import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, link, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { RecordStore, RetentionPlanner, HandoffManager, retentionPolicySchema, retentionHoldsSchema, verifyRetentionPlan, verifyManageDraftRecord, manageDraftRecordBinding, hash, hashBytes, cloudHash, newId } from '../dist/index.mjs';

const NOW = '2026-08-31T20:00:00.000Z';
const OLD = '2025-01-01T00:00:00.000Z';
const EXPIRED = '2025-01-01T00:15:00.000Z';
const PROFILE = 'retention-test';
const PROFILE_HASH = 'b'.repeat(64), CONTRACT = 'c'.repeat(64);
function configuration(overrides = {}) {
  return { profileId: PROFILE, profileHash: PROFILE_HASH, executionContractHash: CONTRACT,
    policy: { version: 1, ownerRef: 'test-owner', policyRef: 'test-only-explicit-periods', periods: { expiredPreparationMs: 1000, terminalEvidenceMs: 1000, auditMs: 1000 } },
    holds: { version: 1, ownerRef: 'test-owner', evidenceRef: 'test-holds-snapshot', reviewedAt: '2026-08-31T19:00:00.000Z', expiresAt: '2026-08-31T21:00:00.000Z', complete: true, holds: [] },
    readDocumentIds: ['doc:allowed'], ...overrides };
}
const planner = (store, config = configuration(), options = {}) => new RetentionPlanner(store, config, { now: () => NOW, ...options });
async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fusion-retention-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RecordStore(path.join(root, 'state')); await store.init();
  return { root, store };
}
function preparedPlan(overrides = {}) {
  const expected = hash({ fixture_state: 1 });
  const plan = { id: newId('plan'), hash: '', created_at: OLD, expires_at: EXPIRED,
    operation: { operation: 'parameters.set', document_id: 'doc:allowed', expected_state: expected, args: { changes: [{ parameter_id: 'parameter:width', expression: '5 cm' }] } },
    expected_state: expected, handler_hash: 'a'.repeat(64), profile_hash: PROFILE_HASH, execution_contract_hash: CONTRACT,
    effect: 'local_edit', provider_args: { changes: [{ parameter_id: 'parameter:width', expression: '5 cm' }] },
    before: { name: 'CONFIDENTIAL_ENGINEERING_CANARY', parameters: [{ id: 'parameter:width', expression: '40 mm', value_mm: 40 }] },
    summary: { title: 'Set width', requested: { changes: [{ parameter_id: 'parameter:width', expression: '5 cm' }] } },
    policy_decision: { authorized: true }, status: 'prepared', limitations: ['Synthetic stored record for a local retention test.'], ...overrides };
  plan.hash = hash({ id: plan.id, created_at: plan.created_at, expires_at: plan.expires_at, operation: plan.operation, expected_state: plan.expected_state ?? null, handler_hash: plan.handler_hash, profile_hash: plan.profile_hash, execution_contract_hash: plan.execution_contract_hash ?? null, effect: plan.effect, provider_args: plan.provider_args, artifact: plan.artifact ?? null, before: plan.before, summary: plan.summary, limitations: plan.limitations });
  return plan;
}
async function putPreparation(store, overrides = {}) {
  const plan = preparedPlan(overrides);
  await store.put('plan', plan.id, plan);
  const details = { plan_id: plan.id, hash: plan.hash, operation: plan.operation.operation, effect: plan.effect, source_state: plan.expected_state, policy: plan.policy_decision };
  const audit = { id: newId('event'), event: 'plan_prepared', time: OLD, details, integrity: hash(details) };
  await store.put('audit', audit.id, audit);
  return { plan, audit };
}
async function contents(store) {
  const names = (await readdir(store.root)).sort();
  return Object.fromEntries(await Promise.all(names.map(async name => [name, hashBytes(await readFile(path.join(store.root, name)))])));
}

test('expired unattempted preparation and its audit form a complete immutable copy-review group', async t => {
  const { store } = await workspace(t); const { plan } = await putPreparation(store);
  const before = await contents(store), rootBefore = await lstat(store.root);
  const service = planner(store), inventory = await service.inventory();
  assert.equal(inventory.scope, 'local_ledger_metadata_only');
  assert.equal(inventory.complete, true); assert.equal(inventory.counts.archive_review_candidate, 2);
  const selected = inventory.entries.find(entry => entry.record_id === plan.id);
  const review = await service.prepare({ inventory_hash: inventory.inventory_hash, record_refs: [selected.record_ref] });
  assert.equal(review.records.length, 2); assert.equal(review.selected_record_refs.length, 1);
  assert.ok(review.records.every(record => record.dependencies.length === 1));
  assert.equal(review.archive_execution_supported, false); assert.equal(review.removal_eligible, false);
  assert.equal(verifyRetentionPlan(review), true); assert.equal(Object.isFrozen(review.records[0]), true);
  assert.equal(review.hash, (await service.prepare({ inventory_hash: inventory.inventory_hash, record_refs: [selected.record_ref] })).hash);
  assert.deepEqual(await contents(store), before);
  assert.equal((await lstat(store.root)).mtimeMs, rootBefore.mtimeMs);
  assert.doesNotMatch(JSON.stringify({ inventory, review }), /CONFIDENTIAL_ENGINEERING_CANARY|parameter:width|provider_args|output_path/);
  assert.equal(inventory.provider_state_observed, false);
});

test('retention preserves existing 121–160 character profile IDs and unrestricted read-scope list shapes', async t => {
  const { store } = await workspace(t); await putPreparation(store);
  for (let length = 121; length <= 160; length++) assert.doesNotThrow(() => planner(store, configuration({ profileId: 'p'.repeat(length) })));
  const context = configuration({ profileId: 'p'.repeat(160), readDocumentIds: [...Array(1100).fill('doc:allowed'), 'x'.repeat(3000)] });
  const service = planner(store, context), inventory = await service.inventory();
  assert.equal(inventory.complete, true); assert.equal(inventory.profile_id.length, 160);
  const review = await service.prepare({ inventory_hash: inventory.inventory_hash, record_refs: [inventory.entries[0].record_ref] });
  assert.equal(verifyRetentionPlan(review), true);
});

test('owner policy and a complete fresh holds snapshot are both required, with no default periods', async t => {
  const { store } = await workspace(t); await putPreparation(store);
  for (const [label, patch, reason] of [
    ['missing policy', { policy: undefined }, 'RETENTION_POLICY_MISSING'],
    ['missing holds', { holds: undefined }, 'TRUSTED_HOLDS_MISSING'],
    ['incomplete holds', { holds: { ...configuration().holds, complete: false } }, 'TRUSTED_HOLDS_INCOMPLETE'],
    ['expired holds', { holds: { ...configuration().holds, expiresAt: NOW } }, 'TRUSTED_HOLDS_EXPIRED'],
    ['future holds', { holds: { ...configuration().holds, reviewedAt: '2026-08-31T20:01:00.000Z' } }, 'TRUSTED_HOLDS_FROM_FUTURE']
  ]) await t.test(label, async () => {
    const inventory = await planner(store, configuration(patch)).inventory();
    assert.equal(inventory.complete, false); assert.equal(inventory.counts.archive_review_candidate, 0);
    assert.ok(inventory.issues.includes(reason));
  });
  const inventory = await planner(store, configuration({ policy: { ...configuration().policy, periods: {} } })).inventory();
  assert.equal(inventory.counts.archive_review_candidate, 0);
  assert.ok(inventory.entries.every(entry => entry.reasons.includes('OWNER_PERIOD_MISSING')));
});

