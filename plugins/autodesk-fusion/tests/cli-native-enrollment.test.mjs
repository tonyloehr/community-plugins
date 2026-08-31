import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, link, lstat, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfile, parseProfile, profileHash, schemaFingerprint } from '../dist/index.mjs';
import { fixtureTool, legacyFixture, modernFixture } from './native-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'scripts', 'fusionctl.mjs');
const simpleTool = {
  ...fixtureTool,
  inputSchema: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'], additionalProperties: false },
};
const neverExecute = async () => ({ isError: true, content: [{ type: 'text', text: 'Enrollment tests must never execute a native tool.' }] });

async function workspace(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fusion native enrollment '));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function profileFile(directory, url, override = {}) {
  const profile = parseProfile({
    version: 1, id: 'native-enrollment-contract', mode: 'managed', stateRoot: path.join(directory, 'unused-state'),
    desktop: { provider: 'native', url, timeoutMs: 12_000 },
    policy: { mutationsEnabled: false, readDocuments: ['explicit-reviewed-document'] },
    outputs: [], ...override,
  });
  const filename = path.join(directory, 'trusted profile.json');
  const bytes = Buffer.from(JSON.stringify(profile, null, 2) + '\n');
  await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
  return { filename, bytes, profile };
}

async function fixedFile(directory, data = { language: 'python' }) {
  const filename = path.join(directory, 'reviewed fixed arguments.json');
  await writeFile(filename, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data), { flag: 'wx', mode: 0o600 });
  return filename;
}

async function cli(args, directory) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: directory, env: { ...process.env, FUSION_PROFILE: '' }, shell: false,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', failure;
    const stop = reason => { failure ??= reason; child.kill('SIGKILL'); };
    const deadline = setTimeout(() => stop(new Error('Native enrollment CLI exceeded its 25 second test deadline.')), 25_000);
    const capture = stream => bytes => {
      if (stream === 'stdout') stdout += bytes; else stderr += bytes;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 1_048_576) stop(new Error('Native enrollment CLI output exceeded its test bound.'));
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', capture('stdout')); child.stderr.on('data', capture('stderr'));
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(deadline);
      if (failure) reject(failure); else resolve({ code, signal, stdout, stderr });
    });
  });
}

const enrollArgs = (profile, tool = simpleTool) => ['native-enroll', '--profile', profile.filename, '--tool', tool.name, '--argument', 'script', '--hash', schemaFingerprint(tool)];
function rejected(result, code) {
  assert.equal(result.code, 1, JSON.stringify(result));
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error.code, code, result.stderr);
}
function noExecution(fixture) {
  assert.deepEqual(fixture.calls, [], 'Enrollment is discovery only, never native tool execution.');
  assert.equal(fixture.requests.some(request => request.method === 'tools/call'), false);
}

for (const protocol of ['legacy', 'modern-json', 'modern-sse']) test(`actual CLI enrolls reviewed required fixed arguments from ${protocol} discovery without execution`, async t => {
  const directory = await workspace(t);
  const fixture = protocol === 'legacy' ? await legacyFixture(t, { call: neverExecute })
    : await modernFixture(t, protocol === 'modern-json' ? 'json' : 'sse', { call: neverExecute });
  const profile = await profileFile(directory, fixture.url);
  const fixed = await fixedFile(directory);
  const discovery = await cli(['native-discover', '--url', fixture.url], directory);
  assert.equal(discovery.code, 0, discovery.stderr);
  const tool = JSON.parse(discovery.stdout).tools.find(value => value.name === fixtureTool.name);
  assert.ok(tool && /^[a-f0-9]{64}$/.test(tool.schema_sha256));
  const result = await cli(['native-enroll', '--profile', profile.filename, '--tool', tool.name, '--argument', 'script', '--hash', tool.schema_sha256, '--fixed-arguments-file', fixed], directory);
  assert.equal(result.code, 0, result.stderr);
  const enrolled = JSON.parse(await readFile(profile.filename, 'utf8'));
  const expected = { tool: tool.name, argument: 'script', schemaHash: tool.schema_sha256, fixedArguments: { language: 'python' } };
  assert.deepEqual(enrolled, { ...profile.profile, desktop: { ...profile.profile.desktop, mapping: expected } });
  assert.deepEqual(JSON.parse(result.stdout).enrolled, expected);
  assert.equal(JSON.parse(result.stdout).live_qualified, false);
  assert.equal((await lstat(profile.filename)).nlink, 1);
  noExecution(fixture);
  if (protocol === 'legacy') assert.equal(fixture.sessionDeleted, true);
});

