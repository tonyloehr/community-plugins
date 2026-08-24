import { calculateMetrics } from "./metrics.mjs";
import { normalizeBenchmarkInput } from "./normalize.mjs";
import { buildPairedComparison } from "./paired.mjs";
import { computeParetoFrontier } from "./pareto.mjs";
import { normalizeLaneBundle, normalizeLaneBundles } from "../normalize/index.mjs";
import { evaluateLaneValidity } from "../eval/index.mjs";
import { calculateLaneMetrics } from "./metrics.mjs";
import { buildLanePairedComparison } from "./paired.mjs";
import { declaredSliceIds, pairingForSlice } from "./slices.mjs";
import { isFiniteNumber, issue, roundNumber, uniqueSortedStrings } from "./shared.mjs";

function methodology(options) {
  return {
    quantile: "LINEAR_INTERPOLATION",
    confidence: "PAIRED_BOOTSTRAP_PERCENTILE",
    confidenceLevel:
      options.confidenceLevel ?? options.decisionPolicy?.confidenceLevel ?? 0.95,
    bootstrapIterations:
      options.bootstrapIterations ??
      options.decisionPolicy?.bootstrapIterations ??
      10_000,
    bootstrapSeed:
      options.bootstrapSeed ?? options.decisionPolicy?.bootstrapSeed ?? "reviewops-v1",
  };
}

/**
 * Convenient pure pipeline for CLI integration. Individual stages remain
 * exported from their modules for focused tests and diagnostics.
 *
 * @param {Record<string, any>} input
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>}
 */
export function buildBenchmarkScorecard(input, options = {}) {
  if (
    Array.isArray(input?.laneBundles) ||
    input?.manifest?.lane ||
    input?.benchmarkManifest?.lane ||
    input?.bundleId
  ) {
    return buildMultiLaneScorecards(input, options);
  }
  const normalized = normalizeBenchmarkInput(input);
  if (normalized.status === "BLOCKED") {
    return {
      schemaVersion: 1,
      status: "BLOCKED",
      errors: normalized.errors,
      warnings: normalized.warnings,
      pairing: null,
      variants: [],
      comparisons: [],
      frontier: computeParetoFrontier([]),
      pricingSnapshot: normalized.pricingSnapshot,
      methodology: methodology(options),
    };
  }
  const pairing = buildPairedComparison(normalized, options);
  const metrics = calculateMetrics(normalized, pairing, options);
  const frontier = computeParetoFrontier(metrics.variants, options.frontierDimensions);
  return {
    schemaVersion: 1,
    ...metrics,
    status:
      metrics.status === "BLOCKED" || pairing.status === "BLOCKED"
        ? "BLOCKED"
        : metrics.status === "INSUFFICIENT_EVIDENCE" ||
            pairing.status === "INSUFFICIENT_EVIDENCE"
          ? "INSUFFICIENT_EVIDENCE"
          : metrics.status === "PARTIAL" ||
              pairing.status === "PARTIAL" ||
              frontier.status === "PARTIAL"
            ? "PARTIAL"
            : "COMPLETE",
    pairing,
    frontier,
    pricingSnapshot: normalized.pricingSnapshot,
    rubric: normalized.rubric,
    methodology: metrics.methodology ?? methodology(options),
  };
}

function normalizedLane(value) {
  if (
    value &&
    Array.isArray(value.runs) &&
    value.caseLabelsById instanceof Map &&
    "rankingEligible" in value
  ) {
    return value;
  }
  return normalizeLaneBundle(value);
}

function emptyFrontier(reasonCode) {
  return {
    status: "INSUFFICIENT_EVIDENCE",
    dimensions: [],
    frontier: [],
    dominated: [],
    unknown: [],
    reasonCodes: [reasonCode],
  };
}

function laneStatus(normalized, validity, metrics) {
  if (normalized.status === "BLOCKED" || validity.status === "BLOCKED") {
    return "BLOCKED";
  }
  if (validity.status !== "COMPLETE" || metrics.status === "INSUFFICIENT_EVIDENCE") {
    return "INSUFFICIENT_EVIDENCE";
  }
  if (
    normalized.status === "PARTIAL" ||
    metrics.status === "PARTIAL" ||
    validity.pairing?.status === "PARTIAL"
  ) {
    return "PARTIAL";
  }
  return "COMPLETE";
}

/**
 * Decision slices use a simultaneous Bonferroni confidence level. The
 * recommendation layer may apply Holm ordering to gates, but it must not
 * consume unadjusted slice intervals as family-wise evidence.
 *
 * @param {Record<string, any>} options
 * @param {string} sliceId
 * @returns {{method: "HOLM_BONFERRONI", familySize: number, adjustedConfidenceLevel: number} | null}
 */
