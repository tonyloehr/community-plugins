/** Limits and transport defenses shared by the native Fusion MCP adapter. */
export declare const DEFAULT_NATIVE_RESPONSE_BYTES: number;
export declare const MAX_NATIVE_REQUEST_BYTES: number;
export declare const MAX_NATIVE_SCHEMA_BYTES: number;
export declare class NativeFusionError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare function boundedInteger(value: number, name: string, min: number, max: number): number;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
/**
 * Canonical JSON with depth, node and byte limits. Never calls user-controlled
 * getters/toJSON, coerces non-finite numbers, or serializes executable objects.
 * Object keys remain data (including a literal __proto__ from parsed JSON).
 */
export declare function boundedJson(value: unknown, maxBytes: number, maxDepth?: number): string;
export declare function cloneNativeJson<T>(value: T, maxBytes: number): T;
/**
 * Parse the raw authority before WHATWG URL normalization: it otherwise turns
 * 127.1, octal/hex IPv4 and integer IPv4 into apparently permitted loopback.
 * An explicit port is configuration, never a port-discovery instruction.
 */
export declare function validateNativeEndpoint(input: string): URL;
/**
 * Keep the SDK's JSON/SSE implementation, with a bounded Fetch response body.
 * The byte limit covers decompressed chunks before JSON or SSE parsing. Each
 * HTTP stream also has a deadline; notification streams need not live forever
 * because managed invocations always rediscover their schema immediately first.
 */
export declare function createBoundedNativeFetch(options: {
    endpoint: URL;
    timeoutMs: number;
    maxResponseBytes: number;
    connectionSignal: AbortSignal;
    fetchImpl: typeof fetch;
}): typeof fetch;
