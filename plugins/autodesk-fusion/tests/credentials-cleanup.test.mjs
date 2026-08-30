import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NativeTokenStore, ApsPkceClient, FusionError, hash, APS_ORIGIN } from '../dist/index.mjs';

// Protocol doubles qualify cleanup/retry behavior, not an OS backend. The separate
// native-credentials.test.mjs has an explicit opt-in for real synthetic vault entries.
const grant = suffix => ({ accessToken: `SYNTHETIC_ACCESS_${suffix}_`.repeat(120), refreshToken: `SYNTHETIC_REFRESH_${suffix}`, obtainedAt: 1, expiresAt: 100, scopes: ['data:read'], tenantId: 'fixture', issuer: APS_ORIGIN, resource: APS_ORIGIN, grantType: 'authorization_code' });
async function fixture(t) {
  const lockRoot = await mkdtemp(path.join(os.tmpdir(), 'fusion-vault-cleanup-'));
  t.after(() => rm(lockRoot, { recursive: true, force: true }));
  const values = new Map(), calls = [], key = hash(lockRoot);
  const controls = { deniedDelete: () => false, deniedRead: () => false, leavePresent: () => false, failWrite: () => false };
  const factory = (service, account) => {
    assert.equal(service, 'community-plugins.autodesk-fusion.aps.v1');
    assert.ok(account === key || account.startsWith(key + '.'));
    return {
      async getPassword() { if (controls.deniedRead(account)) throw new Error('PRIVATE_NATIVE_SECRET read denied'); return values.get(account) ?? null; },
      async setPassword(value) { if (controls.failWrite(account)) throw new Error('PRIVATE_NATIVE_SECRET write denied'); values.set(account, value); },
      async deleteCredential() { calls.push(account); if (controls.deniedDelete(account)) throw new Error('PRIVATE_NATIVE_SECRET delete denied'); return controls.leavePresent(account) ? false : values.delete(account); }
    };
  };
  const restart = () => new NativeTokenStore('/unused', factory, { lockRoot });
  const receiptPath = path.join(lockRoot, key, 'cleanup--generations.json');
  return { vault: restart(), restart, values, calls, controls, key, receiptPath, manifest: () => JSON.parse(values.get(key)) };
}
const cleanupError = error => error.code === 'CREDENTIAL_CLEANUP_INCOMPLETE' && error.outcome === 'partial' && !error.message.includes('PRIVATE_NATIVE_SECRET');

test('denied chunk deletion retains the manifest and a secret-free durable receipt for retry', async t => {
  const f = await fixture(t), original = grant('denied');
  await f.vault.set(f.key, original);
  const pointer = f.values.get(f.key), current = f.manifest();
  f.controls.deniedDelete = account => account.endsWith(`.${current.generation}.0`);
  await assert.rejects(f.vault.delete(f.key), cleanupError);
  assert.equal(f.values.get(f.key), pointer);
  assert.deepEqual(await f.vault.get(f.key), original);
  assert.equal(f.calls.includes(f.key), false, 'Current manifest cannot be removed before its chunks');
  const receipt = await readFile(f.receiptPath, 'utf8');
  assert.equal(receipt.includes('SYNTHETIC_'), false);
  assert.equal(JSON.parse(receipt).generations[0].generation, current.generation);
  f.controls.deniedDelete = () => false;
  await f.restart().delete(f.key);
  assert.equal(f.values.size, 0);
  await assert.rejects(readFile(f.receiptPath), { code: 'ENOENT' });
});

test('partial deletion is retryable across instances and NoEntry is idempotent, not a swallowed failure', async t => {
  const f = await fixture(t);
  await f.vault.set(f.key, grant('partial'));
  const current = f.manifest(), first = `${f.key}.${current.generation}.0`;
  f.controls.deniedDelete = account => account.endsWith(`.${current.generation}.1`);
  await assert.rejects(f.vault.delete(f.key), cleanupError);
  assert.equal(f.values.has(first), false);
  assert.equal(f.values.has(f.key), true);
  await assert.rejects(f.vault.get(f.key), { code: 'CREDENTIAL_STORE_CORRUPT' });
  f.controls.deniedDelete = () => false;
  await f.restart().delete(f.key);
  await f.restart().delete(f.key);
  assert.equal(f.values.size, 0);
  assert.ok(f.calls.filter(account => account === first).length >= 2);
});

test('denied manifest deletion cannot produce successful logout after chunks are gone', async t => {
  const f = await fixture(t);
  await f.vault.set(f.key, grant('manifest'));
  f.controls.deniedDelete = account => account === f.key;
  await assert.rejects(f.vault.delete(f.key), cleanupError);
  assert.deepEqual([...f.values.keys()], [f.key]);
  assert.equal((await f.vault.cleanupStatus(f.key)).trackedGenerations, 1);
  f.controls.deniedDelete = () => false;
  await f.restart().delete(f.key);
  assert.equal(f.values.size, 0);
});

