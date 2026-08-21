import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";

import { datasourceQueryModel } from "./live-catalog.mjs";

const fixtureRoot = fileURLToPath(new URL("../support/authenticated-stack/", import.meta.url));
const composePath = fileURLToPath(new URL("../support/authenticated-stack/compose.yaml", import.meta.url));
const matrix = JSON.parse(readFileSync(new URL("../support/live-stack/matrix.json", import.meta.url), "utf8"));
const ADMIN_USER = "community-disposable-admin";
export const AUTHENTICATION_IMAGES = Object.freeze({
  legacy: "grafana/grafana:12.1.0",
  strict: "grafana/grafana:12.4.0",
});

/** Keep unexpected assertions/subprocess failures from publishing test secrets. */
export function createSecretGuard() {
  const secrets = new Set();
  const remember = (value) => {
    if (typeof value !== "string" || value.length === 0) throw new Error("Invalid disposable secret");
    secrets.add(value);
    return value;
  };
  const redact = (value) => {
    let result = String(value);
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) result = result.replaceAll(secret, "[redacted]");
    return result.replaceAll(/glsa_[A-Za-z0-9_=-]+/gu, "[redacted]");
  };
  const assertAbsent = (value) => {
    const rendered = typeof value === "string" ? value : JSON.stringify(value);
    for (const secret of secrets) {
      if (rendered?.includes(secret)) throw new Error("A disposable credential appeared in an output or artifact");
    }
  };
  const protect = async (action) => {
    try { return await action(); }
    catch (error) {
      // Do not retain `cause`, AssertionError.actual/expected, or other fields:
      // node:test may inspect those independently of the message.
      const failure = new Error(redact(error?.stack ?? error?.message ?? "Authenticated Grafana test failed"));
      failure.name = "AuthenticatedGrafanaTestError";
      throw failure;
    }
  };
  return { remember, redact, assertAbsent, protect };
}

function commandResult(command, args, env) {
  return spawnSync(command, args, { env, encoding: "utf8", timeout: 15_000, maxBuffer: 1_048_576 });
}

function localDockerEnvironment() {
  for (const name of ["DOCKER_HOST", "DOCKER_CONTEXT", "COMPOSE_FILE", "COMPOSE_PROJECT_NAME", "COMPOSE_PROFILES"]) {
    assert.ok(!process.env[name], `${name} must be unset for disposable authenticated tests`);
  }
  const env = {};
  for (const name of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "SYSTEMROOT", "WINDIR", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const context = commandResult("docker", ["context", "show"], env);
  assert.equal(context.status, 0, "A local Docker daemon is required");
  const contextName = context.stdout.trim();
  const inspected = commandResult("docker", ["context", "inspect", contextName, "--format", "{{json .Endpoints.docker.Host}}"], env);
  assert.equal(inspected.status, 0, "Unable to inspect Docker context");
  const host = JSON.parse(inspected.stdout);
  assert.ok(typeof host === "string" && /^(?:unix:\/\/\/|npipe:\/\/)/u.test(host), "Authenticated tests refuse remote Docker endpoints");
  return { ...env, DOCKER_CONTEXT: contextName };
}

function composeCommand(env) {
  if (commandResult("docker", ["compose", "version"], env).status === 0) return ["docker", ["compose"]];
  if (commandResult("docker-compose", ["version"], env).status === 0) return ["docker-compose", []];
  throw new Error("Docker Compose v2 or newer is required");
}

function run(command, args, { env, timeoutMs = 60_000 } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd: fixtureRoot, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    const append = (chunk) => { output = `${output}${chunk}`.slice(-65_536); };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let timedOut = false;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    }, timeoutMs);
    child.once("error", () => { clearTimeout(timer); clearTimeout(killTimer); reject(new Error("Disposable authenticated Docker command did not start")); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (timedOut) reject(new Error(`Disposable authenticated Docker command timed out after ${timeoutMs}ms; subprocess output was withheld`));
      else if (code === 0) accept(output);
      else reject(new Error(`Disposable authenticated Docker command failed (${code ?? signal ?? "unknown"}); subprocess output was withheld`));
    });
  });
}

