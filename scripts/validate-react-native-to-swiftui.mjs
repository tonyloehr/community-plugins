#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const pluginName = "react-native-to-swiftui";
const pluginRoot = path.join(repoRoot, "plugins", pluginName);
const marketplacePath = path.join(
  repoRoot,
  ".agents",
  "plugins",
  "marketplace.json",
);
const safeFirstPrompt =
  "Use $plan-react-native-port to inspect only the declared React Native feature and propose a SwiftUI parity contract. Do not edit files yet.";
const requiredSkills = [
  "plan-react-native-port",
  "port-react-native-slice",
  "verify-swiftui-parity",
  "audit-ios-readiness",
];
const errors = [];

function fail(message) {
  errors.push(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(label + " is not valid JSON: " + error.message);
    return null;
  }
}

function requireFile(relativePath) {
  const filePath = path.join(pluginRoot, relativePath);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    fail("missing " + relativePath);
  }
  return filePath;
}

function requireRepoFile(relativePath) {
  const filePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    fail("missing " + relativePath);
  }
  return filePath;
}

function requireDirectory(relativePath) {
  const directoryPath = path.join(pluginRoot, relativePath);
  if (!fs.existsSync(directoryPath) || !fs.statSync(directoryPath).isDirectory()) {
    fail("missing directory " + relativePath);
  }
  return directoryPath;
}

function assertOnlyKeys(value, allowed, label) {
  if (!isObject(value)) {
    fail(label + " must be an object");
    return;
  }

  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(label + " contains unsupported field " + key);
    }
  }
}

function isInside(parentDir, childPath) {
  const relative = path.relative(parentDir, childPath);
  return (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

const forbiddenDirectoryNames = new Set([
  "node_modules",
  ".cache",
  "__pycache__",
  ".pytest_cache",
  ".ruff_cache",
  "DerivedData",
  ".build",
  "build",
  "dist",
  "coverage",
  ".swiftpm",
  "xcuserdata",
]);
const forbiddenFileNames = new Set([
  ".DS_Store",
  ".env",
  "npm-debug.log",
  "yarn-error.log",
]);

function walk(root) {
  const files = [];
  if (!fs.existsSync(root)) {
    return files;
  }

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    const stat = fs.lstatSync(entryPath);
    const relative = path.relative(repoRoot, entryPath);

    if (stat.isSymbolicLink()) {
      fail("distribution contains symlink: " + relative);
      continue;
    }

    if (stat.isDirectory()) {
      if (forbiddenDirectoryNames.has(entry.name)) {
        fail("distribution contains generated or cache directory: " + relative);
        continue;
      }
      files.push(...walk(entryPath));
      continue;
    }

    if (!stat.isFile()) {
      fail("distribution contains non-regular file: " + relative);
      continue;
    }

    if (
      forbiddenFileNames.has(entry.name) ||
      /\.(?:xcresult|xcuserstate|pyc|pyo)$/u.test(entry.name)
    ) {
      fail("distribution contains generated or cache file: " + relative);
      continue;
    }
    files.push(entryPath);
  }
  return files;
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function requirePattern(text, pattern, label) {
  if (!pattern.test(text)) {
    fail(label);
  }
}

function requireAllPatterns(text, checks) {
  for (const [pattern, label] of checks) {
    requirePattern(text, pattern, label);
  }
}

function textLike(filePath) {
  return /\.(?:md|json|mjs|js|ts|tsx|jsx|swift|yaml|yml|svg|txt|plist|pbxproj)$/u.test(
    filePath,
  );
}

for (const relativePath of [
  ".codex-plugin/plugin.json",
  "README.md",
  "LICENSE",
  "assets/icon.svg",
  "scripts/native-port.mjs",
]) {
  requireFile(relativePath);
}
requireDirectory("fixtures/synthetic");
requireRepoFile("scripts/validate-react-native-to-swiftui.mjs");
const workflowPath = requireRepoFile(".github/workflows/react-native-to-swiftui.yml");

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
      "privacyPolicyURL",
      "termsOfServiceURL",
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
    fail("manifest must expose ./skills/");
  }
  if (manifest.mcpServers !== undefined || manifest.apps !== undefined) {
    fail("v0.1.0 must not declare MCP servers or apps");
  }
  if (manifest.interface?.category !== "Developer Tools") {
    fail("manifest category must be Developer Tools");
  }
  if (
    JSON.stringify(manifest.interface?.capabilities) !==
    JSON.stringify(["Read", "Write"])
  ) {
    fail("manifest capabilities must be exactly Read and Write");
  }
  if (
    !Array.isArray(manifest.interface?.defaultPrompt) ||
    manifest.interface.defaultPrompt.length === 0 ||
    manifest.interface.defaultPrompt[0] !== safeFirstPrompt
  ) {
    fail("manifest default prompt must begin with the read-only planning flow");
  }
  if (manifest.interface?.logo !== "./assets/icon.svg") {
    fail("manifest logo must point to ./assets/icon.svg");
  }
}