test('native enrollment without additional required fields still needs no fixed-argument file', async t => {
  const directory = await workspace(t);
  const fixture = await legacyFixture(t, { list: () => ({ tools: [simpleTool] }), call: neverExecute });
  const profile = await profileFile(directory, fixture.url, { mode: 'assisted' });
  const result = await cli(enrollArgs(profile), directory);
  assert.equal(result.code, 0, result.stderr);
  const enrolled = JSON.parse(await readFile(profile.filename, 'utf8'));
  assert.equal(enrolled.mode, 'assisted');
  assert.equal(Object.hasOwn(enrolled.desktop.mapping, 'fixedArguments'), false);
  assert.deepEqual(enrolled.policy, profile.profile.policy);
  noExecution(fixture);
});

test('native enrollment preserves reviewed JSON values exactly without inferring defaults', async t => {
  const directory = await workspace(t);
  const fixedArguments = { language: 'python', enabled: false, count: 0, note: 'Reviewed \\"中文\\" value', tags: ['part', 'fixture'], options: { units: 'mm' }, nullable: null };
  const tool = { ...fixtureTool, inputSchema: { ...fixtureTool.inputSchema,
    properties: { ...fixtureTool.inputSchema.properties, enabled: { type: 'boolean' }, count: { type: 'integer' }, note: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, options: { type: 'object' }, nullable: { type: 'null' } },
    required: ['script', ...Object.keys(fixedArguments)],
  } };
  const fixture = await legacyFixture(t, { list: () => ({ tools: [tool] }), call: neverExecute });
  const profile = await profileFile(directory, fixture.url), fixed = await fixedFile(directory, fixedArguments);
  const result = await cli([...enrollArgs(profile, tool), '--fixed-arguments-file', fixed], directory);
  assert.equal(result.code, 0, result.stderr);
  const enrolled = JSON.parse(await readFile(profile.filename, 'utf8'));
  assert.deepEqual(enrolled.desktop.mapping.fixedArguments, fixedArguments);
  assert.deepEqual(JSON.parse(result.stdout).enrolled.fixedArguments, fixedArguments);
  assert.equal(JSON.parse(result.stdout).live_qualified, false);
  assert.deepEqual(enrolled.policy, profile.profile.policy);
  noExecution(fixture);
});

function nestedFixedArguments(levels) {
  let options = 'reviewed-leaf';
  for (let level = 0; level < levels; level++) options = { value: options };
  return { language: 'python', options };
}
const nestedFixedTool = { ...fixtureTool, inputSchema: { ...fixtureTool.inputSchema,
  properties: { ...fixtureTool.inputSchema.properties, options: { type: 'object' } },
  required: ['script', 'language', 'options'],
} };

for (const levels of [29, 31]) test(`enrollment rejects ${levels}-level fixed values that exceed the complete profile or result bound before writing`, async t => {
  const directory = await workspace(t);
  const fixture = await legacyFixture(t, { list: () => ({ tools: [nestedFixedTool] }), call: neverExecute });
  const profile = await profileFile(directory, fixture.url);
  const fixed = await fixedFile(directory, nestedFixedArguments(levels));
  const result = await cli([...enrollArgs(profile, nestedFixedTool), '--fixed-arguments-file', fixed], directory);
  noExecution(fixture);
  rejected(result, 'INPUT_LIMIT');
  assert.deepEqual(await readFile(profile.filename), profile.bytes, 'Rejected enrollment must not persist a profile that later fails hashing.');
  assert.equal(profileHash(await loadProfile(profile.filename)), profileHash(profile.profile));
  assert.equal(fixture.sessionDeleted, true);
});

