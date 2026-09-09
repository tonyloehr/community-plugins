import assert from "node:assert/strict";
import test from "node:test";
import { ApsClient, APS_ORIGIN, CloudError, CloudRateLimiter, MFG_QUERY_DOCUMENTS, cloudHash, parseRetryAfter, validateAutodeskOrigin, redactCloudData } from "../dist/index.mjs";

const now = Date.parse("2026-08-28T12:00:00.000Z");
const context = { modelId: "model-1", timestamp: new Date(now).toISOString(), composition: "AS_SAVED", configurationId: null };
const scope = { tenantId: "enterprise-a", hubIds: ["hub-a"], projects: [{ hubId: "hub-a", projectId: "project-a" }], mfgModels: [{ hubId: "hub-a", projectId: "project-a", modelId: "model-1" }], manage: { tenant: "acme", workspaceIds: [10] } };
const grant = changes => ({ accessToken: "PRIVATE_AUTODESK_ACCESS_TOKEN", expiresAt: now + 3_600_000, scopes: ["data:read", "data:write", "code:all"], tenantId: scope.tenantId, issuer: APS_ORIGIN, resource: APS_ORIGIN, grantType: "authorization_code", ...changes });
const options = (fetch, changes = {}) => ({ scope, tokenProvider: { async getToken() { return grant(); } }, fetch, limiter: { async acquire() {} }, now: () => now, sleep: async () => {}, ...changes });
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
const code = expected => error => error instanceof CloudError && error.code === expected;
const model = changes => ({ id: context.modelId, timestamp: context.timestamp, name: { value: "Bracket", displayValue: "Bracket" }, component: { id: "component-1", partNumber: { value: null, displayValue: null }, description: { value: "draft", displayValue: "draft" } }, assemblyRelations: { results: [], pagination: { cursor: null } }, ...changes });

test("Autodesk origins require exact HTTPS identity and reject deceptive URL forms", () => {
  assert.equal(validateAutodeskOrigin(APS_ORIGIN), APS_ORIGIN);
  assert.equal(validateAutodeskOrigin("https://acme.autodeskplm360.net", "acme"), "https://acme.autodeskplm360.net");
  for (const value of ["http://developer.api.autodesk.com", `${APS_ORIGIN}:443`, `${APS_ORIGIN}/`, `${APS_ORIGIN}/data`, `${APS_ORIGIN}?access_token=secret`, `${APS_ORIGIN}#fragment`, "https://developer.api.autodesk.com.attacker.example", "https://user:secret@developer.api.autodesk.com", "https://evil.autodeskplm360.net", "https://127.0.0.1", "https://developer.api.autodesk.com\n"]) assert.throws(() => validateAutodeskOrigin(value, "acme"), code("INVALID_ENDPOINT"), value);
});

test("Data Management navigation uses exact approved endpoints, encodes version IDs and preserves nulls", async () => {
  const seen = [];
  const versionId = "urn:adsk.wipprod:fs.file:vf.example?version=2";
  const client = new ApsClient(options(async (url, init) => {
    seen.push({ url: new URL(url), init });
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.authorization, "Bearer PRIVATE_AUTODESK_ACCESS_TOKEN");
    if (new URL(url).pathname.endsWith(encodeURIComponent(versionId))) return json({ data: { id: versionId, attributes: { description: null } } });
    return json({ data: [], links: {} });
  }));
  await client.listProjects("hub-a", { pageNumber: 0, pageSize: 50 });
  await client.listTopFolders("hub-a", "project-a");
  await client.listFolderContents("project-a", "urn:adsk.folder:1");
  await client.listItemVersions("project-a", "urn:adsk.item:1");
  const result = await client.getVersion("project-a", versionId);
  assert.equal(result.data.attributes.description, null);
  assert.equal(seen[0].url.pathname, "/project/v1/hubs/hub-a/projects");
  assert.equal(seen[0].url.searchParams.get("page[limit]"), "50");
  assert.equal(seen[4].url.pathname, `/data/v1/projects/project-a/versions/${encodeURIComponent(versionId)}`);
  assert.equal(JSON.stringify(result).includes("PRIVATE_AUTODESK_ACCESS_TOKEN"), false);
});

test("scope checks block hub, project and configuration confusion before token access or network I/O", async () => {
  let calls = 0;
  const client = new ApsClient(options(async () => { calls++; return json({ data: [] }); }));
  await assert.rejects(client.listProjects("hub-other"), code("SCOPE_DENIED"));
  await assert.rejects(client.getItem("project-other", "item"), code("SCOPE_DENIED"));
  await assert.rejects(client.listTopFolders("hub-other", "project-a"), code("SCOPE_DENIED"));
  await assert.rejects(client.getVersion("project-a", "../anything"), code("INVALID_ARGUMENT"));
  await assert.rejects(client.inspectMfgModel({ ...context, configurationId: "wrong-row" }), code("STALE_PLAN"));
  assert.equal(calls, 0);
});

