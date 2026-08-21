import assert from "node:assert/strict";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";

import { verifySourceLoader } from "../../scripts/validate-grafana.mjs";
import { createSandbox } from "./helpers/mcp-client.mjs";

function shippedKeychainFactory(pluginRoot) {
  const entrypoint = "scripts/observabilityctl.mjs";
  const { source } = verifySourceLoader(pluginRoot, entrypoint);
  const filename = join(pluginRoot, entrypoint);
  const require = createRequire(import.meta.url);
  const Module = require("node:module");
  // The release loader uses this same mechanism. Keep the original filename so
  // the code-owned native-asset path resolves inside the isolated package.
  const compiled = new Module(filename);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(dirname(filename));
  compiled._compile(source.toString("utf8"), filename);
  return compiled.exports.createBundledMacOsKeychainLoader;
}

test("the shipped keychain loader rejects unsupported platforms and altered assets", async (t) => {
  const sandbox = createSandbox(t);
  const createLoader = shippedKeychainFactory(sandbox.pluginRoot);
  assert.equal(typeof createLoader, "function");
  for (const platform of ["linux", "win32"]) {
    assert.throws(() => createLoader({ platform, architecture: "arm64" }), { name: "NativeKeyringUnavailableError" });
  }
  await assert.rejects(createLoader({ platform: "darwin", architecture: "x64" }).load(), { name: "NativeKeyringUnavailableError" });
  const native = join(sandbox.pluginRoot, "native/keyring.darwin-arm64.node");
  const bytes = readFileSync(native);
  bytes[0] ^= 1;
  chmodSync(native, 0o600);
  writeFileSync(native, bytes);
  await assert.rejects(createLoader({ platform: "darwin", architecture: "arm64" }).load(), { name: "NativeKeyringUnavailableError" });
});

test("the pinned macOS arm64 broker creates, rotates, reads, and deletes one disposable credential", {
  skip: process.env.GRAFANA_E2E_KEYCHAIN !== "1"
    ? "Opt in with GRAFANA_E2E_KEYCHAIN=1; this writes one disposable OS Keychain item"
    : false,
  timeout: 60_000,
}, async (t) => {
  assert.equal(`${process.platform}/${process.arch}`, "darwin/arm64", "Native credential E2E is supported only on macOS arm64");
  const sandbox = createSandbox(t);
  const module = await shippedKeychainFactory(sandbox.pluginRoot)().load();
  assert.equal(module.backendKind, "MACOS_KEYCHAIN");
  const entry = module.createEntry("com.community-plugins.grafana-e2e", `disposable-${randomUUID()}`);
  const first = randomBytes(32);
  const rotated = randomBytes(32);
  let readback;
  try {
    assert.equal(await entry.getSecret(), undefined, "Unique test credential already exists");
    await entry.setSecret(first);
    readback = await entry.getSecret();
    assert.ok(readback instanceof Uint8Array && timingSafeEqual(readback, first), "Keychain round trip failed");
    readback.fill(0);
    await entry.setSecret(rotated);
    readback = await entry.getSecret();
    assert.ok(readback instanceof Uint8Array && timingSafeEqual(readback, rotated), "Keychain rotation failed");
    readback.fill(0);
    assert.equal(await entry.deleteCredential(), true);
    assert.equal(await entry.getSecret(), undefined, "Disposable credential was not deleted");
  } finally {
    first.fill(0);
    rotated.fill(0);
    readback?.fill(0);
    await entry.deleteCredential();
  }
});
