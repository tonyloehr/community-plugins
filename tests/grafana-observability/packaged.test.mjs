import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import {
  GRAFANA_ENTRYPOINTS, GRAFANA_PACK_IDS, sha256, validateGrafanaPlugin, verifySourceLoader,
} from "../../scripts/validate-grafana.mjs";
import {
  McpClient, assertNoAncestorDependencies, createSandbox, isolatedEnvironment, toolData,
} from "./helpers/mcp-client.mjs";

const TOOL_ANNOTATIONS = {
  grafana_profile_status: { readOnlyHint: true, openWorldHint: true, destructiveHint: false, idempotentHint: true },
  grafana_list_packs: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
  grafana_run_pack: { readOnlyHint: false, openWorldHint: true, destructiveHint: false, idempotentHint: true },
  grafana_get_evidence: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
  grafana_resolve_link: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
};
const WINDOW = { start: "2026-08-19T00:00:00Z", end: "2026-08-19T01:00:00Z" };

function run(sandbox, entrypoint, args = [], options = {}) {
  const result = spawnSync(process.execPath, [join(sandbox.pluginRoot, entrypoint), ...args], {
    cwd: sandbox.root,
    env: sandbox.env,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function expectToolError(result, code) {
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.status, "ERROR");
  if (code !== undefined) assert.equal(result.structuredContent?.error?.code, code);
  assert.equal(result.structuredContent?.error?.message, "The Grafana observability request was rejected");
}

function expectInputRejection(result) {
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /Input validation error/u);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret-sentinel/u);
}

function snapshotTree(root) {
  if (!existsSync(root)) return [];
  const result = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else result.push([relative(root, filename), sha256(readFileSync(filename))]);
    }
  }
  visit(root);
  return result.sort(([a], [b]) => a.localeCompare(b));
}

