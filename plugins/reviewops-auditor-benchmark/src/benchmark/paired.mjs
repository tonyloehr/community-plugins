import {
  compareText,
  isNonEmptyString,
  issue,
  stableSort,
  uniqueSortedStrings,
} from "./shared.mjs";
import { isClosedEvalProtocolContract, isOpaqueDigestId } from "../normalize/index.mjs";

const MAX_REPLICATES_PER_CASE_VARIANT = 32;

function valueSet(runs, selector) {
  return new Set(
    runs.map(selector).filter((value) => value !== null && value !== undefined),
  );
}

function addMismatchReason(reasons, runs, selector, code) {
  if (valueSet(runs, selector).size > 1) {
    reasons.push(code);
  }
}

function runPricingKey(run) {
  if (!run.cost) {
    return null;
  }
  return `${run.cost.currency}\u0000${run.cost.pricingSnapshotId}`;
}

function adjudicationKey(run) {
  if (!run.adjudication?.rubricId || !run.adjudication?.labelVersion) {
    return null;
  }
  return `${run.adjudication.rubricId}\u0000${run.adjudication.labelVersion}`;
}

/**
 * Build the common-case cohort used for every cross-variant claim. Missing or
 * mismatched cases are listed, never silently converted into failures.
 */
export function buildPairedComparison(normalized, options = {}) {
  if (!normalized || normalized.status === "BLOCKED") {
    return {
      status: "BLOCKED",
      errors: [
        issue("NORMALIZATION_BLOCKED", "Pairing requires valid normalized runs."),
      ],
      warnings: [],
      variantIds: [],
      baselineVariantId: null,
      pairedCaseIds: [],
      pairedCases: [],
      excludedCases: [],
      comparisons: [],
    };
  }

  const requestedVariantIds = Array.isArray(options.variantIds)
    ? uniqueSortedStrings(options.variantIds)
    : (normalized.variantIds ?? []);
  const variantIds =
    requestedVariantIds.length > 0
      ? requestedVariantIds
      : uniqueSortedStrings(normalized.runs.map((run) => run.variantId));
  const warnings = [];
  const errors = [];
  if (variantIds.length < 2) {
    warnings.push(
      issue(
        "INSUFFICIENT_VARIANTS",
        "Paired comparison requires at least two variants.",
      ),
    );
  }
  const baselineVariantId = isNonEmptyString(options.baselineVariantId)
    ? options.baselineVariantId
    : (variantIds[0] ?? null);
  if (baselineVariantId && !variantIds.includes(baselineVariantId)) {
    errors.push(
      issue(
        "UNKNOWN_BASELINE_VARIANT",
        "The requested baseline is not in the comparison set.",
      ),
    );
  }

  const explicitExclusions = new Set(
    Array.isArray(options.excludedCaseIds)
      ? options.excludedCaseIds.filter((caseId) => isNonEmptyString(caseId))
      : [],
  );
  const byCase = new Map();
  for (const run of normalized.runs) {
    if (!variantIds.includes(run.variantId)) {
      continue;
    }
    if (!byCase.has(run.caseId)) {
      byCase.set(run.caseId, new Map());
    }
    byCase.get(run.caseId).set(run.variantId, run);
  }

  const pairedCases = [];
  const excludedCases = [];
  const declaredCaseIds = Array.isArray(normalized.manifest?.caseIds)
    ? normalized.manifest.caseIds
    : [];
  const caseIds = uniqueSortedStrings([...byCase.keys(), ...declaredCaseIds]);
  for (const caseId of caseIds) {
    const runsByVariant = byCase.get(caseId) ?? new Map();
    const reasons = [];
    if (explicitExclusions.has(caseId)) {
      reasons.push("EXPLICIT_EXCLUSION");
    }
    const missingVariants = variantIds.filter(
      (variantId) => !runsByVariant.has(variantId),
    );
    if (missingVariants.length > 0) {
      reasons.push("MISSING_VARIANT_RUN");
    }
    const runs = variantIds
      .map((variantId) => runsByVariant.get(variantId))
      .filter(Boolean);
    addMismatchReason(
      reasons,
      runs,
      (run) => run.contextDigest,
      "CONTEXT_DIGEST_MISMATCH",
    );
    addMismatchReason(
      reasons,
      runs,
      (run) => run.toolContractId,
      "TOOL_CONTRACT_MISMATCH",
    );
    addMismatchReason(
      reasons,
      runs,
      adjudicationKey,
      "RUBRIC_OR_LABEL_VERSION_MISMATCH",
    );
    addMismatchReason(reasons, runs, runPricingKey, "PRICING_SEMANTICS_MISMATCH");
    if (reasons.length > 0) {
      excludedCases.push({
        caseId,
        reasonCodes: uniqueSortedStrings(reasons),
        missingVariantIds: missingVariants,
      });
      continue;
    }
    const orderedRuns = {};
    for (const variantId of variantIds) {
      orderedRuns[variantId] = runsByVariant.get(variantId);
    }
    pairedCases.push({ caseId, runsByVariant: orderedRuns });
  }

  for (const caseId of [...explicitExclusions].sort(compareText)) {
    if (!byCase.has(caseId)) {
      excludedCases.push({
        caseId,
        reasonCodes: ["EXPLICIT_EXCLUSION", "UNKNOWN_CASE_ID"],
        missingVariantIds: [],
      });
    }
  }

  const pairedCaseIds = pairedCases.map((item) => item.caseId);
  const comparisons = baselineVariantId
    ? variantIds
        .filter((variantId) => variantId !== baselineVariantId)
        .map((candidateVariantId) => ({
          baselineVariantId,
          candidateVariantId,
          pairedCaseIds: [...pairedCaseIds],
          pairedCaseCount: pairedCaseIds.length,
        }))
    : [];
  if (pairedCaseIds.length === 0) {
    warnings.push(
      issue("NO_PAIRED_CASES", "No comparable paired cases remain after exclusions."),
    );
  }
  return {
    status:
      errors.length > 0
        ? "BLOCKED"
        : pairedCaseIds.length === 0 || variantIds.length < 2
          ? "INSUFFICIENT_EVIDENCE"
          : excludedCases.length > 0 || warnings.length > 0
            ? "PARTIAL"
            : "COMPLETE",
    errors,
    warnings,
    variantIds,
    baselineVariantId,
    pairedCaseIds,
    pairedCases,
    excludedCases: stableSort(excludedCases, (item) => item.caseId),
    comparisons,
  };
}

