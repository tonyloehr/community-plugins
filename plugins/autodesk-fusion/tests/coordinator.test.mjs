import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, writeFile, appendFile, chmod, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { CloudCoordinator, RecordStore, MemoryTokenStore, NativeTokenStore, CloudError, FusionError, parseProfile, hash, hashBytes, cloudHash, createFusionServer, verifyTrustedExecutableAsset, APS_ORIGIN } from '../dist/index.mjs';

// Synthetic provider contracts below are not evidence of Autodesk credentials, engine execution or invoices.
const future = () => new Date(Date.now() + 3_600_000).toISOString();
const context = () => ({ tenantId: 'enterprise-a', sources: [], destinationAlias: 'quarantine', variantCount: 1 });
const mfgContext = () => ({ modelId: 'model-1', timestamp: new Date().toISOString(), composition: 'AS_SAVED', configurationId: null });
const status = (providerId, state = 'queued') => ({ providerId, providerStatus: state === 'validating' ? 'success' : state, status: state, completionConfirmed: ['validating', 'failed', 'cancelled'].includes(state), validationRequired: state === 'validating', cancelSupported: ['queued', 'running'].includes(state), observedAt: new Date().toISOString(), statistics: {} });
function profileFor(directory, changes = {}) {
  const raw = { version: 1, id: 'coordinator-fixture', mode: 'assisted', stateRoot: directory, policy: { mutationsEnabled: true, effects: ['cloud_compute', 'cloud_write'], operations: ['cloud.job_submit', 'cloud.job_cancel', 'mfg.property_set'], grantExpiresAt: future(), allowNonAtomicCloudWrites: true }, cloud: { clientId: 'test-public-client', tenantId: 'enterprise-a', scopes: ['data:read', 'data:write', 'code:all'], redirectUri: 'http://127.0.0.1:8765/callback', hubIds: ['hub-a'], projects: [{ hubId: 'hub-a', projectId: 'project-a' }], mfgModels: [{ hubId: 'hub-a', projectId: 'project-a', modelId: 'model-1' }], budget: { maxConcurrentJobs: 2, maxSubmissions: 10, maxReservedUnits: 10, currency: 'USD', period: 'period-a' } } };
  return parseProfile({ ...raw, ...changes });
}
function provider(overrides = {}) {
  const calls = { prepare: 0, submit: 0, status: 0, cancel: 0 };
  let state = 'queued';
  return {
    calls,
    setState(value) { state = value; },
    listRecipes() { return [{ id: 'test-recipe', version: '1', verification: { procedure: 'Synthetic verification contract only.', validatorIds: ['dimensional-check', 'format-check'] }, limits: { maxOutputBytes: 10000 } }]; },
    async prepare(recipeId, inputs, contextValue) {
      calls.prepare++;
      const fields = { id: `fixture-request-${calls.prepare}`, recipeId, recipeVersion: '1', recipeHash: '1'.repeat(64), inputs, context: contextValue, activity: { reference: 'fixture.Test+v1', version: 1, engine: 'Autodesk.Fusion+Latest', definitionHash: '2'.repeat(64), bundles: [], observedAt: new Date().toISOString(), rollingEngine: true, aliasRacePossible: true }, destination: { alias: 'quarantine', kind: 'object_storage', origin: 'https://artifacts.example', keyPrefix: '/tenant/quarantine/' }, reservation: { amount: 4, currency: 'USD', kind: 'estimated', hardCap: false }, createdAt: new Date().toISOString(), expiresAt: future(), warnings: ['Synthetic test contract; no provider job created.'] };
      return { ...fields, requestHash: cloudHash(fields) };
    },
    async submit(prepared) { calls.submit++; return status(`provider-${prepared.id}`); },
    async status(id) { calls.status++; return status(id, state); },
    async cancel(id) { calls.cancel++; return { providerId: id, status: 'cancel_requested', completionConfirmed: false, reservationMustRemain: true }; },
    ...overrides,
  };
}
function apsFor(profile, overrides = {}) {
  const cloud = profile.cloud;
  return {
    scope: { tenantId: cloud.tenantId, hubIds: cloud.hubIds, projects: cloud.projects, mfgModels: cloud.mfgModels },
    async prepareMfgPropertyChange(contextValue, propertyDefinitionId, after) { return { status: 'draft', context: contextValue, componentId: 'component-1', propertyDefinitionId, before: 'old', after, observationHash: '3'.repeat(64), ruleHash: '4'.repeat(64), documentHash: '5'.repeat(64), draftHash: '6'.repeat(64), requiresApproval: true, atomicConcurrency: false }; },
    async executeMfgPropertyChange(_draft, authority) { await authority.authorize(); return { status: 'verified', outcome: 'verified' }; },
    ...overrides,
  };
}
async function setup(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fusion-coordinator-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const profile = options.profile ?? profileFor(directory);
  const store = new RecordStore(directory); await store.init();
  const automation = options.automation ?? provider();
  let binding = 'synthetic-account-session-a';
  const config = { profile, root: '/unused', store, tokenStore: new MemoryTokenStore(), aps: apsFor(profile), automation, authorizationBinding: async () => binding, ...options, profile: { ...profile, stateRoot: directory }, store };
  const coordinator = await CloudCoordinator.create(config);
  return { directory, profile: config.profile, store, automation, coordinator, config, switchAccount: value => { binding = value; } };
}
async function prepare(coordinator) { return coordinator.prepareJob('test-recipe', { size: 2 }, context()); }
const validationReceipt = job => ({ job_id: job.id, provider_id: job.provider_id, request_hash: job.prepared.requestHash, recipe_hash: job.prepared.recipeHash, observed_at: new Date().toISOString(), artifacts: [{ artifact_id: 'fixture-artifact:1', sha256: 'a'.repeat(64), bytes: 100 }], checks: [{ validator_id: 'dimensional-check', outcome: 'passed', evidence_ref: 'fixture-check:dimensions' }, { validator_id: 'format-check', outcome: 'passed', evidence_ref: 'fixture-check:format' }] });
const billingReceipt = (job, actual = 3) => ({ job_id: job.id, provider_id: job.provider_id, request_hash: job.prepared.requestHash, currency: 'USD', actual_amount: actual, observed_at: new Date().toISOString(), evidence_ref: 'fixture-invoice:line-1', source: 'provider_invoice', final: true });

