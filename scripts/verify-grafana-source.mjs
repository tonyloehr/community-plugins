#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const vendorRoot = resolve(repositoryRoot, "vendor/grafana-observability-source");
const packagedRoot = resolve(repositoryRoot, "plugins/grafana-observability");
const generatedDirectories = ["mcp", "native", "schemas", "scripts", "workers"];
const generatedRootFiles = ["LICENSE", "THIRD_PARTY_NOTICES.txt"];
const sourceTestDirectories = [
  "tests/grafana-mcp-server",
  "tests/adapters/grafana",
  "tests/security",
  "tests/grafana-authority-cli",
  "tests/observability-cli",
  "tests/credential-profile",
  "tests/provider-runtime",
  "tests/distribution",
];
const sourceTestSupportFiles = [
  "tests/config/fixtures.ts",
  "scripts/run-tests.mjs",
  "scripts/build-test-dependencies.mjs",
  "scripts/public-package-compile.mjs",
  "docs/connectivity.md",
  "docs/prometheus-grafana-setup.md",
  "docs/compatibility.md",
  "docs/security-threat-model.md",
  "plugins/production-monitoring/references/config-and-preflight.md",
  "plugins/production-monitoring/references/connectivity.md",
];
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_FILES = 512;

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeRelativePath(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(value)
    && value.split("/").every((part) => part !== "." && part !== ".." && part !== ".git" && part !== "node_modules");
}

function requireReceipt(receipt) {
  if (!safeRelativePath(receipt?.path)
    || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 0
    || !SHA256.test(receipt.sha256)) {
    throw new Error("Invalid source receipt");
  }
}

function validateManifest(manifest) {
  assert.equal(manifest.schemaVersion, 1, "unsupported provenance manifest");
  assert.equal(manifest.plugin, "grafana-observability");
  assert.equal(manifest.snapshot?.path, "source.tar.gz");
  assert.equal(manifest.snapshot?.format, "USTAR_GZIP_V1");
  assert.ok(SHA256.test(manifest.snapshot.sha256));
  assert.ok(SHA256.test(manifest.snapshot.treeSha256));
  assert.ok(Number.isSafeInteger(manifest.snapshot.bytes) && manifest.snapshot.bytes > 0 && manifest.snapshot.bytes <= MAX_ARCHIVE_BYTES);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= MAX_SOURCE_FILES);
  assert.equal(manifest.files.length, manifest.snapshot.fileCount);
  assert.equal(new Set(manifest.files.map((file) => file.path)).size, manifest.files.length);
  assert.deepEqual(manifest.files.map((file) => file.path), manifest.files.map((file) => file.path).sort());
  for (const receipt of manifest.files) requireReceipt(receipt);
  assert.equal(manifest.files.reduce((sum, file) => sum + file.bytes, 0), manifest.snapshot.sourceBytes);
  assert.ok(manifest.snapshot.sourceBytes <= MAX_EXPANDED_BYTES);
  assert.equal(digest(`${JSON.stringify(manifest.files)}\n`), manifest.snapshot.treeSha256);
  assert.deepEqual(manifest.build.generatedDirectories, generatedDirectories);
  assert.deepEqual(manifest.build.generatedRootFiles, generatedRootFiles);
  assert.deepEqual(manifest.build.target, { kind: "NATIVE_CANDIDATE", platform: "darwin", architecture: "arm64" });
  assert.ok(SHA256.test(manifest.build.packageLockSha256));
  assert.ok(Array.isArray(manifest.generatedFiles) && manifest.generatedFiles.length > 0);
  assert.equal(new Set(manifest.generatedFiles.map((file) => file.path)).size, manifest.generatedFiles.length);
  assert.deepEqual(manifest.generatedFiles.map((file) => file.path), manifest.generatedFiles.map((file) => file.path).sort());
  for (const receipt of manifest.generatedFiles) {
    requireReceipt(receipt);
    assert.ok(generatedRootFiles.includes(receipt.path) || generatedDirectories.includes(receipt.path.split("/")[0]), "unexpected generated-artifact path");
  }
  if (manifest.distributionChanges !== undefined) {
    assert.ok(Array.isArray(manifest.distributionChanges));
    const current = new Map(manifest.files.map((file) => [file.path, file.sha256]));
    const paths = manifest.distributionChanges.map((change) => change.path);
    assert.equal(new Set(paths).size, paths.length);
    assert.deepEqual(paths, [...paths].sort());
    for (const change of manifest.distributionChanges) {
      assert.ok(safeRelativePath(change.path));
      assert.ok(change.baseSha256 === null || SHA256.test(change.baseSha256));
      assert.ok(change.sha256 === null || SHA256.test(change.sha256));
      assert.notEqual(change.baseSha256, change.sha256);
      assert.equal(current.get(change.path) ?? null, change.sha256, "distribution change does not match current source");
    }
  }
  if (manifest.qualificationPatch !== undefined) {
    assert.equal(manifest.qualificationPatch.path, "qualification.patch");
    requireReceipt(manifest.qualificationPatch);
    assert.ok(SHA256.test(manifest.qualificationPatch.baseTreeSha256));
  }
  return manifest;
}