test('trusted hold propagates through dependencies; caller input cannot release it', async t => {
  const { store } = await workspace(t); const { plan } = await putPreparation(store);
  const initial = await planner(store).inventory(), ref = initial.entries.find(entry => entry.record_id === plan.id).record_ref;
  const context = configuration(); context.holds.holds = [{ id: 'project-hold', scope: 'records', recordRefs: [ref], reason: 'Test owner hold' }];
  const service = planner(store, context);
  context.holds.holds = [];
  const inventory = await service.inventory();
  assert.equal(inventory.counts.held, 2); assert.equal(inventory.counts.archive_review_candidate, 0);
  await assert.rejects(service.prepare({ inventory_hash: inventory.inventory_hash, record_refs: [ref], release_hold: true }), { code: 'INVALID_RETENTION_SELECTION' });
  await assert.rejects(service.prepare({ inventory_hash: inventory.inventory_hash, record_refs: [ref] }), { code: 'RETENTION_PROTECTED' });
});

test('holds that expire during inventory are not extended by an earlier analysis clock', async t => {
  const { store } = await workspace(t); await putPreparation(store);
  const context = configuration(), initial = await planner(store, context).inventory(), before = await contents(store);
  assert.equal(initial.complete, true);
  let clock = NOW, snapshotObservedAt;
  const reader = { async snapshotReadOnly(options) {
    const snapshot = await store.snapshotReadOnly(options); snapshotObservedAt = snapshot.observed_at;
    clock = context.holds.expiresAt;
    return snapshot;
  } };
  const service = planner(reader, context, { now: () => clock });
  const inventory = await service.inventory();
  assert.equal(inventory.observed_at, snapshotObservedAt); assert.equal(inventory.analyzed_at, context.holds.expiresAt);
  assert.equal(inventory.inventory_hash, initial.inventory_hash); assert.equal(inventory.complete, false);
  assert.equal(inventory.counts.archive_review_candidate, 0); assert.ok(inventory.issues.includes('TRUSTED_HOLDS_EXPIRED'));
  clock = NOW;
  await assert.rejects(service.prepare({ inventory_hash: initial.inventory_hash, record_refs: [initial.entries[0].record_ref] }), { code: 'RETENTION_INCOMPLETE' });
  assert.deepEqual(await contents(store), before);
});

test('unresolved owner hold targets keep the entire analysis incomplete', async t => {
  const { store } = await workspace(t); await putPreparation(store);
  const context = configuration(); context.holds.holds = [{ id: 'unlocated-hold', scope: 'records', recordRefs: [`entry:${'e'.repeat(64)}`], reason: 'Not in observed inventory' }];
  const inventory = await planner(store, context).inventory();
  assert.equal(inventory.complete, false); assert.equal(inventory.counts.archive_review_candidate, 0);
  assert.ok(inventory.issues.includes('TRUSTED_HOLD_TARGET_UNRESOLVED'));
});

test('selection is stale after exact source bytes, policy, or holds change', async t => {
  const { store } = await workspace(t); const { plan } = await putPreparation(store);
  const service = planner(store), first = await service.inventory(), ref = first.entries.find(entry => entry.record_id === plan.id).record_ref;
  const changedPolicy = configuration(); changedPolicy.policy.periods.auditMs = 2000;
  await assert.rejects(planner(store, changedPolicy).prepare({ inventory_hash: first.inventory_hash, record_refs: [ref] }), { code: 'RETENTION_INVENTORY_CHANGED' });
  const changedHolds = configuration(); changedHolds.holds.evidenceRef = 'a-new-owner-observation';
  await assert.rejects(planner(store, changedHolds).prepare({ inventory_hash: first.inventory_hash, record_refs: [ref] }), { code: 'RETENTION_INVENTORY_CHANGED' });
  await store.put('plan', plan.id, { ...plan, status: 'executing', idempotency_key: 'test-execution-key' });
  await assert.rejects(service.prepare({ inventory_hash: first.inventory_hash, record_refs: [ref] }), { code: 'RETENTION_INVENTORY_CHANGED' });
});

test('elapsed owner periods do not make a nonexpired or future preparation eligible', async t => {
  const { store } = await workspace(t); await putPreparation(store, { created_at: '2026-08-31T19:59:00.000Z', expires_at: '2026-08-31T20:15:00.000Z' });
  const inventory = await planner(store).inventory();
  assert.equal(inventory.counts.archive_review_candidate, 0);
  assert.ok(inventory.entries.some(entry => entry.reasons.includes('PREPARATION_NOT_EXPIRED')));
});

test('successful, failed partial and unknown plans retain their replay fences and truthful outcomes', async t => {
  for (const [status, result] of [
    ['succeeded', { effect_committed: true, completion: 'provider_completed', data: { changed: true } }],
    ['failed', { error: { code: 'PARTIAL_EDIT', message: 'Test partial edit', outcome: 'partial' }, completion: 'unknown_or_failed' }],
    ['outcome_unknown', { error: { code: 'UNKNOWN_EDIT', message: 'Test unknown effect', outcome: 'unknown' } }]
  ]) await t.test(status, async t => {
    const { store } = await workspace(t), key = 'one-test-attempt';
    const { plan } = await putPreparation(store, { status, result, idempotency_key: key });
    await store.put('idempotency', hash({ profile: PROFILE, key }), { plan_id: plan.id, hash: plan.hash });
    const before = await contents(store), inventory = await planner(store).inventory();
    assert.equal(inventory.counts.archive_review_candidate, 0);
    assert.equal(inventory.counts.protected, 3);
    assert.ok(inventory.entries.some(entry => entry.reasons.includes('REPLAY_FENCE_REQUIRES_LIVE_LEDGER')));
    if (status === 'succeeded') assert.ok(inventory.entries.some(entry => entry.reasons.includes('TERMINAL_TIMESTAMP_UNAVAILABLE')));
    assert.deepEqual(await contents(store), before);
  });
});

test('a pre-intent crash cannot turn an expired prepared plan with a replay receipt into a candidate', async t => {
  const { store } = await workspace(t); const { plan } = await putPreparation(store);
  await store.put('idempotency', hash({ profile: PROFILE, key: 'persisted-before-intent' }), { plan_id: plan.id, hash: plan.hash });
  const inventory = await planner(store).inventory();
  assert.equal(inventory.counts.archive_review_candidate, 0);
  assert.ok(inventory.entries.every(entry => entry.decision === 'protected'));
});