test('durable intent and reservation precede submission; replay uses the original result', async t => {
  const fixture = await setup(t);
  const plan = await prepare(fixture.coordinator);
  fixture.automation.submit = async prepared => {
    fixture.automation.calls.submit++;
    const stored = await fixture.store.get('cloudjob', plan.id);
    assert.equal(stored.status, 'submitting');
    assert.equal(stored.reserved_units, 4);
    assert.equal(stored.submitted, true);
    assert.equal((await fixture.store.list('idempotency')).length, 1);
    return status(`provider-${prepared.id}`);
  };
  const result = await fixture.coordinator.submitJob(plan.id, plan.plan_hash, 'business-request-1');
  assert.equal(result.status, 'queued');
  assert.deepEqual(await fixture.coordinator.submitJob(plan.id, plan.plan_hash, 'business-request-1'), result);
  assert.equal(fixture.automation.calls.submit, 1);
  const other = await prepare(fixture.coordinator);
  await assert.rejects(fixture.coordinator.submitJob(other.id, other.plan_hash, 'business-request-1'), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('unknown outcomes survive restart, retain budgets and never dispatch the same intent twice', async t => {
  const fixture = await setup(t, { automation: provider({ async submit() { this.calls.submit++; throw new CloudError('OUTCOME_UNKNOWN', 'Acknowledgement lost after provider accepted.', 'unknown'); } }) });
  const first = await prepare(fixture.coordinator);
  const failed = await fixture.coordinator.submitJob(first.id, first.plan_hash, 'unknown-request-1');
  assert.equal(failed.status, 'outcome_unknown');
  assert.equal(failed.reserved_units, 4);
  const restarted = await CloudCoordinator.create(fixture.config);
  assert.equal((await restarted.submitJob(first.id, first.plan_hash, 'unknown-request-1')).status, 'outcome_unknown');
  assert.equal(fixture.automation.calls.submit, 1);
  const second = await prepare(restarted);
  await restarted.submitJob(second.id, second.plan_hash, 'unknown-request-2');
  const third = await prepare(restarted);
  await assert.rejects(restarted.submitJob(third.id, third.plan_hash, 'unknown-request-3'), { code: 'BUDGET_EXHAUSTED' });
});

test('crash after persisted submitting intent cannot silently release reservations or retry', async t => {
  const fixture = await setup(t);
  const plan = await prepare(fixture.coordinator);
  plan.status = 'submitting'; plan.reserved_units = 4; plan.submitted = true; plan.idempotency_key = 'crashed-request-1';
  await fixture.store.put('cloudjob', plan.id, plan);
  const resumed = await fixture.coordinator.submitJob(plan.id, plan.plan_hash, 'crashed-request-1');
  assert.equal(resumed.status, 'outcome_unknown');
  assert.equal(resumed.reserved_units, 4);
  assert.equal(fixture.automation.calls.submit, 0);
});

test('separate coordinator processes cannot dispatch the same shared-ledger intent concurrently', async t => {
  const fixture = await setup(t);
  const job = await prepare(fixture.coordinator);
  const entry = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.mjs')).href;
  const worker = `
    import { appendFile } from 'node:fs/promises';
    const { CloudCoordinator, RecordStore, MemoryTokenStore } = await import(process.argv[1]);
    const profile = JSON.parse(process.argv[2]);
    const store = new RecordStore(profile.stateRoot);
    const coordinator = await CloudCoordinator.create({ profile, root: '/unused', store, tokenStore: new MemoryTokenStore(), aps: { scope: { tenantId: profile.cloud.tenantId, hubIds: profile.cloud.hubIds, projects: profile.cloud.projects, mfgModels: profile.cloud.mfgModels } }, authorizationBinding: async () => 'synthetic-account-session-a', automation: { listRecipes: () => [], submit: async prepared => {
      await appendFile(process.argv[5], 'dispatch\\n');
      await new Promise(resolve => setTimeout(resolve, 80));
      return { providerId: 'provider-child', providerStatus: 'pending', status: 'queued', completionConfirmed: false, validationRequired: false, cancelSupported: false, observedAt: new Date().toISOString(), statistics: {} };
    } } });
    try { const result = await coordinator.submitJob(process.argv[3], process.argv[4], 'concurrent-cloud-key'); process.stdout.write(JSON.stringify({ status: result.status })); }
    catch (error) { process.stdout.write(JSON.stringify({ code: error.code })); }
  `;
  const log = path.join(fixture.directory, 'provider-dispatch.log');
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker, entry, JSON.stringify(fixture.profile), job.id, job.plan_hash, log], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
  const results = await Promise.all([run(), run()]);
  assert.equal(results.filter(result => result.status === 'queued').length >= 1, true);
  assert.ok(results.every(result => result.status === 'queued' || result.code === 'EXECUTION_LOCKED'));
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 1);
});

test('tenant/profile reuse, account switch and modified scope cannot expose or execute prior jobs', async t => {
  const fixture = await setup(t);
  const job = await prepare(fixture.coordinator);
  fixture.switchAccount('synthetic-account-session-b');
  await assert.rejects(fixture.coordinator.inspectJob(job.id), { code: 'ACCOUNT_CHANGED' });
  await assert.rejects(fixture.coordinator.submitJob(job.id, job.plan_hash, 'wrong-account-key'), { code: 'ACCOUNT_CHANGED' });
  const changed = profileFor(fixture.directory, { id: 'another-profile' });
  const other = await CloudCoordinator.create({ ...fixture.config, profile: changed, aps: apsFor(changed) });
  await assert.rejects(other.inspectJob(job.id), { code: 'JOB_SCOPE_DENIED' });
  await assert.rejects(other.jobStatus(job.id), { code: 'JOB_SCOPE_DENIED' });
  assert.equal(fixture.automation.calls.submit, 0);
});

test('profile kill switch and an expired scoped grant stop cloud writes before provider dispatch', async t => {
  const fixture = await setup(t);
  const filename = path.join(fixture.directory, 'profile.json');
  await writeFile(filename, JSON.stringify(fixture.profile), { mode: 0o600 });
  const coordinator = await CloudCoordinator.create({ ...fixture.config, profileFile: filename });
  const job = await prepare(coordinator);
  await writeFile(filename, JSON.stringify({ ...fixture.profile, policy: { ...fixture.profile.policy, mutationsEnabled: false } }));
  await assert.rejects(coordinator.submitJob(job.id, job.plan_hash, 'disabled-profile-key'), { code: 'PROFILE_CHANGED' });
  const expired = { ...fixture.profile, policy: { ...fixture.profile.policy, grantExpiresAt: '2020-01-01T00:00:00Z' } };
  const other = await CloudCoordinator.create({ ...fixture.config, profile: expired });
  const expiredJob = await prepare(other);
  await assert.rejects(other.submitJob(expiredJob.id, expiredJob.plan_hash, 'expired-profile-key'), { code: 'GRANT_EXPIRED' });
  assert.equal(fixture.automation.calls.submit, 0);
});

test('provider success stays validating until trusted exact-job output receipts satisfy every validator', async t => {
  let validations = 0;
  const fixture = await setup(t, { validateOutputs: async job => { validations++; return validationReceipt(job); } });
  const job = await prepare(fixture.coordinator);
  await fixture.coordinator.submitJob(job.id, job.plan_hash, 'validate-output-key');
  fixture.automation.setState('validating');
  assert.equal((await fixture.coordinator.jobStatus(job.id)).status, 'validating');
  const done = await fixture.coordinator.validateJob(job.id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.validation.artifacts[0].sha256, 'a'.repeat(64));
  assert.equal(done.reserved_units, 4, 'Output validation does not invent billing settlement');
  assert.equal((await fixture.coordinator.jobStatus(job.id)).status, 'succeeded', 'Later provider polling cannot erase completed output validation');
  assert.equal((await fixture.coordinator.validateJob(job.id)).status, 'succeeded');
  assert.equal(validations, 1);
});

test('missing, mismatched or incomplete validation evidence cannot convert provider success to plugin success', async t => {
  for (const mutate of [receipt => ({ ...receipt, provider_id: 'other-job' }), receipt => ({ ...receipt, checks: receipt.checks.slice(0, 1) }), receipt => ({ ...receipt, artifacts: [{ ...receipt.artifacts[0], bytes: 10001 }] }), receipt => ({ ...receipt, access_token: 'PRIVATE_TOKEN' }), receipt => ({ ...receipt, observed_at: '2000-01-01T00:00:00Z' })]) {
    const fixture = await setup(t, { validateOutputs: async job => mutate(validationReceipt(job)) });
    const job = await prepare(fixture.coordinator);
    await fixture.coordinator.submitJob(job.id, job.plan_hash, 'invalid-validation-key'); fixture.automation.setState('validating');
    await assert.rejects(fixture.coordinator.validateJob(job.id), error => error.code === 'INVALID_VALIDATION_EVIDENCE' && !error.message.includes('PRIVATE_TOKEN'));
    assert.equal((await fixture.coordinator.inspectJob(job.id)).validation, undefined);
  }
  const fixture = await setup(t);
  const job = await prepare(fixture.coordinator);
  await assert.rejects(fixture.coordinator.validateJob(job.id), { code: 'VALIDATION_NOT_CONFIGURED' });
});

test('failed validation remains failed even when the provider reports successful compute', async t => {
  const fixture = await setup(t, { validateOutputs: async job => { const receipt = validationReceipt(job); receipt.checks[0].outcome = 'failed'; return receipt; } });
  const job = await prepare(fixture.coordinator);
  await fixture.coordinator.submitJob(job.id, job.plan_hash, 'failed-validation-key'); fixture.automation.setState('validating');
  assert.equal((await fixture.coordinator.validateJob(job.id)).status, 'failed');
  assert.equal((await fixture.coordinator.jobStatus(job.id)).status, 'failed');
});

test('trusted final billing receipts settle actual cost once and account for overruns', async t => {
  let billingCalls = 0;
  const fixture = await setup(t, { reconcileBilling: async job => { billingCalls++; return billingReceipt(job, 9); } });
  const job = await prepare(fixture.coordinator);
  await fixture.coordinator.submitJob(job.id, job.plan_hash, 'settle-billing-key');
  await assert.rejects(fixture.coordinator.settleJob(job.id), { code: 'PROVIDER_NOT_COMPLETE' });
  fixture.automation.setState('failed');
  const settled = await fixture.coordinator.settleJob(job.id);
  assert.equal(settled.settlement.actual_amount, 9);
  assert.equal(settled.reserved_units, 0);
  assert.equal((await fixture.coordinator.settleJob(job.id)).settlement.receipt_hash, settled.settlement.receipt_hash);
  assert.equal(billingCalls, 1);
  const next = await prepare(fixture.coordinator);
  await assert.rejects(fixture.coordinator.submitJob(next.id, next.plan_hash, 'overrun-next-key'), { code: 'BUDGET_EXHAUSTED' });
});

test('unknown and cancellation-requested jobs retain reservations; billing integration cannot supply an arbitrary amount', async t => {
  for (const mutate of [receipt => ({ ...receipt, actual_amount: -1 }), receipt => ({ ...receipt, currency: 'EUR' }), receipt => ({ ...receipt, provider_id: 'another-job' }), receipt => ({ ...receipt, source: 'model_estimate' }), receipt => ({ ...receipt, final: false }), receipt => ({ ...receipt, evidence_ref: 'https://invoices.example/?token=PRIVATE' })]) {
    const fixture = await setup(t, { reconcileBilling: async job => mutate(billingReceipt(job)) });
    const job = await prepare(fixture.coordinator);
    await fixture.coordinator.submitJob(job.id, job.plan_hash, 'invalid-billing-key'); fixture.automation.setState('cancelled');
    await assert.rejects(fixture.coordinator.settleJob(job.id), { code: 'INVALID_BILLING_EVIDENCE' });
    assert.equal((await fixture.coordinator.inspectJob(job.id)).reserved_units, 4);
  }
  const fixture = await setup(t, { reconcileBilling: async job => billingReceipt(job) });
  const job = await prepare(fixture.coordinator); await fixture.coordinator.submitJob(job.id, job.plan_hash, 'cancel-then-settle-key');
  await fixture.coordinator.cancelJob(job.id);
  assert.equal((await fixture.coordinator.jobStatus(job.id)).status, 'cancel_requested');
  await assert.rejects(fixture.coordinator.settleJob(job.id), { code: 'PROVIDER_NOT_COMPLETE' });
  assert.equal((await fixture.coordinator.inspectJob(job.id)).reserved_units, 4);
});

test('unbilled prior-period jobs still count as exposure after a period rollover', async t => {
  const fixture = await setup(t);
  for (let i = 0; i < 2; i++) { const job = await prepare(fixture.coordinator); await fixture.coordinator.submitJob(job.id, job.plan_hash, `previous-period-${i}`); fixture.automation.setState('failed'); await fixture.coordinator.jobStatus(job.id); }
  const nextProfile = { ...fixture.profile, cloud: { ...fixture.profile.cloud, budget: { ...fixture.profile.cloud.budget, period: 'period-b' } } };
  const next = await CloudCoordinator.create({ ...fixture.config, profile: nextProfile });
  const job = await prepare(next);
  await assert.rejects(next.submitJob(job.id, job.plan_hash, 'new-period-budget-key'), { code: 'BUDGET_EXHAUSTED' });
});

test('data plans preserve verified, unverified and partial statuses and bind account identity', async t => {
  for (const [response, expected] of [[{ status: 'verified', outcome: 'verified' }, 'succeeded'], [{ status: 'submitted', outcome: 'unverified' }, 'outcome_unknown'], [{ status: 'partial_failure', outcome: 'partial' }, 'failed']]) {
    const fixture = await setup(t);
    let writes = 0;
    fixture.config.aps.executeMfgPropertyChange = async (_draft, authority) => { await authority.authorize(); writes++; return response; };
    const plan = await fixture.coordinator.prepareProperty(mfgContext(), 'property-1', 'new', false);
    const result = await fixture.coordinator.executeDataPlan(plan.id, plan.hash, 'data-plan-key-1');
    assert.equal(result.status, expected);
    assert.equal((await fixture.coordinator.executeDataPlan(plan.id, plan.hash, 'data-plan-key-1')).status, expected);
    assert.equal(writes, 1);
    fixture.switchAccount('account-changed');
    await assert.rejects(fixture.coordinator.inspectDataPlan(plan.id), { code: 'ACCOUNT_CHANGED' });
  }
});

test('native vault reconciles lost manifest acknowledgement without deleting the published token chunks', async t => {
  const lockRoot = await mkdtemp(path.join(os.tmpdir(), 'fusion-vault-acknowledgement-')); t.after(() => rm(lockRoot, { recursive: true, force: true }));
  const values = new Map(); let failManifestAfterWrite = false;
  const factory = (service, key) => ({ getPassword: async () => values.get(`${service}/${key}`), setPassword: async value => { values.set(`${service}/${key}`, value); if (failManifestAfterWrite && !key.includes('.')) throw new Error('OS acknowledgement lost PRIVATE_TOKEN'); }, deleteCredential: async () => values.delete(`${service}/${key}`) });
  const vault = new NativeTokenStore('/unused', factory, { lockRoot }), key = hash('credential-fixture');
  const original = { accessToken: 'a'.repeat(2200), refreshToken: 'old-refresh', obtainedAt: 1, expiresAt: 100, scopes: ['data:read'], tenantId: 'tenant', issuer: 'https://developer.api.autodesk.com', resource: 'https://developer.api.autodesk.com', grantType: 'authorization_code' };
  await vault.set(key, original);
  failManifestAfterWrite = true;
  const refreshed = { ...original, accessToken: 'b'.repeat(2400), refreshToken: 'new-refresh' };
  await vault.set(key, refreshed);
  assert.deepEqual(await vault.get(key), refreshed);
  await vault.delete(key);
  assert.equal(values.size, 0);
});

test('unreconciled vault publication retains chunks and emits no credential-bearing native errors', async t => {
  const lockRoot = await mkdtemp(path.join(os.tmpdir(), 'fusion-vault-uncertain-')); t.after(() => rm(lockRoot, { recursive: true, force: true }));
  const values = new Map(); let uncertain = false;
  const factory = (service, key) => ({ getPassword: async () => { if (uncertain && !key.includes('.')) throw Object.assign(new Error('PRIVATE_TOKEN manifest unavailable'), { code: 'RAW_NATIVE_ERROR' }); return values.get(`${service}/${key}`); }, setPassword: async value => { values.set(`${service}/${key}`, value); if (!key.includes('.')) { uncertain = true; throw new Error('PRIVATE_TOKEN acknowledgement lost'); } }, deleteCredential: async () => values.delete(`${service}/${key}`) });
  const vault = new NativeTokenStore('/unused', factory, { lockRoot }), key = hash('vault-uncertainty');
  const grant = { accessToken: 'PRIVATE_TOKEN'.repeat(200), refreshToken: 'refresh', obtainedAt: 1, expiresAt: 100, scopes: ['data:read'], tenantId: 'tenant', issuer: 'https://developer.api.autodesk.com', resource: 'https://developer.api.autodesk.com', grantType: 'authorization_code' };
  await assert.rejects(vault.set(key, grant), error => error.code === 'CREDENTIAL_WRITE_OUTCOME_UNKNOWN' && !error.message.includes('PRIVATE_TOKEN'));
  assert.ok(values.size > 1, 'Potentially published chunks remain in the OS vault until acknowledgement is reconciled');
  uncertain = false;
  assert.deepEqual(await vault.get(key), grant);
  await vault.delete(key);
});

test('persistent grant leases prevent concurrent refresh critical sections and are scoped per opaque grant', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fusion-vault-lock-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const factory = () => ({ getPassword: async () => undefined, setPassword: async () => {}, deleteCredential: async () => false });
  const one = new NativeTokenStore('/unused', factory, { lockRoot: directory }), two = new NativeTokenStore('/unused', factory, { lockRoot: directory });
  const key = hash('one-grant');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const first = one.withLock(key, async () => { entered(); await gate; });
  await ready;
  await assert.rejects(two.withLock(key, async () => assert.fail('must not enter')), { code: 'CREDENTIAL_STORE_BUSY' });
  await two.withLock(hash('different-grant'), async () => {});
  release(); await first;
  await two.withLock(key, async () => {});
});

