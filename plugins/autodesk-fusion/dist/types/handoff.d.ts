import { z } from 'zod/v4';
import { errorResult } from './safety.js';
import type { ArtifactReservation } from './artifacts.js';
import type { ManagedPlan } from './engine.js';
import type { RecordStore } from './storage.js';
import type { OperationInput } from './types.js';
export declare const handoffAssertionSchema: z.ZodUnion<readonly [z.ZodObject<{
    kind: z.ZodLiteral<"equals">;
    pointer: z.ZodString;
    expected: z.ZodUnion<readonly [z.ZodString, z.ZodBoolean, z.ZodNull]>;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"numeric_range">;
    pointer: z.ZodString;
    minimum: z.ZodOptional<z.ZodNumber>;
    maximum: z.ZodOptional<z.ZodNumber>;
    unit: z.ZodObject<{
        pointer: z.ZodString;
        expected: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>]>;
export declare const handoffInputSchema: z.ZodObject<{
    title: z.ZodString;
    plan_ids: z.ZodDefault<z.ZodArray<z.ZodString>>;
    document_ids: z.ZodDefault<z.ZodArray<z.ZodString>>;
    requirements: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        statement: z.ZodString;
        reference: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
    assumptions: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        statement: z.ZodString;
        requirement_ids: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>>;
    reviewers: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        label: z.ZodString;
        role: z.ZodString;
        requirement_ids: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>>;
    checks: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        id: z.ZodString;
        requirement_ids: z.ZodDefault<z.ZodArray<z.ZodString>>;
        artifact_ids: z.ZodDefault<z.ZodArray<z.ZodString>>;
        reviewer_id: z.ZodOptional<z.ZodString>;
        kind: z.ZodLiteral<"typed_read">;
        request: z.ZodObject<{
            operation: z.ZodString;
            document_id: z.ZodString;
            args: z.ZodRecord<z.ZodString, z.ZodUnknown>;
            expected_state: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>;
        assertions: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
            kind: z.ZodLiteral<"equals">;
            pointer: z.ZodString;
            expected: z.ZodUnion<readonly [z.ZodString, z.ZodBoolean, z.ZodNull]>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"numeric_range">;
            pointer: z.ZodString;
            minimum: z.ZodOptional<z.ZodNumber>;
            maximum: z.ZodOptional<z.ZodNumber>;
            unit: z.ZodObject<{
                pointer: z.ZodString;
                expected: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>]>>;
    }, z.core.$strict>, z.ZodObject<{
        id: z.ZodString;
        requirement_ids: z.ZodDefault<z.ZodArray<z.ZodString>>;
        artifact_ids: z.ZodDefault<z.ZodArray<z.ZodString>>;
        reviewer_id: z.ZodOptional<z.ZodString>;
        kind: z.ZodLiteral<"manual">;
        procedure: z.ZodString;
    }, z.core.$strict>]>>>;
    external_evidence: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        description: z.ZodString;
        reference: z.ZodString;
        reported_sha256: z.ZodOptional<z.ZodString>;
        requirement_ids: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>>;
}, z.core.$strict>;
export type HandoffInput = z.infer<typeof handoffInputSchema>;
type HandoffCheck = HandoffInput['checks'][number];
type Assertion = z.infer<typeof handoffAssertionSchema>;
type JsonRecord = Record<string, unknown>;
export interface HandoffContext {
    profileId: string;
    profileHash: string;
    handlerHash: string;
    executionContractHash: string;
    verifyAccess(): Promise<void>;
    authorizeDocument(documentId: string): Promise<void>;
    inspectPlan(id: string): Promise<ManagedPlan>;
    read(request: OperationInput): Promise<unknown>;
    inspectArtifact(id: string): Promise<ArtifactReservation>;
}
export interface HandoffSource {
    document_id: string;
    state: string | null;
    observed_at: string;
    observation_sha256: string | null;
    metadata: JsonRecord;
    evidence: string;
    engineering_qualified: false;
    status: 'observed' | 'incomplete' | 'unavailable';
    freshness: HandoffFreshness | null;
    collection_check: {
        status: 'matching' | 'unavailable_or_changed';
        observed_at: string;
        state: string | null;
        freshness: HandoffFreshness | null;
    };
    error?: ReturnType<typeof errorResult>;
}
export interface HandoffFreshness {
    status: 'complete' | 'incomplete';
    freshness_scope: JsonRecord | null;
    freshness_gaps: string[];
    freshness_unavailable: string | null;
    issues: string[];
}
export interface HandoffCheckResult {
    id: string;
    kind: HandoffCheck['kind'];
    requirement_ids: string[];
    artifact_ids: string[];
    reviewer_id: string | null;
    status: 'criteria_met' | 'criteria_not_met' | 'incomplete' | 'not_run';
    source_document_id: string | null;
    source_state: string | null;
    observed_at: string | null;
    observation_sha256: string | null;
    evidence: string;
    engineering_qualified: false;
    freshness: HandoffFreshness | null;
    assertions: Array<{
        criterion: Assertion;
        result: 'met' | 'not_met' | 'unresolved';
        actual: unknown;
        actual_unit: unknown;
        reason?: string;
    }>;
    procedure?: string;
    error?: ReturnType<typeof errorResult>;
}
export interface HandoffManifest {
    schema_version: 2;
    id: string;
    created_at: string;
    state: 'draft';
    title: string;
    profile_id: string;
    profile_hash: string;
    handler_sha256: string;
    execution_contract_sha256: string;
    integrity: string;
    input: HandoffInput;
    sources: HandoffSource[];
    plans: JsonRecord[];
    artifacts: JsonRecord[];
    checks: HandoffCheckResult[];
    requirements: JsonRecord[];
    assumptions: JsonRecord[];
    reviewer_assignments: JsonRecord[];
    external_evidence: JsonRecord[];
    unresolved: Array<{
        code: string;
        reference: string;
        message: string;
    }>;
    engineering_approval: false;
    regulatory_compliance_established: false;
    external_release_performed: false;
    portability: JsonRecord;
    limitations: string[];
}
/** Pure bounded validation for inspection and retention. This performs no I/O. */
export declare function verifyHandoffManifest(value: unknown): HandoffManifest;
export declare class HandoffManager {
    private store;
    private context;
    constructor(store: RecordStore, context: HandoffContext);
    private source;
    prepare(input: unknown): Promise<HandoffManifest>;
    inspect(id: string): Promise<{
        manifest: HandoffManifest;
        inspection: JsonRecord;
    }>;
}
export {};
