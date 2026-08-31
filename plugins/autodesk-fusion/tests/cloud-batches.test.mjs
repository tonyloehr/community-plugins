import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { CloudCoordinator, CloudError, RecordStore, MemoryTokenStore, parseProfile, hash, cloudHash, createFusionServer, assertJson } from '../dist/index.mjs';

// These provider doubles validate coordinator protocol and durable state only.
// They do not deploy an Automation recipe, spend money, run Fusion or prove geometry.
const future = () => new Date(Date.now() + 3_600_000).toISOString();
const context = () => ({ tenantId: 'batch-tenant', sources: [], destinationAlias: 'quarantine' });
const request = (overrides = {}) => ({ request_key: 'configured-order-001', recipe_id: 'batch-protocol-only', context: context(), variants: [10, 20, 30].map((width, index) => ({ variant_id: `variant-${index + 1}`, inputs: { width } })), ...overrides });
const status = (id, state = 'queued') => ({ providerId: id, providerStatus: state === 'validating' ? 'success' : state, status: state, completionConfirmed: ['validating', 'failed', 'cancelled'].includes(state), validationRequired: state === 'validating', cancelSupported: ['queued', 'running'].includes(state), observedAt: new Date().toISOString(), statistics: {} });
const rehash = value => { const { requestHash: _old, ...fields } = value; return { ...fields, requestHash: cloudHash(fields) }; };
function provider(options = {}) {
  const calls = { prepare: 0, submit: 0, workitems: 0, status: 0, cancel: 0 };
  const states = new Map();
  return {
    calls,
    states,
    listRecipes: () => [{ id: 'batch-protocol-only', version: '1', limits: { maxVariants: options.maxVariants ?? 100, maxOutputBytes: 10000 }, verification: { procedure: 'Synthetic dimensional and format checks.', validatorIds: ['dimensions', 'format'] } }],
    async prepare(recipeId, inputs, sourceContext) {
      calls.prepare++;
      if (recipeId !== 'batch-protocol-only' || typeof inputs.width !== 'number' || !Number.isFinite(inputs.width) || inputs.width < 1 || inputs.width > 100 || Object.keys(inputs).some(key => !['width', 'label'].includes(key))) throw new CloudError('INVALID_ARGUMENT', 'Outside the synthetic reviewed range.');
      if (sourceContext.tenantId !== 'batch-tenant' || sourceContext.destinationAlias !== 'quarantine' || sourceContext.variantCount !== 1) throw new CloudError('SCOPE_DENIED', 'Outside the synthetic scoped context.');
      const fields = { id: `synthetic-request-${calls.prepare}`, recipeId, recipeVersion: '1', recipeHash: '1'.repeat(64), inputs: structuredClone(inputs), context: structuredClone(sourceContext), activity: { reference: 'fixture.Recipe+v1', version: 1, engine: 'Autodesk.Fusion+Latest', definitionHash: '2'.repeat(64), bundles: [], observedAt: new Date().toISOString(), rollingEngine: true, aliasRacePossible: true }, destination: { alias: 'quarantine', kind: 'object_storage', origin: 'https://artifacts.example', keyPrefix: '/batch-tenant/quarantine/' }, reservation: { amount: 4, currency: 'USD', kind: 'estimated', hardCap: false }, createdAt: new Date().toISOString(), expiresAt: future(), warnings: ['Synthetic protocol evidence; no real provider execution or billing.'] };
      const prepared = options.prepare ? await options.prepare(fields, calls.prepare) : fields;
      return rehash(prepared);
    },
    async submit(prepared) {
      calls.submit++;
      await options.beforeSubmit?.(prepared, calls.submit);
      calls.workitems++;
      const id = options.providerId ?? `provider-${prepared.id}`;
      states.set(id, 'queued');
      return status(id);
    },
    async status(id) { calls.status++; return status(id, states.get(id) ?? 'queued'); },
    async cancel(id) { calls.cancel++; return { providerId: id, status: 'cancel_requested', completionConfirmed: false, reservationMustRemain: true }; }
  };
}
async function setup(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fusion-batch-protocol-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const profile = parseProfile({ version: 1, id: 'cloud-batch-fixture', mode: 'assisted', stateRoot: directory, policy: { mutationsEnabled: true, operations: ['cloud.job_submit', 'cloud.job_cancel'], effects: ['cloud_compute'], grantExpiresAt: future() }, cloud: { clientId: 'public-test-client', tenantId: 'batch-tenant', scopes: ['code:all', 'data:read'], redirectUri: 'http://127.0.0.1:8765/callback', hubIds: ['hub-1'], projects: [{ hubId: 'hub-1', projectId: 'project-1' }], budget: { maxConcurrentJobs: 2, maxSubmissions: 20, maxReservedUnits: 100, currency: 'USD', period: 'test-period', ...options.budget } } });
  const store = new RecordStore(directory); await store.init();
  const automation = options.automation ?? provider(options.provider);
  let binding = 'account-session-a';
  const config = { profile, root: '/unused', store, tokenStore: new MemoryTokenStore(), aps: { scope: { tenantId: profile.cloud.tenantId, hubIds: profile.cloud.hubIds, projects: profile.cloud.projects, mfgModels: [] } }, automation, authorizationBinding: async () => binding, ...options.coordinator };
  const coordinator = await CloudCoordinator.create(config);
  return { directory, profile, store, automation, config, coordinator, switchAccount(value) { binding = value; } };
}
const stored = (fixture, batch) => fixture.store.get('cloudbatch', batch.id);
const resume = (fixture, batch, maximum = 100) => fixture.coordinator.resumeBatch(batch.id, batch.plan_hash, maximum);
const validation = job => ({ job_id: job.id, provider_id: job.provider_id, request_hash: job.prepared.requestHash, recipe_hash: job.prepared.recipeHash, observed_at: new Date().toISOString(), artifacts: [{ artifact_id: `artifact:${job.id}`, sha256: 'a'.repeat(64), bytes: 100 }], checks: [{ validator_id: 'dimensions', outcome: 'passed', evidence_ref: 'check:dimensions' }, { validator_id: 'format', outcome: 'passed', evidence_ref: 'check:format' }] });
const billing = (job, amount = 4) => ({ job_id: job.id, provider_id: job.provider_id, request_hash: job.prepared.requestHash, currency: 'USD', actual_amount: amount, observed_at: new Date().toISOString(), evidence_ref: `invoice:${job.id}`, source: 'provider_invoice', final: true });

