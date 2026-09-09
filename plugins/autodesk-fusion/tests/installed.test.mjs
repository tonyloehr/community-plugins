import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fixtureProfile } from '../dist/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function installed(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'fusion installed package '));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const packageRoot = path.join(temporary, 'Autodesk Fusion');
  await cp(root, packageRoot, { recursive: true, filter: filename => !['node_modules', 'src', 'tests', '__pycache__'].includes(path.basename(filename)) });
  const profileFile = path.join(temporary, 'fixture-profile.json');
  await writeFile(profileFile, JSON.stringify(fixtureProfile(path.join(temporary, 'state'))), { mode: 0o600 });
  return { temporary, packageRoot, profileFile };
}
async function processResult(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; }); child.on('error', reject);
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Installed process timeout')); }, 20_000);
    child.on('exit', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
  });
}
test('copied install runs CLI without node_modules, TypeScript, shell interpolation or startup downloads', async t => {
  const { packageRoot, profileFile } = await installed(t);
  assert.equal((await readdir(packageRoot)).includes('node_modules'), false);
  assert.equal((await readdir(packageRoot)).includes('src'), false);
  assert.match(await readFile(path.join(packageRoot, 'dist', 'index.d.mts'), 'utf8'), /types\/index/);
  assert.match(await readFile(path.join(packageRoot, 'dist', 'types', 'cloud-coordinator.d.ts'), 'utf8'), /interface EnterpriseCloudServices/);
  const readme = await readFile(path.join(packageRoot, 'README.md'), 'utf8');
  for (const match of readme.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
    if (/^https?:/.test(match[1])) continue;
    await readFile(path.resolve(packageRoot, match[1]));
  }
  const result = await processResult(process.execPath, [path.join(packageRoot, 'scripts', 'fusionctl.mjs'), 'status', '--profile', profileFile], { cwd: os.tmpdir(), env: { ...process.env, FUSION_PROFILE: profileFile } });
  assert.equal(result.code, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.mode, 'fixture'); assert.equal(status.live_fusion_verified, false); assert.equal(status.desktop.data.provider, 'synthetic_fixture');
});

for (const mode of ['legacy', 'auto']) test(`copied stdio MCP install negotiates ${mode}, discovers tools and completes a governed fixture workflow`, async t => {
  const { packageRoot, profileFile } = await installed(t);
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(packageRoot, 'mcp', 'server.mjs')], cwd: packageRoot, env: { ...Object.fromEntries(Object.entries(process.env).filter(([,v]) => typeof v === 'string')), FUSION_PROFILE: profileFile }, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', bytes => { stderr += bytes; });
  const client = new Client({ name: 'installed-fusion-qualification', version: '1.0.0' }, { versionNegotiation: { mode } });
  t.after(async () => { await client.close(); });
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  const names = tools.map(tool => tool.name);
  assert.ok(names.includes('fusion_cloud_job_submit'));
  assert.ok(names.includes('fusion_data_changes_prepare'));
  assert.equal(names.includes('fusion_native_invoke'), false);
  const invoke = async (name, arguments_) => {
    const result = await client.callTool({ name, arguments: arguments_ });
    if (result.isError) assert.fail(`${name} failed: ${JSON.stringify(result)}; stderr=${stderr}`);
    return result.structuredContent ?? JSON.parse(result.content.find(c => c.type === 'text').text);
  };
  const documents = await invoke('fusion_documents_list', {});
  assert.equal(documents.data.documents[0].document_id, 'fixture:bracket');
  const inspected = await invoke('fusion_document_inspect', { document_id: 'fixture:bracket', args: {} });
  assert.equal(inspected.data.name, 'Synthetic bracket');
  const capabilities = await invoke('fusion_capabilities_list', { family: 'parameters', include_schema: true });
  assert.ok(capabilities.operations.find(op => op.id === 'parameters.set').input_schema);
  const plan = await invoke('fusion_changes_prepare', { operation: 'parameters.set', document_id: 'fixture:bracket', expected_state: inspected.state, args: { changes: [{ parameter_id: 'fixture:param:width', expression: '7 cm' }] } });
  const done = await invoke('fusion_changes_execute', { plan_id: plan.id, plan_hash: plan.hash, idempotency_key: 'installed-package-once' });
  assert.equal(done.status, 'succeeded');
  const measured = await invoke('fusion_geometry_measure', { document_id: 'fixture:bracket', args: { kind: 'physical', entity_ids: ['fixture:body:bracket'] } });
  assert.equal(measured.data.volume.value, 7000);
  const denied = await client.callTool({ name: 'fusion_changes_prepare', arguments: { operation: 'execute_python', args: { code: '__import__("os").system("touch /tmp/should-not-exist")' } } });
  assert.equal(denied.isError, true);
  const unavailable = await client.callTool({ name: 'fusion_data_search', arguments: { operation: 'data.hubs', args: {} } });
  assert.equal(unavailable.isError, true);
  assert.match(JSON.stringify(unavailable), /CLOUD_NOT_CONFIGURED/);
  const readResource = await client.readResource({ uri: 'fusion://capabilities' });
  assert.match(readResource.contents[0].text, /synthetic|Synthetic/);
});

test('live qualification cannot report success when only the fixture is available', async t => {
  const { packageRoot, profileFile } = await installed(t);
  const result = await processResult(process.execPath, [path.join(packageRoot, 'scripts', 'fusionctl.mjs'), 'qualify', '--live', '--profile', profileFile], { cwd: packageRoot, env: process.env });
  assert.equal(result.code, 2, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'incomplete'); assert.equal(report.live_fusion_qualified, false); assert.equal(report.live_fusion_attempted, false);
});

test('source/runtime build receipt covers canonical handlers and bundled native credential modules', async () => {
  const { createHash } = await import('node:crypto');
  const receipt = JSON.parse(await readFile(path.join(root, 'dist', 'build-receipt.json'), 'utf8'));
  assert.ok(receipt.files['handlers/fusion_runtime.py']);
  const native = JSON.parse(await readFile(path.join(root, 'native', 'build-manifest.json'), 'utf8'));
  assert.ok(native.assets.length >= 1 && native.assets.length <= 6);
  assert.deepEqual(Object.keys(receipt.files).filter(file => file.endsWith('.node')).sort(), native.assets.map(asset => asset.path).sort());
  assert.match(native.origin, /original npm platform binaries are not redistributed/);
  for (const [filename, expected] of Object.entries(receipt.files)) assert.equal(createHash('sha256').update(await readFile(path.join(root, filename))).digest('hex'), expected, filename);
});
