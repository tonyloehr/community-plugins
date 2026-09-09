#!/usr/bin/env node
/** Local synthetic measurements only. Importing this module performs no work. */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay, setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCUMENT = 'fixture:bracket';
const BATCH_OPERATIONS = 100;
const MAX_SOAK_SECONDS = 14_400;
const MAX_OBSERVATIONS = 512;
const DEFAULTS = Object.freeze({ samples: 30, reconnects: 10, largeParameters: 256, soakSeconds: 0, progressSeconds: 5 });
const BOUNDS = Object.freeze({ samples: [5, 200], reconnects: [2, 100], largeParameters: [128, 4096], soakSeconds: [0, MAX_SOAK_SECONDS], progressSeconds: [1, 60] });
const THRESHOLDS = Object.freeze({ schema_policy_p95_ms: 100, ledger_status_p95_ms: 500, connection_max_ms: 5000, inspection_p95_ms: 3000, rss_growth_bytes: 134_217_728, heap_growth_bytes: 67_108_864 });
const sha = value => createHash('sha256').update(value).digest('hex');
const round = value => Number(value.toFixed(6));
const sortedObject = entries => Object.fromEntries(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
const fail = (code, message) => Object.assign(new Error(message), { code });
const requireThat = (condition, code, message) => { if (!condition) throw fail(code, message); };
const inspectRequest = () => ({ operation: 'document.inspect', document_id: DOCUMENT, args: { limit: 10 } });

export function validateOptions(input) {
  requireThat(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_OPTIONS', 'Use a benchmark options object.');
  for (const key of Object.keys(input)) requireThat(key === 'outputRoot' || Object.hasOwn(DEFAULTS, key), 'INVALID_OPTIONS', 'Unknown benchmark option; profiles and providers cannot be supplied.');
  const options = { ...DEFAULTS, ...input };
  requireThat(typeof options.outputRoot === 'string' && path.isAbsolute(options.outputRoot) && !options.outputRoot.includes('\0') && !/^[/\\]{2}/u.test(options.outputRoot), 'PRIVATE_OUTPUT_REQUIRED', 'Supply an absolute local path for a new task-private output directory.');
  for (const [key, [minimum, maximum]] of Object.entries(BOUNDS)) requireThat(Number.isInteger(options[key]) && options[key] >= minimum && options[key] <= maximum, 'INVALID_OPTIONS', `${key} must be an integer from ${minimum} to ${maximum}.`);
  return options;
}

export function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const names = { '--output-root': 'outputRoot', '--samples': 'samples', '--reconnects': 'reconnects', '--large-parameters': 'largeParameters', '--soak-seconds': 'soakSeconds', '--progress-seconds': 'progressSeconds' };
  const input = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = Object.hasOwn(names, args[i]) ? names[args[i]] : undefined, value = args[i + 1];
    requireThat(key && value !== undefined && !Object.hasOwn(input, key), 'INVALID_OPTIONS', 'Use each documented option at most once, followed by its value.');
    requireThat(key === 'outputRoot' || /^\d+$/u.test(value), 'INVALID_OPTIONS', 'Numeric options must be nonnegative decimal integers.');
    input[key] = key === 'outputRoot' ? value : Number(value);
  }
  return validateOptions(input);
}

/** Empirical nearest-rank percentiles; no interpolation or population inference. */
export function summarizeSamples(samples, thresholdMs = null, statistic = 'p95_ms') {
  requireThat(Array.isArray(samples) && samples.length > 0 && samples.every(value => Number.isFinite(value) && value >= 0), 'INVALID_SAMPLES', 'Latency samples must be a nonempty finite nonnegative array.');
  requireThat(thresholdMs === null || Number.isFinite(thresholdMs) && thresholdMs > 0, 'INVALID_THRESHOLD', 'A latency threshold must be positive.');
  requireThat(['p95_ms', 'max_ms'].includes(statistic), 'INVALID_THRESHOLD', 'Use the p95 or maximum statistic.');
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = p => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  const raw = { min_ms: sorted[0], p50_ms: percentile(0.5), p95_ms: percentile(0.95), p99_ms: percentile(0.99), max_ms: sorted.at(-1), mean_ms: samples.reduce((sum, value) => sum + value, 0) / samples.length };
  return { sample_count: samples.length, ...Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, round(value)])), samples_ms: samples.map(round), percentile_definition: 'nearest rank: sorted[ceil(p * n) - 1], with p in (0,1]; no interpolation', threshold: thresholdMs === null ? null : { statistic, less_than_ms: thresholdMs, status: raw[statistic] < thresholdMs ? 'passed' : 'failed', basis: 'Proposed engineering target; this run does not establish a population percentile or an SLA.' } };
}

async function timedSamples(count, warmup, operation, check = () => {}) {
  for (let i = 0; i < warmup; i++) check(await operation());
  const samples = [];
  for (let i = 0; i < count; i++) {
    const started = performance.now();
    const result = await operation();
    samples.push(performance.now() - started);
    check(result); // Correctness checks are outside the individual latency sample.
  }
  return samples;
}

