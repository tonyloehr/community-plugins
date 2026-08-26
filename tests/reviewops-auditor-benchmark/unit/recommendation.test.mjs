import assert from "node:assert/strict";
import test from "node:test";

import { recommendReferenceArchitecture } from "../../../plugins/reviewops-auditor-benchmark/src/recommend/index.mjs";
import { buildStaticDiagnostics } from "../../../plugins/reviewops-auditor-benchmark/src/audit/index.mjs";

function policy(overrides = {}) {
  return {
    schemaVersion: 1,
    policyId: "strict-v1",
    confidenceLevel: 0.95,
    bootstrapIterations: 1000,
    bootstrapSeed: "seed-v1",
    minimumPairedCases: 20,
    minimumPairedCasesPerSlice: 20,
    decisionSliceIds: ["critical"],
    sliceMultiplicityMethod: "HOLM_BONFERRONI",
    minimumMetricCoverage: 1,
    minimumRootCauseCoverage: 1,
    maxPricingAgeDays: 30,
    requiredCostBasis: "FULLY_LOADED",
    highCriticalRootCauseNonInferiorityMargin: 0,
    criticalMissNonInferiorityMargin: 0,
    hallucinationNonInferiorityMargin: 0,
    actionablePrecisionNonInferiorityMargin: 0,
    rootCauseQualityNonInferiorityMargin: 0,
    minimumCostPerConfirmedHighCriticalRootCauseImprovementFraction: 0.1,
    maximumHumanReviewRegressionFraction: 0,
    maximumP95CostRegressionFraction: 0,
    maximumP99CostRegressionFraction: 0,
    maximumP95LatencyRegressionFraction: 0,
    maximumP99LatencyRegressionFraction: 0,
    minimumFindingStability: 1,
    blockingStaticRuleIds: ["RO-WF-001"],
    allowedExceptionTypes: ["P95_LATENCY", "P99_COST", "HUMAN_REVIEW"],
    tiePolicy: "LOWEST_ROOT_CAUSE_COST",
    shadowObservationDays: 14,
    rollbackCriticalMisses: 0,
    exceptions: [],
    ...overrides,
  };
}

function metric(value) {
  return {
    status: "AVAILABLE",
    value,
    coverage: 1,
  };
}

function variantMetrics(cost, latency) {
  return {
    highCriticalRootCauseRecall: metric(1),
    criticalMissRate: metric(0),
    actionablePrecision: metric(1),
    hallucinationRate: metric(0),
    rootCauseQuality: metric(1),
    fullyLoadedCostPerConfirmedHighCriticalRootCause: metric(cost),
    fullyLoadedCostPerConfirmedRootCause: metric(cost),
    humanReviewMinutesPerCase: metric(1),
    costP95: metric(cost),
    costP99: metric(cost),
    latencyP95: metric(latency),
    latencyP99: metric(latency),
    findingStability: metric(1),
  };
}

function comparisonMetrics(confidenceLevel = 0.95) {
  const interval = (lower, upper) => ({
    status: "AVAILABLE",
    lower,
    upper,
    confidenceLevel,
  });
  return {
    highCriticalRootCauseRecall: { interval: interval(0, 0) },
    criticalMissRate: { interval: interval(0, 0) },
    actionablePrecision: { interval: interval(0, 0) },
    hallucinationRate: { interval: interval(0, 0) },
    rootCauseQuality: { interval: interval(0, 0) },
    fullyLoadedCostPerConfirmedHighCriticalRootCause: {
      interval: interval(-20, -20),
    },
    humanReviewMinutesPerCase: { interval: interval(-1, -1) },
    costP95: { interval: interval(-20, -20) },
    costP99: { interval: interval(-20, -20) },
    latencyP95: { interval: interval(-10, -10) },
    latencyP99: { interval: interval(-10, -10) },
  };
}