function decisionSliceMultiplicity(options, sliceId) {
  const policy = options.decisionPolicy;
  const decisionSliceIds = Array.isArray(policy?.decisionSliceIds)
    ? uniqueSortedStrings(policy.decisionSliceIds)
    : [];
  if (
    !decisionSliceIds.includes(sliceId) ||
    policy?.sliceMultiplicityMethod !== "HOLM_BONFERRONI" ||
    decisionSliceIds.length === 0
  ) {
    return null;
  }
  const confidenceLevel = options.confidenceLevel ?? policy?.confidenceLevel ?? 0.95;
  if (
    !isFiniteNumber(confidenceLevel) ||
    confidenceLevel <= 0 ||
    confidenceLevel >= 1
  ) {
    return null;
  }
  return {
    method: "HOLM_BONFERRONI",
    familySize: decisionSliceIds.length,
    adjustedConfidenceLevel: roundNumber(
      1 - (1 - confidenceLevel) / decisionSliceIds.length,
    ),
  };
}

/**
 * Score one already-loaded lane bundle. A non-complete validity report may
 * retain descriptive metrics, but it never receives a ranking frontier.
 *
 * @param {any} input
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>}
 */
export function buildLaneBenchmarkScorecard(input, options = {}) {
  const normalized = normalizedLane(input);
  const validity = evaluateLaneValidity(normalized, options);
  const pairing = validity.pairing ?? buildLanePairedComparison(normalized, options);
  const metrics = calculateLaneMetrics(normalized, pairing, options);
  const canRank = validity.status === "COMPLETE" && metrics.pairedCaseCount > 0;
  const frontier = canRank
    ? computeParetoFrontier(metrics.variants, options.frontierDimensions)
    : emptyFrontier("EVAL_VALIDITY_INCOMPLETE");
  const slices = declaredSliceIds(normalized).map((sliceId) => {
    const slicePairing = pairingForSlice(normalized, pairing, sliceId);
    const multiplicity = decisionSliceMultiplicity(options, sliceId);
    const sliceMetrics = calculateLaneMetrics(
      normalized,
      slicePairing,
      multiplicity
        ? { ...options, confidenceLevel: multiplicity.adjustedConfidenceLevel }
        : options,
    );
    const minimum =
      options.decisionPolicy?.minimumPairedCasesPerSlice ??
      options.minimumPairedCasesPerSlice ??
      0;
    const decisionDeclared = Array.isArray(options.decisionPolicy?.decisionSliceIds)
      ? options.decisionPolicy.decisionSliceIds.includes(sliceId)
      : false;
    const eligibleForRanking =
      canRank &&
      slicePairing.pairedCaseIds.length > 0 &&
      slicePairing.pairedCaseIds.length >= minimum;
    return {
      sliceId,
      status:
        slicePairing.pairedCaseIds.length === 0
          ? "INSUFFICIENT_EVIDENCE"
          : eligibleForRanking
            ? sliceMetrics.status
            : "INSUFFICIENT_EVIDENCE",
      decisionEligible: decisionDeclared && eligibleForRanking,
      descriptiveOnly: !decisionDeclared,
      multiplicity,
      pairing: slicePairing,
      pairedCaseCount: slicePairing.pairedCaseIds.length,
      variants: sliceMetrics.variants,
      comparisons: sliceMetrics.comparisons,
      frontier: eligibleForRanking
        ? computeParetoFrontier(sliceMetrics.variants, options.frontierDimensions)
        : emptyFrontier(
            decisionDeclared ? "INSUFFICIENT_SLICE_EVIDENCE" : "DESCRIPTIVE_ONLY_SLICE",
          ),
      limitations: eligibleForRanking
        ? []
        : [
            decisionDeclared
              ? "Slice evidence is below its paired-case threshold."
              : "Slice is descriptive only; policy did not predeclare it.",
          ],
    };
  });
  const status = laneStatus(normalized, validity, metrics);
  const errors = [
    ...(normalized.errors ?? []),
    ...(validity.errors ?? []),
    ...(metrics.errors ?? []),
  ];
  const warnings = [
    ...(normalized.warnings ?? []),
    ...(validity.warnings ?? []),
    ...(metrics.warnings ?? []),
  ];
  return {
    schemaVersion: 1,
    status,
    bundleId: normalized.bundleId ?? null,
    laneId: normalized.lane?.laneId ?? null,
    laneType: normalized.lane?.laneType ?? null,
    baselineVariantId: normalized.lane?.baselineVariantId ?? null,
    replicateAggregation: normalized.evalProtocol?.replicateAggregation ?? null,
    missingReplicatePolicy: normalized.evalProtocol?.missingReplicatePolicy ?? null,
    claimBoundary: validity.claimBoundary,
    attributionStatus: validity.attributionStatus,
    eligibleForRanking: canRank,
    productionBaselineContracts:
      normalized.manifest?.productionBaselineContracts ?? null,
    architectures: (normalized.candidateConfigs ?? []).map((candidate) => ({
      variantId: candidate.variantId,
      architectureId: candidate.architectureId,
      architectureStructuralDigest: candidate.architectureStructuralDigest,
    })),
    candidateContractDifferences: validity.candidateContractDifferences ?? [],
    normalization: normalized.report,
    validity,
    pairing,
    pairedCaseCount: metrics.pairedCaseCount,
    global: {
      status: metrics.status,
      pairedCaseCount: metrics.pairedCaseCount,
      variants: metrics.variants,
      comparisons: metrics.comparisons,
      frontier,
    },
    slices,
    variants: metrics.variants,
    comparisons: metrics.comparisons,
    frontier,
    pricingSnapshot: normalized.pricingSnapshot
      ? {
          schemaVersion: normalized.pricingSnapshot.schemaVersion,
          snapshotId: normalized.pricingSnapshot.snapshotId,
          currency: normalized.pricingSnapshot.currency,
          effectiveAt: normalized.pricingSnapshot.effectiveAt,
          costBasis: normalized.pricingSnapshot.costBasis,
          provenance: normalized.pricingSnapshot.provenance,
          rates: normalized.pricingSnapshot.rates,
        }
      : null,
    methodology: metrics.methodology ?? methodology(options),
    errors,
    warnings,
    reasonCodes: uniqueSortedStrings([
      ...errors.map((entry) => entry.code),
      ...warnings.map((entry) => entry.code),
      ...(validity.reasonCodes ?? []),
    ]),
    limitations: [
      ...(validity.limitations ?? []),
      ...(canRank
        ? []
        : ["Point frontier is withheld until eval validity is complete."]),
    ],
  };
}