test('a persisted refresh intent blocks a restarted vault instance until a new grant is confirmed', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fusion-refresh-fence-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const values = new Map();
  const factory = (service, key) => ({ getPassword: async () => values.get(`${service}/${key}`), setPassword: async value => { values.set(`${service}/${key}`, value); }, deleteCredential: async () => values.delete(`${service}/${key}`) });
  const key = hash('crashed-refresh-grant');
  const vault = new NativeTokenStore('/unused', factory, { lockRoot: directory });
  const old = { accessToken: 'OLD_ACCESS_SECRET', refreshToken: 'OLD_REFRESH_SECRET', obtainedAt: 1, expiresAt: 100, scopes: ['data:read'], tenantId: 'tenant', issuer: APS_ORIGIN, resource: APS_ORIGIN, grantType: 'authorization_code' };
  await vault.set(key, old);
  await vault.withLock(key, async () => { await vault.markRefreshPending(key); /* Simulate a process exiting after dispatch, before a provider/vault receipt. */ });
  const fence = await readFile(path.join(directory, key, 'refresh--intent.json'), 'utf8');
  assert.equal(fence.includes('SECRET'), false);
  const restarted = new NativeTokenStore('/unused', factory, { lockRoot: directory });
  await assert.rejects(restarted.get(key), { code: 'REAUTHENTICATION_REQUIRED' });
  await restarted.set(key, { ...old, accessToken: 'NEW_ACCESS_SECRET', refreshToken: 'NEW_REFRESH_SECRET' });
  assert.equal((await restarted.get(key)).accessToken, 'NEW_ACCESS_SECRET');
  await restarted.delete(key);
});

