import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { parseArguments, runBenchmark, summarizeSamples, validateOptions } from '../scripts/benchmark-local.mjs';

const exec = promisify(execFile);
const script = new URL('../scripts/benchmark-local.mjs', import.meta.url);
async function privateParent(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fusion-benchmark-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('benchmark statistics use empirical nearest rank and compare unrounded observations', () => {
  const values = Array.from({ length: 20 }, (_, i) => 20 - i);
  const summary = summarizeSamples(values, 19);
  assert.deepEqual([summary.sample_count, summary.min_ms, summary.p50_ms, summary.p95_ms, summary.p99_ms, summary.max_ms], [20, 1, 10, 19, 20, 20]);
  assert.equal(summary.threshold.status, 'failed', 'The proposed target is strictly below its bound.');
  assert.equal(summarizeSamples([0.09999999], 0.1).threshold.status, 'passed', 'Display rounding must not change threshold decisions.');
  assert.equal(summarizeSamples([1, 2, 9], 8, 'max_ms').threshold.status, 'failed');
  assert.throws(() => summarizeSamples([]), { code: 'INVALID_SAMPLES' });
  assert.throws(() => summarizeSamples([Infinity]), { code: 'INVALID_SAMPLES' });
  assert.throws(() => summarizeSamples([-1]), { code: 'INVALID_SAMPLES' });
  assert.deepEqual(values, Array.from({ length: 20 }, (_, i) => 20 - i), 'Reporting must not mutate measured samples.');
});

test('benchmark options require an explicit private destination and bound every workload', () => {
  const outputRoot = path.join(os.tmpdir(), 'not-created-by-options');
  const options = parseArguments(['--output-root', outputRoot]);
  assert.equal(options.soakSeconds, 0, 'A long soak must never be automatic.');
  assert.equal(options.samples, 30);
  for (const args of [[], ['--profile', outputRoot], ['--output-root', 'relative'], ['--output-root', outputRoot, '--samples', '0'], ['--output-root', outputRoot, '--soak-seconds', '14401'], ['--output-root', outputRoot, '--soak-seconds', '-1'], ['--output-root', outputRoot, '--large-parameters', '100000'], ['--output-root', outputRoot, '--samples', '5.5'], ['--output-root', outputRoot, '--output-root', outputRoot]]) assert.throws(() => parseArguments(args));
  assert.throws(() => validateOptions({ outputRoot, profileFile: 'user-profile.json' }), { code: 'INVALID_OPTIONS' });
  assert.throws(() => validateOptions({ outputRoot, toString: 'not-an-option' }), { code: 'INVALID_OPTIONS' });
});

test('benchmark imports are inert even without a plugin build and with hostile profile environment', async t => {
  const parent = await privateParent(t), copied = path.join(parent, 'benchmark-local.mjs'), output = path.join(parent, 'must-not-be-created');
  await copyFile(script, copied);
  const { stdout, stderr } = await exec(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(copied).href)}); process.stdout.write('inert\\n');`, '--', '--output-root', output], { env: { ...process.env, FUSION_PROFILE: path.join(parent, 'must-not-load-profile.json') }, timeout: 10_000 });
  assert.equal(stdout, 'inert\n'); assert.equal(stderr, '');
  assert.deepEqual(await readdir(parent), ['benchmark-local.mjs']);
});

test('benchmark refuses to reuse or follow an existing output root without touching its files', async t => {
  const parent = await privateParent(t), existing = path.join(parent, 'existing');
  await mkdir(existing, { mode: 0o700 });
  await writeFile(path.join(existing, 'sentinel'), 'preserve me');
  await assert.rejects(runBenchmark({ outputRoot: existing }), { code: 'EEXIST' });
  assert.equal(await readFile(path.join(existing, 'sentinel'), 'utf8'), 'preserve me');
  assert.deepEqual(await readdir(existing), ['sentinel']);
  const linked = path.join(parent, 'linked');
  try { await symlink(existing, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return; throw error; }
  await assert.rejects(runBenchmark({ outputRoot: linked }), { code: 'EEXIST' });
  assert.equal(await readFile(path.join(existing, 'sentinel'), 'utf8'), 'preserve me');
});

test('local benchmark measures real fixture/ledger paths, checks 100 bound writes and removes synthetic state', { timeout: 120_000 }, async t => {
  const parent = await privateParent(t), outputRoot = path.join(parent, 'new-output'), events = [];
  const previousProfile = process.env.FUSION_PROFILE;
  process.env.FUSION_PROFILE = path.join(parent, 'profile-must-not-be-read.json');
  t.after(() => { if (previousProfile === undefined) delete process.env.FUSION_PROFILE; else process.env.FUSION_PROFILE = previousProfile; });
  const { report, reportPath } = await runBenchmark({ outputRoot, samples: 5, reconnects: 2, largeParameters: 128, soakSeconds: 1, progressSeconds: 1 }, event => events.push(event));
  assert.equal(report.error, undefined);
  assert.equal(report.live_fusion_verified, false);
  assert.equal(report.status === 'incomplete' || report.status === 'failed', true, 'A local run cannot become full performance qualification.');
  assert.equal(report.identity.source_matches_receipt, true, 'Rebuild the reviewed source before running this integration test.');
  assert.match(report.identity.execution_contract_sha256, /^[a-f0-9]{64}$/u);
  assert.match(report.fixture.large_state_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(report.measurements.schema_policy.sample_count, 50);
  assert.equal(report.measurements.ledger_terminal_job_status.sample_count, 5);
  assert.deepEqual(report.checks.ledger_no_provider_refresh.measured_provider_dispatches, 0);
  assert.deepEqual([report.checks.state_bound_batch.completed, report.checks.state_bound_batch.readbacks, report.checks.state_bound_batch.distinct_states, report.checks.state_bound_batch.final_width_mm], [100, 100, 101, 140]);
  assert.equal(report.checks.state_bound_batch.persisted_after_reopen, true);
  assert.equal(report.checks.large_parameter_projection.status, 'passed');
  assert.equal(report.checks.large_entity_pagination.status, 'passed');
  assert.equal(report.checks.large_entity_pagination.unique_entities, 131);
  assert.equal(report.checks.schema_limits.rejected_requests, 7);
  assert.equal(report.checks.soak.status, 'passed');
  assert.equal(report.checks.soak.multi_hour_fixture_session_exercised, false);
  assert.ok(events.some(event => event.event === 'soak_started'));
  assert.ok(events.some(event => event.event === 'soak_completed'));
  assert.ok(events.some(event => event.event === 'progress'));
  assert.equal(report.cleanup.status, 'passed');
  assert.deepEqual(report.cleanup.before.execution_locks, []);
  assert.deepEqual(report.cleanup.before.temporary_records, []);
  assert.equal(report.cleanup.after.exists, false);
  assert.equal(report.stability.counters.engines_created, report.stability.counters.engines_closed);
  assert.equal(report.stability.counters.provider_dispatches_in_flight, 0);
  assert.equal(report.observations.at(-1).open_fixture_engines, 0);
  assert.deepEqual(await readdir(outputRoot), ['benchmark.json']);
  assert.deepEqual(JSON.parse(await readFile(reportPath, 'utf8')), JSON.parse(JSON.stringify(report)));
  if (process.platform !== 'win32') { assert.equal((await lstat(outputRoot)).mode & 0o077, 0); assert.equal((await lstat(reportPath)).mode & 0o077, 0); }
  // Timing/memory budgets are reported engineering gates, not host-speed assertions in CI.
});
