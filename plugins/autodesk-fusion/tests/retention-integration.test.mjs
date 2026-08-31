import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { FixtureDesktopProvider, FusionEngine, createFusionServer, fixtureProfile, hash, hashBytes, parseProfile, verifyRetentionPlan } from '../dist/index.mjs';

function retentionConfiguration() {
  return {
    policy: { version: 1, ownerRef: 'test-owner', policyRef: 'test-only-not-production-retention', periods: { expiredPreparationMs: 0, terminalEvidenceMs: 0, auditMs: 0 } },
    holds: { version: 1, ownerRef: 'test-owner', evidenceRef: 'synthetic-current-holds-review', reviewedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), complete: true, holds: [] }
  };
}
async function setup(t, { configure = true, trustedFile = false, id } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fusion-retention-integration-'));
  const raw = fixtureProfile(path.join(root, 'ledger'));
  raw.policy.planMaxAgeMs = 1000;
  if (configure) raw.retention = retentionConfiguration();
  if (id) raw.id = id;
  const profile = parseProfile(raw), profileFile = path.join(root, 'profile.json');
  if (trustedFile) await writeFile(profileFile, JSON.stringify(profile), { mode: 0o600 });
  // The actual analytic provider is in memory. Retention must never dispatch it.
  const desktop = new FixtureDesktopProvider(), dispatch = desktop.dispatch.bind(desktop), calls = [];
  desktop.dispatch = async request => { calls.push(structuredClone(request)); return dispatch(request); };
  const engine = new FusionEngine(profile, desktop, hash('retention-integration-synthetic-handler'), trustedFile ? { profileFile } : {});
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  return { root, profileFile, profile, engine, calls };
}
async function ledgerBytes(engine) {
  return Object.fromEntries(await Promise.all((await readdir(engine.store.root)).sort().map(async name => [name, hashBytes(await readFile(path.join(engine.store.root, name)))])));
}
function forbidWrites(engine) {
  for (const method of ['init', 'put', 'audit', 'acquireLease']) engine.store[method] = async () => { throw new Error(`Retention unexpectedly called ${method}`); };
}
async function expiredPreparation(t, options) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const context = await setup(t, options);
  const plan = await context.engine.prepare({ operation: 'parameters.set', document_id: 'fixture:bracket', args: { changes: [{ parameter_id: 'fixture:param:width', expression: '5 cm' }] } });
  t.mock.timers.tick(2000);
  context.calls.length = 0;
  return { ...context, plan };
}
async function connect(t, context) {
  const server = createFusionServer({ ...context, root: context.root, close: () => context.engine.close() });
  const client = new Client({ name: 'retention-integration', version: '1.0.0' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right); await client.connect(left);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('retention preserves existing profile defaults and all accepted profile ID lengths', async t => {
  const original = fixtureProfile(path.join(os.tmpdir(), 'fusion-retention-parse-only'));
  assert.equal(Object.hasOwn(parseProfile(original), 'retention'), false);
  assert.equal(hash(parseProfile(original)), hash(original));
  for (const length of [121, 160]) {
    const { engine, calls } = await setup(t, { id: 'p'.repeat(length) });
    const result = await engine.inventoryRetention();
    assert.equal(result.profile_id.length, length);
    assert.equal(result.complete, false);
    assert.equal(calls.length, 0);
  }
  const configured = { ...original, retention: retentionConfiguration() };
  assert.equal(parseProfile(configured).retention.policy.periods.auditMs, 0);
  for (const retention of [
    { ...configured.retention, execute: true },
    { ...configured.retention, policy: { ...configured.retention.policy, periods: { auditMs: -1 } } },
    { ...configured.retention, holds: { ...configured.retention.holds, expiresAt: undefined } }
  ]) assert.throws(() => parseProfile({ ...original, retention }), { code: 'INVALID_PROFILE' });
});

test('retention inventory and rejected selection leave an absent ledger absent', async t => {
  const { engine, calls } = await setup(t, { configure: false });
  forbidWrites(engine);
  const result = await engine.inventoryRetention();
  assert.equal(result.complete, false);
  assert.ok(result.issues.includes('RETENTION_POLICY_MISSING'));
  assert.ok(result.issues.includes('TRUSTED_HOLDS_MISSING'));
  assert.equal(result.provider_state_observed, false);
  assert.equal(result.archive_execution_supported, false);
  assert.equal(result.removal_eligible, false);
  await assert.rejects(engine.prepareRetention({ inventory_hash: result.inventory_hash, record_refs: [`entry:${'a'.repeat(64)}`] }), { code: 'RETENTION_INCOMPLETE' });
  await assert.rejects(lstat(engine.store.root), { code: 'ENOENT' });
  assert.equal(calls.length, 0);
});

test('real prepared-plan and audit records produce a pure copy-review plan after expiry', async t => {
  const { engine, calls, plan } = await expiredPreparation(t);
  const before = await ledgerBytes(engine), rootBefore = await lstat(engine.store.root);
  forbidWrites(engine);
  const inventory = await engine.inventoryRetention();
  assert.equal(inventory.complete, true);
  assert.equal(inventory.counts.archive_review_candidate, 2);
  const entry = inventory.entries.find(item => item.record_id === plan.id);
  const review = await engine.prepareRetention({ inventory_hash: inventory.inventory_hash, record_refs: [entry.record_ref] });
  assert.equal(review.records.length, 2);
  assert.equal(verifyRetentionPlan(review), true);
  assert.equal(review.removal_eligible, false);
  assert.equal(review.archive_execution_supported, false);
  assert.deepEqual(await ledgerBytes(engine), before);
  assert.equal((await lstat(engine.store.root)).mtimeMs, rootBefore.mtimeMs);
  assert.equal(calls.length, 0);
});

test('retention never accepts caller policy, holds release or deletion authority', async t => {
  const { engine, calls, plan } = await expiredPreparation(t);
  const inventory = await engine.inventoryRetention(), record = inventory.entries.find(item => item.record_id === plan.id);
  const selection = { inventory_hash: inventory.inventory_hash, record_refs: [record.record_ref] };
  const before = await ledgerBytes(engine);
  for (const extra of [{ policy: retentionConfiguration().policy }, { holds: { complete: true, holds: [] } }, { release_hold: true }, { execute: true }]) {
    await assert.rejects(engine.prepareRetention({ ...selection, ...extra }), { code: 'INVALID_RETENTION_SELECTION' });
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(await ledgerBytes(engine), before);
});

test('trusted profile changes stop retention before source metadata is returned', async t => {
  const { engine, profile, profileFile, calls } = await expiredPreparation(t, { trustedFile: true });
  const before = await ledgerBytes(engine);
  const changed = structuredClone(profile); changed.retention.holds.evidenceRef = 'changed-trusted-owner-review';
  await writeFile(profileFile, JSON.stringify(changed));
  engine.store.snapshotReadOnly = async () => { throw new Error('Changed profile must reject before local inventory.'); };
  await assert.rejects(engine.inventoryRetention(), { code: 'PROFILE_CHANGED' });
  await assert.rejects(engine.prepareRetention({ inventory_hash: 'b'.repeat(64), record_refs: [`entry:${'a'.repeat(64)}`] }), { code: 'PROFILE_CHANGED' });
  assert.deepEqual(await ledgerBytes(engine), before);
  assert.equal(calls.length, 0);
});

test('trusted policy changes during an inventory are detected without writing a review plan', async t => {
  const { engine, profile, profileFile, calls } = await expiredPreparation(t, { trustedFile: true });
  const before = await ledgerBytes(engine), snapshot = engine.store.snapshotReadOnly.bind(engine.store);
  engine.store.snapshotReadOnly = async options => {
    const result = await snapshot(options), changed = structuredClone(profile);
    changed.retention.holds.evidenceRef = 'changed-during-snapshot';
    await writeFile(profileFile, JSON.stringify(changed));
    return result;
  };
  await assert.rejects(engine.inventoryRetention(), { code: 'PROFILE_CHANGED' });
  assert.deepEqual(await ledgerBytes(engine), before);
  assert.equal(calls.length, 0);
});

test('MCP exposes review-only retention with no model-provided policy or execution switch', async t => {
  const context = await expiredPreparation(t), client = await connect(t, context);
  const before = await ledgerBytes(context.engine);
  forbidWrites(context.engine);
  const tools = (await client.listTools()).tools;
  for (const name of ['fusion_retention_inventory', 'fusion_retention_prepare']) {
    const tool = tools.find(item => item.name === name);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
  }
  const inventory = await client.callTool({ name: 'fusion_retention_inventory', arguments: {} });
  assert.equal(inventory.isError, undefined);
  const record = inventory.structuredContent.entries.find(item => item.record_id === context.plan.id);
  const args = { inventory_hash: inventory.structuredContent.inventory_hash, record_refs: [record.record_ref] };
  const result = await client.callTool({ name: 'fusion_retention_prepare', arguments: args });
  assert.equal(result.isError, undefined);
  assert.equal(verifyRetentionPlan(result.structuredContent), true);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  for (const [name, input] of [
    ['fusion_retention_inventory', { release_holds: true }],
    ['fusion_retention_prepare', { ...args, approved: true }],
    ['fusion_retention_prepare', { ...args, execute: true }]
  ]) assert.equal((await client.callTool({ name, arguments: input })).isError, true);
  assert.deepEqual(await ledgerBytes(context.engine), before);
  assert.equal(context.calls.length, 0);
});
