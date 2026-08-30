import type { FusionProfile } from './profile.js';
import { RecordStore } from './storage.js';
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
}
export interface ArtifactFile {
    name: string;
    size: number;
    sha256: string;
    media_type: string;
    checks: string[];
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
    complete(id: string, producer: {
        plan_id: string;
        plan_hash: string;
    }): Promise<ArtifactReservation>;
    quarantine(id: string, status: 'pending' | 'failed', limitation: string): Promise<ArtifactReservation>;
    private inspectInternal;
}
