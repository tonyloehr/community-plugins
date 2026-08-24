import {
  compareText,
  isFiniteNumber,
  isNonEmptyString,
  isNonNegativeInteger,
  isNonNegativeNumber,
  isPlainObject,
  issue,
  parseUtcTimestamp,
  roundNumber,
  stableSort,
  uniqueSortedStrings,
} from "./shared.mjs";

/** @type {Set<unknown>} */
const SEVERITIES = new Set(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);
/** @type {Set<unknown>} */
const OUTCOMES = new Set(["ACCEPTED", "REJECTED", "UNKNOWN"]);
/** @type {Set<unknown>} */
const VERIFICATIONS = new Set(["VERIFIED", "UNVERIFIED", "UNKNOWN"]);
/** @type {Set<unknown>} */
const ADJUDICATION_STATUSES = new Set(["ADJUDICATED", "PARTIAL", "UNADJUDICATED"]);

/** @param {any} value @param {string} code @param {any[]} errors @returns {string | null} */
function requiredString(value, code, errors) {
  if (!isNonEmptyString(value)) {
    errors.push(issue(code, "A required opaque identifier is missing or invalid."));
    return null;
  }
  return value;
}

/** @param {any} value @param {string} code @param {any[]} errors @returns {string[]} */
function normalizeTags(value, code, errors) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((tag) => !isNonEmptyString(tag))) {
    errors.push(issue(code, "Tags must be an array of non-empty strings."));
    return [];
  }
  return uniqueSortedStrings(value);
}

/** @param {any} value @param {any[]} errors @returns {any} */
function normalizeUsage(value, errors) {
  if (value === undefined) {
    return null;
  }
  if (!isPlainObject(value)) {
    errors.push(issue("INVALID_USAGE", "Run usage must be an object."));
    return null;
  }
  const fields = ["inputTokens", "outputTokens", "cachedInputTokens"];
  /** @type {Record<string, number>} */
  const result = {};
  for (const field of fields) {
    if (!isNonNegativeInteger(value[field])) {
      errors.push(
        issue("INVALID_USAGE", "Run token counts must be non-negative safe integers."),
      );
      return null;
    }
    result[field] = value[field];
  }
  if (result.cachedInputTokens > result.inputTokens) {
    errors.push(
      issue("INVALID_USAGE", "Cached input tokens cannot exceed input tokens."),
    );
    return null;
  }
  return result;
}

/** @param {any} value @param {any[]} errors @returns {any} */
function normalizeCost(value, errors) {
  if (value === undefined) {
    return null;
  }
  if (!isPlainObject(value)) {
    errors.push(issue("INVALID_COST", "Run cost must be an object."));
    return null;
  }
  if (
    !isNonEmptyString(value.currency) ||
    !isNonNegativeNumber(value.amount) ||
    !isNonEmptyString(value.pricingSnapshotId)
  ) {
    errors.push(
      issue(
        "INVALID_COST",
        "Run cost is missing currency, amount, or snapshot identity.",
      ),
    );
    return null;
  }
  return {
    currency: value.currency,
    amount: roundNumber(value.amount),
    pricingSnapshotId: value.pricingSnapshotId,
    source: "SUPPLIED",
  };
}

/** @param {any} value @param {any[]} errors @returns {any} */
function normalizeFinding(value, errors) {
  if (!isPlainObject(value)) {
    errors.push(issue("INVALID_FINDING", "A finding must be an object."));
    return null;
  }
  const findingId = requiredString(value.findingId, "INVALID_FINDING_ID", errors);
  if (!SEVERITIES.has(value.severity)) {
    errors.push(
      issue("INVALID_FINDING_SEVERITY", "A finding has an unsupported severity."),
    );
  }
  if (value.verification !== undefined && !VERIFICATIONS.has(value.verification)) {
    errors.push(
      issue(
        "INVALID_FINDING_VERIFICATION",
        "A finding has an unsupported verification state.",
      ),
    );
  }
  if (findingId === null || !SEVERITIES.has(value.severity)) {
    return null;
  }
  return {
    findingId,
    severity: value.severity,
    category: isNonEmptyString(value.category) ? value.category : null,
    verification: value.verification ?? null,
    tags: normalizeTags(value.tags, "INVALID_FINDING_TAGS", errors),
  };
}

