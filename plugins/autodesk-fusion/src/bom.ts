import { createHash } from "node:crypto";

/** A BOM is a qualified observation, never an implicitly released engineering record. */
export type BomPropertySource = "computed" | "override" | "product" | "plm" | "erp";
export type BomScalar = string | number | boolean | null;
export interface BomContext {
  tenantId: string;
  modelId: string;
  timestamp: string;
  composition: string;
  configurationId: string | null;
  system: string;
  revision?: string | null;
  complete: boolean;
}
export interface BomProperty {
  value: BomScalar;
  unit?: string | null;
  source: BomPropertySource;
  observedAt: string;
  sourceRef: string;
}
export interface BomRow {
  /** Stable occurrence identity within this model; display names and part numbers are not identities. */
  occurrencePath: string[];
  modelId: string;
  componentId: string;
  quantity: { value: number | null; unit: string };
  excluded: boolean;
  suppressed: boolean;
  virtual: boolean;
  externalRef?: { tenantId: string; modelId: string; version: string | null } | null;
  properties: Record<string, BomProperty>;
}
export interface BomSnapshot {
  context: BomContext;
  rows: BomRow[];
}
export interface NormalizedBomRow extends BomRow {
  key: string;
  canonicalQuantity: { value: number | null; unit: string; dimension: string };
}
export interface NormalizedBom {
  context: BomContext;
  rows: NormalizedBomRow[];
  fingerprint: string;
  includedOccurrences: number;
  excludedOccurrences: number;
  suppressedOccurrences: number;
}
export class BomError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "BomError";
  }
}

function fail(message: string): never { throw new BomError("INVALID_BOM", message); }
function textId(value: unknown, label: string, maximum = 1024): asserts value is string {
  if (typeof value !== "string" || !value.length || value.length > maximum || /[\u0000-\u001f]/.test(value)) fail(`${label} must be a bounded nonempty string.`);
}
function timestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) fail(`${label} must be an explicit ISO timestamp with timezone.`);
}
function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

const units: Record<string, { unit: string; dimension: string; factor: number }> = {
  each: { unit: "each", dimension: "count", factor: 1 }, ea: { unit: "each", dimension: "count", factor: 1 },
  kg: { unit: "kg", dimension: "mass", factor: 1 }, g: { unit: "kg", dimension: "mass", factor: 0.001 },
  mg: { unit: "kg", dimension: "mass", factor: 0.000001 }, lb: { unit: "kg", dimension: "mass", factor: 0.45359237 },
  m: { unit: "m", dimension: "length", factor: 1 }, cm: { unit: "m", dimension: "length", factor: 0.01 },
  mm: { unit: "m", dimension: "length", factor: 0.001 }, in: { unit: "m", dimension: "length", factor: 0.0254 },
  ft: { unit: "m", dimension: "length", factor: 0.3048 },
  "m^2": { unit: "m^2", dimension: "area", factor: 1 }, "mm^2": { unit: "m^2", dimension: "area", factor: 0.000001 },
  "in^2": { unit: "m^2", dimension: "area", factor: 0.00064516 },
  "m^3": { unit: "m^3", dimension: "volume", factor: 1 }, "cm^3": { unit: "m^3", dimension: "volume", factor: 0.000001 },
  "mm^3": { unit: "m^3", dimension: "volume", factor: 0.000000001 }, "in^3": { unit: "m^3", dimension: "volume", factor: 0.000016387064 },
};
function canonical(value: number | null, unit: string) {
  const conversion = Object.hasOwn(units, unit) ? units[unit]! : { unit, dimension: `unqualified:${unit}`, factor: 1 };
  const converted = value === null ? null : value * conversion.factor;
  if (converted !== null && !Number.isFinite(converted)) fail("Unit conversion overflowed.");
  return { value: converted, unit: conversion.unit, dimension: conversion.dimension };
}
function validateProperty(property: unknown): asserts property is BomProperty {
  if (!plain(property)) fail("Properties must carry value, source, observation time and source reference.");
  if (!(property.value === null || typeof property.value === "boolean" || (typeof property.value === "number" && Number.isFinite(property.value)) || (typeof property.value === "string" && property.value.length <= 16_384))) fail("Property values must be bounded scalars; missing is not null.");
  if (!["computed", "override", "product", "plm", "erp"].includes(String(property.source))) fail("Unknown property authority.");
  timestamp(property.observedAt, "Property observedAt");
  textId(property.sourceRef, "Property sourceRef");
  if (property.unit !== undefined && property.unit !== null) textId(property.unit, "Property unit", 64);
}

