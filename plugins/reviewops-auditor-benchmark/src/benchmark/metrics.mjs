import {
  pairedBootstrapInterval,
  pairedBootstrapStatisticInterval,
} from "./confidence.mjs";
import {
  METRIC_STATUS,
  isFiniteNumber,
  issue,
  mean,
  metricUnavailable,
  metricValue,
  quantile,
  roundNumber,
  sum,
  uniqueSortedStrings,
} from "./shared.mjs";
import { calculateFindingStability } from "./stability.mjs";

const REQUIRED_COMPLETE_METRICS = Object.freeze([
  "costPerReviewedCase",
  "severityWeightedAcceptedRecall",
  "highCriticalPreservation",
  "falsePositiveRate",
  "hallucinationRate",
  "latencyP95",
]);

const RESOLVED_FINDING_OUTCOMES = new Set(["ACCEPTED", "REJECTED"]);

function completeAdjudication(run) {
  if (!run.adjudication || run.adjudication.status !== "ADJUDICATED") {
    return false;
  }
  if (run.adjudication.findingLabels.length !== run.findings.length) {
    return false;
  }
  const labels = new Set(
    run.adjudication.findingLabels.map((label) => label.findingId),
  );
  return (
    run.adjudication.findingLabels.every((label) =>
      RESOLVED_FINDING_OUTCOMES.has(label.outcome),
    ) && run.findings.every((finding) => labels.has(finding.findingId))
  );
}

function labelsByFinding(run) {
  return new Map(
    (run.adjudication?.findingLabels ?? []).map((label) => [label.findingId, label]),
  );
}

function caseStatistics(run, caseLabel, rubric) {
  const labelMap = labelsByFinding(run);
  const complete = completeAdjudication(run);
  const acceptedLabels = [...labelMap.values()].filter(
    (label) => label.outcome === "ACCEPTED",
  );
  const rejectedLabels = [...labelMap.values()].filter(
    (label) => label.outcome === "REJECTED",
  );
  const unknownLabels = [...labelMap.values()].filter(
    (label) => label.outcome === "UNKNOWN",
  );
  const findingsById = new Map(
    run.findings.map((finding) => [finding.findingId, finding]),
  );
  const acceptedFindingIds = new Set(acceptedLabels.map((label) => label.findingId));
  const matchedGroundTruthIds = new Set(
    acceptedLabels.flatMap((label) => label.matchedGroundTruthIds),
  );
  const weightFor = (severity) => rubric?.severityWeights?.[severity];
  const groundTruth = caseLabel?.groundTruth ?? [];
  const weightsComplete = groundTruth.every((item) =>
    isFiniteNumber(weightFor(item.severity)),
  );
  const totalGroundTruthWeight = weightsComplete
    ? sum(groundTruth.map((item) => weightFor(item.severity)))
    : null;
  const acceptedMatchedWeight = weightsComplete
    ? sum(
        groundTruth
          .filter((item) => matchedGroundTruthIds.has(item.groundTruthId))
          .map((item) => weightFor(item.severity)),
      )
    : null;
  const highCriticalGroundTruth = groundTruth.filter(
    (item) => item.severity === "HIGH" || item.severity === "CRITICAL",
  );
  const highCriticalMatched = highCriticalGroundTruth.filter((item) =>
    matchedGroundTruthIds.has(item.groundTruthId),
  );
  const verificationComplete = run.findings.every(
    (finding) => finding.verification !== null,
  );
  const hallucinationIds = new Set(
    run.findings
      .filter((finding) => finding.verification === "UNVERIFIED")
      .map((finding) => finding.findingId),
  );
  for (const label of rejectedLabels) {
    hallucinationIds.add(label.findingId);
  }
  const crossFileAcceptedCount = [...acceptedFindingIds].filter((findingId) => {
    const tags = findingsById.get(findingId)?.tags ?? [];
    return tags.includes("cross-file") || tags.includes("cross-system");
  }).length;
  return {
    caseId: run.caseId,
    cost: run.cost?.amount ?? null,
    currency: run.cost?.currency ?? null,
    costSource: run.cost?.source ?? null,
    latencyMs: run.latencyMs,
    findingCount: run.findings.length,
    completeAdjudication: complete,
    acceptedCount: acceptedLabels.length,
    rejectedCount: rejectedLabels.length,
    unknownCount: unknownLabels.length,
    acceptedFindingIds,
    totalGroundTruthWeight,
    acceptedMatchedWeight,
    groundTruthReady:
      Boolean(caseLabel) &&
      Boolean(rubric?.matchingRules) &&
      weightsComplete &&
      complete,
    highCriticalTotal: highCriticalGroundTruth.length,
    highCriticalMatched: highCriticalMatched.length,
    hallucinationCount: hallucinationIds.size,
    hallucinationReady: complete || verificationComplete,
    crossFileAcceptedCount,
    rootCauseScore: isFiniteNumber(run.adjudication?.rootCauseScore)
      ? run.adjudication.rootCauseScore
      : null,
  };
}

/**
 * @param {any[]} values
 * @param {number} totalCount
 * @param {{
 *   numerator?: number | null,
 *   denominator?: number | null,
 *   reasonCodes?: string[],
 *   [key: string]: any
 * }} [options]
 * @returns {Record<string, any>}
 */
