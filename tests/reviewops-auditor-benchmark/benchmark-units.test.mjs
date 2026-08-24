import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBenchmarkScorecard,
  buildLaneBenchmarkScorecard,
  buildLanePairedComparison,
  buildMultiLaneScorecards,
  buildPairedComparison,
  calculateLaneMetrics,
  calculateMetrics,
  computeParetoFrontier,
  normalizeBenchmarkInput,
  pairedBootstrapInterval,
} from "../../plugins/reviewops-auditor-benchmark/src/benchmark/index.mjs";
import {
  computeStructuralReceipts,
  normalizeLaneBundle,
} from "../../plugins/reviewops-auditor-benchmark/src/normalize/index.mjs";
import { pairedBootstrapStatisticInterval } from "../../plugins/reviewops-auditor-benchmark/src/benchmark/confidence.mjs";
import { pairingForSlice } from "../../plugins/reviewops-auditor-benchmark/src/benchmark/slices.mjs";
import { calculateFindingStability } from "../../plugins/reviewops-auditor-benchmark/src/benchmark/stability.mjs";

const RUBRIC = {
  rubricId: "rubric-v1",
  version: "1",
  severityWeights: { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 4, CRITICAL: 8 },
  matchingRules: {
    allowOneFindingMultipleGroundTruth: false,
    allowMultipleFindingsPerGroundTruth: false,
  },
};

const PRICING = {
  snapshotId: "pricing-v1",
  currency: "USD",
  effectiveAt: "2026-08-01T00:00:00Z",
  rates: [],
};

function caseLabel(index) {
  return {
    schemaVersion: 1,
    caseId: "case-" + index,
    rubricId: "rubric-v1",
    labelVersion: "1",
    groundTruth: [
      {
        groundTruthId: "truth-" + index,
        severity: "HIGH",
        tags: ["cross-file"],
      },
    ],
  };
}

function run(index, variantId, overrides = {}) {
  const findingId = variantId + "-finding-" + index;
  return {
    schemaVersion: 1,
    caseId: "case-" + index,
    variantId,
    runId: variantId + "-run-" + index,
    contextDigest: "context-" + index,
    toolContractId: "tools-v1",
    startedAt: "2026-08-01T00:00:00Z",
    latencyMs: variantId === "baseline" ? 100 : 80,
    cost: {
      currency: "USD",
      amount: variantId === "baseline" ? 1 : 0.5,
      pricingSnapshotId: "pricing-v1",
    },
    findings: [
      {
        findingId,
        severity: "HIGH",
        category: "QUALITY",
        verification: "VERIFIED",
        tags: ["cross-file"],
      },
    ],
    adjudication: {
      status: "ADJUDICATED",
      rubricId: "rubric-v1",
      labelVersion: "1",
      findingLabels: [
        {
          findingId,
          outcome: "ACCEPTED",
          matchedGroundTruthIds: ["truth-" + index],
        },
      ],
    },
    ...overrides,
  };
}

function input(caseCount = 20, candidateOverrides = () => ({})) {
  const runs = [];
  const caseLabels = [];
  for (let index = 0; index < caseCount; index += 1) {
    caseLabels.push(caseLabel(index));
    runs.push(run(index, "baseline"));
    runs.push(run(index, "candidate", candidateOverrides(index)));
  }
  return {
    runs,
    caseLabels,
    rubric: structuredClone(RUBRIC),
    pricingSnapshot: structuredClone(PRICING),
  };
}

function manifest(caseCount = 1, overrides = {}) {
  return {
    corpusId: "corpus-v1",
    exporterVersion: "exporter-v1",
    caseIds: Array.from({ length: caseCount }, (_, index) => "case-" + index),
    variantIds: ["baseline", "candidate"],
    toolContractId: "tools-v1",
    rubricId: "rubric-v1",
    labelVersion: "1",
    pricingSnapshotId: "pricing-v1",
    ...overrides,
  };
}

function candidates(variantIds = ["baseline", "candidate"]) {
  return variantIds.map((variantId) => ({ variantId }));
}

function mutatedInput(mutate) {
  const source = input(1);
  mutate(source);
  return source;
}

function metric(value) {
  return { status: "AVAILABLE", value, coverage: 1 };
}

test("normalization blocks duplicate runs and contradictory matches", () => {
  const duplicate = input(1);
  duplicate.runs.push(run(0, "baseline", { runId: "second-run-id" }));
  const duplicateResult = normalizeBenchmarkInput(duplicate);
  assert.equal(duplicateResult.status, "BLOCKED");
  assert.ok(
    duplicateResult.errors.some(
      (entry) => entry.code === "DUPLICATE_CASE_VARIANT_RUN",
    ),
  );

  const contradictory = input(1);
  contradictory.runs[1].adjudication.findingLabels[0].outcome = "REJECTED";
  const contradictoryResult = normalizeBenchmarkInput(contradictory);
  assert.equal(contradictoryResult.status, "BLOCKED");
  assert.ok(
    contradictoryResult.errors.some(
      (entry) => entry.code === "CONTRADICTORY_ADJUDICATION",
    ),
  );
});

