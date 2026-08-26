// @ts-check

import {
  compareText,
  isPlainObject,
  metricNumber,
  uniqueSortedStrings,
} from "../benchmark/shared.mjs";
import { evaluateRecommendationGates } from "./gates.mjs";

const RECOMMENDABLE_LANE_TYPES = new Set(["BEST_SYSTEM", "SHADOW_PILOT"]);
const SAFE_NO_CHANGE_REASON = "NO_ELIGIBLE_NON_BASELINE_ARCHITECTURE";

/** @param {unknown} value @returns {Record<string, any>[]} */
function records(value) {
  return Array.isArray(value) ? value.filter((item) => isPlainObject(item)) : [];
}

/** @param {unknown} value @returns {string[]} */
function strings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

/** @param {Record<string, any>} lane */
function laneId(lane) {
  return lane.laneId ?? lane.manifest?.lane?.laneId ?? lane.bundleId ?? "unknown-lane";
}

/** @param {Record<string, any>} lane */
function laneType(lane) {
  return lane.laneType ?? lane.manifest?.lane?.laneType ?? "PORTABLE_CORE_MODEL";
}

/** @param {Record<string, any>} lane */
function laneStatus(lane) {
  return typeof lane.status === "string" ? lane.status : "INSUFFICIENT_EVIDENCE";
}

/** @param {Record<string, any>} lane */
function laneAttribution(lane) {
  return typeof lane.attributionStatus === "string"
    ? lane.attributionStatus
    : "UNKNOWN";
}

/** @param {Record<string, any>} lane */
function laneBundleId(lane) {
  return typeof lane.bundleId === "string" ? lane.bundleId : null;
}

/** @param {Record<string, any>} lane */
function normalizedLaneId(lane) {
  return typeof lane.laneId === "string"
    ? lane.laneId
    : typeof lane.lane?.laneId === "string"
      ? lane.lane.laneId
      : null;
}

/**
 * Associate a scorecard lane with exactly one normalized lane. Public CLI
 * lanes always carry both IDs; the single-lane fallback keeps pure unit calls
 * useful without allowing multi-lane ambiguity.
 *
 * @param {Record<string, any>[]} normalizedLanes
 * @param {Record<string, any>} scorecardLane
 */
function normalizedForScorecardLane(normalizedLanes, scorecardLane) {
  const bundleId = laneBundleId(scorecardLane);
  const scorecardLaneId = laneId(scorecardLane);
  const matches = normalizedLanes.filter((lane) => {
    const sameBundle = bundleId === null || laneBundleId(lane) === bundleId;
    const sameLane = normalizedLaneId(lane) === scorecardLaneId;
    return sameBundle && sameLane;
  });
  if (matches.length === 1) {
    return matches[0];
  }
  if (
    normalizedLanes.length === 1 &&
    laneBundleId(normalizedLanes[0]) === null &&
    normalizedLaneId(normalizedLanes[0]) === null
  ) {
    return normalizedLanes[0];
  }
  return null;
}

/** @param {Record<string, any>} lane */
function baselineId(lane) {
  return (
    lane.baselineVariantId ??
    lane.manifest?.lane?.baselineVariantId ??
    lane.pairing?.baselineVariantId ??
    lane.comparisons?.[0]?.baselineVariantId ??
    null
  );
}

/** @param {Record<string, any>} lane */
function frontierPoints(lane) {
  const global = isPlainObject(lane.global) ? lane.global : {};
  const frontier = global.frontier ?? lane.frontier ?? lane.pareto;
  return Array.isArray(frontier) ? records(frontier) : records(frontier?.frontier);
}

/** @param {Record<string, any>} lane */
function variants(lane) {
  const global = isPlainObject(lane.global) ? lane.global : {};
  return records(global.variants ?? lane.variants);
}

/** @param {Record<string, any>} variant @param {string} metricId */
function variantMetric(variant, metricId) {
  const metrics = variant.metrics;
  if (Array.isArray(metrics)) {
    const metric = metrics.find((item) => item?.metricId === metricId);
    return metric && typeof metric.value === "number" ? metric.value : undefined;
  }
  const internalId =
    metricId === "latency_p95"
      ? "latencyP95"
      : metricId === "fully_loaded_cost_per_confirmed_high_critical_root_cause"
        ? "fullyLoadedCostPerConfirmedHighCriticalRootCause"
        : metricId;
  return metricNumber(metrics?.[internalId]);
}