function availableMetric(
  values,
  totalCount,
  { numerator = null, denominator = null, reasonCodes = [], ...extras } = {},
) {
  if (values.length === 0) {
    return metricUnavailable(
      reasonCodes.length > 0 ? reasonCodes : ["NO_ELIGIBLE_CASES"],
      extras,
    );
  }
  const value =
    denominator !== null
      ? denominator === 0
        ? undefined
        : numerator / denominator
      : mean(values);
  if (!isFiniteNumber(value)) {
    return metricUnavailable(["ZERO_DENOMINATOR", ...reasonCodes], extras);
  }
  return metricValue({
    value,
    numerator,
    denominator,
    eligibleCount: values.length,
    totalCount,
    reasonCodes,
    ...extras,
  });
}

function aggregateVariant(variantId, stats, totalCount) {
  const missingReasons = [];
  const costs = stats.filter((item) => isFiniteNumber(item.cost));
  if (costs.length < totalCount) {
    missingReasons.push("MISSING_COST");
  }
  const costValues = costs.map((item) => item.cost);
  const totalCost = costValues.length > 0 ? sum(costValues) : null;
  const currencySet = new Set(costs.map((item) => item.currency).filter(Boolean));
  const costPerReviewedCase =
    currencySet.size > 1
      ? metricUnavailable(["MIXED_CURRENCY"])
      : availableMetric(costValues, totalCount, {
          numerator: totalCost,
          denominator: costValues.length,
          reasonCodes: missingReasons,
          currency: [...currencySet][0] ?? null,
        });

  const adjudicated = stats.filter((item) => item.completeAdjudication);
  const costAndAdjudicated = stats.filter(
    (item) => isFiniteNumber(item.cost) && item.completeAdjudication,
  );
  const acceptedForCost = new Set();
  for (const item of costAndAdjudicated) {
    for (const findingId of item.acceptedFindingIds) {
      acceptedForCost.add(`${item.caseId}\u0000${findingId}`);
    }
  }
  const acceptedCost = sum(costAndAdjudicated.map((item) => item.cost));
  const costPerAcceptedUniqueFinding =
    currencySet.size > 1
      ? metricUnavailable(["MIXED_CURRENCY"])
      : acceptedForCost.size === 0
        ? metricUnavailable(["ZERO_DENOMINATOR"], {
            currency: [...currencySet][0] ?? null,
          })
        : metricValue({
            value: acceptedCost / acceptedForCost.size,
            numerator: acceptedCost,
            denominator: acceptedForCost.size,
            eligibleCount: costAndAdjudicated.length,
            totalCount,
            reasonCodes:
              costAndAdjudicated.length < totalCount
                ? ["MISSING_COST_OR_ADJUDICATION"]
                : [],
            currency: [...currencySet][0] ?? null,
          });

  const recallStats = stats.filter((item) => item.groundTruthReady);
  const recallNumerator = sum(recallStats.map((item) => item.acceptedMatchedWeight));
  const recallDenominator = sum(recallStats.map((item) => item.totalGroundTruthWeight));
  const severityWeightedAcceptedRecall = availableMetric(recallStats, totalCount, {
    numerator: recallNumerator,
    denominator: recallDenominator,
    reasonCodes: recallStats.length < totalCount ? ["MISSING_QUALITY_EVIDENCE"] : [],
  });

  const precisionNumerator = sum(adjudicated.map((item) => item.acceptedCount));
  const precisionDenominator = sum(
    adjudicated.map((item) => item.acceptedCount + item.rejectedCount),
  );
  const precision = availableMetric(adjudicated, totalCount, {
    numerator: precisionNumerator,
    denominator: precisionDenominator,
    reasonCodes: adjudicated.length < totalCount ? ["INCOMPLETE_ADJUDICATION"] : [],
  });
  const falsePositiveRate = availableMetric(adjudicated, totalCount, {
    numerator: sum(adjudicated.map((item) => item.rejectedCount)),
    denominator: precisionDenominator,
    reasonCodes: adjudicated.length < totalCount ? ["INCOMPLETE_ADJUDICATION"] : [],
  });

  const highCriticalStats = recallStats.filter((item) => item.highCriticalTotal > 0);
  const highCriticalPreservation = availableMetric(highCriticalStats, totalCount, {
    numerator: sum(highCriticalStats.map((item) => item.highCriticalMatched)),
    denominator: sum(highCriticalStats.map((item) => item.highCriticalTotal)),
    reasonCodes:
      highCriticalStats.length < totalCount ? ["MISSING_HIGH_CRITICAL_EVIDENCE"] : [],
  });

  const hallucinationStats = stats.filter((item) => item.hallucinationReady);
  const hallucinationRate = availableMetric(hallucinationStats, totalCount, {
    numerator: sum(hallucinationStats.map((item) => item.hallucinationCount)),
    denominator: sum(hallucinationStats.map((item) => item.findingCount)),
    reasonCodes:
      hallucinationStats.length < totalCount ? ["MISSING_HALLUCINATION_EVIDENCE"] : [],
  });

  const commentVolume = metricValue({
    value: sum(stats.map((item) => item.findingCount)) / totalCount,
    numerator: sum(stats.map((item) => item.findingCount)),
    denominator: totalCount,
    eligibleCount: stats.length,
    totalCount,
  });
  const latencies = stats.map((item) => item.latencyMs).filter(isFiniteNumber);
  const latencyP50 = availableMetric(latencies, totalCount, {
    reasonCodes: latencies.length < totalCount ? ["MISSING_LATENCY"] : [],
    quantile: "p50",
  });
  if (latencyP50.status !== METRIC_STATUS.UNAVAILABLE) {
    latencyP50.value = quantile(latencies, 0.5);
    latencyP50.denominator = latencies.length;
  }
  const latencyP95 = availableMetric(latencies, totalCount, {
    reasonCodes: latencies.length < totalCount ? ["MISSING_LATENCY"] : [],
    quantile: "p95",
  });
  if (latencyP95.status !== METRIC_STATUS.UNAVAILABLE) {
    latencyP95.value = quantile(latencies, 0.95);
    latencyP95.denominator = latencies.length;
  }

  const rootCauseStats = stats.filter((item) => isFiniteNumber(item.rootCauseScore));
  const rootCauseQuality = availableMetric(
    rootCauseStats.map((item) => item.rootCauseScore),
    totalCount,
    {
      reasonCodes:
        rootCauseStats.length < totalCount ? ["MISSING_ROOT_CAUSE_SCORE"] : [],
    },
  );
  const crossFileFindings =
    adjudicated.length === 0
      ? metricUnavailable(["INCOMPLETE_ADJUDICATION"])
      : metricValue({
          value:
            sum(adjudicated.map((item) => item.crossFileAcceptedCount)) /
            adjudicated.length,
          numerator: sum(adjudicated.map((item) => item.crossFileAcceptedCount)),
          denominator: adjudicated.length,
          eligibleCount: adjudicated.length,
          totalCount,
          reasonCodes:
            adjudicated.length < totalCount ? ["INCOMPLETE_ADJUDICATION"] : [],
        });

  return {
    variantId,
    sampleSize: totalCount,
    costSources: uniqueSortedStrings(costs.map((item) => item.costSource)),
    metrics: {
      costPerReviewedCase,
      costPerAcceptedUniqueFinding,
      severityWeightedAcceptedRecall,
      precision,
      falsePositiveRate,
      highCriticalPreservation,
      hallucinationRate,
      commentVolume,
      latencyP50,
      latencyP95,
      rootCauseQuality,
      crossFileFindings,
    },
    _caseStatistics: stats,
  };
}

