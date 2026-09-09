import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { FusionEngine, FusionError, FixtureDesktopProvider, createFusionServer, describeOperations, fixtureProfile, hash, parseOperation, parseProfile } from '../dist/index.mjs';

const DOCUMENT = 'fixture:bracket';
const HANDLER = hash('CAD feature protocol test; not a Fusion handler attestation');
const cases = [
  ['construction_planes.offset', { plane_id: 'plane-xy', distance: '-2 in', name: 'Lower section' }],
  ['features.sweep', { profile_id: 'profile-1', path_entity_ids: ['edge-1', 'line-2'], operation: 'new_body' }],
  ['features.loft', { profile_ids: ['profile-1', 'profile-2'], operation: 'new_body' }],
  ['features.draft', { face_ids: ['face-1'], plane_id: 'plane-xy', angle: '-5 deg', symmetric: false, direction_flipped: true, tangent_chain: false }],
  ['features.split_body', { body_ids: ['body-1', 'body-2'], splitting_tool_id: 'plane-yz', extend_tool: false }],
  ['features.mirror', { body_ids: ['body-1'], plane_id: 'plane-yz' }]
];
const request = ([operation, args]) => ({ operation, document_id: DOCUMENT, args: structuredClone(args) });

class FeatureProtocolDouble {
  revision = 1;
  mutations = [];
  failAfterAttempt = false;
  errorAfterAttempt;
  state() { return hash({ protocol_double: true, revision: this.revision }); }
  async dispatch(input) {
    assert.equal(input.document_id, DOCUMENT);
    const state = this.state();
    if (input.expected_state && input.expected_state !== state) return { ok: false, error: { code: 'STALE_STATE', message: 'Synthetic observation changed.', outcome: 'none' } };
    if (input.operation === 'document.inspect') return { ok: true, state, data: { document_id: DOCUMENT, protocol_double: true, live_fusion_verified: false }, effects: [] };
    assert.ok(cases.some(([operation]) => operation === input.operation));
    this.mutations.push(structuredClone(input));
    this.revision++;
    if (this.errorAfterAttempt) throw this.errorAfterAttempt;
    if (this.failAfterAttempt) return { ok: false, error: { code: 'TEST_KERNEL_INTERRUPTED', message: 'Synthetic interruption after dispatch; actual result is unknown.', outcome: 'unknown' } };
    return { ok: true, state: this.state(), data: { protocol_double: true, live_fusion_verified: false, geometry_validated: false }, effects: ['Synthetic protocol revision changed; no Autodesk geometry created.'] };
  }
}

async function setup(t, { provider = new FeatureProtocolDouble(), configure } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fusion-cad-contract-'));
  const raw = fixtureProfile(directory);
  if (configure) configure(raw);
  const profile = parseProfile(raw);
  const engine = new FusionEngine(profile, provider, HANDLER);
  await engine.init();
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, engine, profile, provider };
}

test('new CAD feature schemas expose bounded explicit selections without a generic API argument', () => {
  const catalog = new Map(describeOperations(undefined, true).map(operation => [operation.id, operation]));
  for (const entry of cases) {
    const parsed = parseOperation(request(entry));
    assert.equal(parsed.operation, entry[0]);
    assert.equal(catalog.get(entry[0]).effect, 'local_edit');
    assert.equal(catalog.get(entry[0]).input_schema.additionalProperties, false);
    const missingDocument = request(entry); delete missingDocument.document_id;
    assert.throws(() => parseOperation(missingDocument), { code: 'DOCUMENT_REQUIRED' });
    assert.throws(() => parseOperation({ ...request(entry), document_id: undefined }), { code: 'INVALID_INPUT' });
    assert.throws(() => parseOperation({ ...request(entry), args: { ...entry[1], code: 'arbitrary API code' } }), { code: 'INVALID_INPUT' });
  }
  for (const count of [0, 1, 21]) assert.throws(() => parseOperation({ ...request(cases[2]), args: { ...cases[2][1], profile_ids: Array.from({ length: count }, (_, index) => `profile-${index}`) } }), { code: 'INVALID_INPUT' });
  for (const count of [0, 101]) assert.throws(() => parseOperation({ ...request(cases[1]), args: { ...cases[1][1], path_entity_ids: Array.from({ length: count }, (_, index) => `edge-${index}`) } }), { code: 'INVALID_INPUT' });
  const split = request(cases[4]); delete split.args.extend_tool;
  assert.throws(() => parseOperation(split), { code: 'INVALID_INPUT' });
  for (const flag of ['symmetric', 'direction_flipped', 'tangent_chain']) assert.throws(() => parseOperation({ ...request(cases[3]), args: { ...cases[3][1], [flag]: 'false' } }), { code: 'INVALID_INPUT' });
  assert.throws(() => parseOperation({ ...request(cases[5]), args: { ...cases[5][1], is_combine: true } }), { code: 'INVALID_INPUT' });
});

