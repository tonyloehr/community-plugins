import { z } from 'zod/v4';
import type { ReadOnlyRecordSnapshotOptions, RecordStore } from './storage.js';
export declare const retentionRecordReferenceSchema: z.ZodString;
/** Trusted profile configuration only. No default legal or project retention periods. */
export declare const retentionPolicySchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    ownerRef: z.ZodString;
    policyRef: z.ZodString;
    periods: z.ZodObject<{
        expiredPreparationMs: z.ZodOptional<z.ZodNumber>;
        terminalEvidenceMs: z.ZodOptional<z.ZodNumber>;
        auditMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>;
}, z.core.$strict>;
/** A complete empty list is an explicit owner observation, not an assumed absence of holds. */
export declare const retentionHoldsSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    ownerRef: z.ZodString;
    evidenceRef: z.ZodString;
    reviewedAt: z.ZodString;
    expiresAt: z.ZodString;
    complete: z.ZodBoolean;
    holds: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        id: z.ZodString;
        scope: z.ZodLiteral<"profile">;
        reason: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        id: z.ZodString;
        scope: z.ZodLiteral<"records">;
        recordRefs: z.ZodArray<z.ZodString>;
        reason: z.ZodString;
    }, z.core.$strict>], "scope">>;
}, z.core.$strict>;
export declare const retentionSelectionSchema: z.ZodObject<{
    inventory_hash: z.ZodString;
    record_refs: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;
export type RetentionHolds = z.infer<typeof retentionHoldsSchema>;
export type RetentionSelection = z.infer<typeof retentionSelectionSchema>;
export interface RetentionContext {
    profileId: string;
    profileHash: string;
    executionContractHash: string;
    policy?: RetentionPolicy;
    holds?: RetentionHolds;
    /** Omitted means the existing profile's unrestricted local-document read scope. */
    readDocumentIds?: readonly string[];
}
export type RetentionDecision = 'archive_review_candidate' | 'protected' | 'held' | 'unknown';
export interface RetentionInventoryEntry {
    record_ref: string;
    record_kind: string;
    record_id?: string;
    sha256?: string;
    bytes?: number;
    state?: string;
    decision: RetentionDecision;
    reasons: string[];
    terminal: boolean;
    age_anchor?: string;
    retention_period_ms?: number;
    dependency_count: number;
    removal_eligible: false;
}
export interface RetentionInventory {
    schema_version: 1;
    scope: 'local_ledger_metadata_only';
    profile_id: string;
    inventory_hash: string;
    observed_at: string;
    analyzed_at: string;
    inventory_complete: boolean;
    dependency_coverage_complete: boolean;
    complete: boolean;
    entry_count_lower_bound: number;
    unrepresented_entry_count_lower_bound: number;
    total_entry_count: number | null;
    counts: Record<RetentionDecision, number>;
    issues: string[];
    entries: RetentionInventoryEntry[];
    excluded: string[];
    provider_state_observed: false;
    archive_execution_supported: false;
    removal_eligible: false;
}
export interface RetentionPlan {
    schema_version: 1;
    kind: 'retention_archive_copy_review';
    id: string;
    hash: string;
    status: 'review_only';
    created_at: string;
    source_binding: {
        profile_id: string;
        profile_hash: string;
        execution_contract_hash: string;
        inventory_hash: string;
        policy_hash: string;
        holds_hash: string;
        holds_expires_at: string;
    };
    selected_record_refs: string[];
    records: Array<{
        record_ref: string;
        record_kind: string;
        sha256: string;
        bytes: number;
        age_anchor: string;
        retention_period_ms: number;
        dependencies: string[];
    }>;
    archive_execution_supported: false;
    removal_eligible: false;
    limitations: string[];
}
/** No provider objects, credentials or native state are accepted by this service. */
export declare class RetentionPlanner {
    private readonly store;
    private readonly options;
    private readonly context;
    constructor(store: Pick<RecordStore, 'snapshotReadOnly'>, context: RetentionContext, options?: {
        now?: () => string;
        snapshotLimits?: Omit<ReadOnlyRecordSnapshotOptions, 'readKinds'>;
    });
    inventory(): Promise<RetentionInventory>;
    prepare(input: RetentionSelection): Promise<RetentionPlan>;
    private analyze;
}
/** Content validation only; this never grants authority to archive or remove anything. */
export declare function verifyRetentionPlan(value: unknown): value is RetentionPlan;
