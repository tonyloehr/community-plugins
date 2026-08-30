import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntime, fixtureProfile, parseProfile } from '../dist/index.mjs';
import { aggregateReport, buildCodexInvocation, planRuns, scoreFixtureRun, validateCorpus } from '../scripts/evaluate-workflows.mjs';
import { reassessRecordedCampaign } from '../scripts/reassess-workflows.mjs';

const currentCorpus = JSON.parse(await readFile(new URL('../evaluation/workflow-corpus.json', import.meta.url), 'utf8'));
const legacyCorpus = JSON.parse(await readFile(new URL('../evaluation/workflow-corpus-v1.json', import.meta.url), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => JSON.stringify(value, null, 2) + '\n';
const put = (filename, value) => writeFile(filename, encode(value), { mode: 0o600 });
const DOCUMENT = 'fixture:bracket';

// Synthetic recorded evidence is built from the real fixture engine. No client
// executable exists at the declared path: reassessment must use only files.
async function setup(t, { version = 1, cleanup = true, policyDenied = false, repeats = 1 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fusion-reassessment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); await mkdir(source, { mode: 0o700 });
  const oldCorpus = structuredClone(version === 1 ? legacyCorpus : currentCorpus);
  const ids = ['s-setup-02', version === 1 ? 'a-inspection-01' : 'a-inspection-clarify-v2'];
  const plan = planRuns(oldCorpus, { repeats, split: 'all', caseIds: ids });
  const results = [], directories = new Map(); let context, contract;
  for (const run of plan.filter(entry => entry.paraphrase === 0)) {
    const entry = oldCorpus.cases.find(value => value.id === run.case_id);
    const identity = randomUUID(), directory = path.join(source, `execution-${identity}`);
    directories.set(run.case_id, directory); await mkdir(directory, { mode: 0o700 });
    const profilePath = path.join(directory, 'profile.json');
    const profile = parseProfile({ ...fixtureProfile(path.join(directory, 'state')), id: `eval-${identity}`, outputs: [], policy: { mutationsEnabled: true, operations: ['parameters.set'], effects: ['local_edit'], documents: [DOCUMENT], readDocuments: [DOCUMENT] } });
    await put(profilePath, profile);
    const runtime = await createRuntime(profilePath), engine = runtime.engine;
    let status, before;
    try {
      status = await engine.connectionStatus();
      before = (await engine.read({ operation: 'parameters.list', document_id: DOCUMENT, args: {} })).data.parameters;
    } finally { await engine.close(); }
    contract ??= status.execution_contract_sha256; assert.equal(status.execution_contract_sha256, contract);
    const invocation = buildCodexInvocation({ codex: path.join(root, 'no-client-executable'), model: 'fixture-test-model', directory, profile: profilePath, schema: path.join(directory, 'response-schema.json'), finalFile: path.join(directory, 'final.json') });
    const instructions = invocation.args.find(arg => arg.startsWith('developer_instructions='));
    context ??= JSON.parse(instructions.slice('developer_instructions='.length));
    const prompt = entry.prompts[run.paraphrase];
    await put(path.join(directory, 'invocation.json'), { ...invocation, prompt, prompt_sha256: hash(prompt), oracle_disclosed_to_model: false });
    const events = [{ type: 'thread.started', thread_id: randomUUID() }, ...(policyDenied ? [{ type: 'turn.started' }, { type: 'error', message: 'Synthetic service policy denial; do not replay.' }] : [
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'status', type: 'mcp_tool_call', server: 'fusion_eval', tool: 'fusion_connection_status', arguments: {}, status: 'completed', error: null, result: { structured_content: status } } },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
    ])];
    const trace = events.map(event => JSON.stringify(event)).join('\n') + '\n';
    await writeFile(path.join(directory, 'trace.jsonl'), trace, { mode: 0o600 });
    const independent = { before, after: structuredClone(before), fixture_only: true };
    await put(path.join(directory, 'independent-state.json'), independent);
    const finalResponse = policyDenied ? null : { outcome: entry.category === 'supported' ? 'completed' : 'needs_clarification', summary: 'Synthetic document metadata is observed; no live Autodesk verification.', live_fusion_verified: false, target_document_id: DOCUMENT, changed_parameter_ids: [], observed_width_mm: null };
    if (finalResponse) await put(path.join(directory, 'final.json'), finalResponse);
    results.push({ ...run, ...scoreFixtureRun(entry, { events, before, after: independent.after, finalResponse, exitCode: policyDenied ? 1 : 0, termination: null, executionContract: contract }), trace_sha256: hash(trace), evidence_directory: path.basename(directory), client_exit_code: policyDenied ? 1 : 0, client_termination: null, process_cleanup: { owned_process_group_clean: cleanup, pipe_cleanup_complete: cleanup },
      ...(version === 2 ? { independent_state_sha256: hash(encode(independent)), final_response_sha256: finalResponse ? hash(encode(finalResponse)) : null } : {}),
    });
  }
  const frozenRunner = '// Synthetic provenance fixture, never evaluated.\n';
  const frozenObserver = '// Synthetic observation scorer provenance, never evaluated.\n';
  const record = { schema_version: 1, corpus_sha256: hash(encode(oldCorpus)), runner_sha256: hash(frozenRunner), execution_contract_sha256: contract, harness_context_sha256: hash(context), requested_model: 'fixture-test-model', repeats, split: 'all', case_ids: ids, plan,
    ...(version === 2 ? { scoring_version: 2, observation_scorer_sha256: hash(frozenObserver) } : {}),
  };
  const report = { ...record, ...aggregateReport(plan, results) };
  await put(path.join(source, 'frozen-plan.json'), record);
  await put(path.join(source, 'frozen-corpus.json'), oldCorpus);
  await writeFile(path.join(source, 'frozen-runner.mjs'), frozenRunner, { mode: 0o600 });
  if (version === 2) await writeFile(path.join(source, 'frozen-observation-scorer.mjs'), frozenObserver, { mode: 0o600 });
  await put(path.join(source, 'report.json'), report);
  const helpers = { validateCorpus, planRuns, scoreFixtureRun, aggregateReport, buildCodexInvocation, context, scorerIdentity: { runner_sha256: 'a'.repeat(64), observations_sha256: 'b'.repeat(64), reassessor_sha256: 'c'.repeat(64) } };
  const invoke = (corpus = currentCorpus, outputRoot = path.join(root, `diagnostic-${randomUUID()}`)) => reassessRecordedCampaign({ sourceRoot: source, outputRoot, corpus, corpusBytes: Buffer.from(encode(corpus)) }, helpers);
  return { root, source, report, directories, invoke };
}

