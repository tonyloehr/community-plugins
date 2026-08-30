import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureEngine, fixtureProfile, installedExecutionContract, parseProfile, redact } from '../dist/index.mjs';
import { scoreObservationChecks, validateObservationChecks } from '../scripts/evaluation-observations.mjs';

const DOCUMENT = 'fixture:bracket', WIDTH = 'fixture:param:width', BODY = 'fixture:body:bracket';
let directory, contract, fixtures;
const wire = value => JSON.parse(JSON.stringify(redact(value)));
const call = (id, tool, args, value) => {
  const result = wire(value);
  return { type: 'item.completed', item: { id, type: 'mcp_tool_call', server: 'fusion_eval', tool, arguments: structuredClone(args), status: 'completed', error: null, result: { structured_content: result, content: [{ type: 'text', text: JSON.stringify(result) }] } } };
};
const content = event => event.item.result.structured_content;
const altered = (event, mutate, synchronizeText = true) => {
  const copy = structuredClone(event); mutate(copy.item);
  if (synchronizeText && copy.item.result?.structured_content) copy.item.result.content = [{ type: 'text', text: JSON.stringify(copy.item.result.structured_content) }];
  return copy;
};
const equals = (pointer, expected, select) => ({ kind: 'equals', pointer, expected, ...(select ? { select } : {}) });
const select = (id, valuePointer) => ({ pointer: '/id', equals: id, value_pointer: valuePointer });
const check = (source, assertions, phase = 'any', id = 'required-facts') => ({ id, source, phase, assertions });
const score = (checks, events) => scoreObservationChecks(checks, { events, executionContract: contract });
const widthFact = (width = 40) => check('parameter_values', [equals('/parameters', width, select(WIDTH, '/value_mm'))]);
const geometryFact = (volume, phase = 'any') => check('geometry_measure', [equals('/volume/value', volume), equals('/volume/unit', 'mm^3'), equals('/bounding_box/unit', 'mm'), equals('/bounding_box/frame', 'component')], phase);

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'fusion-observation-test-'));
  const execution = await installedExecutionContract(fileURLToPath(new URL('../', import.meta.url)));
  contract = execution.executionContractHash;
  const profile = parseProfile({ ...fixtureProfile(directory), id: 'observation-test', outputs: [], policy: { mutationsEnabled: true, effects: ['local_edit'], operations: ['parameters.set'], documents: [DOCUMENT], readDocuments: [DOCUMENT] } });
  const engine = await createFixtureEngine(profile, execution);
  try {
    fixtures = { status: call('status', 'fusion_connection_status', {}, await engine.connectionStatus()), capabilities: call('capabilities', 'fusion_capabilities_list', { include_schema: true }, engine.capabilities(undefined, true)) };
    fixtures.documents = call('documents', 'fusion_documents_list', {}, await engine.read({ operation: 'documents.list', args: {} }));
    fixtures.inspect = call('inspect', 'fusion_document_inspect', { document_id: DOCUMENT, args: {} }, await engine.read({ operation: 'document.inspect', document_id: DOCUMENT, args: {} }));
    fixtures.parameters = call('parameters', 'fusion_read', { operation: 'parameters.list', document_id: DOCUMENT, args: {} }, await engine.read({ operation: 'parameters.list', document_id: DOCUMENT, args: {} }));
    fixtures.partial = call('partial-parameters', 'fusion_read', { operation: 'parameters.list', document_id: DOCUMENT, args: { limit: 1 } }, await engine.read({ operation: 'parameters.list', document_id: DOCUMENT, args: { limit: 1 } }));
    const measure = { operation: 'geometry.measure', document_id: DOCUMENT, args: { entity_ids: [BODY], kind: 'physical' } };
    fixtures.geometry = call('geometry', 'fusion_geometry_measure', { document_id: DOCUMENT, args: measure.args }, await engine.read(measure));
    fixtures.health = call('health', 'fusion_design_check', { document_id: DOCUMENT, args: { kind: 'health' } }, await engine.read({ operation: 'geometry.check', document_id: DOCUMENT, args: { kind: 'health' } }));
    fixtures.cam = call('cam', 'fusion_cam_inspect', { document_id: DOCUMENT, args: {} }, await engine.read({ operation: 'cam.inspect', document_id: DOCUMENT, args: {} }));
    for (const width of [50, 60]) {
      const plan = await engine.prepare({ operation: 'parameters.set', document_id: DOCUMENT, args: { changes: [{ parameter_id: WIDTH, expression: `${width} mm` }] } });
      const args = { plan_id: plan.id, plan_hash: plan.hash, idempotency_key: `observation-test-width-${width}` };
      fixtures[`execute${width}`] = call(`execute-${width}`, 'fusion_changes_execute', args, await engine.execute(args.plan_id, args.plan_hash, args.idempotency_key));
      fixtures[`geometry${width}`] = call(`geometry-${width}`, 'fusion_geometry_measure', { document_id: DOCUMENT, args: measure.args }, await engine.read(measure));
      fixtures[`parameters${width}`] = call(`parameters-${width}`, 'fusion_read', { operation: 'parameters.list', document_id: DOCUMENT, args: {} }, await engine.read({ operation: 'parameters.list', document_id: DOCUMENT, args: {} }));
    }
    const whitespacePlan = await engine.prepare({ operation: 'parameters.set', document_id: DOCUMENT, args: { changes: [{ parameter_id: WIDTH, expression: '\t40 mm\n' }] } });
    assert.equal((await engine.execute(whitespacePlan.id, whitespacePlan.hash, 'observation-whitespace-once')).status, 'succeeded');
    fixtures.whitespace = call('whitespace-parameters', 'fusion_read', { operation: 'parameters.list', document_id: DOCUMENT, args: {} }, await engine.read({ operation: 'parameters.list', document_id: DOCUMENT, args: {} }));
  } finally { await engine.close(); }
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