function tarString(header, offset, length) {
  const end = header.indexOf(0, offset);
  return header.subarray(offset, end === -1 || end > offset + length ? offset + length : end).toString("utf8");
}

function tarNumber(header, offset, length) {
  const value = tarString(header, offset, length).trim();
  if (!/^[0-7]+$/u.test(value)) throw new Error("Invalid source archive numeric field");
  return Number.parseInt(value, 8);
}

/** Decode only the deterministic regular-file USTAR subset used by this repo. */
export function decodeSourceArchive(archive, manifest) {
  validateManifest(manifest);
  assert.equal(archive.byteLength, manifest.snapshot.bytes, "source archive size mismatch");
  assert.equal(digest(archive), manifest.snapshot.sha256, "source archive digest mismatch");
  const tar = gunzipSync(archive, { maxOutputLength: MAX_EXPANDED_BYTES });
  const files = new Map();
  let offset = 0;
  for (const expected of manifest.files) {
    assert.ok(offset + 512 <= tar.length, "truncated source archive header");
    const header = tar.subarray(offset, offset + 512);
    const checksum = tarNumber(header, 148, 8);
    let actualChecksum = 0;
    for (let index = 0; index < 512; index += 1) actualChecksum += index >= 148 && index < 156 ? 32 : header[index];
    assert.equal(actualChecksum, checksum, "source archive header checksum mismatch");
    assert.equal(tarString(header, 257, 6), "ustar");
    assert.equal(tarString(header, 263, 2), "00");
    assert.ok(header[156] === 48 || header[156] === 0, "source archive must contain regular files only");
    assert.equal(tarString(header, 157, 100), "", "source archive links are forbidden");
    assert.equal(tarNumber(header, 100, 8), 0o644);
    assert.equal(tarNumber(header, 108, 8), 0);
    assert.equal(tarNumber(header, 116, 8), 0);
    assert.equal(tarNumber(header, 136, 12), 0);
    const prefix = tarString(header, 345, 155);
    const name = tarString(header, 0, 100);
    const path = prefix.length === 0 ? name : `${prefix}/${name}`;
    assert.equal(path, expected.path, "source archive path/order mismatch");
    assert.ok(safeRelativePath(path));
    const size = tarNumber(header, 124, 12);
    assert.equal(size, expected.bytes);
    const start = offset + 512;
    const end = start + size;
    const next = start + Math.ceil(size / 512) * 512;
    assert.ok(next <= tar.length, "truncated source archive data");
    const bytes = tar.subarray(start, end);
    assert.equal(digest(bytes), expected.sha256, `source file digest mismatch: ${path}`);
    assert.ok(tar.subarray(end, next).every((byte) => byte === 0), "nonzero source archive padding");
    files.set(path, bytes);
    offset = next;
  }
  assert.ok(tar.length - offset >= 1024 && tar.subarray(offset).every((byte) => byte === 0), "unexpected source archive entries or trailer");
  return files;
}

function sourceReceipt(path, bytes) {
  return { path, bytes: bytes.byteLength, sha256: digest(bytes) };
}

