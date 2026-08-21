import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createSecretGuard, startAuthenticatedStack } from "./helpers/authenticated-stack.mjs";
import { createIsolatedObservabilityCli } from "./helpers/isolated-observability-cli.mjs";
import { AUTH_TEST_CREDENTIAL_ENV, CAPABILITY_PACKS, createBearerLiveAuthority } from "./helpers/live-authority.mjs";
import { createLiveCatalog, LIVE_SCOPES } from "./helpers/live-catalog.mjs";
import { createSandbox, McpClient, removeSandbox, toolData } from "./helpers/mcp-client.mjs";

const ACTIVE = process.env.GRAFANA_E2E_AUTH === "1";

async function eventually(check) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await check()) return;
    await new Promise((accept) => setTimeout(accept, 1_000));
  }
  throw new Error("Authenticated Prometheus fixture did not become ready");
}

function inspectArtifacts(directory, guard) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    // Copied release bytes are immutable test inputs, not generated outputs.
    if (entry.name === "plugin") continue;
    const path = join(directory, entry.name);
    assert.equal(entry.isSymbolicLink(), false, "Unexpected symlink in authentication test outputs");
    if (entry.isDirectory()) inspectArtifacts(path, guard);
    else if (entry.isFile()) guard.assertAbsent(readFileSync(path, "utf8"));
  }
}

test("real Grafana12.1 legacy Viewer annotation-write grants are rejected before credential storage", {
  skip: ACTIVE ? false : "opt in with GRAFANA_E2E_AUTH=1; starts a separate disposable authenticated Docker stack",
  timeout: 1_200_000,
}, async (t) => {
  const guard = createSecretGuard();
  let stack;
  let sandbox;
  let cli;
  t.after(() => guard.protect(async () => {
    try { cli?.dispose(); if (stack) await stack.stop(); }
    finally { if (sandbox) removeSandbox(sandbox.root); }
  }));
  await guard.protect(async () => {
    sandbox = createSandbox();
    stack = await startAuthenticatedStack(guard, { mode: "legacy" });
    const viewer = await stack.createIdentity("Viewer");
    const permissions = await stack.read("/api/access-control/user/permissions", viewer);
    guard.assertAbsent(permissions);
    assert.equal(permissions.status, 200);
    for (const action of ["annotations:create", "annotations:write", "annotations:delete"]) {
      assert.deepEqual(permissions.body[action], ["annotations:type:dashboard"]);
    }
    await stack.proveWriteDenied(viewer);
    cli = createIsolatedObservabilityCli(sandbox.pluginRoot, sandbox.root, guard);
    const rejected = await cli.run([
      "grafana", "connect", "--url", stack.origin,
      "--profile", "disposable-legacy-viewer-rejected", "--json",
    ], [viewer.readBytes()]);
    assert.equal(rejected.exitCode, 1);
    assert.match(rejected.stderr, /write or administrative authority/u);
    assert.equal(rejected.consumedInputs, 1);
    assert.equal(cli.registry().profiles.length, 0);
    assert.equal(cli.credentialCount(), 0);
    const isolation = cli.assertIsolation();
    assert.equal(isolation.memoryWrites, 0);
    assert.equal(isolation.nativeLoadAttempts, 0);
    inspectArtifacts(sandbox.root, guard);
    await stack.revoke(viewer);
    assert.equal((await stack.read("/api/datasources", viewer)).status, 401);
    t.diagnostic(`${stack.image}: default Viewer includes real dashboard-annotation writes; shipped discovery correctly refused admission and stored nothing.`);
  });
});

