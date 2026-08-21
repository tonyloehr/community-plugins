import assert from "node:assert/strict";
import { createServer } from "node:http";

import { CAPABILITY_PACKS, DEFAULT_LIMITS, sha256Canonical } from "../helpers/live-authority.mjs";

// These are deliberately synthetic Grafana HTTP fixtures. They exercise the
// shipped transport and normalizers, but are not a substitute for the separate
// Docker-backed Grafana/Prometheus/Loki/Tempo/PostgreSQL integration test.
const SUBJECTS = Object.freeze({
  infrastructure: { kind: "HOST", ref: "pmsub_syntheticinfrahost00000000", providerValue: "native-synthetic-infra-canary" },
  logs: { kind: "HOST", ref: "pmsub_syntheticloghost0000000000", providerValue: "native-synthetic-log-canary" },
  iot: { kind: "DEVICE", ref: "pmsub_syntheticdevice00000000000", providerValue: "native-synthetic-device-canary" },
  business: { kind: "BUSINESS_UNIT", ref: "pmsub_syntheticbusiness000000000", providerValue: "native-synthetic-business-canary" },
});

function scopeFor(alias, service) {
  const subject = SUBJECTS[alias];
  return {
    environment: "simulation",
    ...(service === undefined ? {} : { service }),
    ...(subject === undefined ? {} : { subject: { kind: subject.kind, ref: subject.ref } }),
  };
}

export const SYNTHETIC_SCOPES = Object.freeze({
  infrastructure: scopeFor("infrastructure", "checkout"),
  apm: scopeFor("apm", "checkout"),
  logs: scopeFor("logs", "checkout"),
  iot: scopeFor("iot"),
  business: scopeFor("business"),
});

export const PACK_CASES = Object.freeze([
  ["grafana.infrastructure", "infrastructure"],
  ["grafana.apm", "apm"],
  ["grafana.logs", "logs"],
  ["grafana.iot-edge", "iot"],
  ["grafana.business-kpis", "business"],
]);

const SPECS = [
  { operationId: "grafana.infrastructure.cpu.usage", packId: "grafana.infrastructure", scopeAlias: "infrastructure", datasourceType: "prometheus", value: 97 },
  { operationId: "grafana.infrastructure.memory.load", packId: "grafana.infrastructure", scopeAlias: "infrastructure", datasourceType: "prometheus", value: 82 },
  { operationId: "grafana.infrastructure.disk.free", packId: "grafana.infrastructure", scopeAlias: "infrastructure", datasourceType: "prometheus", value: 8 },
  { operationId: "grafana.infrastructure.system.load", packId: "grafana.infrastructure", scopeAlias: "infrastructure", datasourceType: "prometheus", value: 2.1 },
  { operationId: "grafana.apm.request.rate", packId: "grafana.apm", scopeAlias: "apm", datasourceType: "prometheus", value: 120 },
  { operationId: "grafana.apm.error.codes", packId: "grafana.apm", scopeAlias: "apm", datasourceType: "loki", summary: "HTTP 503 response observed for checkout", attribute: { sourceName: "status_code", outputName: "status_code", value: 503 } },
  { operationId: "grafana.apm.error.rate", packId: "grafana.apm", scopeAlias: "apm", datasourceType: "prometheus", value: 6 },
  { operationId: "grafana.apm.latency.p95", packId: "grafana.apm", scopeAlias: "apm", datasourceType: "prometheus", value: 1_250 },
  { operationId: "grafana.apm.traces.slow", packId: "grafana.apm", scopeAlias: "apm", datasourceType: "tempo", summary: "Slow checkout trace exceeded 1000 ms", attribute: { sourceName: "Duration", outputName: "duration_ms", value: 1_250 } },
  { operationId: "grafana.logs.events", packId: "grafana.logs", scopeAlias: "logs", datasourceType: "loki", value: 42 },
  { operationId: "grafana.logs.error.rate", packId: "grafana.logs", scopeAlias: "logs", datasourceType: "loki", value: 1.5 },
  { operationId: "grafana.logs.security.markers", packId: "grafana.logs", scopeAlias: "logs", datasourceType: "loki", value: 1 },
  { operationId: "grafana.iot.telemetry", packId: "grafana.iot-edge", scopeAlias: "iot", datasourceType: "prometheus", value: 17.4 },
  { operationId: "grafana.iot.device.freshness", packId: "grafana.iot-edge", scopeAlias: "iot", datasourceType: "prometheus", value: 420 },
  { operationId: "grafana.business.revenue", packId: "grafana.business-kpis", scopeAlias: "business", datasourceType: "grafana-postgresql-datasource", value: 95_000 },
  { operationId: "grafana.business.conversion", packId: "grafana.business-kpis", scopeAlias: "business", datasourceType: "grafana-postgresql-datasource", value: 3.2 },
  { operationId: "grafana.business.operational.kpi", packId: "grafana.business-kpis", scopeAlias: "business", datasourceType: "grafana-postgresql-datasource", value: 88 },
];

