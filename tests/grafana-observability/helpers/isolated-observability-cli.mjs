import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { verifySourceLoader } from "../../../scripts/validate-grafana.mjs";

const KEYRING_SERVICE = "com.openai.codex.observability.grafana";

function within(root, filename) {
  assert.equal(typeof filename, "string", "CLI attempted a non-path filesystem mutation");
  const path = resolve(filename);
  const rel = relative(root, path);
  assert.ok(rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), "CLI attempted to write outside its owned temporary profile root");
  return path;
}

function isWriteOpen(flags) {
  return typeof flags === "number"
    ? (flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND)) !== 0
    : typeof flags === "string" && /[wa+]/u.test(flags);
}

function guardedFilesystem(realFs, root, writes) {
  const descriptors = new Set();
  const admit = (path) => { writes.add(within(root, path)); };
  const guard = { ...realFs };
  const simple = ["appendFile", "chmod", "chown", "lchmod", "lchown", "lutimes", "mkdir", "mkdtemp", "rm", "rmdir", "truncate", "unlink", "utimes"];
  for (const name of simple) {
    for (const suffix of ["", "Sync"]) {
      const key = `${name}${suffix}`;
      if (typeof realFs[key] === "function") guard[key] = (...args) => { admit(args[0]); return realFs[key](...args); };
    }
  }
  for (const name of ["rename", "link", "copyFile", "cp"]) {
    for (const suffix of ["", "Sync"]) {
      const key = `${name}${suffix}`;
      if (typeof realFs[key] === "function") guard[key] = (...args) => { admit(args[0]); admit(args[1]); return realFs[key](...args); };
    }
  }
  for (const name of ["symlink", "symlinkSync"]) {
    if (typeof realFs[name] === "function") guard[name] = () => { throw new Error("CLI test refuses symlink creation"); };
  }
  for (const name of ["writeFile", "writeFileSync", "write", "writeSync", "writev", "writevSync", "fchmod", "fchmodSync", "fchown", "fchownSync", "ftruncate", "ftruncateSync"]) {
    if (typeof realFs[name] !== "function") continue;
    guard[name] = (...args) => {
      if (typeof args[0] === "number") assert.ok(descriptors.has(args[0]), "CLI used an unadmitted writable file descriptor");
      else admit(args[0]);
      return realFs[name](...args);
    };
  }
  if (typeof realFs.openSync === "function") {
    guard.openSync = (path, flags, ...rest) => {
      const write = isWriteOpen(flags);
      if (write) admit(path);
      const fd = realFs.openSync(path, flags, ...rest);
      if (write) descriptors.add(fd);
      return fd;
    };
    guard.closeSync = (fd) => { descriptors.delete(fd); return realFs.closeSync(fd); };
    guard.open = (...args) => {
      if (isWriteOpen(args[1])) throw new Error("CLI test refuses unexpected callback-style writable opens");
      return realFs.open(...args);
    };
    guard.createWriteStream = () => { throw new Error("CLI test refuses unexpected writable streams"); };
  } else {
    // fs/promises FileHandle writes are admitted by their original writable
    // open; a read-only handle cannot later acquire write authority.
    guard.open = (path, flags, ...rest) => {
      if (isWriteOpen(flags)) admit(path);
      return realFs.open(path, flags, ...rest);
    };
  }
  return guard;
}

class ScriptedTty extends EventEmitter {
  isTTY = true;
  raw = false;
  consumed = 0;
  transitions = [];

  constructor(inputs) {
    super();
    this.inputs = inputs.map((input) => Buffer.from(input));
  }

  setRawMode(mode) { this.raw = mode; this.transitions.push(mode); }
  pause() {}
  resume() {
    assert.equal(this.raw, true, "Shipped secret reader did not enter raw mode");
    const input = this.inputs.shift();
    assert.ok(input, "Shipped CLI requested an unexpected interactive input");
    this.consumed += 1;
    queueMicrotask(() => {
      const bytes = Buffer.concat([input, Buffer.from("\n")]);
      try { this.emit("data", bytes); }
      catch { this.emit("error", new Error("Scripted terminal input failed")); }
      finally { input.fill(0); bytes.fill(0); }
    });
  }

  dispose() { for (const input of this.inputs) input.fill(0); this.inputs.length = 0; }
}

/**
 * Loads the integrity-verified shipped CLI with explicit TEST seams: scripted
 * TTY, in-memory native-loader substitute, and module-local homedir override.
 * Never patches global built-ins, HOME, CODEX_HOME, or a real OS keyring entry.
 */
