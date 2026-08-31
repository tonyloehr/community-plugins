import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { APS_ORIGIN, ApsClient, CloudCoordinator, FusionError, MemoryTokenStore, RecordStore, cloudHash, createFusionServer, hash, manageDraftRecordBinding, parseProfile, verifyManageDraftRecord } from '../dist/index.mjs';

const prepareTool = 'fusion_manage_item_draft_prepare', inspectTool = 'fusion_manage_item_draft_inspect';
// Opaque synthetic fields payload; rules are explicitly reviewed owner policy,
// never inferred from provider display labels or this test payload's shape.
const fieldsBody = [{ id: 'DESCRIPTION', type: 'STRING' }, { id: 'MASS', type: 'FLOAT' }, { id: 'OPTIONAL', type: 'STRING' }, { id: 'AVAILABLE', type: 'CHECKBOX' }];
const trustedSchema = () => ({ tenant: 'acme', workspaceId: 10, schemaFingerprint: cloudHash(fieldsBody), fields: [
  { fieldId: 'DESCRIPTION', type: 'string', allowNull: false, allowDraftUpdate: true, lifecycle: false, maxLength: 128 },
  { fieldId: 'MASS', type: 'number', allowNull: false, allowDraftUpdate: true, lifecycle: false, minimum: 0, maximum: 10 },
  { fieldId: 'OPTIONAL', type: 'string', allowNull: true, allowDraftUpdate: true, lifecycle: false },
  { fieldId: 'AVAILABLE', type: 'boolean', allowNull: false, allowDraftUpdate: true, lifecycle: false },
  { fieldId: 'READ_ONLY', type: 'string', allowNull: false, allowDraftUpdate: false, lifecycle: false },
  { fieldId: 'LIFECYCLE', type: 'string', allowNull: false, allowDraftUpdate: false, lifecycle: true },
] });
const request = () => ({ workspace_id: 10, item_id: 3, changes: [{ field_id: 'DESCRIPTION', after: 'Draft for review', source_ref: 'model:explicit-caller-reference' }] });
const itemBody = () => ({
  __self__: '/api/v3/workspaces/10/items/3', urn: 'urn:adsk.plm:tenant.workspace.item:ACME.10.3',
  workspace: { link: '/api/v3/workspaces/10', title: 'Test components', deleted: false },
  title: 'Test component', deleted: false, itemLocked: false,
  lifecycle: { link: '/api/v3/workflows/1/states/0', title: 'Unreleased', deleted: false },
  sections: [{ link: '/api/v3/workspaces/10/items/3/views/1/sections/1', title: 'Item Details', sectionLocked: false, fields: [{
    __self__: '/api/v3/workspaces/10/items/3/views/1/fields/DESCRIPTION',
    urn: 'urn:adsk.plm:tenant.workspace.item.view.field:ACME.10.3.1.DESCRIPTION',
    title: 'Description', type: { link: '/api/v3/field-types/4', title: 'Single Line Text', deleted: false },
    value: 'Original description', defaultValue: '',
  }] }],
});
const rawProfile = root => ({ version: 1, id: 'manage-draft-test', mode: 'assisted', stateRoot: path.join(root, 'state'), policy: { mutationsEnabled: false }, cloud: {
  clientId: 'test-public-client', tenantId: 'enterprise-a', scopes: ['data:read'], redirectUri: 'http://127.0.0.1:8765/callback',
  hubIds: [], projects: [], mfgModels: [], manage: { tenant: 'acme', workspaceIds: [10] }, manageDraftSchemas: [trustedSchema()],
} });
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const plain = value => JSON.parse(JSON.stringify(value));

