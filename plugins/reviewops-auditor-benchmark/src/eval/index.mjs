import { buildLanePairedComparison } from "../benchmark/paired.mjs";
import {
  isNonEmptyString,
  isPlainObject,
  issue,
  uniqueSortedStrings,
} from "../benchmark/shared.mjs";
import {
  isClosedEvalProtocolContract,
  normalizeLaneBundle,
  normalizeLaneBundles,
} from "../normalize/index.mjs";
import { inspectAdjudicationProtocol } from "./adjudication.mjs";
import {
  deriveClaimBoundary,
  inspectLaneDifferences,
  isSupportedLaneType,
  productionContractDifferences,
} from "./lanes.mjs";

function check(id, status, reasonCode, details = undefined) {
  const result = { id, status, reasonCode };
  if (details !== undefined) {
    result.details = details;
  }
  return result;
}

/** @param {any} value @returns {any} */
function normalizedLane(value) {
  if (
    isPlainObject(value) &&
    Array.isArray(value.runs) &&
    value.caseLabelsById instanceof Map &&
    "rankingEligible" in value
  ) {
    return value;
  }
  return normalizeLaneBundle(value);
}

/** @param {any} protocol @param {any} lane @returns {any} */
function protocolPairingEvidence(protocol, lane) {
  if (!isPlainObject(protocol)) {
    return {
      status: "UNKNOWN",
      reasonCode: "MISSING_EVAL_PROTOCOL",
      details: {},
    };
  }
  const closedContract = isClosedEvalProtocolContract(protocol);
  const laneMatches = protocol.laneId === lane?.laneId;
  const intendedClaimByLane = {
    PORTABLE_CORE_MODEL: "MODEL_ONLY",
    HARNESS_ABLATION: "ONE_FACTOR",
    BEST_SYSTEM: "HOLISTIC_SYSTEM",
    SHADOW_PILOT: "SHADOW_NO_POSTING",
  };
  const protocolDeclared =
    closedContract &&
    protocol.schemaVersion === 1 &&
    isNonEmptyString(protocol.protocolId) &&
    isNonEmptyString(protocol.protocolVersion) &&
    isNonEmptyString(protocol.intendedClaim) &&
    isNonEmptyString(protocol.samplingFrame) &&
    isNonEmptyString(protocol.inclusionPolicyId) &&
    protocol.intendedClaim === intendedClaimByLane[lane?.laneType];
  const cohortMatches =
    protocol.cohortSelectionDigest === lane?.cohortSelectionDigest &&
    protocol.cohortWindowId === lane?.cohortWindowId;
  const assignmentDeclared =
    typeof protocol.assignmentMethod === "string" &&
    ["PAIRED_SAME_CASE", "RANDOMIZED_BLOCKED"].includes(protocol.assignmentMethod);
  const pairingDeclared =
    typeof protocol.pairingMethod === "string" &&
    ["CASE_VARIANT", "CASE_VARIANT_REPLICATE"].includes(protocol.pairingMethod);
  const aggregationMatches = protocol.replicateAggregation === "CASE_PRIMITIVES";
  const missingPolicyDeclared =
    typeof protocol.missingReplicatePolicy === "string" &&
    ["BLOCK", "SYMMETRIC_EXCLUDE_CASE"].includes(protocol.missingReplicatePolicy);
  const pass =
    protocolDeclared &&
    laneMatches &&
    cohortMatches &&
    assignmentDeclared &&
    pairingDeclared &&
    aggregationMatches &&
    missingPolicyDeclared;
  return {
    status: pass ? "PASS" : "UNKNOWN",
    reasonCode: pass
      ? "COHORT_ASSIGNMENT_AND_PAIRING_DECLARED"
      : "INCOMPLETE_COHORT_OR_PAIRING_EVIDENCE",
    details: {
      laneMatches,
      closedContract,
      protocolDeclared,
      cohortMatches,
      assignmentDeclared,
      pairingDeclared,
      aggregationMatches,
      missingPolicyDeclared,
    },
  };
}

