import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const { RecordStore, ensurePrivateDirectory, recoverDeadLease } = await import(process.env.FUSION_STORAGE_TEST_ENTRY ?? '../dist/index.mjs');
const execFileAsync = promisify(execFile);
const windowsOnly = { skip: process.platform !== 'win32' ? 'Requires real Windows ACL and reparse-point behavior; no platform spoofing.' : false };
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fusion-storage-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return realpath(directory);
}
async function windowsAcl(filename, action = 'inspect', rights = 'ReadAndExecute') {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$name = $env:FUSION_STORAGE_TEST_PATH
$acl = Get-Acl -LiteralPath $name
if ($env:FUSION_STORAGE_TEST_ACTION -eq 'add-everyone') {
  $sid = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
  $item = Get-Item -LiteralPath $name -Force
  $inherit = if ($item.PSIsContainer) { [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [System.Security.AccessControl.InheritanceFlags]::None }
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, $env:FUSION_STORAGE_TEST_RIGHTS, $inherit, 'None', 'Allow'))
  Set-Acl -LiteralPath $name -AclObject $acl
  $acl = Get-Acl -LiteralPath $name
}
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { @{sid=$_.IdentityReference.Value; type=$_.AccessControlType.ToString(); rights=[int]$_.FileSystemRights; inherited=$_.IsInherited; inheritance=$_.InheritanceFlags.ToString()} })
@{current=$current; owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; protected=$acl.AreAccessRulesProtected; sddl=$acl.Sddl; rules=$rules} | ConvertTo-Json -Depth 5 -Compress
`;
  const { stdout } = await execFileAsync(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: { ...process.env, FUSION_STORAGE_TEST_PATH: filename, FUSION_STORAGE_TEST_ACTION: action, FUSION_STORAGE_TEST_RIGHTS: rights }, timeout: 15_000, maxBuffer: 32_768, windowsHide: true });
  return JSON.parse(stdout);
}

test('private record storage preserves Unicode data, atomic replacement and leases', async t => {
  const base = await fixture(t);
  const store = new RecordStore(path.join(base, 'private', 'state'));
  await store.put('plan', 'sample', { label: 'pièce 日本語', revision: 1 });
  await store.put('plan', 'sample', { label: 'pièce 日本語', revision: 2 });
  assert.deepEqual(await store.get('plan', 'sample'), { label: 'pièce 日本語', revision: 2 });
  assert.equal((await store.list('plan')).length, 1);
  assert.equal(await store.get('plan', 'missing'), undefined);
  const release = await store.acquireLease();
  await assert.rejects(store.acquireLease(), error => error.code === 'EXECUTION_LOCKED');
  await assert.rejects(recoverDeadLease(store.root), error => error.code === 'LOCK_OWNER_RUNNING');
  await release();
  await (await store.acquireLease())();
});

test('record reads reject hardlinked state without consuming the referenced bytes', async t => {
  const base = await fixture(t);
  const store = new RecordStore(path.join(base, 'state'));
  const outside = path.join(base, 'outside.json');
  await store.put('plan', 'linked', { untrusted: true });
  await link(path.join(store.root, 'plan--linked.json'), outside);
  await assert.rejects(store.get('plan', 'linked'), error => error.code === 'UNSAFE_RECORD');
  assert.deepEqual(JSON.parse(await readFile(outside, 'utf8')), { untrusted: true });
});

test('the complete on-disk byte limit is checked before replacement', async t => {
  const base = await fixture(t);
  const store = new RecordStore(path.join(base, 'state'));
  await store.put('plan', 'bounded', { original: true });
  const maximum = 16_777_216;
  const overhead = Buffer.byteLength(JSON.stringify({ body: '' }));
  // This JSON alone fits the old limit exactly, but its trailing newline does
  // not. A rejected replacement must not destroy the existing good record.
  await assert.rejects(store.put('plan', 'bounded', { body: 'x'.repeat(maximum - overhead) }), error => error.code === 'RECORD_TOO_LARGE');
  assert.deepEqual(await store.get('plan', 'bounded'), { original: true });
  const body = 'x'.repeat(maximum - overhead - 1);
  await store.put('plan', 'bounded', { body });
  assert.equal((await lstat(path.join(store.root, 'plan--bounded.json'))).size, maximum);
  const stored = await store.get('plan', 'bounded');
  const digest = value => createHash('sha256').update(value).digest('hex');
  assert.equal(digest(stored.body), digest(body));
});

test('existing POSIX shared roots are rejected without changing permissions', { skip: process.platform === 'win32' ? 'POSIX permission-bit contract; Windows has ACL cases below.' : false }, async t => {
  const base = await fixture(t);
  const shared = path.join(base, 'shared');
  await mkdir(shared, { mode: 0o755 }); await chmod(shared, 0o755);
  await assert.rejects(ensurePrivateDirectory(shared), error => error.code === 'UNSAFE_PATH');
  assert.equal((await lstat(shared)).mode & 0o777, 0o755);
});

test('POSIX root symlinks remain rejected', { skip: process.platform === 'win32' ? 'Windows junctions are covered separately.' : false }, async t => {
  const base = await fixture(t);
  const target = path.join(base, 'target'); await mkdir(target, { mode: 0o700 });
  const alias = path.join(base, 'alias'); await symlink(target, alias);
  await assert.rejects(ensurePrivateDirectory(alias), error => error.code === 'UNSAFE_PATH');
});

test('new Windows roots have protected inheritable private ACLs, including literal path punctuation', windowsOnly, async t => {
  const base = await fixture(t);
  const root = path.join(base, "private '$name` [literal]", 'nested');
  await ensurePrivateDirectory(root);
  for (const directory of [path.dirname(root), root]) {
    const acl = await windowsAcl(directory);
    assert.equal(acl.owner, acl.current);
    assert.equal(acl.protected, true);
    const allowed = new Set([acl.current, 'S-1-5-18', 'S-1-5-32-544']);
    assert.ok(acl.rules.some(rule => rule.sid === acl.current && rule.inheritance.includes('ObjectInherit') && rule.inheritance.includes('ContainerInherit')));
    assert.ok(acl.rules.filter(rule => rule.type === 'Allow').every(rule => allowed.has(rule.sid)));
  }
});

