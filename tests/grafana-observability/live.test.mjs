import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { CAPABILITY_PACKS, createLiveAuthority } from "./helpers/live-authority.mjs";
import { createLiveCatalog, datasourceQueryModel, LIVE_SCOPES, PACK_CASES } from "./helpers/live-catalog.mjs";
import { startLiveStack } from "./helpers/live-stack.mjs";
import { assertNoAncestorDependencies, createSandbox, McpClient, removeSandbox, toolData } from "./helpers/mcp-client.mjs";

const ACTIVE = process.env.GRAFANA_E2E_DOCKER === "1";
const requestedMajor = process.env.GRAFANA_E2E_MAJOR ?? "12";

async function jsonRequest(origin, path, options = {}) {
  const response = await fetch(new URL(path, origin), { ...options, signal: AbortSignal.timeout(10_000), redirect: "error" });
  const text = await response.text();
  assert.ok(Buffer.byteLength(text) <= 4 * 1_024 * 1_024, "Real provider response exceeded the fixture bound");
  return { status: response.status, body: JSON.parse(text) };
}

function queryDatasource(origin, entry) {
  const now = Date.now();
  return jsonRequest(origin, "/api/ds/query", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: String(now - 300_000), to: String(now), queries: [datasourceQueryModel(entry)] }),
  });
}

function queryTempo(origin, entry) {
  const now = Math.floor(Date.now() / 1_000);
  const query = new URLSearchParams({ q: entry.target.expression, start: String(now - 300), end: String(now), limit: "2", spss: "2" });
  return jsonRequest(origin, `/api/datasources/proxy/uid/${entry.datasourceUid}/api/search?${query}`);
}

async function eventually(check, label) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { return await check(); } catch (error) { lastError = error; }
    await new Promise((accept) => setTimeout(accept, 1_000));
  }
  throw new Error(`Real Grafana fixture did not become ready: ${label}`, { cause: lastError });
}

function readEvidenceArtifacts(root) {
  const evidence = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.isFile() && /^pmev_.*\.json$/u.test(entry.name)) {
        const value = JSON.parse(readFileSync(filename, "utf8"));
        if (value.evidenceId && value.operationId && value.source) evidence.push(value);
      }
    }
  };
  visit(root);
  return evidence;
}

