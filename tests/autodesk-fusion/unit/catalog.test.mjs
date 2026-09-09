import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { inside, packageLaunch, readJson, REPOSITORY_ROOT, SOURCE_PLUGIN_ROOT } from "../support/packaged-client.mjs";

test("marketplace entry resolves the fixture-first Fusion package with optional authentication", () => {
  const marketplace = readJson(path.join(REPOSITORY_ROOT, ".agents/plugins/marketplace.json"));
  const entries = marketplace.plugins.filter(entry => entry.name === "autodesk-fusion");
  assert.equal(entries.length, 1, "The public package must have one unambiguous catalog entry");
  const entry = entries[0];
  assert.deepEqual(entry.source, { source: "local", path: "./plugins/autodesk-fusion" });
  assert.deepEqual(entry.policy, { installation: "AVAILABLE", authentication: "ON_USE" });
  const pluginRoot = inside(REPOSITORY_ROOT, entry.source.path);
  const manifest = readJson(path.join(pluginRoot, ".codex-plugin/plugin.json"));
  const packageJson = readJson(path.join(pluginRoot, "package.json"));
  assert.equal(manifest.name, entry.name);
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.license, packageJson.license);
  assert.equal(manifest.interface.category, entry.category);
  assert.deepEqual(manifest.interface.capabilities, ["Read", "Write"]);
  assert.equal(manifest.apps, undefined, "Fixture startup must not depend on an installed connector");
  assert.match(manifest.interface.defaultPrompt[0], /^Use \$setup-autodesk-fusion\b/u);
  assert.match(manifest.interface.defaultPrompt[0], /without changing a model/u);
  packageLaunch(pluginRoot);
});

test("every advertised skill, icon and local guide is contained in the installable package", () => {
  const manifest = readJson(path.join(SOURCE_PLUGIN_ROOT, ".codex-plugin/plugin.json"));
  for (const icon of [manifest.interface.logo, manifest.interface.composerIcon]) {
    assert.ok(lstatSync(inside(SOURCE_PLUGIN_ROOT, icon)).isFile());
  }
  const skillsRoot = inside(SOURCE_PLUGIN_ROOT, manifest.skills);
  const skillNames = readdirSync(skillsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  for (const prompt of manifest.interface.defaultPrompt) {
    const skill = /\$([a-z0-9-]+)/u.exec(prompt)?.[1];
    assert.ok(skillNames.includes(skill), `Advertised prompt must resolve to a shipped skill: ${skill}`);
  }
  const guides = [path.join(SOURCE_PLUGIN_ROOT, "README.md")];
  for (const name of skillNames) {
    const directory = inside(skillsRoot, name);
    const filename = path.join(directory, "SKILL.md");
    const markdown = readFileSync(filename, "utf8");
    assert.match(markdown, new RegExp(`^---\\r?\\nname: ${name}\\r?\\ndescription: .+\\r?\\n---`, "u"));
    assert.ok(readFileSync(path.join(directory, "agents/openai.yaml"), "utf8").includes(`$${name}`));
    guides.push(filename);
  }
  for (const filename of guides) {
    for (const match of readFileSync(filename, "utf8").matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/gu)) {
      if (/^[a-z][a-z0-9+.-]*:/iu.test(match[1])) continue;
      const target = path.resolve(path.dirname(filename), match[1]);
      assert.equal(inside(SOURCE_PLUGIN_ROOT, path.relative(SOURCE_PLUGIN_ROOT, target)), target);
      assert.ok(existsSync(target), `Missing packaged guide: ${match[1]}`);
    }
  }
});
