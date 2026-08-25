import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const sourcePlugin = path.join(repoRoot, "plugins", "react-native-to-swiftui");

function walk(root) {
  const entries = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    entries.push(file);
    if (entry.isDirectory()) {
      entries.push(...walk(file));
    }
  }
  return entries;
}

test("copied package runs without the parent checkout or node_modules", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "native-port-package-"));
  const copiedPlugin = path.join(tempRoot, "react-native-to-swiftui");
  const unrelatedCwd = path.join(tempRoot, "unrelated-cwd");
  try {
    fs.cpSync(sourcePlugin, copiedPlugin, {
      recursive: true,
      filter: (source) => path.basename(source) !== "node_modules",
    });
    fs.mkdirSync(unrelatedCwd);

    for (const file of walk(copiedPlugin)) {
      const relative = path.relative(copiedPlugin, file);
      assert.equal(fs.lstatSync(file).isSymbolicLink(), false, "symlink in package: " + relative);
      assert.doesNotMatch(relative, /(^|\/)node_modules(\/|$)/);
    }

    const cli = path.join(copiedPlugin, "scripts", "native-port.mjs");
    const stableFixture = path.join(copiedPlugin, "fixtures", "synthetic", "stable-counter");
    const source = path.join(stableFixture, "source");
    const target = path.join(stableFixture, "swift-target");
    const contract = path.join(
      stableFixture,
      "approved-contract.json",
    );

    const plan = spawnSync(
      process.execPath,
      [
        cli,
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
      { cwd: unrelatedCwd, encoding: "utf8" },
    );
    assert.equal(plan.status, 0, plan.stderr);
    assert.equal(JSON.parse(plan.stdout).writesPerformed, false);

    const verify = spawnSync(
      process.execPath,
      [cli, "verify", "--contract", contract, "--target-dir", target],
      { cwd: unrelatedCwd, encoding: "utf8" },
    );
    assert.equal(verify.status, 0, verify.stderr);
    assert.equal(JSON.parse(verify.stdout).ok, true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