function lane(overrides = {}) {
  return {
    bundleId: "best-system",
    laneId: "best-system",
    laneType: "BEST_SYSTEM",
    status: "COMPLETE",
    attributionStatus: "HOLISTIC_VARIANT",
    claimBoundary: "Holistic comparison only.",
    pairedCaseCount: 30,
    pricingSnapshot: {
      costBasis: "FULLY_LOADED",
      effectiveAt: "2026-08-01T00:00:00Z",
    },
    baselineVariantId: "baseline",
    global: {
      variants: [
        {
          variantId: "baseline",
          metrics: variantMetrics(100, 100),
        },
        {
          variantId: "candidate-a",
          metrics: variantMetrics(80, 90),
        },
      ],
      frontier: [{ variantId: "candidate-a", status: "NON_DOMINATED" }],
      comparisons: [
        {
          baselineVariantId: "baseline",
          candidateVariantId: "candidate-a",
          metrics: comparisonMetrics(),
        },
      ],
    },
    slices: [
      {
        sliceId: "critical",
        status: "COMPLETE",
        decisionEligible: true,
        pairedCaseCount: 30,
        variants: [
          {
            variantId: "baseline",
            metrics: variantMetrics(100, 100),
          },
          {
            variantId: "candidate-a",
            metrics: variantMetrics(80, 90),
          },
        ],
        frontier: [{ variantId: "candidate-a", status: "NON_DOMINATED" }],
        comparisons: [
          {
            baselineVariantId: "baseline",
            candidateVariantId: "candidate-a",
            metrics: comparisonMetrics(0.95),
          },
        ],
        multiplicity: {
          method: "HOLM_BONFERRONI",
          familySize: 1,
          adjustedConfidenceLevel: 0.95,
        },
      },
    ],
    ...overrides,
  };
}

const contracts = {
  controllerContractId: "controller-v1",
  validatorContractId: "validator-v1",
  dedupePolicyId: "dedupe-v1",
  postingPolicyId: "posting-v1",
};
const architectureDigest = "sha256:" + "a".repeat(64);

function recommendation(options = {}) {
  const scorecardLane = options.lane ?? lane();
  return recommendReferenceArchitecture({
    scorecard: { lanes: [scorecardLane] },
    normalizedLanes: [
      {
        candidateConfigs: [
          {
            variantId: "candidate-a",
            architectureId: "architecture-a",
            architectureStructuralDigest: architectureDigest,
          },
          {
            variantId: "candidate-b",
            architectureId: "architecture-b",
            architectureStructuralDigest: architectureDigest,
          },
        ],
        runs: [
          {
            variantId: "candidate-a",
            architectureId: "architecture-a",
            architectureStructuralDigest: architectureDigest,
          },
          {
            variantId: "candidate-b",
            architectureId: "architecture-b",
            architectureStructuralDigest: architectureDigest,
          },
        ],
        manifest: {
          productionBaselineContracts: contracts,
        },
      },
    ],
    decisionPolicy: options.decisionPolicy ?? policy(),
    analysisAsOf: "2026-08-15T00:00:00Z",
    staticDiagnostics: options.staticDiagnostics,
  });
}

test("reference architecture stays shadow-only and preserves baseline contracts", () => {
  const result = recommendation();
  assert.equal(result.recommendationStatus, "RECOMMENDED_FOR_SHADOW");
  assert.equal(result.defaultArchitectureId, "architecture-a");
  assert.deepEqual(result.preservedContracts, contracts);
  assert.deepEqual(result.shadowPilot, {
    executionMode: "SHADOW_NO_POSTING",
    minimumCases: 20,
    observationDays: 14,
    humanApprovalRequired: true,
    rollbackCriticalMisses: 0,
  });
  assert.equal(
    result.perSliceArchitectures[0].architectureId,
    "architecture-a",
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /writeback|command|patch|suppress/iu,
  );
});

test("missing policy and portable-only evidence cannot produce a default", () => {
  const missingPolicy = recommendReferenceArchitecture({
    scorecard: { lanes: [lane()] },
    normalizedLanes: [
      {
        candidateConfigs: [
          {
            variantId: "candidate-a",
            architectureId: "architecture-a",
            architectureStructuralDigest: architectureDigest,
          },
        ],
        runs: [
          {
            variantId: "candidate-a",
            architectureId: "architecture-a",
            architectureStructuralDigest: architectureDigest,
          },
        ],
        manifest: { productionBaselineContracts: contracts },
      },
    ],
    analysisAsOf: "2026-08-15T00:00:00Z",
  });
  assert.equal(missingPolicy.recommendationStatus, "INSUFFICIENT_EVIDENCE");
  assert.equal(missingPolicy.defaultArchitectureId, undefined);

  const portable = recommendation({
    lane: lane({ laneType: "PORTABLE_CORE_MODEL" }),
  });
  assert.equal(portable.recommendationStatus, "INSUFFICIENT_EVIDENCE");
  assert.equal(portable.defaultArchitectureId, undefined);
  assert.ok(portable.rationale.includes("NO_RECOMMENDABLE_LANE"));
});

