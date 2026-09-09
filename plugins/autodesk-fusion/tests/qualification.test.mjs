import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFixtureEngine, fixtureProfile, runQualification } from '../dist/index.mjs';

const DOCUMENT = 'fixture:bracket';
const WIDTH = 'fixture:param:width';
const suppliedScenario = JSON.parse(await readFile(new URL('../profiles/fixture-scenario.json', import.meta.url), 'utf8'));
const parameters = { operation: 'parameters.list', document_id: DOCUMENT, args: {} };
const equals = (pointer, expected) => ({ kind: 'equals', pointer, expected });

async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fusion-qualification-regression-'));
  const profile = fixtureProfile(directory);
  const engines = [];
  t.after(async () => { for (const engine of engines) await engine.close(); await rm(directory, { recursive: true, force: true }); });
  const restart = async () => {
    if (engines.length) await engines.at(-1).close();
    const engine = await createFixtureEngine(profile); engines.push(engine);
    return { profile, engine, root: directory, close: () => engine.close() };
  };
  return { restart, runtime: await restart() };
}
async function width(engine) {
  return (await engine.read(parameters)).data.parameters.find(item => item.id === WIDTH);
}
async function setWidth(engine, expression, key) {
  const before = await engine.read(parameters);
  const plan = await engine.prepare({ operation: 'parameters.set', document_id: DOCUMENT, expected_state: before.state, args: { changes: [{ parameter_id: WIDTH, expression }] } });
  assert.equal((await engine.execute(plan.id, plan.hash, key)).status, 'succeeded');
}

test('supplied qualification scenario restores exact width across repeated persisted sessions and nondefault units', async t => {
  const { runtime, restart } = await setup(t);
  let current = runtime;
  for (let run = 0; run < 2; run++) {
    const report = await runQualification(current, suppliedScenario);
    assert.equal(report.status, 'scenario_passed');
    assert.equal(report.live_fusion_qualified, false);
    assert.deepEqual(report.cleanup.failed_step_ids, []);
    assert.equal(report.cleanup.review_required, false);
    assert.deepEqual(await width(current.engine), { id: WIDTH, name: 'width', expression: '40 mm', value_mm: 40 });
    current = await restart();
  }
  await setWidth(current.engine, '2 in', 'qualification-nondefault-width');
  current = await restart();
  const report = await runQualification(current, suppliedScenario);
  assert.equal(report.status, 'scenario_passed');
  const restored = await width(current.engine);
  assert.equal(restored.expression, '2 in'); assert.equal(restored.value_mm, 50.8);
  const others = (await current.engine.read(parameters)).data.parameters.filter(item => item.id !== WIDTH);
  assert.deepEqual(others.map(item => [item.name, item.expression]).sort(), [['height', '20 mm'], ['thickness', '5 mm']]);
});

test('duplicate or missing selected identities never dispatch a mutation, including attempted cleanup', async t => {
  const { runtime } = await setup(t);
  const provider = runtime.engine.desktop;
  const original = provider.dispatch.bind(provider);
  for (const kind of ['duplicate', 'missing']) {
    let mutations = 0;
    provider.dispatch = async request => {
      if (request.operation === 'parameters.set') mutations++;
      const response = await original(request);
      if (request.operation === 'parameters.list' && response.ok) {
        const values = response.data.parameters;
        response.data.parameters = kind === 'duplicate' ? [...values, structuredClone(values.find(item => item.id === WIDTH))] : values.filter(item => item.id !== WIDTH);
      }
      return response;
    };
    const scenario = structuredClone(suppliedScenario);
    // Keep the read assertion independent of the intentionally removed entry;
    // failure must be the identity selection, not an unrelated list length.
    scenario.steps[0].assertions = [{ kind: 'exists', pointer: '/data/parameters' }];
    const report = await runQualification(runtime, scenario);
    assert.equal(report.status, 'failed', kind);
    assert.equal(report.evidence.find(item => item.id === 'change_width').error.code, 'INVALID_REFERENCE', kind);
    assert.equal(mutations, 0, kind);
    assert.deepEqual(report.cleanup.failed_step_ids, ['restore']);
    assert.equal(report.cleanup.review_required, true);
    provider.dispatch = original;
    assert.equal((await width(runtime.engine)).value_mm, 40);
  }
});