test('a provider false result is insufficient when independent readback still finds the credential', async t => {
  const f = await fixture(t);
  await f.vault.set(f.key, grant('readback'));
  const current = f.manifest();
  f.controls.leavePresent = account => account.endsWith(`.${current.generation}.0`);
  await assert.rejects(f.vault.delete(f.key), cleanupError);
  assert.equal(f.values.has(f.key), true);
  f.controls.leavePresent = () => false;
  await f.vault.delete(f.key);
});

test('unavailable deletion readback preserves retry receipts and never logs the native error', async t => {
  const f = await fixture(t);
  await f.vault.set(f.key, grant('unreadable'));
  const current = f.manifest();
  f.controls.deniedRead = account => account.endsWith(`.${current.generation}.0`);
  await assert.rejects(f.vault.delete(f.key), cleanupError);
  assert.equal(f.values.has(f.key), true);
  assert.equal((await f.vault.cleanupStatus(f.key)).trackedGenerations, 1);
  f.controls.deniedRead = () => false;
  await f.restart().delete(f.key);
});

test('denied old-generation cleanup leaves a valid replacement and durable pending IDs for strict logout', async t => {
  const f = await fixture(t);
  await f.vault.set(f.key, grant('old'));
  const old = f.manifest();
  f.controls.deniedDelete = account => account.includes(`.${old.generation}.`);
  const replacement = grant('new');
  await f.vault.set(f.key, replacement);
  assert.deepEqual(await f.vault.get(f.key), replacement);
  assert.deepEqual(await f.restart().cleanupStatus(f.key), { trackedGenerations: 2, pendingRetiredGenerations: 1, currentManifestPresent: true, containsCredentialContents: false });
  const currentPointer = f.values.get(f.key);
  await assert.rejects(f.restart().delete(f.key), cleanupError);
  assert.equal(f.values.get(f.key), currentPointer);
  f.controls.deniedDelete = () => false;
  await f.restart().delete(f.key);
  assert.equal(f.values.size, 0);
});

test('failed chunk publication with denied rollback keeps exact orphan IDs without invalidating the prior grant', async t => {
  const f = await fixture(t), original = grant('original');
  await f.vault.set(f.key, original);
  const old = f.manifest();
  f.controls.failWrite = account => !account.includes(old.generation) && account.endsWith('.1');
  f.controls.deniedDelete = account => account !== f.key && !account.includes(old.generation);
  await assert.rejects(f.vault.set(f.key, grant('unfinished')), error => error.code === 'CREDENTIAL_STORE_UNAVAILABLE' && !error.message.includes('PRIVATE_NATIVE_SECRET'));
  assert.deepEqual(await f.vault.get(f.key), original);
  assert.equal((await f.restart().cleanupStatus(f.key)).pendingRetiredGenerations, 1);
  f.controls.failWrite = () => false; f.controls.deniedDelete = () => false;
  await f.restart().delete(f.key);
  assert.equal(f.values.size, 0);
});

test('cleanup rejects a corrupted receipt before deleting any known account', async t => {
  const f = await fixture(t);
  await f.vault.set(f.key, grant('corrupt'));
  const stored = JSON.parse(await readFile(f.receiptPath, 'utf8'));
  stored.generations[0].generation = '../../other-account';
  await writeFile(f.receiptPath, JSON.stringify(stored));
  await assert.rejects(f.vault.delete(f.key), { code: 'CREDENTIAL_STORE_CORRUPT' });
  assert.equal(f.calls.length, 0);
});

test('OAuth logout never claims localCredentialsRemoved when its store reports incomplete deletion', async () => {
  let removedCallback = false, deletionAttempted = false;
  const client = new ApsPkceClient({ clientId: 'synthetic-public-client', tenantId: 'fixture', scopes: ['data:read'], redirectUri: 'http://127.0.0.1:55431/callback', store: {
    async get() { throw new FusionError('REAUTHENTICATION_REQUIRED', 'Synthetic uncertain refresh.'); },
    async set() { assert.fail('Logout must not publish a new grant'); },
    async delete() { deletionAttempted = true; throw new FusionError('CREDENTIAL_CLEANUP_INCOMPLETE', 'Synthetic denied removal.', 'partial'); }
  }, async fetch() { assert.fail('No login or Autodesk request is authorized by this protocol test'); }, async onAccountRemoved() { removedCallback = true; } });
  await assert.rejects(client.revoke(), { code: 'CREDENTIAL_CLEANUP_INCOMPLETE', outcome: 'partial' });
  assert.equal(deletionAttempted, true);
  assert.equal(removedCallback, false);
});