test("collections filter unapproved grants and do not follow hostile provider pagination links", async () => {
  const client = new ApsClient(options(async () => json({ data: [{ id: "hub-a" }, { id: "hub-secret" }], links: {} })));
  assert.deepEqual((await client.listHubs()).data.map(item => item.id), ["hub-a"]);
  for (const link of ["https://attacker.example/collect?token=secret", `${APS_ORIGIN}/project/v1/hubs/other/projects?page[number]=1`, `${APS_ORIGIN}/project/v1/hubs/hub-a/projects?page[number]=0`, `${APS_ORIGIN}/project/v1/hubs/hub-a/projects?page[number]=1&access_token=secret`]) {
    const bad = new ApsClient(options(async () => json({ data: [], links: { next: { href: link } } })));
    await assert.rejects(bad.listProjects("hub-a"), code("INVALID_RESPONSE"));
  }
});

test("valid pagination advances a scoped collection and bounded pages refuse oversized responses", async () => {
  const client = new ApsClient(options(async () => json({ data: [{ id: "file" }], links: { next: { href: `${APS_ORIGIN}/data/v1/projects/project-a/folders/folder/contents?page[number]=2&page[limit]=1` } } })));
  const page = await client.listFolderContents("project-a", "folder", { pageNumber: 1, pageSize: 1 });
  assert.equal(page.pagination.nextPageNumber, 2);
  assert.equal(page.pagination.complete, false);
  const oversized = new ApsClient(options(async () => json({ data: [{ id: "one" }, { id: "two" }] })));
  await assert.rejects(oversized.listFolderContents("project-a", "folder", { pageSize: 1 }), code("RESPONSE_TOO_LARGE"));
});

test("expired, wrongly scoped, wrong-issuer and native-MCP credentials cannot reach direct APS endpoints", async () => {
  const cases = [
    [grant({ expiresAt: now + 10 }), "TOKEN_EXPIRED"],
    [grant({ scopes: ["mcp:read", "offline_access"] }), "SCOPE_DENIED"],
    [grant({ tenantId: "another-company" }), "TENANT_MISMATCH"],
    [grant({ issuer: `${APS_ORIGIN}/mcpauth` }), "TENANT_MISMATCH"],
    [grant({ resource: `${APS_ORIGIN}/fusion/mcp` }), "TENANT_MISMATCH"],
    [grant({ accessToken: "secret\r\nX-Forwarded: evil" }), "INVALID_TOKEN"],
  ];
  for (const [token, expected] of cases) {
    let network = false;
    const client = new ApsClient(options(async () => { network = true; return json({ data: [] }); }, { tokenProvider: { async getToken() { return token; } } }));
    await assert.rejects(client.listHubs(), code(expected));
    assert.equal(network, false);
  }
});

test("429 retries obey Retry-After for safe reads and a shared limiter serializes capacity", async () => {
  const delays = [];
  let calls = 0;
  const client = new ApsClient(options(async () => ++calls === 1 ? json({ secret: "DONOTLEAK" }, 429, { "retry-after": "2" }) : json({ data: [] }), { sleep: async ms => { delays.push(ms); }, random: () => 0.5 }));
  await client.listHubs();
  assert.equal(calls, 2);
  assert.deepEqual(delays, [2000]);
  assert.equal(parseRetryAfter("2", now), 2000);
  assert.equal(parseRetryAfter(new Date(now + 5000).toUTCString(), now), 5000);
  let clock = now;
  const waits = [];
  const limiter = new CloudRateLimiter(500, () => clock, async ms => { waits.push(ms); clock += ms; });
  await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
  assert.deepEqual(waits, [500, 500]);
});

test("large Retry-After is reported without sleeping beyond the bounded retry window", async () => {
  let sleeps = 0;
  const client = new ApsClient(options(async () => json({}, 429, { "retry-after": "3600" }), { sleep: async () => { sleeps++; } }));
  await assert.rejects(client.listHubs(), error => code("RATE_LIMITED")(error) && error.retryAfterMs === 3_600_000);
  assert.equal(sleeps, 0);
});