test('verified connection metadata supplies document-summary facts without an extra document-list call', () => {
  const required = [check('connection', [equals('/mode', 'fixture'), equals('/desktop_evidence/kind', 'synthetic_fixture'), { kind: 'exists', pointer: '/desktop_qualification_candidate' }], 'any', 'connection'), check('document_summary', [equals('/document_id', DOCUMENT), equals('/product_type', 'DesignProductType'), equals('/saved', false)], 'any', 'summary')];
  const result = score(required, [fixtures.status]);
  assert.equal(result.passed, true);
  assert.ok(result.checks.every(item => item.matched_item_id === 'status'));
  assert.match(result.checks[1].state, /^[a-f0-9]{64}$/u);
  assert.equal(score([required[1]], [fixtures.status, fixtures.documents]).passed, true);
});

test('parameter facts accept list or inspection observations without inventing completeness metadata', () => {
  const required = check('parameter_values', [equals('/parameters', 'width', select(WIDTH, '/name')), equals('/parameters', '40 mm', select(WIDTH, '/expression')), equals('/parameters', 40, select(WIDTH, '/value_mm'))]);
  for (const source of [fixtures.parameters, fixtures.inspect]) {
    const result = score([required], [fixtures.status, source]);
    assert.equal(result.passed, true); assert.equal(result.checks[0].matched_item_id, source.item.id);
  }
  assert.equal(score([check('parameter_values', [equals('/total', 3), equals('/truncated', false)])], [fixtures.status, fixtures.inspect]).passed, false);
  assert.equal(score([check('parameter_values', [equals('/total', 3), equals('/truncated', false)])], [fixtures.status, fixtures.parameters]).passed, true);
});

test('numeric facts preserve the fixture API permitted literal-expression whitespace', () => {
  assert.equal(score([widthFact()], [fixtures.status, fixtures.whitespace]).passed, true);
  assert.equal(score([check('parameter_values', [equals('/parameters', '\t40 mm\n', select(WIDTH, '/expression'))])], [fixtures.status, fixtures.whitespace]).passed, true);
});

