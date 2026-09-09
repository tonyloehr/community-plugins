import { createHash } from "node:crypto";
import { Client, fromJsonSchema, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CallToolResult, JsonSchemaType, RequestOptions, Tool } from "@modelcontextprotocol/client";
import type { DesktopRequest, DesktopResponse } from "./types.js";
import { buildDesktopScript, parseDesktopResult, validateDesktopRequest } from "./native-script.js";
import {
  boundedInteger, boundedJson, cloneNativeJson, createBoundedNativeFetch,
  DEFAULT_NATIVE_RESPONSE_BYTES, isRecord, MAX_NATIVE_REQUEST_BYTES,
  MAX_NATIVE_SCHEMA_BYTES, NativeFusionError, validateNativeEndpoint,
} from "./native-security.js";

export { buildDesktopScript, parseDesktopResult } from "./native-script.js";
export { NativeFusionError, validateNativeEndpoint } from "./native-security.js";
export type { DesktopScript } from "./native-script.js";

const MAX_TOOL_PAGES = 16;
const MAX_TOOLS = 512;
const MAX_CURSOR_BYTES = 2048;
const READ_OPERATIONS = new Set([
  "documents.list", "document.inspect", "parameters.list", "entities.find",
  "geometry.measure", "geometry.check", "configurations.list", "materials.list",
  "render.status", "cam.inspect", "cam.status", "bom.inspect", "cam.setup_schema",
  "cam.operation_schema", "cam.tools_list", "cam.machining_time",
]);

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
  serverInfo?: { name: string; version: string };
  toolCount: number;
  authenticated: false;
  identityVerified: false;
}

/**
 * Fingerprint the invocation contract. Names, schemas, annotations and execution
 * metadata are bound; free-form descriptions/icons cannot grant authority.
 * This hash cannot prove the identity or implementation of a local listener.
 */
export function schemaFingerprint(tool: Pick<Tool, "name" | "inputSchema" | "outputSchema" | "annotations" | "execution">): string {
  const clean = cloneNativeJson(tool, MAX_NATIVE_SCHEMA_BYTES);
  if (!isRecord(clean) || typeof clean.name !== "string" || !isRecord(clean.inputSchema)) {
    throw new NativeFusionError("INVALID_TOOL_SCHEMA", "A native tool fingerprint requires its exact name and input schema.");
  }
  const contract = {
    name: clean.name,
    inputSchema: clean.inputSchema,
    outputSchema: clean.outputSchema ?? null,
    annotations: clean.annotations ?? null,
    execution: clean.execution ?? null,
  };
  return createHash("sha256").update(boundedJson(contract, MAX_NATIVE_SCHEMA_BYTES)).digest("hex");
}

function validateMapping(mapping: NativeToolMapping): NativeToolMapping {
  const clean = cloneNativeJson(mapping, MAX_NATIVE_SCHEMA_BYTES);
  if (!isRecord(clean) || Object.keys(clean).some(key => !["tool", "argument", "schemaHash", "fixedArguments"].includes(key))
    || typeof clean.tool !== "string" || !/^[A-Za-z0-9_.:/-]{1,128}$/u.test(clean.tool)
    || typeof clean.argument !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(clean.argument)
    || ["__proto__", "constructor", "prototype"].includes(clean.argument)
    || typeof clean.schemaHash !== "string" || !/^[a-f0-9]{64}$/u.test(clean.schemaHash)
    || (clean.fixedArguments !== undefined && !isRecord(clean.fixedArguments))) {
    throw new NativeFusionError("INVALID_ENROLLMENT", "Native enrollment requires an exact tool, string argument, and SHA-256 schema fingerprint.");
  }
  if (clean.fixedArguments && Object.hasOwn(clean.fixedArguments, clean.argument)) {
    throw new NativeFusionError("INVALID_ENROLLMENT", "Fixed native arguments cannot override the reviewed script argument.");
  }
  return clean;
}

