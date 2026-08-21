import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isolatedEnvironment, SOURCE_PLUGIN_ROOT } from "./mcp-client.mjs";

const definition = JSON.parse(readFileSync(new URL("../support/authority-definition.json", import.meta.url), "utf8"));
export const CAPABILITY_PACKS = Object.freeze(definition.capabilityPacks);
export const GRAFANA_ADAPTER = Object.freeze(definition.adapter);
export const AUTH_TEST_CREDENTIAL_ENV = "GRAFANA_E2E_DISPOSABLE_BEARER";
export const DEFAULT_LIMITS = Object.freeze({
  timeoutMs: 10_000,
  maxAgeMs: 120_000,
  maxBytes: 1_048_576,
  maxRows: 2_000,
  maxSeries: 100,
  maxPoints: 2_000,
});

// All inputs here are test-owned JSON (no undefined, prototypes, or exotic
// numbers). Sorting keys with JavaScript's UTF-16 ordering matches RFC 8785.
export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  assert.ok(value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype, "Expected plain fixture JSON");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Canonical(value) {
  return sha256Bytes(canonicalJson(value));
}

function integrity(value) {
  const { integrity: ignored, ...material } = value;
  void ignored;
  return {
    hashContractVersion: "sha256-jcs-v1",
    algorithm: "sha256",
    canonicalization: "RFC8785",
    contentSha256: sha256Canonical(material),
  };
}

function profileConfigHash(profile) {
  const keys = [
    "schemaVersion", "profileAlias", "capabilityProfile", "allowedOrigins", "scopes",
    "endpointIds", "operationIds", "capabilityPackIds", "capabilityPackCatalogSha256", "policy",
  ];
  return sha256Canonical(Object.fromEntries(keys.map((key) => [key, profile[key]])));
}

function providerType(type) {
  return type === "grafana-postgresql-datasource" ? "postgres" : type;
}

function operationSnapshot({ operationId, entry, domain }, capturedAt, limits) {
  const datasourceType = providerType(entry.target.datasourceType);
  const semantic = {
    operationId,
    revision: 1,
    definition: {
      domain: domain ?? (datasourceType === "loki" ? "LOGS" : datasourceType === "tempo" ? "TRACES" : "METRICS"),
      sourceAlias: "grafana-test",
      adapterPackageId: GRAFANA_ADAPTER.packageId,
      adapterOperation: "grafana.datasource.query.read",
      authority: "CORROBORATING",
      sanitizedProviderDefinition: {
        catalogEntryId: entry.id,
        catalogEntrySha256: sha256Canonical(entry),
      },
      expectedSourceLineage: {
        accessPath: "GRAFANA",
        datasourceType,
        sourceIdentitySha256: entry.datasourceIdentitySha256,
      },
      scopeMapping: { ...entry.scopeMappings },
      allowedDimensions: [...new Set([
        ...entry.frame.allowedLabels,
        ...entry.frame.fields.filter((field) => field.role === "DIMENSION").map((field) => field.outputName),
      ])],
      requiredProviderScopes: Object.keys(entry.scopeMappings),
      sensitivity: "INTERNAL",
      limits: { ...limits },
      normalization: {
        resultKind: entry.frame.resultKind,
        ...(entry.frame.unit === undefined ? {} : { targetUnit: entry.frame.unit }),
        dimensionMappings: {},
      },
    },
  };
  return {
    schemaVersion: "1.0.0",
    ...semantic,
    capturedAt,
    definitionSha256: sha256Canonical(semantic),
  };
}

function writePrivate(path, bytes) {
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
}

