import { ApsClient, type MfgContext, type MfgPropertyDraft } from './cloud.js';
import { AutomationClient, type AutomationClientOptions, type AutomationPrepareContext, type PreparedAutomationJob, type AutomationJobStatus } from './cloud-automation.js';
import { compareBoms, normalizeBom, type BomSnapshot, type BomFieldOwnership, type BomMapping } from './bom.js';
import { ApsPkceClient, type TokenProvider, type TokenStore } from './oauth.js';
import { type FusionProfile } from './profile.js';
import { errorResult } from './safety.js';
import { RecordStore } from './storage.js';
import { type CloudBatchInspection, type CloudBatchOwner } from './cloud-batches.js';
import { type ManageDraftReview } from './manage-drafts.js';
export interface CloudJobRecord {
    id: string;
    prepared: PreparedAutomationJob;
    plan_hash: string;
    profile_hash: string;
    status: 'prepared' | 'submitting' | 'queued' | 'running' | 'validating' | 'succeeded' | 'failed' | 'cancel_requested' | 'cancelled' | 'outcome_unknown';
    created_at: string;
    updated_at: string;
    provider_id?: string;
    idempotency_key?: string;
    reserved_units: number;
    budget_period: string;
    submitted: boolean;
    provider?: AutomationJobStatus;
    scope_hash: string;
    authorization_binding: string;
    profile_id: string;
    validation?: CloudValidationReceipt & {
        receipt_hash: string;
    };
    settlement?: CloudBillingReceipt & {
        receipt_hash: string;
    };
    cancellation?: {
        attempted_at: string;
        acknowledgement: 'pending' | 'confirmed' | 'unknown' | 'rejected';
    };
    error?: ReturnType<typeof errorResult>;
    batch?: CloudBatchOwner;
    validation_in_progress?: {
        attempt_id: string;
        started_at: string;
        job_id: string;
        batch_id: string;
        request_hash: string;
    };
    output_identity_conflict?: {
        batch_id: string;
        receipt_hash: string;
        disposition: 'historical_validation_unusable';
    };
    validation_usable?: false;
}
export interface CloudCoordinatorOptions {
    profile: FusionProfile;
    profileFile?: string;
    root: string;
    store: RecordStore;
    tokenStore?: TokenStore;
    aps?: ApsClient;
    automation?: AutomationClient;
    /** Trusted host adapter; its opaque binding changes on account switch, not access-token refresh. */
    authorizationBinding?: () => Promise<string>;
    /** Trusted validators consume configured destinations; MCP supplies only a stored job ID. */
    validateOutputs?: (job: Readonly<CloudJobRecord>) => Promise<CloudValidationReceipt>;
    /** Trusted metering/invoice integration, never model-supplied prices or a boolean assertion. */
    reconcileBilling?: (job: Readonly<CloudJobRecord>) => Promise<CloudBillingReceipt>;
    /** Privileged deployment module services, never supplied through model/tool arguments. */
    enterpriseServices?: EnterpriseCloudServices;
    /** Host-owned source/hash/ownership revalidation; must not be supplied by the deployment module itself. */
    verifyEnterpriseAdapter?: () => Promise<void>;
}
export interface EnterpriseCloudServices {
    tokenProvider: TokenProvider;
    authMode: AutomationClientOptions['authMode'];
    /** Stable account/grant context. Must change on a different account or authorization grant, not token refresh. */
    authorizationBinding: () => Promise<string>;
    /** Optional separately authorized read/write principal for Data Management, MFGDM and Manage. */
    dataTokenProvider?: TokenProvider;
    delegatedTokenProvider?: TokenProvider;
    stageTransfers?: AutomationClientOptions['stageTransfers'];
    permittedTransferOrigins?: string[];
    cancelQualified?: boolean;
    validateOutputs?: CloudCoordinatorOptions['validateOutputs'];
    reconcileBilling?: CloudCoordinatorOptions['reconcileBilling'];
}
export interface CloudValidationReceipt {
    job_id: string;
    provider_id: string;
    request_hash: string;
    recipe_hash: string;
    observed_at: string;
    artifacts: {
        artifact_id: string;
        sha256: string;
        bytes: number;
    }[];
    checks: {
        validator_id: string;
        outcome: 'passed' | 'failed';
        evidence_ref: string;
    }[];
}
export interface CloudBillingReceipt {
    job_id: string;
    provider_id: string;
    request_hash: string;
    currency: string;
    actual_amount: number;
    observed_at: string;
    evidence_ref: string;
    source: 'provider_meter' | 'provider_invoice' | 'enterprise_billing_reconciliation';
    final: true;
}
export interface CloudDataPlan {
    id: string;
    hash: string;
    profile_hash: string;
    created_at: string;
    expires_at: string;
    operation: 'mfg.property_set';
    draft: MfgPropertyDraft;
    require_atomic_concurrency: boolean;
    status: 'prepared' | 'executing' | 'succeeded' | 'failed' | 'outcome_unknown';
    idempotency_key?: string;
    result?: unknown;
    scope_hash: string;
    authorization_binding: string;
}
export declare class CloudCoordinator {
    readonly options: CloudCoordinatorOptions;
    /** Present only for the direct public-client profile. Enterprise modules own their own authorization. */
    readonly oauth: ApsPkceClient | undefined;
    readonly aps: ApsClient;
    automation?: AutomationClient;
    private queue;
    private recipeFileHash?;
    private recipes;
    private constructor();
    static create(options: CloudCoordinatorOptions): Promise<CloudCoordinator>;
    private scopeBinding;
    private enterpriseDescriptor;
    private verifyEnterprise;
    private outputValidator;
    private billingReconciler;
    private ensureAccount;
    private accountBinding;
    private check;
    private guarded;
    status(): Promise<unknown>;
    read(operation: string, args: Record<string, unknown>): Promise<unknown>;
    prepareJob(recipeId: string, inputs: Record<string, string | number | boolean>, context: AutomationPrepareContext): Promise<CloudJobRecord>;
    private initialJob;
    private assertPreparedJob;
    private admissionSnapshot;
    private readBatchRecord;
    private assertBatchChild;
    private batchJobs;
    private readBatchConflict;
    private applyBatchConflict;
    private batchView;
    private materializeBatch;
    prepareBatch(input: unknown): Promise<CloudBatchInspection>;
    inspectBatch(id: string): Promise<CloudBatchInspection>;
    resumeBatch(id: string, expectedHash: string, maxSubmissions: number): Promise<{
        wave: {
            max_submissions: number;
            attempted_variant_ids: string[];
            admission_blocked: {
                code: string;
                outcome: string;
                variant_id?: string;
            } | null;
        };
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
    }>;
    inspectJob(id: string): Promise<CloudJobRecord>;
    submitJob(id: string, expectedHash: string, key: string): Promise<CloudJobRecord>;
    /** Caller holds the shared queue/lease; batch waves must not nest guarded(). */
    private submitJobLocked;
    jobStatus(id: string): Promise<CloudJobRecord>;
    private applyProviderStatus;
    cancelJob(id: string): Promise<unknown>;
    validateJob(id: string): Promise<CloudJobRecord>;
    private recordOutputConflict;
    settleJob(id: string): Promise<CloudJobRecord>;
    prepareBomSync(source: BomSnapshot, target: BomSnapshot, ownership: BomFieldOwnership[], mappings?: BomMapping[]): Promise<unknown>;
    private manageSchema;
    private assertManageContext;
    private assertManageFresh;
    /** Local outbox only. The caller cannot choose the reviewed schema or grant publication. */
    prepareManageDraft(value: unknown): Promise<ManageDraftReview>;
    /** Recheck an unchanged local record with GETs; never rewrite or renew it. */
    inspectManageDraft(id: string): Promise<ManageDraftReview>;
    prepareProperty(context: MfgContext, propertyId: string, after: string | number | boolean | null, requireAtomic?: boolean): Promise<CloudDataPlan>;
    inspectDataPlan(id: string): Promise<CloudDataPlan>;
    executeDataPlan(id: string, expectedHash: string, key: string): Promise<CloudDataPlan>;
}
export { compareBoms, normalizeBom };
