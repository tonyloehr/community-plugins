import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const pluginDir = path.join(repoRoot, "plugins", "react-native-to-swiftui");
const cli = path.join(pluginDir, "scripts", "native-port.mjs");
const fixture = path.join(pluginDir, "fixtures", "synthetic");
const stableFixture = path.join(fixture, "stable-counter");
const source = path.join(stableFixture, "source");
const ambiguousSource = path.join(fixture, "ambiguous-source");
const ambiguousTargetContract = path.join(fixture, "ambiguous-target", "approved-contract.json");
const target = path.join(stableFixture, "swift-target");
const contract = path.join(stableFixture, "approved-contract.json");

function run(args, cwd = repoRoot) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

function digestTree(root) {
  const values = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file);
      if (entry.isDirectory()) {
        values.push("d:" + relative);
        visit(file);
      } else {
        values.push("f:" + relative + ":" + crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
      }
    }
  }
  visit(root);
  return values.join("\n");
}

test("synthetic planning happy path is deterministic and read-only", () => {
  const before = digestTree(source);
  const args = [
    "plan",
    "--source-root",
    source,
    "--source-file",
    "StableCounter.tsx",
    "--feature",
    "StableCounter",
    "--format",
    "json",
  ];
  const first = run(args);
  const second = run(args);

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  const result = JSON.parse(first.stdout);
  assert.equal(result.readOnly, true);
  assert.equal(result.writesPerformed, false);
  assert.equal(result.status, "proposal");
  assert.equal(result.source.matchedExport.file, "StableCounter.tsx");
  assert.deepEqual(result.behavioralParity.accessibilityIdentifiers, [
    "stable-counter.increment",
    "stable-counter.root",
    "stable-counter.value",
  ]);
  assert.equal(digestTree(source), before);
});

test("ambiguous declared feature scope fails closed", () => {
  const result = run([
    "plan",
    "--source-root",
    ambiguousSource,
    "--source-file",
    "FirstStableCounter.tsx",
    "--source-file",
    "SecondStableCounter.tsx",
    "--feature",
    "StableCounter",
    "--format",
    "json",
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AMBIGUOUS_SOURCE_SCOPE/);
});

test("write authorization stays inside one explicit target directory", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "native-port-target-"));
  try {
    const good = run([
      "authorize-write",
      "--contract",
      contract,
      "--target-dir",
      tempRoot,
      "--module",
      "DemoApp",
      "--slice",
      "StableCounter",
      "--write-file",
      "DemoApp/Domain/CounterState.swift",
    ]);
    assert.equal(good.status, 0, good.stderr);
    assert.equal(JSON.parse(good.stdout).writesPerformed, false);

    const bad = run([
      "authorize-write",
      "--contract",
      contract,
      "--target-dir",
      tempRoot,
      "--module",
      "DemoApp",
      "--slice",
      "StableCounter",
      "--write-file",
      "../Outside.swift",
    ]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /PATH_TRAVERSAL_REJECTED|TARGET_FILE_OUT_OF_SCOPE|PATH_OUTSIDE_TARGET/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("ambiguous target contract fails before any write authorization", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "native-port-ambiguous-target-"));
  try {
    const result = run([
      "authorize-write",
      "--contract",
      ambiguousTargetContract,
      "--target-dir",
      tempRoot,
      "--module",
      "DemoApp",
      "--slice",
      "StableCounter",
      "--write-file",
      "DemoApp/Domain/CounterState.swift",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AMBIGUOUS_TARGET/);
    assert.deepEqual(fs.readdirSync(tempRoot), []);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("incomplete backend or licensing contract fails before writes", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "native-port-incomplete-contract-"));
  const incompleteContract = path.join(tempRoot, "incomplete-contract.json");
  try {
    const value = JSON.parse(fs.readFileSync(contract, "utf8"));
    delete value.backendContract;
    fs.writeFileSync(incompleteContract, JSON.stringify(value, null, 2));
    const result = run([
      "authorize-write",
      "--contract",
      incompleteContract,
      "--target-dir",
      tempRoot,
      "--module",
      "DemoApp",
      "--slice",
      "StableCounter",
      "--write-file",
      "DemoApp/Domain/CounterState.swift",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AMBIGUOUS_CONTRACT/);
    assert.deepEqual(fs.readdirSync(tempRoot), ["incomplete-contract.json"]);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("deterministic parity checks pass on the owned target fixture", () => {
  const result = run(["verify", "--contract", contract, "--target-dir", target]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.status, "structural-checks-passed");
  assert.equal(report.structuralOnly, true);
  assert.equal(report.behavioralParityProven, false);
  assert.ok(report.checks.some((check) => check.includes("domain-pure-swift")));
});

test("missing Apple toolchain fails clearly without installation", () => {
  const result = run(["toolchain", "--xcodebuild", path.join(os.tmpdir(), "missing-xcodebuild")]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /XCODE_TOOLCHAIN_UNAVAILABLE/);
  assert.match(result.stderr, /will not install/i);
});

test("readiness audit is explicitly a preflight, never guaranteed approval", () => {
  const result = run(["audit", "--contract", contract, "--target-dir", target]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.preflightOnly, true);
  assert.equal(report.guaranteedApproval, false);
  assert.ok(report.limitations.some((item) => /cannot be guaranteed/i.test(item)));
});