test("unbound static findings explain but only an explicit bound predicate blocks", () => {
  const unbound = recommendation({
    staticDiagnostics: {
      status: "COMPLETE",
      findings: [
        {
          ruleId: "RO-WF-001",
          evidenceStatus: "OBSERVED",
          severity: "CRITICAL",
          confidence: "HIGH",
          applicableToShadowPath: false,
          blocksShadowPath: false,
        },
      ],
    },
  });
  assert.equal(unbound.recommendationStatus, "RECOMMENDED_FOR_SHADOW");

  const bound = recommendation({
    staticDiagnostics: {
      status: "COMPLETE",
      findings: [
        {
          ruleId: "RO-WF-001",
          evidenceStatus: "OBSERVED",
          severity: "CRITICAL",
          confidence: "HIGH",
          binding: {
            laneId: "best-system",
            variantId: "candidate-a",
            architectureStructuralDigest: architectureDigest,
          },
          applicableToShadowPath: true,
          blocksShadowPath: true,
        },
      ],
    },
  });
  assert.equal(bound.recommendationStatus, "BLOCKED_BY_SAFETY_GATE");
  assert.equal(
    bound.gates.find((gate) => gate.gateId === "RO-GATE-STATIC-DIAGNOSTICS")
      .status,
    "BLOCKED",
  );

  const unrelated = recommendation({
    staticDiagnostics: {
      status: "COMPLETE",
      findings: [
        {
          ruleId: "RO-WF-001",
          evidenceStatus: "OBSERVED",
          severity: "CRITICAL",
          confidence: "HIGH",
          binding: {
            laneId: "other-lane",
            variantId: "candidate-a",
            architectureStructuralDigest: architectureDigest,
          },
          applicableToShadowPath: true,
          blocksShadowPath: true,
        },
      ],
    },
  });
  assert.equal(unrelated.recommendationStatus, "RECOMMENDED_FOR_SHADOW");
});

test("no-automatic-winner policy never invents a winner", () => {
  const tied = lane({
    global: {
      variants: [
        { variantId: "baseline", metrics: {} },
        { variantId: "candidate-a", metrics: {} },
        { variantId: "candidate-b", metrics: {} },
      ],
      frontier: [
        { variantId: "candidate-a", status: "NON_DOMINATED" },
        { variantId: "candidate-b", status: "NON_DOMINATED" },
      ],
    },
  });
  const result = recommendation({
    lane: tied,
    decisionPolicy: policy({ tiePolicy: "NO_AUTOMATIC_WINNER" }),
  });
  assert.equal(result.recommendationStatus, "NO_CHANGE_RECOMMENDED");
  assert.equal(result.defaultArchitectureId, undefined);
  assert.ok(result.rationale.includes("NO_ELIGIBLE_NON_BASELINE_ARCHITECTURE"));
});

test("architecture alias is withheld when its structural receipt is not verified", () => {
  const result = recommendReferenceArchitecture({
    scorecard: { lanes: [lane()] },
    normalizedLanes: [
      {
        candidateConfigs: [
          {
            variantId: "candidate-a",
            architectureId: "architecture-a",
            architectureStructuralDigest: architectureDigest,
          },
        ],
        runs: [
          {
            variantId: "candidate-a",
            architectureId: "architecture-a",
            architectureStructuralDigest: "sha256:" + "b".repeat(64),
          },
        ],
        manifest: { productionBaselineContracts: contracts },
      },
    ],
    decisionPolicy: policy(),
    analysisAsOf: "2026-08-15T00:00:00Z",
  });
  assert.equal(result.recommendationStatus, "INSUFFICIENT_EVIDENCE");
  assert.equal(result.defaultArchitectureId, undefined);
  assert.ok(result.rationale.includes("MISSING_ARCHITECTURE_MAPPING"));
});

