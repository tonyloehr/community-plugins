import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const SOURCE_PLUGIN_ROOT = path.join(REPOSITORY_ROOT, "plugins/autodesk-fusion");
export const DOCUMENT_ID = "fixture:bracket";

export function readJson(filename) {
  return JSON.parse(readFileSync(filename, "utf8"));
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// An explicit private fixture profile is always passed. Never inherit the
// caller's Autodesk profile, tokens, Node preload hooks, or proxy settings.
export function isolatedEnvironment(profileFile) {
  const env = { LANG: "C", TZ: "UTC" };
  for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TMPDIR", "TMP", "TEMP"]) {
    if (typeof process.env[key] === "string") env[key] = process.env[key];
  }
  if (profileFile) env.FUSION_PROFILE = profileFile;
  return env;
}

export function inside(root, relative) {
  assert.equal(path.isAbsolute(relative), false, "Package references must be relative");
  const resolved = path.resolve(root, relative);
  const difference = path.relative(root, resolved);
  assert.ok(difference !== ".." && !difference.startsWith(`..${path.sep}`) && !path.isAbsolute(difference));
  return resolved;
}

export function packageLaunch(pluginRoot) {
  const manifest = readJson(path.join(pluginRoot, ".codex-plugin/plugin.json"));
  const configuration = readJson(inside(pluginRoot, manifest.mcpServers));
  assert.deepEqual(Object.keys(configuration.mcpServers), [manifest.name]);
  const launch = configuration.mcpServers[manifest.name];
  assert.equal(launch.command, "node");
  assert.deepEqual(launch.args, ["./mcp/server.mjs"]);
  assert.deepEqual(launch.env_vars, ["FUSION_PROFILE"]);
  assert.equal(launch.env, undefined);
  const cwd = inside(pluginRoot, launch.cwd);
  assert.ok(lstatSync(inside(cwd, launch.args[0])).isFile());
  return { command: process.execPath, args: launch.args, cwd };
}

export function assertNoAncestorDependencies(pluginRoot) {
  for (let directory = pluginRoot; ; directory = path.dirname(directory)) {
    assert.equal(existsSync(path.join(directory, "node_modules")), false, `Dependency directory at ${directory}`);
    if (directory === path.dirname(directory)) break;
  }
}

export function snapshotTree(root) {
  if (!existsSync(root)) return null;
  const entries = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, entry.name);
      const relative = path.relative(root, filename);
      const info = lstatSync(filename);
      assert.equal(info.isSymbolicLink(), false, `Unexpected link in test-owned tree: ${relative}`);
      if (info.isDirectory()) {
        entries.push([relative, "directory"]);
        visit(filename);
      } else {
        assert.ok(info.isFile(), `Unexpected file type: ${relative}`);
        entries.push([relative, sha256(readFileSync(filename))]);
      }
    }
  }
  visit(root);
  return entries;
}

export function runCli(sandbox, args, { timeoutMs = 20_000 } = {}) {
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 20_000, "CLI test timeoutMs must be an integer from 100 through 20000");
  const result = spawnSync(process.execPath, [path.join(sandbox.pluginRoot, "scripts/fusionctl.mjs"), ...args], {
    cwd: sandbox.unrelatedCwd,
    env: isolatedEnvironment(sandbox.profileFile),
    encoding: "utf8",
    timeout: timeoutMs,
    // spawnSync otherwise keeps waiting when a child handles SIGTERM, blocking
    // the test runner's own timers and teardown. This process is test-owned.
    killSignal: "SIGKILL",
    maxBuffer: 4_194_304,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, "The CLI must finish without forced termination");
  return result;
}