export function createIsolatedObservabilityCli(pluginRoot, sandboxRoot, secretGuard) {
  const sandbox = realpathSync(sandboxRoot);
  const sandboxHome = join(sandbox, "isolated-cli-home");
  mkdirSync(sandboxHome, { mode: 0o700 });
  const registryRoot = join(sandboxHome, "Library", "Application Support", "OpenAI", "Codex Observability");
  const registryPath = join(registryRoot, "grafana-profiles-v1.json");
  const require = createRequire(import.meta.url);
  const realFs = require("node:fs");
  const realFsPromises = require("node:fs/promises");
  const realOs = require("node:os");
  const realModule = require("node:module");
  const originalHomedir = realOs.homedir;
  const originalHomeEnvironment = process.env.HOME;
  const originalCodexEnvironment = process.env.CODEX_HOME;
  const writes = new Set();
  const credentials = new Map();
  let homeLookups = 0;
  let nativeLoadAttempts = 0;
  let memoryLoaderCalls = 0;
  let memoryWrites = 0;
  const denyNative = (specifier, baseRequire) => {
    if (typeof specifier === "string" && specifier.endsWith(".node")) {
      nativeLoadAttempts += 1;
      throw new Error("Authenticated CLI test refuses real native addon loading");
    }
    return baseRequire(specifier);
  };
  const moduleShim = {
    ...realModule,
    createRequire: (filename) => {
      const baseRequire = realModule.createRequire(filename);
      return Object.assign((specifier) => denyNative(specifier, baseRequire), baseRequire);
    },
  };
  const fsShim = guardedFilesystem(realFs, sandboxHome, writes);
  const fsPromisesShim = guardedFilesystem(realFsPromises, sandboxHome, writes);
  fsShim.promises = fsPromisesShim;
  const { source } = verifySourceLoader(pluginRoot, "scripts/observabilityctl.mjs");
  const filename = join(pluginRoot, "scripts/observabilityctl.mjs");
  const compiled = new realModule(filename);
  compiled.filename = filename;
  compiled.paths = realModule._nodeModulePaths(dirname(filename));
  const moduleRequire = compiled.require.bind(compiled);
  compiled.require = (specifier) => {
    if (specifier === "node:os" || specifier === "os") return { ...realOs, homedir: () => { homeLookups += 1; return sandboxHome; } };
    if (specifier === "node:fs" || specifier === "fs") return fsShim;
    if (specifier === "node:fs/promises" || specifier === "fs/promises") return fsPromisesShim;
    if (specifier === "node:module" || specifier === "module") return moduleShim;
    return denyNative(specifier, moduleRequire);
  };
  compiled._compile(source.toString("utf8"), filename);
  const runEntrypoint = compiled.exports.runObservabilityCliEntrypoint;
  assert.equal(typeof runEntrypoint, "function");
  const nativeLoader = {
    async load() {
      memoryLoaderCalls += 1;
      return {
        backendKind: "MACOS_KEYCHAIN",
        createEntry(service, account) {
          assert.equal(service, KEYRING_SERVICE);
          assert.match(account, /^profile\/[a-f0-9-]{36}\/bearer\/v[1-9][0-9]*$/u);
          return {
            async getSecret() {
              const secret = credentials.get(account);
              return secret === undefined ? undefined : Uint8Array.from(secret);
            },
            async setSecret(secret) {
              credentials.get(account)?.fill(0);
              credentials.set(account, Uint8Array.from(secret));
              memoryWrites += 1;
            },
            async deleteCredential() {
              credentials.get(account)?.fill(0);
              return credentials.delete(account);
            },
          };
        },
      };
    },
  };
  const run = async (argv, inputs = []) => {
    const stdin = new ScriptedTty(inputs);
    let stdout = "";
    let stderr = "";
    try {
      const exitCode = await runEntrypoint({
        argv, platform: "darwin", nativeLoader,
        io: {
          stdin,
          stdout: { isTTY: true, write: (value) => { stdout += value; } },
          stderr: { write: (value) => { stderr += value; } },
        },
      });
      secretGuard.assertAbsent(stdout);
      secretGuard.assertAbsent(stderr);
      return {
        exitCode, stdout, stderr, consumedInputs: stdin.consumed, rawTransitions: stdin.transitions,
        events: stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line)),
      };
    } finally { stdin.dispose(); }
  };
  const registry = () => {
    if (!existsSync(registryPath)) return { profiles: [] };
    const contents = readFileSync(registryPath, "utf8");
    secretGuard.assertAbsent(contents);
    return JSON.parse(contents);
  };
  const assertIsolation = () => {
    assert.ok(homeLookups > 0, "Shipped CLI did not use the explicit isolated home seam");
    assert.equal(nativeLoadAttempts, 0, "Shipped CLI attempted to load a real native addon");
    assert.ok(realOs.homedir === originalHomedir, "Global node:os was changed");
    assert.ok(process.env.HOME === originalHomeEnvironment && process.env.CODEX_HOME === originalCodexEnvironment, "User home configuration was changed");
    assert.ok(writes.size > 0);
    for (const path of writes) within(sandboxHome, path);
    const visit = (directory) => {
      const metadata = lstatSync(directory);
      assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink() && (metadata.mode & 0o077) === 0);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else {
          const stat = lstatSync(path);
          assert.ok(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0);
          secretGuard.assertAbsent(readFileSync(path, "utf8"));
        }
      }
    };
    visit(sandboxHome);
    return { registryRoot, guardedWritePaths: writes.size, memoryLoaderCalls, memoryWrites, nativeLoadAttempts };
  };
  return {
    run, registry, assertIsolation,
    credentialCount: () => credentials.size,
    dispose: () => { for (const secret of credentials.values()) secret.fill(0); credentials.clear(); },
  };
}