test("normalization fails closed for malformed records and manifest contradictions", () => {
  const malformedCases = [
    {
      name: "non-object input",
      value: null,
      code: "INVALID_BENCHMARK_INPUT",
    },
    {
      name: "non-array runs",
      value: { ...input(1), runs: "not-an-array" },
      code: "INVALID_RUN_RECORDS",
    },
    {
      name: "missing run identity",
      value: mutatedInput((source) => {
        source.runs[0].runId = "";
      }),
      code: "INVALID_RUN_ID",
    },
    {
      name: "unsafe token accounting",
      value: mutatedInput((source) => {
        source.runs[0].usage = {
          inputTokens: 1,
          outputTokens: 0,
          cachedInputTokens: 2,
        };
      }),
      code: "INVALID_USAGE",
    },
    {
      name: "negative cost",
      value: mutatedInput((source) => {
        source.runs[0].cost.amount = -1;
      }),
      code: "INVALID_COST",
    },
    {
      name: "unsupported finding severity",
      value: mutatedInput((source) => {
        source.runs[0].findings[0].severity = "UNKNOWN";
      }),
      code: "INVALID_FINDING_SEVERITY",
    },
    {
      name: "unsupported adjudication",
      value: mutatedInput((source) => {
        source.runs[0].adjudication.status = "GUESS";
      }),
      code: "INVALID_ADJUDICATION_STATUS",
    },
    {
      name: "non-UTC timestamp",
      value: mutatedInput((source) => {
        source.runs[0].startedAt = "2026-08-01";
      }),
      code: "INVALID_STARTED_AT",
    },
    {
      name: "malformed ground truth",
      value: mutatedInput((source) => {
        source.caseLabels[0].groundTruth = [{ severity: "HIGH" }];
      }),
      code: "INVALID_GROUND_TRUTH",
    },
    {
      name: "invalid pricing timestamp",
      value: mutatedInput((source) => {
        source.pricingSnapshot.effectiveAt = "not-a-time";
      }),
      code: "INVALID_PRICING_EFFECTIVE_AT",
    },
  ];
  for (const { name, value, code } of malformedCases) {
    const result = normalizeBenchmarkInput(value);
    assert.equal(result.status, "BLOCKED", name);
    assert.ok(
      result.errors.some((entry) => entry.code === code),
      name,
    );
  }

  const manifestCases = [
    {
      name: "pricing provenance mismatch",
      overrides: { pricingSnapshotId: "other-pricing" },
      code: "MANIFEST_PRICING_MISMATCH",
    },
    {
      name: "undeclared run case",
      overrides: { caseIds: ["other-case"] },
      code: "RUN_OUTSIDE_MANIFEST",
    },
  ];
  for (const { name, overrides, code } of manifestCases) {
    const result = normalizeBenchmarkInput({
      ...input(1),
      benchmarkManifest: manifest(1, overrides),
      candidateConfigs: candidates(),
    });
    assert.equal(result.status, "BLOCKED", name);
    assert.ok(
      result.errors.some((entry) => entry.code === code),
      name,
    );
  }

  const missingCandidate = normalizeBenchmarkInput({
    ...input(1),
    benchmarkManifest: manifest(),
    candidateConfigs: candidates(["baseline"]),
  });
  assert.ok(
    missingCandidate.errors.some(
      (entry) => entry.code === "MISSING_CANDIDATE_CONFIG",
    ),
  );

  const missingEvidence = normalizeBenchmarkInput({
    runs: [],
    caseLabels: [],
  });
  assert.equal(missingEvidence.status, "PARTIAL");
  assert.deepEqual(
    missingEvidence.warnings.map((entry) => entry.code),
    ["MISSING_RUBRIC", "MISSING_PRICING_SNAPSHOT"],
  );
});

test("pairing reports explicit, missing, and mismatched exclusions", () => {
  const source = input(4);
  source.runs = source.runs.filter(
    (entry) => !(entry.caseId === "case-1" && entry.variantId === "candidate"),
  );
  source.runs.find(
    (entry) => entry.caseId === "case-2" && entry.variantId === "candidate",
  ).contextDigest = "different-context";
  const normalized = normalizeBenchmarkInput(source);
  const pairing = buildPairedComparison(normalized, {
    baselineVariantId: "baseline",
    excludedCaseIds: ["case-0"],
  });
  assert.deepEqual(pairing.pairedCaseIds, ["case-3"]);
  assert.deepEqual(
    pairing.excludedCases.map((entry) => [entry.caseId, entry.reasonCodes]),
    [
      ["case-0", ["EXPLICIT_EXCLUSION"]],
      ["case-1", ["MISSING_VARIANT_RUN"]],
      ["case-2", ["CONTEXT_DIGEST_MISMATCH"]],
    ],
  );
});

test("blocked normalization stops the scorecard pipeline before scoring", () => {
  const scorecard = buildBenchmarkScorecard({ runs: "not-an-array" });
  assert.equal(scorecard.status, "BLOCKED");
  assert.equal(scorecard.pairing, null);
  assert.deepEqual(scorecard.variants, []);
  assert.equal(scorecard.frontier.status, "INSUFFICIENT_EVIDENCE");

  const partialSource = input(2);
  partialSource.runs = partialSource.runs.filter(
    (entry) => !(entry.caseId === "case-0" && entry.variantId === "candidate"),
  );
  const partial = buildBenchmarkScorecard(partialSource, {
    baselineVariantId: "baseline",
    bootstrapIterations: 10,
  });
  assert.equal(partial.status, "PARTIAL");
});

test("scorecard computes paired metrics and bootstrap is byte-stable", () => {
  const scorecard = buildBenchmarkScorecard(input(), {
    baselineVariantId: "baseline",
    bootstrapIterations: 100,
    bootstrapSeed: "unit-seed",
  });
  assert.equal(scorecard.status, "COMPLETE");
  assert.equal(scorecard.pairedCaseCount, 20);
  const candidate = scorecard.variants.find(
    (entry) => entry.variantId === "candidate",
  );
  assert.equal(candidate.metrics.costPerReviewedCase.value, 0.5);
  assert.equal(candidate.metrics.severityWeightedAcceptedRecall.value, 1);
  assert.equal(candidate.metrics.falsePositiveRate.value, 0);
  assert.equal(candidate.metrics.latencyP50.value, 80);
  assert.equal(candidate.metrics.latencyP50.denominator, 20);
  assert.equal(candidate.metrics.latencyP95.value, 80);
  assert.equal(candidate.metrics.latencyP95.denominator, 20);
  assert.deepEqual(
    pairedBootstrapInterval([1, -1, 2, -2], {
      iterations: 100,
      seed: "fixed",
    }),
    pairedBootstrapInterval([1, -1, 2, -2], {
      iterations: 100,
      seed: "fixed",
    }),
  );
});