test('lost cancellation acknowledgements persist intent, retain reservations and do not repeat the request', async t => {
  const fixture = await setup(t, { automation: provider({ async cancel() { this.calls.cancel++; throw new CloudError('OUTCOME_UNKNOWN', 'Provider acknowledgement was lost.', 'unknown'); } }) });
  const job = await prepare(fixture.coordinator); await fixture.coordinator.submitJob(job.id, job.plan_hash, 'cancel-unknown-once');
  assert.equal((await fixture.coordinator.cancelJob(job.id)).job.cancellation.acknowledgement, 'unknown');
  const restarted = await CloudCoordinator.create(fixture.config);
  assert.equal((await restarted.cancelJob(job.id)).job.reserved_units, 4);
  assert.equal(fixture.automation.calls.cancel, 1);
});

test('account changes during preparation discard the mixed-account observation before persisting a plan', async t => {
  const fixture = await setup(t);
  const original = fixture.automation.prepare;
  fixture.automation.prepare = async (...args) => { const prepared = await original.apply(fixture.automation, args); fixture.switchAccount('changed-during-network-read'); return prepared; };
  await assert.rejects(prepare(fixture.coordinator), { code: 'ACCOUNT_CHANGED' });
  assert.equal((await fixture.store.list('cloudjob')).length, 0);
  fixture.config.aps.prepareMfgPropertyChange = async () => { fixture.switchAccount('changed-during-property-read'); return { context: mfgContext() }; };
  await assert.rejects(fixture.coordinator.prepareProperty(mfgContext(), 'property-1', 'new'), { code: 'ACCOUNT_CHANGED' });
  assert.equal((await fixture.store.list('dataplan')).length, 0);
});

