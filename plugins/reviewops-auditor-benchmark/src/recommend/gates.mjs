// @ts-check

import {
  daysBetween,
  isFiniteNumber,
  isNonEmptyString,
  isNonNegativeInteger,
  isPlainObject,
  metricNumber,
  parseUtcTimestamp,
  roundNumber,
  uniqueSortedStrings,
} from "../benchmark/shared.mjs";

export const RECOMMENDATION_STATUSES = Object.freeze([
  "RECOMMENDED_FOR_SHADOW",
  "NO_CHANGE_RECOMMENDED",
  "INSUFFICIENT_EVIDENCE",
  "BLOCKED_BY_SAFETY_GATE",
]);

const TIE_POLICIES = new Set([
  "NO_AUTOMATIC_WINNER",
  "LOWEST_ROOT_CAUSE_COST",
  "LOWEST_COST",
  "LOWEST_LATENCY",
]);

/**
 * @param {string} id
 * @param {"PASS" | "FAIL" | "UNKNOWN" | "BLOCKED"} status
 * @param {string} reasonCode
 * @param {Record<string, unknown> | undefined} [details]
 */
function gate(id, status, reasonCode, details = undefined) {
  const result = { id, status, reasonCode };
  return details === undefined ? result : { ...result, details };
}

/** @param {unknown} value @returns {Record<string, any>[]} */
function objectRecords(value) {
  return Array.isArray(value) ? value.filter((entry) => isPlainObject(entry)) : [];
}