test('sweep and loft cannot silently widen cut/intersect participation or imply an explicit join target', () => {
  for (const entry of [cases[1], cases[2]]) {
    for (const operation of ['cut', 'intersect']) {
      const input = request(entry); input.args.operation = operation;
      assert.throws(() => parseOperation(input), { code: 'EXPLICIT_PARTICIPANTS_REQUIRED' });
      input.args.participant_body_ids = ['authorized-body'];
      assert.deepEqual(parseOperation(input).args.participant_body_ids, ['authorized-body']);
      input.args.participant_body_ids = [];
      assert.throws(() => parseOperation(input), { code: 'INVALID_INPUT' });
    }
    for (const operation of ['join', 'new_body']) {
      const input = request(entry); Object.assign(input.args, { operation, participant_body_ids: ['not-a-join-selector'] });
      assert.throws(() => parseOperation(input), { code: 'INVALID_INPUT' });
    }
  }
});

test('the real MCP facade preserves explicit feature inputs and rejects malformed drafts before dispatch', async t => {
  const { engine, profile, provider, directory } = await setup(t);
  const server = createFusionServer({ profile, engine, root: directory, close: () => engine.close() });
  const client = new Client({ name: 'cad-feature-contract-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const malformed = request(cases[4]); delete malformed.args.extend_tool;
  const rejected = await client.callTool({ name: 'fusion_changes_prepare', arguments: malformed });
  assert.equal(rejected.isError, true);
  assert.equal(provider.mutations.length, 0);
  for (const entry of cases) {
    const prepared = await client.callTool({ name: 'fusion_changes_prepare', arguments: request(entry) });
    assert.equal(prepared.isError, undefined);
    const plan = prepared.structuredContent;
    assert.deepEqual(JSON.parse(prepared.content.find(item => item.type === 'text').text), plan);
    assert.deepEqual(plan.operation.args, entry[1]);
    assert.deepEqual(plan.provider_args, entry[1]);
    assert.equal(plan.effect, 'local_edit');
    assert.equal(plan.expected_state, provider.state());
  }
  assert.equal(provider.mutations.length, 0, 'Preparing all six plans is not a geometry mutation.');
});

test('adding feature definitions does not expand an existing real-provider operation grant or qualification', async t => {
  const { engine, provider } = await setup(t, { configure: raw => {
    raw.mode = 'managed'; raw.id = 'old-cad-scope-protocol-test';
    raw.policy.operations = ['features.extrude'];
    raw.policy.qualifiedOperations = [];
    raw.policy.grantExpiresAt = new Date(Date.now() + 600_000).toISOString();
  } });
  for (const entry of cases) {
    const plan = await engine.prepare(request(entry));
    assert.equal(plan.policy_decision.authorized, false);
    assert.equal(plan.policy_decision.blocker, 'OPERATION_DENIED');
    await assert.rejects(engine.execute(plan.id, plan.hash, `denied-${entry[0]}`), { code: 'OPERATION_DENIED' });
  }
  assert.equal(provider.mutations.length, 0);
});

test('a feature plan cannot execute after its source observation changes or after its contract changes', async t => {
  const { engine, profile, provider } = await setup(t);
  const stale = await engine.prepare(request(cases[5]));
  provider.revision++;
  await assert.rejects(engine.execute(stale.id, stale.hash, 'stale-mirror-state'), { code: 'STALE_STATE' });
  assert.equal(provider.mutations.length, 0);
  const current = await engine.prepare(request(cases[5]));
  const changedContract = new FusionEngine(profile, provider, hash('different reviewed handler'));
  await assert.rejects(changedContract.execute(current.id, current.hash, 'changed-mirror-contract'), { code: 'PLAN_BINDING_CHANGED' });
  assert.equal(provider.mutations.length, 0);
  const result = await engine.execute(current.id, current.hash, 'exact-mirror-contract');
  assert.equal(result.status, 'succeeded');
  assert.equal(result.result.data.geometry_validated, false);
  assert.deepEqual(provider.mutations[0].args, cases[5][1]);
});

test('new feature calls retain uncertain outcomes across a broker restart without replay', async t => {
  for (const entry of cases) await t.test(entry[0], async t => {
    const { engine, profile, provider } = await setup(t);
    provider.failAfterAttempt = true;
    const plan = await engine.prepare(request(entry));
    const key = `uncertain-${entry[0]}`;
    const first = await engine.execute(plan.id, plan.hash, key);
    assert.equal(first.status, 'outcome_unknown');
    assert.equal(first.result.error.outcome, 'unknown');
    const restarted = new FusionEngine(profile, provider, HANDLER);
    assert.deepEqual(await restarted.execute(plan.id, plan.hash, key), first);
    assert.equal(provider.mutations.length, 1);
  });
});

test('the synthetic bracket never fabricates kernel support for the new CAD operations', async t => {
  const { engine } = await setup(t, { provider: new FixtureDesktopProvider() });
  const before = await engine.read({ operation: 'parameters.list', document_id: DOCUMENT, args: {} });
  for (const entry of cases) {
    const plan = await engine.prepare(request(entry));
    const result = await engine.execute(plan.id, plan.hash, `unsupported-${entry[0]}`);
    assert.equal(result.status, 'failed');
    assert.equal(result.result.error.code, 'FIXTURE_UNSUPPORTED');
    assert.equal(result.result.error.outcome, 'none');
  }
  const after = await engine.read({ operation: 'parameters.list', document_id: DOCUMENT, args: {} });
  assert.deepEqual(after, before);
  assert.equal(after.data.live_fusion_verified, false);
});

test('oversized provider diagnostics preserve durable partial and unknown feature outcomes without replay', async t => {
  for (const outcome of ['partial', 'unknown']) await t.test(outcome, async t => {
    const { engine, profile, provider } = await setup(t);
    let details = { password: 'SYNTHETIC_SECRET' };
    for (let index = 0; index < 31; index++) details = { child: details };
    provider.errorAfterAttempt = new FusionError('SYNTHETIC_POST_ADD_ERROR', 'Synthetic edit was attempted; inspect its result.', outcome, details);
    const plan = await engine.prepare(request(cases[5]));
    const key = `diagnostic-${outcome}`;
    const result = await engine.execute(plan.id, plan.hash, key);
    assert.equal(result.status, outcome === 'unknown' ? 'outcome_unknown' : 'failed');
    assert.equal(result.result.error.code, 'SYNTHETIC_POST_ADD_ERROR');
    assert.equal(result.result.error.outcome, outcome);
    assert.equal(result.result.error.details.diagnostics_omitted, true);
    assert.equal(result.result.dispatched, true);
    assert.notEqual(provider.state(), plan.expected_state);
    assert.deepEqual(await engine.inspectPlan(plan.id), result);
    const audits = (await engine.store.list('audit')).filter(entry => entry.event === 'execution_result');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].details.result.error.outcome, outcome);
    assert.equal(JSON.stringify(audits).includes('SYNTHETIC_SECRET'), false);
    const restarted = new FusionEngine(profile, provider, HANDLER);
    t.after(() => restarted.close());
    assert.deepEqual(await restarted.execute(plan.id, plan.hash, key), result);
    assert.equal(provider.mutations.length, 1);
  });
});