test('enrollment preserves the deepest admitted fixed values in a reloadable hashable profile', async t => {
  const directory = await workspace(t);
  const fixture = await legacyFixture(t, { list: () => ({ tools: [nestedFixedTool] }), call: neverExecute });
  const profile = await profileFile(directory, fixture.url), fixedArguments = nestedFixedArguments(28);
  const fixed = await fixedFile(directory, fixedArguments);
  const result = await cli([...enrollArgs(profile, nestedFixedTool), '--fixed-arguments-file', fixed], directory);
  assert.equal(result.code, 0, result.stderr);
  const enrolled = await loadProfile(profile.filename);
  assert.deepEqual(enrolled.desktop.mapping.fixedArguments, fixedArguments);
  assert.match(profileHash(enrolled), /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(result.stdout).enrolled.fixedArguments, fixedArguments);
  assert.deepEqual(enrolled.policy, profile.profile.policy);
  noExecution(fixture);
});

test('native enrollment persists the explicitly discovered endpoint and does not contact the previous endpoint', async t => {
  const directory = await workspace(t);
  const options = { list: () => ({ tools: [simpleTool] }), call: neverExecute };
  const previous = await legacyFixture(t, options), selected = await legacyFixture(t, options);
  const profile = await profileFile(directory, previous.url);
  const result = await cli([...enrollArgs(profile), '--url', selected.url], directory);
  assert.equal(result.code, 0, result.stderr);
  const enrolled = JSON.parse(await readFile(profile.filename, 'utf8'));
  assert.equal(enrolled.desktop.url, selected.url);
  assert.equal(enrolled.desktop.provider, 'native');
  assert.equal(enrolled.desktop.timeoutMs, profile.profile.desktop.timeoutMs);
  assert.deepEqual(enrolled.policy, profile.profile.policy);
  assert.deepEqual(previous.requests, []);
  assert.ok(selected.requests.some(request => request.method === 'tools/list'));
  assert.equal(selected.sessionDeleted, true);
  noExecution(previous); noExecution(selected);
});

for (const provider of ['addin', 'fixture']) for (const command of ['native-enroll', 'native-discover']) test(`${command} rejects a ${provider} profile before contacting its endpoint`, async t => {
  const directory = await workspace(t);
  const fixture = await legacyFixture(t, { list: () => ({ tools: [simpleTool] }), call: neverExecute });
  const override = provider === 'addin'
    ? { desktop: { provider: 'addin', url: fixture.url, tokenFile: path.join(directory, 'never-read-token.json') } }
    : { mode: 'fixture' };
  const profile = await profileFile(directory, fixture.url, override);
  const args = command === 'native-enroll' ? enrollArgs(profile) : [command, '--profile', profile.filename, '--url', fixture.url];
  rejected(await cli(args, directory), 'NATIVE_PROFILE_REQUIRED');
  assert.deepEqual(fixture.requests, []);
  assert.deepEqual(await readFile(profile.filename), profile.bytes);
  noExecution(fixture);
});

test('native enrollment requires a profile and all selection fields before discovery', async t => {
  const directory = await workspace(t);
  const fixture = await legacyFixture(t, { list: () => ({ tools: [simpleTool] }), call: neverExecute });
  const profile = await profileFile(directory, fixture.url);
  rejected(await cli(['native-enroll', '--url', fixture.url, '--tool', simpleTool.name, '--argument', 'script', '--hash', schemaFingerprint(simpleTool)], directory), 'CLI_ARGUMENT_REQUIRED');
  rejected(await cli(['native-enroll', '--profile', profile.filename, '--tool', simpleTool.name, '--hash', schemaFingerprint(simpleTool)], directory), 'CLI_ARGUMENT_REQUIRED');
  assert.deepEqual(fixture.requests, []);
  assert.deepEqual(await readFile(profile.filename), profile.bytes);
});