export const pairComparableRuns = buildPairedComparison;

function declaredExclusionByCase(protocol) {
  const result = new Map();
  if (
    !isClosedEvalProtocolContract(protocol) ||
    protocol?.missingReplicatePolicy !== "SYMMETRIC_EXCLUDE_CASE" ||
    !Array.isArray(protocol?.predeclaredExclusions)
  ) {
    return result;
  }
  const exclusions = protocol.predeclaredExclusions;
  for (const entry of exclusions) {
    if (
      entry &&
      isNonEmptyString(entry.caseId) &&
      entry.symmetric === true &&
      isOpaqueDigestId(entry.provenanceDigest)
    ) {
      result.set(entry.caseId, entry);
    }
  }
  return result;
}

function laneRunPricingKey(run) {
  if (!run?.cost) {
    return null;
  }
  return [run.cost.currency, run.cost.pricingSnapshotId, run.cost.costBasis].join(
    "\u0000",
  );
}

function sameValue(runs, selector) {
  const values = valueSet(runs, selector);
  return values.size <= 1;
}

/**
 * Bound replicate fan-out before building nested case/variant maps. This is
 * deliberately linear in the supplied rows so malformed direct callers do
 * not reach the later variant-by-replicate loops.
 *
 * @param {Record<string, any>[]} runs
 * @returns {Record<string, unknown>[]}
 */
