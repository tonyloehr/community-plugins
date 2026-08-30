import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { request } from "node:http";
import { createHash } from "node:crypto";
import { ApsPkceClient, MemoryTokenStore, APS_ORIGIN, CloudError } from "../dist/index.mjs";

const discovery = { issuer: APS_ORIGIN, authorization_endpoint: `${APS_ORIGIN}/authentication/v2/authorize`, token_endpoint: `${APS_ORIGIN}/authentication/v2/token`, revocation_endpoint: `${APS_ORIGIN}/authentication/v2/revoke`, code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"] };
const secret = "PRIVATE_ACCESS_TOKEN_DO_NOT_RETURN";
const refresh = "PRIVATE_REFRESH_TOKEN_DO_NOT_RETURN";
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const tokenReply = overrides => ({ access_token: secret, refresh_token: refresh, token_type: "Bearer", expires_in: 3600, scope: "data:read data:write", ...overrides });
const code = expected => error => error instanceof CloudError && error.code === expected;
async function port() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
function callback(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const pending = request(url, { method: "GET", headers }, response => {
      let body = "";
      response.setEncoding("utf8"); response.on("data", value => { body += value; });
      response.on("end", () => resolve({ status: response.statusCode, body, headers: response.headers }));
    });
    pending.on("error", reject); pending.end();
  });
}
async function clientOptions(overrides = {}) {
  return { clientId: "public-aps-client-id", tenantId: "tenant-a", scopes: ["data:read", "data:write"], redirectUri: `http://127.0.0.1:${await port()}/callback`, authorizationTimeoutMs: 2000, ...overrides };
}
function resultUrl(session, changes = {}) {
  const authorize = new URL(session.authorizationUrl);
  const url = new URL(authorize.searchParams.get("redirect_uri"));
  url.searchParams.set("state", authorize.searchParams.get("state"));
  url.searchParams.set("code", "PRIVATE_AUTHORIZATION_CODE");
  for (const [key, value] of Object.entries(changes)) url.searchParams.set(key, value);
  return url;
}

test("PKCE validates the public issuer, binds exact callback/state and never returns credentials in completion", async t => {
  const seen = [];
  const store = new MemoryTokenStore();
  const client = new ApsPkceClient(await clientOptions({ store, fetch: async (url, init) => { seen.push({ url: String(url), init }); return json(String(url).endsWith("openid-configuration") ? discovery : tokenReply()); } }));
  const session = await client.beginAuthorization(); t.after(() => session.cancel());
  const authorize = new URL(session.authorizationUrl);
  assert.equal(authorize.origin, APS_ORIGIN);
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorize.searchParams.get("state").length, 43);
  assert.equal(authorize.searchParams.has("client_secret"), false);
  assert.equal(authorize.searchParams.has("resource"), false, "APS v2 does not advertise RFC 8707 resource parameters");
  const response = await callback(resultUrl(session));
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  const completion = await session.completion;
  assert.equal(completion.issuer, APS_ORIGIN);
  assert.equal(completion.resource, APS_ORIGIN);
  for (const visible of [completion, client, store, response]) {
    assert.equal(JSON.stringify(visible).includes(secret), false);
    assert.equal(JSON.stringify(visible).includes(refresh), false);
    assert.equal(JSON.stringify(visible).includes("PRIVATE_AUTHORIZATION_CODE"), false);
  }
  const tokenRequest = seen.find(item => item.url.endsWith("/token"));
  const form = new URLSearchParams(tokenRequest.init.body);
  assert.equal(tokenRequest.init.redirect, "error");
  assert.equal(tokenRequest.init.headers.authorization, undefined);
  assert.equal(form.get("client_id"), "public-aps-client-id");
  assert.equal(form.get("redirect_uri"), authorize.searchParams.get("redirect_uri"));
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(createHash("sha256").update(form.get("code_verifier")).digest("base64url"), authorize.searchParams.get("code_challenge"));
  const access = await client.getToken({ tenantId: "tenant-a", resource: APS_ORIGIN, scopes: ["data:read"] });
  assert.equal(access.accessToken, secret, "Internal transport receives the credential; MCP completion does not");
  assert.equal(Object.hasOwn(access, "refreshToken"), false);
});

