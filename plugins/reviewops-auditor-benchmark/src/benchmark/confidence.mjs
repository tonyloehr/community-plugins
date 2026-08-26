import {
  isFiniteNumber,
  isNonNegativeInteger,
  mean,
  quantile,
  roundNumber,
} from "./shared.mjs";

/** @param {unknown} seed @returns {number} */
function seedToUint32(seed) {
  const text = String(seed);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** @param {unknown} seed @returns {() => number} */
function createRandom(seed) {
  let state = seedToUint32(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * @param {string} reasonCode
 * @param {Record<string, any>} options
 * @returns {Record<string, any>}
 */
function unavailable(reasonCode, options) {
  return {
    status: "UNAVAILABLE",
    method: "PAIRED_BOOTSTRAP_PERCENTILE",
    estimate: null,
    lower: null,
    upper: null,
    sampleSize: 0,
    confidenceLevel: options.confidenceLevel ?? null,
    iterations: options.iterations ?? null,
    seed: options.seed ?? null,
    reasonCodes: [reasonCode],
  };
}

/**
 * Fixed-seed paired percentile bootstrap over already paired deltas.
 * The default statistic is a mean because every caller supplies per-case
 * deltas; no ambient randomness or wall clock enters the result.
 */
/**
 * @param {unknown} values
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>}
 */
export function pairedBootstrapInterval(values, options = {}) {
  const confidenceLevel = options.confidenceLevel ?? 0.95;
  const iterations = options.iterations ?? 10_000;
  const seed = options.seed ?? "reviewops-v1";
  if (!Array.isArray(values) || values.length === 0) {
    return unavailable("NO_PAIRED_VALUES", { confidenceLevel, iterations, seed });
  }
  if (
    values.some((value) => !isFiniteNumber(value)) ||
    !isFiniteNumber(confidenceLevel) ||
    confidenceLevel <= 0 ||
    confidenceLevel >= 1 ||
    !isNonNegativeInteger(iterations) ||
    iterations < 1 ||
    iterations > 100_000
  ) {
    return unavailable("INVALID_BOOTSTRAP_INPUT", {
      confidenceLevel,
      iterations,
      seed,
    });
  }
  const statistic = typeof options.statistic === "function" ? options.statistic : mean;
  const estimate = statistic(values);
  if (!isFiniteNumber(estimate)) {
    return unavailable("INVALID_BOOTSTRAP_STATISTIC", {
      confidenceLevel,
      iterations,
      seed,
    });
  }
  const random = createRandom(seed);
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const resample = [];
    for (let index = 0; index < values.length; index += 1) {
      resample.push(values[Math.floor(random() * values.length)]);
    }
    const sample = statistic(resample);
    if (!isFiniteNumber(sample)) {
      return unavailable("INVALID_BOOTSTRAP_STATISTIC", {
        confidenceLevel,
        iterations,
        seed,
      });
    }
    samples.push(sample);
  }
  const alpha = 1 - confidenceLevel;
  return {
    status: "AVAILABLE",
    method: "PAIRED_BOOTSTRAP_PERCENTILE",
    estimate: roundNumber(estimate),
    lower: quantile(samples, alpha / 2),
    upper: quantile(samples, 1 - alpha / 2),
    sampleSize: values.length,
    confidenceLevel,
    iterations,
    seed: String(seed),
    reasonCodes: [],
  };
}

export const bootstrapPairedMeanInterval = pairedBootstrapInterval;

/**
 * Fixed-seed paired percentile bootstrap for case-level primitives. Callers
 * supply a pure statistic so pooled ratios and tail quantiles are recomputed
 * for every case resample instead of averaging replicate rows.
 *
 * @param {unknown} cases
 * @param {(sample: any[]) => number | undefined | null} statistic
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>}
 */
export function pairedBootstrapStatisticInterval(cases, statistic, options = {}) {
  const confidenceLevel = options.confidenceLevel ?? 0.95;
  const iterations = options.iterations ?? 10_000;
  const seed = options.seed ?? "reviewops-v1";
  if (!Array.isArray(cases) || cases.length === 0 || typeof statistic !== "function") {
    return unavailable("NO_PAIRED_VALUES", { confidenceLevel, iterations, seed });
  }
  if (
    !isFiniteNumber(confidenceLevel) ||
    confidenceLevel <= 0 ||
    confidenceLevel >= 1 ||
    !isNonNegativeInteger(iterations) ||
    iterations < 1 ||
    iterations > 100_000
  ) {
    return unavailable("INVALID_BOOTSTRAP_INPUT", {
      confidenceLevel,
      iterations,
      seed,
    });
  }
  const estimate = statistic(cases);
  if (!isFiniteNumber(estimate)) {
    return unavailable("INVALID_BOOTSTRAP_STATISTIC", {
      confidenceLevel,
      iterations,
      seed,
    });
  }
  const random = createRandom(seed);
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const resample = [];
    for (let index = 0; index < cases.length; index += 1) {
      resample.push(cases[Math.floor(random() * cases.length)]);
    }
    const sample = statistic(resample);
    if (!isFiniteNumber(sample)) {
      return unavailable("INVALID_BOOTSTRAP_STATISTIC", {
        confidenceLevel,
        iterations,
        seed,
      });
    }
    samples.push(sample);
  }
  const alpha = 1 - confidenceLevel;
  return {
    status: "AVAILABLE",
    method: "PAIRED_BOOTSTRAP_PERCENTILE",
    estimate: roundNumber(estimate),
    lower: quantile(samples, alpha / 2),
    upper: quantile(samples, 1 - alpha / 2),
    sampleSize: cases.length,
    confidenceLevel,
    iterations,
    seed: String(seed),
    reasonCodes: [],
  };
}

export const bootstrapPairedCaseStatisticInterval = pairedBootstrapStatisticInterval;
