import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createFixtureEngine, createFusionServer, fixtureProfile } from '../dist/index.mjs';

async function setup(t, cloud) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fusion-input-defaults-'));
  const profile = fixtureProfile(root), engine = await createFixtureEngine(profile);
  const server = createFusionServer({ root, profile, engine, ...(cloud ? { cloud } : {}), close: () => engine.close() });
  const client = new Client({ name: 'mcp-input-defaults', version: '1.0.0' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right); await client.connect(left);
  t.after(async () => { await client.close(); await server.close(); await engine.close(); await rm(root, { recursive: true, force: true }); });
  return { client, engine };
}

test('MCP defaulted inputs are optional on the wire and still receive server defaults', async t => {
  const { client, engine } = await setup(t);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.find(item => item.name === 'fusion_capabilities_list').inputSchema.required?.includes('include_schema') ?? false, false);
  assert.equal(tools.find(item => item.name === 'fusion_artifact_inspect').inputSchema.required.includes('allow_pending'), false);
  const capability = await client.callTool({ name: 'fusion_capabilities_list', arguments: {} });
  assert.equal(capability.isError, undefined);
  assert.ok(capability.structuredContent.operations.every(item => item.input_schema === undefined));
  const seen = [];
  engine.artifacts.inspect = async (id, allowPending) => { seen.push({ id, allowPending }); return { observed: true }; };
  const inspected = await client.callTool({ name: 'fusion_artifact_inspect', arguments: { artifact_id: 'test-only-artifact' } });
  assert.equal(inspected.isError, undefined);
  assert.deepEqual(seen, [{ id: 'test-only-artifact', allowPending: false }]);
  const invalid = await client.callTool({ name: 'fusion_artifact_inspect', arguments: { artifact_id: 'test-only-artifact', allow_pending: 'true' } });
  assert.equal(invalid.isError, true); assert.equal(seen.length, 1);
});

test('omitting cloud concurrency input preserves the safer true default', async t => {
  const seen = [], cloud = { prepareProperty: async (...args) => { seen.push(args); return { prepared: true, effect_performed: false }; } };
  const { client } = await setup(t, cloud);
  const context = { modelId: 'model:test-only', timestamp: '2026-08-31T00:00:00Z', composition: 'AS_SAVED' };
  const args = { operation: 'mfg.property_set', context, property_id: 'property:test-only', after: 10 };
  const result = await client.callTool({ name: 'fusion_data_changes_prepare', arguments: args });
  assert.equal(result.isError, undefined);
  assert.deepEqual(seen, [[context, 'property:test-only', 10, true]]);
  const explicit = await client.callTool({ name: 'fusion_data_changes_prepare', arguments: { ...args, require_atomic_concurrency: false } });
  assert.equal(explicit.isError, undefined); assert.equal(seen[1][3], false);
  // This test double observes only the input contract; real profile authorization
  // remains in CloudCoordinator and is covered by its separate policy tests.
  const invalid = await client.callTool({ name: 'fusion_data_changes_prepare', arguments: { ...args, require_atomic_concurrency: null } });
  assert.equal(invalid.isError, true); assert.equal(seen.length, 2);
});

test('handoff input defaults apply through nested union branches without invented checks', async t => {
  const { client } = await setup(t);
  const draft = await client.callTool({ name: 'fusion_handoff_prepare', arguments: { title: 'Metadata-only review outline' } });
  assert.equal(draft.isError, undefined);
  assert.deepEqual(draft.structuredContent.checks, []);
  assert.equal(draft.structuredContent.engineering_approval, false);
  const manual = await client.callTool({ name: 'fusion_handoff_prepare', arguments: { title: 'Manual review', checks: [{ id: 'C_review', kind: 'manual', procedure: 'A qualified engineer must review the applicable load cases.' }] } });
  assert.equal(manual.isError, undefined);
  assert.equal(manual.structuredContent.checks[0].status, 'not_run');
  const forbidden = await client.callTool({ name: 'fusion_handoff_prepare', arguments: { title: 'Invalid claimed approval', approved: true } });
  assert.equal(forbidden.isError, true);
});