// Direct sockets ignore ambient proxy settings and never follow redirects.
// No response body or Authorization header is included in errors.
function jsonRequest(origin, path, { method = "GET", authorization, body } = {}) {
  const endpoint = new URL(origin);
  assert.equal(endpoint.protocol, "http:");
  assert.equal(endpoint.hostname, "127.0.0.1");
  assert.ok(endpoint.port && endpoint.pathname === "/" && !endpoint.search && !endpoint.hash);
  assert.ok(path.startsWith("/api/") && !path.startsWith("//") && !path.includes("#"));
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((accept, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1", port: endpoint.port, path, method,
      headers: {
        accept: "application/json",
        ...(authorization === undefined ? {} : { authorization }),
        ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": String(payload.byteLength) }),
      },
      timeout: 15_000,
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.byteLength;
        if (size > 1_048_576) {
          request.destroy();
          reject(new Error("Disposable Grafana response exceeded its bound"));
        } else chunks.push(chunk);
      });
      response.on("end", () => {
        const bytes = Buffer.concat(chunks);
        try { accept({ status: response.statusCode, body: bytes.length === 0 ? null : JSON.parse(bytes.toString("utf8")) }); }
        catch { reject(new Error("Disposable Grafana returned invalid bounded JSON")); }
        finally { bytes.fill(0); for (const chunk of chunks) chunk.fill(0); }
      });
      response.on("error", () => reject(new Error("Disposable Grafana response failed")));
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => reject(new Error("Disposable Grafana request failed")));
    request.end(payload);
  });
}

