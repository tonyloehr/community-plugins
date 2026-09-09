import { type CloudScope } from "./cloud.js";
import { type CloudTransportOptions } from "./cloud-http.js";
import type { TokenProvider } from "./oauth.js";
export interface RecipeInputRule {
    type: "string" | "number" | "boolean";
    required: boolean;
    enum?: (string | number | boolean)[];
    minimum?: number;
    maximum?: number;
    maxLength?: number;
}
export interface FrozenCloudSource {
    hubId: string;
    projectId: string;
    itemId: string;
    versionId: string;
    configurationId: string | null;
    /** Hash of the exact Data Management version resource; recomputed during prepare and submit. */
    resourceHash: string;
}
export interface RecipeDestination {
    alias: string;
    kind: "fusion_project" | "object_storage";
    hubId?: string;
    projectId?: string;
    /** Exact origin and prefix for approved object storage, never caller-provided signed URLs. */
    origin?: string;
    keyPrefix?: string;
}
export interface ActivityBinding {
    reference: string;
    version: number;
    definitionHash: string;
    engine: string;
    /** Signature is installed by the activity publisher; do not generate one using client secrets. */
    signature?: string;
}
export interface BundleBinding {
    reference: string;
    version: number;
    definitionHash: string;
    packageSha256: string;
}
export interface AutomationRecipe {
    id: string;
    version: string;
    tenantId: string;
    delivery: "inline_script" | "appbundle";
    script?: {
        source: string;
        sha256: string;
        language: "typescript";
        entryPoint: string;
        typeDefinitionsVersion: string;
    };
    activity: ActivityBinding;
    bundles: BundleBinding[];
    inputSchema: Record<string, RecipeInputRule>;
    allowedSources: {
        hubId: string;
        projectId: string;
        itemId: string;
    }[];
    destinations: RecipeDestination[];
    limits: {
        maxVariants: number;
        maxInputBytes: number;
        maxOutputBytes: number;
        maxProcessingSeconds: number;
        maxAttempts: 1;
        minimumDelegatedTokenLifetimeMs: number;
    };
    cost: {
        kind: "estimated" | "provider_enforced";
        currency: string;
        amountPerVariant: number;
        priceAsOf: string;
        evidence: string;
        providerCeiling?: number;
    };
    authority: "managed_service" | "assisted_public_client" | "provider_constrained_public_client";
    /** Required for constrained public-client claims; signing a generic script activity alone is insufficient. */
    providerEnforcementEvidence?: string;
    dependencyImmutability: "release_alias_revalidated" | "provider_enforced";
    immutabilityEvidence?: string;
    verification: {
        procedure: string;
        validatorIds: string[];
    };
}
export interface AutomationPrepareContext {
    tenantId: string;
    sources: FrozenCloudSource[];
    destinationAlias: string;
    variantCount: number;
    requireHardCap?: boolean;
    requireImmutableEngine?: boolean;
    requireImmutableDependencies?: boolean;
}
export interface ActivityEvidence {
    reference: string;
    version: number;
    engine: string;
    definitionHash: string;
    bundles: {
        reference: string;
        version: number;
        definitionHash: string;
    }[];
    observedAt: string;
    rollingEngine: boolean;
    aliasRacePossible: boolean;
}
export interface PreparedAutomationJob {
    id: string;
    recipeId: string;
    recipeVersion: string;
    recipeHash: string;
    inputs: Record<string, string | number | boolean>;
    context: AutomationPrepareContext;
    activity: ActivityEvidence;
    destination: RecipeDestination;
    reservation: {
        amount: number;
        currency: string;
        kind: "estimated" | "provider_enforced";
        hardCap: boolean;
    };
    createdAt: string;
    expiresAt: string;
    warnings: string[];
    requestHash: string;
}
export interface AutomationJobStatus {
    providerId: string;
    providerStatus: string;
    status: "queued" | "running" | "validating" | "failed" | "cancelled" | "outcome_unknown";
    completionConfirmed: boolean;
    validationRequired: boolean;
    cancelSupported: boolean;
    observedAt: string;
    statistics: Record<string, string | number>;
}
export interface AutomationTransferArgument {
    name: string;
    verb: "get" | "put";
    url: string;
    bytes: number;
    sha256?: string;
}
export interface AutomationClientOptions extends Omit<CloudTransportOptions, "tenantId" | "manageTenant"> {
    scope: CloudScope;
    recipes: AutomationRecipe[];
    authMode: "app_only" | "app_with_user" | "public_pkce";
    delegatedTokenProvider?: TokenProvider;
    /** Trusted artifact stager only. Its returned URLs are never included in model-visible plans/status. */
    stageTransfers?: (job: PreparedAutomationJob) => Promise<AutomationTransferArgument[]>;
    permittedTransferOrigins?: string[];
    /** A trusted publisher must qualify provider cancellation for this Fusion activity; default false. */
    cancelQualified?: boolean;
    /** Resolve only provider IDs owned by this tenant in the host's durable job ledger. */
    authorizeExistingJob?: (providerId: string, tenantId: string) => Promise<void>;
    /** Recheck the host policy/account immediately after network preflights, before dispatching a mutation. */
    authorizeSubmission?: (job: Readonly<PreparedAutomationJob>) => Promise<void>;
}
export declare function activityDefinitionHash(value: unknown): string;
export declare function bundleDefinitionHash(value: unknown): string;
export declare function validateAutomationRecipe(recipe: AutomationRecipe, scope: CloudScope): AutomationRecipe;
export declare class AutomationClient {
    #private;
    constructor(options: AutomationClientOptions);
    toJSON(): {
        type: string;
        tenantId: string;
        authMode: "app_only" | "app_with_user" | "public_pkce";
        recipeIds: string[];
        cancelQualified: boolean;
    };
    listRecipes(): {
        id: string;
        version: string;
        delivery: "appbundle" | "inline_script";
        inputSchema: Record<string, RecipeInputRule>;
        destinations: string[];
        limits: {
            maxVariants: number;
            maxInputBytes: number;
            maxOutputBytes: number;
            maxProcessingSeconds: number;
            maxAttempts: 1;
            minimumDelegatedTokenLifetimeMs: number;
        };
        cost: {
            kind: "estimated" | "provider_enforced";
            currency: string;
            amountPerVariant: number;
            priceAsOf: string;
            evidence: string;
            providerCeiling?: number;
        };
        authority: "assisted_public_client" | "managed_service" | "provider_constrained_public_client";
        rollingEngine: boolean;
        verification: {
            procedure: string;
            validatorIds: string[];
        };
    }[];
    resolveActivity(recipeId: string): Promise<ActivityEvidence>;
    prepare(recipeId: string, inputs: Record<string, string | number | boolean>, context: AutomationPrepareContext): Promise<PreparedAutomationJob>;
    submit(prepared: PreparedAutomationJob): Promise<AutomationJobStatus>;
    status(providerId: string): Promise<AutomationJobStatus>;
    cancel(providerId: string): Promise<{
        providerId: string;
        status: "cancel_requested";
        completionConfirmed: false;
        reservationMustRemain: true;
    }>;
}
export interface BudgetReservation {
    jobId: string;
    amount: number;
    state: "reserved" | "submitting" | "running" | "unknown";
}
export interface BudgetSnapshot {
    currency: string;
    limit: number;
    spent: number;
    maxConcurrent: number;
    reservations: BudgetReservation[];
}
/** Pure ledger; the host persists snapshot() atomically with its job intent before any submission. */
export declare class BudgetLedger {
    #private;
    constructor(snapshot: Omit<BudgetSnapshot, "spent" | "reservations"> & {
        spent?: number;
        reservations?: BudgetReservation[];
    });
    snapshot(): BudgetSnapshot;
    get exposure(): number;
    reserve(jobId: string, amount: number, currency?: string): void;
    mark(jobId: string, state: "submitting" | "running" | "unknown"): void;
    releaseUnsubmitted(jobId: string): void;
    reconcile(jobId: string, terminalStatus: "succeeded" | "failed" | "cancelled", actualAmount: number): void;
}
