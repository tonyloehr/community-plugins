import {
  isNonEmptyString,
  isNonNegativeInteger,
  isPlainObject,
} from "../benchmark/shared.mjs";
import { isClosedAdjudicationProtocolContract } from "../normalize/index.mjs";

function result(id, pass, reasonCode, details = undefined) {
  const check = {
    id,
    status: pass ? "PASS" : "UNKNOWN",
    reasonCode,
    evidenceStatus: pass ? "DECLARED" : "UNKNOWN",
  };
  if (details !== undefined) {
    check.details = details;
  }
  return check;
}

/**
 * Evaluate only declared adjudication evidence. A declaration is never
 * upgraded into observed proof by this offline engine.
 *
 * @param {Record<string, any> | null} protocol
 * @param {Record<string, any> | null} manifest
 * @returns {Record<string, any>}
 */
export function inspectAdjudicationProtocol(protocol, manifest) {
  if (!isPlainObject(protocol)) {
    const checks = [
      result("RO-EV-008", false, "MISSING_ADJUDICATION_PROTOCOL"),
      result("RO-EV-009", false, "MISSING_ADJUDICATION_PROTOCOL"),
    ];
    return {
      status: "INSUFFICIENT_EVIDENCE",
      checks,
      reasonCodes: checks.map((check) => check.reasonCode),
      blinding: "UNKNOWN",
      randomization: "UNKNOWN",
      highCriticalReview: "UNKNOWN",
      disagreement: "UNKNOWN",
      adjudicatorIndependence: "UNKNOWN",
    };
  }
  const declared = /** @type {any} */ (protocol);
  const closedContract = isClosedAdjudicationProtocolContract(declared);
  const laneMatches = declared.laneId === manifest?.lane?.laneId;
  const versionsMatch =
    declared.rubricId === manifest?.rubricId &&
    declared.labelVersion === manifest?.labelVersion;
  const blinded = declared.variantIdentity === "HIDDEN";
  const randomized = declared.presentationOrder === "RANDOMIZED";
  const human = declared.highCriticalReview === "HUMAN";
  const ruleEightPasses =
    closedContract && laneMatches && versionsMatch && blinded && randomized && human;
  const independence =
    closedContract &&
    isPlainObject(declared.adjudicatorIndependence) &&
    declared.adjudicatorIndependence.status === "DECLARED" &&
    declared.adjudicatorIndependence.evidenceStatus === "DECLARED" &&
    isNonEmptyString(declared.adjudicatorIndependence.provenanceId);
  const nestedDisagreement = declared.disagreement;
  const disagreement =
    closedContract &&
    ((isPlainObject(nestedDisagreement) &&
      isNonEmptyString(nestedDisagreement.policyId) &&
      isNonNegativeInteger(nestedDisagreement.count) &&
      nestedDisagreement.status === "COMPLETE") ||
      (isNonEmptyString(declared.disagreementPolicyId) &&
        isNonNegativeInteger(declared.disagreementCount) &&
        ["RESOLVED", "NONE"].includes(declared.disagreementStatus)));
  const checks = [
    result(
      "RO-EV-008",
      ruleEightPasses,
      ruleEightPasses
        ? "BLINDED_RANDOMIZED_HUMAN_ADJUDICATION_DECLARED"
        : "INCOMPLETE_BLINDING_OR_HIGH_CRITICAL_REVIEW",
      {
        laneMatches,
        closedContract,
        versionsMatch,
        blinded,
        randomized,
        human,
      },
    ),
    result(
      "RO-EV-009",
      independence && disagreement,
      independence && disagreement
        ? "INDEPENDENCE_AND_DISAGREEMENT_DECLARED"
        : "INCOMPLETE_INDEPENDENCE_OR_DISAGREEMENT_EVIDENCE",
      { independence, disagreement },
    ),
  ];
  return {
    status: checks.every((check) => check.status === "PASS")
      ? "COMPLETE"
      : "INSUFFICIENT_EVIDENCE",
    checks,
    reasonCodes: checks
      .filter((check) => check.status !== "PASS")
      .map((check) => check.reasonCode),
    blinding: blinded ? "DECLARED" : "UNKNOWN",
    randomization: randomized ? "DECLARED" : "UNKNOWN",
    highCriticalReview: human ? "DECLARED" : "UNKNOWN",
    disagreement: disagreement ? "DECLARED" : "UNKNOWN",
    adjudicatorIndependence: independence ? "DECLARED" : "UNKNOWN",
  };
}