test("the distributable is self-contained, hash-pinned, and syntactically valid", (t) => {
  const sandbox = createSandbox(t);
  assertNoAncestorDependencies(sandbox.pluginRoot);
  const validation = validateGrafanaPlugin(sandbox.pluginRoot);
  assert.equal(validation.schemaCount, 22);
  for (const [index, entrypoint] of GRAFANA_ENTRYPOINTS.entries()) {
    const source = verifySourceLoader(sandbox.pluginRoot, entrypoint).source;
    const compiled = join(sandbox.root, `entrypoint-${index}.cjs`);
    writeFileSync(compiled, source, { mode: 0o600 });
    for (const file of [join(sandbox.pluginRoot, entrypoint), compiled]) {
      const result = spawnSync(process.execPath, ["--check", file], {
        env: isolatedEnvironment(), encoding: "utf8", timeout: 30_000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
    }
  }
});

test("the launcher forwards only the reviewed non-secret settings", (t) => {
  const sandbox = createSandbox(t);
  const filename = join(sandbox.pluginRoot, ".mcp.json");
  const original = JSON.parse(readFileSync(filename, "utf8"));
  for (const mutate of [
    (launch) => { delete launch.env_vars; },
    (launch) => { launch.env_vars.push("GRAFANA_API_TOKEN"); },
    (launch) => { launch.env_vars.push("NODE_OPTIONS"); },
    (launch) => { launch.env_vars = ["PRODUCTION_MONITORING_*"]; },
  ]) {
    const changed = structuredClone(original);
    mutate(changed.mcpServers["grafana-observability"]);
    writeFileSync(filename, JSON.stringify(changed));
    assert.throws(() => validateGrafanaPlugin(sandbox.pluginRoot), /reviewed non-secret settings/u);
  }
  const embedded = structuredClone(original);
  embedded.mcpServers["grafana-observability"].env = { PRODUCTION_MONITORING_MODE: "fixture" };
  writeFileSync(filename, JSON.stringify(embedded));
  assert.throws(() => validateGrafanaPlugin(sandbox.pluginRoot), /Do not embed environment values/u);
  writeFileSync(filename, JSON.stringify(original));
  assert.equal(validateGrafanaPlugin(sandbox.pluginRoot).schemaCount, 22);
});

test("an isolated package copy serves the exact five-tool contract", async (t) => {
  const sandbox = createSandbox(t);
  assertNoAncestorDependencies(sandbox.pluginRoot);
  const env = { ...sandbox.env };
  delete env.PRODUCTION_MONITORING_MODE; // The actual launcher default is fixture.
  const client = await McpClient.start(sandbox.pluginRoot, { env });
  try {
    assert.deepEqual(client.initialization.serverInfo, { name: "grafana-observability", version: "0.1.0" });
    const { tools } = await client.request("tools/list");
    assert.deepEqual(tools.map((tool) => tool.name).sort(), Object.keys(TOOL_ANNOTATIONS).sort());
    for (const tool of tools) {
      assert.deepEqual(tool.annotations, TOOL_ANNOTATIONS[tool.name], tool.name);
      assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    }
    const runTool = tools.find((tool) => tool.name === "grafana_run_pack");
    assert.deepEqual(runTool.inputSchema.properties.packId.enum, [...GRAFANA_PACK_IDS]);
    assert.match(runTool.description, /provider-read-only/u);
    assert.match(runTool.description, /local run, audit, checkpoint, and sealed evidence/u);
    const status = toolData(await client.callTool("grafana_profile_status", { profileAlias: "fixture" }));
    assert.equal(status.status, "COMPLETE");
    assert.equal(status.readiness, "READY");
    assert.deepEqual(status.originModes, ["SIMULATED", "REPLAY"]);
    assert.ok(status.checks.every((check) => check.status === "PASS"));
    const packs = toolData(await client.callTool("grafana_list_packs", { profileAlias: "fixture" }));
    assert.equal(packs.status, "EMPTY");
    assert.deepEqual(packs.packs, [], "The generic fixture must not pretend to activate Grafana authority");
  } finally {
    assert.deepEqual(await client.close(), { code: 0, signal: null });
  }
  assert.equal(client.stderr, "");
});

test("unactivated packs, invented references, unsafe input, and invalid windows fail closed", async (t) => {
  const sandbox = createSandbox(t);
  const client = await McpClient.start(sandbox.pluginRoot, { env: sandbox.env });
  const input = {
    idempotencyKey: "packaged-denial", profileAlias: "fixture", packId: "grafana.infrastructure",
    scopeAlias: "checkout", origin: "SIMULATED", window: WINDOW,
  };
  try {
    const before = { state: snapshotTree(sandbox.stateRoot), artifacts: snapshotTree(sandbox.artifactRoot) };
    for (const packId of GRAFANA_PACK_IDS) {
      expectToolError(await client.callTool("grafana_run_pack", { ...input, packId }), "PACK_NOT_ACTIVE");
    }
    expectToolError(await client.callTool("grafana_run_pack", { ...input, origin: "LIVE" }), "PACK_NOT_ACTIVE");
    expectToolError(await client.callTool("grafana_run_pack", { ...input, profileAlias: "not-active" }), "PROFILE_NOT_ACTIVE");
    expectToolError(await client.callTool("grafana_get_evidence", {
      reportRef: `gfrpt_${"x".repeat(24)}`, evidenceRef: `gfev_${"x".repeat(24)}`,
    }), "REPORT_NOT_FOUND");
    expectToolError(await client.callTool("grafana_resolve_link", {
      reportRef: `gfrpt_${"x".repeat(24)}`, linkRef: `gflnk_${"x".repeat(24)}`,
    }), "REPORT_NOT_FOUND");
    for (const field of ["url", "query", "rawSql", "datasourceUid", "token", "headers", "command", "path"]) {
      expectInputRejection(await client.callTool("grafana_run_pack", { ...input, [field]: "synthetic-secret-sentinel" }));
      expectInputRejection(await client.callTool("grafana_profile_status", { profileAlias: "fixture", [field]: "synthetic-secret-sentinel" }));
    }
    for (const change of [
      { packId: "grafana.arbitrary" },
      { profileAlias: "https://example.invalid" },
      { scopeAlias: "../other" },
      { origin: "PRODUCTION" },
      { window: { start: WINDOW.end, end: WINDOW.start } },
      { window: { start: WINDOW.start, end: WINDOW.start } },
      { window: { start: WINDOW.start, end: "2026-08-27T01:00:00Z" } },
      { window: { ...WINDOW, query: "synthetic-secret-sentinel" } },
      { baselineWindow: { start: "2026-08-18T23:30:00Z", end: "2026-08-19T00:30:00Z" } },
      { baselineWindow: { start: "2026-08-18T22:00:00Z", end: "2026-08-18T23:59:00Z" } },
    ]) {
      expectInputRejection(await client.callTool("grafana_run_pack", { ...input, ...change }));
    }
    assert.deepEqual(snapshotTree(sandbox.stateRoot), before.state, "Denied requests created or changed runtime state");
    assert.deepEqual(snapshotTree(sandbox.artifactRoot), before.artifacts, "Denied requests created evidence artifacts");
  } finally {
    assert.deepEqual(await client.close(), { code: 0, signal: null });
  }
  assert.equal(client.stderr, "");
});

test("live mode cannot start without independently activated authority", (t) => {
  const sandbox = createSandbox(t);
  for (const overrides of [
    { PRODUCTION_MONITORING_MODE: "live" },
    { PRODUCTION_MONITORING_MODE: "live", PRODUCTION_MONITORING_TRUST_ROOT: sandbox.root },
    { PRODUCTION_MONITORING_MODE: "live", PRODUCTION_MONITORING_TRUST_ROOT: "relative", PRODUCTION_MONITORING_ACTIVATION_RECEIPT: "relative" },
    { PRODUCTION_MONITORING_MODE: "invalid" },
  ]) {
    const result = run(sandbox, "mcp/server.mjs", ["--stdio"], { env: { ...sandbox.env, ...overrides }, input: "" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Grafana observability server failed to start: [A-Za-z0-9_]+:[A-Z_0-9]+\n$/u);
    assert.equal(result.stderr.includes(sandbox.root), false, "Failure disclosed a local authority path");
  }
});

test("every generated entrypoint rejects source tampering before execution", async (t) => {
  for (const entrypoint of GRAFANA_ENTRYPOINTS) {
    await t.test(entrypoint, (subtest) => {
      const sandbox = createSandbox(subtest);
      const { manifest } = verifySourceLoader(sandbox.pluginRoot, entrypoint);
      const part = join(sandbox.pluginRoot, entrypoint, "..", manifest.parts[0].name);
      const bytes = readFileSync(part);
      bytes[0] ^= 1;
      writeFileSync(part, bytes);
      assert.throws(() => verifySourceLoader(sandbox.pluginRoot, entrypoint), /Wrong part digest/u);
      const result = run(sandbox, entrypoint, entrypoint === "mcp/server.mjs" ? ["--stdio"] : ["--help"], { input: "" });
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /source part failed integrity verification/u);
    });
  }
});

test("package validation rejects missing, extra, symlinked, and altered native assets", (t) => {
  const sandbox = createSandbox(t);
  const entrypoint = "mcp/server.mjs";
  const { manifest } = verifySourceLoader(sandbox.pluginRoot, entrypoint);
  const part = join(sandbox.pluginRoot, "mcp", manifest.parts[0].name);
  const original = readFileSync(part);
  unlinkSync(part);
  assert.throws(() => validateGrafanaPlugin(sandbox.pluginRoot), /ENOENT/u);
  writeFileSync(part, original);
  const extra = join(sandbox.pluginRoot, "mcp/server.mjs.source.part-extra");
  writeFileSync(extra, "unexpected\n");
  assert.throws(() => validateGrafanaPlugin(sandbox.pluginRoot), /unlisted source parts/u);
  unlinkSync(extra);
  if (process.platform !== "win32") {
    const external = join(sandbox.root, "external-part");
    writeFileSync(external, original);
    unlinkSync(part);
    symlinkSync(external, part);
    assert.throws(() => validateGrafanaPlugin(sandbox.pluginRoot), /Symlink/u);
    unlinkSync(part);
    writeFileSync(part, original);
  }
  const native = join(sandbox.pluginRoot, "native/keyring.darwin-arm64.node");
  const bytes = readFileSync(native);
  bytes[0] ^= 1;
  chmodSync(native, 0o600);
  writeFileSync(native, bytes);
  assert.throws(() => validateGrafanaPlugin(sandbox.pluginRoot), /Native keyring asset failed release pin/u);
});

test("both shipped administration CLIs expose working credential-safe help", (t) => {
  const sandbox = createSandbox(t);
  for (const entrypoint of ["scripts/observabilityctl.mjs", "scripts/grafana-authorityctl.mjs"]) {
    const result = run(sandbox, entrypoint, ["--help"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/u);
    assert.equal(result.stderr, "");
  }
  const version = run(sandbox, "scripts/observabilityctl.mjs", ["--version"]);
  assert.equal(version.status, 0);
  assert.match(version.stdout, /0\.1\.0/u);
  const unsafe = run(sandbox, "scripts/observabilityctl.mjs", [
    "grafana", "connect", "--url", "http://127.0.0.1:1", "--profile", "e2e-no-write",
    "--token", "synthetic-secret-sentinel",
  ], { input: "synthetic-secret-sentinel\n" });
  assert.notEqual(unsafe.status, 0);
  assert.doesNotMatch(unsafe.stdout + unsafe.stderr, /synthetic-secret-sentinel/u);
});

function enrollmentExamples(pluginRoot) {
  const text = readFileSync(join(pluginRoot, "skills/setup-grafana-observability/references/saved-panel-enrollment.md"), "utf8");
  return [...text.matchAll(/```json\n([\s\S]*?)\n```/gu)].map((match) => JSON.parse(match[1]));
}

function enroll(sandbox, name, value) {
  const input = join(sandbox.root, `${name}-input.json`);
  const output = join(sandbox.root, `${name}-proposal.json`);
  writeFileSync(input, JSON.stringify(value), { mode: 0o600 });
  const args = ["saved-panel", "enroll", "--input", input, "--output", output];
  return { input, output, args, result: run(sandbox, "scripts/grafana-authorityctl.mjs", args) };
}

test("the documented Prometheus and both PostgreSQL enrollment forms really compile", (t) => {
  const sandbox = createSandbox(t);
  const [prometheus, postgres] = enrollmentExamples(sandbox.pluginRoot);
  const legacy = structuredClone(postgres);
  legacy.dashboard.panels[0].datasource.type = "postgres";
  legacy.dashboard.panels[0].targets[0].datasource.type = "postgres";
  for (const [name, value, expectedType] of [
    ["prometheus", prometheus, "prometheus"],
    ["postgres-modern", postgres, "grafana-postgresql-datasource"],
    ["postgres-legacy", legacy, "postgres"],
  ]) {
    const { output, args, result } = enroll(sandbox, name, value);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const receipt = JSON.parse(result.stdout);
    const proposalBytes = readFileSync(output);
    const proposal = JSON.parse(proposalBytes);
    assert.equal(receipt.mode, "ENROLLMENT_PROPOSAL_WRITTEN");
    assert.equal(receipt.activationPerformed, false);
    assert.equal(proposal.activationPerformed, false);
    assert.equal(proposal.catalogEntry.target.datasourceType, expectedType);
    assert.equal(proposal.catalogEntry.sourcePanel.targetRefId, "A");
    assert.match(proposal.catalogEntrySha256, /^[a-f0-9]{64}$/u);
    const clobber = run(sandbox, "scripts/grafana-authorityctl.mjs", args);
    assert.notEqual(clobber.status, 0, "Enrollment overwrote a previously reviewed proposal");
    assert.deepEqual(readFileSync(output), proposalBytes);
  }
});

test("saved-panel enrollment rejects unscoped, executable, expanded, or unattested input", (t) => {
  const sandbox = createSandbox(t);
  const [prometheus, postgres] = enrollmentExamples(sandbox.pluginRoot);
  const cases = [
    ["raw-dashboard", prometheus.dashboard],
    ["extra-target", { ...prometheus, dashboard: { ...prometheus.dashboard, panels: [{
      ...prometheus.dashboard.panels[0], targets: [prometheus.dashboard.panels[0].targets[0], { ...prometheus.dashboard.panels[0].targets[0], refId: "B" }],
    }] } }],
    ["template-variable", { ...prometheus, dashboard: { ...prometheus.dashboard, templating: { list: [{ name: "environment" }] } } }],
    ["unscoped-promql", (() => { const value = structuredClone(prometheus); value.dashboard.panels[0].targets[0].expr = "up"; return value; })()],
    ["postgres-no-attestation", (() => { const value = structuredClone(postgres); delete value.postgresReadOnlyIdentity; return value; })()],
    ["postgres-write", (() => { const value = structuredClone(postgres); value.dashboard.panels[0].targets[0].rawSql = "DELETE FROM business_kpis"; return value; })()],
    ["postgres-function", (() => { const value = structuredClone(postgres); value.dashboard.panels[0].targets[0].rawSql = value.dashboard.panels[0].targets[0].rawSql.replace("value FROM", "pg_sleep(1) AS value FROM"); return value; })()],
  ];
  for (const [name, value] of cases) {
    const { result, output } = enroll(sandbox, name, value);
    assert.notEqual(result.status, 0, `Unsafe enrollment succeeded: ${name}`);
    assert.equal(existsSync(output), false, `Unsafe enrollment wrote a proposal: ${name}`);
  }
});