async function setup(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fusion-manage-draft-'));
  const raw = rawProfile(root); options.configure?.(raw);
  const profile = parseProfile(raw), store = new RecordStore(path.join(root, 'ledger'));
  const state = { fields: structuredClone(fieldsBody), item: itemBody(), etag: '"item-revision-1"', account: 'test-account-a', grantType: 'authorization_code', tokenRequests: 0, requests: [], sdkDrafts: [], hook: undefined, sdkHook: undefined };
  const apsScope = { tenantId: profile.cloud.tenantId, hubIds: [], projects: [], mfgModels: [], ...(profile.cloud.manage ? { manage: profile.cloud.manage } : {}) };
  const aps = new ApsClient({
    scope: options.apsScope ?? apsScope,
    tokenProvider: { async getToken() { state.tokenRequests++; return { accessToken: 'SYNTHETIC_MANAGE_TOKEN', expiresAt: Date.now() + 3_600_000, scopes: ['data:read'], tenantId: 'enterprise-a', issuer: APS_ORIGIN, resource: APS_ORIGIN, grantType: state.grantType }; } },
    limiter: { async acquire() {} }, now: () => Date.now(), sleep: async () => {},
    fetch: async (url, init) => {
      const seen = { url: String(url), method: init.method, tenant: init.headers['x-tenant'] };
      state.requests.push(seen);
      assert.equal(seen.method, 'GET', 'Manage draft route must never write to Autodesk');
      assert.equal(seen.tenant, 'acme');
      const replacement = await state.hook?.(seen);
      if (replacement) return replacement;
      if (seen.url === 'https://acme.autodeskplm360.net/api/v3/workspaces/10/fields') return json(state.fields);
      if (seen.url === 'https://acme.autodeskplm360.net/api/v3/workspaces/10/items/3') return json(state.item, 200, state.etag === null ? {} : { etag: state.etag });
      throw new Error('Unexpected synthetic APS endpoint');
    },
  });
  const sdkPrepare = aps.prepareManageItemDraft.bind(aps);
  aps.prepareManageItemDraft = async (...args) => {
    const draft = await sdkPrepare(...args); state.sdkDrafts.push(structuredClone(draft));
    return state.sdkHook ? state.sdkHook(structuredClone(draft)) : draft;
  };
  const profileFile = options.profileFile ? path.join(root, 'profile.json') : undefined;
  if (profileFile) await writeFile(profileFile, JSON.stringify(profile), { mode: 0o600 });
  const config = { root, profile, store, aps, tokenStore: new MemoryTokenStore(), authorizationBinding: async () => state.account, ...(profileFile ? { profileFile } : {}) };
  const fixture = { root, profile, store, aps, config, state, profileFile, coordinator: await CloudCoordinator.create(config) };
  const clients = [];
  fixture.wire = async coordinator => {
    const server = createFusionServer({ root, profile, engine: { store }, cloud: coordinator ?? fixture.coordinator, close: async () => {} });
    const client = new Client({ name: 'manage-draft-contract-test', version: '1.0.0' });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(right); await client.connect(left); clients.push({ client, server });
    return client;
  };
  fixture.client = await fixture.wire();
  fixture.bytes = id => readFile(path.join(store.root, `managedraft--${id}.json`), 'utf8');
  t.after(async () => { for (const { client, server } of clients) { await client.close(); await server.close(); } await rm(root, { recursive: true, force: true }); });
  return fixture;
}
async function success(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return result.structuredContent;
}
async function refusal(client, name, args, code) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true);
  if (code) assert.equal(result.structuredContent?.error.code, code, JSON.stringify(result));
  return result;
}
async function noDraft(fixture) { assert.equal((await fixture.store.list('managedraft')).length, 0); }

test('Manage schema registry is optional and existing parsed profile defaults and hashes stay unchanged', () => {
  const raw = rawProfile(path.resolve('test-only-unused-root')); delete raw.cloud.manageDraftSchemas;
  const profile = parseProfile(raw);
  assert.equal(Object.hasOwn(profile.cloud, 'manageDraftSchemas'), false);
  assert.equal(hash(parseProfile(profile)), hash(profile));
  assert.equal(profile.policy.mutationsEnabled, false);
  assert.equal(profile.policy.allowNonAtomicCloudWrites, false);
});

test('trusted schemas require exact scope, unique IDs, explicit lifecycle restrictions and compatible finite bounds', () => {
  const changes = [
    raw => { raw.cloud.manageDraftSchemas.push(trustedSchema()); },
    raw => { raw.cloud.manageDraftSchemas[0].tenant = 'other'; },
    raw => { raw.cloud.manageDraftSchemas[0].workspaceId = 11; },
    raw => { delete raw.cloud.manage; },
    raw => { raw.cloud.manageDraftSchemas[0].fields.push({ ...trustedSchema().fields[0] }); },
    raw => { raw.cloud.manageDraftSchemas[0].fields[5].allowDraftUpdate = true; },
    raw => { raw.cloud.manageDraftSchemas[0].fields[0].minimum = 0; },
    raw => { raw.cloud.manageDraftSchemas[0].fields[1].minimum = 11; },
    raw => { raw.cloud.manageDraftSchemas[0].fields[1].maximum = Infinity; },
    raw => { raw.cloud.manageDraftSchemas[0].fields[1].maxLength = 5; },
    raw => { raw.cloud.manageDraftSchemas[0].fields[3].minimum = 0; },
    raw => { raw.cloud.manageDraftSchemas[0].fields[0].maxLength = 8193; },
    raw => { raw.cloud.manageDraftSchemas[0].fields[0].allowDraftUpdate = 'true'; },
    raw => { raw.cloud.manageDraftSchemas[0].fields[0].fieldId = ''; },
    raw => { raw.cloud.manageDraftSchemas[0].fields[0].fieldId = 'BAD\nID'; },
    raw => { raw.cloud.manageDraftSchemas[0].fields = []; },
    raw => { raw.cloud.manageDraftSchemas[0].fields = Array.from({ length: 201 }, (_, i) => ({ ...trustedSchema().fields[0], fieldId: `field-${i}` })); },
    raw => { raw.cloud.manageDraftSchemas[0].schemaFingerprint = 'unreviewed'; },
    raw => { raw.cloud.manageDraftSchemas[0].approved = true; },
    raw => { raw.cloud.manageDraftSchemas[0].fields[0].type = 'array'; },
  ];
  for (const change of changes) { const raw = rawProfile(path.resolve('test-only-unused-root')); change(raw); assert.throws(() => parseProfile(raw), { code: 'INVALID_PROFILE' }); }
});

