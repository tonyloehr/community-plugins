import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPinnedSource } from '../scripts/build-native.mjs';
import { verifyNativeDistribution } from '../scripts/verify-native.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fusion-native-receipt-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const native = path.join(directory, 'native');
  await mkdir(path.join(native, 'receipts'), { recursive: true }); await mkdir(path.join(directory, 'docs'));
  await cp(path.join(root, 'native', 'source'), path.join(native, 'source'), { recursive: true });
  for (const name of ['source-manifest.json', 'community-credential-errors.patch']) await cp(path.join(root, 'native', name), path.join(native, name));
  const source = await readPinnedSource(directory);
  const sourceFiles = Object.fromEntries(source.files.map(file => [file.path, file.sha256]));
  // An inert synthetic header verifies receipt logic only. It is never loaded,
  // used as a credential backend, shipped, or represented as an actual ABI test.
  const bytes = Buffer.alloc(512); bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(0x0100000c, 4);
  const filename = 'keyring.darwin-arm64.node';
  const record = { schema: 1, kind: 'community-source-native-build', platform: 'darwin', arch: 'arm64', target: 'aarch64-apple-darwin', upstream_commit: 'e46be75c3ba8d5fde6b88a17c6153b87ffe4b946', source_tree_sha256: source.identity, source_manifest_sha256: source.manifestHash, community_patch_sha256: source.patchHash, cargo_lock_sha256: sourceFiles['Cargo.lock'], source_files: sourceFiles, rust_toolchain: { version: '1.98.0', compiler_sha256: hash('synthetic compiler'), cargo_sha256: hash('synthetic cargo'), rustc_verbose: 'release: 1.98.0' }, smoke_test: { kind: 'module-load-export-shape', passed: true, credential_accessed: false }, path_remapping: { enabled: true }, output: { filename, sha256: hash(bytes), size_bytes: bytes.length }, ci: { repository: null, commit: null, run_id: null } };
  const receiptPath = path.join(native, 'receipts', filename.replace('.node', '.build.json'));
  const inventoryPath = path.join(directory, 'docs', 'native-dependencies.json');
  const notices = 'Synthetic non-distributed license metadata test.\n'.repeat(30);
  const inventory = { schema: 1, fixture: true, independent_source_build: {
    cargo_lock_sha256: sourceFiles['Cargo.lock'],
    build_metadata: { source_manifest_path: 'native/source-manifest.json', source_manifest_sha256: source.manifestHash, source_manifest_and_packaged_inputs_verified: true, source_manifest: JSON.parse(await readFile(path.join(native, 'source-manifest.json'), 'utf8')), toolchain_inputs: { toolchain: '1.98.0' } },
    resolved_license_text_collection_complete: true, registry_archive_checksums_verified: true, unresolved_packages: [], rust_toolchain_notices_provided: true,
    rust_runtime_notice_source_commit: '88d9e12ae178fab0fb5cc050a94da85685d449ea'
  }, notice_artifact: { path: 'native/UPSTREAM_NOTICES.txt', sha256: hash(notices), bytes: Buffer.byteLength(notices) } };
  await writeFile(path.join(native, filename), bytes);
  await writeFile(receiptPath, JSON.stringify(record));
  await writeFile(path.join(native, 'UPSTREAM_NOTICES.txt'), notices);
  await writeFile(inventoryPath, JSON.stringify(inventory));
  return { directory, native, filename, bytes, record, receiptPath, inventory, inventoryPath };
}

test('native receipt checks bind an inert target header to exact source/patch/lock and declared evidence', async t => {
  const f = await fixture(t);
  const manifest = await verifyNativeDistribution(f.directory);
  assert.equal(manifest.assets.length, 1);
  assert.equal(manifest.assets[0].sha256, hash(f.bytes));
  assert.match(manifest.limitation, /not builder authentication/);
});

test('unreceipted native additions and a mismatched binary target are rejected', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.native, 'keyring.darwin-x64.node'), f.bytes);
  await assert.rejects(verifyNativeDistribution(f.directory), /do not match exactly/);
  await rm(path.join(f.native, 'keyring.darwin-x64.node'));
  const wrong = Buffer.from(f.bytes); wrong.writeUInt32LE(0x01000007, 4);
  await writeFile(path.join(f.native, f.filename), wrong); f.record.output.sha256 = hash(wrong);
  await writeFile(f.receiptPath, JSON.stringify(f.record));
  await assert.rejects(verifyNativeDistribution(f.directory), /Mach-O target/);
});

