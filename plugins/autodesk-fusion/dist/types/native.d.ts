import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import type { DesktopRequest, DesktopResponse } from "./types.js";
export { buildDesktopScript, parseDesktopResult } from "./native-script.js";
export { NativeFusionError, validateNativeEndpoint } from "./native-security.js";
export type { DesktopScript } from "./native-script.js";
export type NativeTool = Tool;
/** An administrator-reviewed enrollment, never inferred from tool prose. */
export interface NativeToolMapping {
    tool: string;
    argument: string;
    schemaHash: string;
    fixedArguments?: Record<string, unknown>;
}
export interface NativeFusionClientOptions {
    url: string;
    mapping?: NativeToolMapping;
    /** Installed, reviewed module source supplied by the trusted host. */
    handlerSource?: string;
    timeoutMs?: number;
    maxResponseBytes?: number;
    fetchImpl?: typeof fetch;
}
export interface NativeConnectionInfo {
    endpoint: string;
    transport: "streamable-http";
    protocolVersion: string;
    serverInfo?: {
        name: string;
        version: string;
    };
    toolCount: number;
    authenticated: false;
    identityVerified: false;
}
/**
 * Fingerprint the invocation contract. Names, schemas, annotations and execution
 * metadata are bound; free-form descriptions/icons cannot grant authority.
 * This hash cannot prove the identity or implementation of a local listener.
 */
export declare function schemaFingerprint(tool: Pick<Tool, "name" | "inputSchema" | "outputSchema" | "annotations" | "execution">): string;
/** Returns the one exact enrolled definition, or fails before any tools/call. */
export declare function validateEnrollment(mapping: NativeToolMapping, discoveredTools: readonly Tool[]): Tool;
/**
 * SDK-backed native transport. It restricts this client's traffic, not other
 * processes that can reach Autodesk's unauthenticated loopback server.
 *
 * No tool names are built in. Managed dispatch requires a reviewed enrollment
 * and fixed installed Python module. callTool is for separately authorized
 * assisted callers and must never be exposed by a managed model-facing facade.
 */
export declare class NativeFusionClient {
    private readonly endpoint;
    private readonly mapping?;
    private readonly handlerSource?;
    private readonly timeoutMs;
    private readonly maxResponseBytes;
    private readonly fetchImpl;
    private client?;
    private transport?;
    private network?;
    private connecting?;
    private closing?;
    private info?;
    private closed;
    private ready;
    private epoch;
    private closeEpoch;
    private queue;
    private pending;
    private readonly operations;
    constructor(options: NativeFusionClientOptions);
    /** Negotiates modern MCP or the SDK's legacy initialization, without writes. */
    connect(): Promise<NativeConnectionInfo>;
    listTools(): Promise<Tool[]>;
    /** Raw native result for explicitly authorized assisted-mode callers only. */
    callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
    dispatch(request: DesktopRequest): Promise<DesktopResponse>;
    /**
     * Cancel waiting/in-flight client requests and close its MCP session. This
     * never claims cancellation of a Fusion edit or rolls back a document.
     * An explicit subsequent connect() can establish a fresh connection.
     */
    close(): Promise<void>;
    private requestOptions;
    private assertActive;
    private ensureConnected;
    private readTools;
    private enqueue;
}