/** Returns the one exact enrolled definition, or fails before any tools/call. */
export function validateEnrollment(mapping: NativeToolMapping, discoveredTools: readonly Tool[]): Tool {
  const enrolled = validateMapping(mapping);
  if (discoveredTools.length > MAX_TOOLS) throw new NativeFusionError("PAYLOAD_TOO_LARGE", "Native tool inventory exceeds its limit.");
  const candidates = discoveredTools.filter(tool => tool.name === enrolled.tool);
  if (candidates.length !== 1) {
    throw new NativeFusionError("UNENROLLED_TOOL", "The enrolled native tool is missing or ambiguous in the current inventory.");
  }
  const tool = cloneNativeJson(candidates[0]!, MAX_NATIVE_SCHEMA_BYTES);
  if (schemaFingerprint(tool) !== enrolled.schemaHash) {
    throw new NativeFusionError("SCHEMA_DRIFT", "The native tool contract changed; review and enroll the new schema before execution.");
  }
  if (tool.inputSchema.type !== "object" || !isRecord(tool.inputSchema.properties)) {
    throw new NativeFusionError("INVALID_ENROLLMENT", "The enrolled script tool must expose explicit top-level object properties.");
  }
  const argument = tool.inputSchema.properties[enrolled.argument];
  if (!isRecord(argument) || argument.type !== "string" || Object.hasOwn(argument, "$ref") || Object.hasOwn(argument, "x-mcp-header")) {
    throw new NativeFusionError("INVALID_ENROLLMENT", "The enrolled script argument must be an explicit string and cannot be mirrored into HTTP headers.");
  }
  const required = tool.inputSchema.required;
  if (required !== undefined && (!Array.isArray(required) || required.some(name => typeof name !== "string"
    || (name !== enrolled.argument && !Object.hasOwn(enrolled.fixedArguments ?? {}, name))))) {
    throw new NativeFusionError("INVALID_ENROLLMENT", "Every additional required native argument must have a reviewed fixed value.");
  }
  return tool;
}

/** Validation is local and cannot fetch remote JSON Schema references. */
async function validateToolArguments(tool: Tool, args: Record<string, unknown>): Promise<void> {
  const inspect = (value: unknown) => {
    if (Array.isArray(value)) { for (const child of value) inspect(child); }
    else if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        if ((key === "$ref" || key === "$dynamicRef") && (typeof child !== "string" || !child.startsWith("#"))) {
          throw new NativeFusionError("INVALID_TOOL_SCHEMA", "Native tool schemas cannot resolve external references.");
        }
        inspect(child);
      }
    }
  };
  boundedJson(tool.inputSchema, MAX_NATIVE_SCHEMA_BYTES);
  inspect(tool.inputSchema);
  try {
    const schema = fromJsonSchema(tool.inputSchema as JsonSchemaType);
    const validation = await schema["~standard"].validate(args);
    if (validation.issues) throw new NativeFusionError("INVALID_TOOL_ARGUMENTS", "Arguments do not satisfy the current enrolled native tool schema.");
  } catch (error) {
    if (error instanceof NativeFusionError) throw error;
    throw new NativeFusionError("INVALID_TOOL_SCHEMA", "The native tool input schema cannot be validated by the pinned adapter.");
  }
}

function safeError(error: unknown): NativeFusionError {
  if (error instanceof NativeFusionError) return error;
  // Native error strings may contain customer data, Python tracebacks or paths.
  // Keep vendor-supplied messages out of adapter diagnostics.
  return new NativeFusionError("NATIVE_UNAVAILABLE", "The native MCP connection or protocol request failed; verify Fusion and the enrolled endpoint.");
}

function unknownOutcome(cause: string): DesktopResponse {
  return {
    ok: false,
    error: {
      code: "OUTCOME_UNKNOWN",
      message: "Fusion may have applied the operation. Inspect the exact document and reconcile its state before attempting another write; cancellation is not rollback.",
      outcome: "unknown",
      details: { cause_code: cause, automatic_retry: false },
    },
  };
}

/**
 * SDK-backed native transport. It restricts this client's traffic, not other
 * processes that can reach Autodesk's unauthenticated loopback server.
 *
 * No tool names are built in. Managed dispatch requires a reviewed enrollment
 * and fixed installed Python module. callTool is for separately authorized
 * assisted callers and must never be exposed by a managed model-facing facade.
 */
export class NativeFusionClient {
  private readonly endpoint: URL;
  private readonly mapping?: NativeToolMapping;
  private readonly handlerSource?: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: typeof fetch;
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private network?: AbortController;
  private connecting?: Promise<NativeConnectionInfo>;
  private closing?: Promise<void>;
  private info?: NativeConnectionInfo;
  private closed = false;
  private ready = false;
  private epoch = 0;
  private closeEpoch = 0;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private readonly operations = new Set<AbortController>();