export function normalizeBom(snapshot: BomSnapshot, options: { maxRows?: number } = {}): NormalizedBom {
  if (!plain(snapshot) || !plain(snapshot.context) || !Array.isArray(snapshot.rows)) fail("A BOM requires explicit context and rows.");
  const limit = options.maxRows ?? 10_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000 || snapshot.rows.length > limit) fail("BOM row limit exceeded.");
  const context = structuredClone(snapshot.context);
  for (const key of ["tenantId", "modelId", "composition", "system"] as const) textId(context[key], `BOM ${key}`);
  timestamp(context.timestamp, "BOM timestamp");
  if (context.configurationId !== null) textId(context.configurationId, "BOM configurationId");
  if (context.revision !== undefined && context.revision !== null) textId(context.revision, "BOM revision");
  if (typeof context.complete !== "boolean") fail("BOM completeness must be declared explicitly.");
  const seen = new Set<string>();
  const rows = snapshot.rows.map(original => {
    if (!plain(original)) fail("Invalid BOM row.");
    textId(original.modelId, "Row modelId"); textId(original.componentId, "Row componentId");
    if (!Array.isArray(original.occurrencePath) || original.occurrencePath.length > 100) fail("Invalid occurrence path.");
    original.occurrencePath.forEach(part => textId(part, "Occurrence path element"));
    if (!plain(original.quantity) || !(original.quantity.value === null || typeof original.quantity.value === "number" && Number.isFinite(original.quantity.value) && original.quantity.value >= 0)) fail("BOM quantity must be finite, nonnegative, or explicitly null.");
    textId(original.quantity.unit, "Quantity unit", 64);
    for (const key of ["excluded", "suppressed", "virtual"] as const) if (typeof original[key] !== "boolean") fail(`${key} must be explicit.`);
    if (original.externalRef !== undefined && original.externalRef !== null) {
      if (!plain(original.externalRef)) fail("Invalid external reference.");
      textId(original.externalRef.tenantId, "External tenant"); textId(original.externalRef.modelId, "External model");
      if (original.externalRef.version !== null) textId(original.externalRef.version, "External version");
    }
    if (!plain(original.properties) || Object.keys(original.properties).length > 200) fail("Property count exceeded.");
    const row = structuredClone(original);
    const properties: Record<string, BomProperty> = Object.create(null);
    for (const key of Object.keys(row.properties).sort()) {
      textId(key, "Property key", 256);
      if (["__proto__", "prototype", "constructor"].includes(key)) fail("Unsafe property key.");
      validateProperty(row.properties[key]);
      properties[key] = row.properties[key]!;
    }
    // An occurrence path is scoped by the root model, not by a changing display name, part number or revision.
    const key = stable([context.tenantId, context.system, context.modelId, row.occurrencePath]);
    if (seen.has(key)) fail("Duplicate occurrence identity; aggregation must be explicit and preserve the source occurrences.");
    seen.add(key);
    return { ...row, properties, key, canonicalQuantity: canonical(row.quantity.value, row.quantity.unit) };
  }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return {
    context, rows, fingerprint: createHash("sha256").update(stable({ context, rows })).digest("hex"),
    includedOccurrences: rows.filter(row => !row.excluded && !row.suppressed).length,
    excludedOccurrences: rows.filter(row => row.excluded).length,
    suppressedOccurrences: rows.filter(row => row.suppressed).length,
  };
}