/** @param {unknown} value @returns {string[]} */
function strings(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

/** @param {unknown} scorecard @returns {Record<string, any>[]} */
function lanesFromScorecard(scorecard) {
  if (!isPlainObject(scorecard)) {
    return [];
  }
  return Array.isArray(scorecard.lanes) ? objectRecords(scorecard.lanes) : [];
}

/**
 * @param {unknown} scorecards
 * @param {unknown} scorecard
 * @returns {Record<string, any>[]}
 */
function allLanes(scorecards, scorecard) {
  const sources = Array.isArray(scorecards) ? scorecards : [scorecard];
  return sources.flatMap((item) => lanesFromScorecard(item));
}

/**
 * Public schema validation is authoritative. This defensive subset prevents
 * direct callers from turning a missing policy into a recommendation.
 *
 * @param {unknown} policy
 * @returns {policy is Record<string, any>}
 */
function validPolicy(policy) {
  if (!isPlainObject(policy)) {
    return false;
  }
  return (
    isNonEmptyString(policy.policyId) &&
    isFiniteNumber(policy.confidenceLevel) &&
    policy.confidenceLevel > 0 &&
    policy.confidenceLevel < 1 &&
    isNonNegativeInteger(policy.bootstrapIterations) &&
    policy.bootstrapIterations > 0 &&
    isNonEmptyString(policy.bootstrapSeed) &&
    isNonNegativeInteger(policy.minimumPairedCases) &&
    policy.minimumPairedCases >= 1 &&
    isFiniteNumber(policy.minimumMetricCoverage) &&
    policy.minimumMetricCoverage >= 0 &&
    policy.minimumMetricCoverage <= 1 &&
    isNonEmptyString(policy.tiePolicy) &&
    TIE_POLICIES.has(policy.tiePolicy) &&
    isNonNegativeInteger(policy.shadowObservationDays) &&
    policy.shadowObservationDays >= 1 &&
    Array.isArray(policy.exceptions)
  );
}

/**
 * @param {unknown} policy
 * @returns {policy is Record<string, any>}
 */
function validLanePolicy(policy) {
  return (
    validPolicy(policy) &&
    Array.isArray(policy.decisionSliceIds) &&
    policy.decisionSliceIds.length > 0 &&
    policy.sliceMultiplicityMethod === "HOLM_BONFERRONI" &&
    isFiniteNumber(policy.minimumRootCauseCoverage) &&
    policy.minimumRootCauseCoverage >= 0 &&
    policy.minimumRootCauseCoverage <= 1 &&
    policy.requiredCostBasis === "FULLY_LOADED" &&
    isFiniteNumber(policy.highCriticalRootCauseNonInferiorityMargin) &&
    isFiniteNumber(policy.criticalMissNonInferiorityMargin) &&
    isFiniteNumber(policy.hallucinationNonInferiorityMargin) &&
    isFiniteNumber(policy.actionablePrecisionNonInferiorityMargin) &&
    isFiniteNumber(policy.rootCauseQualityNonInferiorityMargin) &&
    isFiniteNumber(
      policy.minimumCostPerConfirmedHighCriticalRootCauseImprovementFraction,
    ) &&
    isFiniteNumber(policy.maximumHumanReviewRegressionFraction) &&
    isFiniteNumber(policy.maximumP95CostRegressionFraction) &&
    isFiniteNumber(policy.maximumP99CostRegressionFraction) &&
    isFiniteNumber(policy.maximumP95LatencyRegressionFraction) &&
    isFiniteNumber(policy.maximumP99LatencyRegressionFraction) &&
    isFiniteNumber(policy.minimumFindingStability) &&
    Array.isArray(policy.allowedExceptionTypes)
  );
}

/**
 * New guardrail exceptions are closed and scoped. They can relax only the
 * named tail/human guardrail, never missing evidence or safety gates.
 *
 * @param {Record<string, any>} policy
 * @param {string} type
 * @param {unknown} analysisAsOf
 * @param {string[]} scopes
 */
function activeScopedException(policy, type, analysisAsOf, scopes) {
  if (!strings(policy.allowedExceptionTypes).includes(type)) {
    return false;
  }
  const asOf = parseUtcTimestamp(analysisAsOf);
  if (asOf === undefined || !Array.isArray(policy.exceptions)) {
    return false;
  }
  return policy.exceptions.some((exception) => {
    if (
      !isPlainObject(exception) ||
      exception.type !== type ||
      !isNonEmptyString(exception.approvedBy) ||
      !isNonEmptyString(exception.scope) ||
      !scopes.includes(exception.scope)
    ) {
      return false;
    }
    const expiresAt = parseUtcTimestamp(exception.expiresAt);
    return expiresAt !== undefined && expiresAt >= asOf;
  });
}

/** @param {unknown} report @returns {Record<string, any>[]} */
function staticFindings(report) {
  return isPlainObject(report) ? objectRecords(report.findings) : [];
}

/**
 * Missing static diagnostics and ordinary static findings are limitations, not
 * gates. Only the versioned closed predicate can block a shadow report.
 *
 * @param {unknown} report
 * @param {Record<string, any>} policy
 * @param {unknown} candidateLaneId
 * @param {unknown} candidateVariantId
 */
function staticDiagnosticGate(report, policy, candidateLaneId, candidateVariantId) {
  if (!isPlainObject(report)) {
    return gate(
      "RO-GATE-STATIC-DIAGNOSTICS",
      "PASS",
      "STATIC_DIAGNOSTICS_NOT_SUPPLIED",
    );
  }
  if (report.status === "BLOCKED" || report.status === "ERROR") {
    return gate("RO-GATE-STATIC-DIAGNOSTICS", "BLOCKED", "STATIC_DIAGNOSTICS_BLOCKED");
  }
  const allowed = new Set(strings(policy.blockingStaticRuleIds));
  const blocking = staticFindings(report).some((finding) => {
    const confidence =
      finding.confidence === "HIGH" ||
      (typeof finding.confidence === "number" && finding.confidence >= 0.9);
    return (
      allowed.has(finding.ruleId) &&
      finding.evidenceStatus === "OBSERVED" &&
      finding.severity === "CRITICAL" &&
      confidence &&
      finding.blocksShadowPath === true &&
      isPlainObject(finding.binding) &&
      isNonEmptyString(finding.binding.laneId) &&
      isNonEmptyString(finding.binding.variantId) &&
      isNonEmptyString(finding.binding.architectureStructuralDigest) &&
      (!isNonEmptyString(candidateLaneId) ||
        finding.binding.laneId === candidateLaneId) &&
      (!isNonEmptyString(candidateVariantId) ||
        finding.binding.variantId === candidateVariantId) &&
      (finding.applicableToShadowPath === true ||
        finding.shadowPathApplicable === true ||
        finding.applicable === true)
    );
  });
  return blocking
    ? gate(
        "RO-GATE-STATIC-DIAGNOSTICS",
        "BLOCKED",
        "STATIC_SAFETY_FINDING_BLOCKS_SHADOW",
      )
    : gate("RO-GATE-STATIC-DIAGNOSTICS", "PASS", "STATIC_DIAGNOSTICS_NON_BLOCKING");
}

/** @param {Record<string, any>} lane */
function laneStatus(lane) {
  return typeof lane.status === "string" ? lane.status : "INSUFFICIENT_EVIDENCE";
}

/** @param {Record<string, any>} lane */
function laneType(lane) {
  return lane.laneType ?? lane.evalValidity?.laneType ?? lane.manifest?.lane?.laneType;
}

/** @param {Record<string, any>} lane */
function attributionStatus(lane) {
  return (
    lane.attributionStatus ??
    lane.evalValidity?.attributionStatus ??
    lane.validity?.attributionStatus ??
    "UNKNOWN"
  );
}

/** @param {Record<string, any>} lane */
function pairedCount(lane) {
  const value = [
    lane.pairedCaseCount,
    lane.pairingCoverage?.pairedCaseCount,
    lane.pairing?.pairedCaseCount,
    lane.evalValidity?.pairingCoverage?.pairedCaseCount,
  ].find((entry) => typeof entry === "number");
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0;
}

/** @param {Record<string, any>} lane */
function laneExecutionMode(lane) {
  return lane.executionMode ?? lane.manifest?.lane?.executionMode ?? null;
}

/** @param {Record<string, any>} lane */
function laneIsEligible(lane) {
  const attribution = attributionStatus(lane);
  return (
    laneStatus(lane) === "COMPLETE" &&
    attribution !== "CONFOUNDED" &&
    attribution !== "UNKNOWN" &&
    lane.recommendationEligible !== false
  );
}

/** @param {Record<string, any>[]} lanes */
function hasBlockedLane(lanes) {
  return lanes.some(
    (lane) => laneStatus(lane) === "BLOCKED" || laneStatus(lane) === "ERROR",
  );
}

/** @param {Record<string, any>} lane @param {string} variantId */
function laneVariant(lane, variantId) {
  const global = isPlainObject(lane.global) ? lane.global : lane;
  return objectRecords(global.variants ?? lane.variants).find(
    (variant) => variant.variantId === variantId,
  );
}

/** @param {Record<string, any>} lane @param {string} variantId */
function laneComparison(lane, variantId) {
  const global = isPlainObject(lane.global) ? lane.global : lane;
  return objectRecords(global.comparisons ?? lane.comparisons).find(
    (comparison) => comparison.candidateVariantId === variantId,
  );
}

/** @param {Record<string, any> | undefined} variant @param {string} name */
function laneMetric(variant, name) {
  if (!variant || !isPlainObject(variant.metrics)) {
    return undefined;
  }
  return variant.metrics[name];
}

/**
 * @param {Record<string, any> | undefined} comparison
 * @param {string} name
 * @returns {Record<string, any> | null}
 */
function laneInterval(comparison, name) {
  const interval = comparison?.metrics?.[name]?.interval;
  return isPlainObject(interval) &&
    interval.status === "AVAILABLE" &&
    isFiniteNumber(interval.lower) &&
    isFiniteNumber(interval.upper)
    ? /** @type {Record<string, any>} */ (interval)
    : null;
}

/** @param {unknown} metric */
function coverage(metric) {
  return isPlainObject(metric) && isFiniteNumber(metric.coverage)
    ? metric.coverage
    : undefined;
}

/**
 * @param {Record<string, any>} lane
 * @param {string} candidateVariantId
 * @param {Record<string, any>} policy
 */
function metricCoverageGate(lane, candidateVariantId, policy) {
  const baselineId =
    lane.baselineVariantId ??
    lane.pairing?.baselineVariantId ??
    lane.comparisons?.[0]?.baselineVariantId;
  const baseline = laneVariant(lane, baselineId);
  const candidate = laneVariant(lane, candidateVariantId);
  const required = [
    "highCriticalRootCauseRecall",
    "criticalMissRate",
    "actionablePrecision",
    "hallucinationRate",
    "rootCauseQuality",
    "fullyLoadedCostPerConfirmedHighCriticalRootCause",
    "humanReviewMinutesPerCase",
    "costP95",
    "costP99",
    "latencyP95",
    "latencyP99",
    "findingStability",
  ];
  const missing = required.filter((name) => {
    const minimum =
      name === "highCriticalRootCauseRecall" ||
      name === "criticalMissRate" ||
      name === "fullyLoadedCostPerConfirmedHighCriticalRootCause"
        ? Math.max(policy.minimumMetricCoverage, policy.minimumRootCauseCoverage)
        : policy.minimumMetricCoverage;
    const left = coverage(laneMetric(baseline, name));
    const right = coverage(laneMetric(candidate, name));
    return (
      left === undefined || right === undefined || left < minimum || right < minimum
    );
  });
  return missing.length === 0
    ? gate("RO-GATE-METRIC-COVERAGE", "PASS", "METRIC_COVERAGE_SATISFIED")
    : gate("RO-GATE-METRIC-COVERAGE", "UNKNOWN", "INSUFFICIENT_METRIC_COVERAGE", {
        missingMetrics: missing,
      });
}

/**
 * @param {string} id
 * @param {Record<string, any> | undefined} comparison
 * @param {string} metricName
 * @param {"MAXIMIZE" | "MINIMIZE"} direction
 * @param {number} margin
 */
function laneIntervalGate(id, comparison, metricName, direction, margin) {
  const interval = laneInterval(comparison, metricName);
  if (!interval) {
    return gate(id, "UNKNOWN", "MISSING_CONFIDENCE_INTERVAL");
  }
  const passes =
    direction === "MAXIMIZE" ? interval.lower >= -margin : interval.upper <= margin;
  return passes
    ? gate(id, "PASS", "NON_INFERIORITY_SATISFIED")
    : gate(id, "FAIL", "NON_INFERIORITY_NOT_SATISFIED");
}

/**
 * @param {string} id
 * @param {Record<string, any> | undefined} baseline
 * @param {Record<string, any> | undefined} candidate
 * @param {Record<string, any> | undefined} comparison
 * @param {string} metricName
 * @param {number} maximumRegressionFraction
 * @param {boolean} [exceptionActive]
 */
function relativeGuardrailGate(
  id,
  baseline,
  candidate,
  comparison,
  metricName,
  maximumRegressionFraction,
  exceptionActive = false,
) {
  const baselineValue = metricNumber(laneMetric(baseline, metricName));
  const candidateValue = metricNumber(laneMetric(candidate, metricName));
  const interval = laneInterval(comparison, metricName);
  if (
    !isFiniteNumber(baselineValue) ||
    baselineValue < 0 ||
    !isFiniteNumber(candidateValue) ||
    !interval
  ) {
    return gate(id, "UNKNOWN", "MISSING_GUARDRAIL_EVIDENCE");
  }
  const allowedDelta = baselineValue * maximumRegressionFraction;
  if (
    candidateValue <= baselineValue + allowedDelta &&
    interval.upper <= allowedDelta
  ) {
    return gate(id, "PASS", "GUARDRAIL_SATISFIED");
  }
  return exceptionActive
    ? gate(id, "PASS", "APPROVED_EXCEPTION_APPLIED")
    : gate(id, "FAIL", "GUARDRAIL_NOT_SATISFIED");
}

/**
 * @param {Record<string, any>} lane
 * @param {string} candidateVariantId
 * @param {Record<string, any>} policy
 * @param {unknown} analysisAsOf
 */
function candidateEvidenceGates(lane, candidateVariantId, policy, analysisAsOf) {
  const gates = [];
  const baselineId =
    lane.baselineVariantId ??
    lane.pairing?.baselineVariantId ??
    lane.comparisons?.[0]?.baselineVariantId;
  const baseline = laneVariant(lane, baselineId);
  const candidate = laneVariant(lane, candidateVariantId);
  const comparison = laneComparison(lane, candidateVariantId);
  if (!baseline || !candidate || !comparison || baselineId === candidateVariantId) {
    return [gate("RO-GATE-CANDIDATE", "UNKNOWN", "MISSING_COMPARISON_VARIANT")];
  }
  gates.push(gate("RO-GATE-CANDIDATE", "PASS", "COMPARISON_VARIANTS_PRESENT"));
  const frontierSource = (isPlainObject(lane.global) ? lane.global : lane).frontier;
  const frontier = Array.isArray(frontierSource)
    ? objectRecords(frontierSource)
    : objectRecords(frontierSource?.frontier);
  gates.push(
    frontier.length === 0
      ? gate("RO-GATE-FRONTIER", "UNKNOWN", "MISSING_PARETO_FRONTIER")
      : frontier.some((point) => point.variantId === candidateVariantId)
        ? gate("RO-GATE-FRONTIER", "PASS", "CANDIDATE_IS_NON_DOMINATED")
        : gate("RO-GATE-FRONTIER", "FAIL", "CANDIDATE_IS_DOMINATED"),
  );
  gates.push(metricCoverageGate(lane, candidateVariantId, policy));
  gates.push(
    laneIntervalGate(
      "RO-GATE-HIGH-CRITICAL",
      comparison,
      "highCriticalRootCauseRecall",
      "MAXIMIZE",
      policy.highCriticalRootCauseNonInferiorityMargin,
    ),
    laneIntervalGate(
      "RO-GATE-CRITICAL-MISS",
      comparison,
      "criticalMissRate",
      "MINIMIZE",
      policy.criticalMissNonInferiorityMargin,
    ),
    laneIntervalGate(
      "RO-GATE-HALLUCINATION",
      comparison,
      "hallucinationRate",
      "MINIMIZE",
      policy.hallucinationNonInferiorityMargin,
    ),
    laneIntervalGate(
      "RO-GATE-ACTIONABLE-PRECISION",
      comparison,
      "actionablePrecision",
      "MAXIMIZE",
      policy.actionablePrecisionNonInferiorityMargin,
    ),
    laneIntervalGate(
      "RO-GATE-ROOT-CAUSE-QUALITY",
      comparison,
      "rootCauseQuality",
      "MAXIMIZE",
      policy.rootCauseQualityNonInferiorityMargin,
    ),
  );
  const baselineCost = metricNumber(
    laneMetric(baseline, "fullyLoadedCostPerConfirmedHighCriticalRootCause"),
  );
  const candidateCost = metricNumber(
    laneMetric(candidate, "fullyLoadedCostPerConfirmedHighCriticalRootCause"),
  );
  const costInterval = laneInterval(
    comparison,
    "fullyLoadedCostPerConfirmedHighCriticalRootCause",
  );
  if (
    !isFiniteNumber(baselineCost) ||
    baselineCost <= 0 ||
    !isFiniteNumber(candidateCost) ||
    !costInterval
  ) {
    gates.push(gate("RO-GATE-ROOT-CAUSE-COST", "UNKNOWN", "MISSING_COST_EVIDENCE"));
  } else {
    const required =
      policy.minimumCostPerConfirmedHighCriticalRootCauseImprovementFraction;
    if (!isFiniteNumber(required)) {
      gates.push(gate("RO-GATE-ROOT-CAUSE-COST", "UNKNOWN", "MISSING_COST_EVIDENCE"));
      return gates;
    }
    const improvement = roundNumber((baselineCost - candidateCost) / baselineCost);
    const requiredDelta = -baselineCost * required;
    gates.push(
      improvement >= required && costInterval.upper <= requiredDelta
        ? gate("RO-GATE-ROOT-CAUSE-COST", "PASS", "COST_IMPROVEMENT_SATISFIED")
        : gate("RO-GATE-ROOT-CAUSE-COST", "FAIL", "COST_IMPROVEMENT_NOT_SATISFIED"),
    );
  }
  gates.push(
    relativeGuardrailGate(
      "RO-GATE-HUMAN-REVIEW",
      baseline,
      candidate,
      comparison,
      "humanReviewMinutesPerCase",
      policy.maximumHumanReviewRegressionFraction,
      activeScopedException(
        policy,
        "HUMAN_REVIEW",
        analysisAsOf,
        [lane.laneId, candidateVariantId].filter(isNonEmptyString),
      ),
    ),
    relativeGuardrailGate(
      "RO-GATE-P95-COST",
      baseline,
      candidate,
      comparison,
      "costP95",
      policy.maximumP95CostRegressionFraction,
    ),
    relativeGuardrailGate(
      "RO-GATE-P99-COST",
      baseline,
      candidate,
      comparison,
      "costP99",
      policy.maximumP99CostRegressionFraction,
      activeScopedException(
        policy,
        "P99_COST",
        analysisAsOf,
        [lane.laneId, candidateVariantId].filter(isNonEmptyString),
      ),
    ),
    relativeGuardrailGate(
      "RO-GATE-P95-LATENCY",
      baseline,
      candidate,
      comparison,
      "latencyP95",
      policy.maximumP95LatencyRegressionFraction,
      activeScopedException(
        policy,
        "P95_LATENCY",
        analysisAsOf,
        [lane.laneId, candidateVariantId].filter(isNonEmptyString),
      ),
    ),
    relativeGuardrailGate(
      "RO-GATE-P99-LATENCY",
      baseline,
      candidate,
      comparison,
      "latencyP99",
      policy.maximumP99LatencyRegressionFraction,
    ),
  );
  const stability = metricNumber(laneMetric(candidate, "findingStability"));
  gates.push(
    !isFiniteNumber(stability)
      ? gate("RO-GATE-STABILITY", "UNKNOWN", "MISSING_STABILITY_EVIDENCE")
      : stability < policy.minimumFindingStability
        ? gate("RO-GATE-STABILITY", "FAIL", "FINDING_STABILITY_NOT_SATISFIED")
        : gate("RO-GATE-STABILITY", "PASS", "FINDING_STABILITY_SATISFIED"),
  );
  const contractDifferences = objectRecords(lane.candidateContractDifferences);
  const protectedFields = new Set([
    "controllerContractId",
    "validatorContractId",
    "dedupePolicyId",
    "postingPolicyId",
  ]);
  const changedProtected = contractDifferences.some(
    (difference) =>
      difference.variantId === candidateVariantId &&
      protectedFields.has(difference.field),
  );
  gates.push(
    changedProtected
      ? gate("RO-GATE-PRESERVATION", "BLOCKED", "PRODUCTION_CONTRACT_NOT_PRESERVED")
      : gate("RO-GATE-PRESERVATION", "PASS", "PRODUCTION_CONTRACTS_PRESERVED"),
  );
  return gates;
}

/**
 * @param {{
 *   scorecards?: unknown,
 *   scorecard?: unknown,
 *   staticDiagnostics?: unknown,
 *   auditReport?: unknown,
 *   decisionPolicy?: unknown,
 *   analysisAsOf?: unknown,
 *   candidateLaneId?: unknown,
 *   candidateVariantId?: unknown
 * }} [options]
 */
function evaluateLaneAwareGates({
  scorecards,
  scorecard,
  staticDiagnostics,
  auditReport,
  decisionPolicy,
  analysisAsOf,
  candidateLaneId,
  candidateVariantId,
} = {}) {
  const gates = [];
  if (!validLanePolicy(decisionPolicy)) {
    gates.push(gate("RO-GATE-POLICY", "UNKNOWN", "MISSING_OR_INVALID_DECISION_POLICY"));
    return {
      status: "INSUFFICIENT_EVIDENCE",
      gates,
      reasonCodes: ["MISSING_OR_INVALID_DECISION_POLICY"],
      eligibleLanes: [],
    };
  }
  const policy = /** @type {Record<string, any>} */ (decisionPolicy);
  gates.push(gate("RO-GATE-POLICY", "PASS", "DECISION_POLICY_VALID"));
  const lanes = allLanes(scorecards, scorecard);
  if (lanes.length === 0) {
    gates.push(gate("RO-GATE-EVAL-VALIDITY", "UNKNOWN", "MISSING_LANE_EVIDENCE"));
    return {
      status: "INSUFFICIENT_EVIDENCE",
      gates,
      reasonCodes: ["MISSING_LANE_EVIDENCE"],
      eligibleLanes: [],
    };
  }
  const eligibleLanes = lanes.filter((lane) => laneIsEligible(lane));
  const targetLanes =
    typeof candidateLaneId === "string"
      ? eligibleLanes.filter(
          (lane) =>
            lane.laneId === candidateLaneId ||
            lane.manifest?.lane?.laneId === candidateLaneId,
        )
      : eligibleLanes.filter((lane) =>
          ["BEST_SYSTEM", "SHADOW_PILOT"].includes(laneType(lane)),
        );
  if (targetLanes.length === 0 && hasBlockedLane(lanes)) {
    gates.push(
      gate("RO-GATE-INTEGRITY", "BLOCKED", "UNRESOLVED_INPUT_INTEGRITY_WARNING"),
    );
    return {
      status: "BLOCKED_BY_SAFETY_GATE",
      gates,
      reasonCodes: ["UNRESOLVED_INPUT_INTEGRITY_WARNING"],
      eligibleLanes: [],
    };
  }
  gates.push(gate("RO-GATE-INTEGRITY", "PASS", "INPUT_INTEGRITY_SATISFIED"));
  gates.push(
    eligibleLanes.length === 0
      ? gate("RO-GATE-EVAL-VALIDITY", "UNKNOWN", "NO_ELIGIBLE_EVAL_LANE")
      : gate("RO-GATE-EVAL-VALIDITY", "PASS", "EVAL_VALIDITY_SATISFIED"),
  );
  const scopedLanes = targetLanes.length > 0 ? targetLanes : eligibleLanes;
  const tooSmall = scopedLanes.filter(
    (lane) => pairedCount(lane) < policy.minimumPairedCases,
  );
  gates.push(
    scopedLanes.length === 0 || tooSmall.length > 0
      ? gate("RO-GATE-PAIRS", "UNKNOWN", "INSUFFICIENT_PAIRED_CASES", {
          required: policy.minimumPairedCases,
          observed: scopedLanes.map((lane) => pairedCount(lane)),
        })
      : gate("RO-GATE-PAIRS", "PASS", "MINIMUM_PAIRED_CASES_SATISFIED"),
  );
  const missingFullyLoaded = scopedLanes.some((lane) => {
    const basis =
      lane.costBasis ??
      lane.pricingSnapshot?.costBasis ??
      lane.metrics?.costBasis ??
      lane.methodology?.costBasis;
    return basis !== (policy.requiredCostBasis ?? "FULLY_LOADED");
  });
  gates.push(
    missingFullyLoaded
      ? gate("RO-GATE-PRICING", "UNKNOWN", "MISSING_FULLY_LOADED_COST_EVIDENCE")
      : gate("RO-GATE-PRICING", "PASS", "FULLY_LOADED_COST_EVIDENCE_SATISFIED"),
  );
  const stalePricing = scopedLanes.some((lane) => {
    const effectiveAt =
      lane.pricingSnapshot?.effectiveAt ?? lane.pricingEffectiveAt ?? undefined;
    const ageDays = daysBetween(analysisAsOf, effectiveAt);
    return (
      ageDays === undefined ||
      !isFiniteNumber(policy.maxPricingAgeDays) ||
      ageDays < 0 ||
      ageDays > policy.maxPricingAgeDays
    );
  });
  if (stalePricing) {
    gates.push(gate("RO-GATE-PRICING-AGE", "UNKNOWN", "STALE_OR_FUTURE_PRICING"));
  }
  const badShadow = scopedLanes.some(
    (lane) =>
      laneType(lane) === "SHADOW_PILOT" &&
      laneExecutionMode(lane) !== "SHADOW_NO_POSTING",
  );
  gates.push(
    badShadow
      ? gate("RO-GATE-NO-POSTING", "BLOCKED", "SHADOW_POSTING_NOT_DISABLED")
      : gate("RO-GATE-NO-POSTING", "PASS", "SHADOW_NO_POSTING_SATISFIED"),
  );
  if (typeof candidateVariantId === "string") {
    const candidateLane = eligibleLanes.find(
      (lane) =>
        (typeof candidateLaneId !== "string" ||
          lane.laneId === candidateLaneId ||
          lane.manifest?.lane?.laneId === candidateLaneId) &&
        laneVariant(lane, candidateVariantId) !== undefined,
    );
    gates.push(
      ...(candidateLane
        ? candidateEvidenceGates(
            candidateLane,
            candidateVariantId,
            policy,
            analysisAsOf,
          )
        : [gate("RO-GATE-CANDIDATE", "UNKNOWN", "MISSING_COMPARISON_VARIANT")]),
    );
  }
  gates.push(
    staticDiagnosticGate(
      staticDiagnostics ?? auditReport,
      policy,
      candidateLaneId,
      candidateVariantId,
    ),
  );
  const blocked = gates.some((item) => item.status === "BLOCKED");
  const unknown = gates.some((item) => item.status === "UNKNOWN");
  const failed = gates.some((item) => item.status === "FAIL");
  return {
    status: blocked
      ? "BLOCKED_BY_SAFETY_GATE"
      : unknown
        ? "INSUFFICIENT_EVIDENCE"
        : failed
          ? "NO_CHANGE_RECOMMENDED"
          : "RECOMMENDED_FOR_SHADOW",
    gates,
    reasonCodes: uniqueSortedStrings(
      gates.filter((item) => item.status !== "PASS").map((item) => item.reasonCode),
    ),
    eligibleLanes,
  };
}

export function evaluateRecommendationGates(options = {}) {
  return evaluateLaneAwareGates(options);
}

export const runRecommendationGates = evaluateRecommendationGates;