/** @param {any} value @param {any[]} errors @returns {any} */
function normalizeFindingLabel(value, errors) {
  if (!isPlainObject(value)) {
    errors.push(issue("INVALID_FINDING_LABEL", "A finding label must be an object."));
    return null;
  }
  const findingId = requiredString(value.findingId, "INVALID_FINDING_LABEL_ID", errors);
  if (!OUTCOMES.has(value.outcome)) {
    errors.push(
      issue("INVALID_FINDING_OUTCOME", "A finding label has an unsupported outcome."),
    );
  }
  const matched = value.matchedGroundTruthIds ?? [];
  if (!Array.isArray(matched) || matched.some((id) => !isNonEmptyString(id))) {
    errors.push(
      issue("INVALID_MATCH_IDS", "Matched ground-truth IDs must be opaque strings."),
    );
    return null;
  }
  if (new Set(matched).size !== matched.length) {
    errors.push(
      issue("DUPLICATE_MATCH_ID", "A finding label repeats a ground-truth match."),
    );
  }
  if (value.outcome === "REJECTED" && matched.length > 0) {
    errors.push(
      issue(
        "CONTRADICTORY_ADJUDICATION",
        "A rejected finding cannot claim ground-truth matches.",
      ),
    );
  }
  if (findingId === null || !OUTCOMES.has(value.outcome)) {
    return null;
  }
  return {
    findingId,
    outcome: value.outcome,
    matchedGroundTruthIds: uniqueSortedStrings(matched),
  };
}

/** @param {any} value @param {any[]} errors @returns {any} */
function normalizeAdjudication(value, errors) {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isPlainObject(value)) {
    errors.push(issue("INVALID_ADJUDICATION", "Adjudication must be an object."));
    return null;
  }
  if (!ADJUDICATION_STATUSES.has(value.status)) {
    errors.push(
      issue("INVALID_ADJUDICATION_STATUS", "Adjudication has an unsupported status."),
    );
  }
  const labels = value.findingLabels ?? [];
  if (!Array.isArray(labels)) {
    errors.push(issue("INVALID_FINDING_LABELS", "Finding labels must be an array."));
    return null;
  }
  const normalizedLabels = labels
    .map((label) => normalizeFindingLabel(label, errors))
    .filter(Boolean);
  const ids = new Set();
  for (const label of normalizedLabels) {
    if (ids.has(label.findingId)) {
      errors.push(
        issue(
          "DUPLICATE_FINDING_LABEL",
          "A finding has more than one adjudication label.",
        ),
      );
    }
    ids.add(label.findingId);
  }
  if (!ADJUDICATION_STATUSES.has(value.status)) {
    return null;
  }
  return {
    status: value.status,
    rubricId: isNonEmptyString(value.rubricId) ? value.rubricId : null,
    labelVersion: isNonEmptyString(value.labelVersion) ? value.labelVersion : null,
    findingLabels: stableSort(normalizedLabels, (label) => label.findingId),
    rootCauseScore: isFiniteNumber(value.rootCauseScore)
      ? roundNumber(value.rootCauseScore)
      : null,
  };
}