test('native enrollment does not infer missing required values or inherit a previous mapping', async t => {
  const directory = await workspace(t);
  const fixture = await legacyFixture(t, { call: neverExecute });
  const profile = await profileFile(directory, fixture.url, { desktop: {
    provider: 'native', url: fixture.url,
    mapping: { tool: fixtureTool.name, argument: 'script', schemaHash: schemaFingerprint(fixtureTool), fixedArguments: { language: 'python' } },
  } });
  rejected(await cli(enrollArgs(profile, fixtureTool), directory), 'INVALID_ENROLLMENT');
  assert.deepEqual(await readFile(profile.filename), profile.bytes);
  noExecution(fixture);
  assert.equal(fixture.sessionDeleted, true);
});

test('schema drift rejects fixed-argument enrollment without changing the profile', async t => {
  const directory = await workspace(t);
  const fixture = await legacyFixture(t, { call: neverExecute });
  const profile = await profileFile(directory, fixture.url), fixed = await fixedFile(directory);
  const args = enrollArgs(profile, fixtureTool); args[args.indexOf('--hash') + 1] = '0'.repeat(64);
  rejected(await cli([...args, '--fixed-arguments-file', fixed], directory), 'SCHEMA_DRIFT');
  assert.deepEqual(await readFile(profile.filename), profile.bytes);
  noExecution(fixture);
  assert.equal(fixture.sessionDeleted, true);
});

const invalidInputs = [
  ['invalid JSON', '{', 'INVALID_INPUT'],
  ['invalid UTF-8', Buffer.from([0x7b, 0xff, 0x7d]), 'INVALID_INPUT'],
  ['array', '[]', 'INVALID_INPUT'],
  ['null', 'null', 'INVALID_INPUT'],
  ['scalar', '"python"', 'INVALID_INPUT'],
  ['script override', { language: 'python', script: 'never execute this string' }, 'INVALID_ENROLLMENT'],
  ['reserved key', '{"language":"python","__proto__":{"polluted":true}}', 'INVALID_INPUT'],
  ['nested reserved key', { language: 'python', options: { constructor: 'forbidden' } }, 'INVALID_INPUT'],
  ['NUL', { language: 'py\0thon' }, 'INVALID_INPUT'],
  ['nonfinite number', '{"language":"python","number":1e309}', 'INVALID_INPUT'],
  ['excessive nesting', '{"nested":'.repeat(34) + 'null' + '}'.repeat(34), 'INPUT_LIMIT'],
  ['oversized bytes', { language: 'python', extra: 'x'.repeat(65_536) }, 'UNTRUSTED_ASSET'],
];
for (const [name, data, code] of invalidInputs) test(`fixed-argument ${name} is rejected before native discovery`, async t => {
  const directory = await workspace(t);
  const fixture = await legacyFixture(t, { call: neverExecute });
  const profile = await profileFile(directory, fixture.url), fixed = await fixedFile(directory, data);
  rejected(await cli([...enrollArgs(profile, fixtureTool), '--fixed-arguments-file', fixed], directory), code);
  assert.deepEqual(fixture.requests, []);
  assert.deepEqual(await readFile(profile.filename), profile.bytes);
  noExecution(fixture);
});

