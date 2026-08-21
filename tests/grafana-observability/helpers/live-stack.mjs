import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fixtureRoot = fileURLToPath(new URL("../support/live-stack/", import.meta.url));
const composePath = fileURLToPath(new URL("../support/live-stack/compose.yaml", import.meta.url));
const matrix = JSON.parse(readFileSync(new URL("../support/live-stack/matrix.json", import.meta.url), "utf8"));
export const GRAFANA_LIVE_MATRIX = Object.freeze(matrix.grafana);

function commandResult(command, args, env) {
  return spawnSync(command, args, { env, encoding: "utf8", timeout: 15_000, maxBuffer: 1_048_576 });
}

function localDockerEnvironment() {
  for (const name of ["DOCKER_HOST", "DOCKER_CONTEXT", "COMPOSE_FILE", "COMPOSE_PROJECT_NAME", "COMPOSE_PROFILES"]) {
    assert.ok(!process.env[name], `${name} must be unset for disposable local Grafana tests`);
  }
  const env = {};
  for (const name of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "SYSTEMROOT", "WINDIR", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const context = commandResult("docker", ["context", "show"], env);
  assert.equal(context.status, 0, "Docker is required for the opt-in live tests");
  const contextName = context.stdout.trim();
  const inspected = commandResult("docker", ["context", "inspect", contextName, "--format", "{{json .Endpoints.docker.Host}}"], env);
  assert.equal(inspected.status, 0, "Unable to inspect the selected Docker context");
  const host = JSON.parse(inspected.stdout);
  assert.ok(typeof host === "string" && /^(?:unix:\/\/\/|npipe:\/\/)/u.test(host), "Live tests refuse non-local Docker endpoints");
  return { ...env, DOCKER_CONTEXT: contextName };
}

function composeCommand(env) {
  if (commandResult("docker", ["compose", "version"], env).status === 0) return ["docker", ["compose"]];
  if (commandResult("docker-compose", ["version"], env).status === 0) return ["docker-compose", []];
  throw new Error("Docker Compose v2 or newer is required (docker compose or docker-compose)");
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
    let forceKillTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, timeoutMs);
    const clearTimers = () => {
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
    };
    child.once("error", (error) => { clearTimers(); reject(error); });
    child.once("close", (code, signal) => {
      clearTimers();
      if (timedOut) reject(new Error(`${command} timed out after ${timeoutMs}ms (${code ?? signal ?? "unknown"}): ${output.trim()}`));
      else if (code === 0) accept(output);
      else reject(new Error(`${command} failed (${code ?? signal ?? "unknown"}): ${output.trim()}`));
    });
  });
}

/** Starts only the checked-in topology on a verified local Docker daemon. */
export async function startLiveStack(major = 12) {
  const entry = matrix.grafana.find((item) => item.major === major);
  assert.ok(entry, "Grafana major must be one of the pinned matrix entries");
  const dockerEnv = localDockerEnvironment();
  const [command, prefix] = composeCommand(dockerEnv);
  const project = `community-grafana-e2e-${major}-${randomUUID().slice(0, 8)}`;
  const env = {
    ...dockerEnv,
    PM_GRAFANA_LIVE_PROJECT: project,
    PM_GRAFANA_IMAGE: entry.image,
    PM_GRAFANA_PROMETHEUS_IMAGE: matrix.providers.prometheus,
    PM_GRAFANA_LOKI_IMAGE: matrix.providers.loki,
    PM_GRAFANA_TEMPO_IMAGE: matrix.providers.tempo,
    PM_GRAFANA_POSTGRES_IMAGE: matrix.providers.postgres,
    PM_GRAFANA_SEED_IMAGE: matrix.providers.seed,
    PM_GRAFANA_LIVE_PORT: "0",
    PM_GRAFANA_PROMETHEUS_PORT: "0",
    PM_GRAFANA_LOKI_PORT: "0",
    PM_GRAFANA_TEMPO_PORT: "0",
    PM_GRAFANA_SEED_PORT: "0",
    COMPOSE_ANSI: "never",
    COMPOSE_PROGRESS: "quiet",
  };
  const args = [...prefix, "--file", composePath, "--project-directory", fixtureRoot, "--project-name", project];
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await run(command, [...args, "down", "--remove-orphans", "--volumes", "--rmi", "local", "--timeout", "10"], { env });
  };
  const readOnlyDatabaseProof = async () => {
    const query = "SELECT current_user,rolsuper,rolcreatedb,rolcreaterole,rolreplication,has_table_privilege(current_user,'public.observability_kpis','SELECT'),has_table_privilege(current_user,'public.observability_kpis','INSERT'),has_table_privilege(current_user,'public.observability_kpis','UPDATE'),has_table_privilege(current_user,'public.observability_kpis','DELETE'),has_table_privilege(current_user,'public.observability_kpis','TRUNCATE'),has_table_privilege(current_user,'public.observability_kpis','REFERENCES'),has_table_privilege(current_user,'public.observability_kpis','TRIGGER'),has_schema_privilege(current_user,'public','CREATE') FROM pg_roles WHERE rolname=current_user";
    const result = (await run(command, [...args, "exec", "-T", "postgres", "psql", "-U", "grafana_live_reader", "-d", "observability", "-Atc", query], { env })).trim();
    assert.equal(result, "grafana_live_reader|f|f|f|f|t|f|f|f|f|f|f|f", "The real KPI database identity must remain SELECT-only");
    return { identity: "grafana_live_reader", selectOnly: true };
  };
  try {
    await run(command, [...args, "up", "--detach", "--build", "--quiet-pull", "--quiet-build", "--wait", "--wait-timeout", "180"], {
      env,
      timeoutMs: 900_000,
    });
    const published = (await run(command, [...args, "port", "grafana-gateway", "3000"], { env })).trim();
    assert.match(published, /^127\.0\.0\.1:[1-9][0-9]{0,4}$/u);
    return { project, origin: `http://${published}`, image: entry.image, major, stop, readOnlyDatabaseProof };
  } catch (error) {
    try { await stop(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Live Grafana startup and cleanup failed");
    }
    throw error;
  }
}
