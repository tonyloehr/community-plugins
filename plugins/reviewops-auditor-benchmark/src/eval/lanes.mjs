import {
  compareText,
  isNonEmptyString,
  isPlainObject,
  uniqueSortedStrings,
} from "../benchmark/shared.mjs";

export const LANE_TYPES = Object.freeze([
  "PORTABLE_CORE_MODEL",
  "HARNESS_ABLATION",
  "BEST_SYSTEM",
  "SHADOW_PILOT",
]);

export const CANDIDATE_DIMENSIONS = Object.freeze([
  "modelAlias",
  "reasoningClass",
  "promptStructuralDigest",
  "configStructuralDigest",
  "contextClass",
  "toolContractId",
  "controllerContractId",
  "validatorContractId",
  "dedupePolicyId",
  "postingPolicyId",
  "retryPolicyId",
  "timeoutPolicyId",
  "routingPolicyId",
]);

const HARNESS_AXES = new Set([
  "promptStructuralDigest",
  "configStructuralDigest",
  "contextClass",
  "toolContractId",
  "controllerContractId",
  "validatorContractId",
  "dedupePolicyId",
  "postingPolicyId",
  "retryPolicyId",
  "timeoutPolicyId",
  "routingPolicyId",
]);

/** @param {any} laneType @returns {boolean} */
export function isSupportedLaneType(laneType) {
  return LANE_TYPES.includes(laneType);
}

/**
 * @param {unknown} laneType
 * @param {unknown} attributionStatus
 * @returns {string}
 */
export function deriveClaimBoundary(laneType, attributionStatus) {
  if (attributionStatus === "CONFOUNDED" || attributionStatus === "UNKNOWN") {
    return "Descriptive only; causal or architecture ranking is not supported.";
  }
  switch (laneType) {
    case "PORTABLE_CORE_MODEL":
      return "Model comparison under equal declared conditions.";
    case "HARNESS_ABLATION":
      return "Single declared workflow-component effect under equal declared conditions.";
    case "BEST_SYSTEM":
      return "Holistic system comparison; no component or model causality.";
    case "SHADOW_PILOT":
      return "Prospective shadow comparison only; no posting or writeback.";
    default:
      return "Descriptive only; unsupported lane evidence.";
  }
}

/**
 * Compare each candidate with the declared baseline without inferring
 * treatment axes from names or provider identity.
 *
 * @param {Record<string, any>} normalized
 * @returns {Record<string, any>}
 */
export function inspectLaneDifferences(normalized) {
  const lane = normalized?.lane ?? normalized?.manifest?.lane ?? null;
  const candidates = Array.isArray(normalized?.candidateConfigs)
    ? normalized.candidateConfigs
    : [];
  const baseline = candidates.find(
    (candidate) => candidate.variantId === lane?.baselineVariantId,
  );
  const missingDimensions = [];
  if (!lane || !baseline) {
    return {
      status: "UNKNOWN",
      baselineVariantId: lane?.baselineVariantId ?? null,
      heldConstantDimensions: [],
      intentionallyChangedDimensions: [],
      unexpectedDimensions: [],
      missingDimensions: ["baselineCandidateConfig"],
      candidateDifferences: [],
      attributionStatus: "UNKNOWN",
    };
  }
  const allowed = new Set(
    Array.isArray(lane.allowedDifferenceAxes) ? lane.allowedDifferenceAxes : [],
  );
  const candidateDifferences = [];
  const allChanged = new Set();
  for (const candidate of candidates) {
    if (candidate.variantId === baseline.variantId) {
      continue;
    }
    const changed = [];
    const missing = [];
    for (const field of CANDIDATE_DIMENSIONS) {
      if (!isNonEmptyString(candidate[field]) || !isNonEmptyString(baseline[field])) {
        missing.push(field);
      } else if (candidate[field] !== baseline[field]) {
        changed.push(field);
        allChanged.add(field);
      }
    }
    candidateDifferences.push({
      variantId: candidate.variantId,
      changedDimensions: changed.sort(compareText),
      missingDimensions: missing.sort(compareText),
    });
    missingDimensions.push(...missing);
  }
  const changedDimensions = [...allChanged].sort(compareText);
  const unexpectedDimensions = changedDimensions
    .filter((field) => !allowed.has(field))
    .sort(compareText);
  const heldConstantDimensions = CANDIDATE_DIMENSIONS.filter(
    (field) => !allChanged.has(field),
  ).sort(compareText);
  const intentionallyChangedDimensions = changedDimensions.filter((field) =>
    allowed.has(field),
  );
  const missing = uniqueSortedStrings(missingDimensions);
  let status = "COMPLETE";
  let attributionStatus = "UNKNOWN";
  if (!isSupportedLaneType(lane.laneType)) {
    status = "UNKNOWN";
  } else if (missing.length > 0) {
    status = "UNKNOWN";
  } else if (unexpectedDimensions.length > 0) {
    status = "CONFOUNDED";
    attributionStatus = "CONFOUNDED";
  } else if (lane.laneType === "PORTABLE_CORE_MODEL") {
    const onlyModelAxis =
      allowed.size === 1 &&
      allowed.has("modelAlias") &&
      changedDimensions.length === 1 &&
      changedDimensions[0] === "modelAlias";
    status = onlyModelAxis ? "COMPLETE" : "CONFOUNDED";
    attributionStatus = onlyModelAxis ? "SINGLE_FACTOR" : "CONFOUNDED";
  } else if (lane.laneType === "HARNESS_ABLATION") {
    const axis = [...allowed][0];
    const oneHarnessAxis =
      allowed.size === 1 &&
      HARNESS_AXES.has(axis) &&
      changedDimensions.length === 1 &&
      changedDimensions[0] === axis;
    status = oneHarnessAxis ? "COMPLETE" : "CONFOUNDED";
    attributionStatus = oneHarnessAxis ? "SINGLE_FACTOR" : "CONFOUNDED";
  } else {
    const declared = changedDimensions.every((field) => allowed.has(field));
    status = declared ? "COMPLETE" : "CONFOUNDED";
    attributionStatus = declared ? "HOLISTIC_VARIANT" : "CONFOUNDED";
  }
  return {
    status,
    baselineVariantId: baseline.variantId,
    heldConstantDimensions,
    intentionallyChangedDimensions,
    unexpectedDimensions,
    missingDimensions: missing,
    candidateDifferences,
    attributionStatus,
  };
}

/**
 * Compare evaluated candidate contracts with the production baseline contract
 * metadata. This is descriptive evidence for a shadow plan, not permission.
 *
 * @param {Record<string, any>} normalized
 * @returns {Record<string, any>[]}
 */
export function productionContractDifferences(normalized) {
  const production = normalized?.manifest?.productionBaselineContracts;
  if (!isPlainObject(production)) {
    return [];
  }
  const fields = [
    "controllerContractId",
    "validatorContractId",
    "dedupePolicyId",
    "postingPolicyId",
  ];
  return (normalized?.candidateConfigs ?? [])
    .map((candidate) => ({
      variantId: candidate.variantId,
      differences: fields
        .filter(
          (field) =>
            isNonEmptyString(candidate[field]) &&
            isNonEmptyString(production[field]) &&
            candidate[field] !== production[field],
        )
        .sort(compareText),
    }))
    .sort((left, right) => compareText(left.variantId, right.variantId));
}
