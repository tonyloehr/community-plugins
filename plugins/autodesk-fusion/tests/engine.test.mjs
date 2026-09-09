import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, symlink, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FusionEngine, FixtureDesktopProvider, RecordStore, fixtureProfile, parseProfile, createFixtureEngine, hash, parseOperation, validateFilename, NativeTokenStore, FusionError } from '../dist/index.mjs';

async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fusion-engine-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const profile = fixtureProfile(directory);
  return { directory, profile, engine: await createFixtureEngine(profile) };
}
const change = expression => ({ operation: 'parameters.set', document_id: 'fixture:bracket', args: { changes: [{ parameter_id: 'fixture:param:width', expression }] } });
const width = async engine => (await engine.read({ operation: 'parameters.list', document_id: 'fixture:bracket', args: {} })).data.parameters.find(p => p.name === 'width').value_mm;

test('prepare is nonmutating; execute changes analytic geometry with explicit units; replay is idempotent', async t => {
  const { engine } = await setup(t);
  const plan = await engine.prepare(change('2 in'));
  assert.equal(await width(engine), 40);
  assert.equal(plan.policy_decision.authorized, true);
  assert.equal(plan.summary.atomicity.includes('modifyParameters'), true);
  const done = await engine.execute(plan.id, plan.hash, 'once-for-inch-width');
  assert.equal(done.status, 'succeeded');
  assert.equal(await width(engine), 50.8);
  const replay = await engine.execute(plan.id, plan.hash, 'once-for-inch-width');
  assert.deepEqual(replay, done);
  const measure = await engine.read({ operation: 'geometry.measure', document_id: 'fixture:bracket', args: { entity_ids: ['fixture:body:bracket'], kind: 'physical' } });
  assert.equal(measure.data.volume.value, 5080);
  assert.equal(measure.data.live_fusion_verified, false);
});

test('invalid second parameter expression leaves the entire batch unchanged', async t => {
  const { engine } = await setup(t);
  const request = change('55 mm'); request.args.changes.push({ parameter_id: 'fixture:param:height', expression: 'not-a-length' });
  const plan = await engine.prepare(request);
  const result = await engine.execute(plan.id, plan.hash, 'atomic-invalid-batch');
  assert.equal(result.status, 'failed'); assert.equal(result.result.error.outcome, 'none'); assert.equal(await width(engine), 40);
});

test('sequential prepared plans reject stale source state and do not alter user edits', async t => {
  const { engine } = await setup(t);
  const first = await engine.prepare(change('45 mm')), second = await engine.prepare(change('60 mm'));
  await engine.execute(first.id, first.hash, 'change-one-key');
  await assert.rejects(engine.execute(second.id, second.hash, 'change-two-key'), { code: 'STALE_STATE' });
  assert.equal(await width(engine), 45);
});

