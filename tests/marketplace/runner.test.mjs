import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runnerSource = fileURLToPath(new URL("../../scripts/run-marketplace-tests.mjs", import.meta.url));
const settingKey = /^(?:npm_config_|https?_proxy$|all_proxy$|no_proxy$)/i;
const settingHash = env => createHash("sha256").update(JSON.stringify(Object.entries(env).filter(([key]) => settingKey.test(key)).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");

// This is a test-owned JavaScript subprocess, not an npm implementation. It
// records the launch boundary and exits without reading npm configuration,
// running package scripts, installing dependencies or contacting a service.
const probeCli = `
import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const guard = setTimeout(() => process.exit(97), 3000);
const args = process.argv.slice(2);
const settings = Object.entries(process.env).filter(([key]) => /^(?:npm_config_|https?_proxy$|all_proxy$|no_proxy$)/i.test(key)).sort(([a], [b]) => a.localeCompare(b));
appendFileSync('invocations.jsonl', JSON.stringify({ pid: process.pid, args, execPath: process.execPath, cwd: process.cwd(), setting_hash: createHash('sha256').update(JSON.stringify(settings)).digest('hex') }) + '\\n');
const behavior = JSON.parse(readFileSync('behavior.json', 'utf8'));
clearTimeout(guard);
process.exit(args.length === 2 && args[0] === 'run' ? (behavior.exitCodes[args[1]] ?? 0) : 96);
`;

function invocations(fixture) {
  const filename = path.join(fixture.root, "invocations.jsonl");
  return existsSync(filename) ? readFileSync(filename, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}

function absent(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === "ESRCH") return true; throw error; }
}

function fixture(t, { names = ["alpha", "beta"], scripts, exitCodes = {} } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "marketplace runner ")));
  const value = { root, runner: path.join(root, "scripts/run-marketplace-tests.mjs"), cli: path.join(root, "npm client & (literal)", "npm-cli.js"), unrelatedCwd: path.join(root, "unrelated cwd"), emptyPath: path.join(root, "empty path"), runners: [], cleanupUncertain: false };
  t.after(async () => {
    if (value.cleanupUncertain) {
      t.diagnostic(`Runner error or forced signal leaves descendant cleanup uncertain; evidence retained at ${root}`);
      assert.fail("Runner-contract cleanup is unconfirmed; recorded PID absence cannot establish all descendants exited");
    }
    const childPids = invocations(value).map(row => row.pid);
    const pids = [...value.runners, ...childPids];
    const deadline = Date.now() + 4000;
    while (pids.some(pid => !absent(pid)) && Date.now() < deadline) await delay(25);
    const present = pids.filter(pid => !absent(pid));
    if (present.length) {
      t.diagnostic(`Owned subprocess absence is unconfirmed; evidence retained at ${root}`);
      assert.fail("Runner-contract subprocess cleanup is unconfirmed");
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    assert.equal(existsSync(root), false);
  });
  for (const directory of [path.join(root, ".agents/plugins"), path.dirname(value.runner), path.dirname(value.cli), value.unrelatedCwd, value.emptyPath]) mkdirSync(directory, { recursive: true });
  copyFileSync(runnerSource, value.runner);
  writeFileSync(path.join(root, ".agents/plugins/marketplace.json"), JSON.stringify({ plugins: names.map(name => ({ name })) }));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ private: true, type: "module", scripts: scripts ?? Object.fromEntries(names.map(name => [`test:${name}`, "a reviewed test script"])) }));
  writeFileSync(path.join(root, "behavior.json"), JSON.stringify({ exitCodes }));
  writeFileSync(value.cli, probeCli);
  return value;
}

function run(fixture, { lifecycle = true, cli = fixture.cli, useInheritedPath = false } = {}) {
  const env = { ...process.env };
  if (!useInheritedPath) {
    // Remove PATH only inside this synthetic subprocess: a PATH fallback must
    // not conceal failure to use the explicitly supplied npm lifecycle CLI.
    for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
    env.PATH = fixture.emptyPath;
  }
  if (lifecycle) env.npm_lifecycle_event = "test:marketplace";
  else delete env.npm_lifecycle_event;
  if (cli === null) delete env.npm_execpath;
  else env.npm_execpath = cli;
  const result = spawnSync(process.execPath, [fixture.runner], {
    cwd: fixture.unrelatedCwd,
    env,
    encoding: "utf8",
    timeout: 10_000,
    killSignal: "SIGKILL",
    maxBuffer: 1_048_576,
    windowsHide: true,
  });
  if (Number.isSafeInteger(result.pid) && result.pid > 1) fixture.runners.push(result.pid);
  if (result.error || result.signal) {
    fixture.cleanupUncertain = true;
    writeFileSync(path.join(fixture.root, "runner-process-failure.json"), JSON.stringify({
      pid: result.pid ?? null, status: result.status, signal: result.signal,
      error: result.error ? { code: result.error.code, name: result.error.name, message: result.error.message } : null,
      stdout: result.stdout, stderr: result.stderr,
      descendant_cleanup_confirmed: false,
    }, null, 2) + "\n", { flag: "wx" });
  }
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, "Runner must finish without forced termination");
  return { ...result, expectedSettingHash: settingHash(env) };
}