test("zero quality denominators stay unavailable instead of becoming zero", () => {
  const source = input(2);
  for (const label of source.caseLabels) {
    label.groundTruth = [];
  }
  for (const entry of source.runs) {
    entry.adjudication.findingLabels[0].matchedGroundTruthIds = [];
  }
  const scorecard = buildBenchmarkScorecard(source, {
    baselineVariantId: "baseline",
    bootstrapIterations: 10,
  });
  const candidate = scorecard.variants.find(
    (entry) => entry.variantId === "candidate",
  );
  assert.equal(
    candidate.metrics.severityWeightedAcceptedRecall.status,
    "UNAVAILABLE",
  );
  assert.ok(
    candidate.metrics.severityWeightedAcceptedRecall.reasonCodes.includes(
      "ZERO_DENOMINATOR",
    ),
  );
});

test("partial required evidence cannot produce a complete scorecard", () => {
  const source = input();
  delete source.runs.find(
    (entry) => entry.caseId === "case-0" && entry.variantId === "candidate",
  ).cost;
  const scorecard = buildBenchmarkScorecard(source, {
    baselineVariantId: "baseline",
    bootstrapIterations: 100,
    bootstrapSeed: "unit-seed",
  });
  const candidate = scorecard.variants.find(
    (entry) => entry.variantId === "candidate",
  );
  assert.equal(scorecard.status, "PARTIAL");
  assert.equal(candidate.metrics.costPerReviewedCase.status, "PARTIAL");
  assert.equal(candidate.metrics.costPerReviewedCase.coverage, 0.95);
});

test("schema-supported INFO severity remains valid in runtime normalization", () => {
  const source = input();
  source.runs[0].findings[0].severity = "INFO";
  source.caseLabels[0].groundTruth[0].severity = "INFO";
  const normalized = normalizeBenchmarkInput(source);
  assert.equal(normalized.status, "COMPLETE");
  assert.equal(normalized.errors.length, 0);
});

test("Pareto keeps ties, marks dominated variants, and quarantines missing data", () => {
  const dimensions = [
    { metric: "quality", direction: "MAXIMIZE" },
    { metric: "cost", direction: "MINIMIZE" },
  ];
  const frontier = computeParetoFrontier(
    [
      { variantId: "a", metrics: { quality: metric(1), cost: metric(1) } },
      { variantId: "b", metrics: { quality: metric(1), cost: metric(1) } },
      { variantId: "c", metrics: { quality: metric(0.5), cost: metric(2) } },
      {
        variantId: "d",
        metrics: {
          quality: metric(1),
          cost: { status: "UNAVAILABLE", value: null, coverage: 0 },
        },
      },
    ],
    dimensions,
  );
  assert.deepEqual(
    frontier.frontier.map((entry) => entry.variantId),
    ["a", "b"],
  );
  assert.deepEqual(frontier.dominated[0].dominatedBy, ["a", "b"]);
  assert.deepEqual(frontier.unknown[0].missingDimensions, ["cost"]);
});

test("bootstrap rejects missing, invalid, and non-finite statistics", () => {
  const cases = [
    {
      name: "no paired values",
      values: [],
      options: {},
      reasonCode: "NO_PAIRED_VALUES",
    },
    {
      name: "non-finite delta",
      values: [1, Number.NaN],
      options: {},
      reasonCode: "INVALID_BOOTSTRAP_INPUT",
    },
    {
      name: "invalid confidence policy",
      values: [1],
      options: { confidenceLevel: 1 },
      reasonCode: "INVALID_BOOTSTRAP_INPUT",
    },
    {
      name: "invalid initial statistic",
      values: [1],
      options: { statistic: () => Number.NaN },
      reasonCode: "INVALID_BOOTSTRAP_STATISTIC",
    },
    {
      name: "invalid resampled statistic",
      values: [1, 2],
      options: {
        statistic: (() => {
          let calls = 0;
          return () => {
            calls += 1;
            return calls === 1 ? 1 : Number.NaN;
          };
        })(),
      },
      reasonCode: "INVALID_BOOTSTRAP_STATISTIC",
    },
  ];
  for (const { name, values, options, reasonCode } of cases) {
    const result = pairedBootstrapInterval(values, options);
    assert.equal(result.status, "UNAVAILABLE", name);
    assert.deepEqual(result.reasonCodes, [reasonCode], name);
  }
});

