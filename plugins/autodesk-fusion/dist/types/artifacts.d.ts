import { type FusionProfile } from './profile.js';
import type { DesktopResponse } from './types.js';
import { RecordStore } from './storage.js';
import { type ArtifactContentValidation, type PngExpectation } from './artifact-validation.js';
export type { ArtifactContentValidation, PngValidation, StlValidation } from './artifact-validation.js';
export { validatePngContent, validateStlContent } from './artifact-validation.js';
export interface ArtifactCompletionEvidence {
    provider_kind: 'native_mcp' | 'typed_addin' | 'synthetic_fixture' | 'unverified_provider';
    /** Actual successful dispatch/poll response retained by the broker, never a tool input. */
    response: Extract<DesktopResponse, {
        ok: true;
    }>;
    provider_job_id?: string;
    /** An already observed documents.list payload. A trusted profile is not a diagnostic. */
    diagnostic?: unknown;
}
export interface ArtifactCompletion {
    plan_id: string;
    plan_hash: string;
    evidence: ArtifactCompletionEvidence;
}
export interface ArtifactProvenance {
    schema: 1;
    producer: {
        plan_id: string;
        plan_hash: string;
        operation: string;
        handler_sha256: string;
        execution_contract_sha256: string;
        profile_sha256: string;
        provider_kind: ArtifactCompletionEvidence['provider_kind'];
        evidence: 'synthetic_fixture' | 'provider_reported' | 'unverified_provider_response';
        fusion_version: string | null;
        diagnostic_session_id: string | null;
        independently_verified: false;
    };
    source: {
        document_id: string;
        observed_document_id: string | null;
        session_id: string | null;
        state_at_preparation: string;
        state_at_completion: string | null;
        completion_state_matches_preparation: boolean | null;
        cloud: Record<string, string | number | null> | null;
        configuration: Record<string, string | boolean | null> | null;
        internal_units: Record<string, string | null> | null;
        reported_units: Record<string, string | null> | null;
        display_length_unit: string | null;
        scope: string;
    };
    request: {
        format: string;
        options: Record<string, unknown>;
        options_basis: string;
        png_dimensions: PngExpectation | null;
    };
    completion: {
        recorded_at: string;
        response_sha256: string;
        provider_job_id: string | null;
        provider_status: string | null;
        reported_output: {
            format: string | null;
            sha256: string | null;
            size_bytes: number | null;
            options: Record<string, unknown>;
        } | null;
    };
    known_losses: string[];
    unknown_fields: string[];
}
export interface ArtifactReservation {
    id: string;
    root: string;
    filename: string;
    format: string;
    directory: string;
    path: string;
    status: 'prepared' | 'generating' | 'succeeded' | 'pending' | 'failed';
    created_at: string;
    plan_id?: string;
    files?: ArtifactFile[];
    limitation?: string;
    producer_plan_hash?: string;
    completed_at?: string;
    manifest_sha256?: string;
    /** Missing means the original version 1 manifest/validation contract. */
    manifest_version?: 1 | 2;
    provenance?: ArtifactProvenance;
}
export interface ArtifactFile {
    name: string;
    size: number;
    sha256: string;
    media_type: string;
    checks: string[];
    validation?: ArtifactContentValidation;
}
export declare function validateFilename(filename: string): string;
export declare function readPinnedAsset(asset: {
    path: string;
    sha256: string;
}, maxBytes?: number): Promise<string>;
export declare class ArtifactManager {
    private profile;
    private store;
    private validateAccess?;
    constructor(profile: FusionProfile, store: RecordStore, validateAccess?: (() => Promise<void>) | undefined);
    reserve(destination: {
        root: string;
        filename: string;
    }, format: string): ArtifactReservation;
    stage(reservation: ArtifactReservation): Promise<ArtifactReservation>;
    /** A read never authorizes completion, even if a partial output looks valid. */
    inspect(id: string, allowPending?: boolean): Promise<ArtifactReservation>;
    /** Called only by the engine after an explicit successful provider result. */
    complete(id: string, producer: ArtifactCompletion): Promise<ArtifactReservation>;
    quarantine(id: string, status: 'pending' | 'failed', limitation: string): Promise<ArtifactReservation>;
    private inspectInternal;
}
