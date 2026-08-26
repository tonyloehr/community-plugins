import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const pluginRoot = path.join(repoRoot, "plugins", "react-native-to-swiftui");
const cli = path.join(pluginRoot, "scripts", "native-port.mjs");
const stableFixture = path.join(pluginRoot, "fixtures", "synthetic", "stable-counter");
const source = path.join(stableFixture, "source");
const target = path.join(stableFixture, "swift-target");
const contract = path.join(stableFixture, "approved-contract.json");

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, LANG: "C", NO_COLOR: "1", TZ: "UTC" },
  });
}

function assertTextFirst(result, heading, allowedStatuses = [0]) {
  assert.ok(allowedStatuses.includes(result.status), result.stderr);
  const output = result.stdout + result.stderr;
  assert.match(output, new RegExp("^# " + heading, "m"));
  assert.doesNotMatch(output, /\u001b/u);
  assert.doesNotMatch(output, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u);
}

test("public Markdown reports are text-first and do not rely on color", () => {
  const tempTarget = fs.mkdtempSync(path.join(os.tmpdir(), "native-port-markdown-"));
  try {
    assertTextFirst(
      run([
        "plan",
        "--source-root",
        source,
        "--source-file",
        "StableCounter.tsx",
        "--feature",
        "StableCounter",
        "--format",
        "markdown",
      ]),
      "Draft SwiftUI parity contract",
    );
    assertTextFirst(
      run([
        "authorize-write",
        "--contract",
        contract,
        "--target-dir",
        tempTarget,
        "--module",
        "DemoApp",
        "--slice",
        "StableCounter",
        "--write-file",
        "DemoApp/Domain/CounterState.swift",
        "--format",
        "markdown",
      ]),
      "Write authorization",
    );
    assertTextFirst(
      run(["verify", "--contract", contract, "--target-dir", target, "--format", "markdown"]),
      "SwiftUI parity verification",
    );
    assertTextFirst(
      run(["audit", "--contract", contract, "--target-dir", target, "--format", "markdown"]),
      "iOS readiness preflight",
    );
    assertTextFirst(
      run(["toolchain", "--xcodebuild", path.join(tempTarget, "missing-xcodebuild"), "--format", "markdown"]),
      "Apple toolchain",
      [0, 2],
    );
  } finally {
    fs.rmSync(tempTarget, { recursive: true, force: true });
  }
});