test('MCP advertises strict Manage prepare/inspect contracts without a schema, approval or execute input', async t => {
  const fixture = await setup(t), tools = (await fixture.client.listTools()).tools;
  const prepare = tools.find(tool => tool.name === prepareTool), inspect = tools.find(tool => tool.name === inspectTool);
  assert.deepEqual(Object.keys(prepare.inputSchema.properties).sort(), ['changes', 'item_id', 'workspace_id']);
  assert.deepEqual(Object.keys(inspect.inputSchema.properties), ['draft_id']);
  assert.equal(prepare.inputSchema.additionalProperties, false);
  assert.equal(prepare.annotations.readOnlyHint, false);
  assert.equal(inspect.annotations.readOnlyHint, true);
  assert.equal(tools.some(tool => /manage.*(?:execute|publish|release)/u.test(tool.name)), false);
  const property = tools.find(tool => tool.name === 'fusion_data_changes_prepare').inputSchema;
  assert.equal(property.properties.require_atomic_concurrency.default, true);
  assert.equal(property.required.includes('require_atomic_concurrency'), false);
  assert.equal(fixture.state.requests.length, 0);
});

test('actual MCP prepares exact SDK draft bytes, scalar changes and explicit unverified provenance with GET-only APS', async t => {
  const fixture = await setup(t), args = request();
  args.changes.push({ field_id: 'MASS', after: 2.5, source_ref: 'inspection:mass' }, { field_id: 'OPTIONAL', after: null, source_ref: 'owner:clear-optional' }, { field_id: 'AVAILABLE', after: false, source_ref: 'caller:availability' });
  const result = await success(fixture.client, prepareTool, args);
  const stored = verifyManageDraftRecord(await fixture.store.get('managedraft', result.id));
  assert.match(result.id, /^managedraft_[a-f0-9-]{36}$/u);
  assert.deepEqual(stored.request, args);
  assert.deepEqual(stored.draft, plain(fixture.state.sdkDrafts[0]));
  assert.equal(result.record_hash, hash(manageDraftRecordBinding(stored)));
  assert.equal(result.stored_draft_hash, stored.draft.draftHash);
  assert.equal(result.review_hash, cloudHash(result.review));
  assert.deepEqual(result.review.changes, args.changes.map(change => ({ fieldId: change.field_id, after: change.after, sourceRef: change.source_ref })));
  assert.equal(result.review.sourceItem.sections[0].fields[0].value, 'Original description');
  assert.equal(result.review.sourceItem.lifecycle.title, 'Unreleased');
  assert.equal(result.source_references_verified, false);
  assert.equal(result.review.requiresApproval, true);
  for (const flag of ['provider_write_performed', 'publication_supported', 'release_approved', 'live_qualified']) assert.equal(result[flag], false);
  assert.equal(result.review.releaseApproved, false); assert.equal(result.review.publicationSupported, false);
  assert.equal(result.freshness.atomic_snapshot, false);
  assert.equal(Date.parse(result.expires_at) - Date.parse(result.created_at), fixture.profile.policy.planMaxAgeMs);
  assert.deepEqual(fixture.state.requests.map(row => [row.method, row.url]), [
    ['GET', 'https://acme.autodeskplm360.net/api/v3/workspaces/10/fields'],
    ['GET', 'https://acme.autodeskplm360.net/api/v3/workspaces/10/items/3'],
  ]);
  const audits = await fixture.store.list('audit');
  assert.equal(audits.length, 1); assert.equal(audits[0].event, 'manage_draft_prepared');
  assert.deepEqual(audits[0].details, { id: stored.id, record_hash: stored.record_hash, stored_draft_hash: stored.draft.draftHash, workspace_id: 10, item_id: 3, provider_write_performed: false });
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_MANAGE_TOKEN'), false);
});