export interface BomMapping { sourceKey: string; targetKey: string; evidence: string }
export interface BomDifference {
  kind: "context" | "added" | "removed" | "identity" | "quantity" | "unit" | "exclusion" | "suppression" | "virtual" | "external_reference" | "property" | "property_source" | "property_unit" | "missing_property";
  sourceKey?: string;
  targetKey?: string;
  field: string;
  before: unknown;
  after: unknown;
  explanation?: string;
}
export interface BomComparison {
  sourceFingerprint: string;
  targetFingerprint: string;
  sourceContext: BomContext;
  targetContext: BomContext;
  differences: BomDifference[];
  comparable: boolean;
  warnings: string[];
  matches: BomMapping[];
}
function equalNumber(a: number, b: number, absolute: number, relative: number) {
  return Math.abs(a - b) <= Math.max(absolute, relative * Math.max(Math.abs(a), Math.abs(b)));
}
export function compareBoms(source: BomSnapshot | NormalizedBom, target: BomSnapshot | NormalizedBom, options: {
  mappings?: BomMapping[];
  absoluteTolerance?: number;
  relativeTolerance?: number;
} = {}): BomComparison {
  // Re-normalize even previously normalized inputs; caller-provided fingerprints are not trusted.
  const left = normalizeBom(source), right = normalizeBom(target);
  if (left.context.tenantId !== right.context.tenantId) throw new BomError("TENANT_MISMATCH", "BOM comparison requires the same authorized tenant context.");
  const absolute = options.absoluteTolerance ?? 1e-9, relative = options.relativeTolerance ?? 1e-9;
  if (![absolute, relative].every(value => Number.isFinite(value) && value >= 0 && value <= 0.01)) fail("Comparison tolerances must be finite and bounded.");
  const differences: BomDifference[] = [], warnings: string[] = [];
  for (const field of ["modelId", "timestamp", "composition", "configurationId", "system", "revision"] as const) {
    if (left.context[field] !== right.context[field]) differences.push({ kind: "context", field, before: right.context[field] ?? null, after: left.context[field] ?? null });
  }
  if (!left.context.complete || !right.context.complete) warnings.push("At least one BOM is incomplete; absence cannot establish a removal and synchronization is blocked.");
  if (left.context.composition !== right.context.composition || left.context.configurationId !== right.context.configurationId) warnings.push("Composition or configuration differs; proposed synchronization requires explicit reconciliation.");
  const leftIndex = new Map(left.rows.map(row => [row.key, row])), rightIndex = new Map(right.rows.map(row => [row.key, row]));
  const matches: BomMapping[] = [], usedLeft = new Set<string>(), usedRight = new Set<string>();
  if ((options.mappings?.length ?? 0) > left.rows.length + right.rows.length) fail("Too many BOM mappings.");
  for (const mapping of options.mappings ?? []) {
    if (!leftIndex.has(mapping.sourceKey) || !rightIndex.has(mapping.targetKey) || usedLeft.has(mapping.sourceKey) || usedRight.has(mapping.targetKey)) fail("Mappings must resolve one source occurrence to one target occurrence.");
    textId(mapping.evidence, "Mapping evidence", 2048);
    usedLeft.add(mapping.sourceKey); usedRight.add(mapping.targetKey); matches.push(structuredClone(mapping));
  }
  for (const [key] of leftIndex) {
    if (rightIndex.has(key) && !usedLeft.has(key) && !usedRight.has(key)) {
      matches.push({ sourceKey: key, targetKey: key, evidence: "Exact tenant, system, root-model and occurrence-path identity." });
      usedLeft.add(key); usedRight.add(key);
    }
  }
  for (const row of left.rows) if (!usedLeft.has(row.key)) differences.push({ kind: "added", sourceKey: row.key, field: "row", before: null, after: row });
  for (const row of right.rows) if (!usedRight.has(row.key)) differences.push({ kind: "removed", targetKey: row.key, field: "row", before: row, after: null, explanation: left.context.complete ? "Absent from the complete source snapshot." : "Not observed in an incomplete source snapshot; removal is not established." });
  for (const mapping of matches.sort((a, b) => a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0)) {
    const a = leftIndex.get(mapping.sourceKey)!, b = rightIndex.get(mapping.targetKey)!;
    const add = (kind: BomDifference["kind"], field: string, before: unknown, after: unknown, explanation?: string) => differences.push({ kind, sourceKey: a.key, targetKey: b.key, field, before, after, ...(explanation ? { explanation } : {}) });
    if (a.modelId !== b.modelId || a.componentId !== b.componentId) add("identity", "component", { modelId: b.modelId, componentId: b.componentId }, { modelId: a.modelId, componentId: a.componentId }, "Occurrence identity matched, but its referenced component changed.");
    if (a.canonicalQuantity.dimension !== b.canonicalQuantity.dimension) add("unit", "quantity", b.quantity, a.quantity, "Units are incompatible or not qualified for conversion.");
    else if (a.quantity.value === null || b.quantity.value === null) {
      if (a.quantity.value !== b.quantity.value) add("quantity", "quantity", b.quantity, a.quantity, "A null quantity is unknown, never zero.");
    } else if (!equalNumber(a.canonicalQuantity.value!, b.canonicalQuantity.value!, absolute, relative)) add("quantity", "quantity", b.quantity, a.quantity);
    for (const [field, kind] of [["excluded", "exclusion"], ["suppressed", "suppression"], ["virtual", "virtual"]] as const) if (a[field] !== b[field]) add(kind, field, b[field], a[field]);
    if (stable(a.externalRef ?? null) !== stable(b.externalRef ?? null)) add("external_reference", "externalRef", b.externalRef ?? null, a.externalRef ?? null);
    for (const field of [...new Set([...Object.keys(a.properties), ...Object.keys(b.properties)])].sort()) {
      const av = a.properties[field], bv = b.properties[field];
      if (!av || !bv) { add("missing_property", field, bv ?? null, av ?? null, "Missing is distinct from a property whose value is explicitly null."); continue; }
      if (av.source !== bv.source) add("property_source", field, bv, av, "CAD computation, a product override and enterprise release data have separate authorities.");
      let same: boolean;
      if (typeof av.value === "number" && typeof bv.value === "number" && av.unit && bv.unit) {
        const ac = canonical(av.value, av.unit), bc = canonical(bv.value, bv.unit);
        if (ac.dimension !== bc.dimension) { add("property_unit", field, bv, av, "Property units are incompatible or unqualified."); same = false; }
        else same = equalNumber(ac.value!, bc.value!, absolute, relative);
      } else {
        same = av.value === bv.value;
        if ((av.unit ?? null) !== (bv.unit ?? null)) add("property_unit", field, bv, av);
      }
      if (!same) add("property", field, bv, av);
    }
  }
  return { sourceFingerprint: left.fingerprint, targetFingerprint: right.fingerprint, sourceContext: left.context, targetContext: right.context, differences, comparable: warnings.length === 0, warnings, matches };
}