function perCaseValue(stat, metricName) {
  switch (metricName) {
    case "costPerReviewedCase":
      return stat.cost;
    case "severityWeightedAcceptedRecall":
      return stat.groundTruthReady && stat.totalGroundTruthWeight > 0
        ? stat.acceptedMatchedWeight / stat.totalGroundTruthWeight
        : null;
    case "highCriticalPreservation":
      return stat.groundTruthReady && stat.highCriticalTotal > 0
        ? stat.highCriticalMatched / stat.highCriticalTotal
        : null;
    case "falsePositiveRate": {
      const denominator = stat.acceptedCount + stat.rejectedCount;
      return stat.completeAdjudication && denominator > 0
        ? stat.rejectedCount / denominator
        : null;
    }
    case "hallucinationRate":
      return stat.hallucinationReady && stat.findingCount > 0
        ? stat.hallucinationCount / stat.findingCount
        : null;
    case "latencyMs":
      return stat.latencyMs;
    default:
      return null;
  }
}

function comparisonMetric(baseStats, candidateStats, metricName, options) {
  const deltas = [];
  for (let index = 0; index < baseStats.length; index += 1) {
    const baseline = perCaseValue(baseStats[index], metricName);
    const candidate = perCaseValue(candidateStats[index], metricName);
    if (isFiniteNumber(baseline) && isFiniteNumber(candidate)) {
      deltas.push(roundNumber(candidate - baseline));
    }
  }
  if (deltas.length === 0) {
    return {
      status: "UNAVAILABLE",
      delta: null,
      coverage: 0,
      pairedCaseCount: 0,
      interval: pairedBootstrapInterval([], options),
      reasonCodes: ["NO_PAIRED_METRIC_VALUES"],
    };
  }
  const total = baseStats.length;
  return {
    status: deltas.length === total ? "AVAILABLE" : "PARTIAL",
    delta: mean(deltas),
    coverage: roundNumber(deltas.length / total),
    pairedCaseCount: deltas.length,
    interval: pairedBootstrapInterval(deltas, options),
    reasonCodes: deltas.length === total ? [] : ["MISSING_PAIRED_METRIC_VALUES"],
  };
}

/**
 * Calculate descriptive per-variant metrics plus fixed-seed paired deltas.
 * Callers may pass already-paired runs; no unpaired comparison is fabricated.
 */