/** @param {Record<string, any>} lane */
function candidateIds(lane) {
  const baseline = baselineId(lane);
  const frontier = frontierPoints(lane)
    .filter((point) => point.status === "NON_DOMINATED" || point.status === undefined)
    .map((point) => point.variantId)
    .filter((value) => typeof value === "string" && value !== baseline);
  return uniqueSortedStrings(frontier);
}

/**
 * A recommendation never invents a winner. If multiple non-dominated
 * candidates remain and policy declines automatic ties, the result is honest
 * insufficiency rather than an arbitrary default.
 *
 * @param {Record<string, any>} lane
 * @param {Record<string, any> | null} policy
 */
function chooseCandidate(lane, policy) {
  const ids = candidateIds(lane);
  if (ids.length === 0) {
    return null;
  }
  if (ids.length > 1 && policy?.tiePolicy === "NO_AUTOMATIC_WINNER") {
    return null;
  }
  const metricId =
    policy?.tiePolicy === "LOWEST_LATENCY"
      ? "latency_p95"
      : "fully_loaded_cost_per_confirmed_high_critical_root_cause";
  const byId = new Map(variants(lane).map((variant) => [variant.variantId, variant]));
  return [...ids].sort((left, right) => {
    const leftValue = variantMetric(byId.get(left) ?? {}, metricId);
    const rightValue = variantMetric(byId.get(right) ?? {}, metricId);
    if (typeof leftValue === "number" && typeof rightValue === "number") {
      return leftValue - rightValue || compareText(left, right);
    }
    if (typeof leftValue === "number") {
      return -1;
    }
    if (typeof rightValue === "number") {
      return 1;
    }
    return compareText(left, right);
  })[0];
}

/** @param {Record<string, any>} lane */
function publicLane(lane) {
  return {
    laneId: laneId(lane),
    laneType: laneType(lane),
    status: laneStatus(lane),
    attributionStatus: laneAttribution(lane),
    claimBoundary:
      typeof lane.claimBoundary === "string"
        ? lane.claimBoundary
        : "Lane evidence supports only the declared comparison scope.",
  };
}

/** @param {unknown} value */
function contracts(value) {
  if (!isPlainObject(value)) {
    return null;
  }
  const required = [
    "controllerContractId",
    "validatorContractId",
    "dedupePolicyId",
    "postingPolicyId",
  ];
  return required.every((key) => typeof value[key] === "string")
    ? Object.fromEntries(required.map((key) => [key, value[key]]))
    : null;
}

/**
 * Prefer the baseline contract set from a declared lane manifest. The
 * recommendation is deliberately unable to synthesize or relax it.
 *
 * @param {Record<string, any>[]} normalizedLanes
 * @param {Record<string, any> | null} scorecardLane
 * @param {unknown} supplied
 */
function preservedContracts(normalizedLanes, scorecardLane, supplied) {
  if (!scorecardLane) {
    return null;
  }
  const normalizedLane = normalizedForScorecardLane(normalizedLanes, scorecardLane);
  const declared = contracts(
    normalizedLane?.manifest?.productionBaselineContracts ??
      scorecardLane.productionBaselineContracts ??
      scorecardLane.preservedContracts,
  );
  const explicit = contracts(supplied);
  if (explicit && declared) {
    return stableEquivalent(explicit, declared) ? declared : null;
  }
  return declared;
}

/**
 * A variant is only recommendable when its source-neutral architecture
 * identity is declared. Never substitute a variant label for that identity.
 *
 * @param {Record<string, any>[]} normalizedLanes
 * @param {Record<string, any>} scorecardLane
 * @param {string | null} variantId
 */