/** Separate, short-lived pinned Grafana + Prometheus topology; no user profiles. */
export async function startAuthenticatedStack(guard, { mode = "strict" } = {}) {
  assert.ok(Object.hasOwn(AUTHENTICATION_IMAGES, mode), "Only the two pinned authentication fixtures are allowed");
  const image = AUTHENTICATION_IMAGES[mode];
  const dockerEnv = localDockerEnvironment();
  const [command, prefix] = composeCommand(dockerEnv);
  const project = `community-grafana-auth-${mode}-${randomUUID().slice(0, 12)}`;
  let password = guard.remember(randomBytes(24).toString("hex"));
  let adminAuthorization = `Basic ${guard.remember(Buffer.from(`${ADMIN_USER}:${password}`).toString("base64"))}`;
  const env = {
    ...dockerEnv,
    CDE_GRAFANA_AUTH_PROJECT: project,
    CDE_GRAFANA_AUTH_IMAGE: image,
    CDE_GRAFANA_AUTH_PROMETHEUS_IMAGE: matrix.providers.prometheus,
    CDE_GRAFANA_AUTH_NODE_IMAGE: matrix.providers.seed,
    CDE_GRAFANA_AUTH_ADMIN_PASSWORD: password,
    COMPOSE_ANSI: "never", COMPOSE_PROGRESS: "quiet",
  };
  const args = [...prefix, "--file", composePath, "--project-directory", fixtureRoot, "--project-name", project];
  const identities = new Set();
  const accounts = new Set();
  let origin;
  let stopped = false;
  const admin = (path, options = {}) => jsonRequest(origin, path, { ...options, authorization: adminAuthorization });
  const bearer = (identity) => identity === undefined ? undefined : `Bearer ${identity.readValue()}`;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      if (origin) {
        for (const accountId of accounts) {
          // Best effort explicit removal; `down` below destroys the entire
          // tmpfs database even if Grafana is no longer responding.
          await admin(`/api/serviceaccounts/${accountId}`, { method: "DELETE" }).catch(() => undefined);
        }
      }
      await run(command, [...args, "down", "--remove-orphans", "--volumes", "--timeout", "10"], { env });
    } finally {
      for (const identity of identities) identity.dispose();
      delete env.CDE_GRAFANA_AUTH_ADMIN_PASSWORD;
      password = "";
      adminAuthorization = "";
    }
  };
  const createIdentity = async (role) => {
    assert.ok(role === "Viewer" || role === "Admin", "Only the two explicit authentication-test roles are allowed");
    const created = await admin("/api/serviceaccounts", {
      method: "POST", body: { name: `${project}-${role.toLowerCase()}`, role, isDisabled: false },
    });
    assert.equal(created.status, 201, "Unable to create the disposable service account");
    const accountId = created.body?.id;
    assert.ok(Number.isSafeInteger(accountId) && accountId > 0, "Invalid disposable account ID");
    accounts.add(accountId);
    assert.equal(created.body.role, role, "Grafana assigned an unexpected service-account role");
    const minted = await admin(`/api/serviceaccounts/${accountId}/tokens`, {
      method: "POST", body: { name: `${project}-${role.toLowerCase()}-short-lived`, secondsToLive: 600 },
    });
    if (typeof minted.body?.key === "string" && minted.body.key.length > 0) guard.remember(minted.body.key);
    assert.equal(minted.status, 200, "Unable to create the disposable service-account token");
    const tokenId = minted.body?.id;
    assert.ok(Number.isSafeInteger(tokenId) && tokenId > 0, "Invalid disposable token ID");
    assert.ok(typeof minted.body.key === "string" && /^[\x21-\x7e]{1,16384}$/u.test(minted.body.key), "Invalid disposable bearer credential");
    let secret = minted.body.key;
    minted.body.key = "";
    const identity = Object.freeze({
      role, accountId, tokenId,
      readValue: () => secret,
      readBytes: () => Buffer.from(secret, "ascii"),
      dispose: () => { secret = ""; },
    });
    identities.add(identity);
    return identity;
  };
  const revoke = async (identity) => {
    assert.ok(identities.has(identity), "Refusing to revoke an identity not created by this fixture");
    const response = await admin(`/api/serviceaccounts/${identity.accountId}/tokens/${identity.tokenId}`, { method: "DELETE" });
    assert.equal(response.status, 200, "Disposable token revocation failed");
  };
  const read = async (path, identity) => {
    assert.ok([
      "/api/health", "/api/datasources", "/api/access-control/user/permissions",
      "/api/datasources/uid/live-prometheus", "/api/datasources/uid/live-prometheus/health",
    ].includes(path), "Unexpected authenticated fixture read route");
    return jsonRequest(origin, path, { authorization: bearer(identity) });
  };
  const query = async (identity, entry) => {
    assert.equal(entry.datasourceUid, "live-prometheus");
    assert.equal(entry.target.datasourceType, "prometheus");
    const end = Date.now();
    return jsonRequest(origin, "/api/ds/query", {
      method: "POST", authorization: bearer(identity),
      body: { from: String(end - 60_000), to: String(end), queries: [datasourceQueryModel(entry)] },
    });
  };
  const proveWriteDenied = async (identity) => {
    assert.ok(identities.has(identity) && identity.role === "Viewer");
    const response = await jsonRequest(origin, "/api/folders", {
      method: "POST", authorization: bearer(identity),
      body: { uid: `${project}-denied`, title: "Disposable Viewer must not create this folder" },
    });
    assert.equal(response.status, 403, "The disposable Viewer unexpectedly has folder-write authority");
  };
  try {
    await run(command, [...args, "up", "--detach", "--quiet-pull", "--wait", "--wait-timeout", "180"], { env, timeoutMs: 900_000 });
    const published = (await run(command, [...args, "port", "grafana", "3000"], { env })).trim();
    assert.match(published, /^127\.0\.0\.1:[1-9][0-9]{0,4}$/u);
    origin = `http://${published}`;
    return { project, image, origin, createIdentity, revoke, read, query, proveWriteDenied, stop };
  } catch (error) {
    try { await stop(); } catch { throw new Error("Authenticated Grafana startup and disposable cleanup failed"); }
    throw error;
  }
}
