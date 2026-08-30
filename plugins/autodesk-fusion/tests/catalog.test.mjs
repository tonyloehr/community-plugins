import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { parseOperation, createFusionServer, fixtureProfile } from '../dist/index.mjs';

const document = 'fixture:bracket';
const operation = (name, args) => ({ operation: name, document_id: document, args });
const rejects = value => assert.throws(() => parseOperation(value), { code: 'INVALID_INPUT' });

test('CAD contracts reject impossible sketch cardinalities before a plan can be prepared', () => {
  const dimension = { sketch_id: 'sketch-1', kind: 'distance', entity_ids: ['point-1', 'point-2'], text_position: ['0 mm', '0 mm'], expression: '10 mm' };
  assert.equal(parseOperation(operation('sketches.dimension', dimension)).args.kind, 'distance');
  rejects(operation('sketches.dimension', { ...dimension, entity_ids: ['point-1'] }));
  rejects(operation('sketches.dimension', { ...dimension, kind: 'diameter' }));
  assert.equal(parseOperation(operation('sketches.dimension', { ...dimension, kind: 'diameter', entity_ids: ['circle-1'] })).args.kind, 'diameter');
  const constraint = kind => operation('sketches.constrain', { sketch_id: 'sketch-1', constraints: [{ kind, entity_ids: ['line-1'] }] });
  parseOperation(constraint('horizontal'));
  rejects(constraint('parallel'));
});

test('CAD and CAM preflight retain their distinct expression, value and entitlement limits', () => {
  const parameter = { name: 'count', expression: '1', unit: '', comment: '' };
  parseOperation(operation('parameters.add', parameter));
  rejects(operation('parameters.add', { ...parameter, expression: '1'.repeat(513) }));
  rejects(operation('parameters.add', { ...parameter, unit: 'm'.repeat(65) }));
  const cam = { setup_id: 'setup-1', strategy: 'face', parameters: [{ name: 'expression-parameter', type: 'expression', value: '1'.repeat(1024) }] };
  parseOperation(operation('cam.operation_create', cam));
  rejects(operation('cam.operation_create', { ...cam, strategy: 'turning' }));
  rejects(operation('cam.operation_create', { ...cam, parameters: [{ name: 'count', type: 'integer', value: 2147483648 }] }));
  rejects(operation('cam.operation_create', { ...cam, parameters: [{ name: 'count', type: 'integer', value: -2147483649 }] }));
});

test('opaque desktop handles, cloud identifiers and configured asset aliases use the right bounds', () => {
  rejects({ operation: 'document.inspect', document_id: 'd'.repeat(129), args: {} });
  rejects({ operation: 'document.inspect', document_id: document, expected_state: 's'.repeat(129), args: {} });
  parseOperation({ operation: 'documents.open', args: { data_file_id: 'a'.repeat(2048), expected_version_id: 'b'.repeat(2048) } });
  parseOperation(operation('materials.list', { library_id: 'm'.repeat(1024) }));
  parseOperation(operation('cam.tools_list', { tool_library_id: 't'.repeat(160) }));
  rejects(operation('cam.tools_list', { tool_library_id: 't'.repeat(161) }));
});

test('save allows an explicitly empty description; pagination rejects values the handler cannot serve', () => {
  parseOperation(operation('documents.save', { description: '' }));
  rejects(operation('documents.save', { description: 'd'.repeat(2049) }));
  parseOperation(operation('bom.inspect', { limit: 100, offset: 10_000 }));
  rejects(operation('bom.inspect', { limit: 101 }));
  rejects(operation('bom.inspect', { offset: 10_001 }));
});

test('the real MCP BOM alias preserves the desktop state precondition and rejects snapshot/desktop ambiguity', async t => {
  const observed = [];
  const runtime = { profile: fixtureProfile(path.join(os.tmpdir(), 'unused-bom-wire-profile')), engine: { read: async input => { observed.push(input); return { data: { rows: [] }, state: 'state-a' }; } } };
  const server = createFusionServer(runtime), client = new Client({ name: 'bom-facade-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const call = args => client.callTool({ name: 'fusion_bom_inspect', arguments: args });
  assert.equal((await call({ source: 'desktop', document_id: document, expected_state: 'state-a', limit: 100, offset: 100 })).isError, undefined);
  assert.deepEqual(observed[0], { operation: 'bom.inspect', document_id: document, expected_state: 'state-a', args: { limit: 100, offset: 100 } });
  assert.equal((await call({ source: 'desktop', document_id: document, limit: 101 })).isError, true);
  assert.equal((await call({ source: 'desktop', document_id: document, snapshot: {} })).isError, true);
  assert.equal((await call({ source: 'snapshot', document_id: document, expected_state: 'state-a', snapshot: {} })).isError, true);
  assert.equal(observed.length, 1);
});
