#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const pluginRoot = path.join(
  repositoryRoot,
  "plugins",
  "reviewops-auditor-benchmark",
);
const bundlePath = path.join(pluginRoot, "scripts", "reviewops.mjs");
const workerBundlePath = path.join(
  pluginRoot,
  "scripts",
  "reviewops-worker.mjs",
);
const BANNED_RUNTIME =
  /node:(?:child_process|http|https|net|tls|dns)|\beval\s*\(|\bnew\s+Function\s*\(|process\.env|LOG_(?:STREAM|TOKENS)/u;

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
  });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-4000);
    throw new Error(`${command} ${args.join(" ")} failed:\n${output}`);
  }
  return result;
}

const originalDigest = sha256(bundlePath);
const originalWorkerDigest = sha256(workerBundlePath);
const tempRoot = mkdtempSync(path.join(tmpdir(), "reviewops-source-"));
const copyRoot = path.join(tempRoot, "reviewops-auditor-benchmark");
try {
  cpSync(pluginRoot, copyRoot, {
    recursive: true,
    filter: (source) => path.basename(source) !== "node_modules",
  });
  const cleanEnv = {
    HOME: tempRoot,
    LANG: "C",
    PATH: process.env.PATH,
    TZ: "UTC",
    npm_config_audit: "false",
    npm_config_cache: path.join(tempRoot, "npm-cache"),
    npm_config_fund: "false",
    npm_config_registry: "https://registry.npmjs.org/",
  };
  run("npm", ["ci", "--ignore-scripts"], { cwd: copyRoot, env: cleanEnv });
  run("npm", ["run", "build"], { cwd: copyRoot, env: cleanEnv });

  const rebuiltBundle = path.join(copyRoot, "scripts", "reviewops.mjs");
  const rebuiltWorkerBundle = path.join(
    copyRoot,
    "scripts",
    "reviewops-worker.mjs",
  );
  assert.equal(
    sha256(rebuiltBundle),
    originalDigest,
    "checked-in ReviewOps bundle is not reproducible from pinned source",
  );
  assert.equal(
    sha256(rebuiltWorkerBundle),
    originalWorkerDigest,
    "checked-in ReviewOps worker bundle is not reproducible from pinned source",
  );
  for (const filePath of [rebuiltBundle, rebuiltWorkerBundle]) {
    const bundle = readFileSync(filePath, "utf8");
    assert.equal(
      BANNED_RUNTIME.test(bundle),
      false,
      "rebuilt ReviewOps bundle contains a forbidden runtime surface",
    );
  }
  const notices = readFileSync(
    path.join(copyRoot, "THIRD_PARTY_NOTICES.txt"),
    "utf8",
  );
  for (const dependency of [
    "ajv 8.20.0",
    "fast-deep-equal 3.1.3",
    "yaml 2.9.0",
  ]) {
    assert.match(notices, new RegExp(dependency.replaceAll(".", "\\."), "u"));
  }
  const lockfile = readFileSync(
    path.join(copyRoot, "package-lock.json"),
    "utf8",
  );
  assert.doesNotMatch(lockfile, /internal\.api|socket-firewall|openai\.org/u);

  rmSync(path.join(copyRoot, "node_modules"), { recursive: true, force: true });
  assert.equal(existsSync(path.join(copyRoot, "node_modules")), false);
  const smoke = run(
    process.execPath,
    [
      rebuiltBundle,
      "recommend-architecture",
      "--fixture",
      "synthetic",
      "--format",
      "json",
    ],
    { cwd: tempRoot, env: { LANG: "C", PATH: process.env.PATH, TZ: "UTC" } },
  );
  const report = JSON.parse(smoke.stdout);
  assert.equal(report.status, "COMPLETE");
  assert.equal(report.toolVersion, "0.1.0");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("ReviewOps source verification passed.");
