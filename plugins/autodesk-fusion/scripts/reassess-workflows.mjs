/** Offline diagnostic reassessment. This module never launches a client or provider. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ensurePrivateDirectory, parseProfile } from '../dist/index.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const DOCUMENT = 'fixture:bracket';
async function bounded(filename, maximum) {
  const info = await lstat(filename);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= maximum, 'Reassessment needs bounded regular evidence files without aliases.');
  return readFile(filename);
}
async function readJson(filename, maximum) {
  const bytes = await bounded(filename, maximum);
  return { value: JSON.parse(bytes.toString('utf8')), sha256: hash(bytes), bytes };
}
async function put(filename, value) { await writeFile(filename, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); }

/** Unchanged prompts/context can receive a new diagnostic grade, never a new execution claim. */
export async function reassessRecordedCampaign({ sourceRoot, outputRoot, corpus, corpusBytes }, helpers) {
  assert.ok(typeof sourceRoot === 'string' && path.isAbsolute(sourceRoot) && typeof outputRoot === 'string' && path.isAbsolute(outputRoot), 'Reassessment requires explicit absolute source and new output directories.');
  assert.ok(!/^[/\\]{2}/u.test(sourceRoot) && !/^[/\\]{2}/u.test(outputRoot) && !sourceRoot.includes('\0') && !outputRoot.includes('\0'));
  const source = path.resolve(sourceRoot), destination = path.resolve(outputRoot);
  const sourceInfo = await lstat(source);
  assert.ok(sourceInfo.isDirectory() && !sourceInfo.isSymbolicLink());
  await ensurePrivateDirectory(source);
  assert.notEqual(source, destination);
  const previous = await readJson(path.join(source, 'report.json'), 32_000_000);
  const frozenPlan = await readJson(path.join(source, 'frozen-plan.json'), 2_097_152);
  const frozenCorpus = await readJson(path.join(source, 'frozen-corpus.json'), 2_097_152);
  const old = previous.value;
  helpers.validateCorpus(corpus); helpers.validateCorpus(frozenCorpus.value);
  assert.equal(corpus.schema_version, 2, 'Use the fact-based diagnostic grader for reassessment.');
  assert.ok(old.schema_version === 1 && Array.isArray(old.runs) && old.runs.length <= 6000 && Array.isArray(old.plan));
  assert.equal(new Set(old.runs.map(run => run.run_id)).size, old.runs.length);
  const recordedDirectories = old.runs.filter(run => run.evidence_directory).map(run => run.evidence_directory);
  assert.equal(new Set(recordedDirectories).size, recordedDirectories.length, 'Distinct runs must not reuse an evidence directory.');
  assert.deepEqual(old.plan, frozenPlan.value.plan);
  assert.deepEqual(old.plan, helpers.planRuns(frozenCorpus.value, { repeats: old.repeats, split: old.split, caseIds: frozenPlan.value.case_ids ?? [] }));
  for (const row of old.runs) {
    const declared = old.plan.find(run => run.run_id === row.run_id); assert.ok(declared);
    for (const [key, expected] of Object.entries(declared)) assert.equal(row[key], expected, 'Recorded run identity differs from the frozen plan.');
  }
  assert.equal(frozenCorpus.sha256, old.corpus_sha256);
  for (const key of ['corpus_sha256', 'runner_sha256', 'execution_contract_sha256', 'harness_context_sha256', 'requested_model', 'repeats', 'split']) assert.equal(old[key], frozenPlan.value[key], `Source report/plan ${key} differs.`);
  assert.ok([old.runner_sha256, old.execution_contract_sha256, old.harness_context_sha256].every(digest));
  assert.equal(hash(await bounded(path.join(source, 'frozen-runner.mjs'), 2_097_152)), old.runner_sha256);
  if (frozenCorpus.value.schema_version === 2) {
    assert.equal(old.scoring_version, 2); assert.equal(frozenPlan.value.scoring_version, 2);
    assert.ok(digest(old.observation_scorer_sha256));
    assert.equal(old.observation_scorer_sha256, frozenPlan.value.observation_scorer_sha256);
    assert.equal(hash(await bounded(path.join(source, 'frozen-observation-scorer.mjs'), 2_097_152)), old.observation_scorer_sha256);
  }
  assert.equal(old.harness_context_sha256, hash(helpers.context), 'Changed model-facing instructions cannot reuse old execution evidence.');
  const plan = helpers.planRuns(corpus, { repeats: old.repeats, split: old.split, caseIds: [] });
  const oldCases = new Map(frozenCorpus.value.cases.map(entry => [entry.id, entry]));
  const oldRows = new Map(old.runs.map(run => [run.run_id, run]));
  const newCases = new Map(corpus.cases.map(entry => [entry.id, entry]));
  const consumed = new Set(), reassessments = [], inputs = [], excluded = [], traceHashes = new Set(), threadIds = new Set();
  let launchIdentity;
  for (const run of plan) {
    if (run.provider !== 'fixture') continue;
    const original = oldRows.get(run.run_id), entry = newCases.get(run.case_id), oldEntry = oldCases.get(run.case_id);
    if (!original || !oldEntry || original.provider !== 'fixture' || !original.evidence_directory) continue;
    const sameTask = structuredClone(entry), priorTask = structuredClone(oldEntry);
    delete sameTask.oracle.required_observations; delete priorTask.oracle.required_observations;
    if (!isDeepStrictEqual(sameTask, priorTask)) {
      excluded.push({ run_id: run.run_id, reason: 'task_or_authority_identity_changed_requires_new_execution' }); continue;
    }
    assert.ok(/^execution-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(original.evidence_directory), 'Evidence directory must be an opaque child identity.');
    const directory = path.join(source, original.evidence_directory), directoryInfo = await lstat(directory);
    assert.ok(directoryInfo.isDirectory() && !directoryInfo.isSymbolicLink());
    await ensurePrivateDirectory(directory);
    const invocation = await readJson(path.join(directory, 'invocation.json'), 65_536);
    assert.equal(invocation.value.prompt, entry.prompts[run.paraphrase]);
    assert.equal(invocation.value.prompt_sha256, hash(invocation.value.prompt));
    assert.equal(invocation.value.oracle_disclosed_to_model, false);
    const args = invocation.value.args;
    assert.ok(Array.isArray(args) && args.length <= 200 && args.every(arg => typeof arg === 'string' && arg.length <= 16_384));
    assert.deepEqual(Object.keys(invocation.value).sort(), ['command', 'args', 'prompt', 'prompt_sha256', 'oracle_disclosed_to_model'].sort());
    const developer = args.filter(arg => arg.startsWith('developer_instructions='));
    assert.equal(developer.length, 1); assert.equal(hash(JSON.parse(developer[0].slice('developer_instructions='.length))), old.harness_context_sha256);
    const serverValue = name => {
      const matches = args.filter(arg => arg.startsWith(`mcp_servers.fusion_eval.${name}=`));
      assert.equal(matches.length, 1, 'Recorded launch must contain one exact Fusion server configuration.');
      return JSON.parse(matches[0].slice(`mcp_servers.fusion_eval.${name}=`.length));
    };
    const nodeExecutable = serverValue('command'), serverArgs = serverValue('args');
    assert.ok(Array.isArray(serverArgs) && serverArgs.length === 1 && typeof serverArgs[0] === 'string' && path.isAbsolute(serverArgs[0]));
    const originalRoot = path.dirname(path.dirname(serverArgs[0]));
    assert.equal(serverArgs[0], path.join(originalRoot, 'mcp', 'server.mjs'));
    const expected = helpers.buildCodexInvocation({ codex: invocation.value.command, model: old.requested_model, directory, profile: path.join(directory, 'profile.json'), schema: path.join(directory, 'response-schema.json'), finalFile: path.join(directory, 'final.json'), root: originalRoot, nodeExecutable });
    assert.deepEqual(args, expected.args, 'Recorded client controls or execution paths differ from the exact reviewed invocation.');
    const identity = { codex: expected.command, node: nodeExecutable, plugin_root: originalRoot };
    launchIdentity ??= identity; assert.deepEqual(identity, launchIdentity, 'A recorded campaign cannot mix executable/server launch identities.');
    const profileInput = await readJson(path.join(directory, 'profile.json'), 1_048_576);
    const profile = parseProfile(profileInput.value);
    assert.equal(profile.id, `eval-${original.evidence_directory.slice('execution-'.length)}`, 'Profile identity must bind the opaque evidence directory.');
    assert.equal(profile.mode, 'fixture'); assert.ok(!profile.desktop && !profile.cloud);
    assert.equal(profile.policy.mutationsEnabled, true);
    assert.equal(profile.stateRoot, path.join(directory, 'state'));
    assert.deepEqual(profile.policy.operations, ['parameters.set']); assert.deepEqual(profile.policy.effects, ['local_edit']);
    assert.deepEqual(profile.policy.documents, [DOCUMENT]); assert.deepEqual(profile.policy.readDocuments, [DOCUMENT]); assert.deepEqual(profile.outputs, []);
    const trace = await bounded(path.join(directory, 'trace.jsonl'), 16_777_216);
    assert.equal(hash(trace), original.trace_sha256, 'The recorded client trace changed.');
    assert.ok(!traceHashes.has(original.trace_sha256), 'Distinct assessed runs must not reuse the same recorded trace.'); traceHashes.add(original.trace_sha256);
    const lines = trace.toString('utf8').split('\n').filter(line => line.trim());
    assert.ok(lines.length <= 50_000, 'The old trace exceeded the supported bounded parser.');
    const events = lines.map(line => JSON.parse(line));
    const threads = events.filter(event => event.type === 'thread.started');
    assert.ok(threads.length <= 1 && (threads.length === 1 || !events.some(event => ['turn.started', 'turn.completed'].includes(event.type))), 'A model turn needs one recorded thread identity.');
    for (const thread of threads) {
      assert.ok(typeof thread.thread_id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(thread.thread_id) && !threadIds.has(thread.thread_id), 'Distinct assessed runs must not reuse a client thread identity.'); threadIds.add(thread.thread_id);
    }
    for (const event of events) if (event.type === 'item.completed' && event.item?.server === 'fusion_eval' && ['fusion_connection_status', 'fusion_capabilities_list'].includes(event.item.tool)) {
      const value = event.item.result?.structured_content ?? event.item.result?.structuredContent;
      if (value && !value.error) assert.equal(value.profile, profile.id, 'Observed provider profile differs from the recorded launch.');
    }
    const state = await readJson(path.join(directory, 'independent-state.json'), 65_536);
    assert.equal(state.value.fixture_only, true);
    if (original.independent_state_sha256) assert.equal(state.sha256, original.independent_state_sha256, 'Recorded independent state changed.');
    let finalResponse = null, finalSha256 = null;
    try {
      const final = await readJson(path.join(directory, 'final.json'), 65_536);
      finalResponse = final.value; finalSha256 = final.sha256;
      if (original.final_response_sha256) assert.equal(finalSha256, original.final_response_sha256);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const score = helpers.scoreFixtureRun(entry, { events, before: state.value.before, after: state.value.after, finalResponse, exitCode: original.client_exit_code, termination: original.client_termination, executionContract: old.execution_contract_sha256, durationMs: original.duration_ms ?? null });
    // A failed isolation/cleanup or infrastructure claim cannot disappear just
    // because the new scorer finds the requested facts in another observation.
    const cleanup = original.process_cleanup;
    if (!cleanup?.owned_process_group_clean || !cleanup?.pipe_cleanup_complete) {
      score.issues.push('prior_client_cleanup_incomplete'); score.safety.effects_requiring_reconciliation.push('prior_client_cleanup_incomplete');
      score.deterministic_pass = false; score.status = 'deterministic_failed';
    }
    reassessments.push({ ...run, ...score, evidence_directory: original.evidence_directory, execution_origin: 'prior_recording_not_new_model_run', original_assessment: { status: original.status, deterministic_pass: original.deterministic_pass, issues: original.issues, safety: original.safety }, trace_sha256: original.trace_sha256, independent_state_sha256: state.sha256, final_response_sha256: finalSha256, independent_state_hash_recorded_at_original_run: Boolean(original.independent_state_sha256), client_exit_code: original.client_exit_code, client_termination: original.client_termination, process_cleanup: cleanup });
    inputs.push({ run_id: run.run_id, evidence_directory: original.evidence_directory, invocation_sha256: invocation.sha256, profile_sha256: profileInput.sha256, trace_sha256: original.trace_sha256, independent_state_sha256: state.sha256, final_response_sha256: finalSha256 });
    consumed.add(original.run_id);
  }
  for (const run of old.runs) if (run.provider === 'fixture' && run.evidence_directory && !consumed.has(run.run_id) && !excluded.some(entry => entry.run_id === run.run_id)) excluded.push({ run_id: run.run_id, reason: 'case_absent_or_changed_in_new_corpus_original_result_retained' });
  const report = {
    schema_version: 1, assessment_kind: 'post_hoc_diagnostic_reassessment', created_at: new Date().toISOString(), source_report_sha256: previous.sha256,
    source_corpus_sha256: old.corpus_sha256, source_runner_sha256: old.runner_sha256, source_execution_contract_sha256: old.execution_contract_sha256,
    current_corpus_sha256: hash(corpusBytes), current_scorer: helpers.scorerIdentity, recorded_launch_identity: launchIdentity ?? null, requested_model: old.requested_model, resolved_model_checkpoint: old.resolved_model_checkpoint ?? null,
    source_context_sha256: old.harness_context_sha256, source_original_summary: old.summary, original_results_preserved: true, source_holdout_is_not_new: true,
    new_model_runs: 0, tools_replayed: 0, excluded_original_runs: excluded, evidence_inputs: inputs, ...helpers.aggregateReport(plan, reassessments), acceptance_status: 'incomplete',
    provenance_limitations: ['This is a revised diagnostic grade of existing observations, not a fresh held-out campaign or an independent human rubric.', 'Original failures remain in source_original_summary and per-run original_assessment; changed task identities receive no reused execution.', 'The original v1 harness did not separately hash independent-state/final files at execution time. Their current private-file hashes are captured here without claiming a timestamped signature.', 'Private file ownership and matching hashes provide local integrity checks, not authenticated provider attestation. No client, provider, credential service or model is invoked.'],
  };
  // Detect changes during this bounded read pass before writing any new result.
  assert.equal(hash(await bounded(path.join(source, 'report.json'), 32_000_000)), previous.sha256);
  assert.equal(hash(await bounded(path.join(source, 'frozen-plan.json'), 2_097_152)), frozenPlan.sha256);
  assert.equal(hash(await bounded(path.join(source, 'frozen-corpus.json'), 2_097_152)), frozenCorpus.sha256);
  assert.equal(hash(await bounded(path.join(source, 'frozen-runner.mjs'), 2_097_152)), old.runner_sha256);
  if (frozenCorpus.value.schema_version === 2) assert.equal(hash(await bounded(path.join(source, 'frozen-observation-scorer.mjs'), 2_097_152)), old.observation_scorer_sha256);
  for (const input of inputs) {
    const directory = path.join(source, input.evidence_directory);
    for (const [name, expected, maxBytes] of [['invocation.json', input.invocation_sha256, 65_536], ['profile.json', input.profile_sha256, 1_048_576], ['trace.jsonl', input.trace_sha256, 16_777_216], ['independent-state.json', input.independent_state_sha256, 65_536], ['final.json', input.final_response_sha256, 65_536]]) if (expected) assert.equal(hash(await bounded(path.join(directory, name), maxBytes)), expected, 'Source evidence changed during reassessment.');
  }
  await ensurePrivateDirectory(path.dirname(destination)); await mkdir(destination, { mode: 0o700 }); await ensurePrivateDirectory(destination);
  await writeFile(path.join(destination, 'frozen-corpus.json'), corpusBytes, { mode: 0o600, flag: 'wx' });
  await put(path.join(destination, 'report.json'), report);
  return { report, reportPath: path.join(destination, 'report.json') };
}
