import type { DesktopRequest, DesktopResponse } from "./types.js";
export interface DesktopScript {
    script: string;
    marker: string;
    handlerHash: string;
    requestId: string;
}
export declare function validateDesktopRequest(value: DesktopRequest): DesktopRequest;
/**
 * The trusted caller supplies installed, reviewed source, never model code.
 * All other values are base64-encoded JSON. The generated source runs once as
 * a script body; an enrolled native script tool must qualify that convention.
 * This is an interoperability wrapper, not a Python or OS sandbox.
 */
export declare function buildDesktopScript(handlerSource: string, request: DesktopRequest, options?: {
    maxResponseBytes?: number;
}): DesktopScript;
export declare function validateDesktopResponse(value: unknown): DesktopResponse;
/**
 * Parse only a complete, nonce-bound envelope in textual tool output. A bare
 * success object, tool prose, image, resource link, or old envelope is never
 * execution evidence. Mirrored text/structured output may repeat one identical
 * envelope; conflicting results are rejected. No resource URL is fetched.
 */
export declare function parseDesktopResult(result: unknown, marker: string, maxResponseBytes?: number, expected?: {
    requestId: string;
    handlerHash: string;
}): DesktopResponse;
