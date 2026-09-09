export declare class FusionError extends Error {
    code: string;
    outcome: 'none' | 'partial' | 'unknown';
    details?: unknown;
    constructor(code: string, message: string, outcome?: 'none' | 'partial' | 'unknown', details?: unknown);
}
export declare function assertJson(value: unknown, maxBytes?: number): void;
export declare function canonicalJson(value: unknown): string;
export declare const hash: (value: unknown) => string;
export declare const hashBytes: (value: string | Buffer) => string;
export declare const newId: (prefix: string) => string;
export declare const now: () => string;
export declare function redact(value: unknown): unknown;
export declare function errorResult(error: unknown): {
    code: string;
    message: string;
    outcome: string;
    details?: unknown;
};
export declare class SerialQueue {
    private tail;
    run<T>(fn: () => Promise<T>): Promise<T>;
}