test('MCP inspection survives coordinator restart and leaves immutable record, audit and expiry unchanged', async t => {
  const fixture = await setup(t), prepared = await success(fixture.client, prepareTool, request());
  const before = await fixture.bytes(prepared.id), entries = (await readdir(fixture.store.root)).sort();
  const restarted = await CloudCoordinator.create({ ...fixture.config, store: new RecordStore(fixture.store.root) });
  const client = await fixture.wire(restarted), inspected = await success(client, inspectTool, { draft_id: prepared.id });
  assert.equal(inspected.record_hash, prepared.record_hash); assert.equal(inspected.review_hash, prepared.review_hash);
  assert.equal(inspected.created_at, prepared.created_at); assert.equal(inspected.expires_at, prepared.expires_at);
  assert.equal(inspected.freshness.schema_and_item_match, true);
  assert.equal(await fixture.bytes(prepared.id), before);
  assert.deepEqual((await readdir(fixture.store.root)).sort(), entries);
  assert.equal((await fixture.store.list('audit')).length, 1);
  assert.equal(fixture.state.requests.length, 4);
});

test('missing trusted registry refuses before any token request or provider read', async t => {
  for (const registry of [undefined, []]) {
    const fixture = await setup(t, { configure: raw => { if (registry === undefined) delete raw.cloud.manageDraftSchemas; else raw.cloud.manageDraftSchemas = registry; } });
    await refusal(fixture.client, prepareTool, request(), 'UNQUALIFIED_SCHEMA');
    assert.equal(fixture.state.tokenRequests, 0); assert.equal(fixture.state.requests.length, 0); await noDraft(fixture);
  }
});

test('workspace scope and client tenant mismatch cannot be repaired by a caller schema', async t => {
  const fixture = await setup(t);
  await refusal(fixture.client, prepareTool, { ...request(), workspace_id: 11 }, 'SCOPE_DENIED');
  await refusal(fixture.client, prepareTool, { ...request(), schema: trustedSchema() });
  const other = await setup(t, { apsScope: { tenantId: 'enterprise-a', hubIds: [], projects: [], mfgModels: [], manage: { tenant: 'other', workspaceIds: [10] } } });
  await refusal(other.client, prepareTool, request(), 'DATA_SCOPE_DENIED');
  for (const f of [fixture, other]) { assert.equal(f.state.tokenRequests, 0); assert.equal(f.state.requests.length, 0); await noDraft(f); }
});

test('an allowlisted workspace still needs its own exact schema binding', async t => {
  const fixture = await setup(t, { configure: raw => { raw.cloud.manage.workspaceIds.push(11); } });
  await refusal(fixture.client, prepareTool, { ...request(), workspace_id: 11 }, 'UNQUALIFIED_SCHEMA');
  assert.equal(fixture.state.tokenRequests, 0); await noDraft(fixture);
});

test('public MCP rejects authority flags, malformed IDs, duplicate fields and unbounded changes before reads', async t => {
  const fixture = await setup(t), good = request();
  const invalid = [
    { ...good, approved: true }, { ...good, releaseApproved: true }, { ...good, schemaFingerprint: 'a'.repeat(64) },
    { ...good, changes: [{ ...good.changes[0], allowDraftUpdate: true }] },
    { ...good, workspace_id: '10' }, { ...good, workspace_id: 0 }, { ...good, item_id: 1.5 }, { ...good, item_id: 2 ** 54 },
    { ...good, changes: [] }, { ...good, changes: [good.changes[0], good.changes[0]] },
    { ...good, changes: Array.from({ length: 101 }, (_, i) => ({ ...good.changes[0], field_id: `field-${i}` })) },
    { ...good, changes: [{ ...good.changes[0], after: { value: 'x' } }] },
    { ...good, changes: [{ ...good.changes[0], source_ref: '' }] },
    { ...good, changes: [{ ...good.changes[0], source_ref: 'x'.repeat(2049) }] },
  ];
  for (const args of invalid) await refusal(fixture.client, prepareTool, args);
  for (const value of [NaN, Infinity, -Infinity]) await assert.rejects(fixture.coordinator.prepareManageDraft({ ...good, changes: [{ ...good.changes[0], after: value }] }));
  assert.equal(fixture.state.tokenRequests, 0); assert.equal(fixture.state.requests.length, 0); await noDraft(fixture);
});

