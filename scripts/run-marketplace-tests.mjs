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

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

for (const scriptName of testScripts) {
  console.log(`\n> Running ${scriptName}`);
  const result = spawnSync(npmCommand, ["run", scriptName], {
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
