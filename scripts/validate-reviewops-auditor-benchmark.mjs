#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const pluginName = "reviewops-auditor-benchmark";
const pluginRoot = path.join(repoRoot, "plugins", pluginName);
const errors = [];
const requiredSkills = [
  "normalize-review-runs",
  "audit-review-eval-validity",
  "benchmark-review-configs",
  "recommend-review-reference-architecture",
];
const requiredSchemas = [
  "common",
  "config",
  "config-validation",
  "review-run-export",
  "normalization-report",
  "eval-protocol",
  "adjudication-protocol",
  "benchmark-manifest",
  "candidate-config",
  "decision-policy",
  "tool-contract",
  "validator-result",
  "rubric",
  "pricing-snapshot",
  "run-record",
  "case-label",
  "eval-validity-report",
  "benchmark-scorecard",
  "reference-architecture-recommendation",
  "static-diagnostic-report",
];

function fail(message) {
  errors.push(message);
}

function assertOnlyKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(`${label} contains unsupported field ${key}`);
    }
  }
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
    return null;
  }
}

function requireFile(relativePath) {
  const filePath = path.join(pluginRoot, relativePath);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    fail(`missing ${relativePath}`);
  }
  return filePath;
}

function walk(root) {
  const files = [];
  if (!fs.existsSync(root)) {
    return files;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules") {
      continue;
    }
    const entryPath = path.join(root, entry.name);
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      fail(
        `distribution contains symlink: ${path.relative(repoRoot, entryPath)}`,
      );
      continue;
    }
    if (stat.isDirectory()) {
      files.push(...walk(entryPath));
    } else if (stat.isFile()) {
      files.push(entryPath);
    } else {
      fail(
        `distribution contains non-regular file: ${path.relative(repoRoot, entryPath)}`,
      );
    }
  }
  return files;
}

for (const file of [
  ".codex-plugin/plugin.json",
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.txt",
  "assets/icon.svg",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "fixtures/synthetic/README.md",
  "scripts/reviewops.mjs",
  "scripts/reviewops-worker.mjs",
]) {
  requireFile(file);
}
for (const file of [
  "scripts/verify-reviewops-source.mjs",
  ".github/workflows/reviewops-auditor-benchmark.yml",
]) {
  const filePath = path.join(repoRoot, file);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    fail(`missing ${file}`);
  }
}

const manifest = readJson(
  path.join(pluginRoot, ".codex-plugin", "plugin.json"),
  "plugin manifest",
);
if (manifest) {
  assertOnlyKeys(
    manifest,
    new Set([
      "name",
      "version",
      "description",
      "author",
      "homepage",
      "repository",
      "license",
      "keywords",
      "skills",
      "interface",
    ]),
    "plugin manifest",
  );
  assertOnlyKeys(manifest.author, new Set(["name", "url"]), "manifest author");
  assertOnlyKeys(
    manifest.interface,
    new Set([
      "displayName",
      "shortDescription",
      "longDescription",
      "developerName",
      "category",
      "websiteURL",
      "capabilities",
      "brandColor",
      "logo",
      "composerIcon",
      "defaultPrompt",
    ]),
    "manifest interface",
  );
  if (manifest.name !== pluginName) {
    fail("manifest name must match plugin folder");
  }
  if (manifest.version !== "0.1.0") {
    fail("manifest version must be 0.1.0 for the first release");
  }
  if (manifest.skills !== "./skills/") {
    fail("manifest must expose only the skills directory");
  }
  if (manifest.mcpServers !== undefined || manifest.apps !== undefined) {
    fail("v0.1.0 must not declare MCP servers or apps");
  }
  const capabilities = manifest.interface?.capabilities;
  if (JSON.stringify(capabilities) !== JSON.stringify(["Read"])) {
    fail("v0.1.0 capabilities must be exactly Read");
  }
}

const marketplace = readJson(
  path.join(repoRoot, ".agents", "plugins", "marketplace.json"),
  "marketplace",
);
const entry = marketplace?.plugins?.find((item) => item.name === pluginName);
if (!entry) {
  fail("marketplace entry is missing");
} else {
  if (entry.source?.path !== `./plugins/${pluginName}`) {
    fail("marketplace source path is wrong");
  }
  if (entry.policy?.installation !== "AVAILABLE") {
    fail("marketplace installation policy must be AVAILABLE");
  }
  if (entry.policy?.authentication !== "ON_USE") {
    fail("marketplace authentication policy must be ON_USE");
  }
}