function replicateLimitErrors(runs) {
  const counts = new Map();
  const errors = [];
  for (const run of runs) {
    if (!isNonEmptyString(run?.caseId) || !isNonEmptyString(run?.variantId)) {
      continue;
    }
    const key = [run.caseId, run.variantId].join("\u0000");
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count === MAX_REPLICATES_PER_CASE_VARIANT + 1) {
      errors.push(
        issue(
          "REPLICATE_LIMIT_EXCEEDED",
          "A case and variant exceed the 32-replicate safety ceiling.",
          {
            caseId: run.caseId,
            variantId: run.variantId,
            limit: MAX_REPLICATES_PER_CASE_VARIANT,
          },
        ),
      );
    }
  }
  return errors;
}

/**
 * Pair normalized lane runs by case, variant, and replicate. Replicate rows
 * are never silently pooled or imputed: an unbalanced case is excluded and
 * remains visible in the report.
 *
 * @param {Record<string, any>} normalized
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>}
 */
export function buildLanePairedComparison(normalized, options = {}) {
  if (!normalized || normalized.status === "BLOCKED") {
    return {
      status: "BLOCKED",
      errors: [
        issue("NORMALIZATION_BLOCKED", "Lane pairing requires normalized input."),
      ],
      warnings: [],
      variantIds: [],
      baselineVariantId: null,
      pairedCaseIds: [],
      pairedCases: [],
      excludedCases: [],
      comparisons: [],
      unsafeExclusions: [],
    };
  }
  const variantIds =
    Array.isArray(options.variantIds) && options.variantIds.length > 0
      ? uniqueSortedStrings(options.variantIds)
      : Array.isArray(normalized.manifest?.variantIds)
        ? normalized.manifest.variantIds
        : uniqueSortedStrings((normalized.runs ?? []).map((run) => run.variantId));
  const baselineVariantId =
    options.baselineVariantId ??
    normalized.lane?.baselineVariantId ??
    normalized.manifest?.lane?.baselineVariantId ??
    variantIds[0] ??
    null;
  const errors = [];
  const warnings = [];
  if (variantIds.length < 2) {
    warnings.push(
      issue("INSUFFICIENT_VARIANTS", "Lane pairing requires at least two variants."),
    );
  }
  if (baselineVariantId && !variantIds.includes(baselineVariantId)) {
    errors.push(
      issue("UNKNOWN_BASELINE_VARIANT", "Lane baseline is not a declared variant."),
    );
  }
  errors.push(...replicateLimitErrors(normalized.runs ?? []));
  if (errors.length > 0) {
    return {
      status: "BLOCKED",
      errors,
      warnings,
      variantIds,
      baselineVariantId,
      pairedCaseIds: [],
      pairedCases: [],
      excludedCases: [],
      unsafeExclusions: [],
      comparisons: [],
    };
  }
  const declaredExclusions = declaredExclusionByCase(
    options.evalProtocol ?? normalized.evalProtocol,
  );
  const explicitExclusions = new Set(
    Array.isArray(options.excludedCaseIds)
      ? options.excludedCaseIds.filter(isNonEmptyString)
      : [],
  );
  const byCase = new Map();
  for (const run of normalized.runs ?? []) {
    if (!variantIds.includes(run.variantId)) {
      continue;
    }
    if (!byCase.has(run.caseId)) {
      byCase.set(run.caseId, new Map());
    }
    const byVariant = byCase.get(run.caseId);
    if (!byVariant.has(run.variantId)) {
      byVariant.set(run.variantId, new Map());
    }
    byVariant.get(run.variantId).set(run.replicateId ?? "replicate_001", run);
  }
  const declaredCaseIds = Array.isArray(normalized.manifest?.caseIds)
    ? normalized.manifest.caseIds
    : [];
  const caseIds = uniqueSortedStrings([...declaredCaseIds, ...byCase.keys()]);
  const pairedCases = [];
  const excludedCases = [];
  const unsafeExclusions = [];
  for (const caseId of caseIds) {
    const byVariant = byCase.get(caseId) ?? new Map();
    const reasons = [];
    const missingVariantIds = variantIds.filter(
      (variantId) => !byVariant.has(variantId),
    );
    if (missingVariantIds.length > 0) {
      reasons.push("MISSING_VARIANT_RUN");
    }
    const replicateIds = uniqueSortedStrings(
      variantIds.flatMap((variantId) => [...(byVariant.get(variantId)?.keys() ?? [])]),
    );
    const missingReplicates = [];
    for (const replicateId of replicateIds) {
      const missing = variantIds.filter(
        (variantId) => !byVariant.get(variantId)?.has(replicateId),
      );
      if (missing.length > 0) {
        missingReplicates.push({ replicateId, missingVariantIds: missing });
      }
    }
    if (replicateIds.length === 0 || missingReplicates.length > 0) {
      reasons.push("UNBALANCED_REPLICATES");
    }
    for (const replicateId of replicateIds) {
      const runs = variantIds
        .map((variantId) => byVariant.get(variantId)?.get(replicateId))
        .filter(Boolean);
      if (!sameValue(runs, (run) => run.contextDigest)) {
        reasons.push("CONTEXT_DIGEST_MISMATCH");
      }
      if (!sameValue(runs, laneRunPricingKey)) {
        reasons.push("PRICING_SEMANTICS_MISMATCH");
      }
      if (
        !sameValue(runs, (run) =>
          run.adjudication
            ? [run.adjudication.rubricId, run.adjudication.labelVersion].join("\u0000")
            : null,
        )
      ) {
        reasons.push("RUBRIC_OR_LABEL_VERSION_MISMATCH");
      }
    }
    const declared = declaredExclusions.get(caseId);
    if (explicitExclusions.has(caseId)) {
      reasons.push("EXPLICIT_EXCLUSION");
    }
    if (declared) {
      reasons.push("PREDECLARED_SYMMETRIC_EXCLUSION");
    }
    if (reasons.length > 0) {
      const safe =
        Boolean(declared) &&
        reasons.every((reason) =>
          [
            "PREDECLARED_SYMMETRIC_EXCLUSION",
            "MISSING_VARIANT_RUN",
            "UNBALANCED_REPLICATES",
          ].includes(reason),
        );
      const exclusion = {
        caseId,
        reasonCodes: uniqueSortedStrings(reasons),
        missingVariantIds,
        missingReplicates,
        symmetricDeclared: safe,
      };
      excludedCases.push(exclusion);
      if (!safe) {
        unsafeExclusions.push(exclusion);
      }
      continue;
    }
    const runsByVariant = {};
    for (const variantId of variantIds) {
      runsByVariant[variantId] = replicateIds.map((replicateId) =>
        byVariant.get(variantId).get(replicateId),
      );
    }
    pairedCases.push({ caseId, replicateIds, runsByVariant });
  }
  const pairedCaseIds = pairedCases.map((item) => item.caseId);
  const comparisons = baselineVariantId
    ? variantIds
        .filter((variantId) => variantId !== baselineVariantId)
        .map((candidateVariantId) => ({
          baselineVariantId,
          candidateVariantId,
          pairedCaseIds: [...pairedCaseIds],
          pairedCaseCount: pairedCaseIds.length,
        }))
    : [];
  if (pairedCaseIds.length === 0) {
    warnings.push(issue("NO_PAIRED_CASES", "No lane cases remain paired."));
  }
  if (unsafeExclusions.length > 0) {
    warnings.push(
      issue(
        "UNSAFE_COHORT_EXCLUSION",
        "Unpaired or mismatched cases lack symmetric exclusion provenance.",
      ),
    );
  }
  return {
    status:
      errors.length > 0
        ? "BLOCKED"
        : pairedCaseIds.length === 0 || variantIds.length < 2
          ? "INSUFFICIENT_EVIDENCE"
          : excludedCases.length > 0 || warnings.length > 0
            ? "PARTIAL"
            : "COMPLETE",
    errors,
    warnings,
    variantIds,
    baselineVariantId,
    pairedCaseIds,
    pairedCases,
    excludedCases: stableSort(excludedCases, (item) => item.caseId),
    unsafeExclusions: stableSort(unsafeExclusions, (item) => item.caseId),
    comparisons,
  };
}

export const pairLaneRuns = buildLanePairedComparison;