/**
 * Score one to eight independent lane bundles without pooling metrics across
 * incompatible experiments.
 *
 * @param {any} input
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>}
 */
export function buildMultiLaneScorecards(input, options = {}) {
  const normalized =
    input &&
    Array.isArray(input.lanes) &&
    input.lanes.every(
      (lane) => lane && Array.isArray(lane.runs) && lane.caseLabelsById instanceof Map,
    )
      ? input
      : normalizeLaneBundles(input);
  if (normalized.status === "BLOCKED") {
    return {
      schemaVersion: 1,
      status: "BLOCKED",
      lanes: [],
      errors: normalized.errors ?? [],
      warnings: normalized.warnings ?? [],
      reasonCodes: normalized.reasonCodes ?? ["NORMALIZATION_BLOCKED"],
      limitations: ["No lane is scored while normalization is blocked."],
    };
  }
  if (!Array.isArray(normalized.lanes) || normalized.lanes.length === 0) {
    const error = issue("NO_LANE_BUNDLES", "No normalized lane bundles are available.");
    return {
      schemaVersion: 1,
      status: "BLOCKED",
      lanes: [],
      errors: [error],
      warnings: [],
      reasonCodes: ["NO_LANE_BUNDLES"],
      limitations: ["No lane can be scored."],
    };
  }
  const lanes = normalized.lanes.map((lane) =>
    buildLaneBenchmarkScorecard(lane, options),
  );
  const status = lanes.some((lane) => lane.status === "BLOCKED")
    ? "BLOCKED"
    : lanes.every((lane) => lane.status === "COMPLETE")
      ? "COMPLETE"
      : lanes.some((lane) => lane.status === "COMPLETE" || lane.status === "PARTIAL")
        ? "PARTIAL"
        : "INSUFFICIENT_EVIDENCE";
  const errors = lanes.flatMap((lane) => lane.errors ?? []);
  const warnings = lanes.flatMap((lane) => lane.warnings ?? []);
  return {
    schemaVersion: 1,
    status,
    lanes,
    errors,
    warnings,
    reasonCodes: uniqueSortedStrings([
      ...errors.map((entry) => entry.code),
      ...warnings.map((entry) => entry.code),
      ...lanes.flatMap((lane) => lane.reasonCodes ?? []),
    ]),
    methodology: {
      laneAggregation: "NONE",
      inferentialUnit: "CASE",
      replicateAggregation: "CASE_PRIMITIVES",
    },
    limitations: [
      "Lanes are reported independently; incompatible lanes are never averaged.",
    ],
  };
}

export const benchmarkImportedRuns = buildBenchmarkScorecard;
export { pairedBootstrapInterval } from "./confidence.mjs";
export { calculateLaneMetrics, calculateMetrics } from "./metrics.mjs";
export { normalizeBenchmarkInput } from "./normalize.mjs";
export { buildLanePairedComparison, buildPairedComparison } from "./paired.mjs";
export { computeParetoFrontier } from "./pareto.mjs";
export { normalizeLaneBundle, normalizeLaneBundles } from "../normalize/index.mjs";
export { evaluateLaneValidity, evaluateEvalValidity } from "../eval/index.mjs";