test("uses the lifecycle npm CLI through the current Node executable, in catalog order, without PATH lookup", async t => {
  const repo = fixture(t);
  const result = run(repo);
  assert.equal(result.status, 0, result.stderr);
  const rows = invocations(repo);
  assert.deepEqual(rows.map(row => row.args), [["run", "test:alpha"], ["run", "test:beta"]]);
  assert.equal(new Set(rows.map(row => row.pid)).size, 2);
  for (const row of rows) {
    assert.equal(row.execPath, process.execPath);
    assert.equal(row.cwd, repo.root);
    assert.equal(row.setting_hash, result.expectedSettingHash, "Inherited registry/proxy/npm settings changed");
  }
  assert.match(result.stdout, /Marketplace plugin tests passed \(2 plugins\)/);
});

test("passes script names containing shell metacharacters as one literal argument", async t => {
  const name = "literal & echo INJECTION > unwanted-marker";
  const repo = fixture(t, { names: [name] });
  const result = run(repo);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(invocations(repo).map(row => row.args), [["run", `test:${name}`]]);
  assert.equal(existsSync(path.join(repo.root, "unwanted-marker")), false);
});

test("propagates a failing master status and never launches later catalog entries", async t => {
  const repo = fixture(t, { names: ["alpha", "beta", "gamma"], exitCodes: { "test:beta": 23 } });
  const result = run(repo);
  assert.equal(result.status, 23, result.stderr);
  assert.deepEqual(invocations(repo).map(row => row.args[1]), ["test:alpha", "test:beta"]);
  assert.match(result.stderr, /test:beta failed with exit code 23/);
  assert.doesNotMatch(result.stdout, /Marketplace plugin tests passed/);
});

for (const invalid of [undefined, "", "   ", 3, []]) test(`rejects every missing/invalid master before starting any child (${JSON.stringify(invalid)})`, async t => {
  const repo = fixture(t, { names: ["alpha", "beta", "gamma"], scripts: { "test:alpha": "a reviewed script", "test:beta": invalid } });
  const result = run(repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing script "test:beta"/);
  assert.match(result.stderr, /missing script "test:gamma"/);
  assert.deepEqual(invocations(repo), []);
});

test("rejects a malformed or empty catalog before starting any child", async t => {
  for (const catalog of ["{", JSON.stringify({ plugins: [] })]) {
    const repo = fixture(t);
    writeFileSync(path.join(repo.root, ".agents/plugins/marketplace.json"), catalog);
    const result = run(repo);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /marketplace (?:is not valid JSON|must include at least one plugin)/);
    assert.deepEqual(invocations(repo), []);
  }
});

test("requires npm lifecycle launch prerequisites and never falls back to a PATH or command-shell executable", async t => {
  const cases = [
    { cli: null },
    { cli: "npm-cli.js" },
    { lifecycle: false },
    { cliKind: "missing" },
    { cliKind: "directory" },
    { cliKind: "command_file" },
  ];
  for (const options of cases) {
    const repo = fixture(t);
    if (options.cliKind === "missing") options.cli = path.join(repo.root, "missing/npm-cli.js");
    if (options.cliKind === "directory") { options.cli = path.join(repo.root, "a directory/npm-cli.js"); mkdirSync(options.cli, { recursive: true }); }
    if (options.cliKind === "command_file") { options.cli = path.join(repo.root, "npm.cmd"); writeFileSync(options.cli, "This must never be executed.\n"); }
    const result = run(repo, options);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /npm lifecycle/i);
    assert.match(result.stderr, /npm run test:marketplace/);
    assert.deepEqual(invocations(repo), []);
  }
});

function inheritedNpmCli() {
  const value = process.env.npm_execpath;
  if (!process.env.npm_lifecycle_event || typeof value !== "string" || !path.isAbsolute(value)) return null;
  try {
    const resolved = realpathSync(value);
    return path.basename(resolved) === "npm-cli.js" && statSync(resolved).isFile() ? resolved : null;
  } catch { return null; }
}

test("launches actual npm masters under the inherited npm lifecycle without changing npm settings", { skip: inheritedNpmCli() === null ? "Run npm run test:marketplace:runner for the actual npm lifecycle check." : false }, async t => {
  const repo = fixture(t, { scripts: { "test:alpha": "node runner-fixture-child.mjs alpha", "test:beta": "node runner-fixture-child.mjs beta" } });
  writeFileSync(path.join(repo.root, "runner-fixture-child.mjs"), "import { appendFileSync } from 'node:fs'; appendFileSync('invocations.jsonl', JSON.stringify({pid:process.pid, args:process.argv.slice(2), lifecycle:process.env.npm_lifecycle_event})+'\\n');\n");
  const result = run(repo, { cli: inheritedNpmCli(), useInheritedPath: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(invocations(repo).map(row => ({ args: row.args, lifecycle: row.lifecycle })), [
    { args: ["alpha"], lifecycle: "test:alpha" },
    { args: ["beta"], lifecycle: "test:beta" },
  ]);
  assert.match(result.stdout, /Marketplace plugin tests passed \(2 plugins\)/);
});
