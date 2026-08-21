import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { verifySourceLoader } from "../../scripts/validate-grafana.mjs";
import { createSecretGuard, startAuthenticatedStack } from "./helpers/authenticated-stack.mjs";
import { CAPABILITY_PACKS, createBrokerLiveAuthority, sha256Canonical } from "./helpers/live-authority.mjs";
import { createLiveCatalog, LIVE_SCOPES } from "./helpers/live-catalog.mjs";
import { createSandbox, isolatedEnvironment, McpClient, removeSandbox, toolData } from "./helpers/mcp-client.mjs";

const ACTIVE = process.env.GRAFANA_E2E_NATIVE_PROFILE === "1";
const REGISTRY = "grafana-profiles-v1.json";
const JOURNAL = "grafana-credential-lifecycle-journal-v1.json";
const LIFECYCLE_LOCK = "grafana-profile-lifecycle-v1.lock";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EMPTY_REGISTRY = { schemaVersion: "1.0.0", activeProfileId: null, profiles: [] };
const ptyDriver = fileURLToPath(new URL("./helpers/real-observability-pty.py", import.meta.url));

function metadata(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

function sameInode(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function ownerOnly(stat, kind) {
  assert.ok(stat && !stat.isSymbolicLink() && (kind === "directory" ? stat.isDirectory() : stat.isFile()), "Native test state was replaced or is not regular");
  assert.equal(stat.uid, process.getuid(), "Native test state has an unexpected owner");
  assert.equal(stat.mode & 0o777, kind === "directory" ? 0o700 : 0o600, "Native test state must be owner-only");
  if (kind === "file") assert.equal(stat.nlink, 1, "Native test state must not be hard-linked");
}

function preflightSharedStore() {
  const home = homedir();
  const root = join(home, "Library", "Application Support", "OpenAI", "Codex Observability");
  assert.equal(metadata(root), undefined, "This opt-in test refuses any existing shared-profile store, including journals and locks");
  const initiallyMissing = [];
  for (let path = root; path !== home; path = dirname(path)) {
    const stat = metadata(path);
    if (stat === undefined) initiallyMissing.push(path);
    else {
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "Shared-profile ancestor must be a real directory");
      assert.equal(stat.uid, process.getuid(), "Shared-profile ancestor has an unexpected owner");
    }
  }
  return { root, initiallyMissing, createdDirectories: new Map() };
}

function rememberCreatedDirectories(preflight) {
  for (const path of preflight.initiallyMissing) {
    const stat = metadata(path);
    if (stat === undefined) continue;
    ownerOnly(stat, "directory");
    if (preflight.createdDirectories.has(path)) assert.ok(sameInode(preflight.createdDirectories.get(path), stat), "Test-created shared-profile directory was replaced");
    else preflight.createdDirectories.set(path, stat);
  }
}

function readOwnedJson(path, guard) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    ownerOnly(stat, "file");
    assert.ok(stat.size > 0 && stat.size <= 262_144, "Native state file exceeded its bound");
    const bytes = readFileSync(descriptor);
    assert.equal(bytes.length, stat.size, "Native state changed during inspection");
    assert.ok(sameInode(stat, metadata(path)), "Native state path changed during inspection");
    guard.assertAbsent(bytes.toString("utf8"));
    return { path, stat, bytes, value: JSON.parse(bytes.toString("utf8")) };
  } finally { closeSync(descriptor); }
}