/** @param {any} value @param {any[]} errors @returns {any} */
function normalizeRun(value, errors) {
  if (!isPlainObject(value)) {
    errors.push(issue("INVALID_RUN_RECORD", "A run record must be an object."));
    return null;
  }
  if (value.schemaVersion !== 1) {
    errors.push(
      issue("UNSUPPORTED_RUN_SCHEMA", "Run records must use schemaVersion 1."),
    );
  }
  const caseId = requiredString(value.caseId, "INVALID_CASE_ID", errors);
  const variantId = requiredString(value.variantId, "INVALID_VARIANT_ID", errors);
  const runId = requiredString(value.runId, "INVALID_RUN_ID", errors);
  const contextDigest = requiredString(
    value.contextDigest,
    "INVALID_CONTEXT_DIGEST",
    errors,
  );
  const toolContractId = requiredString(
    value.toolContractId,
    "INVALID_TOOL_CONTRACT_ID",
    errors,
  );
  if (parseUtcTimestamp(value.startedAt) === undefined) {
    errors.push(
      issue("INVALID_STARTED_AT", "Run timestamps must be RFC 3339 UTC values."),
    );
  }
  if (!isNonNegativeNumber(value.latencyMs)) {
    errors.push(
      issue("INVALID_LATENCY", "Run latency must be a non-negative finite number."),
    );
  }
  if (!Array.isArray(value.findings)) {
    errors.push(issue("INVALID_FINDINGS", "Run findings must be an array."));
  }
  const findings = Array.isArray(value.findings)
    ? value.findings.map((finding) => normalizeFinding(finding, errors)).filter(Boolean)
    : [];
  const findingIds = new Set();
  for (const finding of findings) {
    if (findingIds.has(finding.findingId)) {
      errors.push(issue("DUPLICATE_FINDING_ID", "A run repeats a finding ID."));
    }
    findingIds.add(finding.findingId);
  }
  const adjudication = normalizeAdjudication(value.adjudication, errors);
  if (adjudication) {
    for (const label of adjudication.findingLabels) {
      if (!findingIds.has(label.findingId)) {
        errors.push(
          issue(
            "UNKNOWN_FINDING_LABEL",
            "An adjudication references an unknown finding.",
          ),
        );
      }
    }
  }
  if (
    caseId === null ||
    variantId === null ||
    runId === null ||
    contextDigest === null ||
    toolContractId === null ||
    parseUtcTimestamp(value.startedAt) === undefined ||
    !isNonNegativeNumber(value.latencyMs)
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    caseId,
    variantId,
    runId,
    contextDigest,
    toolContractId,
    startedAt: value.startedAt,
    latencyMs: roundNumber(value.latencyMs),
    usage: normalizeUsage(value.usage, errors),
    cost: normalizeCost(value.cost, errors),
    findings: stableSort(findings, (finding) => finding.findingId),
    adjudication,
  };
}

/** @param {any} value @param {any[]} errors @returns {any} */
function normalizeCaseLabel(value, errors) {
  if (!isPlainObject(value)) {
    errors.push(issue("INVALID_CASE_LABEL", "A case label must be an object."));
    return null;
  }
  if (value.schemaVersion !== 1) {
    errors.push(
      issue("UNSUPPORTED_CASE_LABEL_SCHEMA", "Case labels must use schemaVersion 1."),
    );
  }
  const caseId = requiredString(value.caseId, "INVALID_CASE_LABEL_ID", errors);
  const rubricId = requiredString(value.rubricId, "INVALID_CASE_RUBRIC_ID", errors);
  const labelVersion = requiredString(
    value.labelVersion,
    "INVALID_CASE_LABEL_VERSION",
    errors,
  );
  if (!Array.isArray(value.groundTruth)) {
    errors.push(issue("INVALID_GROUND_TRUTH", "Case ground truth must be an array."));
  }
  const groundTruth = [];
  const ids = new Set();
  for (const item of Array.isArray(value.groundTruth) ? value.groundTruth : []) {
    if (
      !isPlainObject(item) ||
      !isNonEmptyString(item.groundTruthId) ||
      !SEVERITIES.has(item.severity)
    ) {
      errors.push(issue("INVALID_GROUND_TRUTH", "A ground-truth item is malformed."));
      continue;
    }
    if (ids.has(item.groundTruthId)) {
      errors.push(
        issue("DUPLICATE_GROUND_TRUTH_ID", "A case repeats a ground-truth ID."),
      );
    }
    ids.add(item.groundTruthId);
    groundTruth.push({
      groundTruthId: item.groundTruthId,
      severity: item.severity,
      tags: normalizeTags(item.tags, "INVALID_GROUND_TRUTH_TAGS", errors),
    });
  }
  if (caseId === null || rubricId === null || labelVersion === null) {
    return null;
  }
  return {
    schemaVersion: 1,
    caseId,
    rubricId,
    labelVersion,
    groundTruth: stableSort(groundTruth, (item) => item.groundTruthId),
  };
}

