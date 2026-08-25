import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const pluginDir = path.join(repoRoot, "plugins", "react-native-to-swiftui");

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

test("distribution has no symlinks, caches, generated artifacts, or dependencies", () => {
  for (const file of walk(pluginDir)) {
    const relative = path.relative(pluginDir, file);
    const stats = fs.lstatSync(file);
    assert.equal(stats.isSymbolicLink(), false, "symlink rejected: " + relative);
    assert.doesNotMatch(relative, /(^|\/)(node_modules|\.cache|__pycache__|\.DS_Store|dist|build)(\/|$)/);
    if (!stats.isDirectory()) {
      assert.ok(stats.isFile(), "only regular files are packaged: " + relative);
    }
  }
});

test("public plugin contains no private paths, private source names, or secret-shaped material", () => {
  const forbidden = [
    /\/Users\//,
    /HexSplash/i,
    /react-to-swift-demo/i,
    /(?:ghp_|github_pat_|sk-[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{20,})/,
    /(?:password|secret|token|api[_-]?key)\s*[:=]\s*["'][^"']+["']/i,
    /https?:\/\/[^\s"')]+(?:\.internal|\.local|privatelink)/i,
  ];

  for (const file of walk(pluginDir)) {
    if (!fs.lstatSync(file).isFile()) {
      continue;
    }
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, "forbidden material in " + path.relative(pluginDir, file));
    }
  }
});

test("planning skill is explicitly read-only and porting skill bounds writes", () => {
  const planning = fs.readFileSync(
    path.join(pluginDir, "skills", "plan-react-native-port", "SKILL.md"),
    "utf8",
  );
  const porting = fs.readFileSync(
    path.join(pluginDir, "skills", "port-react-native-slice", "SKILL.md"),
    "utf8",
  );

  assert.match(planning, /read-only/i);
  assert.match(planning, /Do not edit|do not edit/i);
  assert.match(planning, /declared React Native/i);
  assert.match(porting, /explicit target directory/i);
  assert.match(porting, /do not overwrite unrelated Swift files/i);
  assert.match(porting, /approved feature slice/i);
});