export function calculateMetrics(normalized, pairing, options = {}) {
  if (
    !normalized ||
    normalized.status === "BLOCKED" ||
    !pairing ||
    pairing.status === "BLOCKED"
  ) {
    return {
      status: "BLOCKED",
      errors: [
        issue(
          "BENCHMARK_INPUT_BLOCKED",
          "Metrics require valid normalized and paired input.",
        ),
      ],
      warnings: [],
      variants: [],
      comparisons: [],
    };
  }
  const totalCount = pairing.pairedCases.length;
  const statsByVariant = new Map();
  const variants = pairing.variantIds.map((variantId) => {
    const stats = pairing.pairedCases.map(({ caseId, runsByVariant }) =>
      caseStatistics(
        runsByVariant[variantId],
        normalized.caseLabelsById.get(caseId),
        normalized.rubric,
      ),
    );
    const result = aggregateVariant(variantId, stats, totalCount);
    statsByVariant.set(variantId, stats);
    return result;
  });
  const bootstrapOptions = {
    confidenceLevel:
      options.confidenceLevel ?? options.decisionPolicy?.confidenceLevel ?? 0.95,
    iterations:
      options.bootstrapIterations ??
      options.decisionPolicy?.bootstrapIterations ??
      10_000,
    seed:
      options.bootstrapSeed ?? options.decisionPolicy?.bootstrapSeed ?? "reviewops-v1",
  };
  const comparisonNames = [
    "costPerReviewedCase",
    "severityWeightedAcceptedRecall",
    "highCriticalPreservation",
    "falsePositiveRate",
    "hallucinationRate",
    "latencyMs",
  ];
  const comparisons = pairing.comparisons.map((comparison) => {
    const baselineStats = statsByVariant.get(comparison.baselineVariantId) ?? [];
    const candidateStats = statsByVariant.get(comparison.candidateVariantId) ?? [];
    const metrics = {};
    for (const name of comparisonNames) {
      metrics[name] = comparisonMetric(
        baselineStats,
        candidateStats,
        name,
        bootstrapOptions,
      );
    }
    return { ...comparison, metrics };
  });
  const cleanVariants = variants.map(({ _caseStatistics, ...variant }) => variant);
  const warnings = [...(normalized.warnings ?? []), ...(pairing.warnings ?? [])];
  const hasQuality = cleanVariants.every(
    (variant) =>
      variant.metrics.severityWeightedAcceptedRecall.status !==
      METRIC_STATUS.UNAVAILABLE,
  );
  const hasCompleteRequiredMetrics = cleanVariants.every((variant) =>
    REQUIRED_COMPLETE_METRICS.every(
      (metricName) => variant.metrics[metricName]?.status === METRIC_STATUS.AVAILABLE,
    ),
  );
  return {
    status:
      totalCount === 0
        ? "INSUFFICIENT_EVIDENCE"
        : hasQuality
          ? warnings.length > 0 ||
            pairing.status === "PARTIAL" ||
            !hasCompleteRequiredMetrics
            ? "PARTIAL"
            : "COMPLETE"
          : "INSUFFICIENT_EVIDENCE",
    errors: [],
    warnings,
    pairedCaseCount: totalCount,
    variants: cleanVariants,
    comparisons,
    methodology: {
      quantile: "LINEAR_INTERPOLATION",
      confidence: "PAIRED_BOOTSTRAP_PERCENTILE",
      confidenceLevel: bootstrapOptions.confidenceLevel,
      bootstrapIterations: bootstrapOptions.iterations,
      bootstrapSeed: bootstrapOptions.seed,
    },
  };
}

export const scorePairedRuns = calculateMetrics;

const LANE_REQUIRED_METRICS = Object.freeze([
  "highCriticalRootCauseRecall",
  "criticalMissRate",
  "actionablePrecision",
  "hallucinationRate",
  "fullyLoadedCostPerConfirmedHighCriticalRootCause",
  "rootCauseQuality",
  "humanReviewMinutesPerCase",
  "latencyP95",
]);

function completeLaneAdjudication(run) {
  const labels = run?.adjudication?.findingLabels;
  if (run?.adjudication?.status !== "ADJUDICATED" || !Array.isArray(labels)) {
    return false;
  }
  if (labels.length !== (run.findings?.length ?? 0)) {
    return false;
  }
  const ids = new Set(labels.map((label) => label.findingId));
  return (
    ids.size === labels.length &&
    labels.every((label) => RESOLVED_FINDING_OUTCOMES.has(label.outcome)) &&
    (run.findings ?? []).every((finding) => ids.has(finding.findingId))
  );
}

function meanComplete(values, expectedCount) {
  const finite = values.filter(isFiniteNumber);
  return finite.length === expectedCount ? mean(finite) : null;
}

function rootCauseMap(caseLabel) {
  return new Map(
    (caseLabel?.groundTruth ?? []).map((rootCause) => [
      rootCause.rootCauseId,
      rootCause,
    ]),
  );
}