test("real Docker Grafana: copied package executes all five signed packs and all 17 reviewed operations", {
  skip: ACTIVE ? false : "opt in with npm run test:grafana:live (starts disposable local Docker containers)",
  timeout: 1_200_000,
}, async (t) => {
  assert.match(requestedMajor, /^(?:10|11|12|13)$/u, "GRAFANA_E2E_MAJOR must select one pinned major");
  let stack;
  let sandbox;
  let client;
  t.after(async () => {
    try {
      if (client) {
        await client.close();
        assert.equal(client.stderr, "", "Packaged MCP server wrote unexpected diagnostics");
      }
    } finally {
      try { if (stack) await stack.stop(); }
      finally { if (sandbox) removeSandbox(sandbox.root); }
    }
  });
  stack = await startLiveStack(Number(requestedMajor));
  t.diagnostic(`Started disposable ${stack.image}; all evidence remains SIMULATED.`);
  const health = await jsonRequest(stack.origin, "/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.version, stack.image.split(":").at(-1));
  assert.equal(health.body.database, "ok");
  assert.deepEqual(await stack.readOnlyDatabaseProof(), { identity: "grafana_live_reader", selectOnly: true });
  const postgres = await jsonRequest(stack.origin, "/api/datasources/uid/live-postgres");
  assert.equal(postgres.status, 200);
  assert.equal(postgres.body.user, "grafana_live_reader", "Grafana must use the independently verified SELECT-only role");

  const entries = createLiveCatalog();
  const entryFor = (id) => entries.find((entry) => entry.operationId === id).entry;
  const cpuEntry = entryFor("grafana.infrastructure.cpu.usage");
  await eventually(async () => {
    const result = await queryDatasource(stack.origin, cpuEntry);
    assert.equal(result.status, 200);
    const frame = result.body.results.A.frames[0];
    assert.equal(frame.schema.fields[1].name, "pm_live_cpu_usage_percent", "A real Prometheus vector retains its metric-name field");
    assert.equal(frame.schema.fields[1].labels.instance, "host-alpha");
    assert.equal(frame.data.values[1][0], 97);
  }, "Prometheus host sample");
  await eventually(async () => {
    const result = await queryDatasource(stack.origin, entryFor("grafana.apm.error.codes"));
    assert.equal(result.status, 200);
    const frame = result.body.results.A.frames[0];
    assert.ok(frame.schema.fields.some((field) => field.name === "labels" && field.type === "other"), "Real Loki log evidence must contain its native JSON-label field");
    assert.ok(frame.data.values[0].some((labels) => labels.environment === "simulation" && labels.service === "checkout" && labels.status_code === "503"));
  }, "native Loki log frame");
  await eventually(async () => {
    const result = await queryTempo(stack.origin, entryFor("grafana.apm.traces.slow"));
    assert.equal(result.status, 200);
    assert.ok(result.body.traces.length > 0);
    const trace = result.body.traces[0];
    const span = (trace.spanSets ?? [trace.spanSet])[0].spans[0];
    const attributes = Object.fromEntries(span.attributes.map((attribute) => [attribute.key, attribute.value.stringValue]));
    assert.equal(attributes["deployment.environment"], "simulation");
    assert.equal(attributes["service.name"], "checkout");
  }, "scope-proven native Tempo search");

  sandbox = createSandbox();
  assertNoAncestorDependencies(sandbox.pluginRoot);
  const authority = createLiveAuthority(sandbox.root, {
    pluginRoot: sandbox.pluginRoot, origin: stack.origin, entries, scopes: LIVE_SCOPES,
  });
  client = await McpClient.start(sandbox.pluginRoot, { env: { ...sandbox.env, ...authority.env }, timeoutMs: 120_000 });
  const call = async (name, args) => toolData(await client.callTool(name, args));
  const profile = await call("grafana_profile_status", { profileAlias: authority.profileAlias });
  assert.equal(profile.readiness, "WARN", "Anonymous Viewer access cannot claim credential authorization was independently proved");
  assert.equal(profile.status, "PARTIAL");
  assert.deepEqual(profile.originModes, ["SIMULATED"]);
  assert.deepEqual(profile.checks.filter((check) => check.status !== "PASS"), [{ name: "provider-read-authorization:grafana", status: "WARN" }]);
  const listed = await call("grafana_list_packs", { profileAlias: authority.profileAlias });
  assert.equal(listed.status, "COMPLETE");
  assert.deepEqual(listed.packs.map((pack) => pack.packId).sort(), CAPABILITY_PACKS.map((pack) => pack.packId).sort());
  assert.equal(listed.packs.reduce((count, pack) => count + pack.requiredOperationCount, 0), 17);

  const end = Math.floor(Date.now() / 1_000) * 1_000;
  const window = { start: new Date(end - 300_000).toISOString(), end: new Date(end).toISOString() };
  const reports = new Map();
  const details = new Map();
  for (const [packId, scopeAlias] of PACK_CASES) {
    const pack = CAPABILITY_PACKS.find((candidate) => candidate.packId === packId);
    const request = { idempotencyKey: `docker-${requestedMajor}-${scopeAlias}`, profileAlias: authority.profileAlias, packId, scopeAlias, origin: "SIMULATED", window };
    const report = await call("grafana_run_pack", request);
    reports.set(packId, report);
    assert.equal(report.status, "COMPLETE", `${packId}: ${JSON.stringify(report.evidence.map((item) => [item.title, item.status]))}`);
    assert.equal(report.collectionFailures, 0, packId);
    assert.equal(report.origin, "SIMULATED");
    assert.deepEqual(report.evidence.map((card) => card.title).sort(), [...pack.requiredOperationIds].sort());
    assert.deepEqual(report.evidenceSummary, { COMPLETE: pack.requiredOperationIds.length, EMPTY: 0, STALE: 0, CONTRADICTORY: 0, ERROR: 0 });
    assert.deepEqual(await call("grafana_run_pack", request), report, "An exact retry must return the same sealed report");
    for (const card of report.evidence) {
      const detail = await call("grafana_get_evidence", { reportRef: report.reportRef, evidenceRef: card.evidenceRef });
      details.set(card.title, detail);
      assert.equal(detail.status, "COMPLETE", card.title);
      assert.equal(detail.provider, "grafana");
      assert.equal(detail.origin, "SIMULATED");
      assert.ok(detail.values.length > 0, card.title);
      assert.ok(card.linkRefs.length > 0, `${card.title} should expose an opaque reviewed source link`);
      for (const linkRef of card.linkRefs) {
        const resolved = await call("grafana_resolve_link", { reportRef: report.reportRef, linkRef });
        assert.equal(resolved.status, "COMPLETE");
        const url = new URL(resolved.url);
        assert.equal(url.origin, stack.origin);
        assert.equal(url.pathname, "/", "Unenrolled dashboard navigation must fall back to the reviewed Grafana root");
        assert.equal(url.search + url.hash + url.username + url.password, "");
      }
    }
    t.diagnostic(`${packId}: COMPLETE (${pack.requiredOperationIds.length} real operations).`);
  }

  const metric = (operationId, label) => details.get(operationId).values.find((value) => value.kind === "METRIC" && value.label === label)?.value;
  assert.equal(metric("grafana.infrastructure.cpu.usage", "cpu_usage"), 97);
  assert.equal(metric("grafana.apm.request.rate", "request_rate"), 120);
  assert.equal(metric("grafana.apm.error.rate", "error_rate"), 20);
  assert.equal(metric("grafana.apm.latency.p95", "latency_p95"), 1_250);
  assert.equal(metric("grafana.iot.telemetry", "telemetry"), 17.4);
  assert.equal(metric("grafana.iot.device.freshness", "device_age"), 420);
  assert.equal(metric("grafana.business.revenue", "revenue"), 95_000);
  assert.equal(metric("grafana.business.conversion", "conversion"), 3.2);
  assert.equal(metric("grafana.business.operational.kpi", "operational_kpi"), 88);
  assert.ok(details.get("grafana.apm.error.codes").values.some((value) => value.kind === "EVENT" && /503|payment timeout/u.test(value.summary)));
  assert.ok(details.get("grafana.apm.traces.slow").values.some((value) => value.kind === "EVENT" && /checkout\.bank_transfer/u.test(value.summary)));
  assert.ok(reports.get("grafana.infrastructure").issues.some((issue) => issue.kind === "ALERT" && issue.severity === "CRITICAL"));
  assert.ok(reports.get("grafana.logs").issues.some((issue) => issue.kind === "ANOMALY" && issue.classification === "SIGNED_RULE"));
  assert.ok(reports.get("grafana.iot-edge").issues.some((issue) => issue.kind === "ALERT"));

  const artifacts = readEvidenceArtifacts(sandbox.artifactRoot);
  assert.equal(artifacts.length, 17);
  assert.deepEqual(artifacts.map((item) => item.operationId).sort(), entries.map((item) => item.operationId).sort());
  for (const { operationId, entry } of entries) {
    const evidence = artifacts.find((item) => item.operationId === operationId);
    assert.equal(evidence.origin, "SIMULATED");
    assert.equal(evidence.collectionState, "COMPLETE");
    assert.equal(evidence.source.provider, "grafana");
    assert.equal(evidence.source.lineage.accessPath, "GRAFANA");
    assert.equal(evidence.source.lineage.datasourceType, entry.target.datasourceType === "grafana-postgresql-datasource" ? "postgres" : entry.target.datasourceType);
    if (entry.scope.subject) {
      assert.ok(JSON.stringify(evidence.values).includes(entry.scope.subject.ref));
      assert.equal(JSON.stringify(evidence.values).includes(entry.scope.subject.providerValue), false);
    }
  }
  assert.doesNotMatch(JSON.stringify([...reports.values(), ...details.values()]), /datasourceUid|sourceIdentitySha256|providerValue|rawSql|executedQueryString|https?:\/\//u);
  t.diagnostic(`Verified ${stack.image}: 5 packs, 17 sealed operations, 4 real datasource families, SELECT-only PostgreSQL, evidence retrieval, and source-link ownership.`);
});