test('existing Windows roots with other-user read access fail without ACL repair', windowsOnly, async t => {
  const base = await fixture(t);
  const root = await ensurePrivateDirectory(path.join(base, 'state'));
  const shared = await windowsAcl(root, 'add-everyone');
  await assert.rejects(ensurePrivateDirectory(root), error => error.code === 'ACL_UNVERIFIED');
  assert.equal((await windowsAcl(root)).sddl, shared.sddl);
});

test('Windows creation remains private under a readable but nonreplaceable parent', windowsOnly, async t => {
  const base = await fixture(t);
  const parent = await ensurePrivateDirectory(path.join(base, 'readable-parent'));
  const readable = await windowsAcl(parent, 'add-everyone');
  const root = await ensurePrivateDirectory(path.join(parent, 'new-private-state'));
  const acl = await windowsAcl(root);
  assert.equal(acl.protected, true);
  assert.ok(acl.rules.filter(rule => rule.type === 'Allow').every(rule => [acl.current, 'S-1-5-18', 'S-1-5-32-544'].includes(rule.sid)));
  assert.equal((await windowsAcl(parent)).sddl, readable.sddl);
});

test('Windows roots under a replaceable ancestor are rejected without changing that ancestor', windowsOnly, async t => {
  const base = await fixture(t);
  const parent = await ensurePrivateDirectory(path.join(base, 'replaceable'));
  const root = await ensurePrivateDirectory(path.join(parent, 'state'));
  const shared = await windowsAcl(parent, 'add-everyone', 'DeleteSubdirectoriesAndFiles');
  await assert.rejects(ensurePrivateDirectory(root), error => error.code === 'ACL_UNVERIFIED');
  assert.equal((await windowsAcl(parent)).sddl, shared.sddl);
});

test('Windows state ACL changes after initialization fail before record reads or writes', windowsOnly, async t => {
  const base = await fixture(t);
  const store = new RecordStore(path.join(base, 'state'));
  await store.put('plan', 'existing', { marker: 'private-ledger' });
  const filename = path.join(store.root, 'plan--existing.json');
  const acl = await windowsAcl(filename, 'add-everyone', 'Read');
  await assert.rejects(store.get('plan', 'existing'), error => error.code === 'ACL_UNVERIFIED');
  await assert.rejects(store.put('plan', 'existing', { marker: 'must-not-write' }), error => error.code === 'ACL_UNVERIFIED');
  assert.equal((await windowsAcl(filename)).sddl, acl.sddl);
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).marker, 'private-ledger');
});