  constructor(options: NativeFusionClientOptions) {
    this.endpoint = validateNativeEndpoint(options.url);
    this.mapping = options.mapping === undefined ? undefined : validateMapping(options.mapping);
    this.handlerSource = options.handlerSource;
    this.timeoutMs = boundedInteger(options.timeoutMs ?? 30_000, "timeoutMs", 50, 120_000);
    this.maxResponseBytes = boundedInteger(options.maxResponseBytes ?? DEFAULT_NATIVE_RESPONSE_BYTES, "maxResponseBytes", 1024, 32 * 1024 * 1024);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /** Negotiates modern MCP or the SDK's legacy initialization, without writes. */
  async connect(): Promise<NativeConnectionInfo> {
    if (this.closing) await this.closing;
    if (this.ready && this.info) return cloneNativeJson(this.info, 16_384);
    if (this.connecting) return this.connecting;
    this.closed = false;
    const network = new AbortController();
    const client = new Client({ name: "community-autodesk-fusion", version: "0.1.0" }, {
      capabilities: {},
      enforceStrictCapabilities: true,
      versionNegotiation: { mode: "auto", probe: { timeoutMs: this.timeoutMs, maxRetries: 0 } },
      inputRequired: { autoFulfill: false },
      listMaxPages: MAX_TOOL_PAGES,
    });
    const transport = new StreamableHTTPClientTransport(this.endpoint, {
      fetch: createBoundedNativeFetch({ endpoint: this.endpoint, timeoutMs: this.timeoutMs, maxResponseBytes: this.maxResponseBytes, connectionSignal: network.signal, fetchImpl: this.fetchImpl }),
      requestInit: { redirect: "manual", credentials: "omit", cache: "no-store" },
      // Do not replay writes, perform auth step-up, or resume request streams.
      onInsufficientScope: "throw",
      maxStepUpRetries: 0,
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
    this.client = client;
    this.transport = transport;
    this.network = network;
    client.onerror = () => { if (this.client === client) this.epoch++; };
    client.onclose = () => {
      if (this.client === client) { this.ready = false; this.info = undefined; this.epoch++; }
    };
    client.setNotificationHandler("notifications/tools/list_changed", () => { if (this.client === client) this.epoch++; });
    const controller = new AbortController();
    this.operations.add(controller);
    const timer = setTimeout(() => controller.abort(new NativeFusionError("NATIVE_TIMEOUT", "Native MCP initialization exceeded its deadline.")), this.timeoutMs);
    const attempt = (async () => {
      try {
        await client.connect(transport, this.requestOptions(controller.signal));
        const inventory = await this.readTools(client, controller.signal);
        if (this.closed || this.client !== client || controller.signal.aborted) throw new NativeFusionError("NATIVE_CANCELLED", "Native MCP initialization was cancelled.");
        const reported = client.getServerVersion();
        const info: NativeConnectionInfo = {
          endpoint: this.endpoint.href, transport: "streamable-http",
          protocolVersion: client.getNegotiatedProtocolVersion() ?? "unknown",
          ...(reported ? { serverInfo: { name: reported.name, version: reported.version } } : {}),
          toolCount: inventory.length, authenticated: false, identityVerified: false,
        };
        this.info = cloneNativeJson(info, 16_384);
        this.ready = true;
        return cloneNativeJson(info, 16_384);
      } catch (error) {
        network.abort();
        await client.close().catch(() => {});
        if (this.client === client) { this.client = undefined; this.transport = undefined; this.info = undefined; this.ready = false; }
        throw safeError(controller.signal.aborted ? controller.signal.reason : error);
      } finally {
        clearTimeout(timer);
        this.operations.delete(controller);
      }
    })();
    this.connecting = attempt;
    try { return await attempt; } finally { if (this.connecting === attempt) this.connecting = undefined; }
  }

  async listTools(): Promise<Tool[]> {
    return this.enqueue(async signal => {
      const client = await this.ensureConnected(signal);
      return this.readTools(client, signal);
    });
  }

  /** Raw native result for explicitly authorized assisted-mode callers only. */
  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    let invoked = false;
    try {
      return await this.enqueue(async signal => {
        if (typeof name !== "string" || !/^[A-Za-z0-9_.:/-]{1,128}$/u.test(name) || !isRecord(args)) {
          throw new NativeFusionError("INVALID_TOOL_ARGUMENTS", "A native call requires an exact discovered tool name and JSON arguments.");
        }
        const cleanArgs = cloneNativeJson(args, MAX_NATIVE_REQUEST_BYTES);
        const client = await this.ensureConnected(signal);
        const definitions = await this.readTools(client, signal);
        const tool = definitions.find(candidate => candidate.name === name);
        if (!tool) throw new NativeFusionError("UNENROLLED_TOOL", "The requested tool does not appear in the current native inventory.");
        await validateToolArguments(tool, cleanArgs);
        this.assertActive(signal);
        invoked = true;
        const result = await client.callTool({ name, arguments: cleanArgs }, { ...this.requestOptions(signal), toolDefinition: tool });
        return cloneNativeJson(result, this.maxResponseBytes);
      });
    } catch (error) {
      if (invoked) throw new NativeFusionError("OUTCOME_UNKNOWN", "The native tool call has an unconfirmed outcome. It was not retried; reconcile provider state before another attempt.");
      throw safeError(error);
    }
  }

  async dispatch(request: DesktopRequest): Promise<DesktopResponse> {
    let invoked = false;
    let readOnly = false;
    try {
      const clean = validateDesktopRequest(request);
      readOnly = READ_OPERATIONS.has(clean.operation);
      return await this.enqueue(async signal => {
        if (!this.mapping) throw new NativeFusionError("UNENROLLED_TOOL", "Managed desktop execution requires a reviewed native script-tool enrollment.");
        if (!this.handlerSource) throw new NativeFusionError("INVALID_HANDLER", "Managed desktop execution requires the installed reviewed handler module.");
        // Leave space for base64, mirrored native output and MCP framing.
        const generated = buildDesktopScript(this.handlerSource, clean, { maxResponseBytes: Math.max(512, Math.floor((this.maxResponseBytes - 512) / 3)) });
        const client = await this.ensureConnected(signal);
        const tool = validateEnrollment(this.mapping, await this.readTools(client, signal));
        const args: Record<string, unknown> = { ...this.mapping.fixedArguments, [this.mapping.argument]: generated.script };
        boundedJson(args, MAX_NATIVE_REQUEST_BYTES);
        await validateToolArguments(tool, args);
        this.assertActive(signal);
        invoked = true;
        // Explicit toolDefinition disables SDK HEADER_MISMATCH refetch/retry.
        const raw = await client.callTool({ name: tool.name, arguments: args }, { ...this.requestOptions(signal), toolDefinition: tool });
        const result = parseDesktopResult(raw, generated.marker, this.maxResponseBytes, { requestId: generated.requestId, handlerHash: generated.handlerHash });
        if (!result.ok && !readOnly && result.error.outcome !== "none" && result.error.outcome !== "partial") return unknownOutcome(result.error.code);
        // A read/status handler may report uncertainty about a prior job. Its
        // explicit outcome remains evidence; only transport failures of the
        // current read are classified as having no new mutation below.
        return result;
      });
    } catch (error) {
      const failure = safeError(error);
      if (invoked && !readOnly) return unknownOutcome(failure.code);
      return { ok: false, error: { code: failure.code, message: failure.message, outcome: "none" } };
    }
  }

  /**
   * Cancel waiting/in-flight client requests and close its MCP session. This
   * never claims cancellation of a Fusion edit or rolls back a document.
   * An explicit subsequent connect() can establish a fresh connection.
   */
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closeEpoch++;
    this.ready = false;
    this.info = undefined;
    for (const controller of this.operations) controller.abort(new NativeFusionError("NATIVE_CANCELLED", "The native MCP client was closed; provider execution may still be running."));
    const client = this.client;
    const transport = this.transport;
    const network = this.network;
    const attempt = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (transport?.sessionId) {
          await Promise.race([
            transport.terminateSession().catch(() => {}),
            new Promise<void>(resolve => { timer = setTimeout(resolve, Math.min(this.timeoutMs, 1000)); }),
          ]);
        }
      } finally {
        if (timer) clearTimeout(timer);
        network?.abort();
        await client?.close().catch(() => {});
        if (this.client === client) { this.client = undefined; this.transport = undefined; this.network = undefined; }
      }
    })();
    this.closing = attempt;
    try { await attempt; } finally { if (this.closing === attempt) this.closing = undefined; }
  }

  private requestOptions(signal: AbortSignal): RequestOptions {
    return { signal, timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs, resetTimeoutOnProgress: false };
  }

  private assertActive(signal: AbortSignal): void {
    if (signal.aborted) throw safeError(signal.reason);
    if (this.closed) throw new NativeFusionError("NATIVE_CANCELLED", "The native MCP client is closed. Reconnect explicitly before continuing.");
  }

  private async ensureConnected(signal: AbortSignal): Promise<Client> {
    this.assertActive(signal);
    if (!this.ready) await this.connect();
    this.assertActive(signal);
    if (!this.client) throw new NativeFusionError("NATIVE_UNAVAILABLE", "Native MCP is not connected.");
    return this.client;
  }

  private async readTools(client: Client, signal: AbortSignal): Promise<Tool[]> {
    const generation = this.epoch;
    const tools: Tool[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let bytes = 0;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      this.assertActive(signal);
      // Use the SDK's typed request method for explicit bounded pagination.
      // Its convenience listTools() silently ends on a repeated cursor; that
      // must be an error here, not an apparently complete qualification list.
      const result = await client.request({ method: "tools/list", ...(cursor === undefined ? {} : { params: { cursor } }) }, this.requestOptions(signal));
      bytes += Buffer.byteLength(boundedJson(result, this.maxResponseBytes));
      if (bytes > this.maxResponseBytes) throw new NativeFusionError("PAYLOAD_TOO_LARGE", "The complete native tool inventory exceeds its byte limit.");
      for (const tool of result.tools) {
        if (names.has(tool.name)) throw new NativeFusionError("INVALID_TOOL_INVENTORY", "The native tool inventory contains ambiguous duplicate names.");
        if (!/^[A-Za-z0-9_.:/-]{1,128}$/u.test(tool.name)) throw new NativeFusionError("INVALID_TOOL_INVENTORY", "The native tool inventory contains an unsupported tool name.");
        boundedJson(tool, MAX_NATIVE_SCHEMA_BYTES);
        names.add(tool.name);
        tools.push(tool);
        if (tools.length > MAX_TOOLS) throw new NativeFusionError("PAYLOAD_TOO_LARGE", "The native tool inventory exceeds its tool-count limit.");
      }
      if (this.epoch !== generation) throw new NativeFusionError("SCHEMA_DRIFT", "Native capabilities changed during discovery. Reconnect and review the current inventory.");
      if (result.nextCursor === undefined) return cloneNativeJson(tools, this.maxResponseBytes);
      cursor = result.nextCursor;
      if (!cursor.length || Buffer.byteLength(cursor) > MAX_CURSOR_BYTES || cursors.has(cursor)) {
        throw new NativeFusionError("INVALID_TOOL_INVENTORY", "The native tool inventory returned an invalid or repeated pagination cursor.");
      }
      cursors.add(cursor);
    }
    throw new NativeFusionError("PAYLOAD_TOO_LARGE", "The native tool inventory exceeds its page-count limit.");
  }

  private async enqueue<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) throw new NativeFusionError("NATIVE_CANCELLED", "The native MCP client is closed. Reconnect explicitly before continuing.");
    if (this.pending >= 32) throw new NativeFusionError("SESSION_BUSY", "The bounded native MCP request queue is full.");
    const controller = new AbortController();
    const generation = this.closeEpoch;
    this.operations.add(controller);
    this.pending++;
    const timer = setTimeout(() => controller.abort(new NativeFusionError("NATIVE_TIMEOUT", "The native MCP operation exceeded its deadline.")), this.timeoutMs);
    const task = this.queue.then(async () => {
      this.assertActive(controller.signal);
      if (generation !== this.closeEpoch) throw new NativeFusionError("NATIVE_CANCELLED", "The native request belongs to a closed connection.");
      return work(controller.signal);
    });
    this.queue = task.then(() => {}, () => {});
    try {
      return await new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(safeError(controller.signal.reason));
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
        task.then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", onAbort));
      });
    } finally {
      clearTimeout(timer);
      this.operations.delete(controller);
      // Aborted queued work is still chained and checks its expired signal,
      // so it cannot execute later or overtake the request ahead of it.
      void task.finally(() => { this.pending--; }).catch(() => {});
    }
  }
}