export const SYNTHETIC_METADATA_CANARY = "synthetic-unreviewed-provider-metadata";
export const SYNTHETIC_ERROR_CANARY = "synthetic-private-provider-failure";
export const SYNTHETIC_TEXT_CANARY = "synthetic-sensitive-event-value";

function slug(value) {
  return value.replaceAll(/[^A-Za-z0-9_]/gu, "_");
}

function targetFor(spec, scope, mappings, subject, resultName) {
  const selectors = [
    `${mappings.environment}="${scope.environment}"`,
    ...(scope.service === undefined ? [] : [`${mappings.service}="${scope.service}"`]),
    ...(subject === undefined ? [] : [`${mappings["subject.ref"]}="${subject.providerValue}"`]),
  ];
  const queryCanary = `private_synthetic_${slug(spec.operationId)}`;
  if (spec.datasourceType === "prometheus") {
    return { queryCanary, target: { datasourceType: "prometheus", expression: `${queryCanary}{${selectors.join(",")}}`, mode: "instant", format: "time_series" } };
  }
  if (spec.datasourceType === "loki") {
    return { queryCanary, target: { datasourceType: "loki", expression: `{${selectors.join(",")}} |= "${queryCanary}"`, queryType: "range", direction: "backward" } };
  }
  if (spec.datasourceType === "tempo") {
    return { queryCanary, target: { datasourceType: "tempo", expression: `{ resource.deployment.environment = "${scope.environment}" && resource.service.name = "${scope.service}" && name = "${queryCanary}" }`, queryType: "traceql", limit: 20, spansPerSpanSet: 20, tableType: "traces" } };
  }
  return {
    queryCanary,
    target: {
      datasourceType: spec.datasourceType,
      rawSql: `SELECT ${resultName} AS value, ${mappings.environment}, ${mappings["subject.ref"]} FROM ${queryCanary} WHERE ${mappings.environment} = '${scope.environment}' AND ${mappings["subject.ref"]} = '${subject.providerValue}' LIMIT 1`,
      format: "table",
      maxRows: 1,
    },
  };
}

function compileSpec(spec, index, conflictingClaims) {
  const pack = CAPABILITY_PACKS.find((candidate) => candidate.packId === spec.packId);
  assert.ok(pack, spec.packId);
  const scope = SYNTHETIC_SCOPES[spec.scopeAlias];
  const subject = SUBJECTS[spec.scopeAlias];
  const mappings = Object.fromEntries(pack.scopeMappings.map((mapping) => [mapping.scopeField, mapping.providerField]));
  const signal = pack.signals.find((candidate) => candidate.operationId === spec.operationId);
  const resultName = conflictingClaims && spec.operationId === "grafana.infrastructure.memory.load"
    ? "cpu_usage"
    : signal?.resultName ?? (spec.datasourceType === "tempo" ? "slow_traces" : "error_codes");
  const { queryCanary, target } = targetFor(spec, scope, mappings, subject, resultName);
  const dimensions = [
    { sourceName: mappings.environment, outputName: "environment", type: "string", role: "DIMENSION" },
    ...(scope.service === undefined ? [] : [{ sourceName: mappings.service, outputName: "service", type: "string", role: "DIMENSION" }]),
    ...(subject === undefined ? [] : [{ sourceName: mappings["subject.ref"], outputName: "subject_ref", type: "string", role: "DIMENSION" }]),
  ];
  let frame;
  if (spec.summary !== undefined) {
    frame = {
      resultKind: "EVENT",
      fields: [
        { sourceName: "Time", outputName: "observed_at", type: "time", role: "TIME" },
        { sourceName: "Summary", outputName: "summary", type: "string", role: "SUMMARY" },
        { sourceName: spec.attribute.sourceName, outputName: spec.attribute.outputName, type: "number", role: "ATTRIBUTE" },
        ...dimensions,
      ],
      allowedLabels: [],
    };
  } else {
    frame = {
      resultKind: spec.datasourceType === "loki" ? "TIMESERIES" : "SCALAR",
      fields: [
        ...(spec.datasourceType === "loki" ? [{ sourceName: "Time", outputName: "observed_at", type: "time", role: "TIME" }] : []),
        { sourceName: "Value", outputName: resultName, type: "number", role: "VALUE" },
        ...dimensions,
      ],
      allowedLabels: [],
      ...(signal?.unit === undefined ? {} : { unit: signal.unit }),
    };
  }
  const datasourceUid = `private-${slug(spec.operationId)}`;
  const entry = {
    id: `catalog.${spec.operationId}`,
    route: "datasource-query",
    outputName: resultName,
    datasourceUid,
    datasourceIdentitySha256: sha256Canonical({ syntheticDatasourceType: spec.datasourceType }),
    target,
    ...(spec.datasourceType === "grafana-postgresql-datasource" ? { postgresReadOnlyIdentity: { roleIdentitySha256: sha256Canonical({ syntheticRole: "SELECT_ONLY" }), privilegeModel: "SELECT_ONLY" } } : {}),
    frame,
    minIntervalMs: 1_000,
    scope: {
      environment: scope.environment,
      ...(scope.service === undefined ? {} : { service: scope.service }),
      ...(subject === undefined ? {} : { subject: { ...subject } }),
    },
    scopeMappings: mappings,
    sourcePanel: { dashboardUid: `synthetic-${spec.scopeAlias}`, dashboardVersion: 1, panelId: index + 1, targetRefId: "A" },
  };
  return { operationId: spec.operationId, entry, spec, leakageTokens: [datasourceUid, queryCanary, ...(subject === undefined ? [] : [subject.providerValue])] };
}