test('Windows root ACL drift after initialization cannot expose new state', windowsOnly, async t => {
  const base = await fixture(t);
  const store = new RecordStore(path.join(base, 'state')); await store.init();
  await windowsAcl(store.root, 'add-everyone');
  await assert.rejects(store.put('plan', 'new', { marker: 'must-not-write' }), error => error.code === 'ACL_UNVERIFIED');
  await assert.rejects(lstat(path.join(store.root, 'plan--new.json')), error => error.code === 'ENOENT');
});

test('Windows junction roots and junction ancestors are rejected before creation', windowsOnly, async t => {
  const base = await fixture(t);
  const actual = await ensurePrivateDirectory(path.join(base, 'actual'));
  const alias = path.join(base, 'junction');
  // Creating a directory junction does not require symbolic-link privilege.
  await symlink(actual, alias, 'junction');
  for (const target of [alias, path.join(alias, 'would-escape')]) await assert.rejects(ensurePrivateDirectory(target), error => ['ACL_UNVERIFIED', 'UNSAFE_PATH'].includes(error.code));
  await assert.rejects(lstat(path.join(actual, 'would-escape')), error => error.code === 'ENOENT');
});

test('Windows junction state entries cannot be read, overwritten or recovered as locks', windowsOnly, async t => {
  const base = await fixture(t);
  const store = new RecordStore(path.join(base, 'state')); await store.init();
  const outside = await ensurePrivateDirectory(path.join(base, 'outside'));
  await symlink(outside, path.join(store.root, 'plan--linked.json'), 'junction');
  await symlink(outside, path.join(store.root, '.execution.lock'), 'junction');
  await assert.rejects(store.get('plan', 'linked'), error => ['ACL_UNVERIFIED', 'UNSAFE_RECORD'].includes(error.code));
  await assert.rejects(store.put('plan', 'linked', { marker: 'must-not-write' }), error => ['ACL_UNVERIFIED', 'UNSAFE_RECORD'].includes(error.code));
  await assert.rejects(recoverDeadLease(store.root), error => ['ACL_UNVERIFIED', 'UNSAFE_RECORD'].includes(error.code));
  assert.equal((await lstat(outside)).isDirectory(), true);
});

test('Windows hardlinked destinations are rejected before replacement', windowsOnly, async t => {
  const base = await fixture(t);
  const store = new RecordStore(path.join(base, 'state'));
  await store.put('plan', 'linked', { marker: 'original' });
  const filename = path.join(store.root, 'plan--linked.json');
  const outside = path.join(base, 'retained-alias.json');
  await link(filename, outside);
  await assert.rejects(store.put('plan', 'linked', { marker: 'must-not-write' }), error => error.code === 'UNSAFE_RECORD');
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).marker, 'original');
  assert.equal(JSON.parse(await readFile(outside, 'utf8')).marker, 'original');
});

test('Windows root replacement after initialization is detected before ledger access', windowsOnly, async t => {
  const base = await fixture(t);
  const store = new RecordStore(path.join(base, 'state'));
  await store.put('plan', 'original', { marker: 'original' });
  await rename(store.root, path.join(base, 'old-state'));
  await ensurePrivateDirectory(store.root);
  await assert.rejects(store.get('plan', 'original'), error => error.code === 'UNSAFE_PATH');
  await assert.rejects(store.put('plan', 'replacement', {}), error => error.code === 'UNSAFE_PATH');
});

test('Windows lease release refuses to remove a replacement lock', windowsOnly, async t => {
  const base = await fixture(t);
  const store = new RecordStore(path.join(base, 'state'));
  const release = await store.acquireLease();
  const filename = path.join(store.root, '.execution.lock');
  await rename(filename, path.join(store.root, 'held-lock.json'));
  await writeFile(filename, JSON.stringify({ pid: process.pid, replacement: true }));
  await assert.rejects(release(), error => error.code === 'UNSAFE_RECORD');
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).replacement, true);
});