function walkFiles(root, prefix = "") {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...walkFiles(join(root, entry.name), path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Non-regular source or artifact entry: ${path}`);
  }
  return files.sort();
}

function generatedReceipts(root) {
  return [
    ...generatedDirectories.flatMap((directory) => walkFiles(resolve(root, directory)).map((path) => {
      const name = `${directory}/${path}`;
      return sourceReceipt(name, readFileSync(resolve(root, name)));
    })),
    ...generatedRootFiles.map((path) => sourceReceipt(path, readFileSync(resolve(root, path)))),
  ].sort((left, right) => comparePaths(left.path, right.path));
}

export function readSourceSnapshot(options = {}) {
  const manifest = validateManifest(JSON.parse(readFileSync(resolve(vendorRoot, "manifest.json"), "utf8")));
  if (manifest.qualificationPatch !== undefined && options.verifyQualificationPatch !== false) {
    const patch = readFileSync(resolve(vendorRoot, manifest.qualificationPatch.path));
    assert.equal(patch.byteLength, manifest.qualificationPatch.bytes, "qualification patch size mismatch");
    assert.equal(digest(patch), manifest.qualificationPatch.sha256, "qualification patch digest mismatch");
  }
  const archive = readFileSync(resolve(vendorRoot, manifest.snapshot.path));
  const files = decodeSourceArchive(archive, manifest);
  assert.equal(digest(files.get("package-lock.json")), manifest.build.packageLockSha256);
  return { manifest, files };
}

function verifyPackagedStaticFiles(receipts) {
  const prefix = "plugins/grafana-observability/";
  for (const expected of receipts.filter((file) => file.path.startsWith(prefix))) {
    const path = expected.path.slice(prefix.length);
    assert.deepEqual(sourceReceipt(expected.path, readSourceFile(packagedRoot, path)), expected, `packaged Grafana static input differs: ${path}`);
  }
}

export function verifyPackagedGeneratedFiles(manifest) {
  assert.deepEqual(generatedReceipts(packagedRoot), manifest.generatedFiles, "packaged Grafana output differs from its source receipt");
  verifyPackagedStaticFiles(manifest.files);
}

/** A native candidate must be rebuilt on its real target, never via npm OS overrides. */
export function assertNativeBuildPlatform(host = { platform: process.platform, architecture: process.arch }) {
  if (host.platform !== "darwin" || host.architecture !== "arm64") {
    throw new Error("The checked-in native candidate must be rebuilt on macOS arm64; archive and output verification works on every platform.");
  }
}

function assertBuildNodeVersion() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) throw new Error("Source rebuilding requires Node.js 22.19 or newer.");
}

function privateTemporaryDirectory(prefix) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  chmodSync(root, 0o700);
  return root;
}

export function extractSourceSnapshot(snapshot, destination) {
  const root = resolve(destination);
  if (existsSync(root)) throw new Error("Source extraction requires a new, nonexistent destination directory.");
  mkdirSync(root, { mode: 0o700 });
  for (const [path, bytes] of snapshot.files) {
    const output = resolve(root, path);
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    writeFileSync(output, bytes, { flag: "wx", mode: 0o644 });
  }
  return realpathSync(root);
}

function readSourceFile(sourceRoot, path) {
  assert.ok(safeRelativePath(path));
  const filename = resolve(sourceRoot, path);
  const metadata = lstatSync(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Source input is not a regular file: ${path}`);
  const resolved = realpathSync(filename);
  const within = relative(sourceRoot, resolved);
  if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error(`Source input escapes its root: ${path}`);
  return readFileSync(filename);
}

function verifySourceFiles(sourceRoot, manifest) {
  for (const expected of manifest.files) {
    assert.deepEqual(sourceReceipt(expected.path, readSourceFile(sourceRoot, expected.path)), expected, `source input differs: ${expected.path}`);
  }
}

async function sourceBuildModules(sourceRoot) {
  const modules = await Promise.all([
    import(pathToFileURL(resolve(sourceRoot, "scripts/plugin-build-lib.mjs")).href),
    import(pathToFileURL(resolve(sourceRoot, "scripts/plugin-descriptors.mjs")).href),
    import(pathToFileURL(resolve(sourceRoot, "scripts/release-lib.mjs")).href),
  ]);
  return {
    buildPluginArtifacts: modules[0].buildPluginArtifacts,
    descriptor: modules[1].pluginDescriptorById("grafana-observability"),
    assertGeneratedPluginFresh: modules[2].assertGeneratedPluginFresh,
    assertPluginReleaseLayout: modules[2].assertPluginReleaseLayout,
  };
}