function syncSamples(count, warmup, operation) {
  for (let i = 0; i < warmup; i++) operation();
  const samples = [];
  for (let i = 0; i < count; i++) { const started = performance.now(); operation(); samples.push(performance.now() - started); }
  return samples;
}

function processObservation(label, elapsedMs, openEngines) {
  const memory = process.memoryUsage();
  const resources = typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo().reduce((counts, name) => { counts[name] = (counts[name] ?? 0) + 1; return counts; }, {}) : null;
  return { label, elapsed_ms: round(elapsedMs), rss_bytes: memory.rss, heap_used_bytes: memory.heapUsed, heap_total_bytes: memory.heapTotal, external_bytes: memory.external, array_buffer_bytes: memory.arrayBuffers, active_resources: resources && sortedObject(Object.entries(resources)), process_listeners: sortedObject(process.eventNames().map(name => [String(name), process.listenerCount(name)])), open_fixture_engines: openEngines };
}

async function reserveOutput(requested) {
  // Exclusive creation, not chmod/reuse of a user's directory or profile.
  const parent = await realpath(path.dirname(requested));
  const root = path.join(parent, path.basename(requested));
  await mkdir(root, { mode: 0o700 });
  const identity = await lstat(root, { bigint: true });
  requireThat(identity.isDirectory() && !identity.isSymbolicLink() && (process.platform === 'win32' || identity.uid === BigInt(process.getuid()) && (identity.mode & 0o077n) === 0n), 'PRIVATE_OUTPUT_REQUIRED', 'The newly created output directory must be private and owned by the current user.');
  return { root, identity };
}

async function sameDirectory(filename, identity) {
  const current = await lstat(filename, { bigint: true });
  requireThat(current.isDirectory() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino, 'OUTPUT_DIRECTORY_CHANGED', 'The task-private directory identity changed; automatic cleanup was refused.');
}

async function loadIdentity() {
  const receiptBytes = await readFile(path.join(ROOT, 'dist', 'build-receipt.json'));
  requireThat(receiptBytes.length <= 2_097_152, 'PACKAGE_INTEGRITY', 'The build receipt exceeds the supported bound.');
  const receipt = JSON.parse(receiptBytes);
  requireThat(receipt.schema === 1 && receipt.files && typeof receipt.files === 'object', 'PACKAGE_INTEGRITY', 'A versioned build receipt is required.');
  const compiled = Object.entries(receipt.files).filter(([name]) => /^dist\/[A-Za-z0-9._-]+\.mjs$/u.test(name));
  requireThat(compiled.length >= 3 && compiled.length <= 100 && ['dist/index.mjs', 'dist/server.mjs', 'dist/cli.mjs'].every(name => compiled.some(([file]) => name === file)), 'PACKAGE_INTEGRITY', 'Required compiled entry points are missing from the receipt.');
  for (const [name, expected] of compiled) {
    const filename = path.join(ROOT, name), info = await lstat(filename);
    requireThat(/^[a-f0-9]{64}$/u.test(expected) && info.isFile() && !info.isSymbolicLink() && info.size <= 32_000_000 && sha(await readFile(filename)) === expected, 'PACKAGE_INTEGRITY', 'A compiled module differs from its build receipt. Rebuild the reviewed source first.');
  }
  const actualModules = (await readdir(path.join(ROOT, 'dist'))).filter(name => name.endsWith('.mjs')).map(name => `dist/${name}`).sort();
  requireThat(JSON.stringify(actualModules) === JSON.stringify(compiled.map(([name]) => name).sort()), 'PACKAGE_INTEGRITY', 'The compiled module set differs from the receipt.');
  const sourceExpected = Object.entries(receipt.files).filter(([name]) => /^src\/[A-Za-z0-9._-]+\.ts$/u.test(name) || name === 'handlers/fusion_runtime.py');
  const sourceObserved = [], differences = [];
  for (const [name, expected] of sourceExpected) {
    const actual = sha(await readFile(path.join(ROOT, name)));
    sourceObserved.push([name, actual]);
    if (actual !== expected) differences.push(name);
  }
  const api = await import(pathToFileURL(path.join(ROOT, 'dist', 'index.mjs')).href);
  const contract = await api.installedExecutionContract(ROOT);
  return { api, contract, evidence: { build_receipt_sha256: sha(receiptBytes), compiled_files: sortedObject(compiled), execution_contract_sha256: contract.executionContractHash, execution_contract_kind: 'installed_code', source_expected_sha256: sha(JSON.stringify(sortedObject(sourceExpected))), source_observed_sha256: sha(JSON.stringify(sortedObject(sourceObserved))), source_files: sortedObject(sourceObserved), source_matches_receipt: sourceExpected.length > 0 && differences.length === 0, source_differences: differences, harness_sha256: sha(await readFile(fileURLToPath(import.meta.url))) } };
}

function checkSynthetic(response) {
  requireThat(response?.evidence === 'synthetic_fixture' && response.data?.live_fusion_verified === false && typeof response.state === 'string', 'FIXTURE_EVIDENCE_INVALID', 'The local inspection must remain explicitly synthetic and state bound.');
}

