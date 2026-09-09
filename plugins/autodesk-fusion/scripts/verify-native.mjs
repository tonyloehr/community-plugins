// Build/release verification only. Runtime never executes a compiler or trusts
// downloaded receipts as authentication. A reviewer must obtain candidates from
// the exact reviewed CI run (or an independently observed local source build).
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readPinnedSource, hostBuild, assertNoPrivatePaths, RUST_TOOLCHAIN } from './build-native.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
async function regular(filename, maximum = 2_097_152) {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size < 1 || metadata.size > maximum) throw new Error('Native distribution input is not a bounded ordinary file.');
  const bytes = await readFile(filename);
  if (bytes.length !== metadata.size) throw new Error('Native distribution input changed while reading.');
  return bytes;
}
function assertBinaryTarget(bytes, platform, arch) {
  if (bytes.length < 256) throw new Error('Native module is too small.');
  if (platform === 'darwin') {
    if (bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== (arch === 'arm64' ? 0x0100000c : 0x01000007)) throw new Error('Native Mach-O target does not match its receipt.');
  } else if (platform === 'linux') {
    if (bytes.subarray(0, 4).toString('hex') !== '7f454c46' || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== (arch === 'arm64' ? 183 : 62)) throw new Error('Native ELF target does not match its receipt.');
  } else {
    const pe = bytes.readUInt32LE(0x3c);
    if (bytes.subarray(0, 2).toString() !== 'MZ' || pe < 64 || pe > bytes.length - 24 || bytes.readUInt32LE(pe) !== 0x00004550 || bytes.readUInt16LE(pe + 4) !== (arch === 'arm64' ? 0xaa64 : 0x8664) || !(bytes.readUInt16LE(pe + 22) & 0x2000)) throw new Error('Native PE DLL target does not match its receipt.');
  }
}

