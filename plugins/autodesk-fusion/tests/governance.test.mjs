import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const {
  FusionEngine, FixtureDesktopProvider, NativeFusionClient, fixtureProfile, parseProfile,
  profileHash, hash, hashBytes, loadProfile, verifyTrustedExecutableAsset,
  validateFilename, runQualification, jsonPointer,
} = await import(process.env.FUSION_GOVERNANCE_TEST_ENTRY ?? new URL('../dist/index.mjs', import.meta.url).href);

const DOCUMENT = 'fixture:bracket';
const SECRET_DOCUMENT = 'private:production';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAGwAAABsCAYAAACPZlfNAAAARElEQVR4nO3BMQEAAADCoPVPbQhfoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHgNtqwAARHUcZkAAAAASUVORK5CYII=', 'base64');
const STEP = 'ISO-10303-21;\nHEADER;\n/* PROTOCOL DOUBLE: NO AUTODESK GEOMETRY */\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n';
const HANDLER = hashBytes('reviewed test handler, not Autodesk');
const change = (document = DOCUMENT) => ({ operation: 'parameters.set', document_id: document, args: { changes: [{ parameter_id: 'fixture:parameter:width', expression: '45 mm' }] } });
const render = () => ({ operation: 'render.start', document_id: DOCUMENT, args: { output: { root: 'artifacts', filename: 'render.png' }, width: 108, height: 108, quality: 'draft' } });
const generate = () => ({ operation: 'cam.generate', document_id: DOCUMENT, args: { operation_ids: ['fixture:cutting-operation'] } });
const exportStep = filename => ({ operation: 'exports.generate', document_id: DOCUMENT, args: { format: 'step', output: { root: 'artifacts', filename } } });
const equals = (pointer, expected) => ({ kind: 'equals', pointer, expected });

/** A deterministic workflow double. It never imports Autodesk or runs a kernel. */
class DesktopDouble {
  calls = [];
  revision = 0;
  futureId = 'job_123456789012345678901234567890ab';
  initialStatus = 'queued';
  futureStatus = 'running';
  documents = new Map([[SECRET_DOCUMENT, { document_id: SECRET_DOCUMENT, name: 'CONFIDENTIAL PRODUCTION NAME', saved: true }], [DOCUMENT, { document_id: DOCUMENT, name: 'Review fixture', saved: false }]]);
  state(document) { return hash({ session: 'protocol-double', revision: this.revision, document: document ?? null }); }
  async dispatch(request) {
    this.calls.push(structuredClone(request));
    if (request.expected_state && request.expected_state !== this.state(request.document_id)) return { ok: false, error: { code: 'STALE_STATE', message: 'Protocol double state changed', outcome: 'none' } };
    const ok = data => ({ ok: true, data, state: this.state(request.document_id), effects: [] });
    if (request.operation === 'documents.list') return ok({ documents: [...this.documents.values()].slice(0, request.args.limit ?? 256), total: this.documents.size, ...(this.listExtra ?? {}) });
    if (request.operation === 'document.inspect') return this.documents.has(request.document_id) ? ok({ ...this.documents.get(request.document_id), body_count: 1 }) : { ok: false, error: { code: 'DOCUMENT_NOT_FOUND', message: 'Unknown protocol document', outcome: 'none' } };
    if (request.operation === 'parameters.list') return ok({ parameters: [{ name: 'width', value_mm: 45 }] });
    if (request.operation === 'parameters.set') { this.revision++; return ok({ changed: request.args.changes }); }
    if (['documents.create', 'documents.import'].includes(request.operation)) {
      const document = { document_id: `created:${this.documents.size}`, name: request.args.name ?? 'Imported fixture', saved: false };
      this.documents.set(document.document_id, document); this.revision++;
      return ok(request.operation === 'documents.import' ? { document, source_sha256: request.args.source_sha256 } : document);
    }
    if (request.operation === 'documents.close') { this.documents.delete(request.document_id); this.revision++; return ok({ closed: true }); }
    if (['cam.generate', 'cam.nc_post', 'render.start', 'cam.setup_sheet'].includes(request.operation)) {
      if (request.args.output_path) await writeFile(request.args.output_path, PNG);
      if (request.args.output_folder) {
        await writeFile(path.join(request.args.output_folder, request.operation === 'cam.nc_post' ? 'candidate.nc' : 'setup.html'), request.operation === 'cam.nc_post' ? '(QUARANTINED PROTOCOL DOUBLE)\nM30\n' : '<!doctype html><html><body>Protocol double</body></html>');
        this.outputFolder = request.args.output_folder;
      }
      this.revision++;
      if (this.startError) return { ok: false, error: this.startError };
      return ok(this.initialData ?? { job_id: this.futureId, status: this.initialStatus, cancel_supported: false });
    }
    if (['cam.status', 'render.status'].includes(request.operation)) {
      assert.equal(request.args.job_id, this.futureId, 'The provider receives its own future ID, not the broker ID');
      if (this.pollError) return { ok: false, error: this.pollError };
      return ok(this.pollData ?? { job_id: this.futureId, status: this.futureStatus, cancel_supported: false });
    }
    if (request.operation === 'exports.generate') {
      const destination = this.decomposeOutput ? path.join(path.dirname(request.args.output_path), path.basename(request.args.output_path).normalize('NFD')) : request.args.output_path;
      await writeFile(destination, STEP); return ok({ protocol_fixture: true, geometry_validated: false });
    }
    return { ok: false, error: { code: 'UNSUPPORTED', message: 'Protocol double does not implement this action', outcome: 'none' } };
  }
  count(operation) { return this.calls.filter(call => call.operation === operation).length; }
}

