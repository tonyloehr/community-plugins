import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FixtureDesktopProvider, RecordStore, createFixtureEngine, fixtureProfile } from '../dist/index.mjs';

const DOCUMENT = 'fixture:bracket';
const WIDTH = 'fixture:param:width';
const baseParameters = () => ({ width: { expression: '40 mm', value_mm: 40 }, height: { expression: '20 mm', value_mm: 20 }, thickness: { expression: '5 mm', value_mm: 5 } });
const extraName = index => `item_${String(index).padStart(3, '0')}`;
function stateWithExtras(count) {
  const entries = [...Object.entries(baseParameters()), ...Array.from({ length: count }, (_, index) => [extraName(index), { expression: `${index + 1} mm`, value_mm: index + 1 }])];
  return { revision: 1, saved: false, parameters: Object.fromEntries(entries.reverse()) };
}
async function setup(t, extras) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fusion-fixture-pages-'));
  const store = new RecordStore(directory), engines = [];
  t.after(async () => { for (const engine of engines) await engine.close(); await rm(directory, { recursive: true, force: true }); });
  if (extras !== undefined) await store.put('fixture', 'bracket', stateWithExtras(extras));
  return { store, provider: new FixtureDesktopProvider(store), engine: async () => {
    const engine = await createFixtureEngine(fixtureProfile(directory)); engines.push(engine); return engine;
  } };
}
function request(operation, args = {}, expected_state) {
  return { operation, args, document_id: DOCUMENT, request_id: 'fixture-pagination-test', ...(expected_state ? { expected_state } : {}) };
}
async function read(provider, operation, args = {}, expected_state) {
  const response = await provider.dispatch(request(operation, args, expected_state));
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.deepEqual(response.effects, []);
  assert.equal(response.data.provider, 'synthetic_fixture');
  assert.equal(response.data.live_fusion_verified, false);
  return response;
}

test('parameter listing reports bounded prefixes and explicit truncation without inventing pagination', async t => {
  const { provider, store } = await setup(t, 134);
  const first = await read(provider, 'parameters.list');
  assert.equal(first.data.parameters.length, 100);
  assert.equal(first.data.total, 137); assert.equal(first.data.truncated, true);
  assert.equal(Object.hasOwn(first.data, 'next_offset'), false);
  assert.equal(Object.hasOwn(first.data, 'next_cursor'), false);
  const limited = await read(provider, 'parameters.list', { limit: 1, kind: 'user' }, first.state);
  assert.deepEqual(limited.data.parameters, [{ id: 'fixture:param:height', name: 'height', expression: '20 mm', value_mm: 20 }]);
  assert.equal(limited.data.total, 137); assert.equal(limited.data.truncated, true);
  assert.equal(limited.state, first.state);
  const all = await read(provider, 'parameters.list', { limit: 100, kind: 'all' }, first.state);
  assert.deepEqual(all.data.parameters, first.data.parameters, 'The synthetic fixture contains only user parameters.');

  await store.put('fixture', 'bracket', stateWithExtras(0));
  const complete = await read(provider, 'parameters.list', { limit: 3 });
  assert.equal(complete.data.parameters.length, 3);
  assert.equal(complete.data.total, 3); assert.equal(complete.data.truncated, false);
  await store.put('fixture', 'bracket', { revision: 1, saved: false, parameters: {} });
  const empty = await read(provider, 'parameters.list', { limit: 1 });
  assert.deepEqual(empty.data.parameters, []);
  assert.equal(empty.data.total, 0); assert.equal(empty.data.truncated, false);
});

test('entity pages traverse every identity once across persisted restarts and end with explicit empty pages', async t => {
  const { provider, store } = await setup(t, 253);
  const expectedNames = ['height', ...Array.from({ length: 253 }, (_, index) => extraName(index)), 'thickness', 'width'];
  const defaultPage = await read(provider, 'entities.find', { kind: 'parameter' });
  assert.equal(defaultPage.data.entities.length, 100);
  assert.equal(defaultPage.data.total, 256); assert.equal(defaultPage.data.offset, 0); assert.equal(defaultPage.data.next_offset, 100);
  assert.equal(Object.hasOwn(defaultPage.data, 'candidates'), false, 'Use the same collection key as the Fusion handler.');
  const found = []; let offset = 0, pages = 0;
  do {
    const page = await read(new FixtureDesktopProvider(store), 'entities.find', { kind: 'parameter', limit: 37, offset }, defaultPage.state);
    assert.equal(page.state, defaultPage.state);
    assert.equal(page.data.total, 256); assert.equal(page.data.offset, offset);
    assert.equal(page.data.entities.length, pages < 6 ? 37 : 34);
    found.push(...page.data.entities.map(entity => entity.entity_id));
    offset = page.data.next_offset;
    if (pages < 6) assert.equal(offset, 37 * (pages + 1));
    else assert.equal(offset, null);
    pages++; assert.ok(pages <= 7, 'A continuation must advance and terminate.');
  } while (offset !== null);
  assert.equal(pages, 7); assert.equal(new Set(found).size, 256);
  assert.deepEqual(found, expectedNames.map(name => `fixture:param:${name}`));
  for (const terminalOffset of [256, 10_000]) {
    const terminal = await read(provider, 'entities.find', { kind: 'parameter', limit: 37, offset: terminalOffset }, defaultPage.state);
    assert.deepEqual(terminal.data.entities, []);
    assert.equal(terminal.data.total, 256); assert.equal(terminal.data.offset, terminalOffset); assert.equal(terminal.data.next_offset, null);
  }
});