test("callback attacks cannot consume the pending authorization or exfiltrate its code", async t => {
  let exchanges = 0;
  const client = new ApsPkceClient(await clientOptions({ fetch: async url => { if (String(url).endsWith("openid-configuration")) return json(discovery); exchanges++; return json(tokenReply()); } }));
  const session = await client.beginAuthorization(); t.after(() => session.cancel());
  const valid = resultUrl(session);
  const duplicate = new URL(valid); duplicate.searchParams.append("state", "duplicate-state");
  const wrongPath = new URL(valid); wrongPath.pathname = "/another-callback";
  for (const [url, headers] of [
    [resultUrl(session, { state: "attacker-state" }), {}],
    [resultUrl(session, { iss: "https://attacker.example" }), {}],
    [resultUrl(session, { resource: `${APS_ORIGIN}/fusion/mcp` }), {}],
    [valid, { host: "attacker.example" }],
    [valid, { origin: "https://attacker.example" }],
    [duplicate, {}], [wrongPath, {}],
  ]) {
    const rejected = await callback(url, headers);
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.includes("PRIVATE_AUTHORIZATION_CODE"), false);
  }
  assert.equal(exchanges, 0);
  assert.equal((await callback(valid)).status, 200);
  await session.completion;
  assert.equal(exchanges, 1);
  await assert.rejects(callback(valid));
});

test("loopback callback URL rejects hostname aliases, normalized port tricks, credentials and nonlocal destinations", async () => {
  const base = await clientOptions();
  const callbackPort = new URL(base.redirectUri).port;
  for (const uri of [`http://localhost:${callbackPort}/callback`, `http://127.1:${callbackPort}/callback`, `http://127.0.0.1:0${callbackPort}/callback`, "http://127.0.0.1:0/callback", "http://127.0.0.1:80/callback", `http://127.0.0.1:${callbackPort}/callback?state=known`, `http://user:secret@127.0.0.1:${callbackPort}/callback`, "https://attacker.example/callback", `${base.redirectUri}\n`]) assert.throws(() => new ApsPkceClient({ ...base, redirectUri: uri }), code("INVALID_CALLBACK"), uri);
});

test("issuer and authorization-endpoint substitution fail before opening a callback listener", async () => {
  for (const changes of [{ issuer: "https://attacker.example" }, { token_endpoint: "https://attacker.example/token" }, { authorization_endpoint: `${APS_ORIGIN}/mcpauth/authorize` }, { code_challenge_methods_supported: ["plain"] }]) {
    const client = new ApsPkceClient(await clientOptions({ fetch: async () => json({ ...discovery, ...changes }) }));
    await assert.rejects(client.beginAuthorization(), code("ISSUER_MISMATCH"));
  }
  assert.throws(() => new ApsPkceClient({ clientId: "id", tenantId: "tenant", scopes: ["mcp:read"], redirectUri: "http://127.0.0.1:8765/callback" }), code("SCOPE_DENIED"));
});

test("expired authorization closes its listener, cancellation is local, and port conflicts have safe diagnostics", async () => {
  const base = await clientOptions({ fetch: async () => json(discovery), authorizationTimeoutMs: 25 });
  const client = new ApsPkceClient(base);
  const session = await client.beginAuthorization();
  await assert.rejects(session.completion, code("AUTHORIZATION_EXPIRED"));
  await assert.rejects(callback(resultUrl(session)));
  const client2 = new ApsPkceClient({ ...base, authorizationTimeoutMs: 1000 });
  const pending = await client2.beginAuthorization();
  const conflict = new ApsPkceClient({ ...base, authorizationTimeoutMs: 1000 });
  await assert.rejects(conflict.beginAuthorization(), code("CALLBACK_UNAVAILABLE"));
  pending.cancel();
  await assert.rejects(pending.completion, code("AUTHORIZATION_CANCELLED"));
});

test("concurrent refreshes serialize per grant and rotated refresh tokens stay private", async t => {
  let now = Date.parse("2026-08-28T12:00:00Z");
  let refreshes = 0;
  const client = new ApsPkceClient(await clientOptions({ now: () => now, fetch: async (url, init) => {
    if (String(url).endsWith("openid-configuration")) return json(discovery);
    const form = new URLSearchParams(init.body);
    if (form.get("grant_type") === "refresh_token") {
      refreshes++;
      assert.equal(form.get("refresh_token"), refresh);
      assert.equal(form.get("client_id"), "public-aps-client-id");
      assert.equal(form.has("client_secret"), false);
      await new Promise(resolve => setTimeout(resolve, 10));
      return json(tokenReply({ access_token: "ROTATED_ACCESS", refresh_token: "ROTATED_REFRESH" }));
    }
    return json(tokenReply());
  } }));
  const session = await client.beginAuthorization(); t.after(() => session.cancel());
  await callback(resultUrl(session)); const signedIn = await session.completion;
  now += 3_600_000;
  const results = await Promise.all(Array.from({ length: 6 }, () => client.getToken({ tenantId: "tenant-a", resource: APS_ORIGIN, scopes: ["data:read"] })));
  assert.equal(refreshes, 1);
  assert.ok(results.every(result => result.accessToken === "ROTATED_ACCESS" && !Object.hasOwn(result, "refreshToken")));
  assert.ok(results.every(result => result.authorizationSessionId === signedIn.authorizationSessionId));
  assert.match(signedIn.authorizationSessionId, /^[a-f0-9-]{36}$/);
});

