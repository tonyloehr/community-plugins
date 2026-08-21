#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const results = [];
let child;
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interrupted = true;
    child?.kill(signal);
  });
}

for (const major of ["10", "11", "12", "13"]) {
  if (interrupted) break;
  console.log(`\nRunning the pinned Grafana ${major} Docker integration`);
  const code = await new Promise((resolveCode, reject) => {
    child = spawn(process.execPath, ["--test", "tests/grafana-observability/live.test.mjs"], {
      cwd: repositoryRoot,
      env: { ...process.env, GRAFANA_E2E_DOCKER: "1", GRAFANA_E2E_MAJOR: major },
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolveCode(exitCode ?? 1));
  });
  results.push({ major, code });
  child = undefined;
}

for (const result of results) console.log(`Grafana ${result.major}: ${result.code === 0 ? "PASS" : "FAIL"}`);
if (interrupted || results.length !== 4 || results.some((result) => result.code !== 0)) process.exitCode = 1;