test('created-document authority pins a producer and its related audit', async t => {
  const { store } = await workspace(t); const { plan } = await putPreparation(store);
  await store.put('createddoc', hash('doc:allowed'), { document_id: 'doc:allowed', profile_hash: PROFILE_HASH, handler_hash: 'a'.repeat(64), execution_contract_hash: CONTRACT, plan_id: plan.id, plan_hash: plan.hash, created_at: OLD });
  const inventory = await planner(store).inventory();
  assert.equal(inventory.counts.archive_review_candidate, 0);
  assert.ok(inventory.entries.some(entry => entry.reasons.includes('CREATED_DOCUMENT_AUTHORITY_REQUIRES_LIVE_LEDGER')));
});

test('cached records outside the document read scope expose only opaque protected entries', async t => {
  const { store } = await workspace(t); const plan = preparedPlan();
  plan.operation.document_id = 'doc:OUT_OF_SCOPE_SOURCE_CANARY';
  const rebound = preparedPlan({ ...plan }); await store.put('plan', rebound.id, rebound);
  const inventory = await planner(store).inventory();
  assert.equal(inventory.entries[0].record_kind, 'restricted');
  assert.equal(inventory.entries[0].record_id, undefined); assert.equal(inventory.entries[0].sha256, undefined);
  assert.doesNotMatch(JSON.stringify(inventory), /OUT_OF_SCOPE_SOURCE_CANARY|CONFIDENTIAL_ENGINEERING_CANARY/);
  assert.equal(inventory.counts.archive_review_candidate, 0);
});

test('unknown payloads, native subtrees and credential fences are never returned or followed', async t => {
  const { root, store } = await workspace(t); await putPreparation(store);
  await mkdir(path.join(store.root, 'credential-locks'), { mode: 0o700 });
  await mkdir(path.join(store.root, 'credential-locks', 'DO_NOT_ENUMERATE_GRANT_CANARY'), { mode: 0o700 });
  await writeFile(path.join(store.root, 'credential-locks', 'DO_NOT_ENUMERATE_GRANT_CANARY', 'secret.json'), 'CREDENTIAL_PAYLOAD_CANARY', { mode: 0o600 });
  await mkdir(path.join(store.root, 'native-private-canary'), { mode: 0o700 });
  await writeFile(path.join(store.root, 'unknown--UNKNOWN_FILENAME_CANARY.json'), 'UNKNOWN_PAYLOAD_CANARY', { mode: 0o600 });
  await writeFile(path.join(store.root, 'refresh--intent.json'), 'CREDENTIAL_FENCE_CANARY not JSON', { mode: 0o600 });
  const snapshot = await store.snapshotReadOnly({ readKinds: ['plan', 'audit', 'refresh'] });
  assert.ok(snapshot.entries.filter(entry => entry.status !== 'read').every(entry => entry.value === undefined));
  const inventory = await planner(store).inventory();
  assert.equal(inventory.complete, false); assert.equal(inventory.counts.archive_review_candidate, 0);
  assert.doesNotMatch(JSON.stringify(inventory), /CREDENTIAL_PAYLOAD_CANARY|CREDENTIAL_FENCE_CANARY|UNKNOWN_PAYLOAD_CANARY|UNKNOWN_FILENAME_CANARY|DO_NOT_ENUMERATE_GRANT_CANARY|native-private-canary/);
  assert.equal(await readFile(path.join(store.root, 'refresh--intent.json'), 'utf8'), 'CREDENTIAL_FENCE_CANARY not JSON');
  const missing = new RecordStore(path.join(root, 'never-created'));
  const absent = await planner(missing).inventory();
  assert.equal(absent.complete, false); assert.equal(absent.total_entry_count, null);
  await assert.rejects(lstat(missing.root), { code: 'ENOENT' });
});

test('unsafe file aliases remain unknown and do not trigger an external read', { skip: process.platform === 'win32' }, async t => {
  const { root, store } = await workspace(t), planId = newId('plan');
  const outside = path.join(root, 'outside.json'); await writeFile(outside, 'OUTSIDE_CANARY', { mode: 0o600 });
  await symlink(outside, path.join(store.root, `plan--${planId}.json`));
  await link(outside, path.join(store.root, `audit--${newId('event')}.json`));
  const inventory = await planner(store).inventory();
  assert.equal(inventory.complete, false); assert.equal(inventory.counts.archive_review_candidate, 0);
  assert.ok(inventory.entries.every(entry => entry.decision === 'unknown'));
  assert.doesNotMatch(JSON.stringify(inventory), /OUTSIDE_CANARY/);
});

test('private inventory does not repair permissions or treat a shared root as empty', { skip: process.platform === 'win32' }, async t => {
  const { store } = await workspace(t); await chmod(store.root, 0o755);
  const inventory = await planner(store).inventory();
  assert.equal(inventory.complete, false); assert.equal(inventory.total_entry_count, null);
  assert.equal((await lstat(store.root)).mode & 0o777, 0o755);
});

test('entry, byte, malformed-JSON and writer-lock limits remain visible and block candidates', async t => {
  const { store } = await workspace(t); await putPreparation(store);
  const limited = await planner(store, configuration(), { snapshotLimits: { maxEntries: 1 } }).inventory();
  assert.equal(limited.complete, false); assert.equal(limited.total_entry_count, null); assert.equal(limited.entry_count_lower_bound, 2);
  assert.equal(limited.counts.archive_review_candidate, 0);
  const bytes = await planner(store, configuration(), { snapshotLimits: { maxTotalBytes: 1 } }).inventory();
  assert.equal(bytes.complete, false); assert.ok(bytes.issues.includes('SNAPSHOT_BYTE_LIMIT'));
  await writeFile(path.join(store.root, `plan--${newId('plan')}.json`), '{ broken record', { mode: 0o600 });
  const corrupt = await planner(store).inventory(); assert.equal(corrupt.complete, false); assert.ok(corrupt.issues.includes('INVALID_RECORD_JSON'));
  await writeFile(path.join(store.root, '.execution.lock'), '{ not a trustworthy PID }', { mode: 0o600 });
  const locked = await planner(store).inventory(); assert.ok(locked.issues.includes('EXECUTION_LOCK_PRESENT'));
  assert.equal(locked.counts.archive_review_candidate, 0);
});

test('a reported concurrent-snapshot change remains incomplete, even with recognizable expired records', async t => {
  const { store } = await workspace(t); await putPreparation(store);
  const reader = { async snapshotReadOnly(options) { const snapshot = await store.snapshotReadOnly(options); return { ...snapshot, complete: false, issues: [...snapshot.issues, 'SNAPSHOT_RECORD_CHANGED'] }; } };
  const inventory = await planner(reader).inventory();
  assert.equal(inventory.complete, false); assert.equal(inventory.counts.archive_review_candidate, 0);
});

