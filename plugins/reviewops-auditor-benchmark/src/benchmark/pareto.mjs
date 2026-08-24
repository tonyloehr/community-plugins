import { compareText, isFiniteNumber, metricNumber, stableSort } from "./shared.mjs";

export const DEFAULT_FRONTIER_DIMENSIONS = Object.freeze([
  { metric: "highCriticalRootCauseRecall", direction: "MAXIMIZE" },
  { metric: "criticalMissRate", direction: "MINIMIZE" },
  { metric: "actionablePrecision", direction: "MAXIMIZE" },
  { metric: "hallucinationRate", direction: "MINIMIZE" },
  { metric: "rootCauseQuality", direction: "MAXIMIZE" },
  {
    metric: "fullyLoadedCostPerConfirmedHighCriticalRootCause",
    direction: "MINIMIZE",
  },
  { metric: "humanReviewMinutesPerCase", direction: "MINIMIZE" },
  { metric: "latencyP95", direction: "MINIMIZE" },
]);

const LEGACY_FRONTIER_DIMENSIONS = Object.freeze([
  { metric: "severityWeightedAcceptedRecall", direction: "MAXIMIZE" },
  { metric: "costPerReviewedCase", direction: "MINIMIZE" },
  { metric: "falsePositiveRate", direction: "MINIMIZE" },
  { metric: "latencyP95", direction: "MINIMIZE" },
]);

function normalizeDimensions(dimensions) {
  const source =
    Array.isArray(dimensions) && dimensions.length > 0
      ? dimensions
      : DEFAULT_FRONTIER_DIMENSIONS;
  return source
    .filter(
      (item) =>
        item &&
        typeof item.metric === "string" &&
        (item.direction === "MAXIMIZE" || item.direction === "MINIMIZE"),
    )
    .map((item) => ({ metric: item.metric, direction: item.direction }));
}

function defaultDimensionsFor(variants, dimensions) {
  if (dimensions !== DEFAULT_FRONTIER_DIMENSIONS) {
    return dimensions;
  }
  const hasLaneMetric = (Array.isArray(variants) ? variants : []).some(
    (variant) => variant?.metrics?.highCriticalRootCauseRecall,
  );
  return hasLaneMetric ? dimensions : LEGACY_FRONTIER_DIMENSIONS;
}

function valuesFor(variant, dimensions) {
  const values = {};
  const missing = [];
  for (const dimension of dimensions) {
    const value = metricNumber(variant.metrics?.[dimension.metric]);
    if (!isFiniteNumber(value)) {
      missing.push(dimension.metric);
    } else {
      values[dimension.metric] = value;
    }
  }
  return { values, missing };
}

function dominates(left, right, dimensions) {
  let strictlyBetter = false;
  for (const dimension of dimensions) {
    const leftValue = left.values[dimension.metric];
    const rightValue = right.values[dimension.metric];
    if (dimension.direction === "MAXIMIZE") {
      if (leftValue < rightValue) {
        return false;
      }
      if (leftValue > rightValue) {
        strictlyBetter = true;
      }
    } else {
      if (leftValue > rightValue) {
        return false;
      }
      if (leftValue < rightValue) {
        strictlyBetter = true;
      }
    }
  }
  return strictlyBetter;
}

/**
 * Return eligible frontier points, dominated points, and descriptive unknowns.
 * Missing dimensions never make a candidate look better.
 */
export function computeParetoFrontier(
  variants,
  dimensions = DEFAULT_FRONTIER_DIMENSIONS,
) {
  const selectedDimensions = normalizeDimensions(
    defaultDimensionsFor(variants, dimensions),
  );
  const ordered = stableSort(
    Array.isArray(variants) ? variants : [],
    (item) => item.variantId,
  );
  const eligible = [];
  const unknown = [];
  for (const variant of ordered) {
    if (!variant || typeof variant.variantId !== "string") {
      continue;
    }
    const resolved = valuesFor(variant, selectedDimensions);
    if (resolved.missing.length > 0) {
      unknown.push({
        variantId: variant.variantId,
        reasonCodes: ["MISSING_FRONTIER_DIMENSION"],
        missingDimensions: resolved.missing.sort(compareText),
      });
    } else {
      eligible.push({ variantId: variant.variantId, values: resolved.values });
    }
  }
  const frontier = [];
  const dominated = [];
  for (const candidate of eligible) {
    const dominators = eligible
      .filter((other) => other.variantId !== candidate.variantId)
      .filter((other) => dominates(other, candidate, selectedDimensions))
      .map((other) => other.variantId)
      .sort(compareText);
    if (dominators.length > 0) {
      dominated.push({
        variantId: candidate.variantId,
        dominatedBy: dominators,
        values: candidate.values,
      });
    } else {
      frontier.push({ variantId: candidate.variantId, values: candidate.values });
    }
  }
  return {
    status:
      frontier.length > 0
        ? unknown.length > 0
          ? "PARTIAL"
          : "COMPLETE"
        : "INSUFFICIENT_EVIDENCE",
    dimensions: selectedDimensions,
    frontier: stableSort(frontier, (item) => item.variantId),
    dominated: stableSort(dominated, (item) => item.variantId),
    unknown: stableSort(unknown, (item) => item.variantId),
  };
}

export const paretoFrontier = computeParetoFrontier;