test('two engine instances sharing a ledger cannot both dispatch the same operation', async t => {
  const { engine, profile } = await setup(t);
  const plan = await engine.prepare(change('47 mm'));
  const second = await createFixtureEngine(profile);
  const results = await Promise.allSettled([engine.execute(plan.id, plan.hash, 'concurrent-same-key'), second.execute(plan.id, plan.hash, 'concurrent-same-key')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length >= 1, true);
  for (const r of results) if (r.status === 'rejected') assert.equal(r.reason.code, 'EXECUTION_LOCKED');
  assert.equal(await width(engine), 47);
  assert.equal((await engine.inspectPlan(plan.id)).status, 'succeeded');
});

test('unknown transport outcome is retained across retries and restarts', async t => {
  const { profile } = await setup(t);
  const fixture = new FixtureDesktopProvider(); let writes = 0;
  const provider = { dispatch: async request => {
    if (request.operation === 'parameters.set') { writes++; await fixture.dispatch(request); throw new Error('connection lost after write'); }
    return fixture.dispatch(request);
  } };
  const engine = new FusionEngine(profile, provider, hash('reviewed-handler'));
  const plan = await engine.prepare(change('49 mm'));
  const result = await engine.execute(plan.id, plan.hash, 'unknown-outcome-key');
  assert.equal(result.status, 'outcome_unknown');
  const restarted = new FusionEngine(profile, provider, hash('reviewed-handler'));
  assert.equal((await restarted.execute(plan.id, plan.hash, 'unknown-outcome-key')).status, 'outcome_unknown');
  assert.equal(writes, 1); assert.equal(await width(engine), 49);
});

test('persisted execution intent without receipt is never dispatched after recovery', async t => {
  const { engine } = await setup(t);
  const plan = await engine.prepare(change('46 mm'));
  plan.status = 'executing'; plan.idempotency_key = 'crashed-before-receipt';
  await engine.store.put('plan', plan.id, plan);
  const resumed = await engine.execute(plan.id, plan.hash, 'crashed-before-receipt');
  assert.equal(resumed.status, 'outcome_unknown'); assert.equal(await width(engine), 40);
});

test('changed plan hash, forged approval and arbitrary API envelopes are rejected', async t => {
  const { engine } = await setup(t);
  const plan = await engine.prepare(change('46 mm'));
  await assert.rejects(engine.execute(plan.id, '0'.repeat(64), 'wrong-plan-hash'), { code: 'PLAN_HASH_MISMATCH' });
  assert.throws(() => parseOperation({ ...change('55 mm'), approved: true }), { code: 'INVALID_INPUT' });
  assert.throws(() => parseOperation({ operation: 'execute_python', args: { code: 'print(1)' } }), { code: 'UNSUPPORTED_OPERATION' });
  plan.provider_args.changes[0].expression = '99 mm'; await engine.store.put('plan', plan.id, plan);
  await assert.rejects(engine.inspectPlan(plan.id), { code: 'PLAN_TAMPERED' });
});

test('managed writes require expiring explicit grant and real qualification evidence', async t => {
  const { directory } = await setup(t);
  assert.throws(() => parseProfile({ version: 1, id: 'managed', mode: 'managed', stateRoot: directory, policy: { mutationsEnabled: true, operations: ['*'] } }), { code: 'INVALID_PROFILE' });
  const profile = parseProfile({ version: 1, id: 'managed', mode: 'managed', stateRoot: directory, policy: { mutationsEnabled: true, operations: ['parameters.set'], documents: ['fixture:bracket'], effects: ['local_edit'], grantExpiresAt: new Date(Date.now() + 60_000).toISOString() } });
  const engine = new FusionEngine(profile, new FixtureDesktopProvider(), hash('test'));
  const plan = await engine.prepare(change('33 mm'));
  assert.equal(plan.policy_decision.blocker, 'QUALIFICATION_REQUIRED');
  await assert.rejects(engine.execute(plan.id, plan.hash, 'qualified-grant-key'), { code: 'QUALIFICATION_REQUIRED' });
});

test('profile kill switch and handler drift invalidate already prepared operations', async t => {
  const { directory, profile } = await setup(t);
  const profileFile = path.join(directory, 'profile.json'), handlerFile = path.join(directory, 'handler.py');
  await writeFile(profileFile, JSON.stringify(profile), { mode: 0o600 }); await writeFile(handlerFile, 'reviewed');
  const engine = new FusionEngine(profile, new FixtureDesktopProvider(), (await import('node:crypto')).createHash('sha256').update('reviewed').digest('hex'), { profileFile, handlerFile });
  const plan = await engine.prepare(change('33 mm'));
  await writeFile(profileFile, JSON.stringify({ ...profile, policy: { ...profile.policy, mutationsEnabled: false } }));
  await assert.rejects(engine.execute(plan.id, plan.hash, 'kill-switch-key'), { code: 'PROFILE_CHANGED' });
  await writeFile(profileFile, JSON.stringify(profile)); await writeFile(handlerFile, 'changed');
  await assert.rejects(engine.execute(plan.id, plan.hash, 'kill-switch-key'), { code: 'HANDLER_CHANGED' });
});

test('idempotency keys cannot be reused for a different valid plan', async t => {
  const { engine } = await setup(t); const first = await engine.prepare(change('40 mm'));
  await engine.execute(first.id, first.hash, 'one-business-request');
  const second = await engine.prepare(change('43 mm'));
  await assert.rejects(engine.execute(second.id, second.hash, 'one-business-request'), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('exports have a unique quarantine, manifest hashes and no geometric fidelity claim', async t => {
  const { engine } = await setup(t);
  const plan = await engine.prepare({ operation: 'exports.generate', document_id: 'fixture:bracket', args: { format: 'step', output: { root: 'artifacts', filename: 'synthetic.step' } } });
  const done = await engine.execute(plan.id, plan.hash, 'artifact-candidate-key');
  assert.equal(done.status, 'succeeded');
  const artifact = await engine.artifacts.inspect(plan.artifact.id);
  assert.equal(artifact.files.length, 1); assert.match(artifact.files[0].sha256, /^[a-f0-9]{64}$/); assert.match(artifact.limitation, /geometric fidelity/);
  assert.equal(done.result.data.geometry_validated, false);
  assert.match(await readFile(artifact.path, 'utf8'), /SYNTHETIC/);
});

test('output path traversal, absolute paths, reserved names, symlinks and hardlinks are blocked', async t => {
  for (const filename of ['../part.step', '/tmp/p.step', 'C:\\temp\\part.step', 'NUL.step', 'a..step', 'part.step.']) assert.throws(() => validateFilename(filename), { code: 'UNSAFE_PATH' });
  const { directory, engine } = await setup(t);
  const plan = await engine.prepare({ operation: 'exports.generate', document_id: 'fixture:bracket', args: { format: 'step', output: { root: 'artifacts', filename: 'part.step' } } });
  const staged = await engine.artifacts.stage(plan.artifact);
  const secret = path.join(directory, 'outside.txt'); await writeFile(secret, 'secret');
  try { await symlink(secret, staged.path); } catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Windows symlink privilege unavailable; hardlink covered separately'); return; } throw error; }
  await assert.rejects(engine.artifacts.inspect(plan.artifact.id), { code: 'UNSAFE_ARTIFACT' });
  await rm(staged.path); await link(secret, staged.path);
  await assert.rejects(engine.artifacts.inspect(plan.artifact.id), { code: 'UNSAFE_ARTIFACT' });
});

test('record references cannot read outside their private store', async t => {
  const { engine } = await setup(t);
  await assert.rejects(engine.store.get('plan', '../../outside'), { code: 'INVALID_REFERENCE' });
  await engine.store.put('plan', 'safe', { value: 1 });
  assert.deepEqual(await engine.store.get('plan', 'safe'), { value: 1 });
});

test('OS vault chunk publication is atomic and failed refresh retains the previous grant', async t => {
  const lockRoot = await mkdtemp(path.join(os.tmpdir(), 'fusion-vault-publish-')); t.after(() => rm(lockRoot, { recursive: true, force: true }));
  const values = new Map(); let fail = false;
  const factory = (service, key) => ({ getPassword: async () => values.get(`${service}/${key}`), setPassword: async value => { if (fail && key.endsWith('.1')) throw new FusionError('VAULT_LOCKED', 'locked'); values.set(`${service}/${key}`, value); }, deleteCredential: async () => values.delete(`${service}/${key}`) });
  const vault = new NativeTokenStore('/unused', factory, { lockRoot }), key = hash('scoped-grant');
  const original = { accessToken: 'a'.repeat(2200), refreshToken: 'r', obtainedAt: 1, expiresAt: 100, scopes: ['data:read'], tenantId: 'tenant', issuer: 'https://developer.api.autodesk.com', resource: 'https://developer.api.autodesk.com', grantType: 'authorization_code' };
  await vault.set(key, original); assert.deepEqual(await vault.get(key), original);
  fail = true; await assert.rejects(vault.set(key, { ...original, accessToken: 'b'.repeat(2200) }), { code: 'VAULT_LOCKED' });
  assert.deepEqual(await vault.get(key), original);
  await vault.delete(key); assert.equal(await vault.get(key), null); assert.equal(values.size, 0);
});