for (const forbiddenPath of [".mcp.json", ".app.json", "mcp", "apps"]) {
  if (fs.existsSync(path.join(pluginRoot, forbiddenPath))) {
    fail("v0.1.0 must not contain " + forbiddenPath);
  }
}

const marketplace = readJson(marketplacePath, "marketplace");
const marketplaceEntry = marketplace?.plugins?.find(
  (entry) => entry.name === pluginName,
);
if (!marketplaceEntry) {
  fail("marketplace entry is missing");
} else {
  if (marketplaceEntry.source?.source !== "local") {
    fail("marketplace source must be local");
  }
  if (marketplaceEntry.source?.path !== "./plugins/" + pluginName) {
    fail("marketplace source path is wrong");
  }
  if (marketplaceEntry.policy?.installation !== "AVAILABLE") {
    fail("marketplace installation policy must be AVAILABLE");
  }
  if (marketplaceEntry.policy?.authentication !== "ON_USE") {
    fail("marketplace authentication policy must be ON_USE");
  }
  if (marketplaceEntry.category !== "Developer Tools") {
    fail("marketplace category must be Developer Tools");
  }
}

const skillTexts = new Map();
for (const skillName of requiredSkills) {
  const skillPath = requireFile(path.join("skills", skillName, "SKILL.md"));
  const agentPath = requireFile(
    path.join("skills", skillName, "agents", "openai.yaml"),
  );

  if (fs.existsSync(skillPath)) {
    const skillText = readText(skillPath);
    skillTexts.set(skillName, skillText);
    const frontmatter = skillText.match(/^---\r?\n([\s\S]*?)\r?\n---/u);
    if (!frontmatter) {
      fail(skillName + " SKILL.md needs YAML frontmatter");
    } else {
      requirePattern(
        frontmatter[1],
        new RegExp("^name:\\s*" + skillName + "\\s*$", "mu"),
        skillName + " SKILL.md name must match its folder",
      );
      requirePattern(
        frontmatter[1],
        /^description:\s*\S.+$/mu,
        skillName + " SKILL.md needs a non-empty description",
      );
    }
  }

  if (fs.existsSync(agentPath)) {
    const agentText = readText(agentPath);
    requireAllPatterns(agentText, [
      [/^interface:\s*$/mu, skillName + " metadata needs interface"],
      [
        /^\s{2}display_name:\s*\S.+$/mu,
        skillName + " metadata needs interface.display_name",
      ],
      [
        /^\s{2}short_description:\s*\S.+$/mu,
        skillName + " metadata needs interface.short_description",
      ],
      [
        /^\s{2}default_prompt:\s*\S.+$/mu,
        skillName + " metadata needs interface.default_prompt",
      ],
      [/^policy:\s*$/mu, skillName + " metadata needs policy"],
      [
        /^\s{2}allow_implicit_invocation:\s*false\s*$/mu,
        skillName + " must disable implicit invocation",
      ],
    ]);
  }
}