async function scanState(root) {
  const result = { exists: true, files: 0, bytes: 0, execution_locks: [], temporary_records: [] };
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name), relative = path.relative(root, filename).split(path.sep).join('/');
      requireThat(!entry.isSymbolicLink(), 'UNEXPECTED_STATE_LINK', 'The synthetic state tree contains an unexpected link.');
      if (entry.isDirectory()) await walk(filename);
      else { result.files++; result.bytes += (await lstat(filename)).size; }
      if (entry.name === '.execution.lock') result.execution_locks.push(relative);
      if (entry.name.startsWith('tmp--')) result.temporary_records.push(relative);
      requireThat(result.files <= 10_000, 'BENCHMARK_STATE_LIMIT', 'The benchmark exceeded its bounded state file count.');
    }
  }
  try { await walk(root); } catch (error) { if (error.code === 'ENOENT' && result.files === 0) result.exists = false; else throw error; }
  return result;
}

/** Only built-in synthetic providers are constructed; no profile/provider injection. */
export async function runBenchmark(input, onProgress = () => {}) {
  const options = validateOptions(input);
  requireThat(typeof onProgress === 'function', 'INVALID_OPTIONS', 'Progress reporting must be a function.');
  const started = performance.now(), output = await reserveOutput(options.outputRoot);
  const stateRoot = path.join(output.root, 'state');
  let stateIdentity, timer, api, contract, phase = 'initialization', interrupted = false, baseline;
  const engines = new Set(), observations = [], counters = { engines_created: 0, engines_closed: 0, provider_dispatches: 0, provider_dispatches_in_flight: 0, progress_events: 0, soak_cycles: 0 };
  const report = { schema: 1, kind: 'fusion_local_fixture_benchmark', run_id: randomUUID(), started_at: new Date().toISOString(), live_fusion_verified: false, scope: 'Local synthetic fixtures only; no Autodesk kernel, transport, account, credential, network, or cloud service is constructed.', configuration: { ...options, outputRoot: undefined, batch_operations: BATCH_OPERATIONS, schema_samples: options.samples * 10, schema_warmup: 20, io_warmup: 3 }, platform: { platform: process.platform, arch: process.arch, os_release: os.release(), node: process.version, v8: process.versions.v8, uv: process.versions.uv, cpu_model: os.cpus()[0]?.model ?? null, logical_cpu_count: os.cpus().length, total_memory_bytes: os.totalmem() }, thresholds: THRESHOLDS, measurements: {}, checks: {}, unavailable: [], observations, limits: ['One process and one workstation; samples are dependent and caches/GC affect timings.', 'Empirical nearest-rank percentiles are descriptive; no confidence interval, population guarantee, or SLA is asserted.', 'Fixture reopen/close is not a native/add-in transport reconnect or Autodesk handler lifecycle test.', 'RSS, heap, active resources and process listeners are observations, not proof of absence of leaks. No forced GC is used.'] };
  let peakRss = 0, peakHeap = 0, droppedObservations = 0;
  function observe(label) {
    const value = processObservation(label, performance.now() - started, engines.size);
    peakRss = Math.max(peakRss, value.rss_bytes); peakHeap = Math.max(peakHeap, value.heap_used_bytes);
    if (observations.length === MAX_OBSERVATIONS) { observations.splice(1, 1); droppedObservations++; }
    observations.push(value); return value;
  }
  function progress(event = 'progress') {
    counters.progress_events++;
    const value = observe(phase);
    // A reporting failure must enter the same bounded cleanup path as a workload failure.
    onProgress({ event, phase, elapsed_ms: value.elapsed_ms, rss_bytes: value.rss_bytes, heap_used_bytes: value.heap_used_bytes, open_fixture_engines: engines.size, completed_batch_operations: report.checks.state_bound_batch?.completed ?? 0, soak_cycles: counters.soak_cycles });
  }
  const stop = () => { interrupted = true; };
  const assertRunning = () => requireThat(!interrupted, 'BENCHMARK_INTERRUPTED', 'The local benchmark was interrupted; its partial evidence is retained.');
  async function closeEngine(engine) { if (engines.has(engine)) { await engine.close(); engines.delete(engine); counters.engines_closed++; } }
  function register(engine) {
    engines.add(engine); counters.engines_created++;
    const dispatch = engine.desktop.dispatch.bind(engine.desktop);
    engine.desktop.dispatch = async request => {
      assertRunning(); counters.provider_dispatches++; counters.provider_dispatches_in_flight++;
      try { return await dispatch(request); } finally { counters.provider_dispatches_in_flight--; }
    };
    return engine;
  }
  function profileFor(name) {
    const profile = api.fixtureProfile(path.join(stateRoot, name));
    // Explicit, fixture-only admission budget for the fixed 100-plan workload.
    profile.policy.maxPlansPerMinute = 600;
    profile.policy.readDocuments = [DOCUMENT];
    return api.parseProfile(profile);
  }
  async function createEngine(name) { return register(await api.createFixtureEngine(profileFor(name), contract)); }
  function measurement(name, samples, details, threshold = null, statistic = 'p95_ms') {
    const summary = summarizeSamples(samples, threshold, statistic);
    report.measurements[name] = { status: summary.threshold?.status ?? 'passed', ...details, ...summary };
  }
  try {
    progress('started');
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    timer = setInterval(() => { try { progress(); } catch { interrupted = true; } }, options.progressSeconds * 1000);
    timer.unref();
    const identity = await loadIdentity(); ({ api, contract } = identity);
    report.identity = identity.evidence;
    await api.ensurePrivateDirectory(output.root);
    await api.ensurePrivateDirectory(stateRoot);
    stateIdentity = await lstat(stateRoot, { bigint: true });
    report.fixture = { implementation: 'FixtureDesktopProvider', fixture_schema: 1, document_count: 1, analytic_body_count: 1, initial_parameter_count: 3, initial_dimensions_mm: [40, 20, 5], large_parameter_count: options.largeParameters + 3, fixture_definition_sha256: api.hash({ fixture_schema: 1, dimensions_mm: [40, 20, 5], large_extra_parameters: options.largeParameters, generated_names: 'bench_00000..bench_N; expression=(index+1) mm' }), fixture_source_sha256: report.identity.source_files['src/fixture.ts'] };
    report.measurements.module_and_identity_load = { status: 'passed', elapsed_ms: round(performance.now() - started), samples: 1, includes: 'Private output reservation, compiled receipt verification and module import; reported separately from fixture connection.' };

    phase = 'initial_fixture_connection';
    const initialStarted = performance.now();
    let engine = await createEngine('main');
    const initialConnection = await engine.connectionStatus(), initialCapabilities = engine.capabilities();
    requireThat(initialConnection.desktop_evidence?.kind === 'synthetic_fixture' && initialConnection.live_fusion_verified === false && initialConnection.desktop?.data?.documents?.length === 1 && initialCapabilities.operations.length > 0, 'FIXTURE_CONNECTION_FAILED', 'The local fixture did not provide its synthetic connection/capability report.');
    measurement('initial_fixture_connection', [performance.now() - initialStarted], { warmup: 0, includes: 'Fresh fixture engine initialization, local store, connectionStatus and capabilities; module loading excluded. No transport handshake exists.' }, THRESHOLDS.connection_max_ms, 'max_ms');
    const inputOperation = { operation: 'parameters.set', document_id: DOCUMENT, args: { changes: [{ parameter_id: 'fixture:param:width', expression: '41 mm' }] } };
    const parsed = api.parseOperation(inputOperation), definition = api.getOperation(parsed.operation), profile = engine.profile;
    phase = 'schema_and_policy';
    const pureCount = options.samples * 10;
    measurement('schema', syncSamples(pureCount, 20, () => api.parseOperation(inputOperation)), { warmup: 20, includes: 'Synchronous parseOperation only; no promise, filesystem or provider call.' });
    measurement('policy', syncSamples(pureCount, 20, () => api.authorize(profile, parsed.operation, definition.effect, DOCUMENT)), { warmup: 20, includes: 'Synchronous authorize on an already parsed operation/profile; no storage, provider, live qualification or host trust-file checks.' });
    measurement('schema_policy', syncSamples(pureCount, 20, () => { const op = api.parseOperation(inputOperation); api.authorize(profile, op.operation, api.getOperation(op.operation).effect, op.document_id); }), { warmup: 20, includes: 'Synchronous schema plus in-memory policy only; no filesystem/provider calls or managed desktop qualification.' }, THRESHOLDS.schema_policy_p95_ms);
    baseline = observe('baseline_after_schema_warmup');
    peakRss = baseline.rss_bytes; peakHeap = baseline.heap_used_bytes;

    phase = 'small_fixture_reads';
    measurement('fixture_connection_status', await timedSamples(options.samples, 3, () => engine.connectionStatus(), result => requireThat(result.desktop_evidence?.kind === 'synthetic_fixture', 'FIXTURE_CONNECTION_FAILED', 'Connection reporting lost its synthetic evidence.')), { warmup: 3, includes: 'Engine configuration/code integrity checks, local filesystem and fixture dispatch; no transport.' }, THRESHOLDS.connection_max_ms, 'max_ms');
    measurement('fixture_capabilities', syncSamples(options.samples, 3, () => engine.capabilities()), { warmup: 3, includes: 'Synchronous static capability report; not a live availability/entitlement probe.' });
    measurement('small_fixture_inspection', await timedSamples(options.samples, 3, () => engine.read(inspectRequest()), checkSynthetic), { warmup: 3, includes: 'Engine read, schema/policy, installed-code checks, local filesystem and three-parameter analytic fixture.' }, THRESHOLDS.inspection_p95_ms);
    await closeEngine(engine); engine = null;

    phase = 'fixture_reopens';
    const reopenSamples = [];
    for (let i = 0; i < options.reconnects; i++) {
      assertRunning(); const begin = performance.now(); const reopened = await createEngine('main');
      try { const read = await reopened.read(inspectRequest()); checkSynthetic(read); requireThat(read.data.parameters.find(p => p.name === 'width')?.value_mm === 40, 'REOPEN_READBACK_FAILED', 'A fresh fixture engine did not read its expected persistent state.'); await reopened.connectionStatus(); reopened.capabilities(); }
      finally { await closeEngine(reopened); }
      reopenSamples.push(performance.now() - begin);
    }
    measurement('fixture_reopen_inspect_close', reopenSamples, { warmup: 0, includes: 'Create/initialize a new fixture engine, inspect persistent state, report connection/capabilities, and call close. Fixture provider owns no socket or Autodesk handlers.' }, THRESHOLDS.connection_max_ms, 'max_ms');
    report.checks.repeated_reopens = { status: 'passed', completed: options.reconnects, live_transport_reconnects: 0, fixture_provider_close_hook: false };
    observe('after_fixture_reopens');

    phase = 'terminal_ledger';
    // A protocol double creates a real, bound terminal broker job through prepare/execute.
    // It does not model CAM execution or claim the stock fixture implements cam.generate.
    class TerminalJobFixture extends api.FixtureDesktopProvider {
      async dispatch(request) {
        if (request.operation !== 'cam.generate') return super.dispatch(request);
        const before = await super.dispatch({ ...request, operation: 'document.inspect', args: {} });
        if (!before.ok) return before;
        return { ok: true, state: before.state, data: { job_id: 'benchmark_terminal_future', status: 'succeeded', provider: 'synthetic_fixture', live_fusion_verified: false }, effects: [] };
      }
    }
    const ledgerProfile = profileFor('ledger');
    const terminal = register(new api.FusionEngine(ledgerProfile, new TerminalJobFixture(new api.RecordStore(ledgerProfile.stateRoot)), api.hashBytes('benchmark-terminal-protocol-double-v1'), contract));
    await terminal.init();
    const jobPlan = await terminal.prepare({ operation: 'cam.generate', document_id: DOCUMENT, args: { operation_ids: ['fixture:synthetic-operation'] } });
    const jobResult = await terminal.execute(jobPlan.id, jobPlan.hash, 'benchmark-terminal-job-once');
    const jobId = jobResult.result?.job?.id;
    requireThat(jobResult.status === 'succeeded' && typeof jobId === 'string', 'TERMINAL_JOB_SETUP_FAILED', 'The local job protocol fixture did not create a bound terminal broker record.');
    const callsBeforeLedger = counters.provider_dispatches;
    measurement('ledger_record_read', await timedSamples(options.samples, 3, () => terminal.store.get('job', jobId), job => requireThat(job?.status === 'succeeded', 'LEDGER_READBACK_FAILED', 'A terminal ledger record did not read back.')), { warmup: 3, includes: 'RecordStore.get only: private filesystem read, safety checks and JSON parsing; no engine job binding or provider refresh.' });
    measurement('ledger_terminal_job_status', await timedSamples(options.samples, 3, () => terminal.jobStatus(jobId, DOCUMENT, 'desktop_cam'), job => requireThat(job.status === 'succeeded', 'LEDGER_STATUS_FAILED', 'A terminal local job changed status.')), { warmup: 3, includes: 'Actual engine.jobStatus with code/profile checks, lease, plan/job binding and local record reads. No expected_state/artifact/provider refresh.' }, THRESHOLDS.ledger_status_p95_ms);
    report.checks.ledger_no_provider_refresh = { status: counters.provider_dispatches === callsBeforeLedger ? 'passed' : 'failed', measured_provider_dispatches: counters.provider_dispatches - callsBeforeLedger, terminal_record_origin: 'Local CAM protocol double; not Autodesk CAM or a stock fixture capability.' };
    await closeEngine(terminal);

    phase = 'state_bound_batch';
    engine = await createEngine('batch');
    let observed = await engine.read(inspectRequest()); checkSynthetic(observed);
    const states = new Set([observed.state]), batchSamples = [];
    report.checks.state_bound_batch = { status: 'incomplete', requested: BATCH_OPERATIONS, completed: 0, readbacks: 0, distinct_states: 1, semantics: '100 sequential, individually state-bound plans; not an atomic 100-operation transaction or CAD recompute test.' };
    for (let i = 0; i < BATCH_OPERATIONS; i++) {
      assertRunning(); const value = 41 + i, begin = performance.now();
      const plan = await engine.prepare({ ...inputOperation, expected_state: observed.state, args: { changes: [{ parameter_id: 'fixture:param:width', expression: `${value} mm` }] } });
      requireThat(plan.expected_state === observed.state && plan.policy_decision.authorized, 'BATCH_PLAN_NOT_BOUND', 'A synthetic batch plan lost its explicit state/policy binding.');
      const done = await engine.execute(plan.id, plan.hash, `benchmark-batch-operation-${i}`);
      requireThat(done.status === 'succeeded', 'BATCH_EXECUTION_FAILED', 'A synthetic batch operation did not complete successfully.');
      const next = await engine.read(inspectRequest()); checkSynthetic(next);
      requireThat(next.state !== observed.state && !states.has(next.state) && next.data.parameters.find(p => p.name === 'width')?.value_mm === value, 'BATCH_READBACK_FAILED', 'A synthetic batch state or numeric readback was incorrect.');
      observed = next; states.add(next.state); batchSamples.push(performance.now() - begin);
      Object.assign(report.checks.state_bound_batch, { completed: i + 1, readbacks: i + 1, distinct_states: states.size });
      if ((i + 1) % 20 === 0) { progress(); await nextTurn(); }
    }
    report.checks.state_bound_batch.status = 'passed';
    report.checks.state_bound_batch.final_width_mm = 140;
    measurement('state_bound_batch_operation', batchSamples, { warmup: 0, includes: 'Prepare, execute, durable writes and explicit state/numeric readback for each individual synthetic update; descriptive only, no batch latency target.' });
    await closeEngine(engine); engine = await createEngine('batch');
    const persisted = await engine.read(inspectRequest());
    requireThat(persisted.state === observed.state && persisted.data.parameters.find(p => p.name === 'width')?.value_mm === 140, 'BATCH_REOPEN_FAILED', 'The completed 100-operation result did not survive reopening its fixture engine.');
    report.checks.state_bound_batch.persisted_after_reopen = true;
    await closeEngine(engine); engine = null; observe('after_state_bound_batch');

    phase = 'large_synthetic_fixture';
    engine = await createEngine('large');
    const parameters = { width: { expression: '40 mm', value_mm: 40 }, height: { expression: '20 mm', value_mm: 20 }, thickness: { expression: '5 mm', value_mm: 5 } };
    for (let i = 0; i < options.largeParameters; i++) parameters[`bench_${String(i).padStart(5, '0')}`] = { expression: `${i + 1} mm`, value_mm: i + 1 };
    await engine.store.put('fixture', 'bracket', { revision: 1, parameters, saved: false });
    report.fixture.large_state_sha256 = api.hash({ revision: 1, parameters, saved: false });
    const projection = await engine.read({ operation: 'parameters.list', document_id: DOCUMENT, args: { limit: 100 } }); checkSynthetic(projection);
    const projectionComplete = typeof projection.data.total === 'number' && typeof projection.data.truncated === 'boolean';
    report.checks.large_parameter_projection = { status: projectionComplete ? projection.data.parameters.length === 100 && projection.data.total === options.largeParameters + 3 && projection.data.truncated === true ? 'passed' : 'failed' : 'incomplete', requested_limit: 100, observed_count: projection.data.parameters.length, reported_total: projection.data.total ?? null, reported_truncated: projection.data.truncated ?? null, scope: 'Synthetic parameter prefix; parameters.list has no offset/cursor contract.' };
    const pageSamples = [], seen = new Set(), pageSize = 64;
    let offset = 0, pagingComplete = false, pagingUnavailable = false, pageCount = 0;
    const maxPages = Math.ceil((options.largeParameters + 3) / pageSize) + 1;
    while (pageCount < maxPages) {
      assertRunning(); const begin = performance.now();
      const page = await engine.read({ operation: 'entities.find', document_id: DOCUMENT, args: { kind: 'parameter', limit: pageSize, offset } }); checkSynthetic(page);
      pageSamples.push(performance.now() - begin); pageCount++;
      if (!Array.isArray(page.data.entities) || !Object.hasOwn(page.data, 'next_offset')) { pagingUnavailable = true; break; }
      requireThat(page.data.entities.length <= pageSize && page.data.offset === offset && page.data.total === options.largeParameters + 3, 'FIXTURE_PAGINATION_INVALID', 'The synthetic entity page violated its declared bounds or completeness metadata.');
      for (const entry of page.data.entities) { requireThat(typeof entry.entity_id === 'string' && !seen.has(entry.entity_id), 'FIXTURE_PAGINATION_INVALID', 'The synthetic traversal repeated or omitted an entity identity.'); seen.add(entry.entity_id); }
      if (page.data.next_offset === null) { pagingComplete = true; break; }
      requireThat(page.data.entities.length > 0 && page.data.next_offset === offset + page.data.entities.length, 'FIXTURE_PAGINATION_INVALID', 'The synthetic cursor did not advance by the returned bounded page size.');
      offset = page.data.next_offset;
    }
    report.checks.large_entity_pagination = { status: pagingUnavailable ? 'incomplete' : pagingComplete && seen.size === options.largeParameters + 3 ? 'passed' : 'failed', page_count: pageCount, page_size: pageSize, maximum_pages: maxPages, unique_entities: seen.size, expected_entities: options.largeParameters + 3, complete: pagingComplete, scope: 'Persisted synthetic parameter entities, not large B-rep/assembly/CAM data.', ...(pagingUnavailable ? { reason: 'This compiled fixture lacks the canonical entities/offset/next_offset response; no large-model pagination claim is possible.' } : {}) };
    measurement('large_synthetic_entity_page', pageSamples, { warmup: 0, includes: 'Bounded synthetic entity requests, local fixture state load/hash and engine checks. No CAD kernel or large-model target is inferred.' });
    const rejected = [
      { operation: 'entities.find', document_id: DOCUMENT, args: { kind: 'parameter', limit: 101 } },
      { operation: 'entities.find', document_id: DOCUMENT, args: { kind: 'parameter', limit: 0 } },
      { operation: 'entities.find', document_id: DOCUMENT, args: { kind: 'parameter', offset: -1 } },
      { operation: 'entities.find', document_id: DOCUMENT, args: { kind: 'parameter', offset: 10001 } },
      { operation: 'parameters.list', document_id: DOCUMENT, args: { limit: 101 } },
      { operation: 'documents.list', args: { limit: 257 } },
      { ...inputOperation, args: { changes: Array.from({ length: 201 }, () => inputOperation.args.changes[0]) } },
    ];
    for (const request of rejected) { let code; try { api.parseOperation(request); } catch (error) { code = error.code; } requireThat(code === 'INVALID_INPUT', 'SCHEMA_LIMIT_NOT_ENFORCED', 'An oversized synthetic request was not rejected by the schema.'); }
    report.checks.schema_limits = { status: 'passed', rejected_requests: rejected.length, provider_dispatches: 0, maximum_entity_limit: 100, maximum_entity_offset: 10000, maximum_parameter_changes: 200 };
    await closeEngine(engine); engine = null; observe('after_large_fixture');

    phase = 'optional_soak';
    report.checks.soak = { status: options.soakSeconds ? 'incomplete' : 'not_requested', requested_seconds: options.soakSeconds, maximum_seconds: MAX_SOAK_SECONDS, cycle_interval_ms: 1000, completed_cycles: 0, multi_hour_fixture_session_exercised: false };
    if (options.soakSeconds) {
      progress('soak_started');
      engine = await createEngine('main');
      const soakStarted = performance.now(), deadline = soakStarted + options.soakSeconds * 1000, soakSamples = [];
      while (performance.now() < deadline) {
        assertRunning(); const begin = performance.now();
        const current = await engine.read(inspectRequest()); checkSynthetic(current); engine.capabilities();
        counters.soak_cycles++; report.checks.soak.completed_cycles = counters.soak_cycles;
        if (counters.soak_cycles % 10 === 0) { await closeEngine(engine); engine = await createEngine('main'); await engine.connectionStatus(); }
        soakSamples.push(performance.now() - begin);
        // The interval yields the event loop; no blocking sleep or indefinite operation is used.
        await delay(Math.max(0, Math.min(1000 - (performance.now() - begin), deadline - performance.now())));
      }
      await closeEngine(engine); engine = null;
      const elapsed = performance.now() - soakStarted;
      Object.assign(report.checks.soak, { status: 'passed', elapsed_ms: round(elapsed), multi_hour_fixture_session_exercised: elapsed >= 7_200_000 });
      measurement('soak_fixture_cycle', soakSamples, { warmup: 0, includes: 'One local inspection/capability cycle and every tenth cycle a fixture reopen. The pacing interval is excluded.' });
      progress('soak_completed');
    }
    phase = 'lock_probe';
    const lockStore = new api.RecordStore(path.join(stateRoot, 'batch'));
    const release = await lockStore.acquireLease(); let duplicateCode;
    try { try { await lockStore.acquireLease(); } catch (error) { duplicateCode = error.code; } }
    finally { await release(); }
    requireThat(duplicateCode === 'EXECUTION_LOCKED', 'LEASE_EXCLUSION_FAILED', 'The fixture ledger did not reject a concurrent lease.');
    report.checks.lease_exclusion = { status: 'passed', rejected_concurrent_lease: true };
    requireThat(sha(await readFile(path.join(ROOT, 'dist', 'build-receipt.json'))) === report.identity.build_receipt_sha256 && sha(await readFile(fileURLToPath(import.meta.url))) === report.identity.harness_sha256, 'BENCHMARK_CODE_CHANGED', 'The compiled receipt or harness changed during the benchmark.');
    assertRunning();
  } catch (error) {
    report.error = { phase, code: typeof error.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code) ? error.code : 'BENCHMARK_FAILED', message: 'The local benchmark did not complete this lane; inspect its checks and rerun after fixing the reported condition. No live provider was used.' };
  } finally {
    clearInterval(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    phase = 'cleanup';
    const closeErrors = [];
    for (const engine of engines) { try { await closeEngine(engine); } catch { closeErrors.push('FIXTURE_CLOSE_FAILED'); } }
    report.cleanup = { status: 'incomplete', engine_close_errors: closeErrors, before: null, after: null };
    try {
      report.cleanup.before = await scanState(stateRoot);
      observe('before_state_cleanup');
      await sameDirectory(output.root, output.identity);
      if (stateIdentity) { await sameDirectory(stateRoot, stateIdentity); await rm(stateRoot, { recursive: true }); }
      report.cleanup.after = await scanState(stateRoot);
      report.cleanup.status = !closeErrors.length && !report.cleanup.before.execution_locks.length && !report.cleanup.before.temporary_records.length && !report.cleanup.after.exists && engines.size === 0 && counters.provider_dispatches_in_flight === 0 ? 'passed' : 'failed';
    } catch (error) { report.cleanup.status = 'failed'; report.cleanup.error_code = error.code ?? 'CLEANUP_FAILED'; }
    await nextTurn(); await nextTurn();
    const after = observe('after_cleanup');
    if (baseline) {
      const positiveDelta = (before, current, ignored = []) => sortedObject(Object.entries(current ?? {}).filter(([name, count]) => !ignored.includes(name) && count > (before?.[name] ?? 0)).map(([name, count]) => [name, count - (before?.[name] ?? 0)]));
      const resourceGrowth = positiveDelta(baseline.active_resources, after.active_resources, ['FSReqCallback', 'FSReqPromise', 'FileHandleCloseReq', 'Immediate']);
      const listenerGrowth = positiveDelta(baseline.process_listeners, after.process_listeners);
      report.stability = { status: peakRss - baseline.rss_bytes < THRESHOLDS.rss_growth_bytes && peakHeap - baseline.heap_used_bytes < THRESHOLDS.heap_growth_bytes && !Object.keys(listenerGrowth).length && engines.size === 0 ? Object.keys(resourceGrowth).length || !baseline.active_resources || !after.active_resources ? 'incomplete' : 'passed' : 'failed', baseline_label: baseline.label, peak_sampled_rss_bytes: peakRss, peak_sampled_heap_bytes: peakHeap, peak_rss_growth_bytes: peakRss - baseline.rss_bytes, peak_heap_growth_bytes: peakHeap - baseline.heap_used_bytes, final_rss_delta_bytes: after.rss_bytes - baseline.rss_bytes, final_heap_delta_bytes: after.heap_used_bytes - baseline.heap_used_bytes, positive_active_resource_delta: resourceGrowth, positive_process_listener_delta: listenerGrowth, transient_resources_excluded_from_delta: ['FSReqCallback', 'FSReqPromise', 'FileHandleCloseReq', 'Immediate'], retained_observations: observations.length, dropped_observations: droppedObservations, observation_limit: MAX_OBSERVATIONS, counters, real_transport_handler_observation: 'Unavailable: the fixture owns no Autodesk connection or event handlers.', memory_threshold_basis: 'Provisional local guardrails after warmup, not a leak detector or calibrated workstation baseline.' };
    }
  }
  report.unavailable = [
    { lane: 'live_fusion_recompute_network_cloud', status: 'incomplete', reason: 'Only local synthetic providers were constructed; kernel, transport, remote queues and transfer were not exercised.' },
    { lane: 'representative_large_CAD_model', status: 'incomplete', reason: 'The generated parameter collection has no real topology, assemblies, manufacturing data or CAD kernel cost.' },
    { lane: 'real_transport_handler_lifecycle', status: 'incomplete', reason: 'Fixture engine reopen/close does not register Autodesk, native MCP, add-in or OS-vault handlers.' },
    ...(!report.checks.soak?.multi_hour_fixture_session_exercised ? [{ lane: 'multi_hour_session', status: 'incomplete', reason: 'No multi-hour run was performed; the default never starts a soak. An explicitly requested fixture soak still cannot qualify live Fusion.' }] : []),
  ];
  const required = [...Object.values(report.measurements), ...Object.values(report.checks), report.cleanup, report.stability].filter(Boolean);
  report.local_status = report.error || required.some(item => item.status === 'failed') ? 'failed' : required.some(item => item.status === 'incomplete') || !report.identity?.source_matches_receipt ? 'incomplete' : 'passed';
  report.status = report.local_status === 'failed' ? 'failed' : 'incomplete';
  report.completed_at = new Date().toISOString(); report.elapsed_ms = round(performance.now() - started);
  await sameDirectory(output.root, output.identity);
  await writeFile(path.join(output.root, 'benchmark.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { report, reportPath: path.join(output.root, 'benchmark.json'), exitCode: report.local_status === 'passed' ? 0 : report.local_status === 'failed' ? 1 : 2 };
}

const HELP = `Usage: node scripts/benchmark-local.mjs --output-root /absolute/new/private-directory [options]

The parent directory must exist. The output directory must not exist. No user profile,
credential or real provider is loaded. Synthetic state is removed; benchmark.json remains.

  --samples N             Measured I/O samples, 5..200 (default 30; schema uses 10*N)
  --reconnects N          Fixture engine reopen cycles, 2..100 (default 10)
  --large-parameters N   Extra synthetic parameters, 128..4096 (default 256)
  --soak-seconds N       Explicit optional soak, 0..14400 (default 0, never automatic)
  --progress-seconds N   Nonblocking progress interval, 1..60 (default 5)

Exit 0: local checks passed; 1: failed; 2: incomplete/invalid setup.
Overall qualification remains incomplete: a fixture is not live Fusion evidence.
`;

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) process.stdout.write(HELP);
    else {
      const result = await runBenchmark(options, progress => process.stdout.write(JSON.stringify(progress) + '\n'));
      process.stdout.write(JSON.stringify({ event: 'completed', local_status: result.report.local_status, qualification_status: result.report.status, report: result.reportPath }) + '\n');
      process.exitCode = result.exitCode;
    }
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: error.code ?? 'BENCHMARK_SETUP_FAILED', message: 'Benchmark setup failed. Use --help, a new private output directory, and an intact reviewed build.' }) + '\n');
    process.exitCode = 2;
  }
}