test('snapshot detects a test-owned record replacement between stat and open', async t => {
  const { store } = await workspace(t); const { plan } = await putPreparation(store);
  const target = path.join(store.root, `plan--${plan.id}.json`), originalBytes = await readFile(target);
  const originalOpen = fs.open; let changed = false;
  fs.open = async (...args) => {
    if (!changed && args[0] === target) { changed = true; await writeFile(target, Buffer.concat([originalBytes, Buffer.from(' ')]), { mode: 0o600 }); }
    return originalOpen(...args);
  };
  syncBuiltinESMExports();
  try {
    const inventory = await planner(store).inventory();
    assert.equal(changed, true); assert.equal(inventory.complete, false); assert.equal(inventory.counts.archive_review_candidate, 0);
    assert.ok(inventory.issues.includes('RECORD_UNAVAILABLE_UNSAFE_OR_CHANGED'));
  } finally { fs.open = originalOpen; syncBuiltinESMExports(); }
});

test('snapshot reports unrepresented entries when membership changes during enumeration', async t => {
  const { store } = await workspace(t); await putPreparation(store);
  const originalOpenDir = fs.opendir; let calls = 0;
  fs.opendir = async (...args) => {
    if (args[0] === store.root && ++calls === 2) await writeFile(path.join(store.root, 'new-unread-entry'), 'PRIVATE_NEW_ENTRY_CANARY', { mode: 0o600 });
    return originalOpenDir(...args);
  };
  syncBuiltinESMExports();
  try {
    const inventory = await planner(store).inventory();
    assert.equal(calls, 2); assert.equal(inventory.complete, false); assert.equal(inventory.total_entry_count, null);
    assert.equal(inventory.entry_count_lower_bound, 3); assert.equal(inventory.unrepresented_entry_count_lower_bound, 1);
    assert.equal(inventory.counts.archive_review_candidate, 0);
    assert.doesNotMatch(JSON.stringify(inventory), /PRIVATE_NEW_ENTRY_CANARY/);
  } finally { fs.opendir = originalOpenDir; syncBuiltinESMExports(); }
});

test('a membership change just after the final enumeration cannot retain an exact count', async t => {
  const { store } = await workspace(t); await putPreparation(store);
  const originalOpenDir = fs.opendir; let calls = 0, changed = false;
  fs.opendir = async (...args) => {
    const directory = await originalOpenDir(...args);
    if (args[0] !== store.root || ++calls !== 2) return directory;
    return { async *[Symbol.asyncIterator]() {
      for await (const entry of directory) yield entry;
      await writeFile(path.join(store.root, 'entry-created-after-enumeration'), 'PRIVATE_LATE_ENTRY_CANARY', { mode: 0o600 }); changed = true;
    } };
  };
  syncBuiltinESMExports();
  try {
    const inventory = await planner(store).inventory();
    assert.equal(changed, true); assert.equal(inventory.complete, false); assert.equal(inventory.total_entry_count, null);
    assert.equal(inventory.entry_count_lower_bound, 2); assert.equal(inventory.counts.archive_review_candidate, 0);
    assert.ok(inventory.issues.includes('SNAPSHOT_ROOT_CHANGED'));
    assert.doesNotMatch(JSON.stringify(inventory), /PRIVATE_LATE_ENTRY_CANARY/);
  } finally { fs.opendir = originalOpenDir; syncBuiltinESMExports(); }
});

test('missing and hash-inconsistent dependencies do not produce a partial safe selection', async t => {
  const { store } = await workspace(t); const { audit } = await putPreparation(store);
  const missing = { ...audit, id: newId('event'), details: { plan_id: newId('plan'), hash: 'd'.repeat(64) } };
  missing.integrity = hash(missing.details); await store.put('audit', missing.id, missing);
  const inventory = await planner(store).inventory();
  assert.equal(inventory.complete, false); assert.equal(inventory.counts.archive_review_candidate, 0);
  assert.ok(inventory.entries.some(entry => entry.reasons.includes('MISSING_DEPENDENCY')));
});