function laneRunPrimitives(run, caseLabel) {
  const complete = completeLaneAdjudication(run);
  const labels = run?.adjudication?.findingLabels ?? [];
  const groundTruth = rootCauseMap(caseLabel);
  const confirmed = new Set();
  const acceptedFindingIds = new Set();
  const rejectedFindingIds = new Set();
  for (const label of labels) {
    if (label.outcome === "ACCEPTED") {
      acceptedFindingIds.add(label.findingId);
      for (const rootCauseId of label.matchedRootCauseIds ?? []) {
        confirmed.add(rootCauseId);
      }
    }
    if (label.outcome === "REJECTED") {
      rejectedFindingIds.add(label.findingId);
    }
  }
  const highCritical = [...groundTruth.values()].filter((rootCause) =>
    ["HIGH", "CRITICAL"].includes(rootCause.severity),
  );
  const critical = [...groundTruth.values()].filter(
    (rootCause) => rootCause.severity === "CRITICAL",
  );
  const confirmedHighCritical = highCritical.filter((rootCause) =>
    confirmed.has(rootCause.rootCauseId),
  );
  const confirmedCritical = critical.filter((rootCause) =>
    confirmed.has(rootCause.rootCauseId),
  );
  const confirmedCrossSystem = [...confirmed].filter((rootCauseId) => {
    const tags = groundTruth.get(rootCauseId)?.tags ?? [];
    return tags.includes("cross-file") || tags.includes("cross-system");
  });
  const hallucinated = new Set(rejectedFindingIds);
  for (const finding of run?.findings ?? []) {
    if (finding.verification === "UNVERIFIED") {
      hallucinated.add(finding.findingId);
    }
  }
  const qualityByRoot = new Map(
    (run?.adjudication?.rootCauseAssessments ?? []).map((assessment) => [
      assessment.rootCauseId,
      assessment,
    ]),
  );
  const qualityScores = [...confirmed]
    .map((rootCauseId) => qualityByRoot.get(rootCauseId)?.qualityScore)
    .filter(isFiniteNumber);
  const fullCost =
    run?.cost?.costBasis === "FULLY_LOADED" && isFiniteNumber(run.cost.amountMicros)
      ? run.cost.amountMicros
      : null;
  const modelCost = isFiniteNumber(run?.cost?.components?.modelMicros)
    ? run.cost.components.modelMicros
    : null;
  return {
    complete,
    highCriticalConfirmed: complete ? confirmedHighCritical.length : null,
    highCriticalGroundTruth: caseLabel ? highCritical.length : null,
    criticalMisses: complete ? critical.length - confirmedCritical.length : null,
    criticalGroundTruth: caseLabel ? critical.length : null,
    acceptedFindings: complete ? acceptedFindingIds.size : null,
    adjudicatedFindings: complete
      ? acceptedFindingIds.size + rejectedFindingIds.size
      : null,
    crossSystemConfirmed: complete ? confirmedCrossSystem.length : null,
    acceptedSymptoms: complete ? acceptedFindingIds.size : null,
    confirmedRoots: complete ? confirmed.size : null,
    hallucinations:
      complete ||
      (run?.findings ?? []).every((finding) => finding.verification !== null)
        ? hallucinated.size
        : null,
    eligibleFindings:
      complete ||
      (run?.findings ?? []).every((finding) => finding.verification !== null)
        ? run.findings.length
        : null,
    humanReviewMinutes: isFiniteNumber(run?.humanReviewMinutes)
      ? run.humanReviewMinutes
      : null,
    fullCostMicros: fullCost,
    modelCostMicros: modelCost,
    rootCauseQualityNumerator:
      complete && qualityScores.length === confirmed.size ? sum(qualityScores) : null,
    rootCauseQualityDenominator:
      complete && qualityScores.length === confirmed.size ? confirmed.size : null,
    latencyMs: isFiniteNumber(run?.latencyMs) ? run.latencyMs : null,
    findingCount: run?.findings?.length ?? 0,
    tokenCount:
      run?.usage &&
      isFiniteNumber(run.usage.inputTokens) &&
      isFiniteNumber(run.usage.outputTokens)
        ? run.usage.inputTokens + run.usage.outputTokens
        : null,
  };
}

function laneCasePrimitives(pairedCase, variantId, caseLabel) {
  const runs = pairedCase?.runsByVariant?.[variantId] ?? [];
  const runStats = runs.map((run) => laneRunPrimitives(run, caseLabel));
  const count = runStats.length;
  const fields = [
    "highCriticalConfirmed",
    "highCriticalGroundTruth",
    "criticalMisses",
    "criticalGroundTruth",
    "acceptedFindings",
    "adjudicatedFindings",
    "crossSystemConfirmed",
    "acceptedSymptoms",
    "confirmedRoots",
    "hallucinations",
    "eligibleFindings",
    "humanReviewMinutes",
    "fullCostMicros",
    "modelCostMicros",
    "rootCauseQualityNumerator",
    "rootCauseQualityDenominator",
    "latencyMs",
    "findingCount",
    "tokenCount",
  ];
  const result = {
    caseId: pairedCase.caseId,
    replicateCount: count,
  };
  for (const field of fields) {
    result[field] = meanComplete(
      runStats.map((stat) => stat[field]),
      count,
    );
  }
  return result;
}

function laneUnavailable(reasonCodes, totalCount, extras = {}) {
  return {
    ...metricUnavailable(reasonCodes, extras),
    eligibleCount: 0,
    totalCount,
  };
}

/**
 * Keep missing metric evidence visible at the case boundary. Lane metrics are
 * intentionally case-level after replicate reduction, so exclusions use the
 * same inferential unit as coverage and confidence intervals.
 *
 * @param {Record<string, any>[]} cases
 * @param {Record<string, any>[]} eligible
 * @param {string} reasonCode
 * @returns {{missingness: {count: number, reasonCodes: string[]}, exclusions: {caseId: string, reasonCodes: string[]}[]}}
 */
function metricEvidence(cases, eligible, reasonCode) {
  const eligibleCaseIds = new Set(eligible.map((item) => item.caseId));
  const exclusions = cases
    .filter((item) => !eligibleCaseIds.has(item.caseId))
    .map((item) => ({ caseId: item.caseId, reasonCodes: [reasonCode] }));
  return {
    missingness: {
      count: exclusions.length,
      reasonCodes: exclusions.length === 0 ? [] : [reasonCode],
    },
    exclusions,
  };
}

function ratioMetric(cases, numeratorField, denominatorField, totalCount, reasonCode) {
  const eligible = cases.filter(
    (item) =>
      isFiniteNumber(item[numeratorField]) && isFiniteNumber(item[denominatorField]),
  );
  const evidence = metricEvidence(cases, eligible, reasonCode);
  if (eligible.length === 0) {
    return laneUnavailable([reasonCode], totalCount, evidence);
  }
  const numerator = sum(eligible.map((item) => item[numeratorField]));
  const denominator = sum(eligible.map((item) => item[denominatorField]));
  if (denominator === 0) {
    return laneUnavailable(["ZERO_DENOMINATOR", reasonCode], totalCount, {
      ...evidence,
      numerator,
      denominator,
      eligibleCount: eligible.length,
    });
  }
  return metricValue({
    value: numerator / denominator,
    numerator,
    denominator,
    eligibleCount: eligible.length,
    totalCount,
    reasonCodes: eligible.length < totalCount ? [reasonCode] : [],
    ...evidence,
  });
}

