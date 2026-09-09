import type { DesktopProvider, DesktopRequest, DesktopResponse } from "./types.js";
/**
 * The add-in rejects browser Fetch-Metadata. Node's global fetch adds
 * Sec-Fetch-Mode even outside browsers, so use Node HTTP for this narrow local
 * IPC route. Response sizing/deadlines are still enforced by the shared
 * bounded Fetch wrapper; no redirect following or general network proxy exists.
 */
export declare const addinLocalFetch: typeof fetch;
export interface AddinDesktopProviderOptions {
    url: string;
    tokenFile: string;
    /** SHA-256 of the canonical installed handlers/fusion_runtime.py. */
    handlerHash: string;
    timeoutMs?: number;
    maxResponseBytes?: number;
    fetchImpl?: typeof fetch;
}
export interface AddinConnectionInfo {
    provider: "addin";
    endpoint: string;
    sessionId: string;
    handlerHash: string;
    authenticated: true;
    trustBoundary: "same_os_user";
    liveQualification: "not_inferred";
}
/**
 * Optional typed add-in route. There is no fallback from native MCP, generic
 * script submission, credential disclosure, or automatic write retry here.
 * Authentication protects the local pairing boundary; it is not a user/role
 * policy engine or a sandbox against code running as the same OS user.
 */
export declare class AddinDesktopProvider implements DesktopProvider {
    private readonly endpoint;
    private readonly tokenFile;
    private readonly handlerHash;
    private readonly timeoutMs;
    private readonly maxResponseBytes;
    private readonly fetchImpl;
    private lifetime;
    private closed;
    constructor(options: AddinDesktopProviderOptions);
    connect(): Promise<AddinConnectionInfo>;
    dispatch(request: DesktopRequest): Promise<DesktopResponse>;
    close(): Promise<void>;
    private exchange;
}
