#!/usr/bin/env node

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

const installPolicies = new Set([
  "NOT_AVAILABLE",
  "AVAILABLE",
  "INSTALLED_BY_DEFAULT",
]);
const authPolicies = new Set(["ON_INSTALL", "ON_USE"]);

const errors = [];
const warnings = [];

function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
    return null;
  }
}

function walkFiles(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const results = [];
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(entryPath));
    } else if (entry.isFile()) {
      results.push(entryPath);
    }
  }
  return results;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isKebabName(value) {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function relativeSourcePath(sourcePath) {
  if (typeof sourcePath !== "string") {
    return null;
  }

  if (!sourcePath.startsWith("./")) {
    return null;
  }

  const resolved = path.resolve(repoRoot, sourcePath);
  const relative = path.relative(repoRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  return resolved;
}

function validatePluginEntry(entry, index) {
  const label = `plugins[${index}]`;

  if (!isObject(entry)) {
    fail(`${label} must be an object`);
    return;
  }

  if (!isKebabName(entry.name)) {
    fail(`${label}.name must be kebab-case`);
  }

  if (!isObject(entry.source)) {
    fail(`${label}.source must be an object`);
  } else {
    if (entry.source.source !== "local") {
      fail(`${label}.source.source must be "local"`);
    }

    const pluginDir = relativeSourcePath(entry.source.path);
    if (!pluginDir) {
      fail(`${label}.source.path must be a ./-prefixed path inside the repo`);
    } else {
      validatePluginDirectory(entry, pluginDir, label);
    }
  }

  if (!isObject(entry.policy)) {
    fail(`${label}.policy must be an object`);
  } else {
    if (!installPolicies.has(entry.policy.installation)) {
      fail(
        `${label}.policy.installation must be one of ${[
          ...installPolicies,
        ].join(", ")}`,
      );
    }

    if (!authPolicies.has(entry.policy.authentication)) {
      fail(
        `${label}.policy.authentication must be one of ${[
          ...authPolicies,
        ].join(", ")}`,
      );
    }
  }

  if (typeof entry.category !== "string" || entry.category.length === 0) {
    fail(`${label}.category must be a non-empty string`);
  }
}

function validatePluginDirectory(entry, pluginDir, label) {
  if (!fs.existsSync(pluginDir)) {
    fail(`${label}.source.path does not exist: ${entry.source.path}`);
    return;
  }

  const manifestPath = path.join(pluginDir, ".codex-plugin", "plugin.json");
  if (!fs.existsSync(manifestPath)) {
    fail(`${label}.source.path is missing .codex-plugin/plugin.json`);
    return;
  }

  const manifest = readJson(manifestPath, `${label} manifest`);
  if (!manifest) {
    return;
  }

  if (manifest.name !== entry.name) {
    fail(`${label}.name must match manifest name "${manifest.name}"`);
  }

  if (!manifest.version || typeof manifest.version !== "string") {
    fail(`${label} manifest must include a string version`);
  }

  if (!manifest.description || typeof manifest.description !== "string") {
    fail(`${label} manifest must include a string description`);
  }

  if (manifest.skills) {
    const skillsDir = path.resolve(pluginDir, manifest.skills);
    const relative = path.relative(pluginDir, skillsDir);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      fail(`${label} manifest skills path must stay inside the plugin folder`);
    } else if (!fs.existsSync(skillsDir)) {
      fail(`${label} manifest skills path does not exist: ${manifest.skills}`);
    } else {
      validateAgentMetadataFiles(skillsDir, label);
    }
  }
}

function validateAgentMetadataFiles(skillsDir, label) {
  for (const filePath of walkFiles(skillsDir)) {
    if (path.basename(filePath) !== "openai.yaml") {
      continue;
    }

    if (path.basename(path.dirname(filePath)) !== "agents") {
      continue;
    }

    const relativePath = path.relative(repoRoot, filePath);
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    const hasInterface = lines.some((line) => line.trim() === "interface:");
    if (!hasInterface) {
      fail(`${label} ${relativePath} must include an interface wrapper`);
    }

    for (const key of ["display_name", "short_description", "default_prompt"]) {
      if (lines.some((line) => line.startsWith(`${key}:`))) {
        fail(`${label} ${relativePath} must nest ${key} under interface`);
      }
    }
  }
}

const marketplace = readJson(marketplacePath, "marketplace");

if (marketplace) {
  if (marketplace.name !== "community-plugins") {
    fail('marketplace.name must be "community-plugins"');
  }

  if (!isObject(marketplace.interface)) {
    fail("marketplace.interface must be an object");
  } else if (marketplace.interface.displayName !== "Community Plugins") {
    fail('marketplace.interface.displayName must be "Community Plugins"');
  }

  if (!Array.isArray(marketplace.plugins)) {
    fail("marketplace.plugins must be an array");
  } else {
    const seen = new Set();
    for (const [index, entry] of marketplace.plugins.entries()) {
      if (isObject(entry) && seen.has(entry.name)) {
        fail(`plugins[${index}].name duplicates "${entry.name}"`);
      }
      if (isObject(entry)) {
        seen.add(entry.name);
      }
      validatePluginEntry(entry, index);
    }

    if (marketplace.plugins.length === 0) {
      warn("marketplace has no plugins yet");
    }
  }
}

for (const message of warnings) {
  console.warn(`WARN ${message}`);
}

if (errors.length > 0) {
  for (const message of errors) {
    console.error(`ERROR ${message}`);
  }
  process.exit(1);
}

console.log("Marketplace validation passed.");