test("normalizer rejects malformed nested evidence and preserves cost provenance", () => {
  const blockedCases = [
    {
      name: "usage is not structured",
      mutate: (source) => {
        source.runs[0].usage = "bad";
      },
      code: "INVALID_USAGE",
    },
    {
      name: "cost is not structured",
      mutate: (source) => {
        source.runs[0].cost = "bad";
      },
      code: "INVALID_COST",
    },
    {
      name: "finding is not structured",
      mutate: (source) => {
        source.runs[0].findings = [null];
      },
      code: "INVALID_FINDING",
    },
    {
      name: "verification is unsupported",
      mutate: (source) => {
        source.runs[0].findings[0].verification = "MAYBE";
      },
      code: "INVALID_FINDING_VERIFICATION",
    },
    {
      name: "finding labels are not structured",
      mutate: (source) => {
        source.runs[0].adjudication.findingLabels = [null];
      },
      code: "INVALID_FINDING_LABEL",
    },
    {
      name: "label references unknown finding",
      mutate: (source) => {
        source.runs[0].adjudication.findingLabels[0].findingId =
          "other-finding";
      },
      code: "UNKNOWN_FINDING_LABEL",
    },
    {
      name: "ground truth ID is duplicated",
      mutate: (source) => {
        source.caseLabels[0].groundTruth.push({
          ...source.caseLabels[0].groundTruth[0],
        });
      },
      code: "DUPLICATE_GROUND_TRUTH_ID",
    },
    {
      name: "rubric is malformed",
      mutate: (source) => {
        source.rubric = "bad";
      },
      code: "INVALID_RUBRIC",
    },
    {
      name: "pricing rate is malformed",
      mutate: (source) => {
        source.pricingSnapshot.rates = [{ variantId: "candidate" }];
      },
      code: "INVALID_PRICING_RATE",
    },
    {
      name: "manifest is malformed",
      mutate: (source) => {
        source.benchmarkManifest = "bad";
      },
      code: "INVALID_BENCHMARK_MANIFEST",
    },
  ];
  for (const { name, mutate, code } of blockedCases) {
    const source = input(1);
    mutate(source);
    const result = normalizeBenchmarkInput(source);
    assert.equal(result.status, "BLOCKED", name);
    assert.ok(
      result.errors.some((entry) => entry.code === code),
      name,
    );
  }

  const reconstructed = input(1);
  delete reconstructed.runs[1].cost;
  reconstructed.runs[1].usage = {
    inputTokens: 1_000_000,
    outputTokens: 0,
    cachedInputTokens: 0,
  };
  reconstructed.pricingSnapshot.rates = [
    {
      variantId: "candidate",
      inputPerMillion: 0.25,
      cachedInputPerMillion: 0,
      outputPerMillion: 0,
    },
  ];
  const reconstructedResult = normalizeBenchmarkInput(reconstructed);
  const candidateRun = reconstructedResult.runs.find(
    (entry) => entry.variantId === "candidate",
  );
  assert.equal(candidateRun.cost.source, "RECONSTRUCTED");
  assert.equal(candidateRun.cost.amount, 0.25);

  const mismatched = input(1);
  mismatched.runs[0].cost.pricingSnapshotId = "other-pricing";
  const mismatchResult = normalizeBenchmarkInput(mismatched);
  assert.ok(
    mismatchResult.warnings.some(
      (entry) => entry.code === "COST_PRICING_MISMATCH",
    ),
  );
});

test("pairing and metrics refuse unsupported cohorts without inventing data", () => {
  const blockedPairing = buildPairedComparison(null);
  assert.equal(blockedPairing.status, "BLOCKED");

  const normalized = normalizeBenchmarkInput(input(2));
  const oneVariant = buildPairedComparison(normalized, {
    variantIds: ["baseline"],
  });
  assert.equal(oneVariant.status, "INSUFFICIENT_EVIDENCE");
  assert.ok(
    oneVariant.warnings.some((entry) => entry.code === "INSUFFICIENT_VARIANTS"),
  );

  const unknownBaseline = buildPairedComparison(normalized, {
    baselineVariantId: "unknown",
  });
  assert.equal(unknownBaseline.status, "BLOCKED");

  const unknownExclusion = buildPairedComparison(normalized, {
    baselineVariantId: "baseline",
    excludedCaseIds: ["not-in-corpus"],
  });
  assert.ok(
    unknownExclusion.excludedCases.some(
      (entry) =>
        entry.caseId === "not-in-corpus" &&
        entry.reasonCodes.includes("UNKNOWN_CASE_ID"),
    ),
  );

  const noCost = input(1);
  delete noCost.runs[1].cost;
  const noCostNormalized = normalizeBenchmarkInput(noCost);
  const noCostPairing = buildPairedComparison(noCostNormalized, {
    baselineVariantId: "baseline",
  });
  const noCostMetrics = calculateMetrics(noCostNormalized, noCostPairing, {
    bootstrapIterations: 10,
  });
  const candidate = noCostMetrics.variants.find(
    (entry) => entry.variantId === "candidate",
  );
  assert.equal(candidate.metrics.costPerReviewedCase.status, "UNAVAILABLE");

  const unadjudicated = input(1);
  unadjudicated.runs[1].adjudication = null;
  const unadjudicatedScorecard = buildBenchmarkScorecard(unadjudicated, {
    baselineVariantId: "baseline",
    bootstrapIterations: 10,
  });
  const candidateComparison = unadjudicatedScorecard.comparisons[0];
  assert.equal(
    candidateComparison.metrics.severityWeightedAcceptedRecall.status,
    "UNAVAILABLE",
  );

  const rejected = input(1);
  rejected.runs[1].adjudication.findingLabels[0].outcome = "REJECTED";
  rejected.runs[1].adjudication.findingLabels[0].matchedGroundTruthIds = [];
  const rejectedScorecard = buildBenchmarkScorecard(rejected, {
    baselineVariantId: "baseline",
    bootstrapIterations: 10,
  });
  const rejectedCandidate = rejectedScorecard.variants.find(
    (entry) => entry.variantId === "candidate",
  );
  assert.equal(rejectedCandidate.metrics.falsePositiveRate.value, 1);
  assert.equal(rejectedCandidate.metrics.hallucinationRate.value, 1);

  assert.equal(calculateMetrics(null, null).status, "BLOCKED");
});

const laneDigest = (number) =>
  "sha256:" + number.toString(16).padStart(64, "0");

function laneCandidate(variantId, modelAlias) {
  return {
    schemaVersion: 1,
    variantId,
    architectureId: variantId + "-architecture",
    architectureStructuralDigest: laneDigest(802),
    modelAlias,
    reasoningClass: "standard",
    promptStructuralDigest: laneDigest(800),
    configStructuralDigest: laneDigest(801),
    contextClass: "same-context",
    toolContractId: "tools-v1",
    controllerContractId: "controller-v1",
    validatorContractId: "validator-v1",
    dedupePolicyId: "dedupe-v1",
    postingPolicyId: "posting-v1",
    retryPolicyId: "retry-v1",
    timeoutPolicyId: "timeout-v1",
    routingPolicyId: "routing-v1",
  };
}