test('trusted lifecycle/read-only exclusions and scalar bounds are enforced before APS reads', async t => {
  const fixture = await setup(t);
  const invalid = [['LIFECYCLE', 'Released', 'SCOPE_DENIED'], ['READ_ONLY', 'value', 'SCOPE_DENIED'], ['UNKNOWN', 'value', 'SCOPE_DENIED'], ['DESCRIPTION', null, 'INVALID_ARGUMENT'], ['DESCRIPTION', 5, 'INVALID_ARGUMENT'], ['DESCRIPTION', 'x'.repeat(129), 'INVALID_ARGUMENT'], ['MASS', '5', 'INVALID_ARGUMENT'], ['MASS', -1, 'INVALID_ARGUMENT'], ['MASS', 10.1, 'INVALID_ARGUMENT'], ['AVAILABLE', 'true', 'INVALID_ARGUMENT']];
  for (const [field_id, after, code] of invalid) await refusal(fixture.client, prepareTool, { ...request(), changes: [{ field_id, after, source_ref: 'caller:unverified' }] }, code);
  assert.equal(fixture.state.tokenRequests, 0); assert.equal(fixture.state.requests.length, 0); await noDraft(fixture);
});

test('credential-bearing requested values and provenance are refused without silently altering the draft', async t => {
  const fixture = await setup(t);
  for (const change of [
    { field_id: 'DESCRIPTION', after: 'Bearer TEST_ONLY_SECRET', source_ref: 'caller:ref' },
    { field_id: 'DESCRIPTION', after: 'review draft', source_ref: 'https://example.invalid/source?signature=TEST_ONLY_SECRET' },
    { field_id: 'DESCRIPTION', after: 'review draft', source_ref: 'https://example.invalid/go?next=https%3A%2F%2Fexample.invalid%2Ffile%3Ftoken%3DTEST_ONLY_SECRET' },
  ]) await refusal(fixture.client, prepareTool, { ...request(), changes: [change] }, 'INVALID_INPUT');
  assert.equal(fixture.state.tokenRequests, 0); await noDraft(fixture);
});

test('stale provider field schema blocks preparation after one GET and leaves no local draft', async t => {
  const fixture = await setup(t); fixture.state.fields.push({ id: 'NEW_FIELD', type: 'STRING' });
  await refusal(fixture.client, prepareTool, request(), 'STALE_PLAN');
  assert.equal(fixture.state.requests.length, 1); assert.ok(fixture.state.requests[0].url.endsWith('/fields')); await noDraft(fixture);
});

test('account drift during either SDK GET rejects the observation and persists no draft', async t => {
  for (const endpoint of ['/fields', '/items/3']) {
    const fixture = await setup(t);
    fixture.state.hook = seen => { if (seen.url.endsWith(endpoint)) fixture.state.account = 'test-account-b'; };
    await refusal(fixture.client, prepareTool, request(), 'ACCOUNT_CHANGED');
    assert.equal(fixture.state.requests.length, 2); await noDraft(fixture);
  }
});

test('profile file and in-memory schema drift during SDK reads are rejected before persistence', async t => {
  const file = await setup(t, { profileFile: true });
  file.state.hook = async seen => { if (seen.url.endsWith('/items/3')) { const changed = structuredClone(file.profile); changed.cloud.manageDraftSchemas[0].fields[0].maxLength = 127; await writeFile(file.profileFile, JSON.stringify(changed), { mode: 0o600 }); } };
  await refusal(file.client, prepareTool, request(), 'PROFILE_CHANGED'); await noDraft(file);
  const memory = await setup(t);
  memory.state.hook = seen => { if (seen.url.endsWith('/items/3')) memory.profile.cloud.manageDraftSchemas[0].fields[0].maxLength = 127; };
  await refusal(memory.client, prepareTool, request(), 'PROFILE_CHANGED'); await noDraft(memory);
});

test('inspection refuses changed account, profile or scope before reading the provider', async t => {
  for (const [change, code] of [
    [f => { f.state.account = 'test-account-b'; }, 'ACCOUNT_CHANGED'],
    [f => { f.profile.cloud.manageDraftSchemas[0].fields[0].maxLength = 127; }, 'PROFILE_CHANGED'],
    [f => { f.profile.cloud.manage.workspaceIds.push(11); }, 'DATA_SCOPE_DENIED'],
  ]) {
    const fixture = await setup(t), prepared = await success(fixture.client, prepareTool, request()), before = await fixture.bytes(prepared.id);
    change(fixture); await refusal(fixture.client, inspectTool, { draft_id: prepared.id }, code);
    assert.equal(fixture.state.requests.length, 2); assert.equal(await fixture.bytes(prepared.id), before);
  }
});