test('fixed-argument paths must be absolute regular files without aliases', async t => {
  const directory = await workspace(t);
  const fixture = await legacyFixture(t, { call: neverExecute });
  const profile = await profileFile(directory, fixture.url), fixed = await fixedFile(directory);
  rejected(await cli([...enrollArgs(profile, fixtureTool), '--fixed-arguments-file', path.basename(fixed)], directory), 'UNTRUSTED_ASSET');
  rejected(await cli([...enrollArgs(profile, fixtureTool), '--fixed-arguments-file', directory], directory), 'UNTRUSTED_ASSET');
  const alias = path.join(directory, 'fixed hard link.json'); await link(fixed, alias);
  rejected(await cli([...enrollArgs(profile, fixtureTool), '--fixed-arguments-file', alias], directory), 'UNTRUSTED_ASSET');
  if (process.platform !== 'win32') {
    const symbolic = path.join(directory, 'fixed symbolic link.json'); await symlink(fixed, symbolic);
    rejected(await cli([...enrollArgs(profile, fixtureTool), '--fixed-arguments-file', symbolic], directory), 'UNTRUSTED_ASSET');
  }
  assert.deepEqual(fixture.requests, []);
  assert.deepEqual(await readFile(profile.filename), profile.bytes);
});

test('fixed-argument files are not silently ignored by native-discover', async t => {
  const directory = await workspace(t);
  const fixture = await legacyFixture(t, { call: neverExecute });
  rejected(await cli(['native-discover', '--url', fixture.url, '--fixed-arguments-file', path.join(directory, 'never-read.json')], directory), 'INVALID_INPUT');
  assert.deepEqual(fixture.requests, []);
});

for (const change of ['settings', 'formatting', 'replacement']) test(`native enrollment preserves a profile ${change} change made during discovery`, async t => {
  const directory = await workspace(t);
  let profile, changed;
  const fixture = await legacyFixture(t, { call: neverExecute, list: async (_cursor, count) => {
    if (count === 1) {
      changed = change === 'settings'
        ? Buffer.from(JSON.stringify({ ...profile.profile, policy: { ...profile.profile.policy, readDocuments: ['newer-owner-scope'] } }) + '\n')
        : change === 'formatting' ? Buffer.concat([profile.bytes, Buffer.from('\n')]) : profile.bytes;
      if (change === 'replacement') {
        const replacement = path.join(directory, 'replacement.json');
        await writeFile(replacement, changed, { flag: 'wx', mode: 0o600 });
        await rename(replacement, profile.filename);
      } else await writeFile(profile.filename, changed);
    }
    return { tools: [simpleTool] };
  } });
  profile = await profileFile(directory, fixture.url);
  rejected(await cli(enrollArgs(profile), directory), 'PROFILE_CHANGED');
  assert.ok(changed);
  assert.deepEqual(await readFile(profile.filename), changed);
  noExecution(fixture);
  assert.equal(fixture.sessionDeleted, true);
});

for (const alias of ['hard link', 'symbolic link']) test(`native enrollment never overwrites a profile replaced with a ${alias} during discovery`, { skip: alias === 'symbolic link' && process.platform === 'win32' ? 'Windows symbolic links require separately administered privileges.' : false }, async t => {
  const directory = await workspace(t);
  let profile;
  const target = path.join(directory, 'newer profile.json'), saved = path.join(directory, 'original profile.json');
  const targetBytes = Buffer.from('{"newer_owner_content":"must remain unchanged"}\n');
  await writeFile(target, targetBytes, { flag: 'wx', mode: 0o600 });
  const fixture = await legacyFixture(t, { call: neverExecute, list: async (_cursor, count) => {
    if (count === 1) {
      await rename(profile.filename, saved);
      if (alias === 'hard link') await link(target, profile.filename); else await symlink(target, profile.filename);
    }
    return { tools: [simpleTool] };
  } });
  profile = await profileFile(directory, fixture.url);
  rejected(await cli(enrollArgs(profile), directory), 'UNTRUSTED_ASSET');
  assert.deepEqual(await readFile(target), targetBytes);
  assert.deepEqual(await readFile(saved), profile.bytes);
  noExecution(fixture);
  assert.equal(fixture.sessionDeleted, true);
});

test('native enrollment help explains reviewed fixed values and the qualification boundary', async t => {
  const directory = await workspace(t);
  const result = await cli(['--help'], directory);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /--fixed-arguments-file/);
  assert.match(result.stdout, /64 KiB/);
  assert.match(result.stdout, /never inferred/);
  assert.match(result.stdout, /does not qualify/i);
});
