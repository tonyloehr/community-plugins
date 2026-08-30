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
    quantity: {
        value: number | null;
        unit: string;
    };
    excluded: boolean;
    suppressed: boolean;
    virtual: boolean;
    externalRef?: {
        tenantId: string;
        modelId: string;
        version: string | null;
    } | null;
    properties: Record<string, BomProperty>;
}
export interface BomSnapshot {
    context: BomContext;
    rows: BomRow[];
}
export interface NormalizedBomRow extends BomRow {
    key: string;
    canonicalQuantity: {
        value: number | null;
        unit: string;
        dimension: string;
    };
}
export interface NormalizedBom {
    context: BomContext;
    rows: NormalizedBomRow[];
    fingerprint: string;
    includedOccurrences: number;
    excludedOccurrences: number;
    suppressedOccurrences: number;
}
export declare class BomError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare function normalizeBom(snapshot: BomSnapshot, options?: {
    maxRows?: number;
}): NormalizedBom;
export interface BomMapping {
    sourceKey: string;
    targetKey: string;
    evidence: string;
}
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
export declare function compareBoms(source: BomSnapshot | NormalizedBom, target: BomSnapshot | NormalizedBom, options?: {
    mappings?: BomMapping[];
    absoluteTolerance?: number;
    relativeTolerance?: number;
}): BomComparison;
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
    changes: {
        sourceKey: string;
        targetKey: string;
        field: string;
        before: BomProperty;
        after: BomProperty;
        approvalClass: BomFieldOwnership["approvalClass"];
    }[];
    blocked: {
        sourceKey?: string;
        targetKey?: string;
        field: string;
        reason: string;
    }[];
    warnings: string[];
    requiresApproval: true;
    releaseApproved: false;
}
export declare function planBomSync(source: BomSnapshot, target: BomSnapshot, ownership: BomFieldOwnership[], options?: {
    mappings?: BomMapping[];
    now?: number;
}): BomSyncDraft;