test('item value, schema and ETag drift fail inspection without renewing or overwriting the original record', async t => {
  for (const change of [f => { f.state.item.sections[0].fields[0].value = 'Changed remotely'; }, f => { f.state.etag = '"item-revision-2"'; }, f => { f.state.fields.push({ id: 'NEW_FIELD', type: 'STRING' }); }]) {
    const fixture = await setup(t), prepared = await success(fixture.client, prepareTool, request()), before = await fixture.bytes(prepared.id);
    change(fixture); await refusal(fixture.client, inspectTool, { draft_id: prepared.id }, 'STALE_PLAN');
    assert.equal(await fixture.bytes(prepared.id), before); assert.equal((await fixture.store.list('audit')).length, 1);
  }
});

test('a missing optional ETag stays null and full-response fingerprints still guard inspection', async t => {
  const fixture = await setup(t); fixture.state.etag = null;
  const prepared = await success(fixture.client, prepareTool, request());
  assert.equal(prepared.review.expectedEtag, null);
  await success(fixture.client, inspectTool, { draft_id: prepared.id });
  fixture.state.item.title = 'Changed even without an ETag';
  await refusal(fixture.client, inspectTool, { draft_id: prepared.id }, 'STALE_PLAN');
});

test('expiration during preparation cannot manufacture a fresh lifetime after slow reads', async t => {
  const fixture = await setup(t, { configure: raw => { raw.policy.planMaxAgeMs = 1000; } });
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  fixture.state.hook = seen => { if (seen.url.endsWith('/items/3')) clock += 1001; };
  await refusal(fixture.client, prepareTool, request(), 'PLAN_EXPIRED'); await noDraft(fixture);
});

test('expired inspection performs no GET and expiration during recheck cannot extend an immutable draft', async t => {
  const fixture = await setup(t, { configure: raw => { raw.policy.planMaxAgeMs = 1000; } });
  const prepared = await success(fixture.client, prepareTool, request()), before = await fixture.bytes(prepared.id);
  let clock = Date.parse(prepared.created_at) + 1; t.mock.method(Date, 'now', () => clock);
  fixture.state.hook = seen => { if (seen.url.endsWith('/items/3')) clock = Date.parse(prepared.expires_at); };
  await refusal(fixture.client, inspectTool, { draft_id: prepared.id }, 'PLAN_EXPIRED');
  assert.equal(fixture.state.requests.length, 4); assert.equal(await fixture.bytes(prepared.id), before);
  await refusal(fixture.client, inspectTool, { draft_id: prepared.id }, 'PLAN_EXPIRED');
  assert.equal(fixture.state.requests.length, 4); assert.equal(await fixture.bytes(prepared.id), before);
});

test('public review hash binds nested sections after both sanitizers while exact SDK evidence stays in the private record', async t => {
  const fixture = await setup(t);
  fixture.state.item.sections[0].fields[0].value = 'See https://user:TEST_USER@name:TEST_PASSWORD@example.invalid/x?token=TEST_QUERY_SECRET';
  fixture.state.item.sections[0].fields.push({ title: 'Attachment', value: 'https://example.invalid/go?next=https%3A%2F%2Fexample.invalid%2Ffile%3Fsig%3DTEST_NESTED_SECRET', access_token: 'TEST_FIELD_SECRET' });
  const prepared = await success(fixture.client, prepareTool, request());
  const stored = verifyManageDraftRecord(await fixture.store.get('managedraft', prepared.id));
  assert.deepEqual(stored.draft, plain(fixture.state.sdkDrafts[0]));
  assert.equal(prepared.stored_draft_hash, stored.draft.draftHash);
  assert.equal(prepared.review_hash, cloudHash(prepared.review));
  assert.equal(prepared.review_redacted, true);
  for (const secret of ['TEST_USER', 'TEST_PASSWORD', 'TEST_QUERY_SECRET', 'TEST_NESTED_SECRET', 'TEST_FIELD_SECRET', 'SYNTHETIC_MANAGE_TOKEN']) assert.equal(JSON.stringify(prepared).includes(secret), false, secret);
  const before = await fixture.bytes(prepared.id);
  const inspected = await success(fixture.client, inspectTool, { draft_id: prepared.id });
  assert.equal(inspected.review_hash, cloudHash(inspected.review)); assert.equal(inspected.review_hash, prepared.review_hash);
  assert.equal(await fixture.bytes(prepared.id), before);
});

