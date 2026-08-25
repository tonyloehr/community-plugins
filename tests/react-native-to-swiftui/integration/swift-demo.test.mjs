import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const pluginRoot = path.join(repoRoot, "plugins", "react-native-to-swiftui");
const cli = path.join(pluginRoot, "scripts", "native-port.mjs");
const stableFixture = path.join(
  pluginRoot,
  "fixtures",
  "synthetic",
  "stable-counter",
);

function run(args, cwd) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LANG: "C", NO_COLOR: "1", TZ: "UTC" },
  });
}

function jsonReport(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function digestTree(root) {
  const hash = crypto.createHash("sha256");
  function visit(directory) {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file);
      hash.update(entry.isDirectory() ? "d:" : "f:");
      hash.update(relative);
      hash.update("\0");
      if (entry.isDirectory()) {
        visit(file);
      } else {
        hash.update(fs.readFileSync(file));
        hash.update("\0");
      }
    }
  }
  visit(root);
  return hash.digest("hex");
}

test("synthetic Swift demo runs contract-first end to end without writes", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "native-port-swift-demo-"));
  const demo = path.join(tempRoot, "stable-counter");
  try {
    fs.cpSync(stableFixture, demo, { recursive: true });
    const source = path.join(demo, "source");
    const target = path.join(demo, "swift-target");
    const contract = path.join(demo, "approved-contract.json");
    const before = digestTree(demo);

    const plan = jsonReport(
      run(
        [
          "plan",
          "--source-root",
          source,
          "--source-file",
          "StableCounter.tsx",
          "--feature",
          "StableCounter",
          "--format",
          "json",
        ],
        tempRoot,
      ),
    );
    assert.equal(plan.status, "proposal");
    assert.equal(plan.readOnly, true);
    assert.equal(plan.writesPerformed, false);
    assert.equal(plan.source.matchedExport.file, "StableCounter.tsx");

    const authorization = jsonReport(
      run(
        [
          "authorize-write",
          "--contract",
          contract,
          "--target-dir",
          target,
          "--module",
          "DemoApp",
          "--slice",
          "StableCounter",
          "--write-file",
          "DemoApp/Domain/CounterState.swift",
          "--write-file",
          "DemoApp/UI/StableCounterView.swift",
          "--write-file",
          "DemoAppUITests/StableCounterUITests.swift",
          "--format",
          "json",
        ],
        tempRoot,
      ),
    );
    assert.equal(authorization.authorized, true);
    assert.equal(authorization.writesPerformed, false);
    assert.equal(authorization.files.length, 3);

    const verification = jsonReport(
      run(
        ["verify", "--contract", contract, "--target-dir", target, "--format", "json"],
        tempRoot,
      ),
    );
    assert.equal(verification.status, "structural-checks-passed");
    assert.equal(verification.structuralOnly, true);
    assert.equal(verification.behavioralParityProven, false);
    assert.ok(verification.accessibilityIdentifiers.includes("stable-counter.increment"));

    const readiness = jsonReport(
      run(
        ["audit", "--contract", contract, "--target-dir", target, "--format", "json"],
        tempRoot,
      ),
    );
    assert.equal(readiness.preflightOnly, true);
    assert.equal(readiness.guaranteedApproval, false);
    assert.equal(digestTree(demo), before);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