test('entity filters precede pagination and unsupported fixture contexts are not reported as empty successful discoveries', async t => {
  const { provider } = await setup(t);
  for (const [kind, name, expected] of [['body', 'Bracket', 'fixture:body:bracket'], ['parameter', 'thickness', 'fixture:param:thickness']]) {
    const match = await read(provider, 'entities.find', { kind, name, limit: 1 });
    assert.deepEqual(match.data.entities.map(entity => entity.entity_id), [expected]);
    assert.equal(match.data.total, 1); assert.equal(match.data.next_offset, null);
    const pastMatch = await read(provider, 'entities.find', { kind, name, limit: 1, offset: 1 }, match.state);
    assert.deepEqual(pastMatch.data.entities, []);
    assert.equal(pastMatch.data.total, 1); assert.equal(pastMatch.data.offset, 1); assert.equal(pastMatch.data.next_offset, null);
  }
  for (const args of [{ kind: 'body', name: 'bracket' }, { kind: 'parameter', name: 'thick' }]) {
    const missing = await read(provider, 'entities.find', args);
    assert.deepEqual(missing.data.entities, []); assert.equal(missing.data.total, 0); assert.equal(missing.data.next_offset, null);
  }
  for (const [args, code] of [
    [{ kind: 'parameter', parent_id: 'fixture:body:bracket' }, 'INVALID_ARGUMENT'],
    [{ kind: 'body', parent_id: 'fixture:body:bracket' }, 'FIXTURE_UNSUPPORTED'],
    [{ kind: 'face', parent_id: 'fixture:body:bracket' }, 'FIXTURE_UNSUPPORTED'],
  ]) {
    const unsupported = await provider.dispatch(request('entities.find', args));
    assert.equal(unsupported.ok, false); assert.equal(unsupported.error.code, code); assert.equal(unsupported.error.outcome, 'none');
  }
});

test('direct fixture reads enforce catalog collection bounds without mutating state', async t => {
  const { provider } = await setup(t);
  const before = await read(provider, 'parameters.list');
  const invalid = [];
  for (const limit of [0, -1, 1.5, 101, '1', null]) {
    invalid.push(['parameters.list', { limit }], ['entities.find', { kind: 'parameter', limit }]);
  }
  for (const offset of [-1, 0.5, 10_001, '1', null]) invalid.push(['entities.find', { kind: 'parameter', offset }]);
  invalid.push(['parameters.list', { offset: 0 }], ['parameters.list', { kind: 'model' }], ['entities.find', { kind: 'body', cursor: 'invented' }]);
  for (const [operation, args] of invalid) {
    const result = await provider.dispatch(request(operation, args, before.state));
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.equal(result.error.code, 'INVALID_INPUT'); assert.equal(result.error.outcome, 'none');
  }
  const after = await read(provider, 'parameters.list', {}, before.state);
  assert.equal(after.state, before.state); assert.deepEqual(after.data, before.data);
});

test('state-bound pages reject intervening edits while parameter control and analytic geometry survive restarts', async t => {
  const fixture = await setup(t), engine = await fixture.engine();
  const inspect = { operation: 'parameters.list', document_id: DOCUMENT, args: {} };
  const before = await engine.read(inspect);
  assert.deepEqual(before.data.parameters.map(parameter => parameter.name), ['height', 'thickness', 'width']);
  const firstPage = await engine.read({ operation: 'entities.find', document_id: DOCUMENT, args: { kind: 'parameter', limit: 1 }, expected_state: before.state });
  const change = await engine.prepare({ operation: 'parameters.set', document_id: DOCUMENT, expected_state: firstPage.state, args: { changes: [{ parameter_id: WIDTH, expression: '2 in' }] } });
  assert.equal((await engine.execute(change.id, change.hash, 'fixture-pages-inch-width')).status, 'succeeded');
  await assert.rejects(engine.read({ operation: 'entities.find', document_id: DOCUMENT, expected_state: firstPage.state, args: { kind: 'parameter', limit: 1, offset: firstPage.data.next_offset } }), { code: 'STALE_STATE' });
  await assert.rejects(engine.read({ ...inspect, expected_state: before.state }), { code: 'STALE_STATE' });
  const restarted = await fixture.engine(), current = await restarted.read(inspect);
  assert.deepEqual(current.data.parameters.map(parameter => parameter.name), ['height', 'thickness', 'width']);
  assert.equal(current.data.parameters.find(parameter => parameter.id === WIDTH).expression, '2 in');
  assert.equal(current.data.parameters.find(parameter => parameter.id === WIDTH).value_mm, 50.8);
  const measured = await restarted.read({ operation: 'geometry.measure', document_id: DOCUMENT, expected_state: current.state, args: { kind: 'physical', entity_ids: ['fixture:body:bracket'] } });
  assert.equal(measured.data.volume.value, 5080); assert.equal(measured.data.live_fusion_verified, false);
  const restore = await restarted.prepare({ operation: 'parameters.set', document_id: DOCUMENT, expected_state: measured.state, args: { changes: [{ parameter_id: WIDTH, expression: '40 mm' }] } });
  assert.equal((await restarted.execute(restore.id, restore.hash, 'fixture-pages-restore-width')).status, 'succeeded');
  assert.deepEqual((await restarted.read(inspect)).data.parameters, before.data.parameters);
});