test("static diagnostics emit explicit null or verified binding context", () => {
  const inputs = {
    workflows: [
      {
        relativePath: "workflows/review.yml",
        text: [
          "name: review",
          "on: pull_request",
          "jobs:",
          "  review:",
          "    runs-on: ubuntu-latest",
          "    steps: []",
          "",
        ].join("\n"),
      },
    ],
  };
  const unbound = buildStaticDiagnostics(inputs);
  const unboundFinding = unbound.findings.find(
    (finding) => finding.ruleId === "RO-WF-001",
  );
  assert.equal(unboundFinding.binding, null);
  assert.equal(unboundFinding.applicableToShadowPath, false);
  assert.equal(unboundFinding.blocksShadowPath, false);

  const bound = buildStaticDiagnostics(inputs, {
    bindings: [
      {
        ruleId: "RO-WF-001",
        path: "workflows/review.yml",
        laneId: "best-system",
        variantId: "candidate-a",
        architectureStructuralDigest: architectureDigest,
        applicableToShadowPath: true,
      },
    ],
    blockingStaticRuleIds: ["RO-WF-001"],
  });
  const boundFinding = bound.findings.find(
    (finding) => finding.ruleId === "RO-WF-001",
  );
  assert.deepEqual(boundFinding.binding, {
    laneId: "best-system",
    variantId: "candidate-a",
    architectureStructuralDigest: architectureDigest,
  });
  assert.equal(boundFinding.applicableToShadowPath, true);
  assert.equal(boundFinding.blocksShadowPath, false);
  assert.equal(boundFinding.possibleContributorOnly, true);
});

test("missing stability and protected-contract drift fail closed", () => {
  const unstable = structuredClone(lane());
  unstable.global.variants.find(
    (variant) => variant.variantId === "candidate-a",
  ).metrics.findingStability = {
    status: "UNAVAILABLE",
    value: null,
    coverage: 0,
  };
  const missingStability = recommendation({ lane: unstable });
  assert.equal(missingStability.recommendationStatus, "INSUFFICIENT_EVIDENCE");
  assert.equal(
    missingStability.gates.find((gate) => gate.gateId === "RO-GATE-STABILITY")
      .reason,
    "MISSING_STABILITY_EVIDENCE",
  );
  assert.equal(
    missingStability.perSliceArchitectures.some(
      (slice) => slice.architectureId !== undefined,
    ),
    false,
  );

  const drifted = lane({
    candidateContractDifferences: [
      {
        variantId: "candidate-a",
        field: "postingPolicyId",
      },
    ],
  });
  const blocked = recommendation({ lane: drifted });
  assert.equal(blocked.recommendationStatus, "BLOCKED_BY_SAFETY_GATE");
  assert.equal(
    blocked.gates.find((gate) => gate.gateId === "RO-GATE-PRESERVATION").status,
    "BLOCKED",
  );
});

test("an unrelated blocked lane stays lane-scoped", () => {
  const result = recommendReferenceArchitecture({
    scorecard: {
      lanes: [
        lane(),
        lane({
          bundleId: "portable-core",
          laneId: "portable-core",
          laneType: "PORTABLE_CORE_MODEL",
          status: "BLOCKED",
          attributionStatus: "UNKNOWN",
        }),
      ],
    },
    normalizedLanes: [
      {
        candidateConfigs: [
          {
            variantId: "candidate-a",
            architectureId: "architecture-a",
            architectureStructuralDigest: architectureDigest,
          },
        ],
        runs: [
          {
            variantId: "candidate-a",
            architectureId: "architecture-a",
            architectureStructuralDigest: architectureDigest,
          },
        ],
        manifest: { productionBaselineContracts: contracts },
      },
    ],
    decisionPolicy: policy(),
    analysisAsOf: "2026-08-15T00:00:00Z",
  });
  assert.equal(result.recommendationStatus, "RECOMMENDED_FOR_SHADOW");
  assert.equal(result.defaultArchitectureId, "architecture-a");
});