/** @param {any} value @param {any[]} warnings @param {any[]} errors @returns {any} */
function normalizeRubric(value, warnings, errors) {
  if (value === undefined || value === null) {
    warnings.push(
      issue("MISSING_RUBRIC", "Quality metrics require a versioned rubric."),
    );
    return null;
  }
  if (!isPlainObject(value)) {
    errors.push(issue("INVALID_RUBRIC", "Rubric must be an object."));
    return null;
  }
  const rubricId = requiredString(value.rubricId, "INVALID_RUBRIC_ID", errors);
  const version = requiredString(
    value.version ?? value.labelVersion,
    "INVALID_RUBRIC_VERSION",
    errors,
  );
  const weights = value.severityWeights;
  if (!isPlainObject(weights)) {
    warnings.push(
      issue("MISSING_SEVERITY_WEIGHTS", "Recall requires explicit severity weights."),
    );
  }
  /** @type {Record<string, number>} */
  const severityWeights = {};
  for (const severity of SEVERITIES) {
    if (!isNonEmptyString(severity)) {
      continue;
    }
    if (isPlainObject(weights) && isNonNegativeNumber(weights[severity])) {
      severityWeights[severity] = roundNumber(weights[severity]);
    }
  }
  if (Object.keys(severityWeights).length !== SEVERITIES.size) {
    warnings.push(
      issue(
        "INCOMPLETE_SEVERITY_WEIGHTS",
        "Recall requires a weight for every severity.",
      ),
    );
  }
  const matchingRules = isPlainObject(value.matchingRules)
    ? {
        allowOneFindingMultipleGroundTruth:
          value.matchingRules.allowOneFindingMultipleGroundTruth === true,
        allowMultipleFindingsPerGroundTruth:
          value.matchingRules.allowMultipleFindingsPerGroundTruth === true,
      }
    : null;
  if (matchingRules === null) {
    warnings.push(
      issue("MISSING_MATCHING_RULES", "Recall requires explicit matching rules."),
    );
  }
  if (rubricId === null || version === null) {
    return null;
  }
  return { rubricId, version, severityWeights, matchingRules };
}

/** @param {any} value @param {any[]} warnings @param {any[]} errors @returns {any} */
function normalizePricing(value, warnings, errors) {
  if (value === undefined || value === null) {
    warnings.push(
      issue(
        "MISSING_PRICING_SNAPSHOT",
        "Cost reconstruction requires a pricing snapshot.",
      ),
    );
    return null;
  }
  if (!isPlainObject(value)) {
    errors.push(
      issue("INVALID_PRICING_SNAPSHOT", "Pricing snapshot must be an object."),
    );
    return null;
  }
  const snapshotId = requiredString(value.snapshotId, "INVALID_PRICING_ID", errors);
  const currency = requiredString(value.currency, "INVALID_PRICING_CURRENCY", errors);
  if (parseUtcTimestamp(value.effectiveAt) === undefined) {
    errors.push(
      issue(
        "INVALID_PRICING_EFFECTIVE_AT",
        "Pricing effectiveAt must be RFC 3339 UTC.",
      ),
    );
  }
  if (!Array.isArray(value.rates)) {
    errors.push(issue("INVALID_PRICING_RATES", "Pricing rates must be an array."));
  }
  /** @type {Record<string, any>} */
  const rates = {};
  for (const rate of Array.isArray(value.rates) ? value.rates : []) {
    if (
      !isPlainObject(rate) ||
      !isNonEmptyString(rate.variantId) ||
      !isNonNegativeNumber(rate.inputPerMillion) ||
      !isNonNegativeNumber(rate.cachedInputPerMillion) ||
      !isNonNegativeNumber(rate.outputPerMillion)
    ) {
      errors.push(issue("INVALID_PRICING_RATE", "A pricing rate is malformed."));
      continue;
    }
    if (rates[rate.variantId]) {
      errors.push(issue("DUPLICATE_PRICING_RATE", "Pricing repeats a variant rate."));
      continue;
    }
    rates[rate.variantId] = {
      inputPerMillion: roundNumber(rate.inputPerMillion),
      cachedInputPerMillion: roundNumber(rate.cachedInputPerMillion),
      outputPerMillion: roundNumber(rate.outputPerMillion),
    };
  }
  if (
    snapshotId === null ||
    currency === null ||
    parseUtcTimestamp(value.effectiveAt) === undefined
  ) {
    return null;
  }
  return {
    snapshotId,
    currency,
    effectiveAt: value.effectiveAt,
    provenance:
      isPlainObject(value.provenance) && isNonEmptyString(value.provenance.kind)
        ? { kind: value.provenance.kind }
        : null,
    rates,
  };
}