function laneRun(caseIndex, variantId, replicateIndex) {
  const caseId = laneDigest(100 + caseIndex);
  const rootCauseId = laneDigest(200 + caseIndex);
  const findingCount = variantId === "candidate" ? 2 : 1;
  const findings = Array.from({ length: findingCount }, (_, index) => ({
    findingId: laneDigest(
      1_000 +
        caseIndex * 100 +
        replicateIndex * 10 +
        (variantId === "candidate" ? 5 : 0) +
        index,
    ),
    severity: "CRITICAL",
    category: "security",
    verification: "VERIFIED",
    tags: ["cross-system"],
  }));
  const amountMicros = variantId === "candidate" ? 500 : 1_000;
  return {
    schemaVersion: 1,
    caseId,
    variantId,
    architectureId: variantId + "-architecture",
    architectureStructuralDigest: laneDigest(802),
    runId: laneDigest(
      2_000 +
        caseIndex * 100 +
        replicateIndex * 10 +
        (variantId === "candidate" ? 5 : 0),
    ),
    replicateId: "replicate_00" + replicateIndex,
    contextDigest: laneDigest(300 + caseIndex),
    toolContractId: "tools-v1",
    controllerContractId: "controller-v1",
    validatorContractId: "validator-v1",
    dedupePolicyId: "dedupe-v1",
    postingPolicyId: "posting-v1",
    reasoningClass: "standard",
    retryPolicyId: "retry-v1",
    timeoutPolicyId: "timeout-v1",
    routingPolicyId: "routing-v1",
    startedAt: "2026-08-01T00:00:00Z",
    latencyMs: variantId === "candidate" ? 80 : 100,
    usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 },
    humanReviewMinutes: variantId === "candidate" ? 1 : 2,
    cost: {
      currency: "USD",
      amountMicros,
      costBasis: "FULLY_LOADED",
      costSource: "SUPPLIED_TOTAL",
      pricingSnapshotId: "pricing-v1",
      components: {
        modelMicros: amountMicros / 2,
        toolingMicros: amountMicros / 4,
        humanReviewMicros: amountMicros / 4,
      },
    },
    findings,
    adjudication: {
      status: "ADJUDICATED",
      rubricId: "rubric-v1",
      labelVersion: "v1",
      findingLabels: findings.map((finding) => ({
        findingId: finding.findingId,
        outcome: "ACCEPTED",
        matchedRootCauseIds: [rootCauseId],
      })),
      rootCauseAssessments: [
        {
          rootCauseId,
          qualityScore: 1,
          qualityRubricId: "rubric-v1",
        },
      ],
    },
  };
}

function refreshLaneReceipts(source) {
  source.manifest.structuralReceipts = computeStructuralReceipts(source);
  return source;
}

function laneMetricBundle() {
  const caseIds = [laneDigest(100), laneDigest(101)];
  const source = {
    bundleId: "portable-core",
    manifest: {
      schemaVersion: 1,
      corpusId: laneDigest(10),
      exporterVersion: "0.1.0",
      exportedAt: "2026-08-01T00:00:00Z",
      caseIds,
      variantIds: ["baseline", "candidate"],
      rubricId: "rubric-v1",
      labelVersion: "v1",
      pricingSnapshotId: "pricing-v1",
      redactionPolicyVersion: "redaction-v1",
      lane: {
        laneId: "portable-core-v1",
        laneType: "PORTABLE_CORE_MODEL",
        baselineVariantId: "baseline",
        cohortSelectionDigest: laneDigest(11),
        cohortWindowId: laneDigest(12),
        allowedDifferenceAxes: ["modelAlias"],
        executionMode: "OFFLINE_REPLAY",
      },
      sliceTaxonomy: {
        taxonomyId: "risk-v1",
        version: "1",
        sliceIds: ["auth", "cross-service"],
      },
      productionBaselineContracts: {
        controllerContractId: "controller-v1",
        validatorContractId: "validator-v1",
        dedupePolicyId: "dedupe-v1",
        postingPolicyId: "posting-v1",
      },
      structuralReceipts: [],
    },
    evalProtocol: {
      schemaVersion: 1,
      protocolId: "eval-v1",
      protocolVersion: "v1",
      laneId: "portable-core-v1",
      intendedClaim: "MODEL_ONLY",
      samplingFrame: "paired-cases",
      cohortSelectionDigest: laneDigest(11),
      cohortWindowId: laneDigest(12),
      inclusionPolicyId: "include-v1",
      assignmentMethod: "PAIRED_SAME_CASE",
      pairingMethod: "CASE_VARIANT_REPLICATE",
      replicateAggregation: "CASE_PRIMITIVES",
      missingReplicatePolicy: "BLOCK",
      leakageControls: [
        {
          controlId: "holdout",
          status: "DECLARED",
          evidenceStatus: "DECLARED",
        },
      ],
      knownContamination: "NONE_DECLARED",
      exclusionPolicyId: "exclude-v1",
      heldConstantFields: [
        "promptStructuralDigest",
        "configStructuralDigest",
        "contextClass",
        "toolContractId",
        "controllerContractId",
        "validatorContractId",
        "dedupePolicyId",
        "postingPolicyId",
        "reasoningClass",
        "retryPolicyId",
        "timeoutPolicyId",
        "routingPolicyId",
      ],
      preservationContracts: {
        controllerContractId: "controller-v1",
        validatorContractId: "validator-v1",
        dedupePolicyId: "dedupe-v1",
        postingPolicyId: "posting-v1",
        toolContractId: "tools-v1",
        contextClass: "same-context",
        retryPolicyId: "retry-v1",
        timeoutPolicyId: "timeout-v1",
        routingPolicyId: "routing-v1",
      },
      expectedExecutionMode: "OFFLINE_REPLAY",
      provenance: {
        kind: "SYNTHETIC_FIXTURE",
        sourceLabel: "synthetic-fixture",
      },
    },
    adjudicationProtocol: {
      schemaVersion: 1,
      protocolId: "adjudication-v1",
      protocolVersion: "v1",
      laneId: "portable-core-v1",
      rubricId: "rubric-v1",
      labelVersion: "v1",
      variantIdentity: "HIDDEN",
      presentationOrder: "RANDOMIZED",
      highCriticalReview: "HUMAN",
      adjudicatorIndependence: {
        status: "DECLARED",
        evidenceStatus: "DECLARED",
        provenanceId: "panel-v1",
      },
      disagreement: {
        policyId: "disagreement-v1",
        count: 0,
        status: "COMPLETE",
      },
      provenance: {
        kind: "SYNTHETIC_FIXTURE",
        sourceLabel: "synthetic-fixture",
      },
    },
    candidateConfigs: [
      laneCandidate("baseline", "model-a"),
      laneCandidate("candidate", "model-b"),
    ],
    rubric: {
      matchingRules: {
        allowOneFindingMultipleRootCauses: false,
        allowMultipleFindingsPerRootCause: true,
      },
    },
    pricingSnapshot: {
      schemaVersion: 1,
      snapshotId: "pricing-v1",
      currency: "USD",
      effectiveAt: "2026-08-01T00:00:00Z",
      costBasis: "FULLY_LOADED",
      provenance: { kind: "user-supplied" },
      rates: [],
    },
    caseLabels: caseIds.map((caseId, index) => ({
      schemaVersion: 1,
      caseId,
      rubricId: "rubric-v1",
      labelVersion: "v1",
      riskSliceIds: index === 0 ? ["auth"] : ["auth", "cross-service"],
      groundTruth: [
        {
          rootCauseId: laneDigest(200 + index),
          severity: "CRITICAL",
          tags: ["cross-system"],
        },
      ],
    })),
    runs: [0, 1].flatMap((caseIndex) =>
      [1, 2].flatMap((replicateIndex) => [
        laneRun(caseIndex, "baseline", replicateIndex),
        laneRun(caseIndex, "candidate", replicateIndex),
      ]),
    ),
  };
  return refreshLaneReceipts(source);
}