test('whole-batch preparation freezes distinct single-variant jobs without submissions or reservations', async t => {
  const fixture = await setup(t);
  const batch = await fixture.coordinator.prepareBatch(request());
  const record = await stored(fixture, batch);
  assert.equal(batch.phase, 'ready');
  assert.equal(batch.progress.prepared, 3);
  assert.equal(batch.admission_estimate.amount, 12);
  assert.equal(batch.admission_estimate.reserved_at_preparation, false);
  assert.equal(fixture.automation.calls.prepare, 3);
  assert.equal(fixture.automation.calls.submit, 0);
  assert.equal(new Set(batch.variants.map(variant => variant.job_id)).size, 3);
  assert.equal(new Set(batch.variants.map(variant => variant.request_hash)).size, 3);
  for (const [index, variant] of record.variants.entries()) {
    const job = await fixture.coordinator.inspectJob(variant.initial_job.id);
    assert.equal(job.prepared.context.variantCount, 1);
    assert.equal(job.prepared.inputs.width, request().variants[index].inputs.width);
    assert.deepEqual(job.batch, { batch_id: batch.id, variant_id: variant.variant_id, request_hash: batch.request_hash });
    assert.equal(job.submitted, false); assert.equal(job.reserved_units, 0);
    assert.equal(job.plan_hash, variant.initial_job.plan_hash);
  }
  assert.equal(batch.all_outputs_validated, false);
  assert.equal(batch.publication_performed, false);
});

test('malformed envelope, duplicate identities and authority fields fail before any provider preparation', async t => {
  const fixture = await setup(t);
  const invalid = [request({ variants: [] }), request({ approved: true }), request({ context: { ...context(), variantCount: 3 } }), request({ context: { ...context(), requireHardCap: 'yes' } }), request({ variants: [request().variants[0], request().variants[0]] }), request({ variants: Array.from({ length: 101 }, (_, i) => ({ variant_id: `v${i}`, inputs: { width: 10 } })) }), request({ variants: [{ variant_id: '../escape', inputs: { width: 10 } }] }), JSON.parse(JSON.stringify(request()).replace('"width":10', '"constructor":10'))];
  for (const input of invalid) await assert.rejects(fixture.coordinator.prepareBatch(input));
  assert.equal(fixture.automation.calls.prepare, 0);
  assert.equal((await fixture.store.list('cloudbatch')).length, 0);
  assert.equal((await fixture.store.list('cloudjob')).length, 0);
});

test('one invalid late parameter set consumes no workitem and exposes no partial child ledger', async t => {
  const fixture = await setup(t);
  const input = request(); input.variants[2].inputs.width = -1;
  await assert.rejects(fixture.coordinator.prepareBatch(input), error => error.code === 'BATCH_PREFLIGHT_FAILED' && error.details.variant_id === 'variant-3');
  assert.equal(fixture.automation.calls.prepare, 3);
  assert.equal(fixture.automation.calls.workitems, 0);
  assert.deepEqual(await fixture.store.list('cloudbatch'), []);
  assert.deepEqual(await fixture.store.list('cloudjob'), []);
});

test('whole-batch recipe limits, total admissions, currencies and estimated cost are checked before commit', async t => {
  for (const [options, expected] of [[{ provider: { maxVariants: 2 } }, 'BATCH_RECIPE_LIMIT'], [{ budget: { maxSubmissions: 2 } }, 'BATCH_BUDGET_EXHAUSTED'], [{ budget: { maxReservedUnits: 11 } }, 'BATCH_BUDGET_EXHAUSTED'], [{ budget: { currency: 'EUR' } }, 'BUDGET_UNIT_MISMATCH']]) {
    const fixture = await setup(t, options);
    await assert.rejects(fixture.coordinator.prepareBatch(request()), { code: expected });
    assert.equal((await fixture.store.list('cloudbatch')).length, 0);
    assert.equal((await fixture.store.list('cloudjob')).length, 0);
    assert.equal(fixture.automation.calls.workitems, 0);
  }
});

test('recipe/activity/source/destination drift during preparation cannot create a ready batch', async t => {
  const mutations = [
    fields => ({ ...fields, recipeHash: '9'.repeat(64) }),
    fields => ({ ...fields, activity: { ...fields.activity, version: 2 } }),
    fields => ({ ...fields, destination: { ...fields.destination, keyPrefix: '/changed/' } }),
    fields => ({ ...fields, context: { ...fields.context, tenantId: 'other-tenant' } }),
    fields => ({ ...fields, inputs: { width: 99 } }),
    fields => ({ ...fields, destination: { alias: 'quarantine', kind: 'fusion_project', hubId: 'hub-1', projectId: 'project-1' } }),
    fields => ({ ...fields, id: 'synthetic-request-1' })
  ];
  for (const mutate of mutations) {
    const fixture = await setup(t, { provider: { prepare: (fields, count) => count === 3 ? mutate(fields) : fields } });
    await assert.rejects(fixture.coordinator.prepareBatch(request()));
    assert.equal((await fixture.store.list('cloudbatch')).length, 0);
    assert.equal((await fixture.store.list('cloudjob')).length, 0);
    assert.equal(fixture.automation.calls.workitems, 0);
  }
});

test('a required hard cap is not fulfilled by an estimated per-variant reservation', async t => {
  const fixture = await setup(t);
  await assert.rejects(fixture.coordinator.prepareBatch(request({ context: { ...context(), requireHardCap: true } })), { code: 'BUDGET_UNENFORCEABLE' });
  assert.equal(fixture.automation.calls.workitems, 0);
  assert.equal((await fixture.store.list('cloudbatch')).length, 0);
});

test('rolling engines and alias revalidation do not satisfy immutable batch requirements', async t => {
  for (const requirement of ['requireImmutableEngine', 'requireImmutableDependencies']) {
    const fixture = await setup(t);
    await assert.rejects(fixture.coordinator.prepareBatch(request({ context: { ...context(), [requirement]: true } })), { code: 'IMMUTABILITY_UNAVAILABLE' });
    assert.equal(fixture.automation.calls.workitems, 0);
    assert.equal((await fixture.store.list('cloudbatch')).length, 0);
  }
});