test('recipe trust is rechecked for changed contents, writable permissions and symlink replacement', async t => {
  const fixture = await setup(t);
  const filename = path.join(fixture.directory, 'reviewed-recipes.json');
  await writeFile(filename, '[]', { mode: 0o600 });
  const options = { ...fixture.config, profile: { ...fixture.profile, cloud: { ...fixture.profile.cloud, recipesFile: filename } } };
  const coordinator = await CloudCoordinator.create(options);
  await writeFile(filename, '[{"id":"changed"}]');
  await assert.rejects(coordinator.status(), { code: 'RECIPE_CHANGED' });
  await writeFile(filename, '[]'); await chmod(filename, 0o666);
  if (process.platform !== 'win32') await assert.rejects(coordinator.status(), { code: 'UNTRUSTED_RECIPES' });
  await chmod(filename, 0o600);
  const target = path.join(fixture.directory, 'replacement.json'); await writeFile(target, '[]', { mode: 0o600 });
  await rm(filename); await symlink(target, filename);
  await assert.rejects(coordinator.status(), { code: 'UNTRUSTED_RECIPES' });
});

test('enterprise services use an independently delegated data principal and revalidate pinned deployment code', async t => {
  const fixture = await setup(t);
  const filename = path.join(fixture.directory, 'enterprise.mjs'), source = 'export async function createFusionCloudServices() { throw new Error("Fixture source only"); }\n';
  await writeFile(filename, source, { mode: 0o600 });
  const descriptor = { path: filename, sha256: hashBytes(source) };
  const { clientId: _client, redirectUri: _redirect, scopes: _scopes, ...serviceScope } = fixture.profile.cloud;
  const profile = parseProfile({ ...fixture.profile, cloud: { ...serviceScope, enterpriseAdapter: descriptor } });
  const calls = { app: 0, user: 0, verify: 0 };
  const token = (type, counter) => ({ getToken: async request => { calls[counter]++; return { ...request, accessToken: 'PRIVATE_ENTERPRISE_CREDENTIAL', expiresAt: Date.now() + 3_600_000, issuer: APS_ORIGIN, grantType: type }; } });
  const services = { tokenProvider: token('client_credentials', 'app'), delegatedTokenProvider: token('authorization_code', 'user'), authMode: 'app_with_user', authorizationBinding: async () => 'enterprise-grant-a', validateOutputs: async job => validationReceipt(job), reconcileBilling: async job => billingReceipt(job) };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), `${APS_ORIGIN}/project/v1/hubs`);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'Bearer PRIVATE_ENTERPRISE_CREDENTIAL');
    return new Response(JSON.stringify({ data: [{ type: 'hubs', id: 'hub-a', attributes: { name: 'Enterprise fixture' } }] }), { headers: { 'content-type': 'application/json' } });
  });
  const options = { ...fixture.config, aps: undefined, profile, enterpriseServices: services, verifyEnterpriseAdapter: async () => { calls.verify++; await verifyTrustedExecutableAsset(descriptor); } };
  const coordinator = await CloudCoordinator.create(options);
  assert.equal(coordinator.oauth, undefined, 'Enterprise authorization does not construct a dummy public-client flow');
  const observed = await coordinator.read('data.hubs', {});
  assert.equal(observed.data[0].id, 'hub-a'); assert.equal(calls.user, 1); assert.equal(calls.app, 0);
  const metadata = await coordinator.status();
  assert.equal(metadata.authentication.source, 'enterprise_adapter');
  assert.equal(metadata.output_validator_configured, true); assert.equal(metadata.billing_reconciler_configured, true);
  assert.equal(JSON.stringify(metadata).includes('PRIVATE_ENTERPRISE_CREDENTIAL'), false);
  const job = await prepare(coordinator); await coordinator.submitJob(job.id, job.plan_hash, 'enterprise-job-once'); fixture.automation.setState('validating');
  assert.equal((await coordinator.validateJob(job.id)).status, 'succeeded');
  assert.equal((await coordinator.settleJob(job.id)).reserved_units, 0);
  await writeFile(filename, `${source}// drift\n`);
  await assert.rejects(coordinator.status(), { code: 'ENTERPRISE_ADAPTER_CHANGED' });
  assert.ok(calls.verify > 5);
});

