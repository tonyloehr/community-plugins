import { createHash } from "node:crypto";
import type { TokenProvider } from "./oauth.js";

export const APS_ORIGIN = "https://developer.api.autodesk.com";
export class CloudError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly outcome: "none" | "partial" | "unknown" = "none",
    public readonly retryable = false,
    public readonly httpStatus?: number,
    public readonly retryAfterMs?: number,
  ) { super(message); this.name = "CloudError"; }
  toJSON() { return { code: this.code, message: this.message, outcome: this.outcome, retryable: this.retryable, httpStatus: this.httpStatus, retryAfterMs: this.retryAfterMs }; }
}

export function isCloudObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
export function cloudString(value: unknown, name: string, max = 2048): asserts value is string {
  if (typeof value !== "string" || !value.length || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new CloudError("INVALID_ARGUMENT", `${name} must be a bounded nonempty string.`);
}
export function cloudId(value: unknown): string {
  cloudString(value, "Identifier");
  if (/[\\/]/.test(value) || value === "." || value === "..") throw new CloudError("INVALID_ARGUMENT", "Identifier cannot contain path navigation.");
  return encodeURIComponent(value);
}
export function cloudTimestamp(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new CloudError("INVALID_ARGUMENT", "An explicit ISO timestamp with timezone is required.");
}
export function cloudCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(cloudCanonical).join(",")}]`;
  if (isCloudObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${cloudCanonical(value[key])}`).join(",")}}`;
  if (value === undefined || typeof value === "number" && !Number.isFinite(value)) throw new CloudError("INVALID_ARGUMENT", "Only finite JSON values can be fingerprinted.");
  const result = JSON.stringify(value);
  if (result === undefined) throw new CloudError("INVALID_ARGUMENT", "Only JSON values can be fingerprinted.");
  return result;
}
export function cloudHash(value: unknown): string { return createHash("sha256").update(cloudCanonical(value)).digest("hex"); }
export function cloudSourceHash(source: string): string { return createHash("sha256").update(source).digest("hex"); }

/** Do not forward provider errors, signed URLs, request headers or credential-bearing fields to the model. */
export function redactCloudData(value: unknown, depth = 0): unknown {
  if (depth > 40) return "[depth limit]";
  if (typeof value === "string") {
    if (/\b(?:Bearer|Basic)\s+\S+/i.test(value)) return "[redacted credential]";
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        if (url.username || url.password || [...url.searchParams.keys()].some(key => /token|secret|signature|credential|x-amz-|x-goog-|^sig$|^code$/i.test(key))) return "[redacted credential URL]";
      } catch { return "[invalid URL]"; }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(item => redactCloudData(item, depth + 1));
  if (isCloudObject(value)) {
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      if (/token|authorization|password|secret|cookie|signature|signedurl|reporturl/i.test(key)) out[key] = "[redacted]";
      else if (!["__proto__", "prototype", "constructor"].includes(key)) out[key] = redactCloudData(item, depth + 1);
    }
    return out;
  }
  return value;
}

export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) > maxBytes) { await response.body?.cancel(); throw new CloudError("RESPONSE_TOO_LARGE", "Provider response exceeds the configured byte limit."); }
  if (response.status === 204) { await response.body?.cancel(); return null; }
  if (!response.body) throw new CloudError("INVALID_RESPONSE", "Provider returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new CloudError("RESPONSE_TOO_LARGE", "Provider response exceeds the configured byte limit."); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new CloudError("INVALID_RESPONSE", "Provider did not return valid JSON."); }
}

export function validateAutodeskOrigin(origin: string, manageTenant?: string): string {
  let url: URL;
  try { url = new URL(origin); } catch { throw new CloudError("INVALID_ENDPOINT", "Invalid Autodesk endpoint."); }
  const allowed = [APS_ORIGIN];
  if (manageTenant !== undefined) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(manageTenant)) throw new CloudError("INVALID_ENDPOINT", "Fusion Manage tenant must be an exact DNS label.");
    allowed.push(`https://${manageTenant}.autodeskplm360.net`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash || !allowed.includes(url.origin) || origin !== url.origin) throw new CloudError("INVALID_ENDPOINT", "Only the exact approved HTTPS Autodesk origin is allowed.");
  return url.origin;
}