/** @param {any} value @param {any[]} errors @returns {any} */
function normalizeManifest(value, errors) {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isPlainObject(value)) {
    errors.push(
      issue("INVALID_BENCHMARK_MANIFEST", "Benchmark manifest must be an object."),
    );
    return null;
  }
  const corpusId = requiredString(value.corpusId, "INVALID_CORPUS_ID", errors);
  const exporterVersion = requiredString(
    value.exporterVersion,
    "INVALID_EXPORTER_VERSION",
    errors,
  );
  const toolContractId = requiredString(
    value.toolContractId,
    "INVALID_MANIFEST_TOOL_CONTRACT",
    errors,
  );
  const rubricId = requiredString(value.rubricId, "INVALID_MANIFEST_RUBRIC", errors);
  const labelVersion = requiredString(
    value.labelVersion,
    "INVALID_MANIFEST_LABEL_VERSION",
    errors,
  );
  const pricingSnapshotId = requiredString(
    value.pricingSnapshotId,
    "INVALID_MANIFEST_PRICING",
    errors,
  );
  const caseIds = Array.isArray(value.caseIds)
    ? uniqueSortedStrings(value.caseIds)
    : [];
  const variantIds = Array.isArray(value.variantIds)
    ? uniqueSortedStrings(value.variantIds)
    : [];
  if (
    !Array.isArray(value.caseIds) ||
    caseIds.length === 0 ||
    caseIds.length !== value.caseIds.length
  ) {
    errors.push(
      issue(
        "INVALID_MANIFEST_CASES",
        "Manifest case IDs must be unique opaque strings.",
      ),
    );
  }
  if (
    !Array.isArray(value.variantIds) ||
    variantIds.length === 0 ||
    variantIds.length !== value.variantIds.length
  ) {
    errors.push(
      issue(
        "INVALID_MANIFEST_VARIANTS",
        "Manifest variant IDs must be unique aliases.",
      ),
    );
  }
  if (
    corpusId === null ||
    exporterVersion === null ||
    toolContractId === null ||
    rubricId === null ||
    labelVersion === null ||
    pricingSnapshotId === null
  ) {
    return null;
  }
  return {
    corpusId,
    exporterVersion,
    caseIds,
    variantIds,
    toolContractId,
    rubricId,
    labelVersion,
    pricingSnapshotId,
  };
}

/**
 * A valid public manifest is the source of cohort identity. Contradictory
 * records are blocked rather than silently dropped from the paired cohort.
 *
 * @param {any} manifest
 * @param {any[]} runs
 * @param {any[]} caseLabels
 * @param {any} rubric
 * @param {any} pricingSnapshot
 * @param {any[]} candidateConfigs
 * @param {any[]} errors
 */