test('enterprise configuration cannot inherit local PKCE authority or skip its host integrity verifier', async t => {
  const fixture = await setup(t);
  const services = { tokenProvider: { getToken: async () => assert.fail('No credential request expected') }, authMode: 'app_only', authorizationBinding: async () => 'service-account-a' };
  await assert.rejects(CloudCoordinator.create({ ...fixture.config, enterpriseServices: services }), { code: 'ENTERPRISE_ADAPTER_REQUIRED' });
  const profile = { ...fixture.profile, cloud: { ...fixture.profile.cloud, enterpriseAdapter: { path: '/trusted/enterprise.mjs', sha256: 'b'.repeat(64) } } };
  await assert.rejects(CloudCoordinator.create({ ...fixture.config, profile, enterpriseServices: services }), { code: 'ENTERPRISE_ADAPTER_REQUIRED' });
  await assert.rejects(CloudCoordinator.create({ ...fixture.config, profile, enterpriseServices: { ...services, authorizationBinding: undefined }, verifyEnterpriseAdapter: async () => {} }), { code: 'INVALID_ENTERPRISE_SERVICES' });
});

async function wireClient(t, fixture) {
  const runtime = { profile: fixture.profile, engine: { store: fixture.store }, cloud: fixture.coordinator, root: '/unused', close: async () => {} };
  const server = createFusionServer(runtime), client = new Client({ name: 'fusion-contract-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('actual MCP transport rejects unknown authority fields and exposes only reviewed data reads', async t => {
  const fixture = await setup(t);
  let reads = 0;
  fixture.config.aps.listHubs = async () => { reads++; return { data: [] }; };
  fixture.config.aps.observeMfgProperty = async (input, propertyId) => { reads++; assert.equal(propertyId, 'property-1'); assert.equal(Object.hasOwn(input, 'property_id'), false); return { value: null, context: input }; };
  const client = await wireClient(t, fixture);
  const listed = await client.listTools();
  const names = listed.tools.map(tool => tool.name);
  assert.ok(names.includes('fusion_data_search'));
  for (const args of [{ operation: 'data.hubs', args: { url: 'https://attacker.example' } }, { operation: 'data.hubs', args: {}, approved: true }, { operation: 'graphql.execute', args: { query: 'mutation Unauthorized' } }]) {
    const result = await client.callTool({ name: 'fusion_data_search', arguments: args });
    assert.equal(result.isError, true);
  }
  assert.equal(reads, 0);
  const job = await prepare(fixture.coordinator);
  const submit = await client.callTool({ name: 'fusion_cloud_job_submit', arguments: { job_id: job.id, plan_hash: job.plan_hash, idempotency_key: 'mcp-approval-cannot-grant', approved: true } });
  assert.equal(submit.isError, true); assert.equal(fixture.automation.calls.submit, 0);
  assert.equal((await client.callTool({ name: 'fusion_data_search', arguments: { operation: 'mfg.property', args: { ...mfgContext(), property_id: 'property-1' } } })).isError, undefined);
  assert.equal(reads, 1);
});

test('MCP cloud outputs remove access credentials, report URLs and signed transfer query strings', async t => {
  const fixture = await setup(t);
  fixture.config.aps.listHubs = async () => ({ accessToken: 'PRIVATE_ACCESS', authorization: 'Bearer PRIVATE_BEARER', reportUrl: 'https://logs.example/report?X-Amz-Signature=PRIVATE_REPORT', link: 'https://artifacts.example/file?X-Amz-Credential=PRIVATE_CREDENTIAL&X-Amz-Signature=PRIVATE_SIGNATURE', data: [] });
  const client = await wireClient(t, fixture);
  const result = await client.callTool({ name: 'fusion_data_search', arguments: { operation: 'data.hubs', args: {} } });
  assert.equal(result.isError, undefined);
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
});