export function createSyntheticCatalog({ conflictingClaims = false } = {}) {
  const expected = CAPABILITY_PACKS.flatMap((pack) => pack.requiredOperationIds).sort();
  assert.deepEqual(SPECS.map((spec) => spec.operationId).sort(), expected, "Every required operation must have exactly one synthetic fixture");
  const compiled = SPECS.map((spec, index) => compileSpec(spec, index, conflictingClaims));
  return {
    compiled,
    entries: compiled.map(({ operationId, entry }) => ({ operationId, entry })),
    leakageTokens: [...new Set([...compiled.flatMap((item) => item.leakageTokens), SYNTHETIC_METADATA_CANARY, SYNTHETIC_ERROR_CANARY, SYNTHETIC_TEXT_CANARY])],
  };
}

function expectedTarget(entry, from, to, limits) {
  const target = entry.target;
  const common = {
    refId: "A",
    datasource: { type: target.datasourceType, uid: entry.datasourceUid },
    intervalMs: Math.max(entry.minIntervalMs, Math.ceil((to - from) / Math.max(1, limits.maxPoints))),
    maxDataPoints: limits.maxPoints,
  };
  if (target.datasourceType === "prometheus") return { ...common, expr: target.expression, instant: target.mode === "instant", range: target.mode === "range", format: target.format };
  if (target.datasourceType === "loki") return { ...common, expr: target.expression, queryType: target.queryType, direction: target.direction, maxLines: limits.maxRows };
  assert.notEqual(target.datasourceType, "tempo", "Tempo uses its separately-certified native GET route");
  return { ...common, rawSql: target.rawSql, format: target.format };
}

function completeResponse(compiled, from, to, behavior, valueScale) {
  const { entry, spec } = compiled;
  const rows = entry.frame.resultKind === "TIMESERIES" ? 2 : 1;
  const dimensionValue = (sourceName) => {
    if (sourceName === entry.scopeMappings.environment) return entry.scope.environment;
    if (sourceName === entry.scopeMappings.service) return entry.scope.service;
    if (sourceName === entry.scopeMappings["subject.ref"]) return entry.scope.subject?.providerValue;
    assert.fail("Unexpected synthetic frame dimension");
  };
  const values = entry.frame.fields.map((field) => {
    if (field.role === "TIME") return Array.from({ length: rows }, (_, index) => Math.max(from, to - (rows - index) * 1_000));
    if (field.role === "SUMMARY") return [behavior === "unsafe-text" ? `Authorization: Bearer ${SYNTHETIC_TEXT_CANARY}` : spec.summary];
    if (field.role === "ATTRIBUTE") return [spec.attribute.value];
    if (field.role === "VALUE") return rows === 2 ? [spec.value * valueScale * 0.8, spec.value * valueScale] : [spec.value * valueScale];
    return Array.from({ length: rows }, () => dimensionValue(field.sourceName));
  });
  const fields = entry.frame.fields.map((field) => ({
    name: field.sourceName,
    type: field.type,
    labels: { unreviewed_label: SYNTHETIC_METADATA_CANARY },
  }));
  if (behavior === "drift") fields[0].name = "Unexpected changed field";
  if (behavior === "scope-mismatch") {
    const index = entry.frame.fields.findIndex((field) => field.sourceName === entry.scopeMappings.environment);
    values[index] = Array.from({ length: rows }, () => "unreviewed-environment");
  }
  return { results: { A: { frames: [{ schema: { refId: "A", fields, meta: { executedQueryString: SYNTHETIC_METADATA_CANARY } }, data: { values } }] } } };
}