test("lane scorecard groups symptom findings into root-cause economics", () => {
  const scorecard = buildLaneBenchmarkScorecard(laneMetricBundle(), {
    bootstrapIterations: 50,
    bootstrapSeed: "lane-seed",
    decisionPolicy: {
      decisionSliceIds: ["auth"],
      minimumPairedCasesPerSlice: 1,
    },
  });
  assert.equal(scorecard.status, "COMPLETE");
  assert.equal(scorecard.attributionStatus, "SINGLE_FACTOR");
  assert.equal(scorecard.replicateAggregation, "CASE_PRIMITIVES");
  assert.equal(scorecard.missingReplicatePolicy, "BLOCK");
  const candidate = scorecard.variants.find(
    (variant) => variant.variantId === "candidate",
  );
  assert.equal(candidate.metrics.highCriticalRootCauseRecall.value, 1);
  assert.equal(
    candidate.metrics.fullyLoadedCostPerConfirmedHighCriticalRootCause.value,
    500,
  );
  assert.equal(candidate.metrics.symptomsPerRootCause.value, 2);
  assert.equal(candidate.metrics.findingStability.value, 1);
  assert.equal(scorecard.slices.length, 2);
  assert.equal(
    scorecard.slices.find((slice) => slice.sliceId === "auth").decisionEligible,
    true,
  );
});

test("pooled root-cause ratios retain zero-confirmation case cost", () => {
  const source = laneMetricBundle();
  for (const entry of source.runs) {
    if (entry.caseId === laneDigest(101) && entry.variantId === "candidate") {
      for (const label of entry.adjudication.findingLabels) {
        label.matchedRootCauseIds = [];
      }
      entry.adjudication.rootCauseAssessments = [];
    }
  }
  refreshLaneReceipts(source);
  const normalized = normalizeLaneBundle(source);
  const pairing = buildLanePairedComparison(normalized);
  const metrics = calculateLaneMetrics(normalized, pairing, {
    bootstrapIterations: 20,
    bootstrapSeed: "pooled-seed",
  });
  const candidate = metrics.variants.find(
    (variant) => variant.variantId === "candidate",
  );
  assert.equal(
    candidate.metrics.fullyLoadedCostPerConfirmedHighCriticalRootCause.value,
    1_000,
  );
  assert.equal(
    candidate.metrics.fullyLoadedCostPerConfirmedHighCriticalRootCause
      .denominator,
    1,
  );
});

test("lane intervals and point frontier are deterministic without cross-lane pooling", () => {
  const options = {
    bootstrapIterations: 50,
    bootstrapSeed: "stable-seed",
  };
  const first = buildLaneBenchmarkScorecard(laneMetricBundle(), options);
  const second = buildLaneBenchmarkScorecard(laneMetricBundle(), options);
  assert.deepEqual(first.comparisons, second.comparisons);
  assert.deepEqual(first.frontier, second.frontier);
  assert.deepEqual(
    first.frontier.frontier.map((entry) => entry.variantId),
    ["candidate"],
  );
  const interval =
    first.comparisons[0].metrics
      .fullyLoadedCostPerConfirmedHighCriticalRootCause.interval;
  assert.equal(interval.status, "AVAILABLE");
  assert.equal(interval.estimate, -500);

  const secondLane = laneMetricBundle();
  secondLane.bundleId = "portable-core-two";
  secondLane.manifest.lane.laneId = "portable-core-v2";
  secondLane.evalProtocol.laneId = "portable-core-v2";
  secondLane.adjudicationProtocol.laneId = "portable-core-v2";
  refreshLaneReceipts(secondLane);
  const multi = buildMultiLaneScorecards(
    {
      laneBundles: [laneMetricBundle(), secondLane],
    },
    options,
  );
  assert.equal(multi.lanes.length, 2);
  assert.equal(multi.methodology.laneAggregation, "NONE");

  const duplicate = buildMultiLaneScorecards(
    { laneBundles: [laneMetricBundle(), laneMetricBundle()] },
    options,
  );
  assert.equal(duplicate.status, "BLOCKED");
  assert.equal(duplicate.lanes.length, 0);
});