test('malformed, unsafe and oversized selections are rejected before preparation or execution', async t => {
  const { runtime } = await setup(t);
  const provider = runtime.engine.desktop, original = provider.dispatch.bind(provider);
  const cases = [
    { label: 'unknown selection key', edit: reference => { reference.select.first = true; } },
    { label: 'unknown reference key', edit: reference => { reference.fallback = WIDTH; } },
    { label: 'empty identity', edit: reference => { reference.select.equals = ''; } },
    { label: 'nonstring identity', edit: reference => { reference.select.equals = 7; } },
    { label: 'prototype pointer', edit: reference => { reference.select.pointer = '/__proto__/id'; } },
    { label: 'constructor value pointer', edit: reference => { reference.select.value_pointer = '/constructor'; } },
    { label: 'invalid pointer escape', edit: reference => { reference.select.pointer = '/id~2'; } },
    { label: 'absent selected value', edit: reference => { reference.select.value_pointer = '/absent'; } },
    { label: 'nonarray reference', edit: reference => { reference.$ref = 'before#/data'; } },
    { label: 'oversized pointer', edit: reference => { reference.select.pointer = '/' + 'a'.repeat(1024); } },
    { label: 'invalid array identity', array: [{ id: 1, expression: '40 mm' }] },
    { label: 'oversized array', array: Array.from({ length: 10_001 }, (_, index) => ({ id: index === 0 ? WIDTH : 'fixture:param:item-' + index, expression: '40 mm' })) },
  ];
  for (const entry of cases) {
    let mutations = 0, preparations = 0;
    const prepare = runtime.engine.prepare.bind(runtime.engine);
    runtime.engine.prepare = async (...args) => { preparations++; return prepare(...args); };
    provider.dispatch = async request => {
      if (request.operation === 'parameters.set') mutations++;
      const response = await original(request);
      if (entry.array && request.operation === 'parameters.list' && response.ok) response.data.parameters = structuredClone(entry.array);
      return response;
    };
    const scenario = structuredClone(suppliedScenario);
    scenario.cleanup = [];
    scenario.steps[0].assertions = [{ kind: 'exists', pointer: '/data/parameters' }];
    entry.edit?.(scenario.steps[1].input.args.changes[0].parameter_id);
    try {
      const report = await runQualification(runtime, scenario);
      assert.equal(report.status, 'failed', entry.label);
      assert.equal(report.evidence.find(item => item.id === 'change_width').error.code, 'INVALID_REFERENCE', entry.label);
      assert.equal(preparations, 0, entry.label); assert.equal(mutations, 0, entry.label);
    } finally { runtime.engine.prepare = prepare; provider.dispatch = original; }
    assert.equal((await width(runtime.engine)).value_mm, 40);
  }
});

test('captured results remain selectable for safe cleanup after a failed read assertion', async t => {
  const { runtime, restart } = await setup(t);
  await setWidth(runtime.engine, '3.7 cm', 'qualification-retained-original');
  const current = await restart(), scenario = structuredClone(suppliedScenario);
  scenario.steps = [scenario.steps[0]];
  scenario.steps[0].assertions = [equals('/data/provider', 'intentionally incorrect')];
  const report = await runQualification(current, scenario);
  assert.equal(report.status, 'failed');
  assert.equal(report.evidence.find(item => item.id === 'before').status, 'failed');
  assert.equal(report.evidence.find(item => item.id === 'restore').status, 'passed');
  assert.deepEqual(report.cleanup.failed_step_ids, []); assert.equal(report.cleanup.review_required, false);
  assert.equal((await width(current.engine)).expression, '3.7 cm');
});

test('failed cleanup requires review even when a negative assertion accepts the failure receipt', async t => {
  const { runtime } = await setup(t), scenario = structuredClone(suppliedScenario);
  scenario.steps = [scenario.steps[0]];
  scenario.cleanup[0].input.args.changes[0].expression = 'not-a-length';
  scenario.cleanup[0].assertions = [equals('/status', 'failed')];
  const report = await runQualification(runtime, scenario);
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.cleanup.failed_step_ids, ['restore']); assert.equal(report.cleanup.review_required, true);
  assert.deepEqual(report.cleanup.remaining_document_ids, []); assert.deepEqual(report.cleanup.unresolved_jobs, []);
  const cleanup = report.evidence.find(item => item.id === 'restore');
  assert.equal(cleanup.status, 'failed'); assert.equal(cleanup.error.code, 'QUALIFICATION_CLEANUP_FAILED');
  assert.equal(cleanup.result.status, 'failed');
  assert.equal(report.successful_operations.some(item => item.step_id === 'restore'), false);
  assert.equal((await width(runtime.engine)).value_mm, 40);
});