function crossValidateManifest(
  manifest,
  runs,
  caseLabels,
  rubric,
  pricingSnapshot,
  candidateConfigs,
  errors,
) {
  if (!manifest) {
    return;
  }
  const caseIds = new Set(manifest.caseIds);
  const variantIds = new Set(manifest.variantIds);
  for (const run of runs) {
    if (!caseIds.has(run.caseId)) {
      errors.push(
        issue("RUN_OUTSIDE_MANIFEST", "A run case is not declared by the manifest."),
      );
    }
    if (!variantIds.has(run.variantId)) {
      errors.push(
        issue(
          "RUN_VARIANT_OUTSIDE_MANIFEST",
          "A run variant is not declared by the manifest.",
        ),
      );
    }
    if (run.toolContractId !== manifest.toolContractId) {
      errors.push(
        issue(
          "TOOL_CONTRACT_MISMATCH",
          "A run tool contract differs from the manifest.",
        ),
      );
    }
  }
  for (const label of caseLabels) {
    if (!caseIds.has(label.caseId)) {
      errors.push(
        issue(
          "LABEL_OUTSIDE_MANIFEST",
          "A case label is not declared by the manifest.",
        ),
      );
    }
    if (
      label.rubricId !== manifest.rubricId ||
      label.labelVersion !== manifest.labelVersion
    ) {
      errors.push(
        issue(
          "MANIFEST_LABEL_MISMATCH",
          "A case label differs from manifest provenance.",
        ),
      );
    }
  }
  if (
    rubric &&
    (rubric.rubricId !== manifest.rubricId || rubric.version !== manifest.labelVersion)
  ) {
    errors.push(issue("MANIFEST_RUBRIC_MISMATCH", "Rubric differs from the manifest."));
  }
  if (pricingSnapshot && pricingSnapshot.snapshotId !== manifest.pricingSnapshotId) {
    errors.push(
      issue("MANIFEST_PRICING_MISMATCH", "Pricing snapshot differs from the manifest."),
    );
  }
  const candidateIds = new Set(
    candidateConfigs.map((candidate) => candidate.variantId),
  );
  for (const candidate of candidateConfigs) {
    if (!variantIds.has(candidate.variantId)) {
      errors.push(
        issue(
          "CANDIDATE_OUTSIDE_MANIFEST",
          "A candidate config is not declared by the manifest.",
        ),
      );
    }
  }
  for (const variantId of manifest.variantIds) {
    if (!candidateIds.has(variantId)) {
      errors.push(
        issue(
          "MISSING_CANDIDATE_CONFIG",
          "Every manifest variant requires a candidate config.",
        ),
      );
    }
  }
}

/** @param {any} run @param {any} pricing @param {any[]} warnings @returns {any} */
function reconstructCost(run, pricing, warnings) {
  if (run.cost) {
    if (
      pricing &&
      (run.cost.currency !== pricing.currency ||
        run.cost.pricingSnapshotId !== pricing.snapshotId)
    ) {
      warnings.push(
        issue(
          "COST_PRICING_MISMATCH",
          "Supplied run cost does not match the supplied snapshot.",
        ),
      );
    }
    return run;
  }
  const rate = pricing?.rates[run.variantId];
  if (!pricing || !rate || !run.usage) {
    return run;
  }
  const uncached = run.usage.inputTokens - run.usage.cachedInputTokens;
  const amount =
    (uncached * rate.inputPerMillion +
      run.usage.cachedInputTokens * rate.cachedInputPerMillion +
      run.usage.outputTokens * rate.outputPerMillion) /
    1_000_000;
  return {
    ...run,
    cost: {
      currency: pricing.currency,
      amount: roundNumber(amount),
      pricingSnapshotId: pricing.snapshotId,
      source: "RECONSTRUCTED",
    },
  };
}

/**
 * @param {any[]} runs
 * @param {Map<string, any>} labelsByCase
 * @param {any} rubric
 * @param {any[]} errors
 * @param {any[]} warnings
 */