async function rebuildSource(sourceRoot, manifest, verifyInputs = true) {
  assertNativeBuildPlatform();
  assertBuildNodeVersion();
  if (verifyInputs) verifySourceFiles(sourceRoot, manifest);
  const { buildPluginArtifacts, descriptor, assertGeneratedPluginFresh } = await sourceBuildModules(sourceRoot);
  const outputRoot = privateTemporaryDirectory("grafana-source-rebuild-");
  try {
    await buildPluginArtifacts({ repositoryRoot: sourceRoot, outputRoot, descriptor, logLevel: "silent", targetPlatform: "darwin", targetArchitecture: "arm64" });
    assertGeneratedPluginFresh(packagedRoot, outputRoot, descriptor);
    return generatedReceipts(outputRoot);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
}

function installDependencies(sourceRoot, offline) {
  const result = spawnSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", ...(offline ? ["--offline"] : [])], {
    cwd: sourceRoot,
    stdio: "inherit",
    shell: false,
  });
  if (result.error || result.status !== 0) throw new Error("Locked source dependency installation failed.");
}

function runSourceCommand(sourceRoot, args, description) {
  const result = spawnSync(process.execPath, args, { cwd: sourceRoot, stdio: "inherit", shell: false });
  if (result.error || result.status !== 0) throw new Error(`${description} failed.`);
}

/** Run only the reviewed source qualification suites in a fresh extracted tree. */
async function testExtractedSource(sourceRoot, manifest) {
  assertNativeBuildPlatform();
  assertBuildNodeVersion();
  verifySourceFiles(sourceRoot, manifest);
  runSourceCommand(sourceRoot, ["node_modules/typescript/bin/tsc", "--noEmit", "--pretty", "false"], "Source typecheck");
  runSourceCommand(sourceRoot, ["scripts/build-test-dependencies.mjs"], "Source test-dependency build");
  const { buildPluginArtifacts, descriptor, assertPluginReleaseLayout } = await sourceBuildModules(sourceRoot);
  const outputRoot = resolve(sourceRoot, descriptor.sourcePath);
  await buildPluginArtifacts({ repositoryRoot: sourceRoot, outputRoot, descriptor, logLevel: "silent", targetPlatform: "darwin", targetArchitecture: "arm64" });
  assertPluginReleaseLayout(outputRoot, resolve(sourceRoot, descriptor.build.schemaSourcePath), descriptor, "darwin", "arm64");
  assert.deepEqual(generatedReceipts(outputRoot), manifest.generatedFiles, "source-test bundle differs from the packaged runtime");
  runSourceCommand(sourceRoot, ["scripts/run-tests.mjs", ...sourceTestDirectories], "Focused Grafana source qualification");
}

function writeTarText(header, offset, length, value) {
  const bytes = Buffer.from(value);
  if (bytes.length > length) throw new Error("Source archive header field is too long");
  bytes.copy(header, offset);
}

