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
export interface TokenProvider {
    getToken(request: TokenRequest): Promise<AccessTokenGrant>;
}
export interface StoredApsGrant extends AccessTokenGrant {
    refreshToken?: string;
    obtainedAt: number;
}
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
export declare class MemoryTokenStore implements TokenStore {
    #private;
    get(key: string): Promise<StoredApsGrant | null>;
    set(key: string, value: StoredApsGrant): Promise<void>;
    delete(key: string): Promise<void>;
    toJSON(): {
        kind: string;
        credentialCount: number;
    };
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
/** APS v2 public-client PKCE, verified against Autodesk's authentication SDK and discovery metadata.
 * No client secrets, PATs, Codex credential-cache access, or incoming MCP token passthrough.
 */
export declare class ApsPkceClient implements TokenProvider {
    #private;
    constructor(options: ApsPkceOptions);
    toJSON(): {
        type: string;
        tenantId: string;
        grantId: string;
        scopes: string[];
        credentialStore: string;
    };
    status(): Promise<ApsAuthorizationSummary | null>;
    beginAuthorization(): Promise<AuthorizationSession>;
    getToken(request: TokenRequest): Promise<AccessTokenGrant>;
    revoke(): Promise<{
        localCredentialsRemoved: true;
        upstreamRevoked: boolean;
    }>;
}