test('reauthorization changes the account-session binding and namespace-isolated profiles do not share credentials', async t => {
  const store = new MemoryTokenStore();
  const opts = await clientOptions({ store, credentialNamespace: 'deployment-a', fetch: async url => json(String(url).endsWith('openid-configuration') ? discovery : tokenReply()) });
  const client = new ApsPkceClient(opts);
  const first = await client.beginAuthorization(); t.after(() => first.cancel()); await callback(resultUrl(first)); const a = await first.completion;
  const second = await client.beginAuthorization(); t.after(() => second.cancel()); await callback(resultUrl(second)); const b = await second.completion;
  assert.equal(a.grantId, b.grantId); assert.notEqual(a.authorizationSessionId, b.authorizationSessionId);
  const other = new ApsPkceClient({ ...opts, credentialNamespace: 'deployment-b' });
  assert.equal(await other.status(), null);
});

test('failed replacement storage cannot replay a rotated refresh token even when the old grant remains', async t => {
  const memory = new MemoryTokenStore(); let failPublication = false, refreshes = 0, now = Date.now();
  const store = { get: key => memory.get(key), delete: key => memory.delete(key), set: async (key, value) => { if (failPublication) throw new Error('Synthetic credential storage unavailable'); return memory.set(key, value); } };
  const client = new ApsPkceClient(await clientOptions({ store, now: () => now, fetch: async (url, init) => {
    if (String(url).endsWith('openid-configuration')) return json(discovery);
    if (new URLSearchParams(init.body).get('grant_type') === 'refresh_token') { refreshes++; return json(tokenReply({ access_token: 'ROTATED', refresh_token: 'ROTATED_REFRESH' })); }
    return json(tokenReply());
  } }));
  const session = await client.beginAuthorization(); t.after(() => session.cancel()); await callback(resultUrl(session)); await session.completion;
  now += 3_600_000; failPublication = true;
  const request = { tenantId: 'tenant-a', resource: APS_ORIGIN, scopes: ['data:read'] };
  await assert.rejects(client.getToken(request));
  await assert.rejects(client.getToken(request), code('REAUTHENTICATION_REQUIRED'));
  assert.equal(refreshes, 1);
});

test('a confirmed refresh rate limit clears the refresh fence but does not automatically repeat the request', async t => {
  let now = Date.now(), refreshes = 0, marks = 0, clears = 0;
  const memory = new MemoryTokenStore();
  const store = { get: key => memory.get(key), delete: key => memory.delete(key), set: (key, value) => memory.set(key, value), markRefreshPending: async () => { marks++; }, clearRefreshPending: async () => { clears++; } };
  const client = new ApsPkceClient(await clientOptions({ store, now: () => now, fetch: async (url, init) => {
    if (String(url).endsWith('openid-configuration')) return json(discovery);
    if (new URLSearchParams(init.body).get('grant_type') === 'refresh_token') { refreshes++; return refreshes === 1 ? json({}, 429) : json(tokenReply({ access_token: 'ROTATED' })); }
    return json(tokenReply());
  } }));
  const session = await client.beginAuthorization(); t.after(() => session.cancel()); await callback(resultUrl(session)); await session.completion;
  now += 3_600_000;
  const request = { tenantId: 'tenant-a', resource: APS_ORIGIN, scopes: ['data:read'] };
  await assert.rejects(client.getToken(request), code('RATE_LIMITED')); assert.equal(refreshes, 1);
  assert.equal((await client.getToken(request)).accessToken, 'ROTATED'); assert.equal(refreshes, 2);
  assert.equal(marks, 2); assert.equal(clears, 3);
});

test("tenant/resource/scope mismatches cannot use a stored APS grant", async t => {
  const client = new ApsPkceClient(await clientOptions({ fetch: async url => json(String(url).endsWith("openid-configuration") ? discovery : tokenReply()) }));
  const session = await client.beginAuthorization(); t.after(() => session.cancel());
  await callback(resultUrl(session)); await session.completion;
  for (const req of [{ tenantId: "other", resource: APS_ORIGIN, scopes: ["data:read"] }, { tenantId: "tenant-a", resource: "https://another-api.example", scopes: ["data:read"] }]) await assert.rejects(client.getToken(req), code("TENANT_MISMATCH"));
  await assert.rejects(client.getToken({ tenantId: "tenant-a", resource: APS_ORIGIN, scopes: ["code:all"] }), code("SCOPE_DENIED"));
});

