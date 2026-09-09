import type { TokenProvider } from "./oauth.js";
export declare const APS_ORIGIN = "https://developer.api.autodesk.com";
export declare class CloudError extends Error {
    readonly code: string;
    readonly outcome: "none" | "partial" | "unknown";
    readonly retryable: boolean;
    readonly httpStatus?: number | undefined;
    readonly retryAfterMs?: number | undefined;
    constructor(code: string, message: string, outcome?: "none" | "partial" | "unknown", retryable?: boolean, httpStatus?: number | undefined, retryAfterMs?: number | undefined);
    toJSON(): {
        code: string;
        message: string;
        outcome: "none" | "partial" | "unknown";
        retryable: boolean;
        httpStatus: number | undefined;
        retryAfterMs: number | undefined;
    };
}
export declare function isCloudObject(value: unknown): value is Record<string, unknown>;
export declare function cloudString(value: unknown, name: string, max?: number): asserts value is string;
export declare function cloudId(value: unknown): string;
export declare function cloudTimestamp(value: unknown): asserts value is string;
export declare function cloudCanonical(value: unknown): string;
export declare function cloudHash(value: unknown): string;
export declare function cloudSourceHash(source: string): string;
/** Do not forward provider errors, signed URLs, request headers or credential-bearing fields to the model. */
export declare function redactCloudData(value: unknown, depth?: number): unknown;
export declare function readBoundedJson(response: Response, maxBytes: number): Promise<unknown>;
export declare function validateAutodeskOrigin(origin: string, manageTenant?: string): string;
export declare class CloudRateLimiter {
    #private;
    private readonly intervalMs;
    private readonly now;
    private readonly sleep;
    constructor(intervalMs?: number, now?: () => number, sleep?: (ms: number) => Promise<void>);
    acquire(): Promise<void>;
}
export interface CloudTransportOptions {
    tokenProvider: TokenProvider;
    tenantId: string;
    manageTenant?: string;
    fetch?: typeof globalThis.fetch;
    limiter?: Pick<CloudRateLimiter, "acquire">;
    maxResponseBytes?: number;
    timeoutMs?: number;
    readRetries?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
}
export interface CloudReply {
    data: unknown;
    etag?: string;
    status: number;
}
/** Internal protocol transport. MCP exposes typed operations, never this arbitrary path surface. */
export declare class ApsTransport {
    #private;
    constructor(options: CloudTransportOptions);
    token(scopes: readonly string[], minValidityMs?: number): Promise<import("./oauth.js").AccessTokenGrant>;
    send(request: {
        path: string;
        origin?: string;
        method: "GET" | "POST" | "DELETE";
        body?: unknown;
        scopes: readonly string[];
        safeRead: boolean;
        headers?: Record<string, string>;
        minValidityMs?: number;
    }): Promise<CloudReply>;
}
export declare function parseRetryAfter(value: string | null, now?: number): number | undefined;