export function createSandbox(t, { configure } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "community fusion package ")));
  const clients = new Set();
  const sandbox = {
    root,
    pluginRoot: path.join(root, "Autodesk Fusion"),
    stateRoot: path.join(root, "private-state"),
    artifactRoot: path.join(root, "private-artifacts"),
    profileFile: path.join(root, "fixture-profile.json"),
    unrelatedCwd: path.join(root, "unrelated-cwd"),
    async start() {
      const client = new McpClient(sandbox.pluginRoot, sandbox.profileFile);
      clients.add(client);
      await client.initialize();
      return client;
    },
  };
  t.after(async () => {
    const failures = [];
    for (const client of clients) {
      try {
        assert.deepEqual(await client.close(), { code: 0, signal: null });
        assert.equal(client.stderr, "", "Fixture MCP must not emit unreviewed diagnostics");
      } catch (error) { failures.push(error); }
    }
    if (failures.length) {
      t.diagnostic(`Packaged client cleanup failed; test-owned evidence retained at ${root}`);
      throw new AggregateError(failures, "Packaged client cleanup failed");
    }
    // Remove only this invocation's tree after every owned process is confirmed
    // closed. Uncertain cleanup must not erase a still-running child's evidence.
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  cpSync(SOURCE_PLUGIN_ROOT, sandbox.pluginRoot, {
    recursive: true,
    dereference: false,
    filter: filename => !["node_modules", "src", "tests", "__pycache__", ".cache"].includes(path.basename(filename)),
  });
  mkdirSync(sandbox.unrelatedCwd, { mode: 0o700 });
  assertNoAncestorDependencies(sandbox.pluginRoot);

  // Use the shipped setup command, then scope its generated fixture profile to
  // this test's disposable directories before starting any runtime. profile-init
  // writes configuration only; it does not initialize the default state root.
  const initialized = runCli(sandbox, ["profile-init", "--mode", "fixture", "--output", sandbox.profileFile]);
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(initialized.stderr, "");
  assert.equal(JSON.parse(initialized.stdout).mode, "fixture");
  const profile = readJson(sandbox.profileFile);
  assert.equal(profile.mode, "fixture");
  profile.stateRoot = sandbox.stateRoot;
  profile.outputs = [{ id: "artifacts", path: sandbox.artifactRoot }];
  configure?.(profile);
  assert.equal(profile.mode, "fixture", "Root package tests must remain synthetic");
  assert.equal(profile.desktop, undefined, "No desktop provider is authorized by these tests");
  assert.equal(profile.cloud, undefined, "No cloud provider is authorized by these tests");
  writeFileSync(sandbox.profileFile, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  sandbox.profile = profile;
  assert.equal(existsSync(sandbox.stateRoot), false);
  return sandbox;
}

function boundedWait(promise, milliseconds) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(undefined), milliseconds); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Dependency-free legacy JSON-RPC client against the actual packaged launcher. */
export class McpClient {
  #child;
  #pending = new Map();
  #nextId = 1;
  #buffer = "";
  #outputBytes = 0;
  #exit;
  #closed;
  #failure;
  #closing = false;
  stderr = "";
  initialization;

  constructor(pluginRoot, profileFile) {
    const launch = packageLaunch(pluginRoot);
    this.#child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: isolatedEnvironment(profileFile),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stdout.on("data", chunk => this.#receive(chunk));
    this.#child.stderr.on("data", chunk => {
      if (Buffer.byteLength(this.stderr) + Buffer.byteLength(chunk) > 65_536) {
        this.#fail(new Error("MCP stderr exceeded its test bound"));
        this.#child.kill("SIGTERM");
      } else this.stderr += chunk;
    });
    this.#child.on("error", error => this.#fail(error));
    this.#child.stdin.on("error", error => this.#fail(error));
    this.#closed = new Promise(resolve => {
      this.#child.once("close", (code, signal) => {
        this.#exit = { code, signal };
        if (!this.#closing || this.#pending.size) this.#fail(new Error(`MCP closed before completion (${code ?? signal})`));
        resolve(this.#exit);
      });
    });
  }

  async initialize() {
    this.initialization = await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "community-fusion-packaged-test", version: "1.0.0" },
    });
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  }

  #fail(error) {
    this.#failure ??= error;
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.#pending.clear();
  }

  #receive(chunk) {
    this.#outputBytes += Buffer.byteLength(chunk);
    this.#buffer += chunk;
    if (this.#outputBytes > 16_777_216 || Buffer.byteLength(this.#buffer) > 8_388_608) {
      this.#fail(new Error("MCP output exceeded its bounded test budget"));
      this.#child.kill("SIGTERM");
      return;
    }
    let end;
    while ((end = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, end).replace(/\r$/u, "");
      this.#buffer = this.#buffer.slice(end + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
        assert.equal(message.jsonrpc, "2.0");
        assert.ok(Object.hasOwn(message, "id"), "Unexpected server request or notification");
        assert.ok(this.#pending.has(message.id), "Response must match one outstanding request");
      } catch (cause) {
        this.#fail(new Error("Unexpected non-response on MCP stdout", { cause }));
        this.#child.kill("SIGTERM");
        return;
      }
      const pending = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message);
        error.code = message.error.code;
        pending.reject(error);
      } else pending.resolve(message.result);
    }
  }

  request(method, params = {}) {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#exit || this.#closing) return Promise.reject(new Error("MCP client is closed"));
    assert.ok(this.#nextId <= 128, "Test exceeded its bounded request count");
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#fail(new Error(`MCP request timed out: ${method}`));
        this.#child.kill("SIGTERM");
      }, 20_000);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  callTool(name, args = {}) {
    return this.request("tools/call", { name, arguments: args });
  }

  async close() {
    this.#closing = true;
    if (!this.#exit) this.#child.stdin.end();
    if (!this.#exit) await boundedWait(this.#closed, 3_000);
    if (!this.#exit) { this.#child.kill("SIGTERM"); await boundedWait(this.#closed, 2_000); }
    if (!this.#exit) { this.#child.kill("SIGKILL"); await boundedWait(this.#closed, 2_000); }
    assert.ok(this.#exit, "MCP child did not finish after bounded cleanup");
    assert.equal(this.#buffer.trim(), "", "MCP emitted an incomplete final message");
    if (this.#failure) throw this.#failure;
    return this.#exit;
  }
}

export function toolData(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent ?? result.content));
  assert.ok(result.structuredContent && typeof result.structuredContent === "object");
  assert.deepEqual(JSON.parse(result.content.find(item => item.type === "text").text), result.structuredContent);
  return result.structuredContent;
}

export function toolError(result, code) {
  assert.equal(result.isError, true, "A denied tool request must be explicitly unsuccessful");
  const data = result.structuredContent ?? JSON.parse(result.content.find(item => item.type === "text").text);
  assert.equal(data.error?.code, code, JSON.stringify(data));
  return data.error;
}

export function widthRequest(state, expression = "5 cm") {
  return {
    operation: "parameters.set",
    document_id: DOCUMENT_ID,
    expected_state: state,
    args: { changes: [{ parameter_id: "fixture:param:width", expression }] },
  };
}

export async function inspectDocument(client) {
  return toolData(await client.callTool("fusion_document_inspect", { document_id: DOCUMENT_ID, args: {} }));
}

export function parameter(observation, name) {
  const matches = observation.data.parameters.filter(item => item.name === name);
  assert.equal(matches.length, 1, `Expected exactly one fixture parameter: ${name}`);
  return matches[0];
}