test('connection/document-summary admission rejects missing, duplicated or inconsistent target metadata', () => {
  const required = check('document_summary', [equals('/document_id', DOCUMENT)]);
  for (const mutate of [
    value => { delete value.desktop.state; },
    value => { value.mode = 'managed'; },
    value => { value.live_fusion_verified = true; },
    value => { value.desktop_evidence.provider = 'native_mcp'; },
    value => { value.desktop.data.documents[0].document_id = 'outside:document'; },
    value => { value.desktop.data.documents.push({ ...value.desktop.data.documents[0] }); value.desktop.data.total = 2; },
    value => { delete value.desktop.data.documents[0].product_type; },
  ]) assert.equal(score([required], [altered(fixtures.status, item => mutate(item.result.structured_content))]).passed, false);
  const duplicated = altered(fixtures.documents, item => { const value = item.result.structured_content; value.data.documents.push({ ...value.data.documents[0] }); value.data.total = 2; });
  // Use capabilities for attestation so a valid status summary cannot satisfy the check itself.
  assert.equal(score([required], [fixtures.capabilities, duplicated]).passed, false);
});

test('capabilities, inspection, geometry, health and CAM facts use their actual fixture shapes', () => {
  const required = [
    check('capabilities', [equals('/operations', 'local_edit', select('parameters.set', '/effect')), equals('/operations', true, select('parameters.set', '/profile_grant_authorized')), equals('/operations', false, select('parameters.set', '/live_qualified'))], 'any', 'capabilities'),
    check('document_inspection', [equals('/units', { angle: 'rad', length: 'mm' }), equals('/body_count', 1), { kind: 'length_equals', pointer: '/parameters', expected: 3 }], 'any', 'inspection'),
    { ...geometryFact(4000), id: 'geometry' },
    check('geometry_check', [equals('/checks', 'passed', { pointer: '/name', equals: 'synthetic_parameter_bounds', value_pointer: '/status' }), { kind: 'length_at_least', pointer: '/limitations', expected: 1 }], 'any', 'health'),
    check('cam_inspection', [{ kind: 'length_equals', pointer: '/setups', expected: 0 }], 'any', 'cam'),
  ];
  assert.equal(score(required, [fixtures.status, fixtures.capabilities, fixtures.inspect, fixtures.geometry, fixtures.health, fixtures.cam]).passed, true);
});

test('a bounded partial list proves present values but cannot supply missing facts or a full count', () => {
  assert.equal(content(fixtures.partial).data.truncated, true);
  const present = content(fixtures.partial).data.parameters[0];
  assert.equal(score([check('parameter_values', [equals('/parameters', present.value_mm, select(present.id, '/value_mm'))])], [fixtures.status, fixtures.partial]).passed, true);
  assert.equal(score([widthFact()], [fixtures.status, fixtures.partial]).passed, false);
  assert.equal(score([check('parameter_values', [{ kind: 'length_equals', pointer: '/parameters', expected: 3 }])], [fixtures.status, fixtures.partial]).passed, false);
});

test('all assertions must hold in one observation, never a splice of separate partial responses', () => {
  const partial = id => altered(fixtures.parameters, item => {
    item.id = `only-${id}`; item.arguments.args.limit = 1;
    item.result.structured_content.data.parameters = item.result.structured_content.data.parameters.filter(row => row.name === id);
    item.result.structured_content.data.truncated = true;
  });
  const required = check('parameter_values', [equals('/parameters', 40, select(WIDTH, '/value_mm')), equals('/parameters', 20, select('fixture:param:height', '/value_mm'))]);
  assert.equal(score([required], [fixtures.status, partial('width'), partial('height')]).passed, false);
  assert.equal(score([required], [fixtures.status, fixtures.parameters]).passed, true);
});

test('missing, duplicated, inconsistent and over-limit parameter responses fail required facts', () => {
  const mutations = [
    value => { delete value.data.parameters[0].value_mm; },
    value => { value.data.parameters.push({ ...value.data.parameters[0] }); value.data.total++; },
    value => { value.data.parameters[0].id = 'outside:parameter'; },
    value => { value.data.parameters[0].expression = '999 mm'; },
    value => { value.data.parameters[0].value_mm = '20'; },
    value => { value.data.total = 0; },
    value => { value.data.truncated = true; },
    value => { delete value.data.total; },
  ];
  for (const mutate of mutations) assert.equal(score([widthFact()], [fixtures.status, altered(fixtures.parameters, item => mutate(item.result.structured_content))]).passed, false);
  const tooMany = altered(fixtures.parameters, item => { item.arguments.args.limit = 1; });
  assert.equal(score([widthFact()], [fixtures.status, tooMany]).passed, false);
});

