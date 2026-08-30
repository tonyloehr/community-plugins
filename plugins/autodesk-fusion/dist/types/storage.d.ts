export declare function ensurePrivateDirectory(directory: string): Promise<string>;
export declare class RecordStore {
    root: string;
    private ready?;
    private windowsRoot?;
    constructor(root: string);
    init(): Promise<void>;
    private checkWindows;
    private removeOwnedTemporary;
    private filename;
    get<T>(kind: string, id: string): Promise<T | undefined>;
    put(kind: string, id: string, value: unknown): Promise<void>;
    list<T>(kind: string): Promise<T[]>;
    acquireLease(): Promise<() => Promise<void>>;
    audit(event: string, details: unknown): Promise<void>;
}
export declare function recoverDeadLease(root: string): Promise<void>;