test("real Grafana Viewer-token discovery, signed-worker Bearer access, and revocation (isolated scripted CLI storage)", {
  skip: ACTIVE ? false : "opt in with GRAFANA_E2E_AUTH=1; starts a separate disposable authenticated Docker stack",
  timeout: 1_200_000,
}, async (t) => {
  const guard = createSecretGuard();
  let stack;
  let sandbox;
  let cli;
  const clients = new Set();
  t.after(() => guard.protect(async () => {
    try {
      for (const client of clients) {
        await client.close();
        guard.assertAbsent(client.stderr);
        assert.equal(client.stderr, "", "Authenticated packaged MCP wrote unexpected diagnostics");
      }
    } finally {
      try { cli?.dispose(); if (stack) await stack.stop(); }
      finally { if (sandbox) removeSandbox(sandbox.root); }
    }
  }));

  await guard.protect(async () => {
    sandbox = createSandbox();
    stack = await startAuthenticatedStack(guard);
    const health = await stack.read("/api/health");
    guard.assertAbsent(health);
    assert.equal(health.status, 200);
    assert.equal(health.body.version, stack.image.split(":").at(-1));
    assert.equal((await stack.read("/api/datasources")).status, 401, "The auth fixture must not admit anonymous Viewer access");
    const viewer = await stack.createIdentity("Viewer");
    const administrative = await stack.createIdentity("Admin");
    const permissions = await stack.read("/api/access-control/user/permissions", viewer);
    guard.assertAbsent(permissions);
    assert.equal(permissions.status, 200);
    assert.ok(permissions.body["datasources:read"]?.length > 0);
    assert.ok(permissions.body["datasources:query"]?.length > 0);
    await stack.proveWriteDenied(viewer);
    t.diagnostic(`${stack.image}: anonymous access denied; real Viewer read/query grants and folder-write denial verified.`);

    cli = createIsolatedObservabilityCli(sandbox.pluginRoot, sandbox.root, guard);
    const connectArgs = (profile) => ["grafana", "connect", "--url", stack.origin, "--profile", profile, "--json"];
    const invalidSecret = guard.remember(`community-invalid-${randomBytes(24).toString("hex")}`);
    const rejected = await cli.run(connectArgs("disposable-invalid"), [Buffer.from(invalidSecret)]);
    assert.equal(rejected.exitCode, 1);
    assert.match(rejected.stderr, /Grafana rejected the proposed read credential/u);
    assert.equal(rejected.consumedInputs, 1);
    assert.equal(cli.registry().profiles.length, 0);
    assert.equal(cli.credentialCount(), 0);

    const privileged = await cli.run(connectArgs("disposable-admin-rejected"), [administrative.readBytes()]);
    assert.equal(privileged.exitCode, 1);
    assert.match(privileged.stderr, /write or administrative authority/u);
    assert.equal(privileged.consumedInputs, 1);
    assert.equal(cli.registry().profiles.length, 0);
    assert.equal(cli.credentialCount(), 0);

    const profileName = "disposable-local-viewer";
    const connected = await cli.run(connectArgs(profileName), [viewer.readBytes(), Buffer.from("ACTIVATE")]);
    assert.equal(connected.exitCode, 0, connected.stderr);
    assert.equal(connected.stderr, "");
    assert.equal(connected.consumedInputs, 2);
    assert.deepEqual(connected.rawTransitions, [true, false, true, false]);
    const preview = connected.events.find((event) => event.event === "GRAFANA_DISCOVERY_PREVIEW");
    assert.ok(preview, "Shipped CLI omitted its discovery preview");
    assert.equal(preview.permissionState, "READ_ONLY_CONFIRMED");
    assert.equal(preview.grafanaVersion, health.body.version);
    assert.deepEqual(preview.datasources, [{ name: "Disposable Auth Prometheus", type: "prometheus" }]);
    assert.deepEqual(preview.proposedCapabilityPackIds, ["grafana.infrastructure", "grafana.apm"]);
    assert.doesNotMatch(JSON.stringify(preview), /datasourceUid|live-prometheus|rawSql|tokenRef/u);
    assert.equal(cli.registry().profiles.length, 1);
    assert.equal(cli.registry().profiles[0].grafanaOrigin, stack.origin);
    assert.equal(cli.credentialCount(), 1);
    const stored = await cli.run(["grafana", "status", "--profile", profileName, "--json"]);
    assert.equal(stored.exitCode, 0);
    assert.equal(stored.events[0].credentialStatus, "AVAILABLE");
    t.diagnostic("Integrity-verified shipped CLI: invalid and Admin tokens rejected; Viewer discovery and explicit ACTIVATE accepted. TTY and credential backend are test-only seams.");

    const pack = CAPABILITY_PACKS.find((candidate) => candidate.packId === "grafana.infrastructure");
    const entries = createLiveCatalog().filter(({ operationId }) => pack.requiredOperationIds.includes(operationId));
    assert.equal(entries.length, 4);
    const cpuEntry = entries.find(({ operationId }) => operationId === "grafana.infrastructure.cpu.usage").entry;
    await eventually(async () => {
      const result = await stack.query(viewer, cpuEntry);
      guard.assertAbsent(result);
      return result.status === 200 && result.body.results?.A?.frames?.[0]?.data?.values?.[1]?.[0] === 97;
    });
    const authority = createBearerLiveAuthority(sandbox.root, {
      pluginRoot: sandbox.pluginRoot,
      origin: stack.origin,
      entries,
      scopes: { infrastructure: LIVE_SCOPES.infrastructure },
      packs: [pack],
      profileAlias: "local-authenticated-grafana-e2e",
    });
    assert.deepEqual(authority.validation.credentialEnvironmentReferences, [AUTH_TEST_CREDENTIAL_ENV]);
    assert.equal(authority.bundle.endpoints[0].authentication.mode, "BEARER");
    const client = await McpClient.start(sandbox.pluginRoot, {
      env: { ...sandbox.env, ...authority.env, [AUTH_TEST_CREDENTIAL_ENV]: viewer.readValue() },
      timeoutMs: 120_000,
    });
    clients.add(client);
    const call = async (name, args) => {
      const response = await client.callTool(name, args);
      guard.assertAbsent(response);
      return toolData(response);
    };
    const status = await call("grafana_profile_status", { profileAlias: authority.profileAlias });
    // The shared provider doctor deliberately checks only bounded health. Even
    // real bearer connectivity cannot upgrade that check to a permission proof.
    assert.equal(status.readiness, "WARN");
    assert.deepEqual(status.checks.filter((check) => check.status !== "PASS"), [{ name: "provider-read-authorization:grafana", status: "WARN" }]);
    const listed = await call("grafana_list_packs", { profileAlias: authority.profileAlias });
    assert.deepEqual(listed.packs.map((item) => item.packId), [pack.packId]);
    const end = Math.floor(Date.now() / 1_000) * 1_000;
    const request = {
      idempotencyKey: "authenticated-viewer-valid",
      profileAlias: authority.profileAlias,
      packId: pack.packId,
      scopeAlias: "infrastructure",
      origin: "SIMULATED",
      window: { start: new Date(end - 60_000).toISOString(), end: new Date(end).toISOString() },
    };
    const report = await call("grafana_run_pack", request);
    assert.equal(report.status, "COMPLETE");
    assert.equal(report.collectionFailures, 0);
    assert.equal(report.evidence.length, 4);
    assert.deepEqual(report.evidence.map((card) => card.title).sort(), [...pack.requiredOperationIds].sort());
    for (const card of report.evidence) {
      const detail = await call("grafana_get_evidence", { reportRef: report.reportRef, evidenceRef: card.evidenceRef });
      assert.equal(detail.status, "COMPLETE");
      assert.equal(detail.origin, "SIMULATED");
      assert.equal(detail.provider, "grafana");
      assert.ok(detail.values.some((value) => value.kind === "METRIC"));
      for (const linkRef of card.linkRefs) {
        const link = await call("grafana_resolve_link", { reportRef: report.reportRef, linkRef });
        assert.equal(new URL(link.url).origin, stack.origin);
      }
    }
    t.diagnostic("Copied MCP package and signed worker completed all4 infrastructure operations using the real Viewer Bearer token.");

    await stack.revoke(viewer);
    assert.equal((await stack.read("/api/datasources", viewer)).status, 401, "Grafana still accepted the revoked Viewer token");
    const revokedConnect = await cli.run(connectArgs("disposable-revoked-rejected"), [viewer.readBytes()]);
    assert.equal(revokedConnect.exitCode, 1);
    assert.match(revokedConnect.stderr, /Grafana rejected the proposed read credential/u);
    assert.equal(cli.registry().profiles.length, 1, "Rejected credential admission changed the accepted profile registry");
    assert.equal(cli.credentialCount(), 1);
    const revokedReport = await call("grafana_run_pack", { ...request, idempotencyKey: "authenticated-viewer-revoked" });
    assert.equal(revokedReport.status, "ERROR", "A fresh collection with a revoked token must not reuse previously successful evidence");
    // Provider rejections are sealed as ERROR evidence; collectionFailures
    // counts operations that failed without producing an evidence envelope.
    assert.equal(revokedReport.collectionFailures, 0);
    assert.equal(revokedReport.evidence.length, 4);
    assert.deepEqual(revokedReport.evidenceSummary, { COMPLETE: 0, EMPTY: 0, STALE: 0, CONTRADICTORY: 0, ERROR: 4 });
    assert.ok(revokedReport.evidence.every((card) => card.status === "ERROR"));
    assert.notEqual(revokedReport.reportRef, report.reportRef);
    for (const card of revokedReport.evidence) {
      const detail = await call("grafana_get_evidence", { reportRef: revokedReport.reportRef, evidenceRef: card.evidenceRef });
      assert.equal(detail.status, "ERROR");
      assert.deepEqual(detail.values, [], "Revoked credentials must not expose previously collected metric values as fresh evidence");
    }

    const deleted = await cli.run(["grafana", "delete", "--profile", profileName, "--json"], [Buffer.from("DELETE")]);
    assert.equal(deleted.exitCode, 0, deleted.stderr);
    assert.equal(cli.registry().profiles.length, 0);
    assert.equal(cli.credentialCount(), 0);
    const isolation = cli.assertIsolation();
    assert.ok(isolation.memoryLoaderCalls > 0 && isolation.memoryWrites === 1);
    assert.equal(isolation.nativeLoadAttempts, 0);
    inspectArtifacts(sandbox.root, guard);
    await stack.revoke(administrative);
    t.diagnostic("Revoked-token CLI admission and a fresh real-provider collection both failed closed; disposable registry and in-memory credential were deleted, and outputs contained no credentials.");
  });
});