test('reads require an earlier exact attestation and cannot survive a later conflicting one', () => {
  assert.equal(score([widthFact()], [fixtures.parameters]).passed, false);
  assert.equal(score([widthFact()], [fixtures.parameters, fixtures.status]).passed, false);
  assert.equal(score([widthFact()], [fixtures.capabilities, fixtures.parameters]).passed, true);
  const bad = altered(fixtures.status, item => { item.id = 'changed-contract'; item.result.structured_content.execution_contract_sha256 = 'f'.repeat(64); });
  assert.equal(score([widthFact()], [fixtures.status, bad, fixtures.parameters]).passed, false);
  const refreshed = altered(fixtures.status, item => { item.id = 'refreshed-contract'; });
  assert.equal(score([widthFact()], [fixtures.status, bad, refreshed, fixtures.parameters]).passed, true);
  const claimedLive = altered(fixtures.capabilities, item => { item.result.structured_content.operations[0].live_qualified = true; });
  assert.equal(score([widthFact()], [fixtures.status, claimedLive, fixtures.parameters]).passed, false);
});

test('wrong targets, operations, states and synthetic/live markers never admit a read', () => {
  const mutations = [
    item => { item.arguments.document_id = 'outside:document'; },
    item => { item.result.structured_content.document_id = 'outside:document'; },
    item => { item.result.structured_content.operation = 'document.inspect'; },
    item => { item.result.structured_content.evidence = 'provider_response'; },
    item => { item.result.structured_content.state = 'not-a-state-hash'; },
    item => { item.arguments.expected_state = 'f'.repeat(64); },
    item => { item.result.structured_content.data.live_fusion_verified = true; },
    item => { item.result.structured_content.data.provider = 'native_mcp'; },
    item => { item.result.structured_content.effects.push('changed'); },
    item => { item.arguments.unreviewed = true; },
    item => { delete item.result.structured_content.operation; },
  ];
  for (const mutate of mutations) assert.equal(score([widthFact()], [fixtures.status, altered(fixtures.parameters, mutate)]).passed, false);
  const wrongInternal = altered(fixtures.inspect, item => { item.result.structured_content.data.document_id = 'outside:document'; });
  assert.equal(score([widthFact()], [fixtures.status, wrongInternal]).passed, false);
});

test('only completed error-free unambiguous structured tool receipts are admitted', () => {
  const mutations = [
    item => { item.server = 'other_server'; },
    item => { item.status = 'in_progress'; },
    item => { item.error = { message: 'failed' }; },
    item => { item.result.isError = true; },
    item => { item.result.is_error = 'false'; },
    item => { item.result.structured_content.error = null; },
    item => { item.result.structuredContent = structuredClone(item.result.structured_content); },
    item => { item.result = { content: item.result.content }; },
    item => { item.result.structured_content.extra = 'not an engine read envelope'; },
  ];
  for (const mutate of mutations) assert.equal(score([widthFact()], [fixtures.status, altered(fixtures.parameters, mutate)]).passed, false);
  const conflictingText = altered(fixtures.parameters, item => { item.result.content[0].text = '{}'; }, false);
  assert.equal(score([widthFact()], [fixtures.status, conflictingText]).passed, false);
  const incomplete = structuredClone(fixtures.parameters); incomplete.type = 'item.started';
  assert.equal(score([widthFact()], [fixtures.status, incomplete]).passed, false);
  assert.equal(score([widthFact()], [fixtures.status, fixtures.parameters, fixtures.parameters]).passed, false);
});

