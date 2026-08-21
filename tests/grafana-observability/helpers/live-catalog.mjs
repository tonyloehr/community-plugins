import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { CAPABILITY_PACKS, sha256Canonical } from "./live-authority.mjs";

const fixture = JSON.parse(readFileSync(new URL("../support/live-stack/catalog/operations.json", import.meta.url), "utf8"));

export const PACK_CASES = Object.freeze([
  ["grafana.infrastructure", "infrastructure"],
  ["grafana.apm", "apm"],
  ["grafana.logs", "logs"],
  ["grafana.iot-edge", "iot"],
  ["grafana.business-kpis", "business"],
]);

const subjects = {
  infrastructure: { kind: "HOST", ref: "pmsub_e2einfrastructure000000", providerValue: "host-alpha" },
  logs: { kind: "HOST", ref: "pmsub_e2eloghost0000000000000", providerValue: "host-alpha" },
  iot: { kind: "DEVICE", ref: "pmsub_e2edevice00000000000000", providerValue: "edge-005" },
  business: { kind: "BUSINESS_UNIT", ref: "pmsub_e2ebusiness000000000000", providerValue: "checkout-unit" },
};

export const LIVE_SCOPES = Object.freeze({
  infrastructure: { environment: "simulation", service: "checkout", subject: { kind: subjects.infrastructure.kind, ref: subjects.infrastructure.ref } },
  apm: { environment: "simulation", service: "checkout" },
  logs: { environment: "simulation", service: "checkout", subject: { kind: subjects.logs.kind, ref: subjects.logs.ref } },
  iot: { environment: "simulation", subject: { kind: subjects.iot.kind, ref: subjects.iot.ref } },
  business: { environment: "simulation", subject: { kind: subjects.business.kind, ref: subjects.business.ref } },
});

const TIME = { sourceName: "Time", outputName: "observed_at", type: "time", role: "TIME" };
const dimension = (sourceName, outputName = sourceName) => ({ sourceName, outputName, type: "string", role: "DIMENSION" });
const attribute = (sourceName, outputName, type = "number") => ({ sourceName, outputName, type, role: "ATTRIBUTE" });

/** Exact test-owned catalogs for the provisioned real datasources. */
export function createLiveCatalog() {
  const cases = new Map(PACK_CASES);
  const entries = fixture.operations.map((operation) => {
    const pack = CAPABILITY_PACKS.find((candidate) => candidate.packId === operation.packId);
    assert.ok(pack, `Unknown fixture pack: ${operation.packId}`);
    const scopeAlias = cases.get(pack.packId);
    const scope = LIVE_SCOPES[scopeAlias];
    const subject = subjects[scopeAlias];
    const mappings = Object.fromEntries(pack.scopeMappings
      .filter((mapping) => mapping.scopeField !== "service" || scope.service !== undefined)
      .map((mapping) => [mapping.scopeField, mapping.providerField]));
    const signal = pack.signals.find((candidate) => candidate.operationId === operation.operationId);
    const outputName = signal?.resultName ?? (operation.target.datasourceType === "tempo" ? "slow_traces" : "error_codes");
    const target = structuredClone(operation.target);
    const type = target.datasourceType;
    let frame;
    if (type === "prometheus") {
      // A direct Prometheus vector retains its metric name in Grafana's
      // numeric field. Enroll that actual name, not a fabricated `Value`.
      const metricName = /^([a-zA-Z_:][a-zA-Z0-9_:]*)\{/u.exec(target.expression)?.[1];
      assert.ok(metricName, "The real fixture uses fixed direct metric selectors");
      frame = {
        resultKind: "SCALAR",
        fields: [TIME, { sourceName: metricName, outputName, type: "number", role: "VALUE" }],
        allowedLabels: Object.values(mappings),
      };
    } else if (type === "loki" && operation.operationId === "grafana.apm.error.codes") {
      frame = {
        resultKind: "EVENT",
        fields: [
          TIME,
          { sourceName: "Line", outputName: "summary", type: "string", role: "SUMMARY" },
          attribute("status_code", "status_code"),
          dimension("environment"), dimension("service"),
        ],
        allowedLabels: [],
      };
    } else if (type === "loki") {
      frame = {
        resultKind: "TIMESERIES",
        fields: [TIME, { sourceName: "Value", outputName, type: "number", role: "VALUE" }],
        allowedLabels: Object.values(mappings),
      };
    } else if (type === "tempo") {
      frame = {
        resultKind: "EVENT",
        fields: [
          TIME,
          { sourceName: "Summary", outputName: "summary", type: "string", role: "SUMMARY" },
          attribute("Duration", "duration_ms"),
          dimension("environment"), dimension("service"),
        ],
        allowedLabels: [],
      };
    } else {
      assert.equal(type, "grafana-postgresql-datasource");
      frame = {
        resultKind: "SCALAR",
        fields: [
          { sourceName: "value", outputName, type: "number", role: "VALUE" },
          dimension("environment"), dimension("business_scope", "subject_ref"),
        ],
        allowedLabels: [],
      };
    }
    if (signal?.unit !== undefined) frame.unit = signal.unit;
    const canonicalType = type === "grafana-postgresql-datasource" ? "postgres" : type;
    return {
      operationId: operation.operationId,
      entry: {
        id: `e2e.${operation.operationId}`,
        route: "datasource-query",
        outputName,
        datasourceUid: operation.datasourceUid,
        datasourceIdentitySha256: sha256Canonical({ kind: "disposable-simulated-datasource", provider: canonicalType }),
        target,
        ...(operation.postgresReadOnlyIdentity === undefined ? {} : { postgresReadOnlyIdentity: structuredClone(operation.postgresReadOnlyIdentity) }),
        frame,
        minIntervalMs: 5_000,
        scope: { ...structuredClone(scope), ...(subject === undefined ? {} : { subject: structuredClone(subject) }) },
        scopeMappings: mappings,
      },
    };
  });
  assert.deepEqual(entries.map(({ operationId }) => operationId).sort(), CAPABILITY_PACKS.flatMap((pack) => pack.requiredOperationIds).sort());
  return entries;
}

export function datasourceQueryModel(entry) {
  const target = entry.target;
  const common = { refId: "A", datasource: { type: target.datasourceType, uid: entry.datasourceUid }, intervalMs: 5_000, maxDataPoints: 100 };
  if (target.datasourceType === "prometheus") return { ...common, expr: target.expression, instant: target.mode === "instant", range: target.mode === "range", format: target.format };
  if (target.datasourceType === "loki") return { ...common, expr: target.expression, queryType: target.queryType, direction: target.direction, maxLines: 100 };
  assert.equal(target.datasourceType, "grafana-postgresql-datasource", "This helper accepts only datasource-query POST targets");
  return { ...common, rawSql: target.rawSql, format: target.format };
}
