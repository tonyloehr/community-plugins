import { ArtifactManager, type ArtifactReservation } from './artifacts.js';
import { type FusionProfile } from './profile.js';
import { HandoffManager, type HandoffManifest } from './handoff.js';
import { type RetentionInventory, type RetentionPlan, type RetentionSelection } from './retention.js';
import { errorResult } from './safety.js';
import { RecordStore } from './storage.js';
import type { DesktopProvider, JsonObject, PlanRecord, JobRecord } from './types.js';
export interface ManagedPlan extends PlanRecord {
    execution_contract_hash: string;
    provider_args: JsonObject;
    artifact?: ArtifactReservation;
    before: unknown;
    policy_decision: {
        authorized: boolean;
        blocker?: string;
    };
    limitations: string[];
}
export interface DesktopJobRecord extends JobRecord {
    provider: 'desktop_cam' | 'desktop_render';
    provider_id: string;
    plan_id: string;
    document_id: string;
    artifact_id?: string;
    execution_contract_hash: string;
    binding_hash: string;
    submission_error?: ReturnType<typeof errorResult>;
}
export interface FusionEngineOptions {
    profileFile?: string;
    handlerFile?: string;
    executionContractHash?: string;
    executionContractFiles?: Array<{
        path: string;
        sha256: string;
    }>;
}
export declare class FusionEngine {
    readonly profile: FusionProfile;
    readonly desktop: DesktopProvider;
    readonly handlerHash: string;
    readonly options: FusionEngineOptions;
    readonly store: RecordStore;
    readonly artifacts: ArtifactManager;
    readonly handoffs: HandoffManager;
    readonly executionContractHash: string;
    readonly executionContractKind: 'installed_code' | 'schema_only';
    private queue;
    private preparedTimes;
    private initialized;
    constructor(profile: FusionProfile, desktop: DesktopProvider, handlerHash: string, options?: FusionEngineOptions);
    init(): Promise<void>;
    assertTrustedConfiguration(): Promise<void>;
    isCreatedDocument(documentId: string): Promise<boolean>;
    private authorizeOperation;
    private verifyDesktopQualification;
    private checkProfile;
    private assertPlanBinding;
    private artifactCompletionEvidence;
    private recordJob;
    private readScope;
    private discoverDocuments;
    private scopedDocumentList;
    private desktopEvidence;
    capabilities(family?: string, includeSchema?: boolean): unknown;
    connectionStatus(): Promise<unknown>;
    read(input: unknown): Promise<unknown>;
    private observe;
    private providerArguments;
    prepare(input: unknown): Promise<ManagedPlan>;
    inspectPlan(id: string): Promise<ManagedPlan>;
    execute(id: string, expectedHash: string, idempotencyKey: string): Promise<ManagedPlan>;
    recovery(id: string): Promise<unknown>;
    jobStatus(id: string, expectedDocument?: string, expectedProvider?: 'desktop_cam' | 'desktop_render', expectedState?: string): Promise<DesktopJobRecord>;
    handoff(input: unknown, planIds?: string[]): Promise<HandoffManifest>;
    inspectHandoff(id: string): Promise<Awaited<ReturnType<HandoffManager['inspect']>>>;
    private retentionPlanner;
    inventoryRetention(): Promise<RetentionInventory>;
    prepareRetention(input: RetentionSelection): Promise<RetentionPlan>;
    close(): Promise<void>;
}
export declare function createFixtureEngine(profile: FusionProfile, options?: FusionEngineOptions): Promise<FusionEngine>;