export interface BomFieldOwnership {
  field: string;
  sourceOfTruth: BomPropertySource;
  destination: BomPropertySource;
  allowSync: boolean;
  allowNull: boolean;
  maxAgeMs: number;
  approvalClass: "shared_business_change" | "release_review";
}
export interface BomSyncDraft {
  status: "draft";
  sourceFingerprint: string;
  targetFingerprint: string;
  changes: { sourceKey: string; targetKey: string; field: string; before: BomProperty; after: BomProperty; approvalClass: BomFieldOwnership["approvalClass"] }[];
  blocked: { sourceKey?: string; targetKey?: string; field: string; reason: string }[];
  warnings: string[];
  requiresApproval: true;
  releaseApproved: false;
}
export function planBomSync(source: BomSnapshot, target: BomSnapshot, ownership: BomFieldOwnership[], options: { mappings?: BomMapping[]; now?: number } = {}): BomSyncDraft {
  const comparison = compareBoms(source, target, options), now = options.now ?? Date.now();
  if (!Number.isFinite(now)) fail("Invalid comparison time.");
  if (!Array.isArray(ownership) || ownership.length > 200) fail("Field ownership must be explicit and bounded.");
  const rules = new Map<string, BomFieldOwnership>();
  for (const rule of ownership) {
    textId(rule.field, "Ownership field", 256);
    if (rules.has(rule.field) || !["computed", "override", "product", "plm", "erp"].includes(rule.sourceOfTruth) || !["computed", "override", "product", "plm", "erp"].includes(rule.destination) || !Number.isFinite(rule.maxAgeMs) || rule.maxAgeMs < 0 || typeof rule.allowSync !== "boolean" || typeof rule.allowNull !== "boolean" || !["shared_business_change", "release_review"].includes(rule.approvalClass)) fail("Invalid or duplicate field ownership rule.");
    rules.set(rule.field, rule);
  }
  const draft: BomSyncDraft = { status: "draft", sourceFingerprint: comparison.sourceFingerprint, targetFingerprint: comparison.targetFingerprint, changes: [], blocked: [], warnings: comparison.warnings, requiresApproval: true, releaseApproved: false };
  const processed = new Set<string>();
  for (const difference of comparison.differences) {
    if (difference.kind === "context") continue;
    const key = stable([difference.sourceKey, difference.targetKey, difference.field]);
    if (processed.has(key)) continue;
    processed.add(key);
    const deny = (reason: string) => draft.blocked.push({ sourceKey: difference.sourceKey, targetKey: difference.targetKey, field: difference.field, reason });
    if (!comparison.comparable) { deny("Snapshot completeness, composition or configuration requires reconciliation."); continue; }
    if (!["property", "property_source"].includes(difference.kind) || !difference.sourceKey || !difference.targetKey) { deny("Structural, quantity, identity, unit and missing-field differences require a separate reviewed operation."); continue; }
    if (comparison.differences.some(other => other.sourceKey === difference.sourceKey && other.targetKey === difference.targetKey && (other.kind === "identity" || other.kind === "external_reference" || (other.field === difference.field && other.kind === "property_unit")))) { deny("The component identity, external reference or units changed."); continue; }
    const rule = rules.get(difference.field), before = difference.before as BomProperty, after = difference.after as BomProperty;
    if (!rule || !rule.allowSync) { deny("No explicit allowed direction for this field."); continue; }
    if (after.source !== rule.sourceOfTruth || before.source !== rule.destination) { deny("Field ownership does not authorize this synchronization direction."); continue; }
    if (rule.destination === "computed") { deny("Computed CAD properties cannot be overwritten through BOM synchronization."); continue; }
    if (after.value === null && !rule.allowNull) { deny("Clearing this field was not authorized."); continue; }
    if ([before, after].some(property => now - Date.parse(property.observedAt) > rule.maxAgeMs || Date.parse(property.observedAt) > now + 60_000)) { deny("Source or target observation is stale or future-dated."); continue; }
    draft.changes.push({ sourceKey: difference.sourceKey, targetKey: difference.targetKey, field: difference.field, before, after, approvalClass: rule.approvalClass });
  }
  return draft;
}