function inspectSharedStore(preflight, guard, expectedProfile) {
  rememberCreatedDirectories(preflight);
  ownerOnly(metadata(preflight.root), "directory");
  assert.ok(sameInode(preflight.createdDirectories.get(preflight.root), metadata(preflight.root)), "Shared-profile store no longer belongs to this test");
  assert.deepEqual(readdirSync(preflight.root).sort(), [JOURNAL, REGISTRY].sort(), "Unexpected shared-profile file or concurrent lifecycle lock; refusing cleanup");
  const registry = readOwnedJson(join(preflight.root, REGISTRY), guard);
  assert.deepEqual(Object.keys(registry.value).sort(), ["schemaVersion", "activeProfileId", "profiles"].sort());
  assert.equal(registry.value.schemaVersion, "1.0.0");
  assert.ok(Array.isArray(registry.value.profiles));
  if (expectedProfile === null) {
    assert.equal(registry.bytes.equals(Buffer.from(`${JSON.stringify(EMPTY_REGISTRY, null, 2)}\n`)), true, "Official deletion did not leave exactly the empty registry");
  } else if (expectedProfile !== undefined) {
    assert.equal(registry.value.profiles.length, 1, "An unrelated or concurrent profile appeared; refusing deletion");
    assert.deepEqual(registry.value.profiles[0], expectedProfile, "The disposable profile identity/revision changed; refusing deletion");
    assert.equal(registry.value.activeProfileId, expectedProfile.profileId);
  }
  const journal = readOwnedJson(join(preflight.root, JOURNAL), guard);
  assert.deepEqual(Object.keys(journal.value).sort(), ["schemaVersion", "kind", "generation", "payload", "integrity"].sort());
  assert.equal(journal.value.schemaVersion, "1.0.0");
  assert.equal(journal.value.kind, "grafana-credential-lifecycle-journal-v1");
  assert.equal(journal.value.payload, null, "A pending or concurrent credential journal appeared; refusing cleanup");
  assert.ok(Number.isSafeInteger(journal.value.generation) && journal.value.generation > 0);
  const { integrity, ...unsigned } = journal.value;
  assert.deepEqual(integrity, {
    hashContractVersion: "sha256-jcs-v1", algorithm: "sha256", canonicalization: "RFC8785",
    contentSha256: sha256Canonical(unsigned),
  });
  return { registry, journal };
}

function exactOwnProfile(state, alias, origin) {
  assert.equal(state.registry.value.profiles.length, 1, "Expected only the profile created by this test");
  const profile = state.registry.value.profiles[0];
  assert.match(profile.profileId ?? "", UUID);
  assert.deepEqual(profile, {
    schemaVersion: "1.0.0", profileId: profile.profileId, profileName: alias,
    grafanaOrigin: origin, networkClass: "loopback", revision: 1,
    credentialRef: { kind: "broker", key: `grafana:${profile.profileId}:bearer:v1` },
  });
  assert.equal(state.registry.value.activeProfileId, profile.profileId);
  return structuredClone(profile);
}

function profileEnvironment() {
  // Preserve the real home; never redirect it or the active Codex configuration.
  return isolatedEnvironment(process.env.HOME === undefined ? {} : { HOME: process.env.HOME });
}

async function runPtyCli(pluginRoot, guard, { mode, alias, origin, secret }) {
  const config = {
    nodeExecutable: process.execPath, pluginRoot, mode, profileAlias: alias,
    ...(mode === "connect" ? { origin, secretBase64: Buffer.from(secret).toString("base64") } : {}),
  };
  const payload = Buffer.from(JSON.stringify(config));
  delete config.secretBase64;
  try {
    return await new Promise((accept, reject) => {
      const child = spawn("python3", [ptyDriver], { cwd: pluginRoot, env: profileEnvironment(), stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      let errors = "";
      let failure;
      let killTimer;
      const stop = () => {
        child.kill("SIGINT");
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), 3_000);
      };
      const timer = setTimeout(() => { failure = "Real CLI PTY driver exceeded its deadline"; stop(); }, 75_000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { output += chunk; if (output.length > 262_144) { failure = "PTY result exceeded its bound"; stop(); } });
      child.stderr.on("data", (chunk) => { errors += chunk; if (errors.length > 16_384) { failure = "PTY diagnostics exceeded their bound"; stop(); } });
      child.stdin.on("error", () => { failure = "PTY driver input failed"; stop(); });
      child.once("error", () => { clearTimeout(timer); clearTimeout(killTimer); reject(new Error("Python 3 and a working local PTY are required")); });
      child.once("close", (code) => {
        clearTimeout(timer); clearTimeout(killTimer);
        try {
          guard.assertAbsent(output); guard.assertAbsent(errors);
          assert.equal(errors, "", "PTY driver produced unexpected diagnostics");
          assert.equal(failure, undefined, failure);
          assert.equal(code, 0, "Real CLI PTY driver failed safely; no subprocess details published");
          const result = JSON.parse(output);
          assert.equal(result.driverError, undefined, "PTY driver rejected the interaction");
          assert.equal(result.echoRestored, true, "The real CLI did not restore terminal echo/canonical mode");
          assert.deepEqual(result.rawInputVerified, Array(result.consumedInputs).fill(true));
          result.events = result.transcript.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
          accept(result);
        } catch (error) { reject(error); }
      });
      child.stdin.end(payload, () => payload.fill(0));
    });
  } finally { payload.fill(0); secret?.fill(0); }
}

