import { ApsClient, type MfgContext, type MfgPropertyDraft } from './cloud.js';
import { AutomationClient, type AutomationClientOptions, type AutomationPrepareContext, type PreparedAutomationJob, type AutomationJobStatus } from './cloud-automation.js';
import { compareBoms, normalizeBom, type BomSnapshot, type BomFieldOwnership, type BomMapping } from './bom.js';
import { ApsPkceClient, type TokenProvider, type TokenStore } from './oauth.js';
import { type FusionProfile } from './profile.js';
import { errorResult } from './safety.js';
import { RecordStore } from './storage.js';
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
    inspectJob(id: string): Promise<CloudJobRecord>;
    submitJob(id: string, expectedHash: string, key: string): Promise<CloudJobRecord>;
    jobStatus(id: string): Promise<CloudJobRecord>;
    private applyProviderStatus;
    cancelJob(id: string): Promise<unknown>;
    validateJob(id: string): Promise<CloudJobRecord>;
    settleJob(id: string): Promise<CloudJobRecord>;
    prepareBomSync(source: BomSnapshot, target: BomSnapshot, ownership: BomFieldOwnership[], mappings?: BomMapping[]): Promise<unknown>;
    prepareProperty(context: MfgContext, propertyId: string, after: string | number | boolean | null, requireAtomic?: boolean): Promise<CloudDataPlan>;
    inspectDataPlan(id: string): Promise<CloudDataPlan>;
    executeDataPlan(id: string, expectedHash: string, key: string): Promise<CloudDataPlan>;
}
export { compareBoms, normalizeBom };
