import { z } from 'zod/v4';
import type { AutomationPrepareContext, PreparedAutomationJob } from './cloud-automation.js';
import type { CloudJobRecord } from './cloud-coordinator.js';
export declare const cloudBatchPrepareSchema: z.ZodObject<{
    request_key: z.ZodString;
    recipe_id: z.ZodString;
    context: z.ZodObject<{
        tenantId: z.ZodString;
        sources: z.ZodArray<z.ZodObject<{
            hubId: z.ZodString;
            projectId: z.ZodString;
            itemId: z.ZodString;
            versionId: z.ZodString;
            configurationId: z.ZodNullable<z.ZodString>;
            resourceHash: z.ZodString;
        }, z.core.$strict>>;
        destinationAlias: z.ZodString;
        requireHardCap: z.ZodOptional<z.ZodBoolean>;
        requireImmutableEngine: z.ZodOptional<z.ZodBoolean>;
        requireImmutableDependencies: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>;
    variants: z.ZodArray<z.ZodObject<{
        variant_id: z.ZodString;
        inputs: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type CloudBatchPrepareInput = z.infer<typeof cloudBatchPrepareSchema>;
export type CloudBatchRequest = Omit<CloudBatchPrepareInput, 'request_key'>;
export interface CloudBatchOwner {
    batch_id: string;
    variant_id: string;
    request_hash: string;
}
export interface CloudBatchVariant {
    variant_id: string;
    idempotency_key: string;
    /** Immutable initial job, used only before the materialization fence is sealed. */
    initial_job: CloudJobRecord;
}
export interface CloudBatchRecord {
    schema_version: 1;
    id: string;
    plan_hash: string;
    request_hash: string;
    request_key_hash: string;
    request: CloudBatchRequest;
    created_at: string;
    expires_at: string;
    profile_id: string;
    profile_hash: string;
    scope_hash: string;
    authorization_binding: string;
    budget_period: string;
    currency: string;
    estimated_reservation: number;
    variants: CloudBatchVariant[];
    /** Progress is separate from immutable plan content; it does not grant submission authority. */
    phase: 'materializing' | 'ready';
}
/** Separate durable evidence keeps the original batch plan/hash immutable. */
export interface CloudBatchConflictRecord {
    schema_version: 1;
    id: string;
    batch_id: string;
    batch_plan_hash: string;
    request_hash: string;
    detected_at: string;
    trigger_job_id: string;
    code: 'OUTPUT_IDENTITY_CONFLICT';
    source: 'trusted_output_validator';
    resolution: 'blocked_no_reconciliation_api';
    candidate_receipt_sha256: string;
    conflicts: {
        artifact_id: string;
        job_ids: string[];
    }[];
    job_bindings: {
        job_id: string;
        plan_hash: string;
        validation_receipt_sha256: string;
    }[];
    receipt_hash: string;
}
export declare function cloudBatchConflictBinding(record: CloudBatchConflictRecord): unknown;
/** May validate the standalone receipt for retention; admission also passes its owning batch. */
export declare function assertCloudBatchConflictIntegrity(record: CloudBatchConflictRecord, batch?: CloudBatchRecord): void;
export declare function parseCloudBatchInput(value: unknown): CloudBatchPrepareInput;
export declare function cloudBatchId(profileId: string, requestKeyHash: string): string;
export declare function cloudBatchChildKey(batchId: string, variant: string): string;
export declare function cloudBatchBinding(batch: CloudBatchRecord): unknown;
export declare function cloudBatchContext(request: CloudBatchRequest): AutomationPrepareContext;
/** Compare actual prepared evidence with the requested variant, not a model-supplied success flag. */
export declare function assertPreparedBatchVariant(request: CloudBatchRequest, variant: CloudBatchRequest['variants'][number], prepared: PreparedAutomationJob): void;
/** Stored hashes detect changed records; they are not authentication against the local host owner. */
export declare function assertCloudBatchIntegrity(batch: CloudBatchRecord): void;
/** Only explicit artifact IDs count as output identity. Equal content hashes may be legitimate variants. */
export declare function batchArtifactConflicts(jobs: readonly (CloudJobRecord | undefined)[]): {
    artifact_id: string;
    job_ids: string[];
}[];
export declare function batchErrorCode(error: unknown): {
    code: string;
    outcome: string;
};
export declare function inspectCloudBatch(batch: CloudBatchRecord, jobs: readonly (CloudJobRecord | undefined)[], conflict?: CloudBatchConflictRecord): {
    schema_version: number;
    id: string;
    plan_hash: string;
    request_hash: string;
    phase: "materializing" | "ready";
    recipe_id: string;
    recipe_version: string | null;
    recipe_version_sha256: string;
    recipe_hash: string;
    profile_id: string;
    created_at: string;
    expires_at: string;
    context: {
        tenantId: string;
        sources: {
            hubId: string;
            projectId: string;
            itemId: string;
            versionId: string;
            configurationId: string | null;
            resourceHash: string;
        }[];
        destinationAlias: string;
        requireHardCap?: boolean | undefined;
        requireImmutableEngine?: boolean | undefined;
        requireImmutableDependencies?: boolean | undefined;
    } | null;
    context_summary: {
        sha256: string;
        hash_basis: string;
        source_count: number;
        inline_complete: boolean;
        inspect_job_id: string;
    };
    destination: import("./cloud-automation.js").RecipeDestination | null;
    destination_summary: {
        sha256: string;
        inline_complete: boolean;
        inspect_job_id: string;
    };
    admission_estimate: {
        amount: number;
        currency: string;
        budget_period: string;
        reserved_at_preparation: boolean;
        all_child_caps_provider_enforced: boolean;
    };
    variants: {
        variant_id: string;
        job_id: string;
        plan_hash: string;
        request_hash: string;
        inputs: Record<string, string | number | boolean> | null;
        input_summary: {
            sha256: string;
            field_count: number;
            inline_complete: boolean;
            inspect_job_id: string;
        };
        status: string;
        submitted: boolean;
        provider_id: string | null;
        reservation: {
            amount: number;
            currency: string;
            kind: "estimated" | "provider_enforced";
            hardCap: boolean;
        };
        reserved_units: number;
        validation: {
            kind: 'validation_receipt_summary';
            receipt_hash: string;
            observed_at: string | null;
            outcome: string;
            usable_for_acceptance: boolean;
            check_counts: {
                total: number;
                passed: number;
                failed: number;
            };
            artifact_count: number;
            artifact_bytes: number;
            full_receipt_included: false;
            inspect_job_id: string;
        } | null;
        settlement: {
            kind: 'billing_receipt_summary';
            receipt_hash: string;
            observed_at: string | null;
            actual_amount: number;
            currency: string;
            source: "enterprise_billing_reconciliation" | "provider_invoice" | "provider_meter";
            final: true;
            full_receipt_included: false;
            inspect_job_id: string;
        } | null;
        cancellation: {
            attempted_at: string | null;
            acknowledgement: "confirmed" | "pending" | "rejected" | "unknown";
        } | null;
        validation_usable: boolean;
        validation_disposition: string;
        validation_outcome_unknown: boolean;
        output_identity_conflict: {
            batch_id: string;
            receipt_hash: string;
            disposition: 'historical_validation_unusable';
        } | null;
        error: {
            code: string;
            outcome: string;
        } | null;
    }[];
    progress: {
        total: number;
        not_materialized: number;
        prepared: number;
        active: number;
        uncertain: number;
        validating: number;
        succeeded: number;
        failed: number;
        cancelled: number;
        unsettled_submitted_jobs: number;
    };
    all_outputs_validated: boolean;
    billing_settled: boolean;
    output_identity_conflicts: {
        artifact_id: string;
        job_ids: string[];
    }[];
    publication_performed: boolean;
    output_conflict_receipt: {
        id: string;
        receipt_hash: string;
        detected_at: string;
        resolution: "blocked_no_reconciliation_api";
    } | null;
    projection: {
        kind: string;
        all_variants_included: boolean;
        full_validation_receipts_included: boolean;
        full_billing_receipts_included: boolean;
        credential_redaction_applied: boolean;
        max_response_bytes: number;
        max_json_nodes: number;
        details_tool: string;
    };
    prepared_warning_summary: {
        sha256: string;
        total_count: number;
        inline_count: number;
        inline_complete: boolean;
        inspect_job_id: string;
    };
    warnings: string[];
};
export type CloudBatchInspection = ReturnType<typeof inspectCloudBatch>;
