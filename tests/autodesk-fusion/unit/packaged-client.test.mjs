import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isolatedEnvironment, runCli } from "../support/packaged-client.mjs";

test("isolated subprocesses retain Windows startup paths without application secrets or preload hooks", () => {
  const env = isolatedEnvironment("fixture-profile.json", {
    Path: "fixture-bin", SYSTEMROOT: "C:\\Windows", USERPROFILE: "C:\\Users\\fixture",
    APPDATA: "fixture-roaming", LOCALAPPDATA: "fixture-local", ProgramFiles: "fixture-programs",
    "ProgramFiles(x86)": "fixture-programs-x86", ProgramW6432: "fixture-programs-native",
    COMSPEC: "fixture-command", PATHEXT: ".EXE", TEMP: "fixture-temp",
    FUSION_PROFILE: "caller-profile", APS_CLIENT_SECRET: "must-not-leak", NODE_OPTIONS: "must-not-load",
    NODE_PATH: "must-not-load", PSModulePath: "must-not-load", HTTP_PROXY: "must-not-connect", HOME: "caller-home",
  });
  assert.deepEqual(env, {
    LANG: "C", TZ: "UTC", PATH: "fixture-bin", SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\fixture",
    APPDATA: "fixture-roaming", LOCALAPPDATA: "fixture-local", ProgramFiles: "fixture-programs",
    "ProgramFiles(x86)": "fixture-programs-x86", ProgramW6432: "fixture-programs-native",
    COMSPEC: "fixture-command", PATHEXT: ".EXE", TEMP: "fixture-temp", FUSION_PROFILE: "fixture-profile.json",
  });
});

test("isolated Windows PowerShell can load the ACL commands before the storage deadline", { skip: process.platform !== "win32" ? "Requires Windows PowerShell and Windows ACLs." : false }, () => {
  const env = isolatedEnvironment();
  const executable = path.join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = "[void](Get-Item -LiteralPath $env:TEMP -Force); [void](Get-Acl -LiteralPath $env:TEMP); @{ ready = $true } | ConvertTo-Json -Compress";
  const result = spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { env, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 16_384, windowsHide: true });
  assert.equal(result.error?.code, undefined, "The isolated OS environment must support PowerShell startup without timing out");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ready: true });
});

test("CLI helper rejects unbounded timeout overrides before spawning a child", () => {
  for (const timeoutMs of [-1, 0, 99, 20_001, 100.5, Infinity, NaN, "100"]) {
    assert.throws(() => runCli({}, [], { timeoutMs }), /timeoutMs must be an integer from 100 through 20000/u);
  }
});

test("CLI timeout stops an owned SIGTERM-resistant child before its self-exit guard", { timeout: 15_000 }, t => {
  const root = mkdtempSync(path.join(tmpdir(), "fusion CLI timeout helper "));
  const pluginRoot = path.join(root, "test-owned-plugin");
  const readyFile = path.join(root, "ready.json");
  const signalFile = path.join(root, "sigterm.json");
  const guardFile = path.join(root, "self-exit.json");
  let absenceConfirmed = false;
  t.after(() => {
    if (!absenceConfirmed) {
      t.diagnostic(`CLI helper child absence was not confirmed; evidence retained at ${root}`);
      return;
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  mkdirSync(path.join(pluginRoot, "scripts"), { recursive: true, mode: 0o700 });
  // No Autodesk code, shell or descendants. The child has a finite lifetime
  // even before the helper is fixed and on platforms with different signals.
  // Its ready marker distinguishes a tested timeout from slow startup.
  writeFileSync(path.join(pluginRoot, "scripts/fusionctl.mjs"), `
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(signalFile)}, JSON.stringify({ received: 'SIGTERM' })); });
const guard = setTimeout(() => {
  writeFileSync(${JSON.stringify(guardFile)}, JSON.stringify({ self_exit: true }));
  process.exit(77);
}, 4000);
writeFileSync(${JSON.stringify(readyFile)}, JSON.stringify({ pid: process.pid, parent_pid: process.ppid }));
`, { flag: "wx", mode: 0o600 });

  const started = performance.now();
  let failure;
  try {
    runCli({ pluginRoot, unrelatedCwd: root, profileFile: path.join(root, "unused-profile.json") }, [], { timeoutMs: 1_000 });
  } catch (error) { failure = error; }
  const elapsedMs = Math.round(performance.now() - started);
  const ready = existsSync(readyFile) ? JSON.parse(readFileSync(readyFile, "utf8")) : undefined;
  if (ready) {
    assert.ok(Number.isInteger(ready.pid) && ready.pid > 0);
    assert.equal(ready.parent_pid, process.pid);
    try { process.kill(ready.pid, 0); }
    catch (error) {
      if (error.code !== "ESRCH") throw error;
      absenceConfirmed = true;
    }
  }
  const guardFired = existsSync(guardFile), sigtermObserved = existsSync(signalFile);
  t.diagnostic(JSON.stringify({ scope: "test-owned CLI timeout helper only", platform: process.platform, timeout_ms: 1_000, self_exit_after_ms: 4_000, elapsed_ms: elapsedMs, child_ready: Boolean(ready), child_absence_confirmed: absenceConfirmed, sigterm_observed: sigtermObserved, self_exit_guard_fired: guardFired }));
  assert.ok(ready, "The child must initialize its signal handler before the timeout; slow startup is not a passing timeout test");
  assert.equal(absenceConfirmed, true, "The direct test-owned CLI child must be reaped");
  assert.equal(guardFired, false, "The CLI helper waited for the child's self-exit instead of enforcing its own timeout");
  assert.equal(sigtermObserved, false, "A test-owned timeout must use a non-ignorable termination signal");
  assert.ok(failure, "A forced timeout must fail the CLI helper instead of returning a normal result");
  assert.equal(failure.actual?.code, "ETIMEDOUT", failure.message);
});