test('before/after phases require successful execution order and exact corresponding states', () => {
  const events = [fixtures.status, fixtures.geometry, fixtures.execute50, fixtures.geometry50];
  assert.equal(score([geometryFact(4000, 'before_change'), { ...geometryFact(5000, 'after_change'), id: 'after' }], events).passed, true);
  assert.equal(score([geometryFact(4000, 'after_change')], [fixtures.status, fixtures.geometry, fixtures.execute50]).passed, false);
  const delayedOld = altered(fixtures.geometry, item => { item.id = 'delayed-old-measurement'; });
  assert.equal(score([geometryFact(4000, 'after_change')], [fixtures.status, fixtures.execute50, delayedOld]).passed, false);
  assert.equal(score([geometryFact(5000, 'before_change')], [fixtures.status, fixtures.geometry50, fixtures.execute50]).passed, false);
  assert.equal(score([geometryFact(4000, 'before_change')], [fixtures.status, fixtures.geometry]).passed, false);
  const failed = altered(fixtures.execute50, item => { item.result.structured_content.status = 'failed'; });
  assert.equal(score([geometryFact(5000, 'after_change')], [fixtures.status, failed, fixtures.geometry50]).passed, false);
});

test('after-change observations bind the last successful execution rather than an earlier edit', () => {
  const events = [fixtures.status, fixtures.geometry, fixtures.execute50, fixtures.geometry50, fixtures.execute60];
  assert.equal(score([geometryFact(5000, 'after_change')], events).passed, false);
  assert.equal(score([geometryFact(6000, 'after_change')], [...events, fixtures.geometry60]).passed, true);
  const wrongContract = altered(fixtures.execute50, item => { item.result.structured_content.execution_contract_hash = 'f'.repeat(64); });
  assert.equal(score([geometryFact(5000, 'after_change')], [fixtures.status, wrongContract, fixtures.geometry50]).passed, false);
  const wrongTool = altered(fixtures.execute50, item => { item.tool = 'fusion_cam_generate'; });
  assert.equal(score([geometryFact(5000, 'after_change')], [fixtures.status, wrongTool, fixtures.geometry50]).passed, false);
});

test('units, frame, consistent numeric geometry and declared approximation tolerances are checked', () => {
  for (const mutate of [value => { value.data.volume.unit = 'cm^3'; }, value => { value.data.bounding_box.unit = 'cm'; }, value => { value.data.bounding_box.frame = 'world'; }, value => { value.data.volume.value = 1; }, value => { value.data.bounding_box.max[0] = '40'; }]) assert.equal(score([geometryFact(4000)], [fixtures.status, altered(fixtures.geometry, item => mutate(item.result.structured_content))]).passed, false);
  assert.equal(score([geometryFact(5000)], [fixtures.status, fixtures.geometry]).passed, false);
  const approximate = expected => check('geometry_measure', [{ kind: 'approx', pointer: '/volume/value', expected, absolute_tolerance: 0.01, relative_tolerance: 0 }]);
  assert.equal(score([approximate(4000.001)], [fixtures.status, fixtures.geometry]).passed, true);
  assert.equal(score([approximate(4000.1)], [fixtures.status, fixtures.geometry]).passed, false);
  assert.equal(score([check('geometry_measure', [equals('/bounding_box/max', [40, 20, 5]), equals('/bounding_box/min', [0, 0, 0])])], [fixtures.status, fixtures.geometry]).passed, true);
});

