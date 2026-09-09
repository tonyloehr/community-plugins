/** Limits and transport defenses shared by the native Fusion MCP adapter. */
export const DEFAULT_NATIVE_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_NATIVE_REQUEST_BYTES = 8 * 1024 * 1024;
export const MAX_NATIVE_SCHEMA_BYTES = 512 * 1024;

export class NativeFusionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "NativeFusionError";
  }
}

export function boundedInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new NativeFusionError("INVALID_CONFIGURATION", `${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/**
 * Canonical JSON with depth, node and byte limits. Never calls user-controlled
 * getters/toJSON, coerces non-finite numbers, or serializes executable objects.
 * Object keys remain data (including a literal __proto__ from parsed JSON).
 */
export function boundedJson(value: unknown, maxBytes: number, maxDepth = 48): string {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const charge = (text: string): string => {
    bytes += Buffer.byteLength(text);
    if (bytes > maxBytes) throw new NativeFusionError("PAYLOAD_TOO_LARGE", "Native JSON payload exceeds its byte limit.");
    return text;
  };
  const visit = (item: unknown, depth: number): string => {
    if (++nodes > 100_000 || depth > maxDepth) {
      throw new NativeFusionError("PAYLOAD_TOO_COMPLEX", "Native JSON payload exceeds its structural limit.");
    }
    if (item === null || typeof item === "boolean") return charge(JSON.stringify(item));
    if (typeof item === "number" && Number.isFinite(item)) return charge(JSON.stringify(item));
    if (typeof item === "string") {
      if (item.length > maxBytes) throw new NativeFusionError("PAYLOAD_TOO_LARGE", "Native string exceeds its byte limit.");
      return charge(JSON.stringify(item));
    }
    if (typeof item !== "object" || item === null || (!Array.isArray(item) && !isRecord(item))) {
      throw new NativeFusionError("INVALID_PAYLOAD", "Native arguments and results must contain only finite JSON values.");
    }
    if (ancestors.has(item)) throw new NativeFusionError("INVALID_PAYLOAD", "Native JSON payload contains a cycle.");
    if (Object.getOwnPropertySymbols(item).length) throw new NativeFusionError("INVALID_PAYLOAD", "Native JSON payload contains symbol properties.");
    ancestors.add(item);
    try {
      const keys = Object.keys(item);
      if (keys.length > 100_000) throw new NativeFusionError("PAYLOAD_TOO_COMPLEX", "Native JSON object has too many properties.");
      const ownValue = (key: string): unknown => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !("value" in descriptor)) throw new NativeFusionError("INVALID_PAYLOAD", "Native JSON payload contains an accessor or sparse array.");
        return descriptor.value;
      };
      if (Array.isArray(item)) {
        if (item.length !== keys.length || item.length > 100_000) {
          throw new NativeFusionError("INVALID_PAYLOAD", "Native JSON arrays must be dense and bounded.");
        }
        charge("[]" + ",".repeat(Math.max(0, item.length - 1)));
        const parts: string[] = [];
        for (let i = 0; i < item.length; i++) parts.push(visit(ownValue(String(i)), depth + 1));
        return `[${parts.join(",")}]`;
      }
      charge("{}" + ",".repeat(Math.max(0, keys.length - 1)));
      return `{${keys.sort().map(key => `${charge(JSON.stringify(key) + ":")}${visit(ownValue(key), depth + 1)}`).join(",")}}`;
    } finally {
      ancestors.delete(item);
    }
  };
  return visit(value, 0);
}

export function cloneNativeJson<T>(value: T, maxBytes: number): T {
  return JSON.parse(boundedJson(value, maxBytes)) as T;
}

/**
 * Parse the raw authority before WHATWG URL normalization: it otherwise turns
 * 127.1, octal/hex IPv4 and integer IPv4 into apparently permitted loopback.
 * An explicit port is configuration, never a port-discovery instruction.
 */
export function validateNativeEndpoint(input: string): URL {
  if (typeof input !== "string" || input.length > 2048 || /[\s\\?#]/u.test(input)) {
    throw new NativeFusionError("INVALID_ENDPOINT", "Configure a literal loopback MCP URL without credentials, query, fragment, whitespace, or backslashes.");
  }
  const match = /^(https?):\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})(\/[^\u0000-\u0020\u007f]*)?$/u.exec(input);
  if (!match || Number(match[3]) > 65535) {
    throw new NativeFusionError("INVALID_ENDPOINT", "Native Fusion requires literal 127.0.0.1 or [::1] and an explicit port from 1 through 65535.");
  }
  let url: URL;
  try { url = new URL(input); } catch { throw new NativeFusionError("INVALID_ENDPOINT", "The configured native MCP URL is invalid."); }
  if (url.username || url.password || url.hash || url.search) {
    throw new NativeFusionError("INVALID_ENDPOINT", "Native MCP endpoints cannot contain credentials, query parameters, or fragments.");
  }
  return url;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof NativeFusionError
    ? signal.reason
    : new NativeFusionError("NATIVE_CANCELLED", "The native MCP request was cancelled; this does not prove provider execution stopped.");
}

/** Await even a custom fetch implementation within an abortable deadline. */
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Keep the SDK's JSON/SSE implementation, with a bounded Fetch response body.
 * The byte limit covers decompressed chunks before JSON or SSE parsing. Each
 * HTTP stream also has a deadline; notification streams need not live forever
 * because managed invocations always rediscover their schema immediately first.
 */
export function createBoundedNativeFetch(options: {
  endpoint: URL;
  timeoutMs: number;
  maxResponseBytes: number;
  connectionSignal: AbortSignal;
  fetchImpl: typeof fetch;
}): typeof fetch {
  const configured = options.endpoint.href;
  return async (input, init) => {
    const target = input instanceof Request ? input.url : String(input);
    if (target !== configured) {
      throw new NativeFusionError("ENDPOINT_CHANGED", "The native transport attempted to use an endpoint other than its configured URL.");
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (!["GET", "POST", "DELETE"].includes(method)) throw new NativeFusionError("INVALID_METHOD", "Unsupported native MCP HTTP method.");
    if (typeof init?.body === "string" && Buffer.byteLength(init.body) > MAX_NATIVE_REQUEST_BYTES) {
      throw new NativeFusionError("PAYLOAD_TOO_LARGE", "Native MCP request exceeds its byte limit.");
    }
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new NativeFusionError("NATIVE_TIMEOUT", "The native MCP HTTP response exceeded its deadline.")), options.timeoutMs);
    timer.unref?.();
    const signals = [options.connectionSignal, deadline.signal];
    if (init?.signal) signals.push(init.signal);
    else if (input instanceof Request) signals.push(input.signal);
    const signal = AbortSignal.any(signals);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let finished = false;
    let onAbort: (() => void) | undefined;
    const finish = () => {
      finished = true;
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    };
    const cancelBody = () => { void reader?.cancel().catch(() => {}); };
    try {
      if (signal.aborted) throw abortReason(signal);
      const responsePromise = options.fetchImpl(input, {
        ...init, method, signal, redirect: "manual", credentials: "omit", cache: "no-store",
      });
      void responsePromise.then(response => {
        if (signal.aborted) void response.body?.cancel().catch(() => {});
      }, () => {});
      const response = await abortable(responsePromise, signal);
      if (signal.aborted) { void response.body?.cancel().catch(() => {}); throw abortReason(signal); }
      // A custom fetch must not conceal following a redirect either.
      if (response.redirected || (response.status >= 300 && response.status < 400) || (response.url && response.url !== configured)) {
        void response.body?.cancel().catch(() => {});
        throw new NativeFusionError("REDIRECT_REFUSED", "Redirects and endpoint changes are refused for native Fusion MCP.");
      }
      let headerBytes = 0;
      response.headers.forEach((value, key) => { headerBytes += Buffer.byteLength(key) + Buffer.byteLength(value); });
      if (headerBytes > 16_384) {
        void response.body?.cancel().catch(() => {});
        throw new NativeFusionError("PAYLOAD_TOO_LARGE", "Native MCP response headers exceed their byte limit.");
      }
      const length = response.headers.get("content-length");
      if (length && (!/^[0-9]+$/u.test(length) || Number(length) > options.maxResponseBytes)) {
        void response.body?.cancel().catch(() => {});
        throw new NativeFusionError("PAYLOAD_TOO_LARGE", "Native MCP response exceeds its byte limit.");
      }
      if (!response.body) { finish(); return response; }
      reader = response.body.getReader();
      let bytes = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          onAbort = () => {
            if (finished) return;
            finish();
            controller.error(abortReason(signal));
            cancelBody();
          };
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        },
        async pull(controller) {
          if (finished) return;
          try {
            const chunk = await reader!.read();
            if (finished) return;
            if (chunk.done) { finish(); controller.close(); return; }
            bytes += chunk.value.byteLength;
            if (bytes > options.maxResponseBytes) throw new NativeFusionError("PAYLOAD_TOO_LARGE", "Native MCP response exceeds its byte limit.");
            controller.enqueue(chunk.value);
          } catch (error) {
            if (finished) return;
            finish();
            controller.error(error);
            cancelBody();
          }
        },
        async cancel() { finish(); await reader?.cancel().catch(() => {}); },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      finish();
      cancelBody();
      throw error;
    }
  };
}