function authorityCommand(pluginRoot, args) {
  const result = spawnSync(process.execPath, [join(pluginRoot, "scripts/grafana-authorityctl.mjs"), ...args], {
    cwd: pluginRoot,
    env: isolatedEnvironment(),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1_048_576,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, "Packaged authority CLI did not start");
  assert.equal(result.status, 0, `Packaged authority CLI rejected the test root: ${result.stderr || result.stdout}`);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

/**
 * Construct and activate disposable TEST authority for the shipped provider
 * worker. This is intentionally not an organizational-authority generator:
 * only an explicit IPv4 loopback origin, anonymous Viewer access, and
 * SIMULATED evidence are admitted. The ephemeral private signing key stays in
 * memory; only its public key and the exact shipped worker digest reach disk.
 */
export function createLiveAuthority(parentDirectory, options = {}) {
  return createTestAuthority(parentDirectory, { ...options, credentialEnvironmentReference: undefined, credentialBrokerReference: undefined });
}

/**
 * The authenticated test has one separate, fixed environment reference. Its
 * secret is never an input to this authority builder and never reaches disk.
 * The original anonymous fixture's defaults and validation remain unchanged.
 */
export function createBearerLiveAuthority(parentDirectory, options = {}) {
  return createTestAuthority(parentDirectory, {
    ...options,
    credentialEnvironmentReference: AUTH_TEST_CREDENTIAL_ENV,
    credentialBrokerReference: undefined,
  });
}

/** One newly connected, revision-one disposable profile; never an arbitrary broker. */
export function createBrokerLiveAuthority(parentDirectory, { profileId, credentialReference, ...options } = {}) {
  assert.match(profileId ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u, "Expected one disposable profile UUID");
  assert.equal(credentialReference, `grafana:${profileId}:bearer:v1`, "Expected the exact new profile's first broker slot");
  return createTestAuthority(parentDirectory, {
    ...options,
    credentialEnvironmentReference: undefined,
    credentialBrokerReference: credentialReference,
  });
}

function createTestAuthority(parentDirectory, {
  pluginRoot = SOURCE_PLUGIN_ROOT,
  origin,
  entries,
  scopes,
  profileAlias = "local-grafana-e2e",
  packs = CAPABILITY_PACKS,
  limits = DEFAULT_LIMITS,
  credentialEnvironmentReference,
  credentialBrokerReference,
} = {}) {
  assert.ok(credentialEnvironmentReference === undefined || credentialEnvironmentReference === AUTH_TEST_CREDENTIAL_ENV);
  assert.ok(credentialEnvironmentReference === undefined || credentialBrokerReference === undefined, "A test endpoint cannot combine credential sources");
  assert.ok(credentialBrokerReference === undefined || /^grafana:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:bearer:v1$/u.test(credentialBrokerReference));
  const endpointUrl = new URL(origin);
  assert.equal(endpointUrl.protocol, "http:");
  assert.equal(endpointUrl.hostname, "127.0.0.1");
  assert.ok(endpointUrl.port && Number(endpointUrl.port) >= 1);
  assert.equal(endpointUrl.pathname, "/");
  assert.equal(endpointUrl.search + endpointUrl.hash + endpointUrl.username + endpointUrl.password, "");
  const rootParent = realpathSync(parentDirectory);
  const canonicalPluginRoot = realpathSync(pluginRoot);
  assert.ok(Array.isArray(entries) && entries.length > 0);
  const capturedAt = new Date().toISOString();
  const workerHash = sha256Bytes(readFileSync(join(canonicalPluginRoot, "workers/provider-worker.mjs")));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const unsignedAdapter = {
    ...structuredClone(GRAFANA_ADAPTER),
    entrypoint: {
      kind: "SIGNED_WORKER",
      protocol: "PM_ADAPTER_STDIO_V1",
      artifactPath: "workers/provider-worker.mjs",
      artifactSha256: workerHash,
      signingKeyId: "local-e2e-ed25519",
    },
  };
  const adapter = {
    ...unsignedAdapter,
    entrypoint: {
      ...unsignedAdapter.entrypoint,
      signature: sign(null, Buffer.from(canonicalJson(unsignedAdapter)), privateKey).toString("base64"),
    },
  };
  const endpoint = {
    endpointId: "grafana-test",
    adapterId: GRAFANA_ADAPTER.packageId,
    baseUrl: endpointUrl.href,
    authentication: credentialBrokerReference !== undefined
      ? { mode: "BEARER", tokenRef: { kind: "broker", key: credentialBrokerReference } }
      : credentialEnvironmentReference === undefined
        ? { mode: "NONE" }
        : { mode: "BEARER", tokenRef: { kind: "env", key: credentialEnvironmentReference } },
    tls: { minimumVersion: "TLSv1.2" },
    network: {
      followRedirects: false,
      allowLoopbackHttp: true,
      allowedHosts: ["127.0.0.1"],
      networkClass: "loopback",
      routeMode: "direct",
    },
  };
  const operations = entries.map((entry) => operationSnapshot(entry, capturedAt, limits));
  const capabilityPacks = structuredClone(packs);
  const profileDraft = {
    schemaVersion: "1.0.0",
    profileAlias,
    capabilityProfile: "investigate",
    allowedOrigins: ["SIMULATED"],
    compiledAt: capturedAt,
    configSha256: "0".repeat(64),
    endpointRegistrySha256: sha256Canonical([endpoint]),
    catalogSha256: sha256Canonical(operations),
    capabilityPackCatalogSha256: sha256Canonical(capabilityPacks),
    scopes: structuredClone(scopes),
    endpointIds: [endpoint.endpointId],
    operationIds: operations.map((operation) => operation.operationId),
    capabilityPackIds: capabilityPacks.map((pack) => pack.packId),
    policy: {
      defaultLookback: { mode: "FIXED", durationSeconds: 3_600 },
      maxEvidenceAge: { mode: "FIXED", durationSeconds: 120 },
      rawEvidenceRetention: { mode: "NONE" },
      auditRequired: true,
      limits: { ...limits },
    },
  };
  const profile = { ...profileDraft, configSha256: profileConfigHash(profileDraft) };
  const bundleDraft = {
    schemaVersion: "1.0.0",
    createdAt: capturedAt,
    profile,
    endpoints: [endpoint],
    operations,
    adapters: [adapter],
    capabilityPacks,
  };
  const bundle = { ...bundleDraft, integrity: integrity(bundleDraft) };
  const runtime = {
    schemaVersion: "1.0.0",
    metadata: {},
    workerAdmission: {
      trustedSigningKeys: [{ keyId: "local-e2e-ed25519", manifestPath: "local-e2e.pub.pem" }],
      revocations: { packageIds: [], artifactSha256s: [], artifactPaths: [], signingKeyIds: [] },
    },
    adapters: [{
      kind: "grafana",
      packageId: GRAFANA_ADAPTER.packageId,
      credentialEnv: credentialEnvironmentReference === undefined ? [] : [credentialEnvironmentReference],
      access: {
        approvalId: "disposable-loopback-e2e",
        reviewedAt: capturedAt,
        effectiveProviderScopes: [...new Set(operations.flatMap((operation) => operation.definition.requiredProviderScopes))],
      },
      bootstrap: {
        endpointId: endpoint.endpointId,
        transport: { timeoutMs: limits.timeoutMs, maxResponseBytes: limits.maxBytes },
        catalog: { entries: entries.map(({ entry }) => structuredClone(entry)) },
      },
    }],
  };
  const trustRootPath = join(rootParent, "test-authority");
  const receiptParent = join(rootParent, "test-activation");
  mkdirSync(trustRootPath, { mode: 0o700 });
  mkdirSync(receiptParent, { mode: 0o700 });
  const files = [
    ["TRUST_BUNDLE", "trust-bundle.yaml", `${canonicalJson(bundle)}\n`],
    ["PROVIDER_RUNTIME", "provider-runtime.yaml", `${canonicalJson(runtime)}\n`],
    ["SIGNING_KEY", "local-e2e.pub.pem", publicKey.export({ type: "spki", format: "pem" }).toString()],
  ].map(([role, path, text]) => {
    const bytes = Buffer.from(text);
    writePrivate(join(trustRootPath, path), bytes);
    return { role, path, bytes: bytes.byteLength, sha256: sha256Bytes(bytes) };
  });
  writePrivate(join(trustRootPath, "manifest.yaml"), `${canonicalJson({
    schemaVersion: "1.0.0", rootId: "disposable-grafana-e2e", createdAt: capturedAt, files,
  })}\n`);
  const validation = authorityCommand(canonicalPluginRoot, ["trust-root", "validate", "--root", trustRootPath]);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.credentialEnvironmentReferences, credentialEnvironmentReference === undefined ? [] : [credentialEnvironmentReference]);
  const receiptPath = join(receiptParent, "active-root.json");
  const activation = authorityCommand(canonicalPluginRoot, [
    "trust-root", "activate", "--root", trustRootPath, "--receipt", receiptPath,
    "--expected-root-manifest-sha256", validation.rootManifestSha256,
    "--expected-trust-bundle-sha256", validation.trustBundleSha256,
  ]);
  assert.equal(activation.activationPerformed, true);
  return {
    trustRootPath, receiptPath, profileAlias, bundle, validation, activation, workerHash,
    env: {
      PRODUCTION_MONITORING_MODE: "live",
      PRODUCTION_MONITORING_TRUST_ROOT: trustRootPath,
      PRODUCTION_MONITORING_ACTIVATION_RECEIPT: receiptPath,
    },
  };
}