function crossValidate(runs, labelsByCase, rubric, errors, warnings) {
  for (const run of runs) {
    const label = labelsByCase.get(run.caseId);
    const adjudication = run.adjudication;
    if (!adjudication) {
      continue;
    }
    if (adjudication.rubricId && label && adjudication.rubricId !== label.rubricId) {
      errors.push(
        issue(
          "RUBRIC_VERSION_MISMATCH",
          "Run adjudication and case label use different rubrics.",
        ),
      );
    }
    if (
      adjudication.labelVersion &&
      label &&
      adjudication.labelVersion !== label.labelVersion
    ) {
      errors.push(
        issue(
          "LABEL_VERSION_MISMATCH",
          "Run adjudication and case label use different label versions.",
        ),
      );
    }
    if (
      rubric &&
      label &&
      (label.rubricId !== rubric.rubricId || label.labelVersion !== rubric.version)
    ) {
      errors.push(
        issue(
          "RUBRIC_VERSION_MISMATCH",
          "Case label and rubric versions do not match.",
        ),
      );
    }
    const groundTruthIds = new Set(
      label?.groundTruth.map((item) => item.groundTruthId) ?? [],
    );
    const seenGroundTruth = new Map();
    for (const findingLabel of adjudication.findingLabels) {
      for (const groundTruthId of findingLabel.matchedGroundTruthIds) {
        if (!groundTruthIds.has(groundTruthId)) {
          errors.push(
            issue(
              "UNKNOWN_GROUND_TRUTH_MATCH",
              "A finding references an unknown ground-truth ID.",
            ),
          );
        }
        const count = (seenGroundTruth.get(groundTruthId) ?? 0) + 1;
        seenGroundTruth.set(groundTruthId, count);
        if (
          rubric?.matchingRules?.allowMultipleFindingsPerGroundTruth === false &&
          count > 1
        ) {
          errors.push(
            issue(
              "CONTRADICTORY_MATCH",
              "Multiple findings match one ground-truth ID against the rubric.",
            ),
          );
        }
      }
      if (
        rubric?.matchingRules?.allowOneFindingMultipleGroundTruth === false &&
        findingLabel.matchedGroundTruthIds.length > 1
      ) {
        errors.push(
          issue(
            "CONTRADICTORY_MATCH",
            "One finding matches multiple ground-truth IDs against the rubric.",
          ),
        );
      }
    }
    if (
      adjudication.status === "ADJUDICATED" &&
      adjudication.findingLabels.length !== run.findings.length
    ) {
      errors.push(
        issue(
          "INCOMPLETE_ADJUDICATION",
          "An adjudicated run does not label every finding.",
        ),
      );
    }
    if (
      !label &&
      adjudication.findingLabels.some((item) => item.matchedGroundTruthIds.length > 0)
    ) {
      errors.push(
        issue(
          "MISSING_CASE_LABEL",
          "Matched findings require a case ground-truth label.",
        ),
      );
    } else if (!label) {
      warnings.push(
        issue(
          "MISSING_CASE_LABEL",
          "Quality metrics are unavailable for a run without case labels.",
        ),
      );
    }
  }
}

/**
 * Normalize imported benchmark data without reading files or trusting unknown
 * content. The surrounding schema layer should reject unknown fields; this
 * layer enforces cross-record invariants needed by scoring.
 */
/**
 * @param {Record<string, any>} [input]
 * @returns {Record<string, any>}
 */