function nativeLokiResponse(compiled, from, to, behavior) {
  const observedAtMs = Math.max(from, to - 1_000);
  const line = behavior === "unsafe-text"
    ? `Authorization: Bearer ${SYNTHETIC_TEXT_CANARY}`
    : compiled.spec.summary;
  const labels = {
    [compiled.entry.scopeMappings.environment]: behavior === "scope-mismatch" ? "unreviewed-environment" : compiled.entry.scope.environment,
    [compiled.entry.scopeMappings.service]: compiled.entry.scope.service,
    [compiled.spec.attribute.sourceName]: String(compiled.spec.attribute.value),
    unreviewed_label: SYNTHETIC_METADATA_CANARY,
  };
  const fields = [
    { name: "labels", type: "other" },
    { name: "Time", type: "time" },
    { name: "Line", type: "string" },
    { name: "tsNs", type: "string" },
    { name: "labelTypes", type: "other" },
    { name: "id", type: "string" },
  ];
  if (behavior === "drift") fields[2].name = "Unexpected changed field";
  return {
    results: { A: { frames: [{
      schema: { refId: "A", fields, meta: { executedQueryString: SYNTHETIC_METADATA_CANARY } },
      data: { values: [[labels], [observedAtMs], [line], [(BigInt(observedAtMs) * 1_000_000n).toString()], [{}], ["synthetic-loki-event-id"]] },
    }] } },
  };
}

