export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | {
    [key: string]: JsonValue;
};
export type JsonObject = Record<string, unknown>;
export interface DesktopRequest {
    operation: string;
    args: JsonObject;
    request_id: string;
    document_id?: string;
    expected_state?: string;
}
export type DesktopResponse = {
    ok: true;
    data: unknown;
    state?: string;
    effects?: string[];
} | {
    ok: false;
    error: {
        code: string;
        message: string;
        details?: unknown;
        outcome?: "none" | "partial" | "unknown";
    };
};
export interface DesktopProvider {
    dispatch(request: DesktopRequest): Promise<DesktopResponse>;
    close?(): Promise<void>;
}
export interface Effect {
    kind: "read" | "local_edit" | "local_artifact" | "cloud_write" | "cloud_compute" | "administration";
    description: string;
}
export interface OperationDefinition {
    id: string;
    title: string;
    family: string;
    provider: "desktop" | "data" | "automation" | "local";
    maturity: "released" | "preview" | "unverified";
    effect: Effect["kind"];
    source: string;
    implemented: boolean;
    cancellation: "supported" | "unsupported" | "not_applicable";
    notes?: string;
}
export interface OperationInput {
    operation: string;
    args: JsonObject;
    document_id?: string;
    expected_state?: string;
}
export interface PlanRecord {
    id: string;
    hash: string;
    created_at: string;
    expires_at: string;
    operation: OperationInput;
    expected_state?: string;
    handler_hash: string;
    profile_hash: string;
    effect: Effect["kind"];
    summary: unknown;
    status: "prepared" | "executing" | "pending" | "succeeded" | "failed" | "outcome_unknown";
    idempotency_key?: string;
    result?: unknown;
}
export interface JobRecord {
    id: string;
    provider: string;
    provider_id?: string;
    status: "prepared" | "submitting" | "queued" | "running" | "validating" | "succeeded" | "failed" | "cancel_requested" | "cancelled" | "outcome_unknown";
    created_at: string;
    updated_at: string;
    request_hash: string;
    cancel_supported: boolean;
    reservation?: number;
    data?: unknown;
}