function architectureReceiptForVariant(normalizedLanes, scorecardLane, variantId) {
  if (variantId === null) {
    return null;
  }
  const normalizedLane = normalizedForScorecardLane(normalizedLanes, scorecardLane);
  if (normalizedLane) {
    const candidates = records(
      normalizedLane.candidateConfigs ??
        normalizedLane.candidates ??
        normalizedLane.normalization?.candidateConfigs,
    );
    const candidate = candidates.find((item) => item.variantId === variantId);
    const runs = records(normalizedLane.runs).filter(
      (run) => run.variantId === variantId,
    );
    if (
      typeof candidate?.architectureId === "string" &&
      typeof candidate.architectureStructuralDigest === "string" &&
      runs.length > 0 &&
      runs.every(
        (run) =>
          run.architectureId === candidate.architectureId &&
          run.architectureStructuralDigest === candidate.architectureStructuralDigest,
      )
    ) {
      return {
        architectureId: candidate.architectureId,
        architectureStructuralDigest: candidate.architectureStructuralDigest,
      };
    }
    return null;
  }
  /*
   * Direct callers may pass a lane scorecard that already carries the
   * normalization-verified architecture receipt. Require the digest beside
   * the alias so an unverified display label never becomes a default.
   */
  const architecture = records(scorecardLane.architectures).find(
    (item) => item.variantId === variantId,
  );
  if (
    typeof architecture?.architectureId === "string" &&
    typeof architecture.architectureStructuralDigest === "string"
  ) {
    return {
      architectureId: architecture.architectureId,
      architectureStructuralDigest: architecture.architectureStructuralDigest,
    };
  }
  const variant = variants(scorecardLane).find((item) => item.variantId === variantId);
  if (
    typeof variant?.architectureId === "string" &&
    typeof variant.architectureStructuralDigest === "string"
  ) {
    return {
      architectureId: variant.architectureId,
      architectureStructuralDigest: variant.architectureStructuralDigest,
    };
  }
  return null;
}

/**
 * @param {Record<string, any>[]} normalizedLanes
 * @param {Record<string, any>} scorecardLane
 * @param {string | null} variantId
 */
function architectureForVariant(normalizedLanes, scorecardLane, variantId) {
  return (
    architectureReceiptForVariant(normalizedLanes, scorecardLane, variantId)
      ?.architectureId ?? null
  );
}