async function setup(t, { assisted = false, provider = new DesktopDouble(), configure = () => {}, options = {} } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fusion-governance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const raw = fixtureProfile(directory);
  if (assisted) {
    raw.mode = 'assisted'; raw.id = 'assisted-protocol-double';
    raw.policy.operations = ['documents.create', 'documents.import', 'documents.close', 'parameters.set', 'exports.generate', 'render.start', 'cam.generate', 'cam.setup_sheet', 'cam.nc_post'];
    raw.policy.grantExpiresAt = new Date(Date.now() + 600_000).toISOString();
    raw.policy.qualificationDocuments = [DOCUMENT];
  }
  await configure(raw, directory, provider);
  const profile = parseProfile(raw);
  const engine = new FusionEngine(profile, provider, HANDLER, options);
  await engine.init();
  return { directory, profile, engine, provider, runtime: { profile, engine, root: directory, close: () => engine.close() } };
}
async function execute(engine, input, key = 'governance-business-request') {
  const plan = await engine.prepare(input);
  return { prepared: plan, result: await engine.execute(plan.id, plan.hash, key) };
}
function scenario(steps, cleanup = []) { return { version: 1, id: 'governance', purpose: 'Protocol-double regression, never Autodesk qualification', steps, cleanup }; }

test('read-only artifact inspection cannot finalize a valid-looking file from a running render', async t => {
  const { engine, provider } = await setup(t);
  const { prepared, result } = await execute(engine, render());
  assert.equal(result.status, 'pending');
  assert.equal(result.result.artifact.status, 'pending');
  const premature = await engine.artifacts.inspect(prepared.artifact.id);
  assert.equal(premature.status, 'pending'); assert.equal(premature.files, undefined); assert.equal(premature.manifest_sha256, undefined);
  assert.equal((await engine.store.get('artifact', prepared.artifact.id)).status, 'pending');
  provider.futureStatus = 'succeeded';
  const completed = await engine.jobStatus(result.result.data.job_id, DOCUMENT);
  assert.equal(completed.status, 'succeeded');
  const finalPlan = await engine.inspectPlan(prepared.id);
  assert.equal(finalPlan.status, 'succeeded'); assert.equal(finalPlan.result.artifact.status, 'succeeded'); assert.equal(finalPlan.result.data.status, 'succeeded');
  const receipt = await engine.artifacts.inspect(prepared.artifact.id);
  assert.equal(receipt.producer_plan_hash, prepared.hash); assert.match(receipt.manifest_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(await engine.artifacts.inspect(prepared.artifact.id), receipt);
  await engine.jobStatus(completed.id); assert.equal(provider.count('render.status'), 1, 'A terminal future is not re-polled');
});

test('completed output bytes and manifest metadata cannot be silently amended', async t => {
  const { engine } = await setup(t);
  const { prepared } = await execute(engine, exportStep('immutable.step'));
  const receipt = await engine.artifacts.inspect(prepared.artifact.id);
  await writeFile(receipt.path, STEP.replace('PROTOCOL', 'ALTERED'));
  await assert.rejects(engine.artifacts.inspect(receipt.id), { code: 'ARTIFACT_CHANGED' });
  await writeFile(receipt.path, STEP);
  receipt.files[0].sha256 = '0'.repeat(64);
  await engine.store.put('artifact', receipt.id, receipt);
  await assert.rejects(engine.artifacts.inspect(receipt.id), { code: 'ARTIFACT_CHANGED' });
});

test('a missing completed artifact stays an integrity failure even with allow_pending', async t => {
  const { engine } = await setup(t);
  const { result } = await execute(engine, exportStep('deleted.step'));
  await rm(result.result.artifact.path);
  await assert.rejects(engine.artifacts.inspect(result.result.artifact.id, true), { code: 'MISSING_ARTIFACT' });
});

for (const status of ['failed', 'cancelled']) test(`terminal ${status} from async submission never becomes pending or successful`, async t => {
  const provider = new DesktopDouble(); provider.initialStatus = status;
  const { engine } = await setup(t, { provider });
  const { result } = await execute(engine, render());
  assert.equal(result.status, 'failed'); assert.equal(result.result.job.status, status); assert.equal(result.result.artifact.status, 'failed');
  assert.equal(result.result.completion, status === 'cancelled' ? 'provider_cancelled' : 'provider_failed');
  await engine.jobStatus(result.result.job.id); assert.equal(provider.count('render.status'), 0);
});

for (const initialData of [{ status: 'running' }, { status: 'not-a-provider-state', job_id: 'bad-future' }, { status: 'succeeded' }]) test(`malformed async submission remains unknown without write replay: ${JSON.stringify(initialData)}`, async t => {
  const provider = new DesktopDouble(); provider.initialData = initialData;
  const { engine } = await setup(t, { provider });
  const { prepared, result } = await execute(engine, render());
  assert.equal(result.status, 'outcome_unknown'); assert.equal(result.result.error.code, 'INVALID_PROVIDER_JOB');
  assert.equal((await engine.execute(prepared.id, prepared.hash, 'governance-business-request')).status, 'outcome_unknown');
  assert.equal(provider.count('render.start'), 1);
});

test('optional async setup-sheet packages wait for completion and include late auxiliary files', async t => {
  const provider = new DesktopDouble(); provider.initialStatus = 'validating';
  const { engine } = await setup(t, { provider });
  const { result } = await execute(engine, { operation: 'cam.setup_sheet', document_id: DOCUMENT, args: { operation_ids: ['fixture:operation'], format: 'html', output: { root: 'artifacts', filename: 'package.html' } } });
  assert.equal(result.status, 'pending'); assert.equal(result.result.job.provider, 'desktop_cam');
  await engine.artifacts.inspect(result.artifact.id);
  await mkdir(path.join(provider.outputFolder, 'styles'));
  await writeFile(path.join(provider.outputFolder, 'styles', 'layout.css'), 'body { color: black; }');
  provider.futureStatus = 'succeeded';
  const job = await engine.jobStatus(result.result.job.id);
  assert.equal(job.status, 'succeeded'); assert.equal(job.data.artifact.files.length, 2);
  assert.match(job.data.artifact.limitation, /not sanitized/);
});

test('CAM status reads translate durable IDs, enforce provider/document binding and preserve stale-read outcomes', async t => {
  const { engine, provider } = await setup(t);
  const { result } = await execute(engine, generate());
  const jobId = result.result.data.job_id;
  await assert.rejects(engine.read({ operation: 'render.status', document_id: DOCUMENT, args: { job_id: jobId } }), { code: 'JOB_PROVIDER_MISMATCH' });
  await assert.rejects(engine.jobStatus(jobId, SECRET_DOCUMENT), { code: 'DOCUMENT_MISMATCH' });
  await assert.rejects(engine.read({ operation: 'cam.status', document_id: DOCUMENT, expected_state: 'stale-state', args: { job_id: jobId } }), { code: 'STALE_STATE' });
  assert.equal((await engine.store.get('job', jobId)).status, 'queued');
  provider.futureStatus = 'succeeded';
  const status = await engine.read({ operation: 'cam.status', document_id: DOCUMENT, args: { job_id: jobId } });
  assert.equal(status.data.job_id, jobId); assert.equal(status.data.status, 'succeeded');
  assert.equal((await engine.inspectPlan(result.id)).status, 'succeeded');
});

test('status cancellation terminates the plan without claiming rollback or exposing an artifact manifest', async t => {
  const { engine, provider } = await setup(t);
  const { result } = await execute(engine, render()); provider.futureStatus = 'cancelled';
  const job = await engine.jobStatus(result.result.job.id);
  assert.equal(job.status, 'cancelled');
  const plan = await engine.inspectPlan(result.id);
  assert.equal(plan.status, 'failed'); assert.equal(plan.result.completion, 'provider_cancelled'); assert.equal(plan.result.artifact.files, undefined);
});

test('unknown polling can reconcile to the existing future without repeating the render', async t => {
  const { engine, provider } = await setup(t);
  const { result } = await execute(engine, render());
  provider.pollData = { status: 'succeeded', job_id: 'another-future' };
  assert.equal((await engine.jobStatus(result.result.job.id)).status, 'outcome_unknown');
  provider.pollData = undefined; provider.futureStatus = 'succeeded';
  assert.equal((await engine.jobStatus(result.result.job.id)).status, 'succeeded');
  const plan = await engine.inspectPlan(result.id);
  assert.equal(plan.status, 'succeeded'); assert.equal(plan.result.error, undefined); assert.equal(plan.result.reconciled_error.code, 'INVALID_PROVIDER_JOB');
  assert.equal(provider.count('render.start'), 1);
});

test('render settings failure retains the submitted future and never turns the overall plan into success', async t => {
  const provider = new DesktopDouble();
  provider.startError = { code: 'RENDER_SETTINGS_RESTORE_FAILED', message: 'Protocol fixture restoration failed', outcome: 'partial', details: { cause: { job_id: provider.futureId }, effects: ['render submitted'] } };
  const { engine } = await setup(t, { provider });
  const { result } = await execute(engine, render());
  assert.equal(result.status, 'failed'); assert.equal(result.result.job.status, 'outcome_unknown');
  provider.futureStatus = 'succeeded';
  assert.equal((await engine.jobStatus(result.result.job.id)).status, 'succeeded');
  const finalPlan = await engine.inspectPlan(result.id);
  assert.equal(finalPlan.status, 'failed'); assert.equal(finalPlan.result.error.code, 'RENDER_SETTINGS_RESTORE_FAILED');
  assert.equal(finalPlan.result.completion, 'provider_completed_with_submission_error');
  assert.equal(finalPlan.result.artifact.status, 'succeeded'); assert.equal(provider.count('render.start'), 1);
});

test('immutable future binding and a changed execution contract block later status dispatch', async t => {
  const { engine, provider, profile } = await setup(t, { options: { executionContractHash: hash('contract-a') } });
  const { result } = await execute(engine, generate());
  const job = await engine.store.get('job', result.result.job.id);
  job.provider_id = 'wrong-future'; await engine.store.put('job', job.id, job);
  await assert.rejects(engine.jobStatus(job.id), { code: 'JOB_BINDING_CHANGED' });
  assert.equal(provider.count('cam.status'), 0);
  const changed = new FusionEngine(profile, provider, HANDLER, { executionContractHash: hash('contract-b') });
  await assert.rejects(changed.jobStatus(job.id), { code: 'PLAN_BINDING_CHANGED' });
  assert.equal(provider.count('cam.status'), 0);
});

test('compiled facade bytes are checked again before execution and assisted preflight', async t => {
  const { directory, profile, provider } = await setup(t);
  const compiled = path.join(directory, 'compiled.mjs'); await writeFile(compiled, 'export const schema = 1;');
  const options = { executionContractHash: hash('installed-contract-a'), executionContractFiles: [{ path: compiled, sha256: hashBytes('export const schema = 1;') }] };
  const engine = new FusionEngine(profile, provider, HANDLER, options);
  const plan = await engine.prepare(change());
  assert.equal(plan.execution_contract_hash, options.executionContractHash);
  await writeFile(compiled, 'export const schema = 2;');
  await assert.rejects(engine.execute(plan.id, plan.hash, 'compiled-drift-request'), { code: 'EXECUTION_CONTRACT_CHANGED' });
  await assert.rejects(engine.assertTrustedConfiguration(), { code: 'EXECUTION_CONTRACT_CHANGED' });
  const changed = new FusionEngine(profile, provider, HANDLER, { executionContractHash: hash('installed-contract-b'), executionContractFiles: [{ path: compiled, sha256: hashBytes('export const schema = 2;') }] });
  await assert.rejects(changed.execute(plan.id, plan.hash, 'compiled-drift-request'), { code: 'PLAN_BINDING_CHANGED' });
  assert.equal(provider.count('parameters.set'), 0);
});

test('engine snapshots the trusted profile instead of admitting mutable caller-side grant changes', async t => {
  const { engine, profile } = await setup(t, { configure: p => { p.policy.mutationsEnabled = false; } });
  profile.policy.mutationsEnabled = true;
  const plan = await engine.prepare(change());
  assert.equal(plan.policy_decision.blocker, 'MUTATIONS_DISABLED');
  assert.throws(() => { engine.profile.policy.mutationsEnabled = true; }, TypeError);
});

test('default asset registries never leak mutable approvals between independently parsed profiles', () => {
  const first = fixtureProfile(path.join(os.tmpdir(), 'first-profile'));
  first.assets.imports.push({ id: 'private-source', path: path.join(os.tmpdir(), 'first.step'), sha256: 'a'.repeat(64), trusted: true });
  first.assets.templates.push({ id: 'private-template', path: path.join(os.tmpdir(), 'first.template'), sha256: 'b'.repeat(64) });
  const second = fixtureProfile(path.join(os.tmpdir(), 'second-profile'));
  assert.deepEqual(second.assets.imports, []); assert.deepEqual(second.assets.templates, []);
});

test('readDocuments filters lists/status and denies observations outside the explicit read scope', async t => {
  const { engine, provider } = await setup(t, { configure: p => { p.policy.readDocuments = [DOCUMENT]; p.policy.documents.push(SECRET_DOCUMENT); } });
  const listed = await engine.read({ operation: 'documents.list', args: { limit: 1 } });
  assert.deepEqual(listed.data.documents.map(d => d.document_id), [DOCUMENT]);
  assert.equal(listed.data.restricted_document_count, 1); assert.equal(provider.calls.at(-1).args.limit, 256);
  const status = await engine.connectionStatus();
  assert.equal(status.read_scope.restricted, true);
  assert.equal(JSON.stringify(status).includes('CONFIDENTIAL'), false); assert.equal(JSON.stringify(status).includes(SECRET_DOCUMENT), false);
  const before = provider.calls.length;
  await assert.rejects(engine.read({ operation: 'document.inspect', document_id: SECRET_DOCUMENT, args: {} }), { code: 'READ_DOCUMENT_DENIED' });
  await assert.rejects(engine.prepare(change(SECRET_DOCUMENT)), { code: 'READ_DOCUMENT_DENIED' });
  assert.equal(provider.calls.length, before);
});

test('omitting readDocuments explicitly preserves current-user open-document inspection', async t => {
  const { engine } = await setup(t);
  const listed = await engine.read({ operation: 'documents.list', args: {} });
  assert.equal(listed.data.documents.length, 2);
  assert.equal((await engine.connectionStatus()).read_scope.mode, 'current_user_open_documents');
  assert.equal((await engine.read({ operation: 'document.inspect', document_id: SECRET_DOCUMENT, args: {} })).data.name, 'CONFIDENTIAL PRODUCTION NAME');
});

test('restricted discovery withholds provider failure text that could name another document', async t => {
  const provider = { async dispatch() { return { ok: false, error: { code: 'PROVIDER_FAILURE', message: 'CONFIDENTIAL PRODUCTION NAME', details: { document_id: SECRET_DOCUMENT }, outcome: 'none' } }; } };
  const { engine } = await setup(t, { provider, configure: p => { p.policy.readDocuments = [DOCUMENT]; } });
  await assert.rejects(engine.read({ operation: 'documents.list', args: {} }), error => error.code === 'SCOPED_DISCOVERY_UNAVAILABLE' && !JSON.stringify(error).includes('CONFIDENTIAL') && !error.message.includes(SECRET_DOCUMENT));
  const status = await engine.connectionStatus();
  assert.equal(JSON.stringify(status).includes('CONFIDENTIAL'), false); assert.equal(JSON.stringify(status).includes(SECRET_DOCUMENT), false);
});

for (const operation of ['documents.create', 'documents.import']) test(`${operation} records the exact response identity and scopes creation to its producing receipt`, async t => {
  const { engine, profile, provider, directory } = await setup(t, { assisted: true, configure: async (p, root) => {
    p.policy.allowUnsavedCreation = true; p.policy.allowCreatedDocuments = true; p.policy.readDocuments = [];
    const source = path.join(root, 'approved.step'); await writeFile(source, STEP);
    p.assets.imports.push({ id: 'approved', path: source, sha256: hashBytes(STEP), trusted: true });
  } });
  const input = operation === 'documents.create' ? { operation, args: { name: 'New fixture' } } : { operation, args: { format: 'step', source: { kind: 'asset', id: 'approved' } } };
  const { result } = await execute(engine, input);
  assert.equal(result.status, 'succeeded');
  const id = operation === 'documents.import' ? result.result.data.document.document_id : result.result.data.document_id;
  assert.equal(await engine.isCreatedDocument(id), true);
  assert.equal((await engine.read({ operation: 'document.inspect', document_id: id, args: {} })).data.document_id, id);
  assert.equal((await engine.prepare(change(id))).policy_decision.authorized, true);
  assert.deepEqual((await engine.read({ operation: 'documents.list', args: {} })).data.documents.map(d => d.document_id), [id]);
  const otherBuild = new FusionEngine(profile, provider, HANDLER, { executionContractHash: hash('different-build') });
  assert.equal(await otherBuild.isCreatedDocument(id), false);
  const receipt = await engine.store.get('createddoc', hash(id));
  receipt.document_id = SECRET_DOCUMENT; await engine.store.put('createddoc', hash(SECRET_DOCUMENT), receipt);
  assert.equal(await engine.isCreatedDocument(SECRET_DOCUMENT), false, 'A standalone ledger entry cannot grant a different document');
  assert.equal(path.isAbsolute(directory), true);
});

test('Unicode output filenames retain real filesystem spelling and can be safely round-trip imported', async t => {
  const provider = new DesktopDouble(); provider.decomposeOutput = true;
  const { engine } = await setup(t, { provider, configure: p => { p.policy.allowUnsavedCreation = true; p.policy.allowCreatedDocuments = true; } });
  const { result } = await execute(engine, exportStep('Café pièce.step'));
  assert.equal(result.status, 'succeeded'); assert.equal(await readFile(result.result.artifact.path, 'utf8'), STEP);
  const imported = await execute(engine, { operation: 'documents.import', args: { format: 'step', source: { kind: 'artifact', id: result.artifact.id } } }, 'unicode-roundtrip-import');
  assert.equal(imported.result.status, 'succeeded');
  assert.equal(await engine.isCreatedDocument(imported.result.result.data.document.document_id), true);
  for (const name of ['COM¹.step', 'LPT².step', 'CON.step', 'Cafe\u0301.step']) assert.throws(() => validateFilename(name), { code: 'UNSAFE_PATH' });
});

test('configuration reload also protects public local artifact reads', async t => {
  const { directory, profile, provider } = await setup(t);
  const filename = path.join(directory, 'profile.json'); await writeFile(filename, JSON.stringify(profile), { mode: 0o600 });
  const engine = new FusionEngine(profile, provider, HANDLER, { profileFile: filename });
  const { result } = await execute(engine, exportStep('approved.step'));
  await writeFile(filename, JSON.stringify({ ...profile, outputs: [] }));
  await assert.rejects(engine.artifacts.inspect(result.artifact.id), { code: 'PROFILE_CHANGED' });
});

test('enterprise modules have distinct authorization configuration and exact executable ownership/hash gates', async t => {
  const { directory, profile } = await setup(t);
  const module = path.join(directory, 'service.mjs'); const source = 'export function createFusionCloudServices() { throw new Error("offline fixture"); }';
  await writeFile(module, source, { mode: 0o600 });
  const descriptor = { path: module, sha256: hashBytes(source) };
  const enterprise = parseProfile({ ...profile, cloud: { tenantId: 'test-tenant', enterpriseAdapter: descriptor } });
  assert.equal(enterprise.cloud.clientId, undefined);
  assert.throws(() => parseProfile({ ...enterprise, cloud: { ...enterprise.cloud, clientId: 'public-client', scopes: ['data:read'], redirectUri: 'http://127.0.0.1:27180/callback' } }), { code: 'INVALID_PROFILE' });
  assert.throws(() => parseProfile({ ...profile, cloud: { tenantId: 'test-tenant' } }), { code: 'INVALID_PROFILE' });
  assert.equal(await verifyTrustedExecutableAsset(descriptor), await (await import('node:fs/promises')).realpath(module));
  const profileFile = path.join(directory, 'enterprise.json'); await writeFile(profileFile, JSON.stringify(enterprise), { mode: 0o600 });
  assert.equal(profileHash(await loadProfile(profileFile)), profileHash(enterprise));
  await writeFile(module, source + '\n// changed');
  await assert.rejects(loadProfile(profileFile), { code: 'ADAPTER_CHANGED' });
  await writeFile(module, source);
  const alias = path.join(directory, 'alias.mjs'); await link(module, alias);
  await assert.rejects(verifyTrustedExecutableAsset(descriptor), { code: 'UNTRUSTED_ASSET' });
  await rm(alias);
  if (process.platform !== 'win32') {
    await chmod(module, 0o666);
    await assert.rejects(verifyTrustedExecutableAsset(descriptor), { code: 'UNTRUSTED_PROFILE' });
    await chmod(module, 0o600); await symlink(module, alias);
    await assert.rejects(verifyTrustedExecutableAsset({ ...descriptor, path: alias }), { code: 'UNTRUSTED_ASSET' });
  }
});

test('fixture execution under a real-mode profile cannot count as live Autodesk qualification', async t => {
  const { runtime, engine } = await setup(t, { assisted: true, provider: new FixtureDesktopProvider(), configure: p => { p.policy.qualifiedOperations = ['parameters.set']; p.policy.qualificationEvidence = 'An offline claim is not a current live observation'; } });
  const report = await runQualification(runtime, scenario([{ id: 'inspect', action: 'read', input: { operation: 'document.inspect', document_id: DOCUMENT, args: {} }, assertions: [equals('/data/fixture', true)] }]));
  assert.equal(report.status, 'scenario_passed'); assert.equal(report.evidence_kind, 'synthetic_fixture');
  assert.equal(report.live_fusion_exercised, false); assert.equal(report.live_fusion_verified, false); assert.equal(report.live_fusion_qualified, false);
  assert.equal((await engine.connectionStatus()).live_fusion_verified, false);
  assert.equal(engine.capabilities().operations.find(op => op.id === 'parameters.set').prior_profile_qualification_attested, false);
});

test('configured or previously attested provider state is not advertised as currently reachable', async t => {
  const { engine } = await setup(t, { assisted: true, provider: { async dispatch() { throw new Error('offline'); } }, configure: p => {
    p.desktop = { provider: 'native', url: 'http://127.0.0.1:27182/mcp', mapping: { tool: 'explicitly_enrolled', argument: 'script', schemaHash: 'a'.repeat(64) }, timeoutMs: 1000 };
    p.policy.qualifiedOperations = ['parameters.set']; p.policy.qualificationEvidence = 'Previous human attestation';
  } });
  const op = engine.capabilities().operations.find(row => row.id === 'parameters.set');
  assert.equal(op.provider_configured, true); assert.equal(op.provider_available, null); assert.equal(op.prior_profile_qualification_attested, true); assert.equal(op.live_qualified, false);
  assert.equal(op.execution_authorized, null); assert.equal(op.profile_grant_authorized, true);
  const status = await engine.connectionStatus();
  assert.equal(status.desktop.connected, false); assert.equal(status.live_fusion_exercised, false); assert.equal(status.live_fusion_verified, false);
});

test('qualification prevents production reads and still runs explicitly scoped cleanup after failure', async t => {
  const { runtime, provider } = await setup(t, { assisted: true });
  const report = await runQualification(runtime, scenario([{ id: 'production', action: 'read', input: { operation: 'document.inspect', document_id: SECRET_DOCUMENT, args: {} }, assertions: [{ kind: 'exists', pointer: '/data' }] }], [{ id: 'cleanup', action: 'read', input: { operation: 'document.inspect', document_id: DOCUMENT, args: {} }, assertions: [equals('/data/document_id', DOCUMENT)] }]));
  assert.equal(report.status, 'failed'); assert.equal(report.evidence[0].error.code, 'QUALIFICATION_SCOPE_DENIED'); assert.equal(report.evidence[1].status, 'passed');
  assert.equal(provider.calls.some(call => call.operation === 'document.inspect' && call.document_id === SECRET_DOCUMENT), false);
});

test('documents created before a run are not silently adopted as qualification fixtures', async t => {
  const { runtime, engine } = await setup(t, { assisted: true, configure: p => { p.policy.allowCreatedDocuments = true; p.policy.allowUnsavedCreation = true; } });
  const prior = await execute(engine, { operation: 'documents.create', args: {} });
  const id = prior.result.result.data.document_id;
  assert.equal(await engine.isCreatedDocument(id), true);
  const report = await runQualification(runtime, scenario([{ id: 'existing', action: 'read', input: { operation: 'document.inspect', document_id: id, args: {} }, assertions: [{ kind: 'exists', pointer: '/data' }] }]));
  assert.equal(report.evidence[0].error.code, 'QUALIFICATION_SCOPE_DENIED');
});

test('qualification cleanup preserves created identities after a failed assertion and does not silently discard them', async t => {
  const { runtime, provider } = await setup(t, { assisted: true, configure: p => { p.policy.allowCreatedDocuments = true; p.policy.allowUnsavedCreation = true; } });
  const report = await runQualification(runtime, scenario([{ id: 'create', action: 'change', input: { operation: 'documents.create', args: {} }, assertions: [equals('/status', 'intentionally-wrong')] }], [{ id: 'inspect_created', action: 'read', input: { operation: 'document.inspect', document_id: { $ref: 'create#/result/data/document_id' }, args: {} }, assertions: [equals('/data/saved', false)] }]));
  assert.equal(report.status, 'failed'); assert.equal(report.evidence[1].status, 'passed');
  assert.equal(report.cleanup.remaining_document_ids.length, 1); assert.equal(report.cleanup.review_required, true); assert.equal(report.cleanup.automatic_discard_or_save, false);
  assert.equal(provider.count('documents.close'), 0);
});

test('qualification cannot use unrelated artifact or job references from the same profile', async t => {
  const { runtime, engine } = await setup(t);
  const prior = await execute(engine, exportStep('previous.step'));
  for (const [action, input] of [['artifact', { artifact_id: prior.result.artifact.id }], ['wait_job', { job_id: 'job_unrelated' }]]) {
    const report = await runQualification(runtime, scenario([{ id: 'unrelated', action, input, assertions: [{ kind: 'exists', pointer: '/status' }] }]));
    assert.equal(report.evidence[0].error.code, 'QUALIFICATION_SCOPE_DENIED');
  }
});

test('an exhausted job poll cannot pass qualification merely because the status field exists', async t => {
  const { runtime } = await setup(t);
  const report = await runQualification(runtime, scenario([
    { id: 'start', action: 'change', input: render(), assertions: [equals('/status', 'pending')] },
    { id: 'wait', action: 'wait_job', input: { job_id: { $ref: 'start#/result/data/job_id' } }, max_polls: 1, poll_interval_ms: 20, assertions: [{ kind: 'exists', pointer: '/status' }] },
  ]));
  assert.equal(report.status, 'failed'); assert.equal(report.evidence[1].error.code, 'QUALIFICATION_JOB_TIMEOUT');
  assert.equal(report.successful_operations.some(operation => operation.operation === 'render.start'), false);
  assert.equal(report.cleanup.unresolved_jobs.length, 1); assert.equal(report.cleanup.review_required, true);
});

test('successful asynchronous qualification is tied to its completed job and bounded durable evidence receipts', async t => {
  const provider = new DesktopDouble(); provider.futureStatus = 'succeeded';
  const { runtime, engine } = await setup(t, { provider });
  const report = await runQualification(runtime, scenario([
    { id: 'start', action: 'change', input: render(), assertions: [equals('/status', 'pending')] },
    { id: 'wait', action: 'wait_job', input: { job_id: { $ref: 'start#/result/data/job_id' } }, max_polls: 1, assertions: [equals('/status', 'succeeded'), { kind: 'exists', pointer: '/data/artifact/manifest_sha256' }] },
  ]));
  assert.equal(report.status, 'scenario_passed'); assert.equal(report.live_fusion_qualified, false);
  assert.equal(report.successful_operations.some(operation => operation.operation === 'render.start' && operation.completion_assertions_passed), true);
  assert.equal(report.execution_contract_sha256, engine.executionContractHash);
  for (const item of report.evidence) {
    const receipt = await engine.store.get(item.result_receipt.kind, item.result_receipt.id);
    assert.equal(hash(receipt), item.result_receipt.sha256);
  }
});

test('reference expansion is bounded before it can amplify a large provider result into an execution', async t => {
  const provider = new DesktopDouble(); provider.listExtra = { blob: 'x'.repeat(1_100_000) };
  const { runtime } = await setup(t, { provider });
  const report = await runQualification(runtime, scenario([
    { id: 'data', action: 'read', input: { operation: 'documents.list', args: {} }, assertions: [{ kind: 'exists', pointer: '/data/blob' }] },
    { id: 'expand', action: 'change', input: { operation: 'parameters.set', document_id: DOCUMENT, args: { changes: [{ parameter_id: 'one', expression: { $ref: 'data#/data/blob' } }, { parameter_id: 'two', expression: { $ref: 'data#/data/blob' } }] } }, assertions: [equals('/status', 'succeeded')] },
  ]));
  assert.equal(report.status, 'failed'); assert.equal(report.evidence[1].error.code, 'PAYLOAD_TOO_LARGE'); assert.equal(provider.count('parameters.set'), 0);
  assert.equal(report.evidence[0].result, undefined); assert.equal(report.evidence[0].result_receipt.size_bytes > 1_000_000, true);
  assert.equal(Buffer.byteLength(JSON.stringify(report)) < 100_000, true);
});

test('JSON pointers cannot resolve inherited properties or malformed escapes', () => {
  assert.throws(() => jsonPointer({}, '/constructor'), { code: 'ASSERTION_PATH_MISSING' });
  assert.throws(() => jsonPointer({ a: 1 }, '/a~2b'), { code: 'INVALID_POINTER' });
  assert.equal(jsonPointer({ 'a/b': { '~': 7 } }, '/a~1b/~0'), 7);
});

/** Unit seam for the enrolled provider type, not a real Fusion connection. */
class EnrolledNativeDouble extends NativeFusionClient {
  constructor(double) { super({ url: 'http://127.0.0.1:27182/mcp', handlerSource: 'reviewed test handler, not Autodesk' }); this.double = double; }
  dispatch(request) { return this.double.dispatch(request); }
}
async function qualifiedSetup(t, mutateBinding = () => {}) {
  const provider = new DesktopDouble();
  provider.listExtra = { execution: 'main_thread_reviewed_handler', fusion_version: 'protocol-build-1', session_id: `fusion_session_${'a'.repeat(32)}` };
  const { directory } = await setup(t);
  const compiled = path.join(directory, 'qualified-contract.mjs'); const code = 'export const protocolDouble = true;';
  await writeFile(compiled, code, { mode: 0o600 });
  const contract = hash({ 'qualified-contract.mjs': hashBytes(code) });
  const raw = fixtureProfile(directory);
  raw.mode = 'managed'; raw.id = 'managed-protocol-double';
  raw.desktop = { provider: 'native', url: 'http://127.0.0.1:27182/mcp', mapping: { tool: 'reviewed_test_tool', argument: 'script', schemaHash: 'a'.repeat(64) }, timeoutMs: 1000 };
  raw.policy.operations = ['parameters.set']; raw.policy.qualifiedOperations = ['parameters.set'];
  raw.policy.grantExpiresAt = new Date(Date.now() + 600_000).toISOString(); raw.policy.qualificationEvidence = 'Only protocol gate checks, never Autodesk execution evidence';
  raw.policy.desktopQualification = { version: 1, provider: 'native', fusionVersion: 'protocol-build-1', platform: process.platform, arch: process.arch, osRelease: os.release(), handlerSha256: HANDLER, executionContractSha256: contract, expiresAt: new Date(Date.now() + 600_000).toISOString(), evidence: 'A deterministic provider double tests admission mechanics only', reviewer: 'automated unit regression, not engineering approval' };
  mutateBinding(raw.policy.desktopQualification, raw);
  const profile = parseProfile(raw);
  const engine = new FusionEngine(profile, new EnrolledNativeDouble(provider), HANDLER, { executionContractHash: contract, executionContractFiles: [{ path: compiled, sha256: hashBytes(code) }] });
  await engine.init(); t.after(() => engine.close());
  return { engine, provider, profile, compiled };
}

for (const [label, mutate, code] of [
  ['missing binding', (_binding, profile) => { delete profile.policy.desktopQualification; }, 'DESKTOP_QUALIFICATION_REQUIRED'],
  ['different Fusion build', binding => { binding.fusionVersion = 'other-build'; }, 'DESKTOP_QUALIFICATION_CHANGED'],
  ['different reviewed handler', binding => { binding.handlerSha256 = '0'.repeat(64); }, 'DESKTOP_QUALIFICATION_CHANGED'],
  ['different compiled contract', binding => { binding.executionContractSha256 = '0'.repeat(64); }, 'DESKTOP_QUALIFICATION_CHANGED'],
  ['different provider', binding => { binding.provider = 'addin'; }, 'DESKTOP_QUALIFICATION_CHANGED'],
  ['different broker architecture', binding => { binding.arch = 'another-architecture'; }, 'DESKTOP_QUALIFICATION_CHANGED'],
  ['different broker OS release', binding => { binding.osRelease = 'another-release'; }, 'DESKTOP_QUALIFICATION_CHANGED'],
  ['expired binding', binding => { binding.expiresAt = new Date(Date.now() - 1000).toISOString(); }, 'DESKTOP_QUALIFICATION_EXPIRED'],
]) test(`managed qualification rejects ${label} before mutation while preserving inspection`, async t => {
  const { engine, provider } = await qualifiedSetup(t, mutate);
  assert.equal((await engine.read({ operation: 'document.inspect', document_id: DOCUMENT, args: {} })).data.document_id, DOCUMENT);
  const plan = await engine.prepare(change());
  assert.equal(plan.policy_decision.authorized, false); assert.equal(plan.policy_decision.blocker, code);
  await assert.rejects(engine.execute(plan.id, plan.hash, 'qualified-gate-request'), { code });
  assert.equal(provider.count('parameters.set'), 0);
});

test('a matching mocked qualification binding admits the reviewed call, without independently verifying Autodesk', async t => {
  const { engine, provider } = await qualifiedSetup(t);
  const { prepared, result } = await execute(engine, change());
  assert.equal(prepared.policy_decision.authorized, true); assert.equal(result.status, 'succeeded');
  assert.equal(provider.count('parameters.set'), 1);
  assert.equal(provider.calls.filter(call => call.request_id.startsWith('qualification_probe_')).length >= 2, true);
  const status = await engine.connectionStatus();
  assert.equal(status.live_fusion_verified, false); assert.equal(status.desktop_evidence.independently_verified, false);
  assert.equal(status.desktop_qualification_candidate.fusionVersion, 'protocol-build-1');
  assert.equal(status.desktop_qualification_candidate.provider, 'native'); assert.equal(status.desktop_qualification_candidate.platform, process.platform);
  assert.equal(status.desktop_qualification_candidate.handlerSha256, HANDLER); assert.equal(status.desktop_qualification_candidate.executionContractSha256, engine.executionContractHash);
  for (const field of ['reviewer', 'evidence', 'expiresAt']) assert.equal(Object.hasOwn(status.desktop_qualification_candidate, field), false, `${field} is never synthesized as approval`);
});

test('Fusion build drift after preparation blocks a previously admitted managed plan', async t => {
  const { engine, provider } = await qualifiedSetup(t);
  const plan = await engine.prepare(change()); assert.equal(plan.policy_decision.authorized, true);
  provider.listExtra.fusion_version = 'protocol-build-2';
  await assert.rejects(engine.execute(plan.id, plan.hash, 'version-drift-request'), { code: 'DESKTOP_QUALIFICATION_CHANGED' });
  assert.equal(provider.count('parameters.set'), 0);
});

test('NC futures retain pinned review/asset admission and cannot publish a partial bundle', async t => {
  const { engine, provider, profile } = await setup(t, { configure: async (p, directory, double) => {
    const assets = [
      ['posts', 'post', 'reviewed.cps', '// reviewed protocol-double post'],
      ['machines', 'machine', 'reviewed.machine', '{"protocol_double":true}'],
      ['toolLibraries', 'tools', 'reviewed-tools.json', '{"data":[]}'],
    ];
    for (const [registry, id, basename, bytes] of assets) {
      const filename = path.join(directory, basename); await writeFile(filename, bytes);
      p.assets[registry].push({ id, path: filename, sha256: hashBytes(bytes) });
    }
    p.manufacturing.push({ id: 'reviewed', postId: 'post', machineId: 'machine', toolLibrarySha256: p.assets.toolLibraries[0].sha256, strategyIds: ['pocket2d'], units: 'mm', qualificationEvidence: 'Protocol-only admission checks, not a machine approval', reviewRecords: [{ id: 'review', sourceState: double.state(DOCUMENT), method: 'protocol double', reviewedBy: 'test, not operator verification', expiresAt: new Date(Date.now() + 600_000).toISOString() }] });
  } });
  const operation = { operation: 'cam.nc_post', document_id: DOCUMENT, args: { operation_ids: ['fixture:cutting-operation'], manufacturing_profile_id: 'reviewed', review_record_id: 'review', program_name: 'candidate', output: { root: 'artifacts', filename: 'candidate.nc' } } };
  const plan = await engine.prepare(operation);
  const post = profile.assets.posts[0]; await writeFile(post.path, 'changed post bytes');
  await assert.rejects(engine.execute(plan.id, plan.hash, 'nc-reviewed-request'), { code: 'ASSET_CHANGED' });
  assert.equal(provider.count('cam.nc_post'), 0);
  await writeFile(post.path, '// reviewed protocol-double post');
  const pending = await engine.execute(plan.id, plan.hash, 'nc-reviewed-request');
  assert.equal(pending.status, 'pending'); assert.equal((await engine.artifacts.inspect(plan.artifact.id)).files, undefined);
  await writeFile(path.join(provider.outputFolder, 'auxiliary.nc'), '(SECOND PROTOCOL FILE)\nM30\n');
  provider.futureStatus = 'succeeded';
  const complete = await engine.jobStatus(pending.result.job.id);
  assert.equal(complete.status, 'succeeded'); assert.equal(complete.data.artifact.files.length, 2);
  assert.match(complete.data.artifact.limitation, /do not establish collision safety/);
  assert.equal(provider.count('cam.nc_post'), 1);
});

test('managed qualification lifetime is rechecked after preparation', async t => {
  const { engine, provider } = await qualifiedSetup(t, binding => { binding.expiresAt = new Date(Date.now() + 60_000).toISOString(); });
  const plan = await engine.prepare(change()); assert.equal(plan.policy_decision.authorized, true);
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 120_000;
    await assert.rejects(engine.execute(plan.id, plan.hash, 'qualification-expiry-request'), { code: 'DESKTOP_QUALIFICATION_EXPIRED' });
  } finally { Date.now = originalNow; }
  assert.equal(provider.count('parameters.set'), 0);
});