function sumMetric(cases, field, totalCount, reasonCode) {
  const eligible = cases.filter((item) => isFiniteNumber(item[field]));
  const evidence = metricEvidence(cases, eligible, reasonCode);
  if (eligible.length === 0) {
    return laneUnavailable([reasonCode], totalCount, evidence);
  }
  const numerator = sum(eligible.map((item) => item[field]));
  return metricValue({
    value: numerator,
    numerator,
    denominator: eligible.length,
    eligibleCount: eligible.length,
    totalCount,
    reasonCodes: eligible.length < totalCount ? [reasonCode] : [],
    ...evidence,
  });
}

function meanMetric(cases, field, totalCount, reasonCode) {
  const eligible = cases.filter((item) => isFiniteNumber(item[field]));
  const evidence = metricEvidence(cases, eligible, reasonCode);
  if (eligible.length === 0) {
    return laneUnavailable([reasonCode], totalCount, evidence);
  }
  const values = eligible.map((item) => item[field]);
  return metricValue({
    value: mean(values),
    numerator: sum(values),
    denominator: values.length,
    eligibleCount: values.length,
    totalCount,
    reasonCodes: values.length < totalCount ? [reasonCode] : [],
    ...evidence,
  });
}

function quantileMetric(cases, field, probability, totalCount, reasonCode) {
  const eligible = cases.filter((item) => isFiniteNumber(item[field]));
  const evidence = metricEvidence(cases, eligible, reasonCode);
  if (eligible.length === 0) {
    return laneUnavailable([reasonCode], totalCount, {
      ...evidence,
      quantile: "p" + Math.round(probability * 100),
    });
  }
  const values = eligible.map((item) => item[field]);
  return metricValue({
    value: quantile(values, probability),
    numerator: null,
    denominator: values.length,
    eligibleCount: values.length,
    totalCount,
    reasonCodes: values.length < totalCount ? [reasonCode] : [],
    quantile: "p" + Math.round(probability * 100),
    ...evidence,
  });
}

function laneVariantMetrics(variantId, cases, pairedCases) {
  const totalCount = cases.length;
  const highCriticalRootCauseRecall = ratioMetric(
    cases,
    "highCriticalConfirmed",
    "highCriticalGroundTruth",
    totalCount,
    "MISSING_HIGH_CRITICAL_ROOT_CAUSE_EVIDENCE",
  );
  const criticalMissRate = ratioMetric(
    cases,
    "criticalMisses",
    "criticalGroundTruth",
    totalCount,
    "MISSING_CRITICAL_ROOT_CAUSE_EVIDENCE",
  );
  const actionablePrecision = ratioMetric(
    cases,
    "acceptedFindings",
    "adjudicatedFindings",
    totalCount,
    "MISSING_ACTIONABLE_PRECISION_EVIDENCE",
  );
  const hallucinationRate = ratioMetric(
    cases,
    "hallucinations",
    "eligibleFindings",
    totalCount,
    "MISSING_HALLUCINATION_EVIDENCE",
  );
  const fullyLoadedCostPerConfirmedHighCriticalRootCause = ratioMetric(
    cases,
    "fullCostMicros",
    "highCriticalConfirmed",
    totalCount,
    "MISSING_FULLY_LOADED_COST_OR_HIGH_CRITICAL_ROOT_CAUSE",
  );
  const fullyLoadedCostPerConfirmedRootCause = ratioMetric(
    cases,
    "fullCostMicros",
    "confirmedRoots",
    totalCount,
    "MISSING_FULLY_LOADED_COST_OR_ROOT_CAUSE",
  );
  const humanReviewMinutesPerConfirmedRootCause = ratioMetric(
    cases,
    "humanReviewMinutes",
    "confirmedRoots",
    totalCount,
    "MISSING_HUMAN_REVIEW_OR_ROOT_CAUSE",
  );
  const rootCauseQuality = ratioMetric(
    cases,
    "rootCauseQualityNumerator",
    "rootCauseQualityDenominator",
    totalCount,
    "MISSING_ROOT_CAUSE_QUALITY",
  );
  const costPerReviewedCase = meanMetric(
    cases,
    "fullCostMicros",
    totalCount,
    "MISSING_FULLY_LOADED_COST",
  );
  const metrics = {
    highCriticalRootCauseRecall,
    criticalMissRate,
    actionablePrecision,
    crossSystemTruePositives: sumMetric(
      cases,
      "crossSystemConfirmed",
      totalCount,
      "MISSING_CROSS_SYSTEM_ROOT_CAUSE_EVIDENCE",
    ),
    symptomsPerRootCause: ratioMetric(
      cases,
      "acceptedSymptoms",
      "confirmedRoots",
      totalCount,
      "MISSING_ROOT_CAUSE_EVIDENCE",
    ),
    hallucinationRate,
    humanReviewMinutesPerCase: meanMetric(
      cases,
      "humanReviewMinutes",
      totalCount,
      "MISSING_HUMAN_REVIEW_EVIDENCE",
    ),
    humanReviewMinutesPerConfirmedRootCause,
    fullyLoadedCostPerConfirmedHighCriticalRootCause,
    fullyLoadedCostPerConfirmedRootCause,
    rootCauseQuality,
    findingStability: calculateFindingStability(pairedCases, variantId),
    latencyP50: quantileMetric(cases, "latencyMs", 0.5, totalCount, "MISSING_LATENCY"),
    latencyP95: quantileMetric(cases, "latencyMs", 0.95, totalCount, "MISSING_LATENCY"),
    latencyP99: quantileMetric(cases, "latencyMs", 0.99, totalCount, "MISSING_LATENCY"),
    costP50: quantileMetric(
      cases,
      "fullCostMicros",
      0.5,
      totalCount,
      "MISSING_FULLY_LOADED_COST",
    ),
    costP95: quantileMetric(
      cases,
      "fullCostMicros",
      0.95,
      totalCount,
      "MISSING_FULLY_LOADED_COST",
    ),
    costP99: quantileMetric(
      cases,
      "fullCostMicros",
      0.99,
      totalCount,
      "MISSING_FULLY_LOADED_COST",
    ),
    costPerReviewedCase,
    modelOnlyCostPerReviewedCase: meanMetric(
      cases,
      "modelCostMicros",
      totalCount,
      "MISSING_MODEL_COST",
    ),
    tokenUsagePerCase: meanMetric(
      cases,
      "tokenCount",
      totalCount,
      "MISSING_TOKEN_USAGE",
    ),
    rawFindingCount: meanMetric(
      cases,
      "findingCount",
      totalCount,
      "MISSING_FINDING_COUNT",
    ),
  };
  metrics.highCriticalPreservation = highCriticalRootCauseRecall;
  metrics.precision = actionablePrecision;
  return {
    variantId,
    sampleSize: totalCount,
    metrics,
    _casePrimitives: cases,
  };
}

