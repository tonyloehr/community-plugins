import type { StoredApsGrant, TokenStore } from './oauth.js';
export interface CredentialEntry {
    getPassword(signal?: AbortSignal): Promise<string | null | undefined>;
    setPassword(value: string, signal?: AbortSignal): Promise<void>;
    deleteCredential(signal?: AbortSignal): Promise<boolean>;
}
export type CredentialFactory = (service: string, account: string) => CredentialEntry;
export declare function nativeCredentialFactory(root: string): Promise<CredentialFactory>;
export interface CredentialCleanupStatus {
    trackedGenerations: number;
    pendingRetiredGenerations: number;
    currentManifestPresent: boolean;
    containsCredentialContents: false;
}
export declare class NativeTokenStore implements TokenStore {
    private root;
    private suppliedFactory?;
    private options;
    readonly service = "community-plugins.autodesk-fusion.aps.v1";
    private factory?;
    constructor(root: string, suppliedFactory?: CredentialFactory | undefined, options?: {
        lockRoot?: string;
    });
    private safe;
    private grantDirectory;
    private hasRefreshFence;
    markRefreshPending(key: string): Promise<void>;
    clearRefreshPending(key: string): Promise<void>;
    withLock<T>(key: string, action: () => Promise<T>): Promise<T>;
    private entry;
    private manifest;
    private mergeGenerations;
    private cleanupGenerations;
    private writeCleanupGenerations;
    /** Reports conservative receipts, not a vault enumeration. Contains no grant or native account values. */
    cleanupStatus(key: string): Promise<CredentialCleanupStatus>;
    get(key: string): Promise<StoredApsGrant | null>;
    set(key: string, grant: StoredApsGrant): Promise<void>;
    private removeEntryStrict;
    private removeChunksStrict;
    private removeRetiredBestEffort;
    delete(key: string): Promise<void>;
    toJSON(): {
        type: string;
        service: string;
        plaintext_fallback: boolean;
        cleanup: string;
    };
}