for (const schemaName of requiredSchemas) {
  const schema = readJson(
    path.join(pluginRoot, "schemas", `${schemaName}.schema.json`),
    `${schemaName} schema`,
  );
  if (
    schemaName !== "common" &&
    schema &&
    (schema.type !== "object" || schema.additionalProperties !== false)
  ) {
    fail(`${schemaName} schema must be a closed object`);
  }
}

for (const skillName of requiredSkills) {
  const skill = requireFile(path.join("skills", skillName, "SKILL.md"));
  const agent = requireFile(
    path.join("skills", skillName, "agents", "openai.yaml"),
  );
  if (fs.existsSync(skill)) {
    const text = fs.readFileSync(skill, "utf8");
    if (
      !/^---\n[\s\S]*name:\s*\S+[\s\S]*description:\s*\S+[\s\S]*---/u.test(text)
    ) {
      fail(`${skillName} SKILL.md needs name and description frontmatter`);
    }
    if (!/## Safety contract/u.test(text)) {
      fail(`${skillName} SKILL.md needs a safety contract`);
    }
  }
  if (fs.existsSync(agent)) {
    const text = fs.readFileSync(agent, "utf8");
    if (
      !/^interface:/mu.test(text) ||
      !/allow_implicit_invocation:\s*false/u.test(text)
    ) {
      fail(`${skillName} agent metadata must disable implicit invocation`);
    }
  }
}

const readme = fs.readFileSync(path.join(pluginRoot, "README.md"), "utf8");
for (const heading of [
  "## Safe first run",
  "## Permissions and authentication",
  "## Data boundary",
  "## Accessibility",
  "## Limitations",
]) {
  if (!readme.includes(heading)) {
    fail(`README is missing ${heading}`);
  }
}

const packageJson = readJson(
  path.join(pluginRoot, "package.json"),
  "plugin package",
);
if (packageJson) {
  for (const script of ["preinstall", "install", "postinstall"]) {
    if (packageJson.scripts?.[script]) {
      fail(`plugin package must not define ${script}`);
    }
  }
}

const lockText = fs.readFileSync(
  path.join(pluginRoot, "package-lock.json"),
  "utf8",
);
if (/internal\.api|socket-firewall|openai\.org/u.test(lockText)) {
  fail("package-lock.json contains a non-public registry URL");
}

const files = walk(pluginRoot);
const publicDocs = [
  path.join(repoRoot, "README.md"),
  path.join(
    repoRoot,
    "docs",
    "reviewops-auditor-benchmark-implementation-plan.md",
  ),
  path.join(repoRoot, ".agents", "plugins", "marketplace.json"),
  path.join(
    repoRoot,
    ".github",
    "workflows",
    "reviewops-auditor-benchmark.yml",
  ),
  path.join(repoRoot, "package.json"),
  path.join(repoRoot, "scripts", "verify-reviewops-source.mjs"),
].filter((file) => fs.existsSync(file) && fs.statSync(file).isFile());
const bannedContent = [
  /\/Users\//u,
  /openai\.enterprise/u,
  /app\.gong/u,
  /internal\.api/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
];
for (const file of [...files, ...publicDocs]) {
  const relative = path.relative(repoRoot, file);
  const text = fs.readFileSync(file, "utf8");
  for (const retiredName of [
    "audit-code-review-workflow",
    "recommend-review-routing",
  ]) {
    if (text.includes(retiredName)) {
      fail("stale ReviewOps skill name " + retiredName + " in " + relative);
    }
  }
  for (const pattern of bannedContent) {
    if (pattern.test(text)) {
      fail(`distribution scan matched ${pattern} in ${relative}`);
    }
  }
}

const sourceFiles = files.filter((file) =>
  path.relative(pluginRoot, file).startsWith(`src${path.sep}`),
);
const runtimeFiles = [
  ...sourceFiles,
  path.join(pluginRoot, "scripts", "reviewops.mjs"),
  path.join(pluginRoot, "scripts", "reviewops-worker.mjs"),
];
for (const file of runtimeFiles) {
  const text = fs.readFileSync(file, "utf8");
  if (
    /node:(?:child_process|http|https|net|tls|dns)|\beval\s*\(|\bnew\s+Function\s*\(|process\.env|LOG_(?:STREAM|TOKENS)/u.test(
      text,
    )
  ) {
    fail(`forbidden runtime surface in ${path.relative(pluginRoot, file)}`);
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`ERROR ${error}`);
  }
  process.exit(1);
}

console.log("ReviewOps validation passed.");
