import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const pluginRoot = path.join(
  repoRoot,
  "plugins",
  "reviewops-auditor-benchmark",
);
const cli = path.join(pluginRoot, "scripts", "reviewops.mjs");

function runCli(args, cwd = pluginRoot) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      LANG: "C",
      PATH: process.env.PATH,
      TZ: "UTC",
    },
  });
}

function jsonResult(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("synthetic normalization is bounded and receipt-only", () => {
  const report = jsonResult(
    runCli(["normalize", "--fixture", "synthetic", "--format", "json"]),
  );
  assert.equal(report.status, "COMPLETE");
  assert.equal(report.toolVersion, "0.1.0");
  assert.equal(report.bundles.length, 2);
  assert.deepEqual(
    report.bundles.map((bundle) => bundle.bundleId),
    ["portable-core", "best-system"],
  );
  assert.ok(
    report.bundles.every(
      (bundle) =>
        bundle.sourceRecordCount === 80 &&
        bundle.acceptedRecordCount === 80 &&
        bundle.rejectedRecordCount === 0 &&
        bundle.normalizedRecordCount === 80,
    ),
  );
  assert.match(report.claimBoundary, /not emitted/u);
  assert.doesNotMatch(JSON.stringify(report), /findingId|matchedRootCauseIds/u);
});

test("synthetic eval audit is paired, declared, and claim-bounded", () => {
  const report = jsonResult(
    runCli(["audit-eval", "--fixture", "synthetic", "--format", "json"]),
  );
  assert.equal(report.status, "COMPLETE");
  assert.equal(report.staticDiagnosticContext, "NOT_SUPPLIED");
  assert.deepEqual(
    report.lanes.map((lane) => [
      lane.bundleId,
      lane.laneType,
      lane.attributionStatus,
      lane.pairedCaseCount,
    ]),
    [
      ["portable-core", "PORTABLE_CORE_MODEL", "SINGLE_FACTOR", 20],
      ["best-system", "BEST_SYSTEM", "HOLISTIC_VARIANT", 20],
    ],
  );
  assert.ok(
    report.lanes.every((lane) =>
      lane.checks.every((check) => check.evidenceStatus === "DECLARED"),
    ),
  );
  assert.match(report.claimBoundary, /does not prove private runtime behavior/u);
});

test("synthetic benchmark is deterministic, lane-scoped, and root-cause-first", () => {
  const first = runCli([
    "benchmark",
    "--fixture",
    "synthetic",
    "--format",
    "json",
  ]);
  const second = runCli([
    "benchmark",
    "--fixture",
    "synthetic",
    "--format",
    "json",
  ]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  const report = JSON.parse(first.stdout);
  assert.equal(report.status, "COMPLETE");
  assert.equal(report.lanes.length, 2);
  const bestSystem = report.lanes.find(
    (lane) => lane.laneType === "BEST_SYSTEM",
  );
  assert.equal(bestSystem.pairedCaseCount, 20);
  assert.equal(bestSystem.replicateAggregation, "CASE_PRIMITIVES");
  assert.equal(
    bestSystem.global.frontier.find((item) => item.variantId === "candidate-a")
      ?.status,
    "NON_DOMINATED",
  );
  const candidate = bestSystem.global.variants.find(
    (variant) => variant.variantId === "candidate-a",
  );
  assert.equal(candidate.eligible, true);
  const highCriticalCost = candidate.metrics.find(
    (metric) =>
      metric.metricId ===
      "fully_loaded_cost_per_confirmed_high_critical_root_cause",
  );
  const stability = candidate.metrics.find(
    (metric) => metric.metricId === "finding_stability",
  );
  const recall = candidate.metrics.find(
    (metric) => metric.metricId === "high_critical_root_cause_recall",
  );
  assert.equal(
    highCriticalCost.value,
    500000,
  );
  assert.equal(stability.value, 1);
  assert.deepEqual(recall.missingness, { count: 0, reasonCodes: [] });
});

test("synthetic recommendation is shadow-only and preserves production contracts", () => {
  const report = jsonResult(
    runCli([
      "recommend-architecture",
      "--fixture",
      "synthetic",
      "--format",
      "json",
    ]),
  );
  assert.equal(report.status, "COMPLETE");
  assert.equal(report.recommendationStatus, "RECOMMENDED_FOR_SHADOW");
  assert.equal(report.defaultArchitectureId, "candidate-a");
  assert.equal(report.decisionPolicyId, "conservative-root-cause-v1");
  assert.equal(report.shadowPilot.executionMode, "SHADOW_NO_POSTING");
  assert.equal(report.shadowPilot.humanApprovalRequired, true);
  assert.deepEqual(report.preservedContracts, {
    controllerContractId: "controller-v1",
    validatorContractId: "validator-v1",
    dedupePolicyId: "dedupe-v1",
    postingPolicyId: "posting-v1",
  });
  assert.ok(report.gates.every((gate) => gate.status === "PASS"));
  assert.doesNotMatch(JSON.stringify(report), /command|patch|writeback/iu);
});

test("Markdown output is text-accessible for every public analysis command", () => {
  const expectations = new Map([
    [
      "normalize",
      [/^# ReviewOps normalization report/mu, /^## Bundles/mu],
    ],
    [
      "audit-eval",
      [/^# ReviewOps eval validity report/mu, /^## Lanes/mu],
    ],
    [
      "benchmark",
      [/^# ReviewOps benchmark scorecard/mu, /^## Lanes/mu, /^### Variant metrics/mu],
    ],
    [
      "recommend-architecture",
      [
        /^# ReviewOps reference architecture/mu,
        /^## Recommendation/mu,
        /^### Safety gates/mu,
      ],
    ],
  ]);
  for (const [command, patterns] of expectations) {
    const result = runCli([
      command,
      "--fixture",
      "synthetic",
      "--format",
      "markdown",
    ]);
    assert.equal(result.status, 0, command + ": " + result.stderr);
    assert.match(result.stdout, /^Status: COMPLETE/mu);
    assert.match(result.stdout, /^Claim boundary:/mu);
    assert.match(result.stdout, /^## Inputs/mu);
    assert.match(result.stdout, /^## Safety notes/mu);
    for (const pattern of patterns) {
      assert.match(result.stdout, pattern, command);
    }
    assert.doesNotMatch(result.stdout, //u);
  }
});

test("validate-config accepts the fixed synthetic config", () => {
  const report = jsonResult(
    runCli(["validate-config", "--fixture", "synthetic", "--format", "json"]),
  );
  assert.equal(report.status, "COMPLETE");
  assert.match(report.configDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(report.inputDigests.length, 1);
  assert.equal(report.redactionCounts.total, 0);
});