/** @param {unknown} left @param {unknown} right */
function stableEquivalent(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** @param {Record<string, any>} lane */
function compatibilityProjection(lane) {
  const manifest = isPlainObject(lane.manifest) ? lane.manifest : {};
  const laneContract = isPlainObject(manifest.lane) ? manifest.lane : {};
  const taxonomy = isPlainObject(manifest.sliceTaxonomy) ? manifest.sliceTaxonomy : {};
  const pricing = isPlainObject(lane.pricingSnapshot) ? lane.pricingSnapshot : {};
  return {
    rubricId: manifest.rubricId ?? null,
    labelVersion: manifest.labelVersion ?? null,
    corpusId: manifest.corpusId ?? null,
    cohortSelectionDigest: laneContract.cohortSelectionDigest ?? null,
    cohortWindowId: laneContract.cohortWindowId ?? null,
    caseIds: Array.isArray(manifest.caseIds) ? [...manifest.caseIds].sort() : null,
    sliceTaxonomy: {
      taxonomyId: taxonomy.taxonomyId ?? null,
      version: taxonomy.version ?? null,
      sliceIds: Array.isArray(taxonomy.sliceIds) ? [...taxonomy.sliceIds].sort() : null,
    },
    pricing: {
      snapshotId: pricing.snapshotId ?? manifest.pricingSnapshotId ?? null,
      currency: pricing.currency ?? null,
      costBasis: pricing.costBasis ?? null,
      effectiveAt: pricing.effectiveAt ?? null,
    },
    contracts: contracts(manifest.productionBaselineContracts),
  };
}

/**
 * Recommendation lanes may explain one another only when their public
 * provenance agrees. Any ambiguity stays lane-scoped and cannot produce a
 * combined architecture recommendation.
 *
 * @param {Record<string, any>[]} lanes
 * @param {Record<string, any>[]} normalizedLanes
 * @param {string | null} variantId
 */
function recommendationLaneCompatibility(lanes, normalizedLanes, variantId) {
  if (lanes.length <= 1) {
    if (
      lanes.length === 1 &&
      normalizedLanes.length > 0 &&
      normalizedForScorecardLane(normalizedLanes, lanes[0]) === null
    ) {
      return { status: "UNKNOWN", reasonCode: "MISSING_LANE_PROVENANCE" };
    }
    return { status: "PASS", reasonCode: "LANE_SCOPED_EVIDENCE" };
  }
  const normalized = lanes.map((lane) =>
    normalizedForScorecardLane(normalizedLanes, lane),
  );
  if (normalized.some((lane) => lane === null)) {
    return { status: "UNKNOWN", reasonCode: "MISSING_LANE_PROVENANCE" };
  }
  const first = /** @type {Record<string, any>} */ (normalized[0]);
  const projection = compatibilityProjection(first);
  for (const lane of normalized.slice(1)) {
    if (!stableEquivalent(projection, compatibilityProjection(lane))) {
      return {
        status: "UNKNOWN",
        reasonCode: "INCOMPATIBLE_RECOMMENDATION_LANES",
      };
    }
  }
  if (variantId !== null) {
    const receipts = lanes.map((lane) =>
      architectureReceiptForVariant(normalizedLanes, lane, variantId),
    );
    if (
      receipts.some((receipt) => receipt === null) ||
      new Set(receipts.map((receipt) => JSON.stringify(receipt))).size !== 1
    ) {
      return {
        status: "UNKNOWN",
        reasonCode: "INCOMPATIBLE_ARCHITECTURE_PROVENANCE",
      };
    }
  }
  return { status: "PASS", reasonCode: "RECOMMENDATION_LANES_COMPATIBLE" };
}

/** @param {Record<string, any>} gate */
function publicGate(gate) {
  return {
    gateId: typeof gate.id === "string" ? gate.id : "RO-GATE-UNKNOWN",
    status:
      gate.status === "PASS" ||
      gate.status === "FAIL" ||
      gate.status === "UNKNOWN" ||
      gate.status === "BLOCKED"
        ? gate.status
        : "UNKNOWN",
    reason:
      typeof gate.reasonCode === "string" ? gate.reasonCode : "MISSING_GATE_REASON",
  };
}

/**
 * @param {Record<string, any> | null} lane
 * @param {Record<string, any> | null} policy
 * @param {Record<string, any>[]} normalizedLanes
 * @param {boolean} allowArchitecture
 * @param {unknown} analysisAsOf
 */
function sliceRecommendations(
  lane,
  policy,
  normalizedLanes,
  allowArchitecture,
  analysisAsOf,
) {
  if (!lane || !policy || !Array.isArray(policy.decisionSliceIds)) {
    return [];
  }
  const byId = new Map(
    records(lane.slices)
      .filter((slice) => typeof slice.sliceId === "string")
      .map((slice) => [slice.sliceId, slice]),
  );
  const familySize = Math.max(1, policy.decisionSliceIds.length);
  const adjustedConfidence = 1 - (1 - Number(policy.confidenceLevel)) / familySize;
  const requiredIntervals = [
    "highCriticalRootCauseRecall",
    "criticalMissRate",
    "hallucinationRate",
    "actionablePrecision",
    "rootCauseQuality",
    "fullyLoadedCostPerConfirmedHighCriticalRootCause",
    "humanReviewMinutesPerCase",
    "costP95",
    "costP99",
    "latencyP95",
    "latencyP99",
  ];
  return uniqueSortedStrings(policy.decisionSliceIds).map((sliceId) => {
    const slice = byId.get(sliceId);
    if (!slice) {
      return {
        sliceId,
        status: "INSUFFICIENT_EVIDENCE",
        reasonCodes: ["MISSING_DECISION_SLICE_EVIDENCE"],
      };
    }
    const candidate = chooseCandidate(
      {
        baselineVariantId: baselineId(lane),
        global: {
          frontier: slice.frontier,
          variants: slice.variants,
        },
      },
      policy,
    );
    const comparison = records(slice.comparisons).find(
      (item) => item.candidateVariantId === candidate,
    );
    const multiplicity = isPlainObject(slice.multiplicity) ? slice.multiplicity : null;
    const intervalsAdjusted =
      multiplicity?.method === "HOLM_BONFERRONI" &&
      multiplicity.familySize === familySize &&
      typeof multiplicity.adjustedConfidenceLevel === "number" &&
      multiplicity.adjustedConfidenceLevel >= adjustedConfidence &&
      requiredIntervals.every((name) => {
        const interval = comparison?.metrics?.[name]?.interval;
        return (
          isPlainObject(interval) &&
          interval.status === "AVAILABLE" &&
          typeof interval.confidenceLevel === "number" &&
          interval.confidenceLevel >= adjustedConfidence
        );
      });
    const sliceLane = {
      ...lane,
      pairedCaseCount: slice.pairedCaseCount,
      global: {
        variants: slice.variants,
        comparisons: slice.comparisons,
        frontier: slice.frontier,
      },
    };
    const evaluation =
      allowArchitecture &&
      laneStatus(lane) === "COMPLETE" &&
      slice.status === "COMPLETE" &&
      slice.decisionEligible === true &&
      typeof candidate === "string" &&
      intervalsAdjusted
        ? evaluateRecommendationGates({
            scorecard: { lanes: [sliceLane] },
            decisionPolicy: policy,
            analysisAsOf,
            candidateLaneId: laneId(lane),
            candidateVariantId: candidate,
          })
        : null;
    const architectureId =
      typeof candidate === "string"
        ? architectureForVariant(normalizedLanes, lane, candidate)
        : null;
    const eligible =
      evaluation?.status === "RECOMMENDED_FOR_SHADOW" && architectureId !== null;
    const reasonCodes = uniqueSortedStrings([
      ...strings(slice.limitations),
      ...(allowArchitecture ? [] : ["GLOBAL_RECOMMENDATION_NOT_ELIGIBLE"]),
      ...(slice.decisionEligible === true ? [] : ["SLICE_NOT_DECISION_ELIGIBLE"]),
      ...(typeof candidate === "string"
        ? []
        : ["NO_ELIGIBLE_NON_BASELINE_ARCHITECTURE"]),
      ...(intervalsAdjusted ? [] : ["MISSING_HOLM_BONFERRONI_INTERVAL_EVIDENCE"]),
      ...(architectureId === null ? ["MISSING_ARCHITECTURE_MAPPING"] : []),
      ...(evaluation?.reasonCodes ?? []),
    ]);
    return {
      sliceId,
      status: eligible ? "COMPLETE" : "INSUFFICIENT_EVIDENCE",
      ...(eligible ? { architectureId } : {}),
      ...(reasonCodes.length > 0 ? { reasonCodes } : {}),
    };
  });
}

/**
 * Build a non-executable, shadow-only reference-architecture report from
 * already-computed lane evidence. It never changes controller, validator,
 * dedupe, posting, or provider state.
 *
 * @param {{
 *   scorecard?: unknown,
 *   scorecards?: unknown,
 *   normalizedLanes?: unknown,
 *   staticDiagnostics?: unknown,
 *   auditReport?: unknown,
 *   decisionPolicy?: unknown,
 *   analysisAsOf?: unknown,
 *   preservedContracts?: unknown
 * }} [options]
 */
export function recommendReferenceArchitecture({
  scorecard,
  scorecards,
  normalizedLanes,
  staticDiagnostics,
  auditReport,
  decisionPolicy,
  analysisAsOf,
  preservedContracts: suppliedContracts,
} = {}) {
  const scorecardLanes = Array.isArray(scorecards)
    ? scorecards.flatMap((item) =>
        records(isPlainObject(item) ? item.lanes : undefined),
      )
    : records(isPlainObject(scorecard) ? scorecard.lanes : undefined);
  const normalized = records(normalizedLanes);
  const policy = isPlainObject(decisionPolicy) ? decisionPolicy : null;
  const relevant = scorecardLanes.filter((lane) =>
    RECOMMENDABLE_LANE_TYPES.has(laneType(lane)),
  );
  const preliminaryEligible = relevant.filter(
    (lane) =>
      laneStatus(lane) === "COMPLETE" &&
      laneAttribution(lane) !== "CONFOUNDED" &&
      laneAttribution(lane) !== "UNKNOWN",
  );
  const candidateLane = [...preliminaryEligible].sort((left, right) => {
    const typeOrder = (lane) => (laneType(lane) === "SHADOW_PILOT" ? 1 : 0);
    return (
      typeOrder(left) - typeOrder(right) || compareText(laneId(left), laneId(right))
    );
  })[0];
  const candidate = candidateLane ? chooseCandidate(candidateLane, policy) : null;
  const evaluation = evaluateRecommendationGates({
    scorecards,
    scorecard,
    staticDiagnostics,
    auditReport,
    decisionPolicy: policy,
    analysisAsOf,
    candidateLaneId: candidateLane ? laneId(candidateLane) : undefined,
    candidateVariantId: candidate ?? undefined,
  });
  const compatibility = recommendationLaneCompatibility(
    preliminaryEligible,
    normalized,
    candidate,
  );
  const architectureId =
    candidateLane === undefined
      ? null
      : architectureForVariant(normalized, candidateLane, candidate);
  const preserved = preservedContracts(
    normalized,
    candidateLane ?? null,
    suppliedContracts,
  );
  const rationale = uniqueSortedStrings([
    ...evaluation.reasonCodes,
    ...(compatibility.status === "PASS" ? [] : [compatibility.reasonCode]),
    ...(relevant.length === 0 ? ["NO_RECOMMENDABLE_LANE"] : []),
    ...(candidateLane && candidate === null ? [SAFE_NO_CHANGE_REASON] : []),
    ...(candidate !== null && architectureId === null
      ? ["MISSING_ARCHITECTURE_MAPPING"]
      : []),
    ...(preserved === null ? ["MISSING_PRESERVED_BASELINE_CONTRACTS"] : []),
  ]);
  let recommendationStatus = evaluation.status;
  if (
    recommendationStatus === "RECOMMENDED_FOR_SHADOW" &&
    compatibility.status !== "PASS"
  ) {
    recommendationStatus = "INSUFFICIENT_EVIDENCE";
  }
  if (recommendationStatus === "RECOMMENDED_FOR_SHADOW" && relevant.length === 0) {
    recommendationStatus = "INSUFFICIENT_EVIDENCE";
  }
  if (recommendationStatus === "RECOMMENDED_FOR_SHADOW" && candidate === null) {
    recommendationStatus = "NO_CHANGE_RECOMMENDED";
  }
  if (recommendationStatus === "RECOMMENDED_FOR_SHADOW" && architectureId === null) {
    recommendationStatus = "INSUFFICIENT_EVIDENCE";
  }
  if (recommendationStatus === "RECOMMENDED_FOR_SHADOW" && preserved === null) {
    recommendationStatus = "INSUFFICIENT_EVIDENCE";
  }
  const recommended = recommendationStatus === "RECOMMENDED_FOR_SHADOW";
  return {
    recommendationStatus,
    decisionPolicyId: policy?.policyId ?? null,
    decisionPolicy: policy,
    gates: [
      ...evaluation.gates.map(publicGate),
      publicGate({
        id: "RO-GATE-LANE-COMPATIBILITY",
        status: compatibility.status,
        reasonCode: compatibility.reasonCode,
      }),
    ],
    lanes: scorecardLanes.map(publicLane),
    ...(recommended && architectureId ? { defaultArchitectureId: architectureId } : {}),
    perSliceArchitectures: sliceRecommendations(
      candidateLane ?? null,
      policy,
      normalized,
      recommended,
      analysisAsOf,
    ),
    preservedContracts: preserved,
    ...(recommended && policy
      ? {
          shadowPilot: {
            executionMode: "SHADOW_NO_POSTING",
            minimumCases: policy.minimumPairedCases,
            observationDays: policy.shadowObservationDays,
            humanApprovalRequired: true,
            rollbackCriticalMisses: policy.rollbackCriticalMisses,
          },
        }
      : {}),
    rationale:
      rationale.length > 0
        ? rationale
        : ["Evidence supports a shadow-only reference architecture."],
    limitations: [
      "Recommendation is descriptive only; it does not authorize posting or production changes.",
      "Controller, validator, dedupe, and posting contracts remain preserved.",
    ],
  };
}

export const buildReferenceArchitectureRecommendation = recommendReferenceArchitecture;