test('strict trusted schemas reject releases, nonfinite or negative periods, invalid dates and duplicate holds', () => {
  assert.equal(retentionPolicySchema.safeParse({ ...configuration().policy, approved: true }).success, false);
  for (const value of [-1, Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(retentionPolicySchema.safeParse({ ...configuration().policy, periods: { auditMs: value } }).success, false);
  assert.equal(retentionHoldsSchema.safeParse({ ...configuration().holds, release_all: true }).success, false);
  assert.equal(retentionHoldsSchema.safeParse({ ...configuration().holds, expiresAt: undefined }).success, false);
  assert.equal(retentionHoldsSchema.safeParse({ ...configuration().holds, reviewedAt: '2026-02-30T00:00:00.000Z' }).success, false);
  const hold = { id: 'held', scope: 'profile', reason: 'Trusted test hold' };
  assert.equal(retentionHoldsSchema.safeParse({ ...configuration().holds, holds: [hold, hold] }).success, false);
});

test('changed or structurally forged immutable plans fail validation', async t => {
  const { store } = await workspace(t); await putPreparation(store);
  const service = planner(store), inventory = await service.inventory();
  const plan = await service.prepare({ inventory_hash: inventory.inventory_hash, record_refs: [inventory.entries[0].record_ref] });
  assert.equal(verifyRetentionPlan({ ...plan, removal_eligible: true }), false);
  const changed = structuredClone(plan); changed.records[0].sha256 = 'f'.repeat(64);
  assert.equal(verifyRetentionPlan(changed), false);
  const forged = { schema_version: 1, kind: 'retention_archive_copy_review', status: 'review_only', archive_execution_supported: false, removal_eligible: false, execute: true };
  const digest = hash(forged);
  assert.equal(verifyRetentionPlan({ ...forged, id: `retention_${digest}`, hash: digest }), false);
});

test('unknown future handoff and batch/retention schemas stay protected with explicit incomplete dependencies', async t => {
  for (const kind of ['handoff', 'batch_plan', 'retention_inventory']) await t.test(kind, async t => {
    const { store } = await workspace(t); await putPreparation(store);
    await store.put(kind, newId(kind), { schema_version: 3, status: 'succeeded', terminal: true, released: true, content: 'FUTURE_PAYLOAD_CANARY' });
    const inventory = await planner(store).inventory();
    assert.equal(inventory.complete, false); assert.equal(inventory.counts.archive_review_candidate, 0);
    assert.ok(inventory.issues.includes('DEPENDENCY_COVERAGE_INCOMPLETE'));
    assert.doesNotMatch(JSON.stringify(inventory), /FUTURE_PAYLOAD_CANARY/);
  });
});

test('a current v2 handoff pins source plans without being mistaken for an unknown schema', async t => {
  const { store } = await workspace(t); const { plan } = await putPreparation(store);
  const manager = new HandoffManager(store, {
    profileId: PROFILE, profileHash: PROFILE_HASH, handlerHash: 'a'.repeat(64), executionContractHash: CONTRACT,
    verifyAccess: async () => {}, authorizeDocument: async id => assert.equal(id, 'doc:allowed'),
    inspectPlan: async id => { assert.equal(id, plan.id); return plan; },
    read: async request => ({ operation: request.operation, document_id: request.document_id, data: { document_id: request.document_id, name: 'PRIVATE_HANDOFF_SOURCE_CANARY', units: { length: 'mm' }, provider: 'synthetic_fixture', live_fusion_verified: false }, state: plan.expected_state, evidence: 'synthetic_fixture', effects: [] }),
    inspectArtifact: async () => { throw new Error('No artifact was selected in this test.'); }
  });
  const handoff = await manager.prepare({ title: 'PRIVATE_HANDOFF_TITLE_CANARY', plan_ids: [plan.id] });
  assert.equal(handoff.schema_version, 2);
  const before = await contents(store), inventory = await planner(store).inventory();
  assert.equal(inventory.complete, true); assert.equal(inventory.counts.protected, 3); assert.equal(inventory.counts.archive_review_candidate, 0);
  assert.ok(inventory.entries.find(entry => entry.record_id === handoff.id).reasons.includes('DRAFT_HANDOFF_REQUIRES_REVIEW'));
  assert.doesNotMatch(JSON.stringify(inventory), /PRIVATE_HANDOFF_SOURCE_CANARY|PRIVATE_HANDOFF_TITLE_CANARY/);
  assert.deepEqual(await contents(store), before);
});

test('artifact v1/v2 metadata binds its declared version without opening outputs or upgrading grades', async t => {
  for (const version of [1, 2]) await t.test(`version ${version}`, async t => {
    const { store } = await workspace(t), artifactId = newId('artifact');
    const reservation = { id: artifactId, root: 'test-outputs', filename: 'capture.png', format: 'png', directory: `/not-an-authorized-retention-path/${artifactId}`, path: `/not-an-authorized-retention-path/${artifactId}/capture.png`, status: 'prepared', created_at: OLD, ...(version === 2 ? { manifest_version: 2 } : {}) };
    const expected = hash({ fixture_state: 1 }), args = { output: { root: 'test-outputs', filename: 'capture.png' }, width: 108, height: 108, fit: false };
    const plan = preparedPlan({ artifact: reservation, operation: { operation: 'view.capture', document_id: 'doc:allowed', expected_state: expected, args }, effect: 'local_artifact', provider_args: { ...args, output_path: reservation.path }, status: 'succeeded', result: { effect_committed: true, completion: 'provider_completed', data: { provider: 'synthetic_fixture', live_fusion_verified: false } } });
    await store.put('plan', plan.id, plan);
    const validation = { validator: 'png_container_v1', width: 108, height: 108, chunk_count: 3, requested_dimensions: { width: 108, height: 108 }, dimensions_match_request: true, pixel_data_decoded: false, animation_chunks_present: false, scope: 'Stored test fixture grade; retention does not rerun this validator.' };
    const artifact = { ...reservation, plan_id: plan.id, status: 'succeeded', producer_plan_hash: plan.hash, completed_at: EXPIRED, files: [{ name: 'capture.png', size: 100, sha256: '9'.repeat(64), media_type: 'image/png', checks: ['regular_file', 'sha256'], ...(version === 2 ? { validation } : {}) }], ...(version === 2 ? { provenance: { schema: 1, producer: { plan_id: plan.id, plan_hash: plan.hash, independently_verified: false }, source: { document_id: 'doc:allowed' } }, limitation: 'Synthetic metadata fixture, not observed artifact bytes.' } : {}) };
    const bound = { version, id: artifact.id, root: artifact.root, filename: artifact.filename, format: artifact.format, plan_id: artifact.plan_id, producer_plan_hash: artifact.producer_plan_hash, completed_at: artifact.completed_at, files: artifact.files, ...(version === 2 ? { provenance: artifact.provenance, limitation: artifact.limitation } : {}) };
    artifact.manifest_sha256 = hash(bound); await store.put('artifact', artifact.id, artifact);
    const before = await contents(store), inventory = await planner(store).inventory();
    assert.equal(inventory.complete, true); assert.equal(inventory.counts.unknown, 0); assert.equal(inventory.counts.archive_review_candidate, 0);
    assert.equal(inventory.entries.find(entry => entry.record_id === artifact.id).terminal, true);
    assert.deepEqual(await contents(store), before);
    assert.doesNotMatch(JSON.stringify(inventory), /not-an-authorized-retention-path|Stored test fixture grade/);
    const stored = await store.get('artifact', artifact.id);
    assert.deepEqual(stored.files[0].validation, version === 2 ? validation : undefined);
  });
});

function cloudJob({ submitted = true, settled = false, batch, inputs = { width: 2 } } = {}) {
  const preparedFields = { id: newId('request'), recipeId: 'approved-test-recipe', recipeVersion: '1', recipeHash: 'd'.repeat(64), inputs, context: { tenantId: 'test-tenant', sources: [], destinationAlias: 'test-staging', variantCount: 1 }, activity: { reference: 'owner.activity+approved', version: 1, engine: 'Autodesk.Fusion+test', definitionHash: 'e'.repeat(64), bundles: [], observedAt: OLD, rollingEngine: false, aliasRacePossible: false }, destination: { kind: 'object_storage', alias: 'test-staging' }, reservation: { amount: 5, currency: 'test-unit', kind: 'estimated', hardCap: false }, createdAt: OLD, expiresAt: EXPIRED, warnings: [] };
  const prepared = { ...preparedFields, requestHash: cloudHash(preparedFields) };
  const job = { id: newId('cloudjob'), prepared, plan_hash: '', profile_hash: PROFILE_HASH, scope_hash: '1'.repeat(64), authorization_binding: '2'.repeat(64), profile_id: PROFILE, status: submitted ? 'failed' : 'prepared', created_at: OLD, updated_at: EXPIRED, reserved_units: submitted && !settled ? 5 : 0, budget_period: 'current-test-budget-period', submitted, ...(batch ? { batch } : {}), ...(submitted ? { provider_id: 'test-provider-workitem' } : {}) };
  job.plan_hash = hash({ id: job.id, created_at: job.created_at, prepared, profile: job.profile_hash, scope: job.scope_hash, authorization: job.authorization_binding, profile_id: job.profile_id, budget_period: job.budget_period, ...(batch ? { batch } : {}) });
  if (settled) { const receipt = { job_id: job.id, provider_id: job.provider_id, request_hash: prepared.requestHash, currency: 'test-unit', actual_amount: 0, observed_at: EXPIRED, evidence_ref: 'test-invoice', source: 'enterprise_billing_reconciliation', final: true }; job.settlement = { ...receipt, receipt_hash: hash(receipt) }; }
  return job;
}

test('terminal cloud jobs retain unsettled exposure and settled current-period accounting', async t => {
  const { store } = await workspace(t);
  for (const settled of [false, true]) { const job = cloudJob({ settled }); await store.put('cloudjob', job.id, job); }
  const before = await contents(store), inventory = await planner(store, configuration({ readDocumentIds: undefined })).inventory();
  assert.equal(inventory.complete, true); assert.equal(inventory.counts.protected, 2); assert.equal(inventory.counts.archive_review_candidate, 0);
  assert.ok(inventory.entries.every(entry => entry.reasons.includes('CLOUD_ACCOUNTING_AND_OWNERSHIP_REQUIRES_LIVE_LEDGER')));
  assert.equal(inventory.entries.filter(entry => entry.reasons.includes('UNSETTLED_CLOUD_EXPOSURE')).length, 1);
  assert.deepEqual(await contents(store), before);
});

function batchManifest(phase = 'ready', widths = [2]) {
  const request = { recipe_id: 'approved-test-recipe', context: { tenantId: 'test-tenant', sources: [], destinationAlias: 'test-staging' }, variants: widths.map(width => ({ variant_id: `width-${width}`, inputs: { width } })) };
  const requestHash = hash(request), requestKeyHash = hash('owner-selected-test-batch-key');
  const id = `cloudbatch_${hash({ profile_id: PROFILE, request_key_hash: requestKeyHash })}`;
  const jobs = request.variants.map(variant => cloudJob({ submitted: false, batch: { batch_id: id, variant_id: variant.variant_id, request_hash: requestHash }, inputs: variant.inputs }));
  const variants = jobs.map((job, index) => ({ variant_id: request.variants[index].variant_id, idempotency_key: `batch:${hash({ batch_id: id, variant_id: request.variants[index].variant_id })}`, initial_job: job }));
  const job = jobs[0];
  const content = { schema_version: 1, id, request_hash: requestHash, request_key_hash: requestKeyHash, request, created_at: OLD, expires_at: EXPIRED, profile_id: PROFILE, profile_hash: PROFILE_HASH, scope_hash: job.scope_hash, authorization_binding: job.authorization_binding, budget_period: job.budget_period, currency: 'test-unit', estimated_reservation: 5 * jobs.length, variants };
  return { batch: { ...content, phase, plan_hash: hash(content) }, job, variant: variants[0], jobs, variants };
}

async function conflictedBatch(store) {
  const { batch, jobs: initialJobs, variants } = batchManifest('ready', [2, 3]);
  const jobs = initialJobs.map((initial, index) => ({ ...structuredClone(initial), submitted: true, reserved_units: 5, provider_id: `test-provider-${index}`, status: 'failed', error: { code: 'OUTPUT_IDENTITY_CONFLICT', message: 'PRIVATE_CONFLICT_DIAGNOSTIC', outcome: 'partial' } }));
  const receipts = jobs.map(job => ({ job_id: job.id, provider_id: job.provider_id, request_hash: job.prepared.requestHash, recipe_hash: job.prepared.recipeHash, observed_at: EXPIRED, artifacts: [{ artifact_id: 'private-retention-output-identity', sha256: '8'.repeat(64), bytes: 16 }], checks: [{ validator_id: 'test-validator', outcome: 'passed', evidence_ref: 'private-validator-receipt' }] }));
  jobs[0].validation = { ...receipts[0], receipt_hash: hash(receipts[0]) };
  const content = { schema_version: 1, id: batch.id, batch_id: batch.id, batch_plan_hash: batch.plan_hash, request_hash: batch.request_hash, detected_at: EXPIRED, trigger_job_id: jobs[1].id, code: 'OUTPUT_IDENTITY_CONFLICT', source: 'trusted_output_validator', resolution: 'blocked_no_reconciliation_api', candidate_receipt_sha256: hash(receipts[1]), conflicts: [{ artifact_id: 'private-retention-output-identity', job_ids: jobs.map(job => job.id) }], job_bindings: jobs.map((job, index) => ({ job_id: job.id, plan_hash: job.plan_hash, validation_receipt_sha256: hash(receipts[index]) })) };
  const conflict = { ...content, receipt_hash: hash(content) };
  await store.put('cloudbatch', batch.id, batch); await store.put('cloudbatchconflict', batch.id, conflict);
  for (const [index, job] of jobs.entries()) {
    job.output_identity_conflict = { batch_id: batch.id, receipt_hash: conflict.receipt_hash, disposition: 'historical_validation_unusable' }; job.validation_usable = false;
    await store.put('cloudjob', job.id, job);
    await store.put('idempotency', hash({ cloud: PROFILE, key: variants[index].idempotency_key }), { job_id: job.id, plan_hash: job.plan_hash });
  }
  const details = { batch_id: batch.id, batch_plan_hash: batch.plan_hash, conflict_receipt_hash: conflict.receipt_hash, job_ids: jobs.map(job => job.id) };
  const audit = { id: newId('event'), event: 'cloud_batch_output_conflict', time: EXPIRED, details, integrity: hash(details) }; await store.put('audit', audit.id, audit);
  return { batch, jobs, conflict, audit };
}

test('a durable batch conflict pins all children, replay fences and audit without reusing historical validation', async t => {
  const { store } = await workspace(t), { batch, jobs, conflict } = await conflictedBatch(store);
  const before = await contents(store), service = planner(store, configuration({ readDocumentIds: undefined })), inventory = await service.inventory();
  assert.equal(inventory.complete, true); assert.equal(inventory.counts.protected, 7); assert.equal(inventory.counts.archive_review_candidate, 0);
  const fence = inventory.entries.find(entry => entry.record_kind === 'cloudbatchconflict');
  assert.equal(fence.record_id, batch.id); assert.ok(fence.reasons.includes('OUTPUT_IDENTITY_CONFLICT_FENCE')); assert.ok(fence.dependency_count >= 3);
  assert.ok(jobs.every(job => inventory.entries.find(entry => entry.record_id === job.id).reasons.includes('HISTORICAL_OUTPUT_VALIDATION_UNUSABLE')));
  await assert.rejects(service.prepare({ inventory_hash: inventory.inventory_hash, record_refs: [fence.record_ref] }), { code: 'RETENTION_PROTECTED' });
  assert.doesNotMatch(JSON.stringify(inventory), /PRIVATE_CONFLICT_DIAGNOSTIC|private-retention-output-identity|private-validator-receipt|validation_usable/);
  assert.equal((await store.get('cloudbatchconflict', batch.id)).receipt_hash, conflict.receipt_hash);
  assert.deepEqual(await contents(store), before);
});

test('missing or changed conflict evidence makes dependency coverage incomplete', async t => {
  for (const mode of ['missing fence', 'changed child binding', 'wrong job receipt']) await t.test(mode, async t => {
    const { store } = await workspace(t), { batch, jobs, conflict } = await conflictedBatch(store);
    if (mode === 'missing fence') await rm(path.join(store.root, `cloudbatchconflict--${batch.id}.json`));
    else if (mode === 'changed child binding') {
      conflict.job_bindings[0].plan_hash = 'f'.repeat(64);
      const { receipt_hash: _receipt, ...content } = conflict; conflict.receipt_hash = hash(content);
      await store.put('cloudbatchconflict', batch.id, conflict);
    } else {
      jobs[0].output_identity_conflict.receipt_hash = 'f'.repeat(64); await store.put('cloudjob', jobs[0].id, jobs[0]);
    }
    const before = await contents(store), inventory = await planner(store, configuration({ readDocumentIds: undefined })).inventory();
    assert.equal(inventory.complete, false); assert.equal(inventory.dependency_coverage_complete, false); assert.equal(inventory.counts.archive_review_candidate, 0);
    assert.deepEqual(await contents(store), before);
  });
});

test('an interrupted batch validation remains explicit protected uncertainty, never a completed or released receipt', async t => {
  const { store } = await workspace(t), { batch, job: initial, variant } = batchManifest();
  const job = { ...structuredClone(initial), submitted: true, reserved_units: 5, provider_id: 'test-provider-workitem', status: 'validating' };
  job.validation_in_progress = { attempt_id: newId('validation'), started_at: EXPIRED, job_id: job.id, batch_id: batch.id, request_hash: job.prepared.requestHash };
  await store.put('cloudbatch', batch.id, batch); await store.put('cloudjob', job.id, job);
  await store.put('idempotency', hash({ cloud: PROFILE, key: variant.idempotency_key }), { job_id: job.id, plan_hash: job.plan_hash });
  const before = await contents(store), inventory = await planner(store, configuration({ readDocumentIds: undefined })).inventory();
  assert.equal(inventory.complete, true); assert.equal(inventory.counts.protected, 3);
  assert.ok(inventory.entries.find(entry => entry.record_id === job.id).reasons.includes('CLOUD_VALIDATION_OUTCOME_UNRESOLVED'));
  assert.deepEqual(await contents(store), before);
  job.validation_in_progress.request_hash = 'f'.repeat(64); await store.put('cloudjob', job.id, job);
  const changed = await planner(store, configuration({ readDocumentIds: undefined })).inventory();
  assert.equal(changed.complete, false); assert.equal(changed.counts.archive_review_candidate, 0);
});

test('batch manifest, child and replay record form one protected group', async t => {
  const { store } = await workspace(t), { batch, job, variant } = batchManifest();
  await store.put('cloudbatch', batch.id, batch); await store.put('cloudjob', job.id, job);
  await store.put('idempotency', hash({ cloud: PROFILE, key: variant.idempotency_key }), { job_id: job.id, plan_hash: job.plan_hash });
  const inventory = await planner(store, configuration({ readDocumentIds: undefined })).inventory();
  assert.equal(inventory.complete, true); assert.equal(inventory.counts.protected, 3);
  assert.ok(inventory.entries.every(entry => entry.dependency_count > 0));
  assert.equal(inventory.counts.archive_review_candidate, 0);
});

test('batch audit bindings reject changed hashes and references even with recomputed audit integrity', async t => {
  for (const [event, patch, reason] of [
    ['cloud_batch_prepared', { plan_hash: 'f'.repeat(64) }, 'DEPENDENCY_HASH_MISMATCH'],
    ['cloud_batch_ready', { plan_hash: 'f'.repeat(64) }, 'DEPENDENCY_HASH_MISMATCH'],
    ['cloud_batch_resume', { plan_hash: 'f'.repeat(64) }, 'DEPENDENCY_HASH_MISMATCH'],
    ['cloud_batch_ready', { plan_hash: undefined }, 'MALFORMED_OR_CHANGED_RECORD'],
    ['cloud_batch_prepared', { request_hash: 'f'.repeat(64) }, 'MALFORMED_OR_CHANGED_RECORD'],
    ['cloud_batch_ready', { job_ids: [newId('cloudjob')] }, 'MALFORMED_OR_CHANGED_RECORD'],
    ['cloud_batch_resume', { attempted_variant_ids: ['unknown-variant'] }, 'MALFORMED_OR_CHANGED_RECORD'],
    ['cloud_batch_resume', { admission_blocked: { code: 'BUDGET_EXHAUSTED', outcome: 'none', variant_id: 'unknown-variant' } }, 'MALFORMED_OR_CHANGED_RECORD']
  ]) await t.test(`${event}: ${Object.keys(patch)[0]}`, async t => {
    const { store } = await workspace(t), { batch, jobs } = batchManifest();
    await putPreparation(store);
    await store.put('cloudbatch', batch.id, batch);
    for (const job of jobs) await store.put('cloudjob', job.id, job);
    const fields = event === 'cloud_batch_prepared' ? { request_hash: batch.request_hash, variants: batch.variants.length, currency: batch.currency, estimated_reservation: batch.estimated_reservation }
      : event === 'cloud_batch_ready' ? { job_ids: jobs.map(job => job.id) }
        : { attempted_variant_ids: [], admission_blocked: null };
    const details = { id: batch.id, plan_hash: batch.plan_hash, ...fields, ...patch };
    if (details.plan_hash === undefined) delete details.plan_hash;
    const audit = { id: newId('event'), event, time: EXPIRED, details, integrity: hash(details) };
    await store.put('audit', audit.id, audit);
    const inventory = await planner(store, configuration({ readDocumentIds: undefined })).inventory();
    assert.equal(inventory.complete, false);
    assert.equal(inventory.counts.archive_review_candidate, 0);
    assert.ok(inventory.entries.some(entry => entry.reasons.includes(reason)));
  });
});

test('missing batch children remain incomplete during materialization and after ready', async t => {
  for (const phase of ['materializing', 'ready']) await t.test(phase, async t => {
    const { store } = await workspace(t), { batch } = batchManifest(phase); await store.put('cloudbatch', batch.id, batch);
    const inventory = await planner(store, configuration({ readDocumentIds: undefined })).inventory();
    assert.equal(inventory.complete, false); assert.equal(inventory.counts.archive_review_candidate, 0);
    assert.ok(inventory.issues.includes('DEPENDENCY_COVERAGE_INCOMPLETE'));
    assert.equal((await readdir(store.root)).length, 1);
  });
});

test('read-only qualification evidence uses its final report time and receipt closure, independent of record ordering', async t => {
  const { store } = await workspace(t), id = newId('qualification'), receiptId = `${id}_inspection`;
  const result = { operation: 'document.inspect', document_id: 'doc:allowed', data: { name: 'PRIVATE_QUALIFICATION_CANARY' }, state: 'observed-state', evidence: 'synthetic_fixture' };
  await store.put('qualification_result', receiptId, result);
  const report = { id, scenario_id: 'test-inspection', scenario_hash: 'a'.repeat(64), purpose: 'Test local evidence retention', tested_at: OLD, profile_id: PROFILE, profile_sha256: PROFILE_HASH, execution_contract_sha256: CONTRACT, status: 'scenario_passed', evidence: [{ id: 'inspection', action: 'read', status: 'passed', result_receipt: { id: receiptId, kind: 'qualification_result', sha256: hash(result), size_bytes: Buffer.byteLength(JSON.stringify(result)) } }], cleanup: { remaining_document_ids: [], unresolved_jobs: [], failed_step_ids: [], review_required: false } };
  await store.put('qualification', id, { ...report, report_hash: hash(report) });
  for (const reverse of [false, true]) {
    const reader = { async snapshotReadOnly(options) { const snapshot = await store.snapshotReadOnly(options); snapshot.entries.sort((a, b) => a.kind.localeCompare(b.kind)); if (reverse) snapshot.entries.reverse(); return snapshot; } };
    const inventory = await planner(reader).inventory();
    assert.equal(inventory.complete, true); assert.equal(inventory.counts.archive_review_candidate, 2);
    assert.ok(inventory.entries.every(entry => entry.terminal && entry.age_anchor === OLD));
    assert.doesNotMatch(JSON.stringify(inventory), /PRIVATE_QUALIFICATION_CANARY/);
  }
});

async function putManageDraft(store) {
  const trustedSchema = { tenant: 'fixture-tenant', workspaceId: 10, schemaFingerprint: 'e'.repeat(64), fields: [{ fieldId: 'DESCRIPTION', type: 'string', allowNull: false, allowDraftUpdate: true, lifecycle: false }] };
  const request = { workspace_id: 10, item_id: 3, changes: [{ field_id: 'DESCRIPTION', after: 'Candidate description', source_ref: 'unverified:model-1' }] };
  const sourceItem = { sections: [{ fields: [{ value: 'PRIVATE_MANAGE_RETENTION_CANARY' }] }] };
  const draft = { status: 'draft_outbox', tenantId: 'test-tenant-context', manageTenant: trustedSchema.tenant, workspaceId: 10, itemId: 3, schemaFingerprint: trustedSchema.schemaFingerprint, expectedItemFingerprint: cloudHash(sourceItem), expectedEtag: '"test-revision"', changes: [{ fieldId: 'DESCRIPTION', after: 'Candidate description', sourceRef: 'unverified:model-1' }], sourceItem, requiresApproval: true, releaseApproved: false, publicationSupported: false, blocker: 'Synthetic stored review draft; no publication authority.' };
  const record = { schema_version: 1, id: newId('managedraft'), operation: 'manage.item_draft', profile_id: PROFILE, profile_hash: PROFILE_HASH, scope_hash: 'a'.repeat(64), authorization_binding: 'd'.repeat(64), schema_hash: hash(trustedSchema), request_hash: hash(request), created_at: OLD, observed_at: OLD, expires_at: EXPIRED, trusted_schema: trustedSchema, request, draft: { ...draft, draftHash: cloudHash(draft) }, record_hash: '' };
  record.record_hash = hash(manageDraftRecordBinding(record));
  verifyManageDraftRecord(record);
  await store.put('managedraft', record.id, record);
  const details = { id: record.id, record_hash: record.record_hash, stored_draft_hash: record.draft.draftHash, workspace_id: 10, item_id: 3, provider_write_performed: false };
  const audit = { id: newId('event'), event: 'manage_draft_prepared', time: OLD, details, integrity: hash(details) };
  await store.put('audit', audit.id, audit);
  return { record, audit };
}

test('an expired Manage draft and its audit are known protected metadata, without provider reads or renewal', async t => {
  const { store } = await workspace(t), { record } = await putManageDraft(store);
  const before = await contents(store), rootBefore = await lstat(store.root);
  const service = planner(store, configuration({ readDocumentIds: undefined })), inventory = await service.inventory();
  assert.equal(inventory.complete, true); assert.equal(inventory.dependency_coverage_complete, true);
  assert.equal(inventory.counts.protected, 2); assert.equal(inventory.counts.archive_review_candidate, 0);
  const entry = inventory.entries.find(item => item.record_kind === 'managedraft');
  assert.equal(entry.record_id, record.id); assert.equal(entry.state, 'draft_outbox'); assert.equal(entry.terminal, false);
  assert.ok(entry.reasons.includes('DRAFT_MANAGE_REQUIRES_REVIEW'));
  assert.ok(inventory.entries.every(item => item.dependency_count === 1));
  assert.equal(inventory.provider_state_observed, false);
  await assert.rejects(service.prepare({ inventory_hash: inventory.inventory_hash, record_refs: [entry.record_ref] }), { code: 'RETENTION_PROTECTED' });
  assert.deepEqual(await contents(store), before); assert.equal((await lstat(store.root)).mtimeMs, rootBefore.mtimeMs);
  assert.equal((await store.get('managedraft', record.id)).expires_at, EXPIRED);
  assert.doesNotMatch(JSON.stringify(inventory), /PRIVATE_MANAGE_RETENTION_CANARY|Candidate description|unverified:model-1|test-revision|sourceItem|authorization_binding/);
});

test('missing, changed or falsely approved Manage evidence keeps dependency coverage incomplete', async t => {
  for (const mode of ['missing draft', 'changed source', 'false approval', 'mismatched audit']) await t.test(mode, async t => {
    const { store } = await workspace(t), { record, audit } = await putManageDraft(store);
    if (mode === 'missing draft') await rm(path.join(store.root, `managedraft--${record.id}.json`));
    else if (mode === 'mismatched audit') {
      audit.details.item_id = 4; audit.integrity = hash(audit.details); await store.put('audit', audit.id, audit);
    } else {
      if (mode === 'changed source') record.draft.sourceItem.sections[0].fields[0].value = 'Changed locally';
      else {
        record.draft.releaseApproved = true;
        const { draftHash: _hash, ...draft } = record.draft; record.draft.draftHash = cloudHash(draft);
        record.record_hash = hash(manageDraftRecordBinding(record));
      }
      await store.put('managedraft', record.id, record);
    }
    const before = await contents(store), inventory = await planner(store, configuration({ readDocumentIds: undefined })).inventory();
    assert.equal(inventory.complete, false); assert.equal(inventory.dependency_coverage_complete, false);
    assert.equal(inventory.counts.archive_review_candidate, 0); assert.equal(inventory.provider_state_observed, false);
    assert.deepEqual(await contents(store), before);
  });
});

test('Manage review metadata obeys cached read restrictions and propagates owner holds to its audit', async t => {
  const { store } = await workspace(t); await putManageDraft(store);
  const initial = await planner(store, configuration({ readDocumentIds: undefined })).inventory();
  const context = configuration(), ref = initial.entries.find(item => item.record_kind === 'managedraft').record_ref;
  context.holds.holds = [{ id: 'manage-owner-hold', scope: 'records', recordRefs: [ref], reason: 'Test owner hold' }];
  const before = await contents(store), inventory = await planner(store, context).inventory();
  assert.equal(inventory.complete, true); assert.equal(inventory.counts.held, 2);
  assert.ok(inventory.entries.every(item => item.record_kind === 'restricted' && item.record_id === undefined && item.sha256 === undefined));
  assert.doesNotMatch(JSON.stringify(inventory), /managedraft_|PRIVATE_MANAGE_RETENTION_CANARY|DESCRIPTION|unverified:model-1/);
  assert.deepEqual(await contents(store), before);
});

test('historical Manage profile bindings stay protected without regaining current authority', async t => {
  const { store } = await workspace(t); await putManageDraft(store);
  const inventory = await planner(store, configuration({ readDocumentIds: undefined, profileHash: 'f'.repeat(64) })).inventory();
  assert.equal(inventory.complete, true); assert.equal(inventory.counts.archive_review_candidate, 0);
  assert.ok(inventory.entries.find(item => item.record_kind === 'managedraft').reasons.includes('SOURCE_BINDING_UNREVIEWED'));
});
