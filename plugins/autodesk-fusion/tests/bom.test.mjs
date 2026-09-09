import assert from "node:assert/strict";
import test from "node:test";
import { BomError, normalizeBom, compareBoms, planBomSync } from "../dist/index.mjs";

const time = "2026-08-28T12:00:00.000Z";
const property = (value, overrides = {}) => ({ value, source: "product", observedAt: time, sourceRef: "mfg:model:revision", ...overrides });
const row = (overrides = {}) => ({ occurrencePath: ["root", "occ-1"], modelId: "model-part", componentId: "component-part", quantity: { value: 1, unit: "each" }, excluded: false, suppressed: false, virtual: false, properties: { partNumber: property("BRACKET-001"), mass: property(1, { source: "computed", unit: "kg" }) }, ...overrides });
const bom = (rows = [row()], overrides = {}) => ({ context: { tenantId: "enterprise-a", modelId: "assembly-1", timestamp: time, composition: "AS_SAVED", configurationId: "config-a", system: "mfgdm", complete: true, ...overrides }, rows });
const code = expected => error => error instanceof BomError && error.code === expected;

test("normalization is deterministic while retaining occurrences, nulls, exclusions, external references and authority", () => {
  const a = row({ occurrencePath: ["root", "two"], quantity: { value: null, unit: "each" }, excluded: true, virtual: true, properties: { unknown: property(null) } });
  const b = row({ suppressed: true, externalRef: { tenantId: "supplier", modelId: "external-part", version: "3" } });
  const first = normalizeBom(bom([a, b])), second = normalizeBom(bom([b, a]));
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.rows.length, 2);
  assert.equal(first.excludedOccurrences, 1);
  assert.equal(first.suppressedOccurrences, 1);
  assert.equal(first.includedOccurrences, 0);
  assert.equal(first.rows.find(item => item.excluded).quantity.value, null);
  assert.equal(first.rows.find(item => item.excluded).properties.unknown.value, null);
  assert.equal(first.rows.find(item => item.suppressed).externalRef.tenantId, "supplier");
  assert.equal(first.rows.find(item => item.suppressed).properties.mass.source, "computed");
});

test("same part numbers do not merge distinct occurrences or replace exact identities", () => {
  const snapshot = bom([row(), row({ occurrencePath: ["root", "occ-2"], componentId: "copy-with-same-number" })]);
  const normalized = normalizeBom(snapshot);
  assert.equal(normalized.rows.length, 2);
  assert.notEqual(normalized.rows[0].key, normalized.rows[1].key);
  const change = compareBoms(bom([row({ componentId: "replacement" })]), bom());
  assert.equal(change.differences.some(item => item.kind === "identity"), true);
  assert.throws(() => normalizeBom(bom([row(), row()])), code("INVALID_BOM"));
});

test("unit conversion compares physical values while source channels remain distinct", () => {
  const source = bom([row({ quantity: { value: 25.4, unit: "mm" }, properties: { mass: property(1000, { source: "override", unit: "g" }) } })]);
  const target = bom([row({ quantity: { value: 1, unit: "in" }, properties: { mass: property(1, { source: "computed", unit: "kg" }) } })]);
  const comparison = compareBoms(source, target);
  assert.equal(comparison.differences.filter(item => item.kind === "quantity").length, 0);
  assert.equal(comparison.differences.filter(item => item.kind === "property").length, 0);
  assert.equal(comparison.differences.filter(item => item.kind === "property_source").length, 1);
  assert.match(comparison.differences[0].explanation, /separate authorities/);
});

test("quantity null is not zero, incompatible units are differences, and exclusions are not deleted", () => {
  const comparison = compareBoms(bom([row({ quantity: { value: null, unit: "each" }, excluded: true })]), bom([row({ quantity: { value: 0, unit: "each" } })]));
  assert.equal(comparison.differences.filter(item => item.kind === "quantity").length, 1);
  assert.equal(comparison.differences.filter(item => item.kind === "exclusion").length, 1);
  assert.equal(comparison.differences.some(item => item.kind === "removed"), false);
  assert.equal(compareBoms(bom([row({ quantity: { value: 1, unit: "kg" } })]), bom()).differences[0].kind, "unit");
});

test("missing properties are distinguishable from explicit null values", () => {
  const source = bom([row({ properties: { optional: property(null) } })]);
  const target = bom([row({ properties: {} })]);
  const difference = compareBoms(source, target).differences[0];
  assert.equal(difference.kind, "missing_property");
  assert.equal(difference.before, null);
  assert.equal(difference.after.value, null);
});

