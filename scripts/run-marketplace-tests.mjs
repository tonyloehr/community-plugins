#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const marketplacePath = path.join(
  repoRoot,
  ".agents",
  "plugins",
  "marketplace.json",
);
const packagePath = path.join(repoRoot, "package.json");

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.error(`ERROR ${label} is not valid JSON: ${error.message}`);
    process.exit(1);
  }
}

const marketplace = readJson(marketplacePath, "marketplace");
const packageJson = readJson(packagePath, "package.json");
const scripts = packageJson.scripts ?? {};

if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
  console.error("ERROR marketplace must include at least one plugin");
  process.exit(1);
}

const testScripts = [];
const missingScripts = [];

for (const entry of marketplace.plugins) {
  const scriptName = `test:${entry.name}`;
  if (typeof scripts[scriptName] !== "string" || scripts[scriptName].trim() === "") {
    missingScripts.push(scriptName);
  } else {
    testScripts.push(scriptName);
  }
}

if (missingScripts.length > 0) {
  for (const scriptName of missingScripts) {
    console.error(`ERROR package.json is missing script "${scriptName}"`);
  }
  process.exit(1);
}

// npm.cmd cannot be launched directly by spawnSync on Windows. Reuse npm's
// existing lifecycle entry point through this Node executable on every OS,
// without a shell, PATH fallback or changes to inherited npm configuration.
// These are launch prerequisites, not authentication of the npm installation.
const npmExecPath = process.env.npm_execpath;
let npmCli;
try {
  if (
    typeof process.env.npm_lifecycle_event === "string" &&
    process.env.npm_lifecycle_event.trim() !== "" &&
    typeof npmExecPath === "string" &&
    path.isAbsolute(npmExecPath)
  ) {
    const resolved = fs.realpathSync(npmExecPath);
    if (path.basename(resolved) === "npm-cli.js" && fs.statSync(resolved).isFile()) {
      npmCli = resolved;
    }
  }
} catch {
  // Report the same actionable diagnostic for a missing or unusable path.
}
if (!npmCli) {
  console.error(
    "ERROR this runner requires an npm lifecycle with an absolute npm_execpath resolving to a regular npm-cli.js. Run npm run test:marketplace (or npm test) from the repository root; direct Node launch and PATH fallback are not supported.",
  );
  process.exit(1);
}

for (const scriptName of testScripts) {
  console.log(`\n> Running ${scriptName}`);
  const result = spawnSync(process.execPath, [npmCli, "run", scriptName], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`ERROR failed to start ${scriptName}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`ERROR ${scriptName} failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

console.log(`\nMarketplace plugin tests passed (${testScripts.length} plugin${
  testScripts.length === 1 ? "" : "s"
}).`);