test('pure record verification rejects changed content, authority, unknown fields and inconsistent bindings', async t => {
  const fixture = await setup(t), prepared = await success(fixture.client, prepareTool, request()), original = await fixture.store.get('managedraft', prepared.id);
  for (const change of [
    value => { value.request.changes[0].after = 'Different value'; },
    value => { value.draft.releaseApproved = true; const { draftHash, ...draft } = value.draft; value.draft.draftHash = cloudHash(draft); },
    value => { value.draft.itemId = 4; const { draftHash, ...draft } = value.draft; value.draft.draftHash = cloudHash(draft); },
    value => { value.request.workspace_id = 11; value.request_hash = hash(value.request); },
    value => { value.trusted_schema.fields[0].lifecycle = true; value.schema_hash = hash(value.trusted_schema); },
    value => { value.expires_at = value.created_at; },
    value => { value.observed_at = value.expires_at; },
    value => { value.unknown_authority = true; },
  ]) {
    const altered = structuredClone(original); change(altered); altered.record_hash = hash(manageDraftRecordBinding(altered));
    assert.throws(() => verifyManageDraftRecord(altered), { code: 'DRAFT_TAMPERED' });
  }
  const altered = structuredClone(original); altered.draft.sourceItem.title = 'Changed raw receipt';
  await fixture.store.put('managedraft', prepared.id, altered);
  await refusal(fixture.client, inspectTool, { draft_id: prepared.id }, 'DRAFT_TAMPERED');
  assert.equal(fixture.state.requests.length, 2);
});

test('opaque draft IDs cannot traverse paths or swap an otherwise valid record into another identity', async t => {
  const fixture = await setup(t), first = await success(fixture.client, prepareTool, request()), second = await success(fixture.client, prepareTool, request());
  assert.notEqual(first.id, second.id);
  for (const id of ['../profile', 'managedraft_fake', first.id + '/other']) await refusal(fixture.client, inspectTool, { draft_id: id });
  const record = await fixture.store.get('managedraft', second.id); await fixture.store.put('managedraft', first.id, record);
  await refusal(fixture.client, inspectTool, { draft_id: first.id }, 'DRAFT_TAMPERED');
  assert.equal(fixture.state.requests.length, 4);
});

test('unexpected SDK identities, requested values or publication flags cannot become durable drafts', async t => {
  for (const change of [draft => { draft.itemId = 4; }, draft => { draft.tenantId = 'other-enterprise'; }, draft => { draft.changes[0].after = 'Substituted'; }, draft => { draft.publicationSupported = true; }]) {
    const fixture = await setup(t);
    fixture.state.sdkHook = draft => { change(draft); const { draftHash, ...body } = draft; return { ...body, draftHash: cloudHash(body) }; };
    await refusal(fixture.client, prepareTool, request(), 'INVALID_MANAGE_DRAFT'); await noDraft(fixture);
  }
});

test('user-delegated Manage credentials remain mandatory and permission errors never cause writes', async t => {
  const appOnly = await setup(t); appOnly.state.grantType = 'client_credentials';
  await refusal(appOnly.client, prepareTool, request(), 'SCOPE_DENIED');
  assert.equal(appOnly.state.requests.length, 0); await noDraft(appOnly);
  const denied = await setup(t); denied.state.hook = () => json({ error: 'test-only permission refusal' }, 403);
  await refusal(denied.client, prepareTool, request());
  assert.equal(denied.state.requests.length, 1); assert.equal(denied.state.requests[0].method, 'GET'); await noDraft(denied);
});

test('failed audit persistence preserves the allocated local draft identity without claiming provider effects', async t => {
  const fixture = await setup(t); fixture.store.audit = async () => { throw new Error('synthetic disk failure'); };
  const result = await refusal(fixture.client, prepareTool, request(), 'DRAFT_PERSISTENCE_UNCONFIRMED');
  const error = result.structuredContent.error;
  assert.equal(error.outcome, 'unknown'); assert.equal(error.details.provider_write_performed, false);
  const stored = verifyManageDraftRecord(await fixture.store.get('managedraft', error.details.draft_id));
  assert.equal(stored.record_hash, error.details.record_hash);
  assert.equal(fixture.state.requests.every(row => row.method === 'GET'), true);
});