test("snapshots preserve time and configuration; incomplete observations never imply synchronized releases", () => {
  const comparison = compareBoms(bom([], { complete: false, timestamp: "2026-08-27T12:00:00Z", configurationId: "config-b" }), bom());
  assert.equal(comparison.comparable, false);
  assert.equal(comparison.sourceContext.configurationId, "config-b");
  assert.match(comparison.differences.find(item => item.kind === "removed").explanation, /not established/);
  assert.ok(comparison.differences.some(item => item.kind === "context" && item.field === "timestamp"));
  assert.throws(() => compareBoms(bom(), bom(undefined, { tenantId: "another-company" })), code("TENANT_MISMATCH"));
});

test("cross-system matching requires an explicit, one-to-one mapping with evidence", () => {
  const a = bom(), b = bom([row()], { system: "plm" });
  assert.equal(compareBoms(a, b).matches.length, 0);
  const mapping = { sourceKey: normalizeBom(a).rows[0].key, targetKey: normalizeBom(b).rows[0].key, evidence: "Verified external CAD component ID on PLM item 42, revision B." };
  assert.equal(compareBoms(a, b, { mappings: [mapping] }).matches.length, 1);
  assert.throws(() => compareBoms(a, b, { mappings: [mapping, mapping] }), code("INVALID_BOM"));
});

test("field ownership creates only fresh draft updates and never approves a release", () => {
  const a = bom([row({ properties: { description: property("updated", { source: "product" }) } })]);
  const b = bom([row({ properties: { description: property("old", { source: "plm" }) } })]);
  const ownership = [{ field: "description", sourceOfTruth: "product", destination: "plm", allowSync: true, allowNull: false, maxAgeMs: 60_000, approvalClass: "shared_business_change" }];
  const draft = planBomSync(a, b, ownership, { now: Date.parse(time) });
  assert.equal(draft.changes.length, 1);
  assert.equal(draft.changes[0].before.value, "old");
  assert.equal(draft.changes[0].after.value, "updated");
  assert.equal(draft.requiresApproval, true);
  assert.equal(draft.releaseApproved, false);
  assert.equal(planBomSync(a, b, ownership, { now: Date.parse(time) + 120_000 }).changes.length, 0);
  assert.match(planBomSync(a, b, [], { now: Date.parse(time) }).blocked[0].reason, /No explicit allowed direction/);
});

test("sync blocks overwriting computed geometry, changed component identity, incompatible units and clears", () => {
  const a = bom([row({ properties: { mass: property(2, { source: "override", unit: "kg" }) } })]);
  const b = bom();
  const ownership = [{ field: "mass", sourceOfTruth: "override", destination: "computed", allowSync: true, allowNull: false, maxAgeMs: 60_000, approvalClass: "release_review" }];
  const blocked = planBomSync(a, b, ownership, { now: Date.parse(time) });
  assert.equal(blocked.changes.length, 0);
  assert.ok(blocked.blocked.some(item => /Computed CAD/.test(item.reason)));
  const productRule = [{ ...ownership[0], destination: "product" }];
  for (const source of [bom([row({ ...a.rows[0], componentId: "replacement" })]), bom([row({ properties: { mass: property(2, { source: "override", unit: "m" }) } })]), bom([row({ properties: { mass: property(null, { source: "override", unit: "kg" }) } })])]) {
    const target = bom([row({ properties: { mass: property(1, { source: "product", unit: "kg" }) } })]);
    assert.equal(planBomSync(source, target, productRule, { now: Date.parse(time) }).changes.length, 0);
  }
});

test("BOM validation rejects ambiguous identities, unknown timestamps, invalid numeric values and oversized projections", () => {
  for (const snapshot of [bom([row({ quantity: { value: NaN, unit: "kg" } })]), bom([row({ quantity: { value: -1, unit: "each" } })]), bom([], { timestamp: "today" }), bom([], { configurationId: undefined }), bom([row({ properties: { mass: property(Infinity) } })]), bom([row({ excluded: undefined })])]) assert.throws(() => normalizeBom(snapshot), code("INVALID_BOM"));
  assert.throws(() => normalizeBom(bom([row(), row({ occurrencePath: ["other"] })]), { maxRows: 1 }), code("INVALID_BOM"));
  assert.throws(() => compareBoms(bom(), bom(), { relativeTolerance: Infinity }), code("INVALID_BOM"));
});