export async function verifyNativeDistribution(root) {
  const native = path.join(root, 'native');
  const nativeMetadata = await lstat(native);
  if (!nativeMetadata.isDirectory() || nativeMetadata.isSymbolicLink()) throw new Error('Native distribution root must be an ordinary directory.');
  const nativeEntries = await readdir(native, { withFileTypes: true });
  const allowedFiles = new Set(['source-manifest.json', 'community-credential-errors.patch', 'UPSTREAM_NOTICES.txt', 'build-manifest.json']);
  for (const entry of nativeEntries) {
    if (entry.isDirectory() && ['source', 'receipts'].includes(entry.name)) continue;
    if (entry.isFile() && (allowedFiles.has(entry.name) || /^keyring\.(darwin-(?:arm64|x64)|linux-(?:arm64|x64)-gnu|win32-(?:arm64|x64)-msvc)\.node$/u.test(entry.name))) continue;
    throw new Error('Native distribution contains an unexpected file, directory or link; only declared source and receipted binaries may be shipped.');
  }
  // readPinnedSource recursively requires the exact nine source inputs. The
  // receipt directory below must also match exactly. A strict tree prevents
  // nested, differently cased or renamed upstream modules escaping validation.
  const source = await readPinnedSource(root);
  const entries = nativeEntries.filter(entry => entry.name.endsWith('.node'));
  if (!entries.length || entries.length > 6 || entries.some(entry => !entry.isFile())) throw new Error('At least one reviewed source-built native module is required; no unreceipted upstream binary may be shipped.');
  const receiptRoot = path.join(native, 'receipts');
  const receiptNames = (await readdir(receiptRoot)).sort();
  const expectedNames = entries.map(entry => entry.name.replace(/\.node$/u, '.build.json')).sort();
  if (JSON.stringify(receiptNames) !== JSON.stringify(expectedNames)) throw new Error('Native binaries and their source-build receipts do not match exactly.');
  const sourceFiles = Object.fromEntries(source.files.map(file => [file.path, file.sha256]));
  const assets = [];
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const receiptPath = `native/receipts/${entry.name.replace(/\.node$/u, '.build.json')}`;
    const receiptBytes = await regular(path.join(root, receiptPath));
    const receipt = JSON.parse(receiptBytes.toString('utf8'));
    const selected = hostBuild(receipt.platform, receipt.arch);
    if (receipt.schema !== 1 || receipt.kind !== 'community-source-native-build' || receipt.upstream_commit !== 'e46be75c3ba8d5fde6b88a17c6153b87ffe4b946' || selected.filename !== entry.name || selected.target !== receipt.target) throw new Error('Native receipt does not describe this community source/target.');
    if (receipt.source_tree_sha256 !== source.identity || receipt.source_manifest_sha256 !== source.manifestHash || receipt.community_patch_sha256 !== source.patchHash || receipt.cargo_lock_sha256 !== sourceFiles['Cargo.lock']) throw new Error('Native receipt has a different source, patch, manifest or Cargo.lock.');
    if (!receipt.source_files || Object.keys(receipt.source_files).length !== source.files.length || source.files.some(file => receipt.source_files[file.path] !== file.sha256)) throw new Error('Native receipt source files differ from the pinned tree.');
    if (receipt.rust_toolchain?.version !== RUST_TOOLCHAIN || !hashPattern.test(receipt.rust_toolchain.compiler_sha256) || !hashPattern.test(receipt.rust_toolchain.cargo_sha256) || !String(receipt.rust_toolchain.rustc_verbose).includes(`release: ${RUST_TOOLCHAIN}`)) throw new Error('Native compiler provenance is missing or inconsistent.');
    if (receipt.smoke_test?.kind !== 'module-load-export-shape' || receipt.smoke_test.passed !== true || receipt.smoke_test.credential_accessed !== false || receipt.path_remapping?.enabled !== true) throw new Error('Native module load/remapping evidence is incomplete.');
    const bytes = await regular(path.join(native, entry.name), 67_108_864);
    if (receipt.output?.filename !== entry.name || receipt.output.size_bytes !== bytes.length || receipt.output.sha256 !== sha(bytes)) throw new Error('Native module bytes differ from their build receipt.');
    assertBinaryTarget(bytes, receipt.platform, receipt.arch);
    assertNoPrivatePaths(bytes, []); assertNoPrivatePaths(receiptBytes, []);
    assets.push({ platform: receipt.platform, arch: receipt.arch, target: receipt.target, path: `native/${entry.name}`, sha256: receipt.output.sha256, size_bytes: bytes.length, receipt_path: receiptPath, receipt_sha256: sha(receiptBytes), ci: receipt.ci });
  }
  const notices = await regular(path.join(native, 'UPSTREAM_NOTICES.txt'), 32_000_000);
  const inventory = await regular(path.join(root, 'docs', 'native-dependencies.json'), 16_000_000);
  const dependencies = JSON.parse(inventory.toString('utf8'));
  const resolution = dependencies.independent_source_build;
  const metadata = resolution?.build_metadata;
  const sourceManifest = JSON.parse((await regular(path.join(native, 'source-manifest.json'))).toString('utf8'));
  if (dependencies.schema !== 1 || resolution?.cargo_lock_sha256 !== sourceFiles['Cargo.lock'] ||
      metadata?.source_manifest_path !== 'native/source-manifest.json' || metadata.source_manifest_sha256 !== source.manifestHash ||
      metadata.source_manifest_and_packaged_inputs_verified !== true || !isDeepStrictEqual(metadata.source_manifest, sourceManifest) ||
      resolution.resolved_license_text_collection_complete !== true || resolution.registry_archive_checksums_verified !== true ||
      !Array.isArray(resolution.unresolved_packages) || resolution.unresolved_packages.length !== 0 ||
      resolution.rust_toolchain_notices_provided !== true || metadata.toolchain_inputs?.toolchain !== RUST_TOOLCHAIN ||
      resolution.rust_runtime_notice_source_commit !== '88d9e12ae178fab0fb5cc050a94da85685d449ea' ||
      dependencies.notice_artifact?.path !== 'native/UPSTREAM_NOTICES.txt' || dependencies.notice_artifact.bytes !== notices.length ||
      dependencies.notice_artifact.sha256 !== sha(notices) || notices.length < 1000) {
    throw new Error('Native source dependency notices/inventory do not cover the verified source, lockfile, runtime and notice bytes.');
  }
  return { schema: 1, origin: 'Community-patched source builds; original npm platform binaries are not redistributed.', source_tree_sha256: source.identity, source_manifest_sha256: source.manifestHash, community_patch_sha256: source.patchHash, cargo_lock_sha256: sourceFiles['Cargo.lock'], rust_toolchain: RUST_TOOLCHAIN, assets, notices_sha256: sha(notices), dependency_inventory_sha256: sha(inventory), limitation: 'Receipts pin inputs and output bytes. They are not builder authentication, a reconstructed upstream binary SBOM, cross-SDK bit reproducibility, live Fusion qualification or production signing.' };
}