test('offline fact reassessment preserves the original failure and excludes the changed task without launching a client', async t => {
  const state = await setup(t), sourceBytes = await readFile(path.join(state.source, 'report.json'));
  const { report } = await state.invoke();
  const row = report.runs.find(run => run.run_id === 's-setup-02-p1-r1');
  assert.equal(row.original_assessment.deterministic_pass, false);
  assert.ok(row.original_assessment.issues.includes('required_operation_not_observed:document.inspect'));
  assert.equal(row.deterministic_pass, true, JSON.stringify({ issues: row.issues, observations: row.observation_checks }));
  assert.equal(row.execution_origin, 'prior_recording_not_new_model_run');
  assert.equal(row.literal_operation_coverage.gates_task_score, false);
  assert.ok(row.literal_operation_coverage.missing_direct_operations.includes('document.inspect'));
  assert.equal(report.new_model_runs, 0); assert.equal(report.tools_replayed, 0);
  assert.equal(report.source_holdout_is_not_new, true); assert.equal(report.release_qualified, false);
  assert.equal(report.acceptance_status, 'incomplete'); assert.equal(row.human_review.full_workflow_success, null);
  assert.ok(report.excluded_original_runs.some(run => run.run_id === 'a-inspection-01-p1-r1'));
  assert.ok(report.runs.filter(run => run.case_id === 'a-inspection-clarify-v2').every(run => run.status === 'not_run'));
  assert.deepEqual(report.source_original_summary, state.report.summary);
  assert.deepEqual(await readFile(path.join(state.source, 'report.json')), sourceBytes);
});

test('a changed prompt under the same case ID cannot reuse a previous execution', async t => {
  const state = await setup(t), changed = structuredClone(currentCorpus);
  changed.cases.find(entry => entry.id === 's-setup-02').prompts[0] += ' Also ask a new, unrelated engineering question.';
  const { report } = await state.invoke(changed);
  assert.equal(report.summary.executed, 0);
  assert.ok(report.excluded_original_runs.some(run => run.run_id === 's-setup-02-p1-r1' && run.reason === 'task_or_authority_identity_changed_requires_new_execution'));
});

test('trace, profile, invocation authority and frozen plan tampering are refused before a diagnostic is written', async t => {
  for (const kind of ['trace', 'profile', 'instructions', 'plan']) await t.test(kind, async t => {
    const state = await setup(t), directory = state.directories.get('s-setup-02');
    if (kind === 'trace') await writeFile(path.join(directory, 'trace.jsonl'), '{}\n', { mode: 0o600 });
    if (kind === 'profile') {
      const filename = path.join(directory, 'profile.json'), profile = JSON.parse(await readFile(filename, 'utf8'));
      profile.policy.documents.push('fixture:another-document'); await put(filename, profile);
    }
    if (kind === 'instructions') {
      const filename = path.join(directory, 'invocation.json'), invocation = JSON.parse(await readFile(filename, 'utf8'));
      invocation.args = invocation.args.map(arg => arg.startsWith('developer_instructions=') ? 'developer_instructions="Changed authority"' : arg); await put(filename, invocation);
    }
    if (kind === 'plan') {
      const filename = path.join(state.source, 'frozen-plan.json'), plan = JSON.parse(await readFile(filename, 'utf8'));
      plan.plan[0].paraphrase = 1; await put(filename, plan);
    }
    const output = path.join(state.root, 'must-not-write');
    await assert.rejects(state.invoke(currentCorpus, output));
    await assert.rejects(readFile(path.join(output, 'report.json')), { code: 'ENOENT' });
  });
});