function writeTarNumber(header, offset, length, value) {
  writeTarText(header, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

export function encodeSourceArchive(files) {
  const chunks = [];
  for (const [path, bytes] of [...files].sort(([left], [right]) => comparePaths(left, right))) {
    assert.ok(safeRelativePath(path));
    const header = Buffer.alloc(512);
    let name = path;
    let prefix = "";
    if (Buffer.byteLength(name) > 100) {
      const split = path.lastIndexOf("/");
      prefix = path.slice(0, split);
      name = path.slice(split + 1);
    }
    writeTarText(header, 0, 100, name);
    writeTarNumber(header, 100, 8, 0o644);
    writeTarNumber(header, 108, 8, 0);
    writeTarNumber(header, 116, 8, 0);
    writeTarNumber(header, 124, 12, bytes.byteLength);
    writeTarNumber(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = 48;
    writeTarText(header, 257, 6, "ustar\0");
    writeTarText(header, 263, 2, "00");
    writeTarText(header, 345, 155, prefix);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeTarText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

function assertNoSecretIndicators(path, bytes) {
  const text = bytes.toString("utf8");
  assert.ok(Buffer.from(text).equals(bytes), `source snapshot contains non-text input: ${path}`);
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u,
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/u,
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
    /\bglsa_[A-Za-z0-9_]{24,}\b/u,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
    /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}\b/u,
  ];
  if (patterns.some((pattern) => pattern.test(text))) throw new Error(`Source input requires a secret-indicator review: ${path}`);
}

function firstPartySourcePaths(sourceRoot) {
  const paths = [];
  const workspaces = ["conformance"];
  for (const directory of ["packages", "adapters"]) {
    for (const entry of readdirSync(resolve(sourceRoot, directory), { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(resolve(sourceRoot, directory, entry.name, "package.json"))) workspaces.push(`${directory}/${entry.name}`);
    }
  }
  for (const workspace of workspaces) {
    for (const entry of readdirSync(resolve(sourceRoot, workspace), { withFileTypes: true })) {
      if (entry.isFile() && /^(?:package\.json|tsconfig(?:\.[a-z-]+)?\.json|README\.md|LICENSE)$/u.test(entry.name)) paths.push(`${workspace}/${entry.name}`);
      if (entry.isDirectory() && ["src", "schemas", "examples", "workflow-evals"].includes(entry.name)) {
        const directory = `${workspace}/${entry.name}`;
        for (const path of walkFiles(resolve(sourceRoot, directory))) paths.push(`${directory}/${path}`);
      }
    }
  }
  return paths;
}

export async function collectSourceFiles(sourceRoot) {
  const { descriptor } = await sourceBuildModules(sourceRoot);
  const { build } = createRequire(resolve(sourceRoot, "package.json"))("esbuild");
  const paths = new Set([
    "AGENTS.md", "LICENSE", "package.json", "package-lock.json", "tsconfig.json", "eslint.config.mjs",
    "scripts/plugin-build-lib.mjs", "scripts/plugin-descriptors.mjs", "scripts/license-inventory.mjs",
    "scripts/release-lib.mjs", "scripts/public-package-manifest.mjs", "scripts/release-target.mjs",
    ...sourceTestSupportFiles,
    ...firstPartySourcePaths(sourceRoot),
  ]);
  for (const directory of ["packages/contracts/schemas", "scripts/legal-assets", "plugins/grafana-observability/.codex-plugin", "plugins/grafana-observability/assets", "plugins/grafana-observability/skills", ...sourceTestDirectories]) {
    if (existsSync(resolve(sourceRoot, directory))) for (const path of walkFiles(resolve(sourceRoot, directory))) paths.add(`${directory}/${path}`);
  }
  paths.add("plugins/grafana-observability/.mcp.json");
  if (existsSync(resolve(sourceRoot, "plugins/grafana-observability/README.md"))) paths.add("plugins/grafana-observability/README.md");
  for (const step of descriptor.build.steps) {
    const result = await build({ absWorkingDir: sourceRoot, entryPoints: [step.entryPoint], bundle: true, format: "cjs", platform: "node", target: "node22", write: false, metafile: true, logLevel: "silent", define: { "import.meta.url": "__PM_LOADER_URL__" } });
    for (const input of Object.keys(result.metafile.inputs)) if (!input.startsWith("node_modules/")) paths.add(input);
  }
  const files = new Map([...paths].sort().map((path) => {
    const bytes = readSourceFile(sourceRoot, path);
    assertNoSecretIndicators(path, bytes);
    return [path, bytes];
  }));
  return { files, descriptor };
}

async function captureSource(sourceRoot, previous) {
  assertNativeBuildPlatform();
  assertBuildNodeVersion();
  const generatedFiles = await rebuildSource(sourceRoot, previous, false);
  const { files, descriptor } = await collectSourceFiles(sourceRoot);
  const receipts = [...files].map(([path, bytes]) => sourceReceipt(path, bytes));
  verifyPackagedStaticFiles(receipts);
  const archive = encodeSourceArchive(files);
  const baseline = new Map(previous.files.map((file) => [file.path, file.sha256]));
  for (const change of previous.distributionChanges ?? []) {
    if (change.baseSha256 === null) baseline.delete(change.path);
    else baseline.set(change.path, change.baseSha256);
  }
  const current = new Map(receipts.map((file) => [file.path, file.sha256]));
  const changes = [...new Set([...baseline.keys(), ...current.keys()])].sort().flatMap((path) => {
    const baseSha256 = baseline.get(path) ?? null;
    const sha256 = current.get(path) ?? null;
    return baseSha256 === sha256 ? [] : [{ path, baseSha256, sha256 }];
  });
  const { reviewOverlay: _obsoleteReviewOverlay, ...priorManifest } = previous;
  void _obsoleteReviewOverlay;
  const manifest = {
    ...priorManifest,
    upstreamCapture: previous.upstreamCapture ?? { archiveSha256: previous.snapshot.sha256, treeSha256: previous.snapshot.treeSha256 },
    distributionChanges: changes,
    ...(existsSync(resolve(vendorRoot, "qualification.patch")) ? {
      qualificationPatch: {
        ...sourceReceipt("qualification.patch", readFileSync(resolve(vendorRoot, "qualification.patch"))),
        baseTreeSha256: previous.upstreamCapture?.treeSha256 ?? previous.snapshot.treeSha256,
      },
    } : {}),
    snapshot: { path: "source.tar.gz", format: "USTAR_GZIP_V1", bytes: archive.byteLength, sha256: digest(archive), fileCount: receipts.length, sourceBytes: receipts.reduce((sum, file) => sum + file.bytes, 0), treeSha256: digest(`${JSON.stringify(receipts)}\n`) },
    build: { ...previous.build, packageLockSha256: digest(files.get("package-lock.json")), entrypoints: descriptor.build.steps.map((step) => step.entryPoint) },
    files: receipts,
    generatedFiles,
  };
  decodeSourceArchive(archive, manifest);
  const temporaryArchive = resolve(vendorRoot, `.source-${process.pid}.tmp`);
  const temporaryManifest = resolve(vendorRoot, `.manifest-${process.pid}.tmp`);
  try {
    writeFileSync(temporaryArchive, archive, { flag: "wx", mode: 0o644 });
    writeFileSync(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    renameSync(temporaryArchive, resolve(vendorRoot, "source.tar.gz"));
    renameSync(temporaryManifest, resolve(vendorRoot, "manifest.json"));
  } finally {
    rmSync(temporaryArchive, { force: true });
    rmSync(temporaryManifest, { force: true });
  }
  return manifest;
}

function usage() {
  return "Usage: node scripts/verify-grafana-source.mjs [--rebuild [--test] [--offline] | --extract <new-directory> | --source <prepared-source-directory> | --capture-source <reviewed-source-directory>]\n";
}

function argumentsFor(argv) {
  if (argv.length === 0) return { mode: "verify" };
  if (argv.length === 1 && argv[0] === "--help") return { mode: "help" };
  if (argv[0] === "--rebuild") {
    const flags = argv.slice(1);
    if (new Set(flags).size === flags.length && flags.every((flag) => flag === "--offline" || flag === "--test")) {
      return { mode: "rebuild", offline: flags.includes("--offline"), test: flags.includes("--test") };
    }
  }
  if (argv.length === 2 && ["--extract", "--source", "--capture-source"].includes(argv[0]) && argv[1].length > 0) return { mode: argv[0].slice(2), path: resolve(argv[1]) };
  throw new Error(usage().trim());
}

export async function main(argv = process.argv.slice(2)) {
  const options = argumentsFor(argv);
  if (options.mode === "help") { process.stdout.write(usage()); return; }
  const snapshot = readSourceSnapshot({ verifyQualificationPatch: options.mode !== "capture-source" });
  if (options.mode === "capture-source") {
    const manifest = await captureSource(realpathSync(options.path), snapshot.manifest);
    console.log(`Captured ${manifest.snapshot.fileCount} reviewed source files; generated Grafana bytes match exactly.`);
    return;
  }
  verifyPackagedGeneratedFiles(snapshot.manifest);
  if (options.mode === "extract") {
    console.log(`Verified source extracted to ${extractSourceSnapshot(snapshot, options.path)}`);
    return;
  }
  if (options.mode === "source") {
    assert.deepEqual(await rebuildSource(realpathSync(options.path), snapshot.manifest), snapshot.manifest.generatedFiles);
  } else if (options.mode === "rebuild") {
    assertNativeBuildPlatform();
    assertBuildNodeVersion();
    const temporaryRoot = privateTemporaryDirectory("grafana-source-verification-");
    try {
      const sourceRoot = extractSourceSnapshot(snapshot, resolve(temporaryRoot, "source"));
      installDependencies(sourceRoot, options.offline);
      assert.deepEqual(await rebuildSource(sourceRoot, snapshot.manifest), snapshot.manifest.generatedFiles);
      if (options.test) await testExtractedSource(sourceRoot, snapshot.manifest);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
  console.log(`Grafana source provenance verified: ${snapshot.manifest.snapshot.fileCount} source files, ${snapshot.manifest.generatedFiles.length} generated files${options.mode === "verify" ? "." : `, byte-for-byte rebuild passed${options.test ? ", focused source suite passed" : ""}.`}`);
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`Grafana source verification failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