test("lost refresh response requires a new login instead of blindly replaying rotating credentials", async t => {
  let now = Date.now(), refreshes = 0;
  const client = new ApsPkceClient(await clientOptions({ now: () => now, fetch: async (url, init) => {
    if (String(url).endsWith("openid-configuration")) return json(discovery);
    if (new URLSearchParams(init.body).get("grant_type") === "refresh_token") { refreshes++; throw new Error(`connection lost ${refresh}`); }
    return json(tokenReply());
  } }));
  const session = await client.beginAuthorization(); t.after(() => session.cancel());
  await callback(resultUrl(session)); await session.completion; now += 3_600_000;
  const req = { tenantId: "tenant-a", resource: APS_ORIGIN, scopes: ["data:read"] };
  await assert.rejects(client.getToken(req), error => code("OAUTH_TRANSPORT_ERROR")(error) && !error.message.includes(refresh));
  await assert.rejects(client.getToken(req), code("NOT_AUTHENTICATED"));
  assert.equal(refreshes, 1);
});

test("revocation uses public-client form parameters, removes credentials and reports uncertain upstream revocation", async t => {
  const revocations = [], removed = [];
  const client = new ApsPkceClient(await clientOptions({ onAccountRemoved: async tenant => { removed.push(tenant); }, fetch: async (url, init) => {
    if (String(url).endsWith("openid-configuration")) return json(discovery);
    if (String(url).endsWith("/revoke")) { revocations.push(new URLSearchParams(init.body)); return new Response(null, { status: 200 }); }
    return json(tokenReply());
  } }));
  const session = await client.beginAuthorization(); t.after(() => session.cancel());
  await callback(resultUrl(session)); await session.completion;
  assert.deepEqual(await client.revoke(), { localCredentialsRemoved: true, upstreamRevoked: true });
  assert.deepEqual(revocations.map(form => form.get("token_type_hint")), ["refresh_token", "access_token"]);
  assert.ok(revocations.every(form => form.get("client_id") === "public-aps-client-id" && !form.has("client_secret")));
  assert.deepEqual(removed, ["tenant-a"]);
  assert.equal(await client.status(), null);
  const failing = new ApsPkceClient(await clientOptions({ fetch: async url => String(url).endsWith("openid-configuration") ? json(discovery) : String(url).endsWith("/revoke") ? json({ secret }, 503) : json(tokenReply()) }));
  const other = await failing.beginAuthorization(); t.after(() => other.cancel());
  await callback(resultUrl(other)); await other.completion;
  assert.deepEqual(await failing.revoke(), { localCredentialsRemoved: true, upstreamRevoked: false });
  assert.equal(await failing.status(), null);
});

test('logout removes local credentials even when an uncertain refresh fence prevents reading the old grant', async t => {
  const memory = new MemoryTokenStore(); let unreadable = false, deleted = 0, upstream = 0;
  const store = { get: key => { if (unreadable) throw new CloudError('REAUTHENTICATION_REQUIRED', 'Uncertain refresh intent'); return memory.get(key); }, set: (key, value) => memory.set(key, value), delete: async key => { deleted++; unreadable = false; await memory.delete(key); } };
  const client = new ApsPkceClient(await clientOptions({ store, fetch: async url => { if (String(url).endsWith('/revoke')) upstream++; return json(String(url).endsWith('openid-configuration') ? discovery : tokenReply()); } }));
  const session = await client.beginAuthorization(); t.after(() => session.cancel()); await callback(resultUrl(session)); await session.completion;
  unreadable = true;
  assert.deepEqual(await client.revoke(), { localCredentialsRemoved: true, upstreamRevoked: false });
  assert.equal(deleted, 1); assert.equal(upstream, 0); assert.equal(await client.status(), null);
});

test("provider error text and non-Bearer token responses never escape authorization completion", async () => {
  for (const reply of [() => json({ error_description: `${secret} ${refresh}` }, 400), () => json(tokenReply({ token_type: "MAC" })), () => json(tokenReply({ scope: "data:read data:write account:write" }))]) {
    const client = new ApsPkceClient(await clientOptions({ fetch: async url => String(url).endsWith("openid-configuration") ? json(discovery) : reply() }));
    const session = await client.beginAuthorization();
    await callback(resultUrl(session));
    await assert.rejects(session.completion, error => code("AUTHORIZATION_FAILED")(error) && !error.message.includes(secret) && !error.message.includes(refresh));
    assert.equal(await client.status(), null);
  }
});