export class CloudRateLimiter {
  #tail: Promise<void> = Promise.resolve();
  #next = 0;
  constructor(private readonly intervalMs = 500, private readonly now = Date.now, private readonly sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) {
    if (!Number.isFinite(intervalMs) || intervalMs < 400 || intervalMs > 60_000) throw new CloudError("INVALID_ARGUMENT", "Rate-limit interval must be between 400 and 60000 milliseconds.");
  }
  async acquire(): Promise<void> {
    const pending = this.#tail.then(async () => {
      const delay = Math.max(0, this.#next - this.now());
      if (delay) await this.sleep(delay);
      this.#next = this.now() + this.intervalMs;
    });
    this.#tail = pending.catch(() => {});
    return pending;
  }
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
export interface CloudReply { data: unknown; etag?: string; status: number }

/** Internal protocol transport. MCP exposes typed operations, never this arbitrary path surface. */
export class ApsTransport {
  #fetch: typeof globalThis.fetch;
  #limiter: Pick<CloudRateLimiter, "acquire">;
  #maxBytes: number;
  #timeout: number;
  #retries: number;
  #now: () => number;
  #sleep: (ms: number) => Promise<void>;
  #random: () => number;
  #opts: CloudTransportOptions;
  constructor(options: CloudTransportOptions) {
    cloudString(options.tenantId, "Tenant context", 256);
    if (!options.tokenProvider || typeof options.tokenProvider.getToken !== "function") throw new CloudError("NOT_AUTHENTICATED", "An independently authorized APS token provider is required.");
    if (options.manageTenant) validateAutodeskOrigin(`https://${options.manageTenant}.autodeskplm360.net`, options.manageTenant);
    this.#opts = { ...options };
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#limiter = options.limiter ?? new CloudRateLimiter();
    this.#maxBytes = options.maxResponseBytes ?? 2_000_000;
    this.#timeout = options.timeoutMs ?? 30_000;
    this.#retries = options.readRetries ?? 2;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.#random = options.random ?? Math.random;
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 128 || this.#maxBytes > 20_000_000 || !Number.isSafeInteger(this.#retries) || this.#retries < 0 || this.#retries > 5 || !Number.isFinite(this.#timeout) || this.#timeout < 1 || this.#timeout > 120_000) throw new CloudError("INVALID_ARGUMENT", "Invalid cloud transport limits.");
  }
  async token(scopes: readonly string[], minValidityMs = 30_000) {
    let grant;
    try { grant = await this.#opts.tokenProvider.getToken({ tenantId: this.#opts.tenantId, resource: APS_ORIGIN, scopes, minValidityMs }); }
    catch (error) {
      const safeCodes = new Set(['NOT_AUTHENTICATED', 'TOKEN_EXPIRED', 'SCOPE_DENIED', 'TENANT_MISMATCH', 'REAUTHENTICATION_REQUIRED', 'RATE_LIMITED', 'OAUTH_TRANSPORT_ERROR', 'OAUTH_PROVIDER_ERROR', 'INVALID_OAUTH_RESPONSE']);
      const code = error instanceof CloudError && safeCodes.has(error.code) ? error.code : 'NOT_AUTHENTICATED';
      throw new CloudError(code, 'APS credentials are unavailable or do not satisfy this request. Complete the configured Autodesk authorization flow; credential-provider diagnostics were withheld.');
    }
    if (!grant || grant.tenantId !== this.#opts.tenantId || grant.resource !== APS_ORIGIN || grant.issuer !== APS_ORIGIN) throw new CloudError("TENANT_MISMATCH", "Credential tenant, issuer or API resource does not match the configured scope.");
    if (!Number.isFinite(grant.expiresAt) || grant.expiresAt < this.#now() + minValidityMs) throw new CloudError("TOKEN_EXPIRED", "APS authorization expires too soon for this operation.");
    if (!Array.isArray(grant.scopes) || scopes.some(scope => !grant.scopes.includes(scope))) throw new CloudError("SCOPE_DENIED", "APS authorization lacks a required direct API scope.");
    if (typeof grant.accessToken !== "string" || !grant.accessToken.length || grant.accessToken.length > 32_768 || /[\r\n\s]/.test(grant.accessToken)) throw new CloudError("INVALID_TOKEN", "The credential provider returned an invalid access token.");
    if (!["authorization_code", "client_credentials"].includes(grant.grantType)) throw new CloudError("INVALID_TOKEN", "Unsupported APS authorization grant.");
    return grant;
  }
  async send(request: { path: string; origin?: string; method: "GET" | "POST" | "DELETE"; body?: unknown; scopes: readonly string[]; safeRead: boolean; headers?: Record<string, string>; minValidityMs?: number }): Promise<CloudReply> {
    const origin = validateAutodeskOrigin(request.origin ?? APS_ORIGIN, this.#opts.manageTenant);
    if (!request.path.startsWith("/") || request.path.startsWith("//") || /[\\\r\n#]/.test(request.path)) throw new CloudError("INVALID_ENDPOINT", "Invalid API path.");
    const url = new URL(request.path, origin);
    if (url.origin !== origin || url.username || url.password || /(?:^|\/)\.\.?(?:\/|$)/.test(decodeURIComponent(url.pathname))) throw new CloudError("INVALID_ENDPOINT", "API path cannot escape its approved origin.");
    const extra = request.headers ?? {};
    if (Object.keys(extra).some(key => !["x-tenant", "if-match"].includes(key.toLowerCase())) || Object.values(extra).some(value => /[\r\n]/.test(value))) throw new CloudError("INVALID_ARGUMENT", "Unapproved cloud request header.");
    if (!request.safeRead && request.method === "GET") throw new CloudError("INVALID_ARGUMENT", "Mutation cannot use GET.");
    const body = request.body === undefined ? undefined : JSON.stringify(request.body);
    if (body && Buffer.byteLength(body) > 2_000_000) throw new CloudError("REQUEST_TOO_LARGE", "Cloud request exceeds the configured byte limit.");
    for (let attempt = 0; ; attempt++) {
      await this.#limiter.acquire();
      const grant = await this.token(request.scopes, request.minValidityMs);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.#timeout);
      try {
        let response: Response;
        try {
          response = await this.#fetch(url, { method: request.method, redirect: "error", signal: controller.signal, headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...extra, authorization: `Bearer ${grant.accessToken}` }, ...(body ? { body } : {}) });
        } catch {
          if (request.safeRead && attempt < this.#retries) { clearTimeout(timeout); await this.#backoff(attempt); continue; }
          throw new CloudError(request.safeRead ? "NETWORK_ERROR" : "OUTCOME_UNKNOWN", request.safeRead ? "Autodesk request failed before a response could be read." : "The mutation acknowledgement was lost. Reconcile provider state before retrying; the operation may have taken effect.", request.safeRead ? "none" : "unknown", request.safeRead);
        }
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"), this.#now());
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          const isTransient = response.status === 429 || [408, 500, 502, 503, 504].includes(response.status);
          if (request.safeRead && isTransient && attempt < this.#retries && (retryAfter ?? 0) <= 60_000) { clearTimeout(timeout); await this.#backoff(attempt, retryAfter); continue; }
          const outcome = !request.safeRead && (response.status === 408 || response.status >= 500) ? "unknown" : "none";
          const code = outcome === "unknown" ? "OUTCOME_UNKNOWN" : response.status === 429 ? "RATE_LIMITED" : response.status === 401 ? "TOKEN_EXPIRED" : response.status === 403 ? "ACCESS_DENIED" : response.status === 404 ? "NOT_FOUND" : response.status === 409 || response.status === 412 ? "STALE_PLAN" : "PROVIDER_ERROR";
          throw new CloudError(code, outcome === "unknown" ? "Autodesk returned an uncertain mutation result; reconcile it before any retry." : `Autodesk returned HTTP ${response.status}. Provider response content was withheld to protect credentials and customer data.`, outcome, request.safeRead && isTransient, response.status, retryAfter);
        }
        let data;
        try { data = await readBoundedJson(response, this.#maxBytes); }
        catch (error) {
          if (!request.safeRead) throw new CloudError("OUTCOME_UNKNOWN", "Autodesk accepted the request but its response could not be safely read; reconcile before retrying.", "unknown");
          if (error instanceof CloudError) throw error;
          throw new CloudError("NETWORK_ERROR", "The Autodesk response stream was interrupted.", "none", true);
        }
        const etag = response.headers.get("etag") ?? undefined;
        return { data, status: response.status, ...(etag ? { etag } : {}) };
      } finally { clearTimeout(timeout); }
    }
  }
  async #backoff(attempt: number, retryAfter?: number) {
    const jitter = Math.max(0, Math.min(1, this.#random()));
    await this.#sleep(Math.min(60_000, Math.max(retryAfter ?? 0, 500 * 2 ** attempt * (0.75 + jitter * 0.5))));
  }
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Math.max(0, Number(value) * 1000);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed - now) : undefined;
}