const readmePath = path.join(pluginRoot, "README.md");
const readme = fs.existsSync(readmePath) ? readText(readmePath) : "";
requireAllPatterns(readme, [
  [/^## Safe first run\s*$/mu, "README is missing a safe first run section"],
  [
    /^## .*Permissions.*authentication.*$/imu,
    "README is missing permissions and authentication guidance",
  ],
  [
    /^## .*data boundar(?:y|ies).*$/imu,
    "README is missing data-boundary guidance",
  ],
  [/^## .*Accessibility.*$/imu, "README is missing accessibility guidance"],
  [/^## Limitations\s*$/imu, "README is missing a limitations section"],
]);
requireAllPatterns(readme, [
  [/\$plan-react-native-port/u, "README must show the planning skill"],
  [/Do not edit files yet\./u, "README safe first run must be read-only"],
  [/\bread\b/iu, "README must explain Read capability"],
  [/\bwrite\b/iu, "README must explain Write capability"],
  [/\bON_USE\b/u, "README must explain ON_USE authentication"],
  [
    /(?:explicit(?:ly)?(?: (?:approved|declared))?|approved)\s+target directory/iu,
    "README must bound writes to an approved target directory",
  ],
  [
    /(?:VoiceOver|Dynamic Type|accessibility label)/iu,
    "README must cover accessibility",
  ],
  [
    /(?:not a generic transpiler|bounded)/iu,
    "README must explain the bounded limitation",
  ],
  [
    /(?:App Store[\s\S]{0,100}(?:not guarantee|no guarantee|does not guarantee|cannot guarantee|does not promise)|(?:not guarantee|no guarantee|does not guarantee|cannot guarantee|does not promise)[\s\S]{0,100}App Store)/iu,
    "README must avoid promising App Store approval",
  ],
]);

const planSkill = skillTexts.get("plan-react-native-port") ?? "";
requireAllPatterns(planSkill, [
  [/read[- ]only/iu, "planning skill must say it is read-only"],
  [
    /do not (?:edit|write|modify|create|change)/iu,
    "planning skill must prohibit edits",
  ],
  [
    /declared (?:React Native )?(?:feature|source|scope)/iu,
    "planning skill must stay within declared source scope",
  ],
  [/parity contract/iu, "planning skill must produce a parity contract"],
]);

const portSkill = skillTexts.get("port-react-native-slice") ?? "";
requireAllPatterns(portSkill, [
  [
    /explicitly approved (?:feature )?slice/iu,
    "port skill must require an explicitly approved slice",
  ],
  [
    /(?:explicit(?:ly)?(?: (?:approved|declared))?|approved)\s+target directory/iu,
    "port skill must require an approved target directory",
  ],
  [
    /(?:do not overwrite|preserve)\s+(?:unrelated )?Swift/iu,
    "port skill must preserve unrelated Swift files",
  ],
  [
    /pure Swift[\s\S]{0,160}(?:(?:separate|separated)[\s\S]{0,120}(?:SwiftUI|UIKit)|(?:no|without)[\s\S]{0,60}(?:SwiftUI|UIKit))/iu,
    "port skill must keep pure Swift logic separate from UI frameworks",
  ],
]);

const verifySkill = skillTexts.get("verify-swiftui-parity") ?? "";
requireAllPatterns(verifySkill, [
  [
    /(?:Xcode|xcodebuild)/u,
    "verification skill must cover Xcode checks",
  ],
  [
    /(?:Simulator|simulator|XCUITest)/u,
    "verification skill must cover Simulator or XCUITest checks",
  ],
  [
    /(?:\bavailable\b|\bunavailable\b)/iu,
    "verification skill must handle unavailable platform tooling",
  ],
]);

const auditSkill = skillTexts.get("audit-ios-readiness") ?? "";
requireAllPatterns(auditSkill, [
  [/App Store/u, "readiness skill must cover App Store preflight"],
  [
    /(?:not guarantee|no guarantee|does not guarantee|cannot guarantee)/iu,
    "readiness skill must not promise approval",
  ],
]);

const nativePortPath = path.join(pluginRoot, "scripts", "native-port.mjs");
const nativePort = fs.existsSync(nativePortPath) ? readText(nativePortPath) : "";
requireAllPatterns(nativePort, [
  [/--target-dir/u, "native-port CLI must require --target-dir for writes"],
  [
    /(?:path\.relative|relative\s*\()/u,
    "native-port CLI must check target containment",
  ],
  [
    /(?:outside|inside|within|escape)/iu,
    "native-port CLI must reject target escapes clearly",
  ],
  [
    /(?:xcodebuild|xcrun)/u,
    "native-port CLI must probe Xcode or Simulator tooling",
  ],
  [
    /(?:unavailable|not found|missing|requires Xcode)/iu,
    "native-port CLI must fail clearly when platform tooling is missing",
  ],
  [
    /backendContract/u,
    "native-port CLI must require an explicit backend contract",
  ],
  [
    /parityExpectations/u,
    "native-port CLI must require explicit parity expectations",
  ],
  [
    /AMBIGUOUS_TARGET/u,
    "native-port CLI must fail closed on ambiguous targets",
  ],
  [
    /structuralOnly/u,
    "native-port CLI must not overclaim structural checks as parity proof",
  ],
]);
if (
  /(?:brew\s+install|xcode-select\s+--install|xcodebuild\s+-license\s+accept|softwareupdate|sudo\s+)/u.test(
    nativePort,
  )
) {
  fail("native-port CLI must not install platform tooling or accept licenses");
}

const fixtureContract = readJson(
  path.join(
    pluginRoot,
    "fixtures",
    "synthetic",
    "stable-counter",
    "approved-contract.json",
  ),
  "synthetic approved contract",
);
if (fixtureContract) {
  if (!isNonEmptyString(fixtureContract.backendContract)) {
    fail("synthetic approved contract must include backendContract");
  }
  if (!isNonEmptyString(fixtureContract.licensing)) {
    fail("synthetic approved contract must include licensing");
  }
  if (
    !Array.isArray(fixtureContract.parityExpectations) ||
    fixtureContract.parityExpectations.length === 0
  ) {
    fail("synthetic approved contract must include parityExpectations");
  }
}

if (fs.existsSync(workflowPath)) {
  const workflow = readText(workflowPath);
  requireAllPatterns(workflow, [
    [
      /native-port\.mjs\s+toolchain/u,
      "master plugin job must run the no-install Apple toolchain preflight",
    ],
    [
      /name:\s+React Native to SwiftUI E2E/u,
      "workflow must expose one plugin-level E2E check",
    ],
    [
      /Full React Native to SwiftUI qualification \/ Node 22\.19\.0/u,
      "master job must run the full Node 22.19 qualification",
    ],
    [
      /Full uninstrumented suite \/ Node 24/u,
      "master job must keep Node 24 compatibility inside one check",
    ],
    [
      /Full uninstrumented suite \/ Node 26/u,
      "master job must keep Node 26 compatibility inside one check",
    ],
    [
      /npm run test:react-native-to-swiftui/u,
      "workflow must invoke the plugin master test suite",
    ],
  ]);
  const jobsText = workflow.split(/\njobs:\s*\n/u)[1] ?? "";
  const jobNames = [...jobsText.matchAll(/^  ([a-z][a-z0-9-]*):\s*$/gmu)].map(
    (match) => match[1],
  );
  if (
    jobNames.length !== 1 ||
    jobNames[0] !== "react-native-to-swiftui-e2e"
  ) {
    fail("workflow must contain exactly one react-native-to-swiftui-e2e job");
  }
}

const pluginFiles = walk(pluginRoot);
if (!pluginFiles.some((file) => path.relative(pluginRoot, file).startsWith("fixtures" + path.sep + "synthetic" + path.sep))) {
  fail("fixtures/synthetic must contain an owned fixture");
}

const publicFiles = [
  path.join(repoRoot, "README.md"),
  marketplacePath,
  path.join(repoRoot, "package.json"),
  path.join(repoRoot, ".github", "workflows", "react-native-to-swiftui.yml"),
].filter((file) => fs.existsSync(file) && fs.statSync(file).isFile());
const bannedContent = [
  [/\/Users\//u, "personal macOS path"],
  [/\/home\/[A-Za-z0-9._-]+\//u, "personal Linux path"],
  [/\bfile:\/\//iu, "file URL"],
  [
    /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|[^/\s]+\.(?:internal|corp|local))(?:[:/]|$)/iu,
    "private URL",
  ],
  [/\b(?:git@|ssh:\/\/)[^\s]+/u, "private repository-style URL"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/u, "private key"],
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u, "GitHub token"],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/u, "API key"],
  [/\bAKIA[0-9A-Z]{16}\b/u, "AWS access key"],
  [
    /\b(?:password|api[_-]?key|secret|token)\s*[:=]\s*["'][^"'\s]{8,}["']/iu,
    "credential assignment",
  ],
  [/hexsplash/iu, "private demo identifier"],
];
for (const file of [...pluginFiles, ...publicFiles]) {
  if (!textLike(file)) {
    continue;
  }
  const relative = path.relative(repoRoot, file);
  const content = readText(file);
  for (const [pattern, label] of bannedContent) {
    if (pattern.test(content)) {
      fail("distribution scan found " + label + " in " + relative);
    }
  }
}

for (const file of pluginFiles.filter((candidate) => candidate.endsWith(".mjs"))) {
  const source = readText(file);
  const importPattern =
    /(?:import\s+(?:[^"'()]+?\s+from\s+)?|export\s+[^"'()]+?\s+from\s+|import\s*\()\s*["']([^"']+)["']/gu;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (specifier.startsWith("node:")) {
      continue;
    }
    if (!specifier.startsWith(".")) {
      fail(
        "packaged runtime must not require node_modules: " +
          path.relative(repoRoot, file) +
          " imports " +
          specifier,
      );
      continue;
    }
    const resolved = path.resolve(path.dirname(file), specifier);
    if (!isInside(pluginRoot, resolved)) {
      fail(
        "packaged runtime import escapes the plugin: " +
          path.relative(repoRoot, file) +
          " imports " +
          specifier,
      );
    }
  }
}

const testsRoot = path.join(repoRoot, "tests", pluginName);
if (!fs.existsSync(testsRoot) || !fs.statSync(testsRoot).isDirectory()) {
  fail("missing tests/" + pluginName);
} else {
  requireRepoFile(path.join("tests", pluginName, "README.md"));
  for (const group of ["unit", "integration", "security"]) {
    const groupPath = path.join(testsRoot, group);
    if (!fs.existsSync(groupPath) || !fs.statSync(groupPath).isDirectory()) {
      fail("tests/" + pluginName + " must include " + group + "/");
      continue;
    }
    if (!walk(groupPath).some((file) => file.endsWith(".test.mjs"))) {
      fail("tests/" + pluginName + "/" + group + " must contain a .test.mjs file");
    }
  }
  const packageJsonText = readText(path.join(repoRoot, "package.json"));
  for (const group of ["unit", "integration", "security"]) {
    if (!packageJsonText.includes("tests/" + pluginName + "/" + group + "/*.test.mjs")) {
      fail("test dispatch must include tests/" + pluginName + "/" + group + "/*.test.mjs");
    }
  }
  if (
    !fs.existsSync(path.join(testsRoot, "integration", "swift-demo.test.mjs"))
  ) {
    fail("integration suite must include the synthetic Swift demo E2E test");
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error("ERROR " + error);
  }
  process.exit(1);
}

console.log("React Native to SwiftUI validation passed.");
