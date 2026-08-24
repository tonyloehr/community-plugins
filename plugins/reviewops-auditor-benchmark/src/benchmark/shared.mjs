/**
 * Small deterministic helpers shared by the offline benchmark modules.
 * Nothing in this file reads ambient state or executes user-controlled code.
 */

export const METRIC_STATUS = Object.freeze({
  AVAILABLE: "AVAILABLE",
  PARTIAL: "PARTIAL",
  UNAVAILABLE: "UNAVAILABLE",
});

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** @param {unknown} value @returns {value is string} */
export function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/** @param {unknown} value @returns {value is number} */
export function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** @param {unknown} value @returns {value is number} */
export function isNonNegativeNumber(value) {
  return isFiniteNumber(value) && value >= 0;
}

/** @param {unknown} value @returns {value is number} */
export function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** @param {unknown} left @param {unknown} right @returns {number} */
export function compareText(left, right) {
  const leftText = String(left);
  const rightText = String(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

/**
 * @template T
 * @param {readonly T[]} values
 * @param {(value: T) => unknown} [selector]
 * @returns {T[]}
 */
export function stableSort(values, selector = (value) => value) {
  return [...values].sort((left, right) =>
    compareText(selector(left), selector(right)),
  );
}

/** @param {unknown} values @returns {string[]} */
export function uniqueSortedStrings(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return stableSort([...new Set(values.filter((value) => isNonEmptyString(value)))]);
}

/**
 * @param {string} code
 * @param {string} message
 * @param {unknown} [details]
 * @returns {Record<string, unknown>}
 */
export function issue(code, message, details = undefined) {
  /** @type {Record<string, unknown>} */
  const result = { code, message };
  if (details !== undefined) {
    result.details = details;
  }
  return result;
}

/** @param {number} value @param {number} [digits] @returns {number} */
export function roundNumber(value, digits = 12) {
  if (!isFiniteNumber(value)) {
    return value;
  }
  const rounded = Number(value.toFixed(digits));
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** @param {number[]} values @returns {number} */
export function sum(values) {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return roundNumber(total);
}

/** @param {number[]} values @returns {number | undefined} */
export function mean(values) {
  return values.length === 0 ? undefined : roundNumber(sum(values) / values.length);
}

/**
 * Deterministic linear-interpolation quantile. Callers must provide finite
 * values; an empty input intentionally stays unavailable.
 */
/** @param {number[]} values @param {number} probability @returns {number | undefined} */
export function quantile(values, probability) {
  if (values.length === 0 || !isFiniteNumber(probability)) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 1) {
    return roundNumber(sorted[0]);
  }
  const bounded = Math.min(1, Math.max(0, probability));
  const position = (sorted.length - 1) * bounded;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) {
    return roundNumber(sorted[lowerIndex]);
  }
  const fraction = position - lowerIndex;
  return roundNumber(
    sorted[lowerIndex] + (sorted[upperIndex] - sorted[lowerIndex]) * fraction,
  );
}

/**
 * @param {unknown} reasonCodes
 * @param {Record<string, unknown>} [extras]
 * @returns {Record<string, unknown>}
 */
export function metricUnavailable(reasonCodes, extras = {}) {
  return {
    status: METRIC_STATUS.UNAVAILABLE,
    value: null,
    numerator: null,
    denominator: null,
    coverage: 0,
    reasonCodes: uniqueSortedStrings(reasonCodes),
    ...extras,
  };
}

/**
 * @param {{
 *   value: number,
 *   numerator?: number | null,
 *   denominator?: number | null,
 *   eligibleCount: number,
 *   totalCount: number,
 *   reasonCodes?: string[],
 *   [key: string]: unknown
 * }} input
 * @returns {Record<string, unknown>}
 */
export function metricValue({
  value,
  numerator = null,
  denominator = null,
  eligibleCount,
  totalCount,
  reasonCodes = [],
  ...extras
}) {
  if (!isFiniteNumber(value) || totalCount <= 0 || eligibleCount <= 0) {
    return metricUnavailable(
      reasonCodes.length > 0 ? reasonCodes : ["NO_ELIGIBLE_CASES"],
      extras,
    );
  }
  const coverage = totalCount > 0 ? roundNumber(eligibleCount / totalCount) : 0;
  return {
    status:
      eligibleCount === totalCount && totalCount > 0
        ? METRIC_STATUS.AVAILABLE
        : METRIC_STATUS.PARTIAL,
    value: roundNumber(value),
    numerator: isFiniteNumber(numerator) ? roundNumber(numerator) : numerator,
    denominator: isFiniteNumber(denominator) ? roundNumber(denominator) : denominator,
    coverage,
    reasonCodes: uniqueSortedStrings(reasonCodes),
    ...extras,
  };
}

/** @param {unknown} metric @returns {number | undefined} */
export function metricNumber(metric) {
  if (!isPlainObject(metric)) {
    return undefined;
  }
  if (
    metric.status !== METRIC_STATUS.AVAILABLE &&
    metric.status !== METRIC_STATUS.PARTIAL
  ) {
    return undefined;
  }
  return isFiniteNumber(metric.value) ? metric.value : undefined;
}

/** @param {unknown} value @returns {number | undefined} */
export function parseUtcTimestamp(value) {
  if (!isNonEmptyString(value) || !value.endsWith("Z")) {
    return undefined;
  }
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) ? epochMs : undefined;
}

/** @param {unknown} later @param {unknown} earlier @returns {number | undefined} */
export function daysBetween(later, earlier) {
  const laterMs = parseUtcTimestamp(later);
  const earlierMs = parseUtcTimestamp(earlier);
  if (laterMs === undefined || earlierMs === undefined) {
    return undefined;
  }
  return roundNumber((laterMs - earlierMs) / 86_400_000);
}
