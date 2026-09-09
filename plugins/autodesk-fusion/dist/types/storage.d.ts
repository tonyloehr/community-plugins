/** Internal input for retention analysis. Never return record payloads directly through MCP. */
export interface ReadOnlyRecordSnapshotEntry {
    ref: string;
    kind?: string;
    id?: string;
    entry_type: 'file' | 'directory' | 'symlink' | 'other';
    status: 'read' | 'protected' | 'unknown';
    bytes?: number;
    sha256?: string;
    value?: unknown;
    issue?: string;
}
export interface ReadOnlyRecordSnapshot {
    schema_version: 1;
    scope: 'top_level_local_state_records';
    root_hash: string;
    observed_at: string;
    complete: boolean;
    entries: ReadOnlyRecordSnapshotEntry[];
    entry_count_lower_bound: number;
    total_entry_count: number | null;
    issues: string[];
    excluded_subtrees: string[];
}
export interface ReadOnlyRecordSnapshotOptions {
    /** Only these known record kinds are read. All other payloads stay unopened. */
    readKinds: readonly string[];
    maxEntries?: number;
    maxTotalBytes?: number;
    maxDurationMs?: number;
}
export declare function ensurePrivateDirectory(directory: string): Promise<string>;
export declare class RecordStore {
    root: string;
    private ready?;
    private windowsRoot?;
    private posixRoot?;
    constructor(root: string);
    init(): Promise<void>;
    private checkStorage;
    private removeOwnedTemporary;
    private filename;
    get<T>(kind: string, id: string): Promise<T | undefined>;
    put(kind: string, id: string, value: unknown): Promise<void>;
    list<T>(kind: string): Promise<T[]>;
    /** Observes existing top-level ledger records only; never initializes, repairs or removes storage. */
    snapshotReadOnly(options: ReadOnlyRecordSnapshotOptions): Promise<ReadOnlyRecordSnapshot>;
    acquireLease(): Promise<() => Promise<void>>;
    audit(event: string, details: unknown): Promise<void>;
}
export declare function recoverDeadLease(root: string): Promise<void>;