/** @param {any} protocol @param {any} manifest @param {any} baseline @returns {any} */
function preservationEvidence(protocol, manifest, baseline) {
  const expected = manifest?.productionBaselineContracts;
  const actual = protocol?.preservationContracts;
  const productionFields = [
    "controllerContractId",
    "validatorContractId",
    "dedupePolicyId",
    "postingPolicyId",
  ];
  const candidateFields = [
    "toolContractId",
    "contextClass",
    "retryPolicyId",
    "timeoutPolicyId",
    "routingPolicyId",
  ];
  if (
    !isClosedEvalProtocolContract(protocol) ||
    !isPlainObject(expected) ||
    !isPlainObject(actual)
  ) {
    return {
      status: "UNKNOWN",
      reasonCode: "MISSING_PRESERVATION_CONTRACTS",
      fields: [...productionFields, ...candidateFields],
    };
  }
  const mismatched = productionFields.filter(
    (field) => actual[field] !== expected[field],
  );
  for (const field of candidateFields) {
    if (!isNonEmptyString(actual[field])) {
      mismatched.push(field);
    } else if (baseline && actual[field] !== baseline[field]) {
      mismatched.push(field);
    }
  }
  return {
    status: mismatched.length === 0 ? "PASS" : "UNKNOWN",
    reasonCode:
      mismatched.length === 0
        ? "PRODUCTION_CONTRACTS_DECLARED"
        : "PRESERVATION_CONTRACT_MISMATCH",
    fields: mismatched,
  };
}

/** @param {any} protocol @returns {any} */
function leakageEvidence(protocol) {
  if (!isPlainObject(protocol)) {
    return {
      status: "UNKNOWN",
      reasonCode: "MISSING_LEAKAGE_OR_EXCLUSION_EVIDENCE",
      details: {},
    };
  }
  const closedContract = isClosedEvalProtocolContract(protocol);
  const controls =
    closedContract &&
    Array.isArray(protocol.leakageControls) &&
    protocol.leakageControls.length > 0 &&
    protocol.leakageControls.every(
      (control) =>
        isPlainObject(control) &&
        control.status === "DECLARED" &&
        control.evidenceStatus === "DECLARED",
    );
  const evidence = controls;
  const uncontaminated = protocol.knownContamination === "NONE_DECLARED";
  const exclusionPolicy = isNonEmptyString(protocol.exclusionPolicyId);
  const pass = controls && evidence && uncontaminated && exclusionPolicy;
  return {
    status: pass ? "PASS" : "UNKNOWN",
    reasonCode: pass
      ? "LEAKAGE_AND_EXCLUSION_EVIDENCE_DECLARED"
      : "MISSING_LEAKAGE_OR_EXCLUSION_EVIDENCE",
    details: {
      closedContract,
      controls,
      evidence,
      uncontaminated,
      exclusionPolicy,
    },
  };
}

/** @param {any} normalized @returns {any} */
function runCandidateProvenance(normalized) {
  const runToCandidate = [
    "architectureId",
    "architectureStructuralDigest",
    "toolContractId",
    "controllerContractId",
    "validatorContractId",
    "dedupePolicyId",
    "postingPolicyId",
    "reasoningClass",
    "retryPolicyId",
    "timeoutPolicyId",
    "routingPolicyId",
  ];
  const mismatches = [];
  const missing = [];
  for (const run of normalized.runs ?? []) {
    const candidate = normalized.candidatesById?.get(run.variantId);
    if (!candidate) {
      missing.push(run.variantId);
      continue;
    }
    for (const field of runToCandidate) {
      if (!isNonEmptyString(run[field]) || !isNonEmptyString(candidate[field])) {
        missing.push(field);
      } else if (run[field] !== candidate[field]) {
        mismatches.push({ variantId: run.variantId, field });
      }
    }
  }
  return {
    status:
      mismatches.length > 0 ? "CONFOUNDED" : missing.length > 0 ? "UNKNOWN" : "PASS",
    mismatches,
    missing: uniqueSortedStrings(missing),
  };
}

/**
 * Evaluate one lane's declared causal validity from normalized in-memory
 * evidence. The engine reports declarations; it never claims to observe the
 * original private experiment.
 *
 * @param {any} input
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>}
 */