async function assertExactKeychainSlotMissing(pluginRoot, profile) {
  const filename = join(pluginRoot, "scripts/observabilityctl.mjs");
  const { source } = verifySourceLoader(pluginRoot, "scripts/observabilityctl.mjs");
  const require = createRequire(import.meta.url);
  const Module = require("node:module");
  const compiled = new Module(filename);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(dirname(filename));
  compiled._compile(source.toString("utf8"), filename);
  const native = await compiled.exports.createBundledMacOsKeychainLoader().load();
  assert.equal(native.backendKind, "MACOS_KEYCHAIN");
  const entry = native.createEntry("com.openai.codex.observability.grafana", `profile/${profile.profileId}/bearer/v1`);
  const value = await entry.getSecret();
  try { assert.equal(value === undefined, true, "Official CLI deletion left its disposable Keychain item behind"); }
  finally { value?.fill(0); }
}

function cleanupEmptySharedStore(preflight, guard) {
  const empty = inspectSharedStore(preflight, guard, null);
  assert.equal(empty.journal.value.generation, 6, "Unexpected journal history; refusing to remove shared state");
  const lockPath = join(preflight.root, LIFECYCLE_LOCK);
  const lockBytes = Buffer.from(JSON.stringify({ schemaVersion: "1.0.0", pid: process.pid, createdAtMs: Date.now(), nonce: randomUUID() }));
  // Coordinate with the same official lifecycle lock; never reclaim another
  // process's lock or unlink shared metadata while a CLI operation can write it.
  const descriptor = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  const ownLock = fstatSync(descriptor);
  try {
    ownerOnly(ownLock, "file");
    writeFileSync(descriptor, lockBytes); fsyncSync(descriptor);
  } catch (error) {
    if (sameInode(metadata(lockPath), ownLock)) unlinkSync(lockPath);
    throw error;
  } finally { closeSync(descriptor); }
  try {
    assert.deepEqual(readdirSync(preflight.root).sort(), [JOURNAL, REGISTRY, LIFECYCLE_LOCK].sort(), "Concurrent shared state appeared; refusing cleanup");
    for (const expected of [empty.registry, empty.journal]) {
      const current = readOwnedJson(expected.path, guard);
      assert.ok(sameInode(current.stat, expected.stat) && current.bytes.equals(expected.bytes), "Shared metadata changed before cleanup; refusing deletion");
    }
    assert.deepEqual(readdirSync(preflight.root).sort(), [JOURNAL, REGISTRY, LIFECYCLE_LOCK].sort());
    unlinkSync(empty.registry.path);
    assert.deepEqual(readdirSync(preflight.root).sort(), [JOURNAL, LIFECYCLE_LOCK].sort(), "Concurrent data appeared during cleanup");
    unlinkSync(empty.journal.path);
  } finally {
    const lock = readOwnedJson(lockPath, guard);
    assert.ok(sameInode(lock.stat, ownLock) && lock.bytes.equals(lockBytes), "Cleanup lock was replaced; refusing to remove it");
    unlinkSync(lockPath);
  }
  cleanupCreatedEmptyDirectories(preflight);
}

function cleanupCreatedEmptyDirectories(preflight) {
  rememberCreatedDirectories(preflight);
  for (const path of preflight.initiallyMissing) {
    const stat = metadata(path);
    if (stat === undefined) continue;
    ownerOnly(stat, "directory");
    assert.ok(sameInode(stat, preflight.createdDirectories.get(path)), "Test-created directory changed; refusing cleanup");
    assert.equal(readdirSync(path).length, 0, "Concurrent data appeared; refusing to remove its parent");
    rmdirSync(path); // Deliberately nonrecursive, and only initially absent paths.
  }
  assert.equal(metadata(preflight.root), undefined, "Shared-profile store was not restored to its initially absent state");
}

function inspectArtifacts(directory, guard) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "plugin") continue;
    const path = join(directory, entry.name);
    assert.equal(entry.isSymbolicLink(), false);
    if (entry.isDirectory()) inspectArtifacts(path, guard);
    else if (entry.isFile()) guard.assertAbsent(readFileSync(path, "utf8"));
  }
}

test("broker handoff authority admits only the exact disposable revision-one UUID reference", () => {
  const profileId = randomUUID();
  for (const credentialReference of [
    "env:GRAFANA_TOKEN", `grafana:${randomUUID()}:bearer:v1`,
    `grafana:${profileId}:bearer:v2`, `grafana:${profileId}:bearer`,
  ]) assert.throws(() => createBrokerLiveAuthority("/unused", { profileId, credentialReference }), /first broker slot/u);
  assert.throws(() => createBrokerLiveAuthority("/unused", { profileId: "not-a-uuid", credentialReference: "anything" }), /profile UUID/u);
});