export function normalizeBenchmarkInput(input = {}) {
  /** @type {any[]} */
  const errors = [];
  /** @type {any[]} */
  const warnings = [];
  if (!isPlainObject(input)) {
    return {
      status: "BLOCKED",
      errors: [issue("INVALID_BENCHMARK_INPUT", "Benchmark input must be an object.")],
      warnings: [],
      runs: [],
      caseLabels: [],
      variantIds: [],
    };
  }
  const rawRuns = input.runRecords ?? input.runs ?? [];
  const rawLabels = input.caseLabels ?? input.labels ?? [];
  if (!Array.isArray(rawRuns)) {
    errors.push(issue("INVALID_RUN_RECORDS", "Run records must be an array."));
  }
  if (!Array.isArray(rawLabels)) {
    errors.push(issue("INVALID_CASE_LABELS", "Case labels must be an array."));
  }

  const rubric = normalizeRubric(input.rubric, warnings, errors);
  const pricingSnapshot = normalizePricing(
    input.pricingSnapshot ?? input.pricing,
    warnings,
    errors,
  );
  const manifest = normalizeManifest(input.benchmarkManifest ?? input.manifest, errors);
  const caseLabels = (Array.isArray(rawLabels) ? rawLabels : [])
    .map((label) => normalizeCaseLabel(label, errors))
    .filter(Boolean);
  const labelsByCase = new Map();
  for (const label of caseLabels) {
    if (labelsByCase.has(label.caseId)) {
      errors.push(
        issue("DUPLICATE_CASE_LABEL", "A case has more than one ground-truth label."),
      );
    }
    labelsByCase.set(label.caseId, label);
  }

  let runs = (Array.isArray(rawRuns) ? rawRuns : [])
    .map((run) => normalizeRun(run, errors))
    .filter(Boolean);
  const pairKeys = new Set();
  const runIds = new Set();
  for (const run of runs) {
    const pairKey = `${run.caseId}\u0000${run.variantId}`;
    if (pairKeys.has(pairKey)) {
      errors.push(
        issue(
          "DUPLICATE_CASE_VARIANT_RUN",
          "A case and variant pair has more than one run.",
        ),
      );
    }
    pairKeys.add(pairKey);
    if (runIds.has(run.runId)) {
      errors.push(issue("DUPLICATE_RUN_ID", "A run ID is repeated."));
    }
    runIds.add(run.runId);
  }
  runs = runs.map((run) => reconstructCost(run, pricingSnapshot, warnings));
  crossValidate(runs, labelsByCase, rubric, errors, warnings);

  const rawCandidates = input.candidateConfigs ?? input.candidates;
  const candidateConfigs = Array.isArray(rawCandidates)
    ? [...rawCandidates]
        .filter(
          (candidate) =>
            isPlainObject(candidate) && isNonEmptyString(candidate.variantId),
        )
        .map((candidate) => ({
          variantId: candidate.variantId,
          modelAlias: isNonEmptyString(candidate.modelAlias)
            ? candidate.modelAlias
            : null,
          reasoningProfile: isNonEmptyString(candidate.reasoningProfile)
            ? candidate.reasoningProfile
            : null,
          promptConfigDigest: isNonEmptyString(candidate.promptConfigDigest)
            ? candidate.promptConfigDigest
            : null,
          routingPolicyId: isNonEmptyString(candidate.routingPolicyId)
            ? candidate.routingPolicyId
            : null,
          declaredContextClass: isNonEmptyString(candidate.declaredContextClass)
            ? candidate.declaredContextClass
            : null,
        }))
        .sort((left, right) => compareText(left.variantId, right.variantId))
    : [];
  const candidateIds = new Set();
  for (const candidate of candidateConfigs) {
    if (candidateIds.has(candidate.variantId)) {
      errors.push(
        issue("DUPLICATE_CANDIDATE_CONFIG", "A candidate variant is repeated."),
      );
    }
    candidateIds.add(candidate.variantId);
  }
  crossValidateManifest(
    manifest,
    runs,
    caseLabels,
    rubric,
    pricingSnapshot,
    candidateConfigs,
    errors,
  );

  const sortedRuns = [...runs].sort(
    (left, right) =>
      compareText(left.caseId, right.caseId) ||
      compareText(left.variantId, right.variantId) ||
      compareText(left.runId, right.runId),
  );
  const variantIds = uniqueSortedStrings([
    ...sortedRuns.map((run) => run.variantId),
    ...candidateConfigs.map((candidate) => candidate.variantId),
  ]);
  const sortedLabels = stableSort(caseLabels, (label) => label.caseId);
  return {
    status:
      errors.length > 0 ? "BLOCKED" : warnings.length > 0 ? "PARTIAL" : "COMPLETE",
    errors,
    warnings,
    runs: sortedRuns,
    caseLabels: sortedLabels,
    caseLabelsById: new Map(sortedLabels.map((label) => [label.caseId, label])),
    rubric,
    pricingSnapshot,
    candidateConfigs,
    variantIds,
    manifest,
  };
}

export const normalizeImportedRuns = normalizeBenchmarkInput;

// New lane-aware callers should import from src/normalize/index.mjs. These
// re-exports keep older benchmark-only integrations source-compatible while
// the CLI migrates to the shared in-memory normalizer.
export {
  normalizeLaneBundle,
  normalizeLaneBundles,
  normalizeReviewRuns,
} from "../normalize/index.mjs";