test('request replay after restart reuses exact immutable jobs; changed variants or order conflict', async t => {
  const fixture = await setup(t);
  const batch = await fixture.coordinator.prepareBatch(request());
  const restarted = await CloudCoordinator.create(fixture.config);
  const replay = await restarted.prepareBatch(request());
  assert.deepEqual(replay, batch);
  assert.equal(fixture.automation.calls.prepare, 3);
  await assert.rejects(restarted.prepareBatch(request({ variants: [...request().variants].reverse() })), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(restarted.prepareBatch(request({ variants: [{ variant_id: 'other', inputs: { width: 10 } }] })), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal((await fixture.store.list('cloudbatch')).length, 1);
  assert.equal((await fixture.store.list('cloudjob')).length, 3);
});

test('bounded waves share global concurrency and preserve admission-blocked prepared children', async t => {
  const fixture = await setup(t);
  const batch = await fixture.coordinator.prepareBatch(request());
  const first = await resume(fixture, batch, 1);
  assert.deepEqual(first.wave.attempted_variant_ids, ['variant-1']);
  const second = await resume(fixture, batch);
  assert.deepEqual(second.wave.attempted_variant_ids, ['variant-2']);
  assert.equal(second.wave.admission_blocked.code, 'BUDGET_EXHAUSTED');
  assert.equal(second.variants[2].status, 'prepared');
  assert.equal(second.variants[2].submitted, false);
  assert.equal(second.variants[2].reserved_units, 0);
  const third = await resume(fixture, batch);
  assert.deepEqual(third.wave.attempted_variant_ids, []);
  assert.equal(fixture.automation.calls.workitems, 2);
  assert.equal(fixture.automation.calls.status, 0, 'Batch resume does not secretly poll provider jobs');
});

test('partial batches resume original unattempted jobs after known completion without duplicating work', async t => {
  const fixture = await setup(t);
  const batch = await fixture.coordinator.prepareBatch(request());
  const first = await resume(fixture, batch);
  for (const variant of first.variants.slice(0, 2)) {
    fixture.automation.states.set(variant.provider_id, 'failed');
    await fixture.coordinator.jobStatus(variant.job_id);
  }
  const restarted = await CloudCoordinator.create(fixture.config);
  const last = await restarted.resumeBatch(batch.id, batch.plan_hash, 1);
  assert.deepEqual(last.wave.attempted_variant_ids, ['variant-3']);
  assert.equal(last.progress.failed, 2); assert.equal(last.progress.active, 1);
  assert.deepEqual(last.variants.map(variant => variant.job_id), batch.variants.map(variant => variant.job_id));
  assert.equal(fixture.automation.calls.workitems, 3);
  assert.deepEqual((await restarted.resumeBatch(batch.id, batch.plan_hash, 100)).wave.attempted_variant_ids, []);
});

test('unknown submission retains its reservation and stops future batch admissions after restart', async t => {
  const fixture = await setup(t, { provider: { beforeSubmit: async () => { throw new CloudError('OUTCOME_UNKNOWN', 'Response lost; PRIVATE_RAW_PROVIDER_SECRET', 'unknown'); } } });
  const batch = await fixture.coordinator.prepareBatch(request());
  const first = await resume(fixture, batch);
  assert.equal(first.progress.uncertain, 1); assert.equal(first.progress.prepared, 2);
  assert.equal(first.variants[0].reserved_units, 4);
  assert.equal(JSON.stringify(first).includes('PRIVATE_RAW_PROVIDER_SECRET'), false);
  const restarted = await CloudCoordinator.create(fixture.config);
  const replay = await restarted.resumeBatch(batch.id, batch.plan_hash, 100);
  assert.equal(replay.wave.admission_blocked.code, 'BATCH_RECONCILIATION_REQUIRED');
  assert.equal(fixture.automation.calls.submit, 1);
  assert.deepEqual(replay.wave.attempted_variant_ids, []);
});

test('persisted submitting intent becomes unknown without reentering provider submit', async t => {
  const fixture = await setup(t), batch = await fixture.coordinator.prepareBatch(request());
  const manifest = await stored(fixture, batch), variant = manifest.variants[0];
  const job = { ...variant.initial_job, status: 'submitting', submitted: true, reserved_units: 4, idempotency_key: variant.idempotency_key };
  await fixture.store.put('idempotency', hash({ cloud: fixture.profile.id, key: variant.idempotency_key }), { job_id: job.id, plan_hash: job.plan_hash });
  await fixture.store.put('cloudjob', job.id, job);
  const restarted = await CloudCoordinator.create(fixture.config);
  const result = await restarted.resumeBatch(batch.id, batch.plan_hash, 3);
  assert.equal(result.variants[0].status, 'outcome_unknown');
  assert.equal(result.variants[0].reserved_units, 4);
  assert.equal(result.progress.prepared, 2);
  assert.equal(fixture.automation.calls.submit, 0);
  assert.equal((await fixture.store.get('cloudjob', job.id)).status, 'outcome_unknown');
});

test('known no-effect failure is retained while a later explicit resume can admit other variants', async t => {
  const fixture = await setup(t, { provider: { beforeSubmit: async (_prepared, count) => { if (count === 1) throw new CloudError('STALE_PLAN', 'Synthetic source changed before dispatch.', 'none'); } } });
  const batch = await fixture.coordinator.prepareBatch(request());
  const first = await resume(fixture, batch);
  assert.equal(first.variants[0].status, 'failed'); assert.equal(first.variants[0].submitted, false); assert.equal(first.variants[0].reserved_units, 0);
  assert.equal(first.progress.prepared, 2);
  const next = await resume(fixture, batch);
  assert.deepEqual(next.wave.attempted_variant_ids, ['variant-2', 'variant-3']);
  assert.equal(fixture.automation.calls.submit, 3); assert.equal(fixture.automation.calls.workitems, 2);
  assert.equal(next.variants[0].status, 'failed');
});

test('all remaining child expiries are checked before the first submission of a wave', async t => {
  const originalNow = Date.now, start = Date.now();
  const fixture = await setup(t, { provider: { prepare: (fields, count) => count === 3 ? { ...fields, expiresAt: new Date(start + 60_000).toISOString() } : fields } });
  const batch = await fixture.coordinator.prepareBatch(request());
  try {
    Date.now = () => start + 120_000;
    await assert.rejects(resume(fixture, batch), { code: 'PLAN_EXPIRED' });
  } finally { Date.now = originalNow; }
  assert.equal(fixture.automation.calls.submit, 0);
  assert.equal((await fixture.coordinator.inspectBatch(batch.id)).progress.prepared, 3);
});

test('frozen source changes at submission stay failed with no workitem and no remapping', async t => {
  let sourceChanged = false;
  const source = { hubId: 'hub-1', projectId: 'project-1', itemId: 'item-1', versionId: 'version-1', configurationId: 'configuration-1', resourceHash: 'c'.repeat(64) };
  const fixture = await setup(t, { provider: { beforeSubmit: async prepared => { assert.deepEqual(prepared.context.sources, [source]); if (sourceChanged) throw new CloudError('STALE_PLAN', 'Source resource changed before dispatch.', 'none'); } } });
  const batch = await fixture.coordinator.prepareBatch(request({ context: { ...context(), sources: [source] } }));
  sourceChanged = true;
  const result = await resume(fixture, batch);
  assert.equal(result.variants[0].status, 'failed'); assert.equal(result.variants[0].error.code, 'STALE_PLAN');
  assert.equal(result.variants[0].submitted, false); assert.equal(result.progress.prepared, 2);
  assert.equal(fixture.automation.calls.workitems, 0);
  assert.deepEqual(result.context.sources, [source]);
  assert.deepEqual(result.variants.map(variant => variant.job_id), batch.variants.map(variant => variant.job_id));
});

test('account changes during preparation and after review cannot reuse the batch', async t => {
  const fixture = await setup(t);
  const prepare = fixture.automation.prepare.bind(fixture.automation);
  fixture.automation.prepare = async (...args) => { const result = await prepare(...args); if (fixture.automation.calls.prepare === 3) fixture.switchAccount('other-session'); return result; };
  await assert.rejects(fixture.coordinator.prepareBatch(request()), { code: 'ACCOUNT_CHANGED' });
  assert.equal((await fixture.store.list('cloudbatch')).length, 0);
  fixture.switchAccount('account-session-a'); fixture.automation.prepare = prepare;
  const batch = await fixture.coordinator.prepareBatch(request());
  fixture.switchAccount('other-session');
  await assert.rejects(fixture.coordinator.inspectBatch(batch.id), { code: 'ACCOUNT_CHANGED' });
  await assert.rejects(resume(fixture, batch), { code: 'ACCOUNT_CHANGED' });
  assert.equal(fixture.automation.calls.submit, 0);
});

test('changed profile scope, grants or exact reviewed hash block submissions', async t => {
  const fixture = await setup(t);
  const filename = path.join(fixture.directory, 'profile.json');
  await writeFile(filename, JSON.stringify(fixture.profile), { mode: 0o600 });
  fixture.coordinator = await CloudCoordinator.create({ ...fixture.config, profileFile: filename });
  const batch = await fixture.coordinator.prepareBatch(request());
  await assert.rejects(fixture.coordinator.resumeBatch(batch.id, 'f'.repeat(64), 1), { code: 'PLAN_BINDING_CHANGED' });
  await writeFile(filename, JSON.stringify({ ...fixture.profile, policy: { ...fixture.profile.policy, mutationsEnabled: false } }));
  await assert.rejects(resume(fixture, batch), { code: 'PROFILE_CHANGED' });
  const changed = await CloudCoordinator.create({ ...fixture.config, profile: { ...fixture.profile, cloud: { ...fixture.profile.cloud, tenantId: 'other-tenant' } } });
  await assert.rejects(changed.inspectBatch(batch.id), { code: 'JOB_SCOPE_DENIED' });
  assert.equal(fixture.automation.calls.submit, 0);
});

test('partial materialization can resume only original unattempted children before sealing ready', async t => {
  const fixture = await setup(t), put = fixture.store.put.bind(fixture.store);
  let children = 0;
  fixture.store.put = async (kind, id, value) => { if (kind === 'cloudjob' && ++children === 2) throw Object.assign(new Error('Injected local write failure'), { code: 'EIO' }); return put(kind, id, value); };
  await assert.rejects(fixture.coordinator.prepareBatch(request()), { code: 'EIO' });
  const manifest = (await fixture.store.list('cloudbatch'))[0];
  assert.equal(manifest.phase, 'materializing'); assert.equal((await fixture.store.list('cloudjob')).length, 1);
  assert.equal((await fixture.coordinator.inspectBatch(manifest.id)).progress.not_materialized, 2);
  const first = manifest.variants[0];
  await assert.rejects(fixture.coordinator.submitJob(first.initial_job.id, first.initial_job.plan_hash, first.idempotency_key), { code: 'BATCH_SUBMISSION_REQUIRED' });
  fixture.store.put = put;
  const restarted = await CloudCoordinator.create(fixture.config);
  const result = await restarted.resumeBatch(manifest.id, manifest.plan_hash, 1);
  assert.equal(result.phase, 'ready'); assert.deepEqual(result.wave.attempted_variant_ids, ['variant-1']);
  assert.equal(fixture.automation.calls.prepare, 3); assert.equal(fixture.automation.calls.workitems, 1);
  assert.deepEqual((await stored(fixture, result)).variants, manifest.variants);
});

test('a missing child of a ready batch is never recreated or submitted', async t => {
  const fixture = await setup(t), batch = await fixture.coordinator.prepareBatch(request());
  await unlink(path.join(fixture.directory, `cloudjob--${batch.variants[1].job_id}.json`));
  await assert.rejects(fixture.coordinator.inspectBatch(batch.id), { code: 'BATCH_LEDGER_INCOMPLETE', outcome: 'unknown' });
  await assert.rejects(resume(fixture, batch), { code: 'BATCH_LEDGER_INCOMPLETE', outcome: 'unknown' });
  await assert.rejects(fixture.coordinator.prepareBatch(request()), { code: 'BATCH_LEDGER_INCOMPLETE' });
  assert.equal((await fixture.store.list('cloudjob')).length, 2);
  assert.equal(fixture.automation.calls.submit, 0);
});

test('an attempted child in an unsealed batch blocks materialization of other missing records', async t => {
  const fixture = await setup(t), batch = await fixture.coordinator.prepareBatch(request());
  const manifest = await stored(fixture, batch), first = manifest.variants[0];
  manifest.phase = 'materializing';
  await fixture.store.put('cloudbatch', manifest.id, manifest);
  await fixture.store.put('cloudjob', first.initial_job.id, { ...first.initial_job, status: 'submitting', submitted: true, reserved_units: 4, idempotency_key: first.idempotency_key });
  await unlink(path.join(fixture.directory, `cloudjob--${batch.variants[2].job_id}.json`));
  await assert.rejects(resume(fixture, batch), { code: 'BATCH_MATERIALIZATION_BLOCKED' });
  assert.equal((await fixture.store.list('cloudjob')).length, 2); assert.equal(fixture.automation.calls.submit, 0);
});

test('changed child plans and variant mappings fail closed even if other children are valid', async t => {
  for (const target of ['child', 'manifest']) {
    const fixture = await setup(t), batch = await fixture.coordinator.prepareBatch(request());
    if (target === 'child') {
      const job = await fixture.store.get('cloudjob', batch.variants[2].job_id); job.prepared.inputs.width = 99;
      await fixture.store.put('cloudjob', job.id, job);
    } else {
      const manifest = await stored(fixture, batch); manifest.variants[2].variant_id = 'remapped';
      await fixture.store.put('cloudbatch', manifest.id, manifest);
    }
    await assert.rejects(resume(fixture, batch));
    assert.equal(fixture.automation.calls.workitems, 0);
  }
});

test('standalone submit cannot bypass the owning batch even with its exact child key', async t => {
  const fixture = await setup(t), batch = await fixture.coordinator.prepareBatch(request()), manifest = await stored(fixture, batch);
  for (const variant of manifest.variants) await assert.rejects(fixture.coordinator.submitJob(variant.initial_job.id, variant.initial_job.plan_hash, variant.idempotency_key), { code: 'BATCH_SUBMISSION_REQUIRED' });
  assert.equal(fixture.automation.calls.submit, 0);
  await resume(fixture, batch, 1);
  const variant = manifest.variants[0];
  await assert.rejects(fixture.coordinator.submitJob(variant.initial_job.id, variant.initial_job.plan_hash, variant.idempotency_key), { code: 'BATCH_SUBMISSION_REQUIRED' });
  assert.equal(fixture.automation.calls.workitems, 1);
});

test('failure to persist a provider result retains submitting intent and forbids retry', async t => {
  const fixture = await setup(t), batch = await fixture.coordinator.prepareBatch(request()), put = fixture.store.put.bind(fixture.store);
  fixture.store.put = async (kind, id, value) => { if (kind === 'cloudjob' && value.status === 'queued') throw Object.assign(new Error('Injected receipt write failure'), { code: 'EIO' }); return put(kind, id, value); };
  const first = await resume(fixture, batch);
  assert.equal(first.variants[0].status, 'submitting'); assert.equal(first.progress.prepared, 2);
  assert.equal(fixture.automation.calls.workitems, 1);
  fixture.store.put = put;
  const restarted = await CloudCoordinator.create(fixture.config);
  const result = await restarted.resumeBatch(batch.id, batch.plan_hash, 100);
  assert.equal(result.variants[0].status, 'outcome_unknown'); assert.equal(result.variants[0].reserved_units, 4);
  assert.equal(fixture.automation.calls.workitems, 1);
});

test('shared lease prevents two coordinators from admitting the same batch concurrently', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  const fixture = await setup(t, { provider: { beforeSubmit: async () => { entered(); await gate; } } });
  const batch = await fixture.coordinator.prepareBatch(request());
  const other = await CloudCoordinator.create(fixture.config);
  const first = resume(fixture, batch, 1);
  await ready;
  try { await assert.rejects(other.resumeBatch(batch.id, batch.plan_hash, 1), { code: 'EXECUTION_LOCKED' }); }
  finally { release(); }
  await first;
  assert.equal(fixture.automation.calls.workitems, 1);
});

test('provider identity collision is uncertain and never reuses another variant provider ID', async t => {
  const fixture = await setup(t, { provider: { providerId: 'duplicate-provider-id' } });
  const batch = await fixture.coordinator.prepareBatch(request());
  const result = await resume(fixture, batch);
  assert.equal(result.variants[0].status, 'queued');
  assert.equal(result.variants[1].status, 'outcome_unknown'); assert.equal(result.variants[1].provider_id, null);
  assert.equal(result.variants[1].error.code, 'PROVIDER_IDENTITY_CONFLICT'); assert.equal(result.variants[1].reserved_units, 4);
  assert.equal(result.variants[2].status, 'prepared');
  await resume(fixture, batch);
  assert.equal(fixture.automation.calls.workitems, 2);
});

test('provider completion, output validation, identity collisions and actual billing remain separate', async t => {
  let collide = true, validations = 0;
  const fixture = await setup(t, { coordinator: { validateOutputs: async job => { validations++; const receipt = validation(job); if (collide) receipt.artifacts[0].artifact_id = 'artifact:shared'; return receipt; }, reconcileBilling: async job => billing(job) } });
  const batch = await fixture.coordinator.prepareBatch(request({ variants: request().variants.slice(0, 2) }));
  const submitted = await resume(fixture, batch);
  for (const variant of submitted.variants) { fixture.automation.states.set(variant.provider_id, 'validating'); await fixture.coordinator.jobStatus(variant.job_id); }
  const pending = await fixture.coordinator.inspectBatch(batch.id);
  assert.equal(pending.progress.validating, 2); assert.equal(pending.all_outputs_validated, false);
  await fixture.coordinator.validateJob(batch.variants[0].job_id);
  await assert.rejects(fixture.coordinator.validateJob(batch.variants[1].job_id), { code: 'OUTPUT_IDENTITY_CONFLICT' });
  assert.equal((await fixture.coordinator.inspectBatch(batch.id)).all_outputs_validated, false);
  collide = false;
  for (const variant of batch.variants) await assert.rejects(fixture.coordinator.validateJob(variant.job_id), { code: 'OUTPUT_IDENTITY_CONFLICT' });
  assert.equal(validations, 2, 'Another validator invocation must not erase observed identity collisions');
  const validated = await fixture.coordinator.inspectBatch(batch.id);
  assert.equal(validated.all_outputs_validated, false);
  assert.equal(validated.output_conflict_receipt.resolution, 'blocked_no_reconciliation_api');
  assert.ok(validated.variants.every(variant => variant.validation_usable === false));
  assert.equal(validated.billing_settled, false); assert.equal(validated.progress.unsettled_submitted_jobs, 2);
  for (const variant of batch.variants) await fixture.coordinator.settleJob(variant.job_id);
  const settled = await fixture.coordinator.inspectBatch(batch.id);
  assert.equal(settled.billing_settled, true); assert.equal(settled.all_outputs_validated, false); assert.equal(settled.publication_performed, false);
  assert.ok(settled.variants.every(variant => variant.status === 'failed' && variant.validation_usable === false));
});

test('equal output content under distinct artifact identities can still validate and settle normally', async t => {
  const fixture = await setup(t, { coordinator: { validateOutputs: async job => validation(job), reconcileBilling: async job => billing(job) } });
  const batch = await fixture.coordinator.prepareBatch(request({ variants: request().variants.slice(0, 2) }));
  const submitted = await resume(fixture, batch);
  for (const variant of submitted.variants) {
    fixture.automation.states.set(variant.provider_id, 'validating');
    await fixture.coordinator.validateJob(variant.job_id); await fixture.coordinator.settleJob(variant.job_id);
  }
  const result = await fixture.coordinator.inspectBatch(batch.id);
  assert.equal(result.all_outputs_validated, true); assert.equal(result.billing_settled, true);
  assert.ok(result.variants.every(variant => variant.validation_usable));
  assert.equal(result.output_conflict_receipt, null); assert.deepEqual(await fixture.store.list('cloudbatchconflict'), []);
  assert.equal(fixture.automation.calls.workitems, 2);
});

test('durable output conflict stops remaining variants after restart and invalidates clean cached grades', async t => {
  const fixture = await setup(t, { coordinator: { validateOutputs: async job => { const receipt = validation(job); receipt.artifacts[0].artifact_id = 'artifact:collision'; return receipt; } } });
  const batch = await fixture.coordinator.prepareBatch(request());
  const first = await resume(fixture, batch, 2);
  for (const variant of first.variants.slice(0, 2)) { fixture.automation.states.set(variant.provider_id, 'validating'); await fixture.coordinator.jobStatus(variant.job_id); }
  await fixture.coordinator.validateJob(batch.variants[0].job_id);
  await assert.rejects(fixture.coordinator.validateJob(batch.variants[1].job_id), { code: 'OUTPUT_IDENTITY_CONFLICT' });
  const restarted = await CloudCoordinator.create(fixture.config);
  const resumed = await restarted.resumeBatch(batch.id, batch.plan_hash, 100);
  t.diagnostic(JSON.stringify({ workitems: fixture.automation.calls.workitems, attempted_variants: resumed.wave.attempted_variant_ids, output_conflicts: resumed.output_identity_conflicts }));
  assert.equal(fixture.automation.calls.workitems, 2, 'A known output collision must prevent another workitem, including after restart');
  assert.deepEqual(resumed.wave.attempted_variant_ids, []);
  assert.equal(resumed.output_identity_conflicts.length, 1);
  assert.equal(resumed.all_outputs_validated, false);
  for (const variant of resumed.variants.slice(0, 2)) {
    assert.equal(variant.status, 'failed'); assert.equal(variant.validation_usable, false);
    const job = await restarted.inspectJob(variant.job_id);
    assert.equal(job.status, 'failed'); assert.equal(job.validation_usable, false);
  }
  assert.equal(resumed.variants[2].status, 'prepared');
});

test('terminal cancellation observation is durable without a repeated DELETE or released reservation', async t => {
  const fixture = await setup(t), batch = await fixture.coordinator.prepareBatch(request());
  const first = await resume(fixture, batch, 1), variant = first.variants[0];
  await fixture.coordinator.cancelJob(variant.job_id);
  fixture.automation.states.set(variant.provider_id, 'cancelled');
  const reply = await fixture.coordinator.cancelJob(variant.job_id);
  assert.equal(reply.job.status, 'cancelled'); assert.equal(fixture.automation.calls.cancel, 1);
  const restarted = await CloudCoordinator.create(fixture.config), inspected = await restarted.inspectBatch(batch.id);
  assert.equal(inspected.variants[0].status, 'cancelled');
  assert.equal(inspected.variants[0].reserved_units, 4); assert.equal(inspected.variants[0].settlement, null);
});

test('terminal observation during an inapplicable cancellation is persisted without DELETE', async t => {
  const fixture = await setup(t), batch = await fixture.coordinator.prepareBatch(request());
  const first = await resume(fixture, batch, 1), variant = first.variants[0];
  fixture.automation.states.set(variant.provider_id, 'failed');
  const reply = await fixture.coordinator.cancelJob(variant.job_id);
  assert.equal(reply.job.status, 'failed'); assert.equal(fixture.automation.calls.cancel, 0);
  assert.equal((await fixture.coordinator.inspectBatch(batch.id)).variants[0].status, 'failed');
  assert.equal((await fixture.coordinator.inspectJob(variant.job_id)).reserved_units, 4);
});

async function stagedCollision(t) {
  const fixture = await setup(t, { coordinator: { validateOutputs: async job => { const receipt = validation(job); receipt.artifacts[0].artifact_id = 'artifact:collision'; return receipt; } } });
  const batch = await fixture.coordinator.prepareBatch(request()), original = await stored(fixture, batch);
  const submitted = await resume(fixture, batch, 2);
  for (const variant of submitted.variants.slice(0, 2)) { fixture.automation.states.set(variant.provider_id, 'validating'); await fixture.coordinator.jobStatus(variant.job_id); }
  await fixture.coordinator.validateJob(batch.variants[0].job_id);
  return { ...fixture, batch, original };
}

test('a failed conflict receipt write preserves an unresolved validation intent and prevents replay', async t => {
  const fixture = await stagedCollision(t), { batch } = fixture, put = fixture.store.put.bind(fixture.store);
  fixture.store.put = async (kind, id, value) => { if (kind === 'cloudbatchconflict') throw Object.assign(new Error('Synthetic conflict receipt write failure'), { code: 'EIO' }); return put(kind, id, value); };
  await assert.rejects(fixture.coordinator.validateJob(batch.variants[1].job_id), { code: 'EIO' });
  fixture.store.put = put;
  assert.equal((await fixture.store.get('cloudjob', batch.variants[1].job_id)).validation_in_progress.batch_id, batch.id);
  const restarted = await CloudCoordinator.create(fixture.config), result = await restarted.resumeBatch(batch.id, batch.plan_hash, 100);
  assert.equal(result.wave.admission_blocked.code, 'BATCH_RECONCILIATION_REQUIRED');
  assert.deepEqual(result.wave.attempted_variant_ids, []); assert.equal(result.progress.uncertain, 1);
  assert.equal(result.all_outputs_validated, false); assert.equal(result.variants[0].validation_usable, false);
  assert.equal((await restarted.inspectJob(batch.variants[0].job_id)).validation_usable, false);
  await assert.rejects(restarted.validateJob(batch.variants[1].job_id), { code: 'VALIDATION_RECONCILIATION_REQUIRED' });
  await assert.rejects(restarted.validateJob(batch.variants[0].job_id), { code: 'VALIDATION_RECONCILIATION_REQUIRED' });
  assert.equal(fixture.automation.calls.workitems, 2);
});

test('lost successful validation persistence also leaves an unresolved intent rather than a clean batch', async t => {
  let validationCalls = 0;
  const fixture = await setup(t, { coordinator: { validateOutputs: async job => { validationCalls++; return validation(job); } } });
  const batch = await fixture.coordinator.prepareBatch(request()), first = await resume(fixture, batch, 1), variant = first.variants[0];
  fixture.automation.states.set(variant.provider_id, 'validating');
  const put = fixture.store.put.bind(fixture.store);
  fixture.store.put = async (kind, id, value) => { if (kind === 'cloudjob' && value.validation) throw Object.assign(new Error('Synthetic completed-validation write loss'), { code: 'EIO' }); return put(kind, id, value); };
  await assert.rejects(fixture.coordinator.validateJob(variant.job_id), { code: 'EIO' });
  fixture.store.put = put;
  const restarted = await CloudCoordinator.create(fixture.config);
  await restarted.jobStatus(variant.job_id);
  const resumed = await restarted.resumeBatch(batch.id, batch.plan_hash, 100);
  assert.equal(resumed.wave.admission_blocked.code, 'BATCH_RECONCILIATION_REQUIRED');
  assert.deepEqual(resumed.wave.attempted_variant_ids, []); assert.equal(resumed.all_outputs_validated, false);
  assert.equal(resumed.variants[0].validation_outcome_unknown, true);
  await assert.rejects(restarted.validateJob(variant.job_id), { code: 'VALIDATION_RECONCILIATION_REQUIRED' });
  assert.equal(validationCalls, 1); assert.equal(fixture.automation.calls.workitems, 1);
});

test('durable conflict protects every implicated job even when saving job projections fails', async t => {
  const fixture = await stagedCollision(t), { batch } = fixture, put = fixture.store.put.bind(fixture.store);
  fixture.store.put = async (kind, id, value) => { if (kind === 'cloudjob' && value.output_identity_conflict) throw Object.assign(new Error('Synthetic conflict projection write failure'), { code: 'EIO' }); return put(kind, id, value); };
  await assert.rejects(fixture.coordinator.validateJob(batch.variants[1].job_id), { code: 'EIO' });
  fixture.store.put = put;
  const fence = await fixture.store.get('cloudbatchconflict', batch.id);
  assert.equal(fence.batch_plan_hash, batch.plan_hash); assert.equal(fence.job_bindings.length, 2);
  assert.equal(fence.candidate_receipt_sha256, fence.job_bindings.find(job => job.job_id === batch.variants[1].job_id).validation_receipt_sha256);
  assert.deepEqual(await stored(fixture, batch), fixture.original, 'Initial batch hashes and mappings remain unchanged');
  const restarted = await CloudCoordinator.create(fixture.config);
  for (const variant of batch.variants.slice(0, 2)) {
    const record = await restarted.inspectJob(variant.job_id);
    assert.equal(record.status, 'failed'); assert.equal(record.validation_usable, false);
    await restarted.jobStatus(variant.job_id);
    assert.equal((await restarted.inspectJob(variant.job_id)).status, 'failed', 'Provider success cannot resurrect a conflicted cached validation');
  }
  const resumed = await restarted.resumeBatch(batch.id, batch.plan_hash, 100);
  assert.equal(resumed.wave.admission_blocked.code, 'OUTPUT_IDENTITY_CONFLICT');
  assert.deepEqual(resumed.wave.attempted_variant_ids, []); assert.equal(fixture.automation.calls.workitems, 2);
});

test('missing, modified and cross-bound conflict receipts fail closed instead of restoring clean grades', async t => {
  for (const mode of ['hash_changed', 'different_batch', 'different_job_plan', 'missing']) {
    const fixture = await stagedCollision(t), { batch } = fixture;
    await assert.rejects(fixture.coordinator.validateJob(batch.variants[1].job_id), { code: 'OUTPUT_IDENTITY_CONFLICT' });
    if (mode === 'missing') await unlink(path.join(fixture.directory, `cloudbatchconflict--${batch.id}.json`));
    else {
      const fence = await fixture.store.get('cloudbatchconflict', batch.id);
      if (mode === 'hash_changed') fence.detected_at = '2026-01-01T00:00:00Z';
      if (mode === 'different_batch') fence.batch_plan_hash = 'f'.repeat(64);
      if (mode === 'different_job_plan') fence.job_bindings[0].plan_hash = 'f'.repeat(64);
      if (mode !== 'hash_changed') { const { receipt_hash: _old, ...fields } = fence; fence.receipt_hash = hash(fields); }
      await fixture.store.put('cloudbatchconflict', batch.id, fence);
    }
    const expected = mode === 'missing' ? 'BATCH_CONFLICT_LEDGER_INCOMPLETE' : 'BATCH_CONFLICT_TAMPERED';
    const restarted = await CloudCoordinator.create(fixture.config);
    await assert.rejects(restarted.inspectBatch(batch.id), { code: expected });
    await assert.rejects(restarted.resumeBatch(batch.id, batch.plan_hash, 100), { code: expected });
    await assert.rejects(restarted.inspectJob(batch.variants[0].job_id), { code: expected });
    assert.equal(fixture.automation.calls.workitems, 2);
  }
});

test('a completed known validator failure can be retried explicitly without a workitem replay', async t => {
  let validationCalls = 0;
  const fixture = await setup(t, { coordinator: { validateOutputs: async job => { if (++validationCalls === 1) throw new Error('Synthetic read failure'); return validation(job); } } });
  const batch = await fixture.coordinator.prepareBatch(request({ variants: request().variants.slice(0, 1) })), first = await resume(fixture, batch, 1), variant = first.variants[0];
  fixture.automation.states.set(variant.provider_id, 'validating');
  await assert.rejects(fixture.coordinator.validateJob(variant.job_id), { code: 'VALIDATION_FAILED' });
  assert.equal((await fixture.store.get('cloudjob', variant.job_id)).validation_in_progress, undefined);
  assert.equal((await fixture.coordinator.validateJob(variant.job_id)).status, 'succeeded');
  assert.equal(validationCalls, 2); assert.equal(fixture.automation.calls.workitems, 1);
});

test('batch reporting stays bounded at 100 populated variants with large stored receipts', async t => {
  const fixture = await setup(t, { budget: { maxConcurrentJobs: 100, maxSubmissions: 100, maxReservedUnits: 1000 } });
  const input = request({ variants: Array.from({ length: 100 }, (_, index) => ({ variant_id: `variant-${index + 1}`, inputs: { width: index + 1, label: 'x'.repeat(8192) } })) });
  const batch = await fixture.coordinator.prepareBatch(input), manifest = await stored(fixture, batch), hashes = [];
  // Seed internally consistent synthetic terminal ledger fixtures. This tests
  // reporting already-recorded evidence, not service execution or CAD validity.
  for (const [index, variant] of manifest.variants.entries()) {
    const job = { ...variant.initial_job, status: index === 99 ? 'failed' : 'succeeded', submitted: true, idempotency_key: variant.idempotency_key, provider_id: `synthetic-report-${index}`, reserved_units: 4 };
    job.provider = status(job.provider_id, 'validating');
    const receipt = validation(job);
    receipt.artifacts = Array.from({ length: 100 }, (_, artifact) => ({ artifact_id: `artifact:${'a'.repeat(1700)}:${job.id}:${artifact}`, sha256: 'a'.repeat(64), bytes: 1 }));
    if (index === 99) receipt.checks[1].outcome = 'failed';
    job.validation = { ...receipt, receipt_hash: hash(receipt) };
    if (index % 2 === 0) { const settled = billing(job); job.settlement = { ...settled, receipt_hash: hash(settled) }; job.reserved_units = 0; }
    hashes.push({ validation: job.validation.receipt_hash, settlement: job.settlement?.receipt_hash ?? null });
    await fixture.store.put('cloudjob', job.id, job);
  }
  const calls = { ...fixture.automation.calls }, put = fixture.store.put.bind(fixture.store); let writes = 0;
  fixture.store.put = async (...args) => { writes++; return put(...args); };
  const result = await fixture.coordinator.inspectBatch(batch.id);
  assertJson(result, 4_194_304);
  assert.equal(result.variants.length, 100); assert.equal(result.progress.succeeded, 99); assert.equal(result.progress.failed, 1);
  assert.equal(result.all_outputs_validated, false); assert.equal(result.billing_settled, false);
  for (const [index, variant] of result.variants.entries()) {
    assert.equal(variant.validation.kind, 'validation_receipt_summary');
    assert.equal(variant.validation.receipt_hash, hashes[index].validation); assert.equal(variant.validation.artifact_count, 100);
    assert.deepEqual(variant.validation.check_counts, { total: 2, passed: index === 99 ? 1 : 2, failed: index === 99 ? 1 : 0 });
    assert.equal(variant.validation.full_receipt_included, false); assert.equal(variant.validation.inspect_job_id, variant.job_id);
    assert.equal(variant.inputs, null); assert.equal(variant.input_summary.inline_complete, false);
    assert.equal(variant.input_summary.sha256, hash(input.variants[index].inputs)); assert.equal(variant.input_summary.field_count, 2);
    if (index % 2 === 0) { assert.equal(variant.settlement.kind, 'billing_receipt_summary'); assert.equal(variant.settlement.receipt_hash, hashes[index].settlement); assert.equal(variant.settlement.actual_amount, 4); }
    else assert.equal(variant.settlement, null);
  }
  const detailed = await fixture.coordinator.inspectJob(result.variants[0].job_id);
  assert.equal(detailed.validation.artifacts.length, 100); assert.equal(detailed.validation.receipt_hash, hashes[0].validation);
  const client = await wireClient(t, fixture);
  const wire = await client.callTool({ name: 'fusion_cloud_batch_inspect', arguments: { batch_id: batch.id } });
  assert.equal(wire.isError, undefined); assertJson(wire.structuredContent, 4_194_304);
  assert.equal(wire.structuredContent.variants.length, 100); assert.equal(wire.structuredContent.variants[0].validation.receipt_hash, hashes[0].validation);
  assert.deepEqual(fixture.automation.calls, calls, 'Inspection must not poll or submit a provider job');
  assert.equal(writes, 0, 'Summaries do not rewrite the stored evidence');
});

test('large common context, destination metadata and warnings use explicit complete-hash references', async t => {
  const fixture = await setup(t, { provider: { prepare: fields => ({ ...fields, destination: { ...fields.destination, annotation: 'd'.repeat(9000) }, warnings: Array.from({ length: 20 }, () => 'w'.repeat(2048)) }) } });
  const sources = Array.from({ length: 100 }, (_, index) => ({ hubId: 'hub-1', projectId: 'project-1', itemId: `item-${index}-${'i'.repeat(500)}`, versionId: `version-${index}-${'v'.repeat(500)}`, configurationId: `configuration-${index}`, resourceHash: 'c'.repeat(64) }));
  const input = request({ context: { ...context(), sources }, variants: request().variants.slice(0, 1) });
  const batch = await fixture.coordinator.prepareBatch(input), manifest = await stored(fixture, batch), initial = manifest.variants[0].initial_job;
  assertJson(batch, 4_194_304);
  assert.equal(batch.context, null); assert.equal(batch.context_summary.inline_complete, false); assert.equal(batch.context_summary.source_count, 100);
  assert.equal(batch.context_summary.sha256, hash(input.context)); assert.equal(batch.context_summary.inspect_job_id, initial.id);
  assert.equal(batch.destination, null); assert.equal(batch.destination_summary.inline_complete, false);
  assert.equal(batch.destination_summary.sha256, hash(initial.prepared.destination));
  assert.equal(batch.prepared_warning_summary.total_count, 20); assert.equal(batch.prepared_warning_summary.inline_count, 0);
  assert.equal(batch.prepared_warning_summary.inline_complete, false); assert.equal(batch.prepared_warning_summary.sha256, hash(initial.prepared.warnings));
  assert.equal(batch.variants[0].input_summary.inline_complete, true); assert.deepEqual(batch.variants[0].inputs, input.variants[0].inputs);
  const full = await fixture.coordinator.inspectJob(initial.id);
  assert.equal(full.prepared.context.sources.length, 100); assert.equal(full.prepared.warnings.length, 20);
  assert.equal(full.prepared.destination.annotation.length, 9000); assert.equal(fixture.automation.calls.submit, 0); assert.equal(fixture.automation.calls.status, 0);
});

test('another job and reconciled actual cost can exhaust the shared budget between batch waves', async t => {
  const fixture = await setup(t, { budget: { maxReservedUnits: 15 }, coordinator: { reconcileBilling: async job => billing(job, 12) } });
  const batch = await fixture.coordinator.prepareBatch(request());
  const first = await resume(fixture, batch, 1), done = first.variants[0];
  fixture.automation.states.set(done.provider_id, 'failed');
  await fixture.coordinator.settleJob(done.job_id);
  const blocked = await resume(fixture, batch);
  assert.equal(blocked.wave.admission_blocked.code, 'BUDGET_EXHAUSTED');
  assert.deepEqual(blocked.wave.attempted_variant_ids, []); assert.equal(blocked.progress.prepared, 2);
  assert.equal(fixture.automation.calls.workitems, 1);
});

test('a competing standalone job consumes the same total-submission pool as prepared batch children', async t => {
  const fixture = await setup(t, { budget: { maxSubmissions: 3, maxConcurrentJobs: 10 } });
  const batch = await fixture.coordinator.prepareBatch(request());
  const other = await fixture.coordinator.prepareJob('batch-protocol-only', { width: 50 }, { ...context(), variantCount: 1 });
  await fixture.coordinator.submitJob(other.id, other.plan_hash, 'standalone-business-request');
  const result = await resume(fixture, batch);
  assert.deepEqual(result.wave.attempted_variant_ids, ['variant-1', 'variant-2']);
  assert.equal(result.wave.admission_blocked.code, 'BUDGET_EXHAUSTED');
  assert.equal(result.variants[2].status, 'prepared'); assert.equal(result.variants[2].submitted, false);
  assert.equal(fixture.automation.calls.workitems, 3);
});

test('durable whole-batch and per-job intent exist before any synthetic workitem call', async t => {
  const fixture = await setup(t);
  let batch;
  const submit = fixture.automation.submit.bind(fixture.automation);
  fixture.automation.submit = async prepared => {
    const manifest = await stored(fixture, batch);
    assert.equal(manifest.phase, 'ready');
    const jobs = await fixture.store.list('cloudjob'); assert.equal(jobs.length, 3);
    const current = jobs.find(job => job.prepared.id === prepared.id);
    assert.equal(current.status, 'submitting'); assert.equal(current.submitted, true); assert.equal(current.reserved_units, 4);
    assert.equal(fixture.automation.calls.prepare, 3);
    assert.ok((await fixture.store.list('idempotency')).some(item => item.job_id === current.id));
    return submit(prepared);
  };
  batch = await fixture.coordinator.prepareBatch(request());
  await resume(fixture, batch, 1);
});

async function wireClient(t, fixture) {
  const server = createFusionServer({ profile: fixture.profile, engine: { store: fixture.store }, cloud: fixture.coordinator, root: '/unused', close: async () => {} });
  const client = new Client({ name: 'batch-protocol-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('MCP exposes strict batch tools and redacts raw credentials and signed URLs in returned manifests', async t => {
  const fixture = await setup(t, { provider: { prepare: fields => ({ ...fields, accessToken: 'PRIVATE_ACCESS_TOKEN', warnings: ['Bearer PRIVATE_BEARER', 'https://artifacts.example/result?X-Amz-Signature=PRIVATE_SIGNED_QUERY'] }), beforeSubmit: async () => { throw new CloudError('OUTCOME_UNKNOWN', 'PRIVATE_RAW_SECRET https://logs.example/?sig=PRIVATE_REPORT', 'unknown'); } } });
  const client = await wireClient(t, fixture);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of ['fusion_cloud_batch_prepare', 'fusion_cloud_batch_inspect', 'fusion_cloud_batch_resume']) assert.ok(names.includes(name));
  const bad = await client.callTool({ name: 'fusion_cloud_batch_prepare', arguments: request({ approved: true }) });
  assert.equal(bad.isError, true); assert.equal(fixture.automation.calls.prepare, 0);
  const prepared = await client.callTool({ name: 'fusion_cloud_batch_prepare', arguments: request() });
  assert.equal(prepared.isError, undefined); assert.equal(JSON.stringify(prepared).includes('PRIVATE_'), false);
  const batch = prepared.structuredContent;
  const invalid = await client.callTool({ name: 'fusion_cloud_batch_resume', arguments: { batch_id: batch.id, plan_hash: batch.plan_hash, max_submissions: 101, approved: true } });
  assert.equal(invalid.isError, true); assert.equal(fixture.automation.calls.submit, 0);
  const result = await client.callTool({ name: 'fusion_cloud_batch_resume', arguments: { batch_id: batch.id, plan_hash: batch.plan_hash, max_submissions: 1 } });
  assert.equal(result.isError, undefined); assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  assert.equal(result.structuredContent.variants[0].status, 'outcome_unknown');
  const inspected = await client.callTool({ name: 'fusion_cloud_batch_inspect', arguments: { batch_id: batch.id } });
  assert.equal(inspected.isError, undefined); assert.equal(JSON.stringify(inspected).includes('PRIVATE_'), false);
});

test('preparation provider diagnostics cannot leak raw secrets or signed URLs through MCP errors', async t => {
  const fixture = await setup(t, { provider: { prepare: () => { throw new CloudError('INVALID_RESPONSE', 'PRIVATE_RAW_TOKEN https://artifact.example/?sig=PRIVATE_SIGNATURE'); } } });
  const client = await wireClient(t, fixture);
  const result = await client.callTool({ name: 'fusion_cloud_batch_prepare', arguments: request() });
  assert.equal(result.isError, true); assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  assert.equal(result.structuredContent.error.code, 'BATCH_PREFLIGHT_FAILED');
  assert.equal(fixture.automation.calls.workitems, 0);
});