test("transport error messages never copy credentials from provider failures or invalid JSON", async () => {
  for (const fetch of [async () => { throw new Error("Bearer PRIVATE_AUTODESK_ACCESS_TOKEN"); }, async () => json({ message: "Bearer PRIVATE_AUTODESK_ACCESS_TOKEN" }, 403), async () => new Response("PRIVATE_AUTODESK_ACCESS_TOKEN", { status: 200 })]) {
    const client = new ApsClient(options(fetch, { readRetries: 0 }));
    await assert.rejects(client.listHubs(), error => error instanceof CloudError && !JSON.stringify(error).includes("PRIVATE_AUTODESK_ACCESS_TOKEN") && !error.message.includes("PRIVATE_AUTODESK_ACCESS_TOKEN"));
  }
});

test("streamed byte limits work without a content-length and abort oversized reads", async () => {
  let cancelled = false;
  const client = new ApsClient(options(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"data":[' + '"x",'.repeat(100))); }, cancel() { cancelled = true; } })), { maxResponseBytes: 128 }));
  await assert.rejects(client.listHubs(), code("RESPONSE_TOO_LARGE"));
  assert.equal(cancelled, true);
});

test("successful metadata also redacts bearer fields and signed artifact URLs", () => {
  const redacted = JSON.stringify(redactCloudData({ token: "SECRET", headers: { Authorization: "Bearer SECRET" }, reportUrl: "https://store.example/report?X-Amz-Signature=SECRET", href: "https://store.example/out?sig=SECRET", regular: "https://help.autodesk.com/view/?guid=PUBLIC", description: "ordinary CAD text" }));
  assert.equal(redacted.includes("SECRET"), false);
  assert.equal(redacted.includes("ordinary CAD text"), true);
  assert.equal(redacted.includes("guid=PUBLIC"), true);
});

test("MFGDM uses reviewed v3 documents with a fixed time/composition and snapshot-bound pagination", async () => {
  const requests = [];
  const client = new ApsClient(options(async (url, init) => {
    assert.equal(String(url), `${APS_ORIGIN}/mfg/v3/graphql/public`);
    const body = JSON.parse(init.body); requests.push(body);
    return json({ data: { model: model({ assemblyRelations: { results: [{ fromModel: { id: "model-1" }, toModel: { id: "unapproved-external", name: { value: "SECRET_PART" }, version: null } }], pagination: { cursor: requests.length === 1 ? "cursor-a" : null } } }) } });
  }));
  const first = await client.inspectMfgModel(context);
  assert.equal(first.context.timestamp, context.timestamp);
  assert.equal(first.complete, false);
  assert.equal(JSON.stringify(first).includes("SECRET_PART"), false);
  assert.equal(first.data.component.partNumber.value, null);
  assert.equal(requests[0].query, MFG_QUERY_DOCUMENTS.model.document);
  assert.equal(requests[0].variables.time, context.timestamp);
  await assert.rejects(client.inspectMfgModel({ ...context, timestamp: "2026-08-27T12:00:00.000Z", cursor: "cursor-a" }), code("STALE_SNAPSHOT"));
  const next = await client.inspectMfgModel({ ...context, cursor: "cursor-a" });
  assert.equal(next.complete, true);
  assert.equal(requests[1].variables.time, requests[0].variables.time);
  await assert.rejects(client.inspectMfgModel({ ...context, composition: "LATEST" }), code("UNSUPPORTED_CAPABILITY"));
});

test("GraphQL partial failure remains partial without exposing provider error prose", async () => {
  const client = new ApsClient(options(async () => json({ data: { model: model() }, errors: [{ message: "Bearer PRIVATE_AUTODESK_ACCESS_TOKEN", path: ["model", "physicalProperties"], extensions: { code: "ACCESS_DENIED" } }] })));
  const result = await client.inspectMfgModel(context);
  assert.equal(result.partial, true);
  assert.equal(result.complete, false);
  assert.equal(result.errors[0].code, "ACCESS_DENIED");
  assert.equal(JSON.stringify(result).includes("PRIVATE_AUTODESK_ACCESS_TOKEN"), false);
});

test("current MFG property reader checks the deployed schema and current value, then verifies an approved write", async () => {
  let propertyValue = "before";
  let mutationCalls = 0;
  const bodies = [];
  const client = new ApsClient(options(async (_url, init) => {
    const body = JSON.parse(init.body); bodies.push(body);
    if (body.query === MFG_QUERY_DOCUMENTS.propertySchema.document) return json({ data: { componentType: { fields: [{ name: "customProperties", args: [{ name: "pagination" }] }] }, setInput: { inputFields: [] } } });
    if (body.query === MFG_QUERY_DOCUMENTS.currentProperty.document) return json({ data: { model: { id: context.modelId, timestamp: context.timestamp, component: { id: "component-1", customProperties: { results: [{ value: propertyValue, definition: { id: "property-1", isReadOnly: false, isArchived: false, specification: "STRING", propertyBehavior: "TIMELESS", units: null } }], pagination: { cursor: null } } } } } });
    assert.equal(body.query, MFG_QUERY_DOCUMENTS.setProperty.document);
    mutationCalls++; propertyValue = body.variables.propertyValue;
    return json({ data: { setProperties: { properties: [{ value: propertyValue }] } } });
  }, { propertyRules: [{ propertyDefinitionId: "property-1", type: "string", allowNull: false, maxLength: 100, owner: "product" }] }));
  const draft = await client.prepareMfgPropertyChange(context, "property-1", "after");
  assert.equal(draft.before, "before");
  assert.equal(mutationCalls, 0);
  await assert.rejects(client.executeMfgPropertyChange(draft, { authorize: async () => {}, requireAtomicConcurrency: true }), code("UNSUPPORTED_CAPABILITY"));
  const authorizations = [];
  const result = await client.executeMfgPropertyChange(draft, { authorize: async (...args) => { authorizations.push(args); }, requireAtomicConcurrency: false });
  assert.equal(result.status, "verified");
  assert.equal(propertyValue, "after");
  assert.equal(mutationCalls, 1);
  assert.deepEqual(authorizations, [[draft.draftHash, "shared_business_change"]]);
  assert.ok(bodies.filter(body => body.query === MFG_QUERY_DOCUMENTS.currentProperty.document).every(body => !body.query.includes("time:")));
});

test("MFG write rejects changed values and historical-current mismatch without mutation", async () => {
  let before = "old", providerTime = context.timestamp;
  let mutations = 0;
  const client = new ApsClient(options(async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.query === MFG_QUERY_DOCUMENTS.propertySchema.document) return json({ data: { componentType: { fields: [{ name: "customProperties", args: [{ name: "pagination" }] }] }, setInput: { inputFields: [] } } });
    if (body.query === MFG_QUERY_DOCUMENTS.currentProperty.document) return json({ data: { model: { id: "model-1", timestamp: providerTime, component: { id: "component-1", customProperties: { results: [{ value: before, definition: { id: "property-1", isReadOnly: false, isArchived: false, specification: "STRING", propertyBehavior: "TIMELESS", units: null } }], pagination: { cursor: null } } } } } });
    mutations++; return json({ data: {} });
  }, { propertyRules: [{ propertyDefinitionId: "property-1", type: "string", allowNull: false, owner: "product" }] }));
  const draft = await client.prepareMfgPropertyChange(context, "property-1", "requested");
  before = "changed by colleague";
  await assert.rejects(client.executeMfgPropertyChange(draft, { authorize: async () => {}, requireAtomicConcurrency: false }), code("STALE_PLAN"));
  providerTime = "2026-08-28T13:00:00.000Z";
  await assert.rejects(client.prepareMfgPropertyChange(context, "property-1", "requested"), code("STALE_PLAN"));
  assert.equal(mutations, 0);
});

test("Fusion Manage reads are bound to the exact tenant and workspace with separate draft schema checks", async () => {
  const seen = [];
  const fields = [{ id: "DESCRIPTION", type: "STRING" }];
  const client = new ApsClient(options(async (url, init) => {
    seen.push({ url: String(url), init });
    return json(String(url).endsWith("/fields") ? fields : { id: 3, description: "existing draft" }, 200, { etag: '"revision-3"' });
  }));
  const schema = { tenant: "acme", workspaceId: 10, schemaFingerprint: cloudHash(fields), fields: [{ fieldId: "DESCRIPTION", type: "string", allowNull: false, allowDraftUpdate: true, lifecycle: false }] };
  const draft = await client.prepareManageItemDraft(10, 3, schema, [{ fieldId: "DESCRIPTION", after: "new draft", sourceRef: "model-1" }]);
  assert.equal(draft.status, "draft_outbox");
  assert.equal(draft.releaseApproved, false);
  assert.equal(draft.publicationSupported, false);
  assert.equal(seen[0].url, "https://acme.autodeskplm360.net/api/v3/workspaces/10/fields");
  assert.equal(seen[0].init.headers["x-tenant"], "acme");
  assert.equal(seen.every(call => call.init.method === "GET"), true);
  await assert.rejects(client.getManageItem(11, 3), code("SCOPE_DENIED"));
  await assert.rejects(client.prepareManageItemDraft(10, 3, { ...schema, schemaFingerprint: "0".repeat(64) }, [{ fieldId: "DESCRIPTION", after: "new", sourceRef: "model" }]), code("STALE_PLAN"));
});
