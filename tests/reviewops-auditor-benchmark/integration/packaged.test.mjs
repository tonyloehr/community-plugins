import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const pluginRoot = path.join(
  repoRoot,
  "plugins",
  "reviewops-auditor-benchmark",
);

test("copied package runs without node_modules or parent checkout", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "reviewops-package-"));
  const copy = path.join(temp, "reviewops-auditor-benchmark");
  fs.cpSync(pluginRoot, copy, {
    recursive: true,
    filter: (source) => path.basename(source) !== "node_modules",
  });
  assert.equal(fs.existsSync(path.join(copy, "node_modules")), false);
  for (const command of [
    "validate-config",
    "normalize",
    "audit-eval",
    "benchmark",
    "recommend-architecture",
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        path.join(copy, "scripts", "reviewops.mjs"),
        command,
        "--fixture",
        "synthetic",
        "--format",
        "json",
      ],
      {
        cwd: temp,
        encoding: "utf8",
        env: { LANG: "C", PATH: process.env.PATH, TZ: "UTC" },
      },
    );
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "COMPLETE", command);
    assert.equal(report.toolVersion, "0.1.0", command);
  }
});

test("shipped bundle parses dense JSONL within a bounded parent heap", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewops-dense-jsonl-"));
  const fixture = path.join(pluginRoot, "fixtures", "synthetic");
  fs.cpSync(fixture, root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "dense.jsonl"),
    "\n".repeat(8 * 1024 * 1024),
  );
  const configPath = path.join(root, "reviewops.config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.staticDiagnostics = {
    workflowPaths: [],
    promptPaths: [],
    telemetryPaths: [],
    toolContractPaths: [],
    validatorResultPaths: ["dense.jsonl"],
    bindings: [],
  };
  config.limits.maxBytesPerFile = 8 * 1024 * 1024;
  fs.writeFileSync(configPath, JSON.stringify(config));
  const result = spawnSync(
    process.execPath,
    [
      "--max-old-space-size=64",
      path.join(pluginRoot, "scripts", "reviewops.mjs"),
      "audit-eval",
      "--config",
      "reviewops.config.json",
      "--format",
      "json",
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      env: { LANG: "C", PATH: process.env.PATH, TZ: "UTC" },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "COMPLETE");
  assert.equal(report.staticDiagnosticContext, "SUPPLIED");
});

test("distributed plugin tree contains only regular files and directories", () => {
  const queue = [pluginRoot];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules") {
        continue;
      }
      const target = path.join(current, entry.name);
      const stat = fs.lstatSync(target);
      assert.equal(stat.isSymbolicLink(), false, target);
      if (stat.isDirectory()) {
        queue.push(target);
      } else {
        assert.equal(stat.isFile(), true, target);
      }
    }
  }
});

test("missing shipped worker is a sanitized internal failure", () => {
  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), "reviewops-worker-error-"),
  );
  const copy = path.join(temp, "reviewops-auditor-benchmark");
  fs.cpSync(pluginRoot, copy, {
    recursive: true,
    filter: (source) => path.basename(source) !== "node_modules",
  });
  fs.unlinkSync(path.join(copy, "scripts", "reviewops-worker.mjs"));
  const result = spawnSync(
    process.execPath,
    [
      path.join(copy, "scripts", "reviewops.mjs"),
      "normalize",
      "--fixture",
      "synthetic",
      "--format",
      "json",
    ],
    {
      cwd: temp,
      encoding: "utf8",
      env: { LANG: "C", PATH: process.env.PATH, TZ: "UTC" },
    },
  );
  assert.equal(result.status, 4, result.stderr);
  const error = JSON.parse(result.stderr);
  assert.equal(error.status, "ERROR");
  assert.equal(error.code, "RO_WORKER_FAILED");
  assert.equal(result.stdout, "");
});