test("real PTY CLI → macOS Keychain → shared-profile broker → packaged MCP handoff", {
  skip: ACTIVE ? false : "opt in with GRAFANA_E2E_NATIVE_PROFILE=1; requires an absent real shared-profile store and creates/deletes one disposable macOS Keychain profile",
  timeout: 1_200_000,
}, async (t) => {
  const guard = createSecretGuard();
  const alias = `community-native-handoff-${randomUUID()}`;
  const originalEnvironment = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
  let preflight;
  let sandbox;
  let stack;
  let profile;
  let client;
  let attemptedConnect = false;
  t.after(() => guard.protect(async () => {
    try {
      if (client) { await client.close(); guard.assertAbsent(client.stderr); assert.equal(client.stderr, ""); }
      if (attemptedConnect && metadata(preflight.root) !== undefined) {
        // An error after the CLI committed may precede its JSON result. Only
        // this exact random alias/origin/revision can be adopted for cleanup.
        if (!profile && readdirSync(preflight.root).length === 0) {
          cleanupCreatedEmptyDirectories(preflight);
        } else {
          if (!profile) profile = exactOwnProfile(inspectSharedStore(preflight, guard), alias, stack.origin);
          inspectSharedStore(preflight, guard, profile);
          const deleted = await runPtyCli(sandbox.pluginRoot, guard, { mode: "delete", alias });
          assert.equal(deleted.exitCode, 0, "Official CLI failed to delete its disposable profile");
          assert.equal(deleted.consumedInputs, 1);
          const result = deleted.events.find((event) => event.operation === "delete");
          assert.equal(result?.profile?.profileId, profile.profileId);
          assert.equal(result.profile.revision, 1);
          inspectSharedStore(preflight, guard, null);
          await assertExactKeychainSlotMissing(sandbox.pluginRoot, profile);
          cleanupEmptySharedStore(preflight, guard);
          t.diagnostic("Official CLI deleted its exact revision-one profile and Keychain item; only verified empty test-created metadata/directories were removed. The real store is absent again.");
        }
      }
      assert.deepEqual({ HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME }, originalEnvironment);
    } finally {
      try { if (stack) await stack.stop(); }
      finally { if (sandbox) { try { inspectArtifacts(sandbox.root, guard); } finally { removeSandbox(sandbox.root); } } }
    }
  }));
  await guard.protect(async () => {
    assert.equal(`${process.platform}/${process.arch}`, "darwin/arm64");
    preflight = preflightSharedStore();
    sandbox = createSandbox();
    // Exercise the PTY driver's EOF/exit path before any real shared-state or
    // credential operation. This fake process only reports its terminal flags.
    const probeRoot = join(sandbox.root, "pty-driver-probe");
    mkdirSync(join(probeRoot, "scripts"), { recursive: true, mode: 0o700 });
    writeFileSync(join(probeRoot, "scripts/observabilityctl.mjs"), 'process.stdout.write(JSON.stringify({stdinIsTTY:process.stdin.isTTY,stdoutIsTTY:process.stdout.isTTY})+"\\n");\n', { mode: 0o600, flag: "wx" });
    const probe = await runPtyCli(probeRoot, guard, { mode: "status", alias });
    assert.equal(probe.exitCode, 0);
    assert.equal(probe.consumedInputs, 0);
    assert.deepEqual(probe.events, [{ stdinIsTTY: true, stdoutIsTTY: true }]);
    stack = await startAuthenticatedStack(guard, { mode: "strict" });
    const viewer = await stack.createIdentity("Viewer");
    assert.equal((await stack.read("/api/datasources")).status, 401, "The real fixture must require credentials");
    assert.equal((await stack.read("/api/datasources", viewer)).status, 200);
    assert.equal(metadata(preflight.root), undefined, "Shared state appeared during stack startup; refusing CLI mutation");
    attemptedConnect = true;
    const connected = await runPtyCli(sandbox.pluginRoot, guard, {
      mode: "connect", alias, origin: stack.origin, secret: viewer.readBytes(),
    });
    assert.equal(connected.exitCode, 0, "The real packaged CLI did not connect its disposable profile");
    assert.equal(connected.consumedInputs, 2);
    assert.deepEqual(connected.rawInputVerified, [true, true]);
    const preview = connected.events.find((event) => event.event === "GRAFANA_DISCOVERY_PREVIEW");
    assert.equal(preview?.permissionState, "READ_ONLY_CONFIRMED");
    assert.equal(preview.grafanaVersion, "12.4.0");
    const connectedState = inspectSharedStore(preflight, guard);
    profile = exactOwnProfile(connectedState, alias, stack.origin);
    assert.equal(connectedState.journal.value.generation, 3);
    const connection = connected.events.find((event) => event.operation === "connect");
    assert.equal(connection?.profile?.profileId, profile.profileId);
    assert.equal(connection.credentialReference, profile.credentialRef.key);
    const status = await runPtyCli(sandbox.pluginRoot, guard, { mode: "status", alias });
    assert.equal(status.exitCode, 0);
    assert.equal(status.consumedInputs, 0);
    assert.equal(status.events[0]?.credentialStatus, "AVAILABLE");
    const pack = CAPABILITY_PACKS.find((candidate) => candidate.packId === "grafana.infrastructure");
    const entries = createLiveCatalog().filter(({ operationId }) => pack.requiredOperationIds.includes(operationId));
    assert.equal(entries.length, 4);
    const cpu = entries.find(({ operationId }) => operationId === "grafana.infrastructure.cpu.usage").entry;
    let metricsReady = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const query = await stack.query(viewer, cpu);
      guard.assertAbsent(query);
      if (query.status === 200 && query.body.results?.A?.frames?.[0]?.data?.values?.[1]?.[0] === 97) { metricsReady = true; break; }
      await new Promise((accept) => setTimeout(accept, 1_000));
    }
    assert.equal(metricsReady, true, "Disposable real Prometheus data did not become ready");
    const authority = createBrokerLiveAuthority(sandbox.root, {
      pluginRoot: sandbox.pluginRoot, origin: stack.origin, entries,
      scopes: { infrastructure: LIVE_SCOPES.infrastructure }, packs: [pack],
      profileAlias: "local-native-broker-e2e", profileId: profile.profileId,
      credentialReference: profile.credentialRef.key,
    });
    assert.deepEqual(authority.validation.credentialEnvironmentReferences, []);
    assert.deepEqual(authority.bundle.endpoints[0].authentication, { mode: "BEARER", tokenRef: profile.credentialRef });
    const environment = { ...sandbox.env, ...profileEnvironment(), ...authority.env };
    guard.assertAbsent(environment);
    assert.equal(Object.hasOwn(environment, "GRAFANA_E2E_DISPOSABLE_BEARER"), false);
    client = await McpClient.start(sandbox.pluginRoot, { env: environment, timeoutMs: 120_000 });
    const call = async (name, args) => {
      const response = await client.callTool(name, args);
      guard.assertAbsent(response);
      return toolData(response);
    };
    const listed = await call("grafana_list_packs", { profileAlias: authority.profileAlias });
    assert.deepEqual(listed.packs.map((item) => item.packId), [pack.packId]);
    const end = Math.floor(Date.now() / 1_000) * 1_000;
    const report = await call("grafana_run_pack", {
      idempotencyKey: "native-shared-profile-handoff", profileAlias: authority.profileAlias,
      packId: pack.packId, scopeAlias: "infrastructure", origin: "SIMULATED",
      window: { start: new Date(end - 60_000).toISOString(), end: new Date(end).toISOString() },
    });
    assert.equal(report.status, "COMPLETE");
    assert.equal(report.collectionFailures, 0);
    assert.equal(report.evidence.length, 4);
    for (const card of report.evidence) {
      const detail = await call("grafana_get_evidence", { reportRef: report.reportRef, evidenceRef: card.evidenceRef });
      assert.equal(detail.status, "COMPLETE");
      assert.equal(detail.provider, "grafana");
      assert.equal(detail.origin, "SIMULATED");
      assert.ok(detail.values.some((value) => value.kind === "METRIC"));
    }
    await client.close(); guard.assertAbsent(client.stderr); assert.equal(client.stderr, ""); client = undefined;
    const unchanged = inspectSharedStore(preflight, guard, profile);
    assert.equal(unchanged.registry.bytes.equals(connectedState.registry.bytes), true, "Read-only broker handoff changed profile state");
    assert.equal(unchanged.journal.bytes.equals(connectedState.journal.bytes), true, "Read-only broker handoff changed lifecycle history");
    inspectArtifacts(sandbox.root, guard);
    t.diagnostic("Actual hidden-prompt CLI and hash-pinned OS Keychain were used without backend/TTY injection; fresh packaged MCP and signed worker completed4 real operations using only the shared-profile broker reference.");
  });
});
