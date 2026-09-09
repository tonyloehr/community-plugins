import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NativeTokenStore, nativeCredentialFactory, APS_ORIGIN, hash } from "../dist/index.mjs";

const optedIn = process.env.FUSION_TEST_OS_VAULT === "1";
const root = fileURLToPath(new URL("../", import.meta.url));
const service = "community-plugins.autodesk-fusion.aps.v1";

test("real OS vault round-trip and verified removal of unique synthetic plugin entries (explicit opt-in)", {
  skip: optedIn ? false : "Set FUSION_TEST_OS_VAULT=1 to exercise the real OS vault; protocol-double tests do not qualify native storage.",
  timeout: 120000
}, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fusion-real-vault-test-"));
  const key = hash({ synthetic_os_vault_test: randomUUID() });
  const entries = new Map();
  const writesAttempted = new Set();
  const nativeFailures = [];
  let vault;
  let operationError;
  let roundTripCompleted = false;
  let cleanupVerified = false;
  let cleanupReceipt;

  const timeout = () => AbortSignal.timeout(10000);
  const failureCode = error => typeof error?.code === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(error.code) ? error.code : "UNCLASSIFIED";
  const recordFailure = (operation, error) => {
    const message = typeof error?.message === "string" ? error.message : "";
    // These native calls address only this test's synthetic values. Bound the diagnostic and omit long values.
    const category = /interaction.*not allowed|interaction.*required|locked/i.test(message) ? "interaction_required_or_vault_locked" :
      /permission|denied|entitlement|not authorized|not permitted/i.test(message) ? "access_denied" :
      /not found|no.*keychain|unavailable|not available/i.test(message) ? "secure_store_unavailable" :
      /invalid.*parameter|parameter.*invalid/i.test(message) ? "invalid_native_parameter" : "unclassified_native_failure";
    const numericCodes = [...message.matchAll(/(?:^|[\s:(])-([0-9]{1,8})(?=$|[\s),.:])/g)].map(match => "-" + match[1]);
    nativeFailures.push({ operation, code: failureCode(error), category, numeric_codes: [...new Set(numericCodes)].slice(0, 5), diagnostic: message.replace(/[A-Za-z0-9_+/=-]{48,}/g, '[omitted long value]').slice(0, 256) });
  };

  try {
    if (process.platform !== "win32") assert.equal((await stat(directory)).mode & 0o077, 0);
    // Verifies the existing build receipt before loading the real platform N-API binary.
    const nativeFactory = await nativeCredentialFactory(root);
    const factory = (requestedService, account) => {
      assert.equal(requestedService, service);
      assert.ok(account === key || account.startsWith(key + "."), "Only this test's fresh grant and its own generations may be addressed");
      if (entries.has(account)) return entries.get(account);
      const native = nativeFactory(requestedService, account);
      const entry = {
        async getPassword() {
          try { return await native.getPassword(timeout()); }
          catch (error) { recordFailure("get", error); throw error; }
        },
        async setPassword(value) {
          writesAttempted.add(account);
          try { return await native.setPassword(value, timeout()); }
          catch (error) { recordFailure("set", error); throw error; }
        },
        async deleteCredential() {
          try { return await native.deleteCredential(timeout()); }
          catch (error) { recordFailure("delete", error); throw error; }
        }
      };
      entries.set(account, entry);
      return entry;
    };
    vault = new NativeTokenStore(root, factory, { lockRoot: directory });
    assert.equal(vault.service, service);
    const obtainedAt = Date.now();
    const grant = {
      accessToken: "SYNTHETIC_NONSECRET_ACCESS_" + "A".repeat(2200),
      refreshToken: "SYNTHETIC_NONSECRET_REFRESH_" + "B".repeat(1200),
      expiresAt: obtainedAt + 60000,
      obtainedAt,
      issuer: APS_ORIGIN,
      resource: APS_ORIGIN,
      scopes: ["data:read"],
      tenantId: "synthetic-os-vault-test",
      grantType: "authorization_code",
      owner: "synthetic-plugin-vault-test-only",
      clientId: "synthetic-never-authenticated-client",
      grantId: key,
      authorizationSessionId: randomUUID()
    };
    await vault.withLock(key, async () => {
      assert.equal(await vault.get(key), null, "The randomly generated test reference must be absent");
      await vault.set(key, grant);
      assert.deepEqual(await vault.get(key), grant);
      const replacement = { ...grant, accessToken: "SYNTHETIC_NONSECRET_ROTATED_" + "C".repeat(2400), refreshToken: "SYNTHETIC_NONSECRET_ROTATED_REFRESH_" + "D".repeat(900) };
      await vault.markRefreshPending(key);
      await assert.rejects(vault.get(key), { code: "REAUTHENTICATION_REQUIRED" });
      await vault.set(key, replacement);
      assert.deepEqual(await vault.get(key), replacement);
      await vault.delete(key);
      assert.equal(await vault.get(key), null);
      // A missing manifest alone is insufficient: verify deletion of every old/new synthetic chunk.
      // N-API represents an absent native Option value as null.
      for (const entry of entries.values()) assert.equal(await entry.getPassword() == null, true);
      roundTripCompleted = true;
    });
  } catch (error) {
    operationError = error;
  } finally {
    // Cleanup is restricted to exact accounts touched by this test. Never enumerate the user's vault.
    const unresolved = [];
    for (const [account, entry] of entries) {
      if (writesAttempted.has(account)) {
        try { await entry.deleteCredential(); } catch { /* Verify absence independently below. */ }
      }
      if (writesAttempted.size === 0) continue;
      try { if (await entry.getPassword() != null) unresolved.push(account); }
      catch { unresolved.push(account); }
    }
    cleanupVerified = unresolved.length === 0;
    if (!cleanupVerified) {
      cleanupReceipt = path.join(directory, "synthetic-vault-cleanup-needed.json");
      await writeFile(cleanupReceipt, JSON.stringify({ schema: 1, synthetic_only: true, service, exact_accounts: unresolved, contains_autodesk_credentials: false, instruction: "Inspect/remove only these synthetic accounts. Do not enumerate or clear other vault entries." }, null, 2) + "\n", { mode: 0o600 });
    } else await rm(directory, { recursive: true, force: true });
    t.diagnostic(JSON.stringify({
      evidence: "real_os_native_vault",
      platform: process.platform,
      architecture: process.arch,
      node: process.versions.node,
      synthetic_only: true,
      namespace: service,
      unique_grant: key,
      round_trip_completed: roundTripCompleted,
      write_attempt_account_count: writesAttempted.size,
      exact_account_count: entries.size,
      cleanup_verified: cleanupVerified,
      ...(cleanupReceipt ? { cleanup_receipt: cleanupReceipt } : {}),
      native_failures: nativeFailures
    }));
  }
  if (!cleanupVerified) throw new Error("Synthetic vault cleanup could not be verified; inspect the private receipt reported above. No Autodesk credentials were used.");
  if (operationError) throw new Error("Real OS vault qualification failed (" + failureCode(operationError) + "). See the bounded native diagnostic classification above; no Autodesk credentials were used.");
  assert.equal(roundTripCompleted, true);
});