function ratioValue(cases, side, numeratorField, denominatorField) {
  const eligible = cases.filter(
    (item) =>
      isFiniteNumber(item[side]?.[numeratorField]) &&
      isFiniteNumber(item[side]?.[denominatorField]),
  );
  if (eligible.length === 0) {
    return null;
  }
  const numerator = sum(eligible.map((item) => item[side][numeratorField]));
  const denominator = sum(eligible.map((item) => item[side][denominatorField]));
  return denominator === 0 ? null : numerator / denominator;
}

function quantileValue(cases, side, field, probability) {
  const values = cases.map((item) => item[side]?.[field]).filter(isFiniteNumber);
  return values.length === cases.length ? quantile(values, probability) : null;
}

function meanValue(cases, side, field) {
  const values = cases.map((item) => item[side]?.[field]).filter(isFiniteNumber);
  return values.length === cases.length ? mean(values) : null;
}

const COMPARISON_DESCRIPTORS = Object.freeze({
  highCriticalRootCauseRecall: {
    kind: "ratio",
    numerator: "highCriticalConfirmed",
    denominator: "highCriticalGroundTruth",
  },
  criticalMissRate: {
    kind: "ratio",
    numerator: "criticalMisses",
    denominator: "criticalGroundTruth",
  },
  actionablePrecision: {
    kind: "ratio",
    numerator: "acceptedFindings",
    denominator: "adjudicatedFindings",
  },
  hallucinationRate: {
    kind: "ratio",
    numerator: "hallucinations",
    denominator: "eligibleFindings",
  },
  fullyLoadedCostPerConfirmedHighCriticalRootCause: {
    kind: "ratio",
    numerator: "fullCostMicros",
    denominator: "highCriticalConfirmed",
  },
  rootCauseQuality: {
    kind: "ratio",
    numerator: "rootCauseQualityNumerator",
    denominator: "rootCauseQualityDenominator",
  },
  humanReviewMinutesPerCase: { kind: "mean", field: "humanReviewMinutes" },
  costP95: { kind: "quantile", field: "fullCostMicros", probability: 0.95 },
  costP99: { kind: "quantile", field: "fullCostMicros", probability: 0.99 },
  latencyP95: { kind: "quantile", field: "latencyMs", probability: 0.95 },
  latencyP99: { kind: "quantile", field: "latencyMs", probability: 0.99 },
});

function descriptorValue(cases, side, descriptor) {
  if (descriptor.kind === "ratio") {
    return ratioValue(cases, side, descriptor.numerator, descriptor.denominator);
  }
  if (descriptor.kind === "quantile") {
    return quantileValue(cases, side, descriptor.field, descriptor.probability);
  }
  return meanValue(cases, side, descriptor.field);
}

function eligibleComparisonCases(baseCases, candidateCases, descriptor) {
  const pairs = [];
  const totalCount = Math.max(baseCases.length, candidateCases.length);
  for (let index = 0; index < totalCount; index += 1) {
    const pair = {
      caseId: baseCases[index]?.caseId ?? candidateCases[index]?.caseId,
      baseline: baseCases[index],
      candidate: candidateCases[index],
    };
    const eligible =
      descriptor.kind === "ratio"
        ? ["baseline", "candidate"].every(
            (side) =>
              isFiniteNumber(pair[side]?.[descriptor.numerator]) &&
              isFiniteNumber(pair[side]?.[descriptor.denominator]),
          )
        : isFiniteNumber(descriptorValue([pair], "baseline", descriptor)) &&
          isFiniteNumber(descriptorValue([pair], "candidate", descriptor));
    if (eligible) {
      pairs.push(pair);
    }
  }
  return pairs;
}

