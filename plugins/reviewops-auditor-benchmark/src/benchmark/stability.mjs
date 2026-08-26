import {
  mean,
  metricUnavailable,
  metricValue,
  roundNumber,
  uniqueSortedStrings,
} from "./shared.mjs";

/** @param {Record<string, any>} run @returns {Set<string>} */
export function confirmedRootCauseSet(run) {
  const confirmed = new Set();
  for (const label of run?.adjudication?.findingLabels ?? []) {
    if (label.outcome !== "ACCEPTED") {
      continue;
    }
    for (const rootCauseId of label.matchedRootCauseIds ?? []) {
      confirmed.add(rootCauseId);
    }
  }
  return confirmed;
}

/**
 * @param {Set<string>} left
 * @param {Set<string>} right
 * @returns {number | null}
 */
function jaccard(left, right) {
  const union = new Set([...left, ...right]);
  if (union.size === 0) {
    return null;
  }
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) {
      intersection += 1;
    }
  }
  return roundNumber(intersection / union.size);
}

/**
 * Macro-average pairwise Jaccard over case-level replicate sets. Both-empty
 * pairs remain unavailable instead of being counted as perfect agreement.
 *
 * @param {Record<string, any>[]} pairedCases
 * @param {string} variantId
 * @returns {Record<string, any>}
 */
export function calculateFindingStability(pairedCases, variantId) {
  const totalCount = Array.isArray(pairedCases) ? pairedCases.length : 0;
  const caseScores = [];
  const exclusions = [];
  let replicatePairCount = 0;
  let unavailablePairCount = 0;
  for (const pairedCase of pairedCases ?? []) {
    const runs = pairedCase?.runsByVariant?.[variantId] ?? [];
    if (!Array.isArray(runs) || runs.length < 2) {
      exclusions.push({
        caseId: pairedCase.caseId,
        reasonCodes: ["MISSING_REPLICATES"],
      });
      continue;
    }
    const scores = [];
    for (let left = 0; left < runs.length; left += 1) {
      for (let right = left + 1; right < runs.length; right += 1) {
        const score = jaccard(
          confirmedRootCauseSet(runs[left]),
          confirmedRootCauseSet(runs[right]),
        );
        if (score === null) {
          unavailablePairCount += 1;
        } else {
          scores.push(score);
          replicatePairCount += 1;
        }
      }
    }
    if (scores.length > 0) {
      caseScores.push(mean(scores));
    } else {
      exclusions.push({
        caseId: pairedCase.caseId,
        reasonCodes: ["NO_STABILITY_PAIR_VALUES"],
      });
    }
  }
  const missingness = {
    count: exclusions.length,
    reasonCodes: uniqueSortedStrings(
      exclusions.flatMap((exclusion) => exclusion.reasonCodes),
    ),
  };
  if (caseScores.length === 0) {
    return metricUnavailable(["INSUFFICIENT_REPLICATES"], {
      eligibleCount: 0,
      totalCount,
      replicatePairCount,
      unavailablePairCount,
      missingness,
      exclusions,
    });
  }
  return metricValue({
    value: mean(caseScores),
    numerator: caseScores.reduce((total, score) => total + score, 0),
    denominator: caseScores.length,
    eligibleCount: caseScores.length,
    totalCount,
    reasonCodes: caseScores.length < totalCount ? ["MISSING_STABILITY_EVIDENCE"] : [],
    replicatePairCount,
    unavailablePairCount,
    missingness,
    exclusions,
  });
}

export const findingStability = calculateFindingStability;
