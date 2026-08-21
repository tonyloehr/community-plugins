import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import test from "node:test";

import {
  assertNativeBuildPlatform,
  decodeSourceArchive,
  encodeSourceArchive,
  extractSourceSnapshot,
  readSourceSnapshot,
  verifyPackagedGeneratedFiles,
} from "../../scripts/verify-grafana-source.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sourceRoot = resolve(repositoryRoot, "vendor/grafana-observability-source");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("vendored source and every generated runtime file have deterministic matching receipts", () => {
  const snapshot = readSourceSnapshot();
  verifyPackagedGeneratedFiles(snapshot.manifest);
  const checkedArchive = readFileSync(resolve(sourceRoot, "source.tar.gz"));
  const encodedArchive = encodeSourceArchive(snapshot.files);
  // readSourceSnapshot already verified the pinned compressed size and digest.
  // Different zlib versions may encode the same canonical TAR differently.
  assert.equal(encodedArchive.equals(encodeSourceArchive(snapshot.files)), true, "gzip encoding must repeat within the same encoder");
  assert.equal(gunzipSync(encodedArchive).equals(gunzipSync(checkedArchive)), true, "canonical TAR bytes must match exactly across encoders");
  assert.equal(snapshot.manifest.qualificationPatch.baseTreeSha256, snapshot.manifest.upstreamCapture.treeSha256);
  for (const path of [
    "scripts/run-tests.mjs",
    "scripts/build-test-dependencies.mjs",
    "tests/config/fixtures.ts",
    "tests/adapters/grafana/grafana-adapter.test.ts",
    "tests/grafana-mcp-server/real-grafana-adapter-fixture.ts",
    "tests/distribution/grafana-native-response.test.ts",
  ]) assert.ok(snapshot.files.has(path), `source qualification input missing: ${path}`);
  for (const [path, bytes] of snapshot.files) {
    assert.doesNotMatch(path, /(?:^|\/)(?:node_modules|dist|\.git|generated\/generated)(?:\/|$)/u);
    assert.equal(/implementation-plan/iu.test(path), false, "Local planning files must not enter the source archive");
    assert.equal(/implementation-plan/iu.test(bytes.toString("utf8")), false, "Local planning links must not enter the source archive");
  }
});

test("source archive corruption, links, and unsafe paths fail closed", () => {
  const snapshot = readSourceSnapshot();
  const original = readFileSync(resolve(sourceRoot, "source.tar.gz"));
  const corrupted = Buffer.from(original);
  corrupted[corrupted.length - 1] ^= 1;
  assert.throws(() => decodeSourceArchive(corrupted, snapshot.manifest), /digest mismatch/u);
  assert.throws(() => encodeSourceArchive(new Map([["../escape", Buffer.from("x")]])));

  const tar = gunzipSync(original);
  tar[156] = 50; // A symlink entry is never admitted, even with a matching archive hash.
  tar.fill(32, 148, 156);
  const checksum = tar.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
  tar.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  const linked = gzipSync(tar, { level: 9 });
  const manifest = structuredClone(snapshot.manifest);
  manifest.snapshot.bytes = linked.length;
  manifest.snapshot.sha256 = sha256(linked);
  assert.throws(() => decodeSourceArchive(linked, manifest), /regular files only/u);
});

test("native source rebuild is explicitly limited to the actual macOS arm64 host", () => {
  assert.doesNotThrow(() => assertNativeBuildPlatform({ platform: "darwin", architecture: "arm64" }));
  for (const host of [
    { platform: "linux", architecture: "x64" },
    { platform: "linux", architecture: "arm64" },
    { platform: "darwin", architecture: "x64" },
    { platform: "win32", architecture: "arm64" },
  ]) assert.throws(() => assertNativeBuildPlatform(host), /must be rebuilt on macOS arm64/u);
});

function receipts(root, prefix = "") {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) return receipts(join(root, entry.name), path);
    assert.equal(entry.isFile(), true);
    const bytes = readFileSync(join(root, entry.name));
    return [{ path, bytes: bytes.length, sha256: sha256(bytes) }];
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

test("the review patch reverses exactly to the recorded pre-qualification source baseline", (t) => {
  const snapshot = readSourceSnapshot();
  const parent = mkdtempSync(join(tmpdir(), "grafana-source-patch-test-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const extracted = extractSourceSnapshot(snapshot, join(parent, "source"));
  assert.throws(() => extractSourceSnapshot(snapshot, extracted), /nonexistent destination/u);
  const patch = resolve(sourceRoot, "qualification.patch");
  const text = readFileSync(patch, "utf8");
  assert.equal(/implementation-plan/iu.test(text), false, "Local planning links must not enter the qualification patch");
  for (const line of text.split("\n").filter((line) => /^(?:diff --git|--- |\+\+\+ )/u.test(line))) {
    assert.doesNotMatch(line, /\/Users\/|\/private\/var\/|\/tmp\//u);
  }
  const environment = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete environment[name];
  for (const flags of [["--reverse", "--check"], ["--reverse"]]) {
    const result = spawnSync("git", ["apply", ...flags, patch], {
      cwd: extracted, env: environment, encoding: "utf8", shell: false,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  }
  const baselineReceipts = receipts(extracted);
  assert.equal(sha256(`${JSON.stringify(baselineReceipts)}\n`), snapshot.manifest.upstreamCapture.treeSha256);
  const baseline = new Map(baselineReceipts.map((file) => [file.path, file.sha256]));
  const current = new Map(snapshot.manifest.files.map((file) => [file.path, file.sha256]));
  const changes = [...new Set([...baseline.keys(), ...current.keys()])].sort().flatMap((path) => {
    const baseSha256 = baseline.get(path) ?? null;
    const sha256 = current.get(path) ?? null;
    return baseSha256 === sha256 ? [] : [{ path, baseSha256, sha256 }];
  });
  assert.deepEqual(changes, snapshot.manifest.distributionChanges);
});