function laneComparisonMetric(baseCases, candidateCases, descriptor, options) {
  const pairs = eligibleComparisonCases(baseCases, candidateCases, descriptor);
  const allCases = Array.from(
    { length: Math.max(baseCases.length, candidateCases.length) },
    (_, index) => ({
      caseId: baseCases[index]?.caseId ?? candidateCases[index]?.caseId,
    }),
  );
  const totalCount = allCases.length;
  const evidence = metricEvidence(allCases, pairs, "MISSING_PAIRED_METRIC_VALUES");
  if (pairs.length === 0) {
    return {
      status: "UNAVAILABLE",
      delta: null,
      coverage: 0,
      pairedCaseCount: 0,
      interval: pairedBootstrapStatisticInterval([], () => null, options),
      reasonCodes: ["NO_PAIRED_METRIC_VALUES"],
      eligibleCount: 0,
      totalCount,
      ...evidence,
    };
  }
  const statistic = (sample) => {
    const baseline = descriptorValue(sample, "baseline", descriptor);
    const candidate = descriptorValue(sample, "candidate", descriptor);
    return isFiniteNumber(baseline) && isFiniteNumber(candidate)
      ? roundNumber(candidate - baseline)
      : null;
  };
  const delta = statistic(pairs);
  return {
    status: pairs.length === totalCount ? "AVAILABLE" : "PARTIAL",
    delta,
    coverage: roundNumber(pairs.length / totalCount),
    pairedCaseCount: pairs.length,
    interval: pairedBootstrapStatisticInterval(pairs, statistic, options),
    reasonCodes: pairs.length === totalCount ? [] : ["MISSING_PAIRED_METRIC_VALUES"],
    eligibleCount: pairs.length,
    totalCount,
    ...evidence,
  };
}

/**
 * Score one normalized, lane-aware paired cohort. Replicates are reduced to
 * case primitives before pooled ratios, quantiles, or bootstrap resampling.
 *
 * @param {Record<string, any>} normalized
 * @param {Record<string, any>} pairing
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>}
 */
export function calculateLaneMetrics(normalized, pairing, options = {}) {
  if (
    !normalized ||
    normalized.status === "BLOCKED" ||
    !pairing ||
    pairing.status === "BLOCKED"
  ) {
    return {
      status: "BLOCKED",
      errors: [
        issue("BENCHMARK_INPUT_BLOCKED", "Lane metrics require safe paired input."),
      ],
      warnings: [],
      pairedCaseCount: 0,
      variants: [],
      comparisons: [],
    };
  }
  const totalCount = pairing.pairedCases.length;
  const primitivesByVariant = new Map();
  const variants = pairing.variantIds.map((variantId) => {
    const cases = pairing.pairedCases.map((pairedCase) =>
      laneCasePrimitives(
        pairedCase,
        variantId,
        normalized.caseLabelsById.get(pairedCase.caseId),
      ),
    );
    primitivesByVariant.set(variantId, cases);
    return laneVariantMetrics(variantId, cases, pairing.pairedCases);
  });
  const bootstrapOptions = {
    confidenceLevel:
      options.confidenceLevel ?? options.decisionPolicy?.confidenceLevel ?? 0.95,
    iterations:
      options.bootstrapIterations ??
      options.decisionPolicy?.bootstrapIterations ??
      10_000,
    seed:
      options.bootstrapSeed ?? options.decisionPolicy?.bootstrapSeed ?? "reviewops-v1",
  };
  const comparisons = pairing.comparisons.map((comparison) => {
    const baselineCases = primitivesByVariant.get(comparison.baselineVariantId) ?? [];
    const candidateCases = primitivesByVariant.get(comparison.candidateVariantId) ?? [];
    const metrics = {};
    for (const [metricName, descriptor] of Object.entries(COMPARISON_DESCRIPTORS)) {
      metrics[metricName] = laneComparisonMetric(
        baselineCases,
        candidateCases,
        descriptor,
        bootstrapOptions,
      );
    }
    metrics.highCriticalPreservation = metrics.highCriticalRootCauseRecall;
    metrics.precision = metrics.actionablePrecision;
    return { ...comparison, metrics };
  });
  const cleanVariants = variants.map(({ _casePrimitives, ...variant }) => variant);
  const complete = cleanVariants.every((variant) =>
    LANE_REQUIRED_METRICS.every(
      (metricName) => variant.metrics[metricName]?.status === METRIC_STATUS.AVAILABLE,
    ),
  );
  return {
    status:
      totalCount === 0
        ? "INSUFFICIENT_EVIDENCE"
        : complete && pairing.status === "COMPLETE"
          ? "COMPLETE"
          : "PARTIAL",
    errors: [],
    warnings: pairing.warnings ?? [],
    pairedCaseCount: totalCount,
    variants: cleanVariants,
    comparisons,
    methodology: {
      quantile: "LINEAR_INTERPOLATION",
      confidence: "PAIRED_BOOTSTRAP_PERCENTILE",
      replicateAggregation: "CASE_PRIMITIVES",
      inferentialUnit: "CASE",
      confidenceLevel: bootstrapOptions.confidenceLevel,
      bootstrapIterations: bootstrapOptions.iterations,
      bootstrapSeed: bootstrapOptions.seed,
    },
  };
}

export const scoreLaneRuns = calculateLaneMetrics;