function nativeTempoResponse(compiled, from, to, behavior) {
  const observedAtMs = Math.max(from, to - 1_000);
  const startTimeUnixNano = (BigInt(observedAtMs) * 1_000_000n).toString();
  const environment = behavior === "scope-mismatch" ? "unreviewed-environment" : compiled.entry.scope.environment;
  const rootTraceName = behavior === "unsafe-text"
    ? `Authorization: Bearer ${SYNTHETIC_TEXT_CANARY}`
    : compiled.spec.summary;
  return {
    traces: [{
      traceID: behavior === "drift" ? "invalid-trace-id" : "0123456789abcdef0123456789abcdef",
      rootTraceName,
      startTimeUnixNano,
      durationMs: compiled.spec.attribute.value,
      spanSets: [{ spans: [{
        spanID: "0123456789abcdef",
        startTimeUnixNano,
        durationNanos: (BigInt(compiled.spec.attribute.value) * 1_000_000n).toString(),
        attributes: [
          { key: "deployment.environment", value: { stringValue: environment } },
          { key: "service.name", value: { stringValue: compiled.entry.scope.service } },
          { key: "unreviewed.synthetic", value: { stringValue: SYNTHETIC_METADATA_CANARY } },
        ],
      }] }],
    }],
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

/** A strict loopback-only HTTP stand-in. It has no write or proxy route. */
export async function startSyntheticGrafana(catalog, { limits = DEFAULT_LIMITS } = {}) {
  const byUid = new Map(catalog.compiled.map((item) => [item.entry.datasourceUid, item]));
  const allowedWindows = new Map();
  const allowedTempoWindows = new Map();
  const requests = [];
  const unexpectedRequests = [];
  let selectedBehavior = { mode: "complete" };
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, undefined, "Synthetic test must not inherit credentials");
      if (request.method === "GET" && request.url === "/api/health") {
        requests.push({ method: "GET", path: "/api/health" });
        sendJson(response, 200, { database: "ok", version: "13.1.0" });
        return;
      }
      if (request.method === "GET" && request.url.startsWith("/api/datasources/proxy/uid/")) {
        const url = new URL(request.url, "http://127.0.0.1");
        const prefix = "/api/datasources/proxy/uid/";
        const suffix = "/api/search";
        assert.ok(url.pathname.endsWith(suffix));
        const uid = url.pathname.slice(prefix.length, -suffix.length);
        const compiled = byUid.get(uid);
        assert.ok(compiled && compiled.entry.target.datasourceType === "tempo", "Unreviewed Tempo datasource identity");
        assert.equal(url.pathname, `${prefix}${compiled.entry.datasourceUid}${suffix}`);
        assert.deepEqual([...url.searchParams.keys()].sort(), ["end", "limit", "q", "spss", "start"]);
        const window = allowedTempoWindows.get(`${url.searchParams.get("start")}:${url.searchParams.get("end")}`);
        assert.ok(window, "Unreviewed Tempo query window");
        const target = compiled.entry.target;
        assert.deepEqual(Object.fromEntries(url.searchParams), {
          q: target.expression,
          start: String(Math.floor(window.from / 1_000)),
          end: String(Math.ceil(window.to / 1_000)),
          limit: String(Math.max(1, Math.min(target.limit, limits.maxRows))),
          spss: String(Math.max(1, Math.min(target.spansPerSpanSet, limits.maxRows))),
        }, "The exact enrolled Tempo search must reach Grafana unchanged");
        requests.push({ method: "GET", path: url.pathname, operationId: compiled.operationId, datasourceType: "tempo", from: window.from, to: window.to });
        const behavior = selectedBehavior.operationIds === undefined || selectedBehavior.operationIds.includes(compiled.operationId)
          ? selectedBehavior.mode
          : "complete";
        if (behavior === "http-error") sendJson(response, 503, { message: SYNTHETIC_ERROR_CANARY });
        else if (behavior === "rate-limit") sendJson(response, 429, { message: SYNTHETIC_ERROR_CANARY });
        else if (behavior === "query-error") sendJson(response, 403, { message: SYNTHETIC_ERROR_CANARY });
        else if (behavior === "empty") sendJson(response, 200, { traces: [] });
        else sendJson(response, 200, nativeTempoResponse(compiled, window.from, window.to, behavior));
        return;
      }
      assert.equal(request.method, "POST", "Only Grafana's read-only query POST is admitted");
      assert.equal(request.url, "/api/ds/query");
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        assert.ok(bytes <= 65_536, "Synthetic query request exceeded its bound");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.deepEqual(Object.keys(body).sort(), ["from", "queries", "to"]);
      assert.equal(typeof body.from, "string");
      assert.equal(typeof body.to, "string");
      const from = Number(body.from);
      const to = Number(body.to);
      assert.ok(Number.isSafeInteger(from) && Number.isSafeInteger(to) && from < to);
      assert.ok(allowedWindows.has(`${from}:${to}`), "Unreviewed query window");
      assert.equal(body.queries.length, 1);
      const compiled = byUid.get(body.queries[0]?.datasource?.uid);
      assert.ok(compiled, "Unreviewed datasource identity");
      assert.notEqual(compiled.entry.target.datasourceType, "tempo", "Tempo search must use the certified native read route");
      assert.deepEqual(body.queries[0], expectedTarget(compiled.entry, from, to, limits), "The exact enrolled target must reach Grafana unchanged");
      requests.push({ method: "POST", path: "/api/ds/query", operationId: compiled.operationId, datasourceType: compiled.entry.target.datasourceType, from, to });
      const behavior = selectedBehavior.operationIds === undefined || selectedBehavior.operationIds.includes(compiled.operationId)
        ? selectedBehavior.mode
        : "complete";
      if (behavior === "http-error") sendJson(response, 503, { message: SYNTHETIC_ERROR_CANARY });
      else if (behavior === "rate-limit") sendJson(response, 429, { message: SYNTHETIC_ERROR_CANARY });
      else if (behavior === "query-error") sendJson(response, 200, { results: { A: { status: 403, error: SYNTHETIC_ERROR_CANARY, frames: [] } } });
      else if (behavior === "empty") sendJson(response, 200, { results: { A: { frames: [] } } });
      else if (compiled.entry.target.datasourceType === "loki" && compiled.entry.frame.resultKind === "EVENT") sendJson(response, 200, nativeLokiResponse(compiled, from, to, behavior));
      else sendJson(response, 200, completeResponse(compiled, from, to, behavior, allowedWindows.get(`${from}:${to}`)));
    } catch (error) {
      unexpectedRequests.push({ method: request.method, path: request.url, message: error.message });
      if (!response.headersSent) sendJson(response, 400, { message: "Synthetic fixture rejected an unexpected request" });
      else response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    unexpectedRequests,
    allowWindow(window, { valueScale = 1 } = {}) {
      const from = Date.parse(window.start);
      const to = Date.parse(window.end);
      allowedWindows.set(`${from}:${to}`, valueScale);
      const tempoKey = `${Math.floor(from / 1_000)}:${Math.ceil(to / 1_000)}`;
      const existing = allowedTempoWindows.get(tempoKey);
      assert.ok(existing === undefined || (existing.from === from && existing.to === to), "Ambiguous synthetic Tempo window");
      allowedTempoWindows.set(tempoKey, { from, to });
    },
    setBehavior(mode, operationIds) { selectedBehavior = { mode, ...(operationIds === undefined ? {} : { operationIds: [...operationIds] }) }; },
    async close() {
      const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}
