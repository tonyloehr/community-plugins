import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const cli = path.join(
  repoRoot,
  "plugins",
  "reviewops-auditor-benchmark",
  "src",
  "cli.mjs",
);
const commands = [
  "validate-config",
  "normalize",
  "audit-eval",
  "benchmark",
  "recommend-architecture",
];

function run(command, format) {
  return spawnSync(
    process.execPath,
    [cli, command, "--fixture", "synthetic", "--format", format],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { LANG: "C", PATH: process.env.PATH, TZ: "UTC" },
    },
  );
}

function runConfig(cwd, command, format) {
  return spawnSync(
    process.execPath,
    [cli, command, "--config", "reviewops.config.json", "--format", format],
    {
      cwd,
      encoding: "utf8",
      env: { LANG: "C", PATH: process.env.PATH, TZ: "UTC" },
    },
  );
}

function unescapeMarkdown(value) {
  return value.replace(/\\([\\*_{}\[\]()<>#+.!|\-])/gu, "$1");
}

test("all five commands expose text-first status, boundary, inputs, and limits", () => {
  for (const command of commands) {
    const jsonRun = run(command, "json");
    assert.ok(
      [0, 2, 3].includes(jsonRun.status),
      command + ": " + jsonRun.stderr,
    );
    const report = JSON.parse(jsonRun.stdout);
    const markdownRun = run(command, "markdown");
    assert.equal(
      markdownRun.status,
      jsonRun.status,
      command + ": " + markdownRun.stderr,
    );
    const markdown = unescapeMarkdown(markdownRun.stdout);
    assert.match(markdown, /^# ReviewOps /mu, command);
    assert.match(
      markdown,
      new RegExp("^Status: " + report.status + "$", "mu"),
      command,
    );
    assert.match(markdown, /^Claim boundary: /mu, command);
    assert.match(markdown, /^## Inputs$/mu, command);
    assert.match(markdown, /^## Safety notes$/mu, command);
    assert.match(markdown, /Maximum records:/u, command);
    assert.doesNotMatch(markdownRun.stdout, /\u001b/u, command);
    assert.doesNotMatch(
      markdownRun.stdout,
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u,
      command,
    );
  }
});

test("eval and benchmark Markdown carry lane semantics instead of color-only state", () => {
  for (const command of ["audit-eval", "benchmark"]) {
    const jsonRun = run(command, "json");
    const report = JSON.parse(jsonRun.stdout);
    const markdown = unescapeMarkdown(run(command, "markdown").stdout);
    assert.match(markdown, /^## Lanes$/mu);
    for (const lane of report.lanes) {
      assert.match(markdown, new RegExp(lane.laneId, "u"));
      assert.match(markdown, new RegExp(lane.laneType, "u"));
      assert.match(markdown, new RegExp(lane.attributionStatus, "u"));
      assert.match(markdown, new RegExp(lane.status, "u"));
    }
  }
  const evalMarkdown = unescapeMarkdown(run("audit-eval", "markdown").stdout);
  assert.match(evalMarkdown, /^### Eval checks$/mu);
  assert.match(evalMarkdown, /^## Static diagnostic context$/mu);
  assert.match(evalMarkdown, /Status: NOT_SUPPLIED/u);

  const benchmarkMarkdown = unescapeMarkdown(
    run("benchmark", "markdown").stdout,
  );
  assert.match(benchmarkMarkdown, /^### Variant metrics$/mu);
  assert.match(benchmarkMarkdown, /Currency/u);
  assert.match(benchmarkMarkdown, /Cost basis/u);
  assert.match(benchmarkMarkdown, /Unit/u);
  assert.match(benchmarkMarkdown, /Denominator/u);
  assert.match(benchmarkMarkdown, /Missingness/u);
  assert.match(benchmarkMarkdown, /^### Slice metric evidence$/mu);
  assert.match(benchmarkMarkdown, /^### Slice paired comparisons$/mu);
  assert.match(benchmarkMarkdown, /Multiplicity/u);
  assert.match(benchmarkMarkdown, /^### Lane exclusions$/mu);
  assert.match(benchmarkMarkdown, /^### Pareto frontier$/mu);
  assert.match(benchmarkMarkdown, /^### Paired comparisons$/mu);
  assert.match(benchmarkMarkdown, /^### Slice eligibility$/mu);
  assert.match(benchmarkMarkdown, /^## Methodology$/mu);
});

test("recommendation Markdown exposes gates, preservation, shadow boundary, and rationale", () => {
  const jsonRun = run("recommend-architecture", "json");
  const report = JSON.parse(jsonRun.stdout);
  const markdown = unescapeMarkdown(
    run("recommend-architecture", "markdown").stdout,
  );
  assert.match(markdown, /^## Recommendation$/mu);
  assert.match(markdown, /^### Decision policy$/mu);
  assert.match(markdown, /^### Safety gates$/mu);
  assert.match(markdown, /Plain-language meaning/u);
  assert.match(markdown, /Scope/u);
  assert.match(markdown, /^### Preserved production contracts$/mu);
  assert.match(markdown, /^### Per-slice architecture$/mu);
  assert.match(markdown, /Adjusted interval-backed gates passed/u);
  assert.match(markdown, /^### Rationale$/mu);
  assert.match(markdown, /shadow-only/iu);
  for (const gate of report.gates) {
    assert.match(markdown, new RegExp(gate.gateId, "u"));
    assert.match(markdown, new RegExp(gate.status, "u"));
    assert.match(markdown, new RegExp(gate.reason, "u"));
  }
});

test("help gives a credential-free first command and exact syntax", () => {
  const result = spawnSync(process.execPath, [cli, "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { LANG: "C", PATH: process.env.PATH, TZ: "UTC" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/u);
  assert.match(result.stdout, /--fixture synthetic/u);
  assert.match(result.stdout, /--config <relative-path>/u);
  assert.match(
    result.stdout,
    /normalize --fixture synthetic --format markdown/u,
  );
  assert.equal(result.stderr, "");
});

test("legacy command names are rejected instead of silently changing meaning", () => {
  const result = run("audit", "json");
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    code: "RO_COMMAND_INVALID",
    message:
      "Command must be validate-config, normalize, audit-eval, benchmark, or recommend-architecture.",
    status: "BLOCKED",
  });
});

test("supplied static diagnostics stay secondary when a binding does not match lane evidence", () => {
  const fixture = path.join(
    repoRoot,
    "plugins",
    "reviewops-auditor-benchmark",
    "fixtures",
    "synthetic",
  );
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "reviewops-static-"));
  fs.cpSync(fixture, temp, { recursive: true });
  const configPath = path.join(temp, "reviewops.config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.staticDiagnostics = {
    workflowPaths: ["workflows/code-review.yml"],
    promptPaths: ["prompts/reviewer.md"],
    telemetryPaths: [],
    toolContractPaths: [],
    validatorResultPaths: [],
    bindings: [
      {
        ruleId: "RO-WF-001",
        path: "workflows/code-review.yml",
        laneId: "portable-core-2026-08",
        variantId: "candidate-a",
        architectureStructuralDigest: "sha256:" + "f".repeat(64),
        applicableToShadowPath: true,
      },
    ],
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const jsonRun = runConfig(temp, "audit-eval", "json");
  assert.equal(jsonRun.status, 0, jsonRun.stderr);
  const report = JSON.parse(jsonRun.stdout);
  assert.equal(report.staticDiagnosticContext, "SUPPLIED");
  assert.ok(report.staticDiagnostics.findings.length > 0);
  assert.ok(
    report.staticDiagnostics.findings.every(
      (finding) =>
        finding.binding === null &&
        finding.applicableToShadowPath === false &&
        finding.blocksShadowPath === false,
    ),
  );
  const markdown = unescapeMarkdown(
    runConfig(temp, "audit-eval", "markdown").stdout,
  );
  assert.match(markdown, /Binding/u);
  assert.match(markdown, /None/u);
  assert.match(markdown, /Possible contributor; not causal evidence./u);
});