test('nested, differently cased and renamed extra native files cannot bypass admission', async t => {
  const f = await fixture(t);
  const nested = path.join(f.native, 'retained-upstream');
  await mkdir(nested); await writeFile(path.join(nested, 'original.node'), f.bytes);
  await assert.rejects(verifyNativeDistribution(f.directory), /unexpected file, directory or link/);
  await rm(nested, { recursive: true });
  for (const name of ['original.NODE', 'original.dll', 'keyring.darwin-x64.NODE']) {
    const filename = path.join(f.native, name);
    await writeFile(filename, f.bytes);
    await assert.rejects(verifyNativeDistribution(f.directory), /unexpected file, directory or link/);
    await rm(filename);
  }
  await writeFile(path.join(f.native, 'source', 'original.node'), f.bytes);
  await assert.rejects(verifyNativeDistribution(f.directory), /exactly the nine pinned files/);
});

test('license text bytes and structured inventory bindings cannot be replaced with unrelated evidence', async t => {
  const f = await fixture(t);
  const original = JSON.stringify(f.inventory);
  const noticesPath = path.join(f.native, 'UPSTREAM_NOTICES.txt');
  const notices = await readFile(noticesPath);
  await writeFile(noticesPath, 'unrelated filler '.repeat(100));
  await assert.rejects(verifyNativeDistribution(f.directory), /notices\/inventory/);
  await writeFile(noticesPath, notices);
  const mutations = [
    x => { x.unrelated_old_lock = x.independent_source_build.cargo_lock_sha256; x.independent_source_build.cargo_lock_sha256 = '0'.repeat(64); },
    x => { x.independent_source_build.build_metadata.source_manifest_sha256 = '0'.repeat(64); },
    x => { x.independent_source_build.build_metadata.source_manifest.files[0].sha256 = '0'.repeat(64); },
    x => { x.independent_source_build.unresolved_packages = ['uncollected-crate']; },
    x => { delete x.independent_source_build.unresolved_packages; },
    x => { x.independent_source_build.rust_toolchain_notices_provided = false; },
    x => { x.independent_source_build.rust_runtime_notice_source_commit = '0'.repeat(40); },
    x => { x.notice_artifact.path = 'other/UPSTREAM_NOTICES.txt'; },
    x => { x.notice_artifact.bytes += 1; },
    x => { x.notice_artifact.sha256 = '0'.repeat(64); }
  ];
  for (const mutate of mutations) {
    const invalid = JSON.parse(original); mutate(invalid);
    await writeFile(f.inventoryPath, JSON.stringify(invalid));
    await assert.rejects(verifyNativeDistribution(f.directory), /notices\/inventory/);
  }
});

test('native bytes, source trees and compiler provenance cannot drift under an old receipt', async t => {
  const f = await fixture(t);
  const altered = Buffer.from(f.bytes); altered[255] = 1;
  await writeFile(path.join(f.native, f.filename), altered);
  await assert.rejects(verifyNativeDistribution(f.directory), /bytes differ/);
  await writeFile(path.join(f.native, f.filename), f.bytes);
  f.record.source_tree_sha256 = '0'.repeat(64); await writeFile(f.receiptPath, JSON.stringify(f.record));
  await assert.rejects(verifyNativeDistribution(f.directory), /different source/);
  f.record.source_tree_sha256 = (await readPinnedSource(f.directory)).identity;
  f.record.rust_toolchain.compiler_sha256 = 'unverified'; await writeFile(f.receiptPath, JSON.stringify(f.record));
  await assert.rejects(verifyNativeDistribution(f.directory), /compiler provenance/);
});

test('missing load evidence, private-path leakage and incomplete license collection block distribution', async t => {
  const f = await fixture(t);
  f.record.smoke_test.passed = false; await writeFile(f.receiptPath, JSON.stringify(f.record));
  await assert.rejects(verifyNativeDistribution(f.directory), /load\/remapping evidence/);
  f.record.smoke_test.passed = true; f.record.note = '/home/synthetic-user/build';
  await writeFile(f.receiptPath, JSON.stringify(f.record));
  await assert.rejects(verifyNativeDistribution(f.directory), /private filesystem prefix/);
  delete f.record.note; await writeFile(f.receiptPath, JSON.stringify(f.record));
  f.inventory.independent_source_build.resolved_license_text_collection_complete = false;
  await writeFile(f.inventoryPath, JSON.stringify(f.inventory));
  await assert.rejects(verifyNativeDistribution(f.directory), /notices\/inventory/);
});
