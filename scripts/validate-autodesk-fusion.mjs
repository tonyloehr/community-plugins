import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyNativeDistribution } from '../plugins/autodesk-fusion/scripts/verify-native.mjs';
import { validateCorpus } from '../plugins/autodesk-fusion/scripts/evaluate-workflows.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(repo, 'plugins', 'autodesk-fusion');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const manifest = JSON.parse(read('.codex-plugin/plugin.json'));
assert.equal(manifest.name, 'autodesk-fusion');
assert.equal(manifest.license, 'Apache-2.0');
assert.equal(manifest.skills, './skills/');
assert.equal(manifest.mcpServers, './.mcp.json');
assert.ok(Array.isArray(manifest.interface.defaultPrompt));
const mcp = JSON.parse(read('.mcp.json'));
assert.deepEqual(Object.keys(mcp.mcpServers), ['autodesk-fusion']);
assert.equal(mcp.mcpServers['autodesk-fusion'].command, 'node');
assert.deepEqual(mcp.mcpServers['autodesk-fusion'].args, ['./mcp/server.mjs']);
assert.equal(mcp.mcpServers['autodesk-fusion'].cwd, '.');
assert.deepEqual(mcp.mcpServers['autodesk-fusion'].env_vars, ['FUSION_PROFILE']);
for (const name of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'SECURITY.md', 'docs/operation-catalog.json', 'docs/support-matrix.md', 'docs/software-inventory.json', 'docs/qualification.md', 'docs/cad-features.md', 'docs/enterprise.md', 'docs/operations.md', 'docs/artifact-fidelity.md', 'docs/batches.md', 'docs/handoffs.md', 'docs/manage-drafts.md', 'docs/retention.md', 'docs/native-builds.md', 'docs/performance.md', 'docs/workflow-evaluation.md', 'evaluation/workflow-corpus.json', 'evaluation/workflow-corpus-v2.json', 'docs/autodesk-fusion-360-plugin-implementation-plan.md', 'docs/autodesk-fusion-implementation-status.md', 'dist/index.d.mts', 'dist/types/cloud-coordinator.d.ts']) assert.ok(read(name).trim(), name);
const evaluationCorpus = validateCorpus(JSON.parse(read('evaluation/workflow-corpus.json')));
assert.ok(evaluationCorpus.counts.supported >= 60 && evaluationCorpus.counts.adversarial >= 60);
const packageLock = JSON.parse(read('package-lock.json'));
for (const [location, dependency] of Object.entries(packageLock.packages)) {
  if (!location) continue;
  const resolved = new URL(dependency.resolved);
  assert.ok(resolved.protocol === 'https:' && resolved.hostname === 'registry.npmjs.org' && !resolved.port && !resolved.username && !resolved.password && !resolved.search && !resolved.hash && resolved.pathname.endsWith('.tgz'), `Public lockfile must use canonical npm package identities, not an environment-specific mirror: ${location}`);
  assert.match(dependency.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/u, `Pinned package integrity is required: ${location}`);
}
const inventory = JSON.parse(read('docs/software-inventory.json'));
assert.deepEqual(inventory.components.map(entry => ({ name: entry.name, version: entry.version, resolved: entry.resolved, integrity: entry.registry_integrity })).sort((a, b) => a.name.localeCompare(b.name)), Object.entries(packageLock.packages).filter(([location]) => location).map(([location, entry]) => ({ name: location.split('node_modules/').at(-1), version: entry.version, resolved: entry.resolved, integrity: entry.integrity })).sort((a, b) => a.name.localeCompare(b.name)), 'Public npm inventory must preserve every locked package identity and checksum.');
const skills = fs.readdirSync(path.join(root, 'skills'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
assert.equal(skills.length, 8);
for (const name of skills) {
  const body = read(`skills/${name}/SKILL.md`), ui = read(`skills/${name}/agents/openai.yaml`);
  assert.match(body, new RegExp(`^---\\r?\\nname: ${name}\\r?\\ndescription: .+\\r?\\n---`, 'u'));
  assert.ok(!body.includes('[TODO:') && !body.includes('TODO:') && body.length < 16_000, name);
  assert.ok(ui.includes(`$${name}`) && ui.includes('interface:'), name);
  assert.ok(!/allow_implicit_invocation:\s*false/u.test(ui), 'Implicit invocation should remain the normal default.');
  for (const match of body.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
    if (/^https?:/.test(match[1])) continue;
    assert.ok(fs.existsSync(path.resolve(root, 'skills', name, match[1])), `${name}: missing ${match[1]}`);
  }
}
const catalog = JSON.parse(read('docs/operation-catalog.json'));
assert.ok(catalog.operations.length >= 60);
for (const id of ['construction_planes.offset', 'features.sweep', 'features.loft', 'features.draft', 'features.split_body', 'features.mirror']) assert.ok(catalog.operations.some(operation => operation.id === id && operation.effect === 'local_edit'), `Missing reviewed CAD contract: ${id}`);
assert.equal(new Set(catalog.operations.map(op => op.id)).size, catalog.operations.length);
assert.ok(catalog.boundaries.length >= 7);
assert.ok(catalog.operations.every(op => op.input_schema && op.source.startsWith('https://help.autodesk.com/')));
const receipt = JSON.parse(read('dist/build-receipt.json'));
assert.deepEqual(await verifyNativeDistribution(root), JSON.parse(read('native/build-manifest.json')), 'Native source/build/license inventory must agree with the packaged modules.');
assert.equal(receipt.schema, 1);
for (const [filename, expected] of Object.entries(receipt.files)) {
  assert.ok(!path.isAbsolute(filename) && !filename.includes('..') && /^[a-f0-9]{64}$/.test(expected));
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, filename))).digest('hex'), expected, `Build receipt drift: ${filename}`);
}
const handler = read('handlers/fusion_runtime.py');
const handlers = [...handler.matchAll(/@_operation\("([a-z_.]+)"/g)].map(match => match[1]).sort();
assert.deepEqual(handlers, catalog.operations.map(op => op.id).sort(), 'Advertised desktop registry must match the actual shipped handler IDs.');
const addon = JSON.parse(read('dist/addin/CodexFusionInterop/handler-manifest.json'));
assert.equal(addon.handler_hash, createHash('sha256').update(handler).digest('hex'));
assert.equal(read('dist/addin/CodexFusionInterop/fusion_runtime.py'), handler);
const builtInScopes = read('README.md') + read('SECURITY.md');
assert.match(builtInScopes, /fixture/i);
assert.match(builtInScopes, /not.*sandbox/i);
assert.match(builtInScopes, /qualified/i);
console.log(`Autodesk Fusion package validated: ${handlers.length} desktop operations, ${skills.length} skills, exact source/build/native/license receipts.`);