test("incomplete eval validity withholds ranking while keeping description", () => {
  const source = laneMetricBundle();
  source.adjudicationProtocol.variantIdentity = "VISIBLE";
  refreshLaneReceipts(source);
  const scorecard = buildLaneBenchmarkScorecard(source, {
    bootstrapIterations: 20,
  });
  assert.equal(scorecard.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(scorecard.eligibleForRanking, false);
  assert.equal(scorecard.frontier.frontier.length, 0);
  assert.ok(scorecard.variants.length > 0);

  const forged = buildLaneBenchmarkScorecard(source, {
    validityReport: {
      status: "COMPLETE",
      claimBoundary: "forged",
      attributionStatus: "SINGLE_FACTOR",
    },
    bootstrapIterations: 20,
  });
  assert.equal(forged.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(forged.frontier.frontier.length, 0);
});

test("ad hoc lane exclusions cannot bypass symmetric cohort provenance", () => {
  const caseId = laneDigest(100);
  const normalized = normalizeLaneBundle(laneMetricBundle());
  const pairing = buildLanePairedComparison(normalized, {
    excludedCaseIds: [caseId],
  });
  assert.equal(pairing.pairedCaseIds.length, 1);
  assert.deepEqual(pairing.unsafeExclusions[0].reasonCodes, [
    "EXPLICIT_EXCLUSION",
  ]);

  const scorecard = buildLaneBenchmarkScorecard(laneMetricBundle(), {
    excludedCaseIds: [caseId],
    bootstrapIterations: 10,
  });
  assert.equal(scorecard.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(scorecard.eligibleForRanking, false);
  assert.equal(scorecard.frontier.frontier.length, 0);

  const malformed = laneMetricBundle();
  malformed.evalProtocol.predeclaredExclusions = [
    {
      caseId,
      symmetric: true,
      provenanceDigest: "not-a-digest",
    },
  ];
  refreshLaneReceipts(malformed);
  const malformedNormalized = normalizeLaneBundle(malformed);
  assert.equal(malformedNormalized.status, "BLOCKED");
  assert.ok(
    malformedNormalized.reasonCodes.includes("INVALID_PREDECLARED_EXCLUSION"),
  );
});

test("lane metric missingness, unsupported slices, and empty stability fail closed", () => {
  const source = laneMetricBundle();
  for (const entry of source.runs) {
    delete entry.humanReviewMinutes;
    if (entry.variantId === "candidate") {
      delete entry.cost;
    }
  }
  refreshLaneReceipts(source);
  const normalized = normalizeLaneBundle(source);
  const pairing = buildLanePairedComparison(normalized);
  const metrics = calculateLaneMetrics(normalized, pairing, {
    bootstrapIterations: 10,
  });
  const candidate = metrics.variants.find(
    (variant) => variant.variantId === "candidate",
  );
  assert.equal(
    candidate.metrics.humanReviewMinutesPerCase.status,
    "UNAVAILABLE",
  );
  assert.deepEqual(candidate.metrics.humanReviewMinutesPerCase.missingness, {
    count: 2,
    reasonCodes: ["MISSING_HUMAN_REVIEW_EVIDENCE"],
  });
  assert.deepEqual(
    candidate.metrics.humanReviewMinutesPerCase.exclusions.map(
      (entry) => entry.caseId,
    ),
    [laneDigest(100), laneDigest(101)],
  );
  assert.equal(
    candidate.metrics.fullyLoadedCostPerConfirmedHighCriticalRootCause.status,
    "UNAVAILABLE",
  );
  assert.equal(
    metrics.comparisons[0].metrics
      .fullyLoadedCostPerConfirmedHighCriticalRootCause.missingness.count,
    2,
  );
  assert.equal(metrics.status, "PARTIAL");

  const unsupported = pairingForSlice(normalized, pairing, "not-declared");
  assert.equal(unsupported.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(unsupported.warnings[0].code, "UNSUPPORTED_RISK_SLICE");

  const empty = laneMetricBundle();
  for (const entry of empty.runs) {
    for (const label of entry.adjudication.findingLabels) {
      label.matchedRootCauseIds = [];
    }
  }
  refreshLaneReceipts(empty);
  const emptyNormalized = normalizeLaneBundle(empty);
  const emptyPairing = buildLanePairedComparison(emptyNormalized);
  const stability = calculateFindingStability(
    emptyPairing.pairedCases,
    "candidate",
  );
  assert.equal(stability.status, "UNAVAILABLE");
  assert.ok(stability.reasonCodes.includes("INSUFFICIENT_REPLICATES"));
  assert.deepEqual(stability.missingness, {
    count: 2,
    reasonCodes: ["NO_STABILITY_PAIR_VALUES"],
  });
});

test("unknown adjudication outcomes cannot become actionable precision", () => {
  const source = laneMetricBundle();
  for (const runRecord of source.runs) {
    if (runRecord.variantId !== "candidate") {
      continue;
    }
    runRecord.adjudication.findingLabels[0].outcome = "UNKNOWN";
    runRecord.adjudication.findingLabels[0].matchedRootCauseIds = [];
  }
  refreshLaneReceipts(source);
  const normalized = normalizeLaneBundle(source);
  const pairing = buildLanePairedComparison(normalized);
  const metrics = calculateLaneMetrics(normalized, pairing, {
    bootstrapIterations: 10,
  });
  const candidate = metrics.variants.find(
    (variant) => variant.variantId === "candidate",
  );
  assert.equal(normalized.status, "COMPLETE");
  assert.equal(candidate.metrics.actionablePrecision.status, "UNAVAILABLE");
  assert.equal(candidate.metrics.actionablePrecision.denominator, null);
  assert.deepEqual(candidate.metrics.actionablePrecision.missingness, {
    count: 2,
    reasonCodes: ["MISSING_ACTIONABLE_PRECISION_EVIDENCE"],
  });
  assert.equal(metrics.status, "PARTIAL");
});

test("lane pairing blocks replicate fan-out before nested pairing", () => {
  const normalized = normalizeLaneBundle(laneMetricBundle());
  const first = normalized.runs.find(
    (runRecord) =>
      runRecord.caseId === laneDigest(100) &&
      runRecord.variantId === "baseline",
  );
  for (let index = 3; index <= 33; index += 1) {
    const replicate = structuredClone(first);
    replicate.runId = laneDigest(900 + index);
    replicate.replicateId = "replicate_" + String(index).padStart(3, "0");
    normalized.runs.push(replicate);
  }
  const pairing = buildLanePairedComparison(normalized);
  assert.equal(pairing.status, "BLOCKED");
  assert.ok(
    pairing.errors.some((entry) => entry.code === "REPLICATE_LIMIT_EXCEEDED"),
  );
  assert.deepEqual(pairing.pairedCases, []);
});

test("decision slices carry family-wise interval evidence", () => {
  const scorecard = buildLaneBenchmarkScorecard(laneMetricBundle(), {
    bootstrapIterations: 10,
    decisionPolicy: {
      confidenceLevel: 0.95,
      decisionSliceIds: ["auth", "cross-service"],
      sliceMultiplicityMethod: "HOLM_BONFERRONI",
      minimumPairedCasesPerSlice: 1,
    },
  });
  const auth = scorecard.slices.find((slice) => slice.sliceId === "auth");
  assert.deepEqual(auth.multiplicity, {
    method: "HOLM_BONFERRONI",
    familySize: 2,
    adjustedConfidenceLevel: 0.975,
  });
  assert.equal(
    auth.comparisons[0].metrics.actionablePrecision.interval.confidenceLevel,
    0.975,
  );
  const descriptive = buildLaneBenchmarkScorecard(laneMetricBundle(), {
    bootstrapIterations: 10,
  }).slices[0];
  assert.equal(descriptive.multiplicity, null);
});

test("lane pipeline keeps blocked, empty, safe-exclusion, and partial branches visible", () => {
  const blocked = buildLaneBenchmarkScorecard(null, {
    bootstrapIterations: 10,
  });
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.frontier.frontier.length, 0);

  const noLanes = buildMultiLaneScorecards({ lanes: [] });
  assert.equal(noLanes.status, "BLOCKED");
  assert.ok(noLanes.reasonCodes.includes("NO_LANE_BUNDLES"));

  const normalized = normalizeLaneBundle(laneMetricBundle());
  const preNormalized = buildMultiLaneScorecards(
    { lanes: [normalized] },
    { bootstrapIterations: 10 },
  );
  assert.equal(preNormalized.status, "COMPLETE");
  assert.equal(preNormalized.lanes.length, 1);

  const safeSource = laneMetricBundle();
  safeSource.evalProtocol.predeclaredExclusions = [
    {
      caseId: laneDigest(100),
      symmetric: true,
      provenanceDigest: laneDigest(500),
    },
  ];
  safeSource.evalProtocol.missingReplicatePolicy = "SYMMETRIC_EXCLUDE_CASE";
  refreshLaneReceipts(safeSource);
  const safePairing = buildLanePairedComparison(
    normalizeLaneBundle(safeSource),
  );
  assert.equal(safePairing.status, "PARTIAL");
  assert.equal(safePairing.unsafeExclusions.length, 0);
  assert.equal(safePairing.excludedCases[0].symmetricDeclared, true);

  const crossService = pairingForSlice(
    normalized,
    buildLanePairedComparison(normalized),
    "cross-service",
  );
  assert.equal(crossService.status, "PARTIAL");
  assert.deepEqual(crossService.pairedCaseIds, [laneDigest(101)]);

  const partialSource = laneMetricBundle();
  for (const runRecord of partialSource.runs) {
    if (
      runRecord.variantId === "candidate" &&
      runRecord.caseId === laneDigest(100)
    ) {
      delete runRecord.humanReviewMinutes;
    }
  }
  refreshLaneReceipts(partialSource);
  const partialNormalized = normalizeLaneBundle(partialSource);
  const partialPairing = buildLanePairedComparison(partialNormalized);
  const partialMetrics = calculateLaneMetrics(
    partialNormalized,
    partialPairing,
    { bootstrapIterations: 10 },
  );
  const partialCandidate = partialMetrics.variants.find(
    (variant) => variant.variantId === "candidate",
  );
  assert.equal(
    partialCandidate.metrics.humanReviewMinutesPerCase.status,
    "PARTIAL",
  );
  assert.equal(
    partialCandidate.metrics.humanReviewMinutesPerCase.missingness.count,
    1,
  );
  assert.equal(
    partialMetrics.comparisons[0].metrics.humanReviewMinutesPerCase.status,
    "PARTIAL",
  );

  const oneReplicate = calculateFindingStability(
    [
      {
        caseId: laneDigest(100),
        runsByVariant: { candidate: [laneRun(0, "candidate", 1)] },
      },
    ],
    "candidate",
  );
  assert.equal(oneReplicate.status, "UNAVAILABLE");
  assert.deepEqual(oneReplicate.exclusions[0].reasonCodes, [
    "MISSING_REPLICATES",
  ]);
});

test("case-statistic bootstrap is deterministic and rejects invalid statistics", () => {
  const cases = [{ value: 1 }, { value: 3 }];
  const statistic = (sample) =>
    sample.reduce((total, entry) => total + entry.value, 0) / sample.length;
  const first = pairedBootstrapStatisticInterval(cases, statistic, {
    iterations: 20,
    seed: "case-seed",
  });
  const second = pairedBootstrapStatisticInterval(cases, statistic, {
    iterations: 20,
    seed: "case-seed",
  });
  assert.deepEqual(first, second);
  assert.equal(first.status, "AVAILABLE");
  assert.equal(
    pairedBootstrapStatisticInterval(cases, () => null, {
      iterations: 5,
    }).status,
    "UNAVAILABLE",
  );
  assert.equal(
    calculateLaneMetrics({ status: "BLOCKED" }, null).status,
    "BLOCKED",
  );
});