test("recommendation never borrows architecture provenance from another lane", () => {
  const secondDigest = "sha256:" + "b".repeat(64);
  const result = recommendReferenceArchitecture({
    scorecard: {
      lanes: [
        lane({ bundleId: "best-a", laneId: "best-a" }),
        lane({ bundleId: "best-b", laneId: "best-b" }),
      ],
    },
    normalizedLanes: [
      {
        bundleId: "best-a",
        laneId: "best-a",
        candidateConfigs: [
          {
            variantId: "candidate-a",
            architectureId: "architecture-a",
            architectureStructuralDigest: architectureDigest,
          },
        ],
        runs: [
          {
            variantId: "candidate-a",
            architectureId: "architecture-a",
            architectureStructuralDigest: architectureDigest,
          },
        ],
        manifest: { productionBaselineContracts: contracts },
      },
      {
        bundleId: "best-b",
        laneId: "best-b",
        candidateConfigs: [
          {
            variantId: "candidate-a",
            architectureId: "architecture-b",
            architectureStructuralDigest: secondDigest,
          },
        ],
        runs: [
          {
            variantId: "candidate-a",
            architectureId: "architecture-b",
            architectureStructuralDigest: secondDigest,
          },
        ],
        manifest: { productionBaselineContracts: contracts },
      },
    ],
    decisionPolicy: policy(),
    analysisAsOf: "2026-08-15T00:00:00Z",
  });
  assert.equal(result.recommendationStatus, "INSUFFICIENT_EVIDENCE");
  assert.equal(result.defaultArchitectureId, undefined);
  assert.equal(
    result.gates.find(
      (gate) => gate.gateId === "RO-GATE-LANE-COMPATIBILITY",
    ).reason,
    "INCOMPATIBLE_ARCHITECTURE_PROVENANCE",
  );
});

test("an explicit single-lane identity mismatch fails closed", () => {
  const result = recommendReferenceArchitecture({
    scorecard: { lanes: [lane({ bundleId: "best-a", laneId: "best-a" })] },
    normalizedLanes: [
      {
        bundleId: "best-b",
        laneId: "best-b",
        candidateConfigs: [
          {
            variantId: "candidate-a",
            architectureId: "architecture-b",
            architectureStructuralDigest: architectureDigest,
          },
        ],
        runs: [
          {
            variantId: "candidate-a",
            architectureId: "architecture-b",
            architectureStructuralDigest: architectureDigest,
          },
        ],
        manifest: { productionBaselineContracts: contracts },
      },
    ],
    decisionPolicy: policy(),
    analysisAsOf: "2026-08-15T00:00:00Z",
  });
  assert.equal(result.recommendationStatus, "INSUFFICIENT_EVIDENCE");
  assert.equal(result.defaultArchitectureId, undefined);
  assert.equal(result.preservedContracts, null);
  assert.equal(
    result.gates.find(
      (gate) => gate.gateId === "RO-GATE-LANE-COMPATIBILITY",
    ).reason,
    "MISSING_LANE_PROVENANCE",
  );
  assert.ok(result.rationale.includes("MISSING_ARCHITECTURE_MAPPING"));
});

test("slice architecture requires adjusted interval-backed gates", () => {
  const failedSlice = structuredClone(lane());
  failedSlice.slices[0].comparisons[0].metrics.criticalMissRate.interval = {
    status: "AVAILABLE",
    lower: 0.1,
    upper: 0.1,
    confidenceLevel: 0.95,
  };
  const failed = recommendation({ lane: failedSlice });
  assert.equal(failed.recommendationStatus, "RECOMMENDED_FOR_SHADOW");
  assert.equal(failed.perSliceArchitectures[0].architectureId, undefined);
  assert.equal(failed.perSliceArchitectures[0].status, "INSUFFICIENT_EVIDENCE");
  assert.ok(
    failed.perSliceArchitectures[0].reasonCodes.includes(
      "NON_INFERIORITY_NOT_SATISFIED",
    ),
  );

  const unadjusted = structuredClone(lane());
  delete unadjusted.slices[0].multiplicity;
  const missingMultiplicity = recommendation({ lane: unadjusted });
  assert.equal(
    missingMultiplicity.perSliceArchitectures[0].architectureId,
    undefined,
  );
  assert.ok(
    missingMultiplicity.perSliceArchitectures[0].reasonCodes.includes(
      "MISSING_HOLM_BONFERRONI_INTERVAL_EVIDENCE",
    ),
  );
});