export function evaluateLaneValidity(input, options = {}) {
  const normalized = normalizedLane(input);
  if (normalized.status === "BLOCKED") {
    const errors = [
      ...(normalized.errors ?? []),
      issue("RO-EV-001", "Normalization or lane provenance is blocked."),
    ];
    return {
      schemaVersion: 1,
      status: "BLOCKED",
      laneId: normalized.laneId ?? null,
      laneType: normalized.laneType ?? null,
      attributionStatus: "UNKNOWN",
      claimBoundary: deriveClaimBoundary(normalized.laneType, "UNKNOWN"),
      eligibleForMetrics: false,
      eligibleForRecommendation: false,
      checks: [check("RO-EV-001", "BLOCKED", "NORMALIZATION_BLOCKED")],
      reasonCodes: uniqueSortedStrings(errors.map((entry) => entry.code)),
      errors,
      warnings: normalized.warnings ?? [],
      pairing: buildLanePairedComparison(normalized, options),
      heldConstantDimensions: [],
      intentionallyChangedDimensions: [],
      unexpectedDimensions: [],
      missingDimensions: [],
      candidateContractDifferences: [],
      productionBaselineContracts:
        normalized.manifest?.productionBaselineContracts ?? null,
      limitations: ["Normalization or provenance must be repaired first."],
      evidenceRequired: ["valid normalized lane bundle"],
    };
  }
  const lane = normalized.lane;
  const protocol = normalized.evalProtocol;
  const pairing = buildLanePairedComparison(normalized, {
    ...options,
    evalProtocol: protocol,
  });
  const differences = inspectLaneDifferences(normalized);
  const adjudication = inspectAdjudicationProtocol(
    normalized.adjudicationProtocol,
    normalized.manifest,
  );
  const checks = [];
  const lanePass =
    Boolean(lane) &&
    isSupportedLaneType(lane?.laneType) &&
    normalized.manifest?.lane?.laneId === normalized.laneId;
  checks.push(
    check(
      "RO-EV-001",
      lanePass ? "PASS" : "BLOCKED",
      lanePass ? "LANE_CONTRACT_VALID" : "INVALID_LANE_CONTRACT",
    ),
  );
  const pairingEvidence = protocolPairingEvidence(protocol, lane);
  const pairedPass =
    pairingEvidence.status === "PASS" &&
    pairing.status !== "BLOCKED" &&
    pairing.pairedCaseIds.length > 0 &&
    pairing.unsafeExclusions.length === 0;
  checks.push(
    check(
      "RO-EV-002",
      pairedPass ? "PASS" : "UNKNOWN",
      pairedPass ? "PAIRING_EVIDENCE_COMPATIBLE" : pairingEvidence.reasonCode,
      { ...pairingEvidence.details, pairedCaseCount: pairing.pairedCaseIds.length },
    ),
  );
  const differencePass = differences.status === "COMPLETE";
  const heldConstantContradictions = differences.intentionallyChangedDimensions.filter(
    (field) => protocol?.heldConstantFields?.includes(field),
  );
  const heldConstantDeclared =
    Array.isArray(protocol?.heldConstantFields) &&
    heldConstantContradictions.length === 0 &&
    differences.heldConstantDimensions.every((field) =>
      protocol.heldConstantFields.includes(field),
    );
  checks.push(
    check(
      "RO-EV-003",
      differencePass && heldConstantDeclared ? "PASS" : "UNKNOWN",
      differencePass && heldConstantDeclared
        ? "HELD_CONSTANT_DIMENSIONS_MATCH"
        : differences.status === "CONFOUNDED"
          ? "UNCONTROLLED_DIMENSION_DIFFERENCE"
          : "MISSING_HELD_CONSTANT_EVIDENCE",
      {
        heldConstantDimensions: differences.heldConstantDimensions,
        unexpectedDimensions: differences.unexpectedDimensions,
        missingDimensions: differences.missingDimensions,
        heldConstantContradictions,
      },
    ),
  );
  checks.push(
    check(
      "RO-EV-004",
      differencePass ? "PASS" : "UNKNOWN",
      differencePass
        ? "DIFFERENCE_AXES_DECLARED"
        : "INVALID_OR_UNDECLARED_DIFFERENCE_AXES",
      {
        intentionallyChangedDimensions: differences.intentionallyChangedDimensions,
      },
    ),
  );
  const ablationPass =
    lane?.laneType !== "HARNESS_ABLATION" || differences.status === "COMPLETE";
  checks.push(
    check(
      "RO-EV-005",
      ablationPass ? "PASS" : "UNKNOWN",
      ablationPass
        ? "ABLATION_AXIS_VALID_OR_NOT_APPLICABLE"
        : "HARNESS_ABLATION_NOT_SINGLE_FACTOR",
    ),
  );
  const preservation = preservationEvidence(
    protocol,
    normalized.manifest,
    normalized.candidatesById?.get(lane?.baselineVariantId),
  );
  checks.push(
    check("RO-EV-006", preservation.status, preservation.reasonCode, {
      mismatchedFields: preservation.fields,
    }),
  );
  const provenance = runCandidateProvenance(normalized);
  checks.push(
    check(
      "RO-EV-007",
      provenance.status === "PASS" ? "PASS" : "UNKNOWN",
      provenance.status === "PASS"
        ? "RUN_AND_CANDIDATE_CONTRACTS_MATCH"
        : provenance.status === "CONFOUNDED"
          ? "RUN_CANDIDATE_PROVENANCE_MISMATCH"
          : "MISSING_RUN_CANDIDATE_PROVENANCE",
      { mismatches: provenance.mismatches, missing: provenance.missing },
    ),
  );
  checks.push(...adjudication.checks);
  const leakage = leakageEvidence(protocol);
  checks.push(check("RO-EV-010", leakage.status, leakage.reasonCode, leakage.details));
  const shadowPass =
    lane?.laneType !== "SHADOW_PILOT" ||
    (isClosedEvalProtocolContract(protocol) &&
      lane.executionMode === "SHADOW_NO_POSTING" &&
      protocol?.expectedExecutionMode === "SHADOW_NO_POSTING");
  checks.push(
    check(
      "RO-EV-011",
      shadowPass ? "PASS" : "UNKNOWN",
      shadowPass
        ? "SHADOW_NO_POSTING_DECLARED_OR_NOT_APPLICABLE"
        : "SHADOW_NO_POSTING_NOT_DECLARED",
    ),
  );
  const blocked = checks.some((entry) => entry.status === "BLOCKED");
  const incomplete = checks.some((entry) => entry.status !== "PASS");
  let attributionStatus = differences.attributionStatus;
  if (differences.status === "CONFOUNDED" || provenance.status === "CONFOUNDED") {
    attributionStatus = "CONFOUNDED";
  } else if (incomplete) {
    attributionStatus = "UNKNOWN";
  }
  const status = blocked
    ? "BLOCKED"
    : incomplete
      ? "INSUFFICIENT_EVIDENCE"
      : "COMPLETE";
  const reasonCodes = uniqueSortedStrings(
    checks.filter((entry) => entry.status !== "PASS").map((entry) => entry.reasonCode),
  );
  const evidenceRequired = [];
  if (pairingEvidence.status !== "PASS") {
    evidenceRequired.push("compatible cohort, assignment, and pairing protocol");
  }
  if (differences.status !== "COMPLETE") {
    evidenceRequired.push("complete held-constant and declared difference axes");
  }
  if (adjudication.status !== "COMPLETE") {
    evidenceRequired.push("blinded randomized human high-critical adjudication");
  }
  if (leakage.status !== "PASS") {
    evidenceRequired.push("declared leakage controls and exclusion provenance");
  }
  return {
    schemaVersion: 1,
    status,
    laneId: lane?.laneId ?? null,
    laneType: lane?.laneType ?? null,
    attributionStatus,
    claimBoundary: deriveClaimBoundary(lane?.laneType, attributionStatus),
    eligibleForMetrics: status === "COMPLETE",
    eligibleForRecommendation: status === "COMPLETE",
    checks,
    reasonCodes,
    errors: blocked ? (normalized.errors ?? []) : [],
    warnings: [...(normalized.warnings ?? []), ...(pairing.warnings ?? [])],
    pairing,
    heldConstantDimensions: differences.heldConstantDimensions,
    intentionallyChangedDimensions: differences.intentionallyChangedDimensions,
    unexpectedDimensions: differences.unexpectedDimensions,
    missingDimensions: differences.missingDimensions,
    candidateDifferences: differences.candidateDifferences,
    candidateContractDifferences: productionContractDifferences(normalized),
    productionBaselineContracts:
      normalized.manifest?.productionBaselineContracts ?? null,
    blinding: adjudication.blinding,
    randomization: adjudication.randomization,
    highCriticalReview: adjudication.highCriticalReview,
    disagreement: adjudication.disagreement,
    adjudicatorIndependence: adjudication.adjudicatorIndependence,
    limitations:
      status === "COMPLETE"
        ? ["Declared evidence is not proof of private runtime behavior."]
        : ["Quality ranking is disabled until eval validity is complete."],
    evidenceRequired,
  };
}

/**
 * @param {any} input
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>}
 */
export function evaluateEvalValidity(input, options = {}) {
  const normalized =
    Array.isArray(input) || input?.laneBundles
      ? normalizeLaneBundles(input)
      : { lanes: [normalizedLane(input)] };
  const lanes = normalized.lanes.map((lane) => evaluateLaneValidity(lane, options));
  const status = lanes.some((lane) => lane.status === "BLOCKED")
    ? "BLOCKED"
    : lanes.every((lane) => lane.status === "COMPLETE")
      ? "COMPLETE"
      : "INSUFFICIENT_EVIDENCE";
  return {
    schemaVersion: 1,
    status,
    lanes,
    reasonCodes: uniqueSortedStrings(lanes.flatMap((lane) => lane.reasonCodes ?? [])),
    errors: lanes.flatMap((lane) => lane.errors ?? []),
    warnings: lanes.flatMap((lane) => lane.warnings ?? []),
  };
}

export const auditReviewEvalValidity = evaluateEvalValidity;