test('reassessment refuses aliased evidence and never overwrites an existing output directory', async t => {
  const state = await setup(t), directory = state.directories.get('s-setup-02');
  const output = path.join(state.root, 'existing'); await mkdir(output, { mode: 0o700 });
  await put(path.join(output, 'sentinel.json'), { preserve: true });
  await assert.rejects(state.invoke(currentCorpus, output), { code: 'EEXIST' });
  assert.deepEqual(JSON.parse(await readFile(path.join(output, 'sentinel.json'), 'utf8')), { preserve: true });
  await link(path.join(directory, 'trace.jsonl'), path.join(state.root, 'trace-alias.jsonl'));
  await assert.rejects(state.invoke(), /without aliases/u);
});

test('later flag overrides, extra servers and changed profile or working-directory identities cannot weaken recorded controls', async t => {
  for (const kind of ['enable_tool', 'second_model', 'second_sandbox', 'additional_server', 'cwd', 'profile_identity']) await t.test(kind, async t => {
    const state = await setup(t), directory = state.directories.get('s-setup-02');
    if (kind === 'profile_identity') {
      const filename = path.join(directory, 'profile.json'), profile = JSON.parse(await readFile(filename, 'utf8'));
      profile.id = `eval-${randomUUID()}`; await put(filename, profile);
    } else {
      const filename = path.join(directory, 'invocation.json'), invocation = JSON.parse(await readFile(filename, 'utf8'));
      if (kind === 'enable_tool') invocation.args.push('--enable', 'shell_tool');
      if (kind === 'second_model') invocation.args.push('--model', 'different-test-model');
      if (kind === 'second_sandbox') invocation.args.push('--sandbox', 'workspace-write');
      if (kind === 'additional_server') invocation.args.push('-c', 'mcp_servers.unreviewed.command="synthetic-only"');
      if (kind === 'cwd') invocation.args[invocation.args.indexOf('-C') + 1] = state.root;
      await put(filename, invocation);
    }
    await assert.rejects(state.invoke(), /identity|controls/u);
  });
});

test('repeat slots cannot count one evidence directory, trace or client thread twice', async t => {
  for (const kind of ['directory', 'trace', 'thread']) await t.test(kind, async t => {
    const state = await setup(t, { repeats: 2 });
    const report = structuredClone(state.report), rows = report.runs.filter(run => run.case_id === 's-setup-02' && run.evidence_directory);
    assert.equal(rows.length, 2);
    const firstDirectory = path.join(state.source, rows[0].evidence_directory), secondDirectory = path.join(state.source, rows[1].evidence_directory);
    const firstBytes = await readFile(path.join(firstDirectory, 'trace.jsonl'));
    if (kind === 'directory') rows[1].evidence_directory = rows[0].evidence_directory;
    else {
      let trace = firstBytes;
      if (kind === 'thread') {
        const firstEvents = firstBytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
        const events = (await readFile(path.join(secondDirectory, 'trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        events.find(event => event.type === 'thread.started').thread_id = firstEvents.find(event => event.type === 'thread.started').thread_id;
        trace = Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n');
      }
      await writeFile(path.join(secondDirectory, 'trace.jsonl'), trace); rows[1].trace_sha256 = hash(trace);
    }
    await put(path.join(state.source, 'report.json'), report);
    await assert.rejects(state.invoke(), /must not reuse/u);
  });
});

test('failed isolation and service denial remain failures after alternate observations are considered', async t => {
  for (const option of [{ cleanup: false }, { policyDenied: true }]) await t.test(JSON.stringify(option), async t => {
    const state = await setup(t, option), { report } = await state.invoke();
    const row = report.runs.find(run => run.run_id === 's-setup-02-p1-r1');
    assert.equal(row.deterministic_pass, false);
    if (option.cleanup === false) assert.ok(row.safety.effects_requiring_reconciliation.includes('prior_client_cleanup_incomplete'));
    else { assert.ok(row.issues.includes('client_exit_nonzero')); assert.equal(row.model_turn_completed, false); }
    assert.equal(report.new_model_runs, 0); assert.equal(report.tools_replayed, 0);
  });
});

test('v2 source observations can be reassessed only with their original helper and independent-state hashes intact', async t => {
  const state = await setup(t, { version: 2 });
  const { report } = await state.invoke();
  assert.equal(report.summary.executed, 2); assert.equal(report.summary.deterministic_passed, 2, JSON.stringify(report.runs.filter(run => run.deterministic_pass === false).map(run => ({ issues: run.issues, observations: run.observation_checks }))));
  assert.ok(report.runs.filter(run => run.execution_origin).every(run => run.independent_state_hash_recorded_at_original_run));
  const directory = state.directories.get('s-setup-02');
  const original = await readFile(path.join(directory, 'independent-state.json'));
  await writeFile(path.join(directory, 'independent-state.json'), original.toString('utf8') + ' ');
  await assert.rejects(state.invoke(), /Recorded independent state changed/u);
  await writeFile(path.join(directory, 'independent-state.json'), original);
  await writeFile(path.join(state.source, 'frozen-observation-scorer.mjs'), '// changed helper\n');
  await assert.rejects(state.invoke());
});
