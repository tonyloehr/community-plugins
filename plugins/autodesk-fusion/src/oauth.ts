import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { APS_ORIGIN, CloudError, cloudString, isCloudObject, readBoundedJson } from "./cloud-http.js";

export interface TokenRequest {
  tenantId: string;
  resource: string;
  scopes: readonly string[];
  minValidityMs?: number;
}
/** Only an adapter's internal transport consumes this value; never return it as an MCP result. */
export interface AccessTokenGrant {
  accessToken: string;
  expiresAt: number;
  scopes: readonly string[];
  tenantId: string;
  issuer: string;
  resource: string;
  grantType: "authorization_code" | "client_credentials";
  subject?: string;
  owner?: string;
  grantId?: string;
  clientId?: string;
  /** Changes on each sign-in/account switch, stays stable across refreshes. Not a bearer credential. */
  authorizationSessionId?: string;
}
export interface TokenProvider { getToken(request: TokenRequest): Promise<AccessTokenGrant> }
export interface StoredApsGrant extends AccessTokenGrant { refreshToken?: string; obtainedAt: number }
/** Inject OS credential storage or an enterprise secret manager. No plaintext file implementation is shipped. */
export interface TokenStore {
  get(key: string): Promise<StoredApsGrant | null>;
  set(key: string, value: StoredApsGrant): Promise<void>;
  delete(key: string): Promise<void>;
  /** Optional cross-process grant lease, required by persistent credential stores for rotating refreshes. */
  withLock?<T>(key: string, action: () => Promise<T>): Promise<T>;
  /** Persist a nonsecret refresh-intent fence before dispatch. get() must reject while a fence exists. */
  markRefreshPending?(key: string): Promise<void>;
  /** Clear only after a confirmed nonrotating rejection or a safely published replacement grant. */
  clearRefreshPending?(key: string): Promise<void>;
}
export class MemoryTokenStore implements TokenStore {
  #values = new Map<string, StoredApsGrant>();
  async get(key: string) { const value = this.#values.get(key); return value ? structuredClone(value) : null; }
  async set(key: string, value: StoredApsGrant) { this.#values.set(key, structuredClone(value)); }
  async delete(key: string) { this.#values.delete(key); }
  toJSON() { return { kind: "session_memory", credentialCount: this.#values.size }; }
}

export interface ApsAuthorizationSummary {
  grantId: string;
  tenantId: string;
  issuer: string;
  resource: string;
  scopes: readonly string[];
  expiresAt: number;
  subject?: string;
  authorizationSessionId?: string;
}
export interface AuthorizationSession {
  authorizationUrl: string;
  completion: Promise<ApsAuthorizationSummary>;
  cancel(): void;
}
export interface ApsPkceOptions {
  clientId: string;
  /** Local policy context. Hub/project authorization is still checked by the API and scoped adapter. */
  tenantId: string;
  scopes: readonly string[];
  /** Exact pre-registered callback; dynamic, unregistered ports are deliberately not invented. */
  redirectUri: string;
  store?: TokenStore;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  authorizationTimeoutMs?: number;
  requestTimeoutMs?: number;
  onAccountRemoved?: (tenantId: string) => Promise<void>;
  /** Isolate credentials for independently managed profile/state-root deployments. */
  credentialNamespace?: string;
}
const APS_SCOPES = new Set(["user-profile:read", "user:read", "user:write", "viewables:read", "data:read", "data:write", "data:create", "data:search", "bucket:create", "bucket:read", "bucket:update", "bucket:delete", "code:all", "account:read", "account:write", "openid"]);
const grantLocks = new WeakMap<TokenStore, Map<string, Promise<unknown>>>();
const uncertainRefreshes = new WeakMap<TokenStore, Set<string>>();
function refreshFence(store: TokenStore): Set<string> {
  let pending = uncertainRefreshes.get(store);
  if (!pending) { pending = new Set(); uncertainRefreshes.set(store, pending); }
  return pending;
}
async function serializeGrant<T>(store: TokenStore, key: string, action: () => Promise<T>): Promise<T> {
  let locks = grantLocks.get(store);
  if (!locks) { locks = new Map(); grantLocks.set(store, locks); }
  const previous = locks.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(() => store.withLock ? store.withLock(key, action) : action());
  locks.set(key, pending);
  try { return await pending; }
  finally { if (locks.get(key) === pending) locks.delete(key); }
}

function validateScopes(scopes: readonly string[]): string[] {
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > 50 || scopes.some(scope => !APS_SCOPES.has(scope))) throw new CloudError("SCOPE_DENIED", "Configure supported direct APS API scopes; native MCP scopes are not APS grants.");
  return [...new Set(scopes)].sort();
}
function redirect(urlText: string): URL {
  let url: URL;
  try { url = new URL(urlText); } catch { throw new CloudError("INVALID_CALLBACK", "Configure an exact pre-registered loopback callback URL."); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || Number(url.port) < 1024 || Number(url.port) > 65535 || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9_/-]{1,128}$/.test(url.pathname) || urlText !== url.href || url.pathname.includes("//")) throw new CloudError("INVALID_CALLBACK", "The callback must be an exact pre-registered http://127.0.0.1:<port>/<path> URL on an unprivileged fixed port.");
  return url;
}
function constantEqual(a: string, b: string) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function callbackResponse(response: ServerResponse, status: number, message: string) {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; frame-ancestors 'none'", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", connection: "close" });
  response.end(message);
}

/** APS v2 public-client PKCE, verified against Autodesk's authentication SDK and discovery metadata.
 * No client secrets, PATs, Codex credential-cache access, or incoming MCP token passthrough.
 */
export class ApsPkceClient implements TokenProvider {
  #opts: ApsPkceOptions;
  #store: TokenStore;
  #fetch: typeof globalThis.fetch;
  #now: () => number;
  #scopes: string[];
  #redirect: URL;
  #grantId: string;
  #pending?: AuthorizationSession;
  constructor(options: ApsPkceOptions) {
    cloudString(options.clientId, "APS public client ID", 256);
    cloudString(options.tenantId, "Tenant policy context", 256);
    this.#opts = { ...options };
    this.#store = options.store ?? new MemoryTokenStore();
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#scopes = validateScopes(options.scopes);
    this.#redirect = redirect(options.redirectUri);
    this.#grantId = createHash("sha256").update(JSON.stringify([APS_ORIGIN, options.clientId, options.tenantId, this.#scopes, options.redirectUri, options.credentialNamespace ?? "default"])).digest("hex");
    for (const [value, max] of [[options.authorizationTimeoutMs ?? 300_000, 600_000], [options.requestTimeoutMs ?? 30_000, 60_000]]) if (!Number.isFinite(value) || value! < 1 || value! > max!) throw new CloudError("INVALID_ARGUMENT", "OAuth timeout is outside the permitted range.");
  }
  toJSON() { return { type: "APS_public_client_PKCE", tenantId: this.#opts.tenantId, grantId: this.#grantId, scopes: this.#scopes, credentialStore: this.#opts.store ? "injected" : "session_memory" }; }
  async status(): Promise<ApsAuthorizationSummary | null> {
    const grant = await this.#load();
    return grant ? this.#summary(grant) : null;
  }
  async #load() {
    const grant = await this.#store.get(this.#grantId);
    if (grant && (grant.issuer !== APS_ORIGIN || grant.resource !== APS_ORIGIN || grant.tenantId !== this.#opts.tenantId || grant.clientId !== this.#opts.clientId || grant.grantId !== this.#grantId || grant.grantType !== "authorization_code")) throw new CloudError("TENANT_MISMATCH", "Stored credential does not match this client, grant, resource and tenant context.");
    return grant;
  }
  #summary(grant: StoredApsGrant): ApsAuthorizationSummary {
    return { grantId: this.#grantId, tenantId: grant.tenantId, issuer: grant.issuer, resource: grant.resource, scopes: [...grant.scopes], expiresAt: grant.expiresAt, ...(grant.subject ? { subject: grant.subject } : {}), ...(grant.authorizationSessionId ? { authorizationSessionId: grant.authorizationSessionId } : {}) };
  }
  async #request(path: string, form?: URLSearchParams, allowEmpty = false): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#opts.requestTimeoutMs ?? 30_000);
    try {
      let response;
      try { response = await this.#fetch(`${APS_ORIGIN}${path}`, { method: form ? "POST" : "GET", redirect: "error", signal: controller.signal, headers: { accept: "application/json", ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) }, ...(form ? { body: form.toString() } : {}) }); }
      catch { throw new CloudError("OAUTH_TRANSPORT_ERROR", "Autodesk authorization could not be completed. No authorization code or token was logged or returned."); }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new CloudError(response.status === 400 || response.status === 401 ? "REAUTHENTICATION_REQUIRED" : response.status === 429 ? "RATE_LIMITED" : "OAUTH_PROVIDER_ERROR", "Autodesk rejected the authorization request. Sign in again or review the registered public-client settings.", "none", false, response.status);
      }
      if (allowEmpty) { await response.body?.cancel().catch(() => {}); return null; }
      try { return await readBoundedJson(response, 65_536); }
      catch { throw new CloudError("INVALID_OAUTH_RESPONSE", "Autodesk authorization returned an unreadable or oversized response."); }
    } finally { clearTimeout(timeout); }
  }
  async #discover() {
    const data = await this.#request("/.well-known/openid-configuration");
    if (!isCloudObject(data) || data.issuer !== APS_ORIGIN || data.authorization_endpoint !== `${APS_ORIGIN}/authentication/v2/authorize` || data.token_endpoint !== `${APS_ORIGIN}/authentication/v2/token` || data.revocation_endpoint !== `${APS_ORIGIN}/authentication/v2/revoke` || !Array.isArray(data.code_challenge_methods_supported) || !data.code_challenge_methods_supported.includes("S256")) throw new CloudError("ISSUER_MISMATCH", "Autodesk discovery metadata does not match the pinned APS v2 issuer and PKCE endpoints.");
    // APS metadata omits public-client auth 'none'; its primary SDK explicitly documents client_id-only PKCE.
  }
  async beginAuthorization(): Promise<AuthorizationSession> {
    if (this.#pending) throw new CloudError("AUTHORIZATION_IN_PROGRESS", "Complete or cancel the current Autodesk sign-in first.");
    await this.#discover();
    if (this.#pending) throw new CloudError("AUTHORIZATION_IN_PROGRESS", "Complete or cancel the current Autodesk sign-in first.");
    const verifier = randomBytes(48).toString("base64url"), state = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    let resolve!: (value: ApsAuthorizationSummary) => void, reject!: (error: Error) => void;
    const completion = new Promise<ApsAuthorizationSummary>((yes, no) => { resolve = yes; reject = no; });
    // Consumers may present the browser link before attaching their completion handler.
    void completion.catch(() => {});
    let consumed = false, settled = false;
    const expiresAt = this.#now() + (this.#opts.authorizationTimeoutMs ?? 300_000);
    const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 10_000 }, (request: IncomingMessage, response) => {
      if (request.method !== "GET" || request.headers.host !== this.#redirect.host || request.socket.remoteAddress !== "127.0.0.1" || request.headers.origin && ![APS_ORIGIN, this.#redirect.origin].includes(request.headers.origin) || !request.url?.startsWith("/") || request.url.startsWith("//") || request.url.length > 8192) { callbackResponse(response, 400, "Invalid authorization callback."); return; }
      let returned: URL;
      try { returned = new URL(request.url, this.#redirect.origin); } catch { callbackResponse(response, 400, "Invalid authorization callback."); return; }
      const params = returned.searchParams;
      if (returned.pathname !== this.#redirect.pathname || returned.hash || [...params.keys()].some(key => !["state", "code", "error", "error_description", "iss", "resource"].includes(key) || params.getAll(key).length !== 1) || !constantEqual(params.get("state") ?? "", state) || params.has("iss") && params.get("iss") !== APS_ORIGIN || params.has("resource") && params.get("resource") !== APS_ORIGIN) { callbackResponse(response, 400, "Authorization callback did not match the pending request."); return; }
      if (consumed || this.#now() > expiresAt) { callbackResponse(response, 409, "This authorization request is no longer active."); return; }
      consumed = true;
      const code = params.get("code");
      if (params.has("error") || !code || code.length > 4096 || /[\u0000-\u0020]/.test(code)) { callbackResponse(response, 400, "Autodesk sign-in was not completed."); finish(new CloudError("AUTHORIZATION_DENIED", "Autodesk sign-in was denied or returned no valid authorization code.")); return; }
      callbackResponse(response, 200, "Autodesk sign-in received. You can close this window and return to Codex.");
      server.close();
      void serializeGrant(this.#store, this.#grantId, async () => {
        const result = await this.#request("/authentication/v2/token", new URLSearchParams({ grant_type: "authorization_code", client_id: this.#opts.clientId, redirect_uri: this.#redirect.href, code, code_verifier: verifier }));
        const grant = this.#parseGrant(result);
        if (settled) return;
        await this.#store.set(this.#grantId, grant);
        if (settled) { await this.#store.delete(this.#grantId); return; }
        await this.#store.clearRefreshPending?.(this.#grantId);
        refreshFence(this.#store).delete(this.#grantId);
        finish(undefined, this.#summary(grant));
      }).catch(() => finish(new CloudError("AUTHORIZATION_FAILED", "Autodesk token exchange failed. Start a new sign-in; no credentials were exposed.")));
    });
    server.maxConnections = 8;
    const finish = (error?: Error, result?: ApsAuthorizationSummary) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close(); server.closeAllConnections();
      this.#pending = undefined;
      if (error) reject(error); else if (result) resolve(result);
    };
    const timer = setTimeout(() => finish(new CloudError("AUTHORIZATION_EXPIRED", "Autodesk sign-in timed out. Start a new authorization request.")), this.#opts.authorizationTimeoutMs ?? 300_000);
    const url = new URL(`${APS_ORIGIN}/authentication/v2/authorize`);
    url.search = new URLSearchParams({ response_type: "code", client_id: this.#opts.clientId, redirect_uri: this.#redirect.href, scope: this.#scopes.join(" "), state, code_challenge: challenge, code_challenge_method: "S256", response_mode: "query" }).toString();
    const session = { authorizationUrl: url.href, completion, cancel: () => finish(new CloudError("AUTHORIZATION_CANCELLED", "Autodesk authorization was cancelled locally.")) };
    this.#pending = session;
    await new Promise<void>((yes, no) => {
      server.once("error", () => { const error = new CloudError("CALLBACK_UNAVAILABLE", "The configured loopback callback port could not be bound. Close the conflicting process or register another exact callback."); finish(error); no(error); });
      server.listen(Number(this.#redirect.port), "127.0.0.1", yes);
    });
    return session;
  }
  #parseGrant(result: unknown, previous?: StoredApsGrant): StoredApsGrant {
    if (!isCloudObject(result) || typeof result.access_token !== "string" || !result.access_token.length || result.access_token.length > 32_768 || /\s/.test(result.access_token) || typeof result.expires_in !== "number" || !Number.isFinite(result.expires_in) || result.expires_in < 1 || result.expires_in > 86_400 || typeof result.token_type !== "string" || result.token_type.toLowerCase() !== "bearer") throw new CloudError("INVALID_OAUTH_RESPONSE", "Autodesk returned invalid access-token metadata.");
    const requestedScopes = previous?.scopes ?? this.#scopes;
    const returnedScopes = result.scope === undefined ? requestedScopes : typeof result.scope === "string" ? result.scope.split(/\s+/).filter(Boolean) : [];
    if (returnedScopes.length === 0 || returnedScopes.some(scope => !requestedScopes.includes(scope))) throw new CloudError("SCOPE_DENIED", "Autodesk returned an unexpected scope grant.");
    if (result.refresh_token !== undefined && (typeof result.refresh_token !== "string" || !result.refresh_token.length || result.refresh_token.length > 32_768 || /\s/.test(result.refresh_token))) throw new CloudError("INVALID_OAUTH_RESPONSE", "Autodesk returned invalid refresh-token metadata.");
    const obtainedAt = this.#now();
    const refreshToken = result.refresh_token as string | undefined ?? previous?.refreshToken;
    return { accessToken: result.access_token, expiresAt: obtainedAt + result.expires_in * 1000, scopes: [...returnedScopes], tenantId: this.#opts.tenantId, issuer: APS_ORIGIN, resource: APS_ORIGIN, grantType: "authorization_code", owner: "autodesk-fusion-plugin", grantId: this.#grantId, clientId: this.#opts.clientId, authorizationSessionId: previous?.authorizationSessionId ?? randomUUID(), ...(refreshToken ? { refreshToken } : {}), obtainedAt };
  }
  async getToken(request: TokenRequest): Promise<AccessTokenGrant> {
    if (request.tenantId !== this.#opts.tenantId || request.resource !== APS_ORIGIN) throw new CloudError("TENANT_MISMATCH", "This grant cannot be used for another tenant or resource.");
    const scopes = validateScopes(request.scopes);
    const minValidity = request.minValidityMs ?? 30_000;
    if (!Number.isFinite(minValidity) || minValidity < 0 || minValidity > 3_600_000) throw new CloudError("INVALID_ARGUMENT", "Invalid token lifetime requirement.");
    return serializeGrant(this.#store, this.#grantId, async () => {
      let grant = await this.#load();
      if (!grant) throw new CloudError("NOT_AUTHENTICATED", "Complete the plugin's Autodesk PKCE sign-in first.");
      if (refreshFence(this.#store).has(this.#grantId)) throw new CloudError('REAUTHENTICATION_REQUIRED', 'A previous refresh did not publish a confirmed replacement grant. Sign in again; the uncertain refresh token will not be reused.');
      if (scopes.some(scope => !grant!.scopes.includes(scope))) throw new CloudError("SCOPE_DENIED", "The stored APS grant lacks a required direct API scope.");
      if (grant.expiresAt < this.#now() + minValidity) {
        if (!grant.refreshToken) throw new CloudError("TOKEN_EXPIRED", "Autodesk authorization expired and cannot be refreshed; sign in again.");
        await this.#store.markRefreshPending?.(this.#grantId);
        refreshFence(this.#store).add(this.#grantId);
        let result;
        try { result = await this.#request("/authentication/v2/token", new URLSearchParams({ grant_type: "refresh_token", client_id: this.#opts.clientId, refresh_token: grant.refreshToken, scope: grant.scopes.join(" ") })); }
        catch (error) {
          // Refresh tokens rotate. A lost response must not trigger repeated reuse of an uncertain token.
          if (error instanceof CloudError && error.code === 'RATE_LIMITED') {
            await this.#store.clearRefreshPending?.(this.#grantId);
            refreshFence(this.#store).delete(this.#grantId);
          } else await this.#store.delete(this.#grantId);
          throw error;
        }
        try { grant = this.#parseGrant(result, grant); }
        catch (error) { await this.#store.delete(this.#grantId); throw error; }
        await this.#store.set(this.#grantId, grant);
        await this.#store.clearRefreshPending?.(this.#grantId);
        refreshFence(this.#store).delete(this.#grantId);
      }
      if (grant.expiresAt < this.#now() + minValidity || scopes.some(scope => !grant!.scopes.includes(scope))) throw new CloudError("TOKEN_EXPIRED", "Refreshed authorization does not satisfy this operation's lifetime or scope requirements.");
      const { refreshToken: _refreshToken, obtainedAt: _obtainedAt, ...access } = grant;
      return access;
    });
  }
  async revoke(): Promise<{ localCredentialsRemoved: true; upstreamRevoked: boolean }> {
    this.#pending?.cancel();
    return serializeGrant(this.#store, this.#grantId, async () => {
      let upstreamRevoked = true;
      try {
        const grant = await this.#load();
        if (grant) {
          for (const [token, hint] of [[grant.refreshToken, "refresh_token"], [grant.accessToken, "access_token"]]) {
            if (token) await this.#request("/authentication/v2/revoke", new URLSearchParams({ client_id: this.#opts.clientId, token, token_type_hint: hint! }), true);
          }
        }
      } catch { upstreamRevoked = false; }
      finally { await this.#store.delete(this.#grantId); refreshFence(this.#store).delete(this.#grantId); await this.#opts.onAccountRemoved?.(this.#opts.tenantId); }
      return { localCredentialsRemoved: true, upstreamRevoked };
    });
  }
}