test('context and clock drift after local persistence return only an explicit uncertainty receipt', async t => {
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  for (const [change, reason] of [
    [f => { f.state.account = 'test-account-b'; }, 'ACCOUNT_CHANGED'],
    [f => { f.profile.cloud.manageDraftSchemas[0].fields[0].maxLength = 127; }, 'PROFILE_CHANGED'],
    [() => { clock += 1000; }, 'PLAN_EXPIRED'],
  ]) {
    const fixture = await setup(t, { configure: raw => { raw.policy.planMaxAgeMs = 1000; } });
    const audit = fixture.store.audit.bind(fixture.store);
    fixture.store.audit = async (...args) => { await audit(...args); change(fixture); };
    const result = await refusal(fixture.client, prepareTool, request(), 'DRAFT_REVIEW_UNCONFIRMED');
    const error = result.structuredContent.error;
    assert.equal(error.outcome, 'unknown'); assert.equal(error.details.reason_code, reason);
    assert.equal(error.details.provider_write_performed, false);
    assert.equal(JSON.stringify(result).includes('Original description'), false);
    const stored = verifyManageDraftRecord(await fixture.store.get('managedraft', error.details.draft_id));
    assert.equal(stored.record_hash, error.details.record_hash);
    assert.equal((await fixture.store.list('audit')).length, 1);
    assert.equal(fixture.state.requests.length, 2);
  }
});

for (const contextDrift of [false, true]) test(`lease cleanup failure retains the draft receipt and prior context refusal=${contextDrift}`, async t => {
  const fixture = await setup(t);
  const acquire = fixture.store.acquireLease.bind(fixture.store);
  let releases = 0;
  fixture.store.acquireLease = async () => {
    const release = await acquire();
    return async () => {
      // Exercise the actual lease lifecycle; this fails only after its owned
      // lock is normally cleaned, so the test leaves no unresolved resources.
      await release(); releases++;
      throw new FusionError('SYNTHETIC_LEASE_RELEASE_FAILURE', 'Test-only cleanup failure after real lease release.', 'none');
    };
  };
  if (contextDrift) {
    const audit = fixture.store.audit.bind(fixture.store);
    fixture.store.audit = async (...args) => { await audit(...args); fixture.state.account = 'test-account-b'; };
  }
  const result = await refusal(fixture.client, prepareTool, request(), 'DRAFT_COMPLETION_UNCONFIRMED');
  const error = result.structuredContent.error;
  assert.equal(error.outcome, 'unknown'); assert.equal(error.details.provider_write_performed, false);
  assert.equal(error.details.cleanup_error_code, 'SYNTHETIC_LEASE_RELEASE_FAILURE');
  assert.equal(error.details.prior_error_code, contextDrift ? 'DRAFT_REVIEW_UNCONFIRMED' : undefined);
  assert.equal(error.details.prior_reason_code, contextDrift ? 'ACCOUNT_CHANGED' : undefined);
  const records = await fixture.store.list('managedraft');
  assert.equal(records.length, 1);
  const stored = verifyManageDraftRecord(records[0]);
  assert.equal(error.details.draft_id, stored.id); assert.equal(error.details.record_hash, stored.record_hash);
  assert.equal((await fixture.store.list('audit')).length, 1); assert.equal(releases, 1);
  assert.equal(fixture.state.requests.length, 2); assert.ok(fixture.state.requests.every(row => row.method === 'GET'));
  assert.equal(JSON.stringify(result).includes('Original description'), false);
  assert.equal((await readdir(fixture.store.root)).includes('.execution.lock'), false);
});

test('lease cleanup cannot erase an allocated receipt when the first put itself fails', async t => {
  const fixture = await setup(t);
  const acquire = fixture.store.acquireLease.bind(fixture.store), put = fixture.store.put.bind(fixture.store);
  fixture.store.acquireLease = async () => {
    const release = await acquire();
    return async () => { await release(); throw new FusionError('SYNTHETIC_LEASE_RELEASE_FAILURE', 'Test-only cleanup failure.', 'none'); };
  };
  let attemptedId;
  fixture.store.put = async (kind, id, value) => {
    if (kind === 'managedraft') { attemptedId = id; throw new Error('Test-only failed first persistence attempt'); }
    return put(kind, id, value);
  };
  const result = await refusal(fixture.client, prepareTool, request(), 'DRAFT_COMPLETION_UNCONFIRMED');
  const error = result.structuredContent.error;
  assert.equal(error.outcome, 'unknown'); assert.equal(error.details.provider_write_performed, false);
  assert.equal(error.details.draft_id, attemptedId); assert.match(error.details.record_hash, /^[a-f0-9]{64}$/u);
  assert.equal(error.details.prior_error_code, 'DRAFT_PERSISTENCE_UNCONFIRMED');
  assert.equal(error.details.cleanup_error_code, 'SYNTHETIC_LEASE_RELEASE_FAILURE');
  assert.equal(await fixture.store.get('managedraft', attemptedId), undefined);
  assert.equal((await fixture.store.list('audit')).length, 0);
  assert.equal((await readdir(fixture.store.root)).includes('.execution.lock'), false);
});