test('unsafe pointers, schema extras, invalid tolerances, duplicate IDs and oversized checks are rejected', () => {
  const valid = widthFact();
  for (const pointer of ['$.parameters', '#/parameters', '/__proto__', '/constructor/x', '/x/prototype', '/bad~2escape', '/x'.repeat(33), '/' + 'x'.repeat(1024), '/bad\u0000key']) {
    const item = structuredClone(valid); item.assertions[0].pointer = pointer;
    assert.throws(() => validateObservationChecks([item]), { code: 'INVALID_OBSERVATION_CHECKS' });
  }
  const invalid = [
    { ...valid, source: 'arbitrary_code' }, { ...valid, phase: 'later' }, { ...valid, extra: true },
    check('connection', [{ kind: 'exists', pointer: '/mode', expected: true }]),
    check('connection', [{ kind: 'equals', pointer: '/mode' }]),
    check('connection', [{ kind: 'approx', pointer: '/mode', expected: Infinity }]),
    check('connection', [{ kind: 'approx', pointer: '/mode', expected: 1, absolute_tolerance: -1 }]),
    check('connection', [{ kind: 'approx', pointer: '/mode', expected: 1, relative_tolerance: 0.1 }]),
    check('connection', [{ kind: 'length_equals', pointer: '/mode', expected: 1.5 }]),
    check('connection', [equals('/mode', true, { pointer: '/id', equals: 4, value_pointer: '' })]),
    check('connection', [equals('/mode', true, { pointer: '/id', equals: 'x', value_pointer: '', optional: true })]),
    check('connection', [equals('/mode', 'x'.repeat(262_144))]),
    { ...valid, assertions: Array.from({ length: 33 }, () => valid.assertions[0]) },
  ];
  for (const value of invalid) assert.throws(() => validateObservationChecks([value]), { code: 'INVALID_OBSERVATION_CHECKS' });
  assert.throws(() => validateObservationChecks([valid, valid]), { code: 'INVALID_OBSERVATION_CHECKS' });
  assert.throws(() => validateObservationChecks(Array.from({ length: 33 }, (_, i) => ({ ...valid, id: `check-${i}` }))), { code: 'INVALID_OBSERVATION_CHECKS' });
  assert.throws(() => validateObservationChecks(Array.from({ length: 32 }, (_, i) => ({ ...valid, id: `check-${i}`, assertions: Array.from({ length: 9 }, () => valid.assertions[0]) }))), { code: 'INVALID_OBSERVATION_CHECKS' });
  assert.doesNotThrow(() => validateObservationChecks([check('connection', [{ kind: 'exists', pointer: '/escaped~1slash/~0tilde' }])]));
});

test('non-JSON values, reserved keys, accessors, cycles and trace limits are rejected without executing hooks', () => {
  const cyclic = widthFact(); cyclic.assertions[0].expected = cyclic;
  assert.throws(() => validateObservationChecks([cyclic]), { code: 'INVALID_OBSERVATION_CHECKS' });
  const accessor = widthFact(); let called = false;
  Object.defineProperty(accessor.assertions[0], 'expected', { enumerable: true, get() { called = true; return 40; } });
  assert.throws(() => validateObservationChecks([accessor]), { code: 'INVALID_OBSERVATION_CHECKS' }); assert.equal(called, false);
  const reserved = widthFact(); reserved.assertions[0].expected = JSON.parse('{"constructor":1}');
  assert.throws(() => validateObservationChecks([reserved]), { code: 'INVALID_OBSERVATION_CHECKS' });
  let nested = 0; for (let i = 0; i < 22; i++) nested = [nested];
  assert.throws(() => validateObservationChecks([check('connection', [equals('', nested)])]), { code: 'INVALID_OBSERVATION_CHECKS' });
  const nonfinite = altered(fixtures.parameters, item => { item.result.structured_content.data.parameters[0].value_mm = Infinity; });
  assert.throws(() => score([widthFact()], [fixtures.status, nonfinite]), { code: 'INVALID_OBSERVATION_EVIDENCE' });
  assert.throws(() => score([widthFact()], Array.from({ length: 50_001 }, () => ({ type: 'turn.started' }))), { code: 'INVALID_OBSERVATION_EVIDENCE' });
  assert.throws(() => scoreObservationChecks([widthFact()], { events: [], executionContract: 'wrong' }), { code: 'INVALID_OBSERVATION_EVIDENCE' });
});

test('scoring is deterministic, does not mutate inputs, and never treats text-only/model claims as facts', () => {
  const checks = [widthFact()], events = structuredClone([fixtures.status, fixtures.parameters]);
  const original = JSON.stringify({ checks, events });
  const first = score(checks, events), second = score(checks, events);
  assert.deepEqual(first, second); assert.equal(JSON.stringify({ checks, events }), original);
  assert.equal(score(checks, [{ type: 'item.completed', item: { id: 'claim', type: 'agent_message', text: 'Width is 40 mm and Fusion is verified.' } }]).passed, false);
  assert.deepEqual(score([], []), { passed: true, checks: [] }, 'Empty externally gated observations make no independent workflow claim.');
});
