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
  sum,
  uniqueSortedStrings,
} from "../benchmark/shared.mjs";
import { structuralDigest } from "../utils.mjs";

const OPAQUE_DIGEST_ID = /^sha256:[0-9a-f]{64}$/u;
const PUBLIC_ALIAS = /^[a-z][a-z0-9._-]{0,63}$/u;
const TOOL_VERSION =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const SEVERITIES = new Set(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const CATEGORIES = new Set([
  "SECURITY",
  "RELIABILITY",
  "COST",
  "LATENCY",
  "QUALITY",
  "NOISE",
  "TELEMETRY",
]);
const OUTCOMES = new Set(["ACCEPTED", "REJECTED", "UNKNOWN"]);
const VERIFICATIONS = new Set(["VERIFIED", "UNVERIFIED", "UNKNOWN"]);
const ADJUDICATION_STATUSES = new Set(["ADJUDICATED", "PARTIAL", "UNADJUDICATED"]);
const COST_BASES = new Set(["FULLY_LOADED", "MODEL_ONLY"]);
const COST_SOURCES = new Set(["SUPPLIED_TOTAL", "RECONSTRUCTED_COMPONENTS"]);
const LANE_TYPES = new Set([
  "PORTABLE_CORE_MODEL",
  "HARNESS_ABLATION",
  "BEST_SYSTEM",
  "SHADOW_PILOT",
]);
const EXECUTION_MODES = new Set(["OFFLINE_REPLAY", "SHADOW_NO_POSTING"]);
const FORBIDDEN_KEYS = new Set([
  "apikey",
  "api_key",
  "authorization",
  "body",
  "command",
  "comment",
  "commentbody",
  "comment_body",
  "credential",
  "credentials",
  "diff",
  "email",
  "headers",
  "log",
  "logs",
  "patch",
  "password",
  "prompt",
  "prompttext",
  "prompt_text",
  "rawdiff",
  "raw_diff",
  "rawprompt",
  "raw_prompt",
  "secret",
  "token",
  "url",
]);

const RUN_KEYS = new Set([
  "schemaVersion",
  "caseId",
  "variantId",
  "architectureId",
  "architectureStructuralDigest",
  "runId",
  "replicateId",
  "contextDigest",
  "toolContractId",
  "controllerContractId",
  "validatorContractId",
  "dedupePolicyId",
  "postingPolicyId",
  "reasoningClass",
  "retryPolicyId",
  "timeoutPolicyId",
  "routingPolicyId",
  "startedAt",
  "latencyMs",
  "usage",
  "cost",
  "humanReviewMinutes",
  "findings",
  "outputCounts",
  "adjudication",
]);
const FINDING_KEYS = new Set([
  "findingId",
  "severity",
  "category",
  "verification",
  "tags",
]);
const ADJUDICATION_KEYS = new Set([
  "status",
  "rubricId",
  "labelVersion",
  "findingLabels",
  "rootCauseAssessments",
]);
const FINDING_LABEL_KEYS = new Set(["findingId", "outcome", "matchedRootCauseIds"]);
const ROOT_CAUSE_ASSESSMENT_KEYS = new Set([
  "rootCauseId",
  "qualityScore",
  "qualityRubricId",
]);
const CASE_LABEL_KEYS = new Set([
  "schemaVersion",
  "caseId",
  "rubricId",
  "labelVersion",
  "riskSliceIds",
  "groundTruth",
  "provenance",
]);
const GROUND_TRUTH_KEYS = new Set(["rootCauseId", "severity", "tags"]);
const CANDIDATE_KEYS = new Set([
  "schemaVersion",
  "variantId",
  "architectureId",
  "architectureStructuralDigest",
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
const COST_KEYS = new Set([
  "currency",
  "amountMicros",
  "costBasis",
  "costSource",
  "pricingSnapshotId",
  "components",
]);
const COST_COMPONENT_KEYS = new Set([
  "modelMicros",
  "toolingMicros",
  "humanReviewMicros",
]);
const USAGE_KEYS = new Set(["inputTokens", "outputTokens", "cachedInputTokens"]);
const OUTPUT_COUNT_KEYS = new Set(["proposedFindings", "publishedComments"]);
const EXPORT_KEYS = new Set([
  "schemaVersion",
  "exportId",
  "exporterVersion",
  "runRecord",
  "provenance",
]);
const PRICING_KEYS = new Set([
  "schemaVersion",
  "snapshotId",
  "currency",
  "effectiveAt",
  "costBasis",
  "provenance",
  "rates",
]);
const PRICING_RATE_KEYS = new Set([
  "variantId",
  "inputMicrosPerMillion",
  "cachedInputMicrosPerMillion",
  "outputMicrosPerMillion",
  "toolingMicrosPerRun",
  "humanReviewMicrosPerMinute",
]);
const MANIFEST_KEYS = new Set([
  "schemaVersion",
  "corpusId",
  "exporterVersion",
  "exportedAt",
  "caseIds",
  "variantIds",
  "rubricId",
  "labelVersion",
  "pricingSnapshotId",
  "redactionPolicyVersion",
  "lane",
  "sliceTaxonomy",
  "productionBaselineContracts",
  "structuralReceipts",
]);
const LANE_KEYS = new Set([
  "laneId",
  "laneType",
  "baselineVariantId",
  "cohortSelectionDigest",
  "cohortWindowId",
  "allowedDifferenceAxes",
  "executionMode",
]);
const SLICE_TAXONOMY_KEYS = new Set(["taxonomyId", "version", "sliceIds"]);
const BASELINE_CONTRACT_KEYS = new Set([
  "controllerContractId",
  "validatorContractId",
  "dedupePolicyId",
  "postingPolicyId",
]);
const PROVENANCE_KEYS = new Set(["kind", "sourceLabel", "exporterVersion"]);
const EVAL_PROTOCOL_KEYS = new Set([
  "schemaVersion",
  "protocolId",
  "protocolVersion",
  "laneId",
  "intendedClaim",
  "samplingFrame",
  "cohortSelectionDigest",
  "cohortWindowId",
  "inclusionPolicyId",
  "exclusionPolicyId",
  "assignmentMethod",
  "pairingMethod",
  "replicateAggregation",
  "missingReplicatePolicy",
  "leakageControls",
  "knownContamination",
  "heldConstantFields",
  "preservationContracts",
  "expectedExecutionMode",
  "provenance",
  "predeclaredExclusions",
]);
const LEAKAGE_CONTROL_KEYS = new Set(["controlId", "status", "evidenceStatus"]);
const PRESERVATION_CONTRACT_KEYS = new Set([
  "controllerContractId",
  "validatorContractId",
  "dedupePolicyId",
  "postingPolicyId",
  "toolContractId",
  "contextClass",
  "retryPolicyId",
  "timeoutPolicyId",
  "routingPolicyId",
]);
const ADJUDICATION_PROTOCOL_KEYS = new Set([
  "schemaVersion",
  "protocolId",
  "protocolVersion",
  "laneId",
  "rubricId",
  "labelVersion",
  "variantIdentity",
  "presentationOrder",
  "highCriticalReview",
  "adjudicatorIndependence",
  "disagreement",
  "provenance",
]);
const ADJUDICATOR_INDEPENDENCE_KEYS = new Set([
  "status",
  "evidenceStatus",
  "provenanceId",
]);
const DISAGREEMENT_KEYS = new Set(["policyId", "status", "count"]);
const PREDECLARED_EXCLUSION_KEYS = new Set(["caseId", "symmetric", "provenanceDigest"]);
const DIFFERENCE_AXES = new Set([
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
const REQUIRED_RECEIPT_KINDS = new Set([
  "MANIFEST",
  "EVAL_PROTOCOL",
  "ADJUDICATION_PROTOCOL",
  "CANDIDATES",
  "RUBRIC",
  "PRICING",
  "CASE_LABELS",
]);
const SOURCE_RECEIPT_KINDS = new Set(["EXPORT", "CANONICAL_RUNS"]);
const RECEIPT_KINDS = new Set([...REQUIRED_RECEIPT_KINDS, ...SOURCE_RECEIPT_KINDS]);
const MAX_REPLICATES_PER_CASE_VARIANT = 32;

/** @param {unknown} value @returns {value is string} */
export function isOpaqueDigestId(value) {
  return typeof value === "string" && OPAQUE_DIGEST_ID.test(value);
}

/** @param {unknown} value @returns {value is string} */
export function isPublicAlias(value) {
  return typeof value === "string" && PUBLIC_ALIAS.test(value);
}

/** @param {unknown} value @returns {string | null} */
function normalizedEnum(value) {
  return typeof value === "string" ? value.toUpperCase() : null;
}

/** @param {unknown} value @returns {string | null} */
function normalizedTimestamp(value) {
  const epoch = parseUtcTimestamp(value);
  return epoch === undefined ? null : new Date(epoch).toISOString();
}

/**
 * @param {unknown} value
 * @param {Set<string>} allowed
 * @param {string} code
 * @param {Record<string, unknown>[]} errors
 * @returns {boolean}
 */
function rejectUnknownKeys(value, allowed, code, errors) {
  if (!isPlainObject(value)) {
    return false;
  }
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length === 0) {
    return true;
  }
  errors.push(
    issue(code, "Input includes fields outside the source-neutral contract.", {
      fields: unknown.sort(compareText),
    }),
  );
  return false;
}

/**
 * Reject high-risk raw-data keys even when an upstream schema check was
 * skipped. Exact-key matching avoids confusing typed fields such as
 * inputTokens with secrets.
 *
 * @param {unknown} value
 * @param {string[]} path
 * @returns {string[]}
 */
function forbiddenPaths(value, path = []) {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      forbiddenPaths(item, [...path, String(index)]),
    );
  }
  if (!isPlainObject(value)) {
    return [];
  }
  const paths = [];
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replaceAll("-", "").toLowerCase();
    if (FORBIDDEN_KEYS.has(normalized)) {
      paths.push([...path, key].join("."));
    } else {
      paths.push(...forbiddenPaths(child, [...path, key]));
    }
  }
  return paths;
}

/**
 * @param {unknown} value
 * @param {string} code
 * @param {Record<string, unknown>[]} errors
 * @returns {string | null}
 */
function requiredOpaqueId(value, code, errors) {
  if (!isOpaqueDigestId(value)) {
    errors.push(issue(code, "Expected a sha256 opaque digest identifier."));
    return null;
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} code
 * @param {Record<string, unknown>[]} errors
 * @returns {string | null}
 */
function requiredAlias(value, code, errors) {
  if (!isPublicAlias(value)) {
    errors.push(issue(code, "Expected a lower-case public alias."));
    return null;
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} code
 * @param {Record<string, unknown>[]} errors
 * @returns {string | null}
 */
function requiredToolVersion(value, code, errors) {
  if (typeof value !== "string" || !TOOL_VERSION.test(value)) {
    errors.push(issue(code, "Expected a semantic exporter version."));
    return null;
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} code
 * @param {Record<string, unknown>[]} errors
 * @returns {string[] | null}
 */
function normalizeStringArray(value, code, errors) {
  if (!Array.isArray(value) || value.some((item) => !isPublicAlias(item))) {
    errors.push(issue(code, "Expected unique lower-case public aliases."));
    return null;
  }
  const result = uniqueSortedStrings(value);
  if (result.length !== value.length) {
    errors.push(issue(code, "Expected unique lower-case public aliases."));
    return null;
  }
  return result;
}

/**
 * @param {unknown} value
 * @param {Record<string, unknown>[]} errors
 * @returns {string[] | null}
 */
function normalizeDifferenceAxes(value, errors) {
  if (
    !Array.isArray(value) ||
    value.some((item) => !DIFFERENCE_AXES.has(item)) ||
    new Set(value).size !== value.length
  ) {
    errors.push(
      issue("INVALID_DIFFERENCE_AXES", "Difference axes must be known unique fields."),
    );
    return null;
  }
  return [...value].sort(compareText);
}

/**
 * @param {unknown} value
 * @param {Record<string, unknown>[]} errors
 * @returns {any[]}
 */
function normalizeStructuralReceipts(value, errors) {
  if (!Array.isArray(value)) {
    errors.push(
      issue("INVALID_STRUCTURAL_RECEIPTS", "Manifest receipts must be an array."),
    );
    return [];
  }
  const receipts = [];
  for (const receipt of value) {
    if (
      !isPlainObject(receipt) ||
      !isNonEmptyString(receipt.kind) ||
      !RECEIPT_KINDS.has(receipt.kind) ||
      !isOpaqueDigestId(receipt.digest)
    ) {
      errors.push(
        issue("INVALID_STRUCTURAL_RECEIPT", "A structural receipt is malformed."),
      );
      continue;
    }
    receipts.push({ kind: receipt.kind, digest: receipt.digest });
  }
  const kinds = receipts.map((receipt) => receipt.kind);
  const missing = [...REQUIRED_RECEIPT_KINDS].filter((kind) => !kinds.includes(kind));
  const sourceCount = kinds.filter((kind) => SOURCE_RECEIPT_KINDS.has(kind)).length;
  if (missing.length > 0 || sourceCount !== 1 || new Set(kinds).size !== kinds.length) {
    errors.push(
      issue(
        "INVALID_STRUCTURAL_RECEIPTS",
        "Manifest receipts must include each required artifact exactly once.",
        { missingKinds: missing.sort(compareText) },
      ),
    );
  }
  return stableSort(receipts, (receipt) => receipt.kind);
}

/**
 * Receipts bind only the closed source-neutral artifacts accepted by this
 * plugin. The manifest projection omits its own receipt array so the digest
 * is non-self-referential; missing artifacts receive an explicit sentinel and
 * therefore cannot accidentally verify.
 *
 * @param {unknown} input
 * @returns {{kind: string, digest: string}[]}
 */
export function computeStructuralReceipts(input) {
  if (!isPlainObject(input)) {
    return [];
  }
  try {
    if (forbiddenPaths(input).length > 0) {
      return [];
    }
    const manifestValue = input.manifest ?? input.benchmarkManifest;
    const manifest = isPlainObject(manifestValue)
      ? Object.fromEntries(
          Object.entries(manifestValue).filter(([key]) => key !== "structuralReceipts"),
        )
      : undefined;
    const sourceField = [
      "exports",
      "exportRecords",
      "canonicalRunRecords",
      "runs",
      "records",
    ].find((field) => Array.isArray(input[field]));
    const sourceKind =
      sourceField === "exports" || sourceField === "exportRecords"
        ? "EXPORT"
        : "CANONICAL_RUNS";
    const projections = [
      { kind: sourceKind, artifact: sourceField ? input[sourceField] : undefined },
      { kind: "MANIFEST", artifact: manifest },
      { kind: "EVAL_PROTOCOL", artifact: input.evalProtocol },
      {
        kind: "ADJUDICATION_PROTOCOL",
        artifact: input.adjudicationProtocol,
      },
      {
        kind: "CANDIDATES",
        artifact: input.candidateConfigs ?? input.candidates,
      },
      { kind: "RUBRIC", artifact: input.rubric },
      { kind: "PRICING", artifact: input.pricingSnapshot },
      { kind: "CASE_LABELS", artifact: input.caseLabels },
    ].filter(({ artifact }) => artifact !== undefined && artifact !== null);
    return stableSort(
      projections.map(({ kind, artifact: value }) => ({
        kind,
        digest: structuralDigest({
          receiptVersion: 1,
          kind,
          artifact: value,
        }),
      })),
      (receipt) => receipt.kind,
    );
  } catch {
    return [];
  }
}

/**
 * @param {unknown} input
 * @param {any} manifest
 * @param {Record<string, unknown>[]} errors
 */
function verifyStructuralReceipts(input, manifest, errors) {
  if (!manifest || !Array.isArray(manifest.structuralReceipts)) {
    return;
  }
  const declared = new Map(
    manifest.structuralReceipts.map((receipt) => [receipt.kind, receipt.digest]),
  );
  const expectedReceipts = computeStructuralReceipts(input);
  const expectedKinds = new Set(expectedReceipts.map((receipt) => receipt.kind));
  for (const expected of expectedReceipts) {
    if (declared.get(expected.kind) !== expected.digest) {
      errors.push(
        issue(
          "RO_RECEIPT_MISMATCH",
          "Structural receipt does not match the loaded artifact.",
          { kind: expected.kind },
        ),
      );
    }
  }
  for (const kind of declared.keys()) {
    if (!expectedKinds.has(kind)) {
      errors.push(
        issue(
          "RO_RECEIPT_MISMATCH",
          "Structural receipt does not match the loaded artifact.",
          { kind },
        ),
      );
    }
  }
}

/**
 * @param {unknown} value
 * @param {string} code
 * @param {Record<string, unknown>[]} errors
 * @returns {string[]}
 */
function normalizeTags(value, code, errors) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => !isPublicAlias(item))) {
    errors.push(issue(code, "Tags must be lower-case public aliases."));
    return [];
  }
  const result = uniqueSortedStrings(value);
  if (result.length !== value.length) {
    errors.push(issue(code, "Tags must be unique."));
  }
  return result;
}

/** @param {unknown} value @returns {any} */
function normalizeProvenance(value) {
  if (
    !isPlainObject(value) ||
    Object.keys(value).some((key) => !PROVENANCE_KEYS.has(key))
  ) {
    return null;
  }
  const kind =
    typeof value.kind === "string" &&
    ["USER_SUPPLIED", "PRIVATE_EXPORT", "SYNTHETIC_FIXTURE"].includes(value.kind)
      ? value.kind
      : null;
  const sourceLabel = isPublicAlias(value.sourceLabel) ? value.sourceLabel : null;
  const exporterVersion =
    typeof value.exporterVersion === "string" &&
    TOOL_VERSION.test(value.exporterVersion)
      ? value.exporterVersion
      : null;
  if (
    !kind ||
    !sourceLabel ||
    (value.exporterVersion !== undefined && !exporterVersion)
  ) {
    return null;
  }
  return {
    kind,
    sourceLabel,
    ...(exporterVersion ? { exporterVersion } : {}),
  };
}

/**
 * @param {unknown} value
 * @param {string} code
 * @param {Record<string, unknown>[]} errors
 * @returns {any}
 */
function normalizeProtocolProvenance(value, code, errors) {
  const provenance = normalizeProvenance(value);
  if (!provenance) {
    errors.push(issue(code, "Protocol provenance is missing or malformed."));
  }
  return provenance;
}

/**
 * @param {unknown} value
 * @param {Set<string>} keys
 * @param {string} unknownCode
 * @param {string} invalidCode
 * @param {Record<string, unknown>[]} errors
 * @returns {Record<string, string> | null}
 */
function normalizeAliasObject(value, keys, unknownCode, invalidCode, errors) {
  if (!isPlainObject(value) || !rejectUnknownKeys(value, keys, unknownCode, errors)) {
    errors.push(issue(invalidCode, "Protocol contract fields are malformed."));
    return null;
  }
  /** @type {Record<string, string>} */
  const result = {};
  for (const field of keys) {
    const normalized = requiredAlias(value[field], invalidCode, errors);
    if (!normalized) {
      return null;
    }
    result[field] = normalized;
  }
  return result;
}

/**
 * @param {unknown} value
 * @param {Record<string, unknown>[]} errors
 * @returns {any}
 */
function normalizeLeakageControls(value, errors) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    errors.push(
      issue(
        "INVALID_LEAKAGE_CONTROLS",
        "Leakage controls must contain one to 32 declarations.",
      ),
    );
    return null;
  }
  const controls = [];
  for (const control of value) {
    if (
      !isPlainObject(control) ||
      !rejectUnknownKeys(
        control,
        LEAKAGE_CONTROL_KEYS,
        "UNKNOWN_LEAKAGE_CONTROL_FIELD",
        errors,
      ) ||
      !isPublicAlias(control.controlId) ||
      typeof control.status !== "string" ||
      !["DECLARED", "FAILED", "UNKNOWN"].includes(control.status) ||
      typeof control.evidenceStatus !== "string" ||
      !["DECLARED", "UNKNOWN"].includes(control.evidenceStatus)
    ) {
      errors.push(
        issue("INVALID_LEAKAGE_CONTROL", "A leakage-control declaration is malformed."),
      );
      continue;
    }
    controls.push({
      controlId: control.controlId,
      status: control.status,
      evidenceStatus: control.evidenceStatus,
    });
  }
  return controls.length === value.length ? controls : null;
}

/**
 * @param {unknown} value
 * @param {Record<string, unknown>[]} errors
 * @returns {any[] | null}
 */
function normalizePredeclaredExclusions(value, errors) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 10_000) {
    errors.push(
      issue(
        "INVALID_PREDECLARED_EXCLUSIONS",
        "Predeclared exclusions must be a bounded array.",
      ),
    );
    return null;
  }
  const exclusions = [];
  const caseIds = new Set();
  for (const entry of value) {
    if (
      !isPlainObject(entry) ||
      !rejectUnknownKeys(
        entry,
        PREDECLARED_EXCLUSION_KEYS,
        "UNKNOWN_PREDECLARED_EXCLUSION_FIELD",
        errors,
      ) ||
      !isOpaqueDigestId(entry.caseId) ||
      entry.symmetric !== true ||
      !isOpaqueDigestId(entry.provenanceDigest)
    ) {
      errors.push(
        issue(
          "INVALID_PREDECLARED_EXCLUSION",
          "A predeclared symmetric exclusion is malformed.",
        ),
      );
      continue;
    }
    if (caseIds.has(entry.caseId)) {
      errors.push(
        issue(
          "DUPLICATE_PREDECLARED_EXCLUSION",
          "A case may be predeclared for exclusion only once.",
        ),
      );
      continue;
    }
    caseIds.add(entry.caseId);
    exclusions.push({
      caseId: entry.caseId,
      symmetric: true,
      provenanceDigest: entry.provenanceDigest,
    });
  }
  return exclusions.length === value.length
    ? stableSort(exclusions, (entry) => entry.caseId)
    : null;
}

/**
 * Validate and canonicalize the same closed eval-protocol shape accepted by
 * the public schema. This keeps direct pure-module callers from bypassing the
 * schema boundary used by the CLI.
 *
 * @param {unknown} value
 * @param {Record<string, unknown>[]} errors
 * @returns {any}
 */
function normalizeEvalProtocol(value, errors) {
  const localErrors = [];
  if (value === undefined || value === null) {
    errors.push(
      issue("MISSING_EVAL_PROTOCOL", "Lane bundle requires an eval protocol."),
    );
    return null;
  }
  if (
    !isPlainObject(value) ||
    !rejectUnknownKeys(
      value,
      EVAL_PROTOCOL_KEYS,
      "UNKNOWN_EVAL_PROTOCOL_FIELD",
      localErrors,
    )
  ) {
    localErrors.push(issue("INVALID_EVAL_PROTOCOL", "Eval protocol is malformed."));
    errors.push(...localErrors);
    return null;
  }
  if (value.schemaVersion !== 1) {
    localErrors.push(
      issue(
        "UNSUPPORTED_EVAL_PROTOCOL_SCHEMA",
        "Eval protocol schemaVersion must be 1.",
      ),
    );
  }
  const protocolId = requiredAlias(
    value.protocolId,
    "INVALID_EVAL_PROTOCOL_ID",
    localErrors,
  );
  const protocolVersion = requiredAlias(
    value.protocolVersion,
    "INVALID_EVAL_PROTOCOL_VERSION",
    localErrors,
  );
  const laneId = requiredAlias(value.laneId, "INVALID_EVAL_PROTOCOL_LANE", localErrors);
  const samplingFrame = requiredAlias(
    value.samplingFrame,
    "INVALID_SAMPLING_FRAME",
    localErrors,
  );
  const cohortSelectionDigest = requiredOpaqueId(
    value.cohortSelectionDigest,
    "INVALID_EVAL_COHORT_SELECTION_DIGEST",
    localErrors,
  );
  const cohortWindowId = requiredOpaqueId(
    value.cohortWindowId,
    "INVALID_EVAL_COHORT_WINDOW_ID",
    localErrors,
  );
  const inclusionPolicyId = requiredAlias(
    value.inclusionPolicyId,
    "INVALID_INCLUSION_POLICY_ID",
    localErrors,
  );
  const exclusionPolicyId = requiredAlias(
    value.exclusionPolicyId,
    "INVALID_EXCLUSION_POLICY_ID",
    localErrors,
  );
  const intendedClaim =
    typeof value.intendedClaim === "string" &&
    ["MODEL_ONLY", "ONE_FACTOR", "HOLISTIC_SYSTEM", "SHADOW_NO_POSTING"].includes(
      value.intendedClaim,
    )
      ? value.intendedClaim
      : null;
  const assignmentMethod =
    typeof value.assignmentMethod === "string" &&
    ["PAIRED_SAME_CASE", "RANDOMIZED_BLOCKED", "UNKNOWN"].includes(
      value.assignmentMethod,
    )
      ? value.assignmentMethod
      : null;
  const pairingMethod =
    typeof value.pairingMethod === "string" &&
    ["CASE_VARIANT", "CASE_VARIANT_REPLICATE", "UNKNOWN"].includes(value.pairingMethod)
      ? value.pairingMethod
      : null;
  const missingReplicatePolicy =
    typeof value.missingReplicatePolicy === "string" &&
    ["BLOCK", "SYMMETRIC_EXCLUDE_CASE"].includes(value.missingReplicatePolicy)
      ? value.missingReplicatePolicy
      : null;
  const knownContamination =
    typeof value.knownContamination === "string" &&
    ["NONE_DECLARED", "PRESENT", "UNKNOWN"].includes(value.knownContamination)
      ? value.knownContamination
      : null;
  const expectedExecutionMode =
    typeof value.expectedExecutionMode === "string" &&
    EXECUTION_MODES.has(value.expectedExecutionMode)
      ? value.expectedExecutionMode
      : null;
  if (!intendedClaim) {
    localErrors.push(
      issue("INVALID_INTENDED_CLAIM", "Eval intended claim is invalid."),
    );
  }
  if (!assignmentMethod) {
    localErrors.push(
      issue("INVALID_ASSIGNMENT_METHOD", "Assignment method is invalid."),
    );
  }
  if (!pairingMethod) {
    localErrors.push(issue("INVALID_PAIRING_METHOD", "Pairing method is invalid."));
  }
  if (value.replicateAggregation !== "CASE_PRIMITIVES") {
    localErrors.push(
      issue("INVALID_REPLICATE_AGGREGATION", "Replicates must use case primitives."),
    );
  }
  if (!missingReplicatePolicy) {
    localErrors.push(
      issue("INVALID_MISSING_REPLICATE_POLICY", "Missing-replicate policy is invalid."),
    );
  }
  if (!knownContamination) {
    localErrors.push(
      issue("INVALID_KNOWN_CONTAMINATION", "Known-contamination status is invalid."),
    );
  }
  if (!expectedExecutionMode) {
    localErrors.push(
      issue("INVALID_EXPECTED_EXECUTION_MODE", "Expected execution mode is invalid."),
    );
  }
  const leakageControls = normalizeLeakageControls(value.leakageControls, localErrors);
  const heldConstantFields = normalizeDifferenceAxes(
    value.heldConstantFields,
    localErrors,
  );
  if (Array.isArray(value.heldConstantFields) && value.heldConstantFields.length > 32) {
    localErrors.push(
      issue(
        "INVALID_HELD_CONSTANT_FIELDS",
        "Held constants exceed the 32-field ceiling.",
      ),
    );
  }
  const preservationContracts = normalizeAliasObject(
    value.preservationContracts,
    PRESERVATION_CONTRACT_KEYS,
    "UNKNOWN_PRESERVATION_CONTRACT_FIELD",
    "INVALID_PRESERVATION_CONTRACTS",
    localErrors,
  );
  const provenance = normalizeProtocolProvenance(
    value.provenance,
    "INVALID_EVAL_PROTOCOL_PROVENANCE",
    localErrors,
  );
  const predeclaredExclusions = normalizePredeclaredExclusions(
    value.predeclaredExclusions,
    localErrors,
  );
  if (
    Array.isArray(predeclaredExclusions) &&
    predeclaredExclusions.length > 0 &&
    missingReplicatePolicy !== "SYMMETRIC_EXCLUDE_CASE"
  ) {
    localErrors.push(
      issue(
        "PREDECLARED_EXCLUSION_POLICY_MISMATCH",
        "Predeclared exclusions require the symmetric missing-replicate policy.",
      ),
    );
  }
  errors.push(...localErrors);
  if (
    localErrors.length > 0 ||
    !protocolId ||
    !protocolVersion ||
    !laneId ||
    !samplingFrame ||
    !cohortSelectionDigest ||
    !cohortWindowId ||
    !inclusionPolicyId ||
    !exclusionPolicyId ||
    !intendedClaim ||
    !assignmentMethod ||
    !pairingMethod ||
    !missingReplicatePolicy ||
    !knownContamination ||
    !expectedExecutionMode ||
    !leakageControls ||
    !heldConstantFields ||
    !preservationContracts ||
    !provenance ||
    !predeclaredExclusions
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    protocolId,
    protocolVersion,
    laneId,
    intendedClaim,
    samplingFrame,
    cohortSelectionDigest,
    cohortWindowId,
    inclusionPolicyId,
    exclusionPolicyId,
    assignmentMethod,
    pairingMethod,
    replicateAggregation: "CASE_PRIMITIVES",
    missingReplicatePolicy,
    leakageControls,
    knownContamination,
    heldConstantFields,
    preservationContracts,
    expectedExecutionMode,
    provenance,
    ...(predeclaredExclusions.length > 0 ? { predeclaredExclusions } : {}),
  };
}

/**
 * @param {unknown} value
 * @param {Record<string, unknown>[]} errors
 * @returns {any}
 */
function normalizeAdjudicationProtocol(value, errors) {
  const localErrors = [];
  if (value === undefined || value === null) {
    errors.push(
      issue(
        "MISSING_ADJUDICATION_PROTOCOL",
        "Lane bundle requires an adjudication protocol.",
      ),
    );
    return null;
  }
  if (
    !isPlainObject(value) ||
    !rejectUnknownKeys(
      value,
      ADJUDICATION_PROTOCOL_KEYS,
      "UNKNOWN_ADJUDICATION_PROTOCOL_FIELD",
      localErrors,
    )
  ) {
    localErrors.push(
      issue("INVALID_ADJUDICATION_PROTOCOL", "Adjudication protocol is malformed."),
    );
    errors.push(...localErrors);
    return null;
  }
  if (value.schemaVersion !== 1) {
    localErrors.push(
      issue(
        "UNSUPPORTED_ADJUDICATION_PROTOCOL_SCHEMA",
        "Adjudication protocol schemaVersion must be 1.",
      ),
    );
  }
  const protocolId = requiredAlias(
    value.protocolId,
    "INVALID_ADJUDICATION_PROTOCOL_ID",
    localErrors,
  );
  const protocolVersion = requiredAlias(
    value.protocolVersion,
    "INVALID_ADJUDICATION_PROTOCOL_VERSION",
    localErrors,
  );
  const laneId = requiredAlias(
    value.laneId,
    "INVALID_ADJUDICATION_PROTOCOL_LANE",
    localErrors,
  );
  const rubricId = requiredAlias(
    value.rubricId,
    "INVALID_ADJUDICATION_PROTOCOL_RUBRIC",
    localErrors,
  );
  const labelVersion = requiredAlias(
    value.labelVersion,
    "INVALID_ADJUDICATION_PROTOCOL_LABEL_VERSION",
    localErrors,
  );
  const variantIdentity =
    typeof value.variantIdentity === "string" &&
    ["HIDDEN", "VISIBLE", "UNKNOWN"].includes(value.variantIdentity)
      ? value.variantIdentity
      : null;
  const presentationOrder =
    typeof value.presentationOrder === "string" &&
    ["RANDOMIZED", "FIXED", "UNKNOWN"].includes(value.presentationOrder)
      ? value.presentationOrder
      : null;
  const highCriticalReview =
    typeof value.highCriticalReview === "string" &&
    ["HUMAN", "OTHER", "UNKNOWN"].includes(value.highCriticalReview)
      ? value.highCriticalReview
      : null;
  if (!variantIdentity || !presentationOrder || !highCriticalReview) {
    localErrors.push(
      issue(
        "INVALID_ADJUDICATION_PROTOCOL",
        "Adjudication protocol enums are invalid.",
      ),
    );
  }
  let adjudicatorIndependence = null;
  if (
    isPlainObject(value.adjudicatorIndependence) &&
    rejectUnknownKeys(
      value.adjudicatorIndependence,
      ADJUDICATOR_INDEPENDENCE_KEYS,
      "UNKNOWN_ADJUDICATOR_INDEPENDENCE_FIELD",
      localErrors,
    ) &&
    typeof value.adjudicatorIndependence.status === "string" &&
    ["DECLARED", "UNKNOWN"].includes(value.adjudicatorIndependence.status) &&
    typeof value.adjudicatorIndependence.evidenceStatus === "string" &&
    ["DECLARED", "UNKNOWN"].includes(value.adjudicatorIndependence.evidenceStatus) &&
    isPublicAlias(value.adjudicatorIndependence.provenanceId)
  ) {
    adjudicatorIndependence = {
      status: value.adjudicatorIndependence.status,
      evidenceStatus: value.adjudicatorIndependence.evidenceStatus,
      provenanceId: value.adjudicatorIndependence.provenanceId,
    };
  } else {
    localErrors.push(
      issue(
        "INVALID_ADJUDICATOR_INDEPENDENCE",
        "Adjudicator-independence declaration is malformed.",
      ),
    );
  }
  let disagreement = null;
  if (
    isPlainObject(value.disagreement) &&
    rejectUnknownKeys(
      value.disagreement,
      DISAGREEMENT_KEYS,
      "UNKNOWN_DISAGREEMENT_FIELD",
      localErrors,
    ) &&
    isPublicAlias(value.disagreement.policyId) &&
    typeof value.disagreement.status === "string" &&
    ["COMPLETE", "PARTIAL", "UNKNOWN"].includes(value.disagreement.status) &&
    isNonNegativeInteger(value.disagreement.count) &&
    value.disagreement.count <= 10_000
  ) {
    disagreement = {
      policyId: value.disagreement.policyId,
      status: value.disagreement.status,
      count: value.disagreement.count,
    };
  } else {
    localErrors.push(
      issue("INVALID_DISAGREEMENT", "Disagreement declaration is malformed."),
    );
  }
  const provenance = normalizeProtocolProvenance(
    value.provenance,
    "INVALID_ADJUDICATION_PROTOCOL_PROVENANCE",
    localErrors,
  );
  errors.push(...localErrors);
  if (
    localErrors.length > 0 ||
    !protocolId ||
    !protocolVersion ||
    !laneId ||
    !rubricId ||
    !labelVersion ||
    !variantIdentity ||
    !presentationOrder ||
    !highCriticalReview ||
    !adjudicatorIndependence ||
    !disagreement ||
    !provenance
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    protocolId,
    protocolVersion,
    laneId,
    rubricId,
    labelVersion,
    variantIdentity,
    presentationOrder,
    highCriticalReview,
    adjudicatorIndependence,
    disagreement,
    provenance,
  };
}

/** @param {unknown} value @returns {boolean} */
export function isClosedEvalProtocolContract(value) {
  const errors = [];
  return Boolean(normalizeEvalProtocol(value, errors)) && errors.length === 0;
}

/** @param {unknown} value @returns {boolean} */
export function isClosedAdjudicationProtocolContract(value) {
  const errors = [];
  return Boolean(normalizeAdjudicationProtocol(value, errors)) && errors.length === 0;
}

/**
 * @param {unknown} value
 * @param {Record<string, unknown>[]} errors
 * @returns {any}
 */
function normalizeUsage(value, errors) {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    !isPlainObject(value) ||
    !rejectUnknownKeys(value, USAGE_KEYS, "UNKNOWN_USAGE_FIELD", errors)
  ) {
    errors.push(issue("INVALID_USAGE", "Usage must be a typed token-count object."));
    return null;
  }
  /** @type {Record<string, number>} */
  const result = {};
  for (const field of USAGE_KEYS) {
    if (!isNonNegativeInteger(value[field])) {
      errors.push(issue("INVALID_USAGE", "Token counts must be safe integers."));
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

/**
 * @param {unknown} value
 * @param {Record<string, unknown>[]} errors
 * @returns {any}
 */
function normalizeOutputCounts(value, errors) {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    !isPlainObject(value) ||
    !rejectUnknownKeys(value, OUTPUT_COUNT_KEYS, "UNKNOWN_OUTPUT_COUNT_FIELD", errors)
  ) {
    errors.push(issue("INVALID_OUTPUT_COUNTS", "Output counts are malformed."));
    return null;
  }
  const result = {};
  for (const field of OUTPUT_COUNT_KEYS) {
    if (!isNonNegativeInteger(value[field])) {
      errors.push(
        issue("INVALID_OUTPUT_COUNTS", "Output counts must be safe integers."),
      );
      return null;
    }
    result[field] = value[field];
  }
  return result;
}

/**
 * @param {unknown} value
 * @param {Record<string, unknown>[]} errors
 * @returns {any}
 */
function normalizeComponents(value, errors) {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    !isPlainObject(value) ||
    !rejectUnknownKeys(
      value,
      COST_COMPONENT_KEYS,
      "UNKNOWN_COST_COMPONENT_FIELD",
      errors,
    )
  ) {
    errors.push(issue("INVALID_COST_COMPONENTS", "Cost components are malformed."));
    return null;
  }
  /** @type {Record<string, number>} */
  const result = {};
  for (const field of COST_COMPONENT_KEYS) {
    if (!isNonNegativeInteger(value[field])) {
      errors.push(
        issue("INVALID_COST_COMPONENTS", "Cost components must be integer micros."),
      );
      return null;
    }
    result[field] = value[field];
  }
  return result;
}

/**
 * @param {any} usage
 * @param {number | null} humanReviewMinutes
 * @param {any} rate
 * @returns {any}
 */
function reconstructComponents(usage, humanReviewMinutes, rate) {
  if (!usage || !rate || !isFiniteNumber(humanReviewMinutes)) {
    return null;
  }
  const fields = [
    "inputMicrosPerMillion",
    "cachedInputMicrosPerMillion",
    "outputMicrosPerMillion",
    "toolingMicrosPerRun",
    "humanReviewMicrosPerMinute",
  ];
  if (fields.some((field) => !isNonNegativeInteger(rate[field]))) {
    return null;
  }
  const uncachedInput = usage.inputTokens - usage.cachedInputTokens;
  const modelTerms = [
    uncachedInput * rate.inputMicrosPerMillion,
    usage.cachedInputTokens * rate.cachedInputMicrosPerMillion,
    usage.outputTokens * rate.outputMicrosPerMillion,
  ];
  const humanProduct = humanReviewMinutes * rate.humanReviewMicrosPerMinute;
  if (
    modelTerms.some((term) => !Number.isSafeInteger(term)) ||
    !isFiniteNumber(humanProduct) ||
    Math.abs(humanProduct) > Number.MAX_SAFE_INTEGER
  ) {
    return null;
  }
  const modelMicros = Math.round(sum(modelTerms) / 1_000_000);
  const humanReviewMicros = Math.round(humanProduct);
  if (!isNonNegativeInteger(modelMicros) || !isNonNegativeInteger(humanReviewMicros)) {
    return null;
  }
  return {
    modelMicros,
    toolingMicros: rate.toolingMicrosPerRun,
    humanReviewMicros,
  };
}

/** @param {number[]} values @returns {number | null} */
function safeMicrosSum(values) {
  const total = values.reduce((current, value) => current + value, 0);
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}

/**
 * @param {unknown} value
 * @param {string} variantId
 * @param {any} usage
 * @param {number | null} humanReviewMinutes
 * @param {any} pricingSnapshot
 * @param {Record<string, unknown>[]} errors
 * @returns {any}
 */
function normalizeCost(
  value,
  variantId,
  usage,
  humanReviewMinutes,
  pricingSnapshot,
  errors,
) {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    !isPlainObject(value) ||
    !rejectUnknownKeys(value, COST_KEYS, "UNKNOWN_COST_FIELD", errors)
  ) {
    errors.push(issue("INVALID_COST", "Cost must be a typed micros object."));
    return null;
  }
  const costBasis = normalizedEnum(value.costBasis);
  const costSource = normalizedEnum(value.costSource);
  if (
    !(typeof value.currency === "string" && /^[A-Z]{3}$/u.test(value.currency)) ||
    !isPublicAlias(value.pricingSnapshotId) ||
    !COST_BASES.has(costBasis) ||
    !COST_SOURCES.has(costSource)
  ) {
    errors.push(issue("INVALID_COST", "Cost provenance or basis is invalid."));
    return null;
  }
  if (
    pricingSnapshot &&
    (value.pricingSnapshotId !== pricingSnapshot.snapshotId ||
      value.currency !== pricingSnapshot.currency)
  ) {
    errors.push(
      issue("PRICING_MISMATCH", "Run cost does not match its pricing snapshot."),
    );
    return null;
  }
  const suppliedComponents = normalizeComponents(value.components, errors);
  let components = suppliedComponents;
  let amountMicros = value.amountMicros;
  if (costSource === "RECONSTRUCTED_COMPONENTS") {
    const rate = pricingSnapshot?.ratesByVariant?.get(variantId);
    components = reconstructComponents(usage, humanReviewMinutes, rate);
    if (!components) {
      errors.push(
        issue(
          "UNRECONSTRUCTABLE_COST",
          "Reconstructed cost requires usage, human effort, and exact rates.",
        ),
      );
      return null;
    }
    amountMicros = safeMicrosSum([
      components.modelMicros,
      components.toolingMicros,
      components.humanReviewMicros,
    ]);
  }
  if (!isNonNegativeInteger(amountMicros)) {
    errors.push(issue("INVALID_COST", "Cost amount must be integer micros."));
    return null;
  }
  if (components) {
    const componentTotal = safeMicrosSum([
      components.modelMicros,
      components.toolingMicros,
      components.humanReviewMicros,
    ]);
    if (componentTotal !== amountMicros) {
      errors.push(
        issue("COST_COMPONENT_MISMATCH", "Cost components do not equal total."),
      );
      return null;
    }
  }
  if (costBasis === "FULLY_LOADED" && !components) {
    errors.push(
      issue(
        "INCOMPLETE_FULLY_LOADED_COST",
        "Fully loaded cost requires model, tooling, and human components.",
      ),
    );
    return null;
  }
  return {
    currency: value.currency,
    amountMicros,
    costBasis,
    costSource,
    pricingSnapshotId: value.pricingSnapshotId,
    components,
  };
}

/**
 * @param {unknown} value
 * @param {Record<string, unknown>[]} errors
 * @returns {any}
 */
function normalizeFinding(value, errors) {
  if (
    !isPlainObject(value) ||
    !rejectUnknownKeys(value, FINDING_KEYS, "UNKNOWN_FINDING_FIELD", errors)
  ) {
    errors.push(issue("INVALID_FINDING", "Finding must be a typed object."));
    return null;
  }
  const findingId = requiredOpaqueId(value.findingId, "INVALID_FINDING_ID", errors);
  const severity = normalizedEnum(value.severity);
  const verification =
    value.verification === undefined || value.verification === null
      ? null
      : normalizedEnum(value.verification);
  const category =
    value.category === undefined || value.category === null
      ? null
      : normalizedEnum(value.category);
  if (!SEVERITIES.has(severity)) {
    errors.push(issue("INVALID_FINDING_SEVERITY", "Unsupported severity."));
  }
  if (verification !== null && !VERIFICATIONS.has(verification)) {
    errors.push(
      issue("INVALID_FINDING_VERIFICATION", "Unsupported verification state."),
    );
  }
  if (category !== null && !CATEGORIES.has(category)) {
    errors.push(issue("INVALID_FINDING_CATEGORY", "Unsupported finding category."));
  }
  if (
    !findingId ||
    !SEVERITIES.has(severity) ||
    (verification && !VERIFICATIONS.has(verification)) ||
    (category && !CATEGORIES.has(category))
  ) {
    return null;
  }
  return {
    findingId,
    severity,
    category,
    verification,
    tags: normalizeTags(value.tags, "INVALID_FINDING_TAGS", errors),
  };
}

/**
 * @param {unknown} value
 * @param {Record<string, unknown>[]} errors
 * @returns {any}
 */
function normalizeFindingLabel(value, errors) {
  if (
    !isPlainObject(value) ||
    !rejectUnknownKeys(value, FINDING_LABEL_KEYS, "UNKNOWN_FINDING_LABEL_FIELD", errors)
  ) {
    errors.push(issue("INVALID_FINDING_LABEL", "Finding label is malformed."));
    return null;
  }
  const findingId = requiredOpaqueId(
    value.findingId,
    "INVALID_FINDING_LABEL_ID",
    errors,
  );
  const outcome = normalizedEnum(value.outcome);
  const matches = value.matchedRootCauseIds ?? [];
  if (
    !Array.isArray(matches) ||
    matches.some((rootCauseId) => !isOpaqueDigestId(rootCauseId)) ||
    new Set(matches).size !== matches.length
  ) {
    errors.push(
      issue("INVALID_ROOT_CAUSE_MATCHES", "Root-cause matches must be unique IDs."),
    );
  }
  if (!OUTCOMES.has(outcome)) {
    errors.push(issue("INVALID_FINDING_OUTCOME", "Unsupported finding outcome."));
  }
  if (outcome === "REJECTED" && Array.isArray(matches) && matches.length > 0) {
    errors.push(
      issue(
        "CONTRADICTORY_ADJUDICATION",
        "Rejected findings cannot confirm root causes.",
      ),
    );
  }
  if (
    !findingId ||
    !OUTCOMES.has(outcome) ||
    !Array.isArray(matches) ||
    matches.some((rootCauseId) => !isOpaqueDigestId(rootCauseId))
  ) {
    return null;
  }
  return {
    findingId,
    outcome,
    matchedRootCauseIds: [...new Set(matches)].sort(compareText),
  };
}

/**
 * @param {unknown} value
 * @param {Record<string, unknown>[]} errors
 * @returns {any}
 */
function normalizeRootCauseAssessment(value, errors) {
  if (
    !isPlainObject(value) ||
    !rejectUnknownKeys(
      value,
      ROOT_CAUSE_ASSESSMENT_KEYS,
      "UNKNOWN_ROOT_CAUSE_ASSESSMENT_FIELD",
      errors,
    )
  ) {
    errors.push(issue("INVALID_ROOT_CAUSE_ASSESSMENT", "Assessment is malformed."));
    return null;
  }
  const rootCauseId = requiredOpaqueId(
    value.rootCauseId,
    "INVALID_ROOT_CAUSE_ID",
    errors,
  );
  const qualityRubricId = requiredAlias(
    value.qualityRubricId,
    "INVALID_QUALITY_RUBRIC_ID",
    errors,
  );
  if (
    !isFiniteNumber(value.qualityScore) ||
    value.qualityScore < 0 ||
    value.qualityScore > 1
  ) {
    errors.push(
      issue("INVALID_ROOT_CAUSE_QUALITY", "Quality score must be between 0 and 1."),
    );
  }
  if (!rootCauseId || !qualityRubricId || !isFiniteNumber(value.qualityScore)) {
    return null;
  }
  return {
    rootCauseId,
    qualityScore: roundNumber(value.qualityScore),
    qualityRubricId,
  };
}

/**
 * @param {unknown} value
 * @param {Record<string, unknown>[]} errors
 * @returns {any}
 */
function normalizeAdjudication(value, errors) {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    !isPlainObject(value) ||
    !rejectUnknownKeys(value, ADJUDICATION_KEYS, "UNKNOWN_ADJUDICATION_FIELD", errors)
  ) {
    errors.push(issue("INVALID_ADJUDICATION", "Adjudication is malformed."));
    return null;
  }
  const status = normalizedEnum(value.status);
  const rubricId = requiredAlias(value.rubricId, "INVALID_ADJUDICATION_RUBRIC", errors);
  const labelVersion = isNonEmptyString(value.labelVersion) ? value.labelVersion : null;
  if (!labelVersion) {
    errors.push(
      issue("INVALID_ADJUDICATION_LABEL_VERSION", "Label version is missing."),
    );
  }
  if (!ADJUDICATION_STATUSES.has(status)) {
    errors.push(
      issue("INVALID_ADJUDICATION_STATUS", "Unsupported adjudication status."),
    );
  }
  if (!Array.isArray(value.findingLabels)) {
    errors.push(issue("INVALID_FINDING_LABELS", "Finding labels must be an array."));
    return null;
  }
  const findingLabels = value.findingLabels
    .map((item) => normalizeFindingLabel(item, errors))
    .filter(Boolean);
  const rootCauseAssessments = Array.isArray(value.rootCauseAssessments)
    ? value.rootCauseAssessments
        .map((item) => normalizeRootCauseAssessment(item, errors))
        .filter(Boolean)
    : [];
  if (
    value.rootCauseAssessments !== undefined &&
    !Array.isArray(value.rootCauseAssessments)
  ) {
    errors.push(
      issue(
        "INVALID_ROOT_CAUSE_ASSESSMENTS",
        "Root-cause assessments must be an array.",
      ),
    );
  }
  const findingIds = findingLabels.map((item) => item.findingId);
  const assessmentIds = rootCauseAssessments.map((item) => item.rootCauseId);
  if (new Set(findingIds).size !== findingIds.length) {
    errors.push(issue("DUPLICATE_FINDING_LABEL", "A finding has duplicate labels."));
  }
  if (new Set(assessmentIds).size !== assessmentIds.length) {
    errors.push(
      issue("DUPLICATE_ROOT_CAUSE_ASSESSMENT", "A root cause has duplicate scores."),
    );
  }
  if (!ADJUDICATION_STATUSES.has(status) || !rubricId || !labelVersion) {
    return null;
  }
  return {
    status,
    rubricId,
    labelVersion,
    findingLabels: stableSort(findingLabels, (item) => item.findingId),
    rootCauseAssessments: stableSort(rootCauseAssessments, (item) => item.rootCauseId),
  };
}

/**
 * @param {unknown} value
 * @param {any} pricingSnapshot
 * @param {Record<string, unknown>[]} errors
 * @returns {any}
 */
function normalizeRun(value, pricingSnapshot, errors) {
  if (
    !isPlainObject(value) ||
    !rejectUnknownKeys(value, RUN_KEYS, "UNKNOWN_RUN_FIELD", errors)
  ) {
    errors.push(issue("INVALID_RUN", "Run record is malformed."));
    return null;
  }
  if (value.schemaVersion !== 1) {
    errors.push(issue("UNSUPPORTED_RUN_SCHEMA", "Run schemaVersion must be 1."));
  }
  const caseId = requiredOpaqueId(value.caseId, "INVALID_CASE_ID", errors);
  const variantId = requiredAlias(value.variantId, "INVALID_VARIANT_ID", errors);
  const architectureId = requiredAlias(
    value.architectureId,
    "INVALID_ARCHITECTURE_ID",
    errors,
  );
  const architectureStructuralDigest = requiredOpaqueId(
    value.architectureStructuralDigest,
    "INVALID_ARCHITECTURE_DIGEST",
    errors,
  );
  const runId = requiredOpaqueId(value.runId, "INVALID_RUN_ID", errors);
  const replicateId = requiredAlias(value.replicateId, "INVALID_REPLICATE_ID", errors);
  const contextDigest = requiredOpaqueId(
    value.contextDigest,
    "INVALID_CONTEXT_DIGEST",
    errors,
  );
  const startedAt = normalizedTimestamp(value.startedAt);
  if (!startedAt) {
    errors.push(issue("INVALID_STARTED_AT", "Run timestamp must be UTC."));
  }
  if (!isNonNegativeInteger(value.latencyMs)) {
    errors.push(issue("INVALID_LATENCY", "Latency must be integer milliseconds."));
  }
  const contractFields = [
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
  const contracts = {};
  for (const field of contractFields) {
    contracts[field] = requiredAlias(
      value[field],
      "INVALID_" + field.toUpperCase(),
      errors,
    );
  }
  const usage = normalizeUsage(value.usage, errors);
  const outputCounts = normalizeOutputCounts(value.outputCounts, errors);
  const humanReviewMinutes =
    value.humanReviewMinutes === undefined || value.humanReviewMinutes === null
      ? null
      : isNonNegativeNumber(value.humanReviewMinutes)
        ? roundNumber(value.humanReviewMinutes)
        : null;
  if (
    value.humanReviewMinutes !== undefined &&
    value.humanReviewMinutes !== null &&
    humanReviewMinutes === null
  ) {
    errors.push(
      issue("INVALID_HUMAN_REVIEW_MINUTES", "Human review must be non-negative."),
    );
  }
  const findingsSource = value.findings;
  if (!Array.isArray(findingsSource)) {
    errors.push(issue("INVALID_FINDINGS", "Findings must be an array."));
  }
  const findings = Array.isArray(findingsSource)
    ? findingsSource.map((item) => normalizeFinding(item, errors)).filter(Boolean)
    : [];
  const findingIds = findings.map((item) => item.findingId);
  if (new Set(findingIds).size !== findingIds.length) {
    errors.push(issue("DUPLICATE_FINDING_ID", "A run repeats a finding ID."));
  }
  const adjudication = normalizeAdjudication(value.adjudication, errors);
  if (adjudication) {
    const knownFindings = new Set(findingIds);
    for (const label of adjudication.findingLabels) {
      if (!knownFindings.has(label.findingId)) {
        errors.push(
          issue(
            "UNKNOWN_ADJUDICATED_FINDING",
            "Adjudication references an unknown finding.",
          ),
        );
      }
    }
  }
  const cost = variantId
    ? normalizeCost(
        value.cost,
        variantId,
        usage,
        humanReviewMinutes,
        pricingSnapshot,
        errors,
      )
    : null;
  if (
    value.schemaVersion !== 1 ||
    !caseId ||
    !variantId ||
    !architectureId ||
    !architectureStructuralDigest ||
    !runId ||
    !replicateId ||
    !contextDigest ||
    !startedAt ||
    !isNonNegativeInteger(value.latencyMs) ||
    contractFields.some((field) => !contracts[field]) ||
    !Array.isArray(findingsSource)
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    caseId,
    variantId,
    architectureId,
    architectureStructuralDigest,
    runId,
    replicateId,
    contextDigest,
    ...contracts,
    startedAt,
    latencyMs: value.latencyMs,
    usage,
    outputCounts,
    cost,
    humanReviewMinutes,
    findings: stableSort(findings, (item) => item.findingId),
    adjudication,
  };
}

/**
 * @param {unknown} value
 * @param {Record<string, unknown>[]} errors
 * @returns {any}
 */
function normalizeCaseLabel(value, errors) {
  if (
    !isPlainObject(value) ||
    !rejectUnknownKeys(value, CASE_LABEL_KEYS, "UNKNOWN_CASE_LABEL_FIELD", errors)
  ) {
    errors.push(issue("INVALID_CASE_LABEL", "Case label is malformed."));
    return null;
  }
  if (value.schemaVersion !== 1) {
    errors.push(
      issue("UNSUPPORTED_CASE_LABEL_SCHEMA", "Case-label schemaVersion must be 1."),
    );
  }
  const caseId = requiredOpaqueId(value.caseId, "INVALID_CASE_LABEL_ID", errors);
  const rubricId = requiredAlias(value.rubricId, "INVALID_CASE_LABEL_RUBRIC", errors);
  const labelVersion = isNonEmptyString(value.labelVersion) ? value.labelVersion : null;
  if (!labelVersion) {
    errors.push(issue("INVALID_CASE_LABEL_VERSION", "Label version is missing."));
  }
  const riskSliceIds =
    value.riskSliceIds === undefined
      ? []
      : normalizeStringArray(value.riskSliceIds, "INVALID_RISK_SLICES", errors);
  if (!Array.isArray(value.groundTruth)) {
    errors.push(issue("INVALID_GROUND_TRUTH", "Ground truth must be an array."));
    return null;
  }
  const groundTruth = [];
  for (const item of value.groundTruth) {
    if (
      !isPlainObject(item) ||
      !rejectUnknownKeys(item, GROUND_TRUTH_KEYS, "UNKNOWN_GROUND_TRUTH_FIELD", errors)
    ) {
      errors.push(issue("INVALID_GROUND_TRUTH", "Ground truth is malformed."));
      continue;
    }
    const rootCauseId = requiredOpaqueId(
      item.rootCauseId,
      "INVALID_ROOT_CAUSE_ID",
      errors,
    );
    const severity = normalizedEnum(item.severity);
    if (!SEVERITIES.has(severity)) {
      errors.push(issue("INVALID_ROOT_CAUSE_SEVERITY", "Unsupported severity."));
    }
    if (rootCauseId && SEVERITIES.has(severity)) {
      groundTruth.push({
        rootCauseId,
        severity,
        tags: normalizeTags(item.tags, "INVALID_ROOT_CAUSE_TAGS", errors),
      });
    }
  }
  const rootCauseIds = groundTruth.map((item) => item.rootCauseId);
  if (new Set(rootCauseIds).size !== rootCauseIds.length) {
    errors.push(issue("DUPLICATE_ROOT_CAUSE_ID", "A case repeats a root-cause ID."));
  }
  if (
    value.schemaVersion !== 1 ||
    !caseId ||
    !rubricId ||
    !labelVersion ||
    !riskSliceIds
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    caseId,
    rubricId,
    labelVersion,
    riskSliceIds,
    groundTruth: stableSort(groundTruth, (item) => item.rootCauseId),
    provenance: normalizeProvenance(value.provenance),
  };
}

/**
 * @param {unknown} value
 * @param {Record<string, unknown>[]} errors
 * @returns {any}
 */
function normalizeCandidate(value, errors) {
  if (
    !isPlainObject(value) ||
    !rejectUnknownKeys(value, CANDIDATE_KEYS, "UNKNOWN_CANDIDATE_FIELD", errors)
  ) {
    errors.push(issue("INVALID_CANDIDATE_CONFIG", "Candidate config is malformed."));
    return null;
  }
  if (value.schemaVersion !== 1) {
    errors.push(
      issue("UNSUPPORTED_CANDIDATE_SCHEMA", "Candidate schemaVersion must be 1."),
    );
  }
  const variantId = requiredAlias(value.variantId, "INVALID_VARIANT_ID", errors);
  const architectureId = requiredAlias(
    value.architectureId,
    "INVALID_ARCHITECTURE_ID",
    errors,
  );
  const architectureStructuralDigest = requiredOpaqueId(
    value.architectureStructuralDigest,
    "INVALID_ARCHITECTURE_DIGEST",
    errors,
  );
  const aliasFields = [
    "modelAlias",
    "reasoningClass",
    "contextClass",
    "toolContractId",
    "controllerContractId",
    "validatorContractId",
    "dedupePolicyId",
    "postingPolicyId",
    "retryPolicyId",
    "timeoutPolicyId",
    "routingPolicyId",
  ];
  const digestFields = ["promptStructuralDigest", "configStructuralDigest"];
  const result = {
    schemaVersion: 1,
    variantId,
    architectureId,
    architectureStructuralDigest,
  };
  for (const field of aliasFields) {
    result[field] = requiredAlias(
      value[field],
      "INVALID_" + field.toUpperCase(),
      errors,
    );
  }
  for (const field of digestFields) {
    result[field] = requiredOpaqueId(
      value[field],
      "INVALID_" + field.toUpperCase(),
      errors,
    );
  }
  if (
    value.schemaVersion !== 1 ||
    !variantId ||
    !architectureId ||
    !architectureStructuralDigest ||
    [...aliasFields, ...digestFields].some((field) => !result[field])
  ) {
    return null;
  }
  return result;
}

/**
 * @param {unknown} value
 * @param {Record<string, unknown>[]} errors
 * @returns {any}
 */
function normalizePricingSnapshot(value, errors) {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    !isPlainObject(value) ||
    !rejectUnknownKeys(value, PRICING_KEYS, "UNKNOWN_PRICING_FIELD", errors)
  ) {
    errors.push(issue("INVALID_PRICING_SNAPSHOT", "Pricing snapshot is malformed."));
    return null;
  }
  if (value.schemaVersion !== 1) {
    errors.push(
      issue("UNSUPPORTED_PRICING_SCHEMA", "Pricing schemaVersion must be 1."),
    );
  }
  const snapshotId = requiredAlias(value.snapshotId, "INVALID_PRICING_ID", errors);
  const currency =
    typeof value.currency === "string" && /^[A-Z]{3}$/u.test(value.currency)
      ? value.currency
      : null;
  if (!currency) {
    errors.push(
      issue("INVALID_PRICING_CURRENCY", "Currency must be an uppercase ISO code."),
    );
  }
  const effectiveAt = normalizedTimestamp(value.effectiveAt);
  if (!effectiveAt) {
    errors.push(
      issue("INVALID_PRICING_EFFECTIVE_AT", "Pricing timestamp must be UTC."),
    );
  }
  const costBasis = normalizedEnum(value.costBasis);
  if (!COST_BASES.has(costBasis)) {
    errors.push(issue("INVALID_PRICING_COST_BASIS", "Unsupported cost basis."));
  }
  if (!Array.isArray(value.rates)) {
    errors.push(issue("INVALID_PRICING_RATES", "Pricing rates must be an array."));
    return null;
  }
  const rates = [];
  for (const rate of value.rates) {
    if (
      !isPlainObject(rate) ||
      !rejectUnknownKeys(rate, PRICING_RATE_KEYS, "UNKNOWN_PRICING_RATE_FIELD", errors)
    ) {
      errors.push(issue("INVALID_PRICING_RATE", "Pricing rate is malformed."));
      continue;
    }
    const variantId = requiredAlias(rate.variantId, "INVALID_PRICING_VARIANT", errors);
    const numericFields = [...PRICING_RATE_KEYS].filter(
      (field) => field !== "variantId",
    );
    if (numericFields.some((field) => !isNonNegativeInteger(rate[field]))) {
      errors.push(
        issue("INVALID_PRICING_RATE", "Pricing rates must be integer micros."),
      );
      continue;
    }
    if (variantId) {
      rates.push({
        variantId,
        ...Object.fromEntries(numericFields.map((field) => [field, rate[field]])),
      });
    }
  }
  const rateIds = rates.map((rate) => rate.variantId);
  if (new Set(rateIds).size !== rateIds.length) {
    errors.push(issue("DUPLICATE_PRICING_RATE", "Pricing repeats a variant."));
  }
  if (
    value.schemaVersion !== 1 ||
    !snapshotId ||
    !currency ||
    !effectiveAt ||
    !COST_BASES.has(costBasis)
  ) {
    return null;
  }
  const orderedRates = stableSort(rates, (rate) => rate.variantId);
  return {
    schemaVersion: 1,
    snapshotId,
    currency,
    effectiveAt,
    costBasis,
    provenance: normalizeProvenance(value.provenance),
    rates: orderedRates,
    ratesByVariant: new Map(orderedRates.map((rate) => [rate.variantId, rate])),
  };
}

/**
 * @param {unknown} value
 * @param {Record<string, unknown>[]} errors
 * @returns {any}
 */
function normalizeManifest(value, errors) {
  if (value === undefined || value === null) {
    errors.push(issue("MISSING_MANIFEST", "Lane bundle requires a manifest."));
    return null;
  }
  if (
    !isPlainObject(value) ||
    !rejectUnknownKeys(value, MANIFEST_KEYS, "UNKNOWN_MANIFEST_FIELD", errors)
  ) {
    errors.push(issue("INVALID_MANIFEST", "Benchmark manifest is malformed."));
    return null;
  }
  if (value.schemaVersion !== 1) {
    errors.push(
      issue("UNSUPPORTED_MANIFEST_SCHEMA", "Manifest schemaVersion must be 1."),
    );
  }
  const corpusId = requiredOpaqueId(value.corpusId, "INVALID_CORPUS_ID", errors);
  const exporterVersion = requiredToolVersion(
    value.exporterVersion,
    "INVALID_EXPORTER_VERSION",
    errors,
  );
  const exportedAt = normalizedTimestamp(value.exportedAt);
  if (!exportedAt) {
    errors.push(issue("INVALID_EXPORTED_AT", "Manifest timestamp must be UTC."));
  }
  const rubricId = requiredAlias(value.rubricId, "INVALID_MANIFEST_RUBRIC", errors);
  const pricingSnapshotId = requiredAlias(
    value.pricingSnapshotId,
    "INVALID_MANIFEST_PRICING",
    errors,
  );
  const structuralReceipts = normalizeStructuralReceipts(
    value.structuralReceipts,
    errors,
  );
  const labelVersion = isNonEmptyString(value.labelVersion) ? value.labelVersion : null;
  if (!labelVersion) {
    errors.push(issue("INVALID_MANIFEST_LABEL_VERSION", "Label version is missing."));
  }
  const caseIds =
    Array.isArray(value.caseIds) &&
    value.caseIds.every((item) => isOpaqueDigestId(item)) &&
    new Set(value.caseIds).size === value.caseIds.length
      ? [...value.caseIds].sort(compareText)
      : null;
  if (!caseIds) {
    errors.push(issue("INVALID_MANIFEST_CASES", "Manifest case IDs are invalid."));
  }
  const variantIds = normalizeStringArray(
    value.variantIds,
    "INVALID_MANIFEST_VARIANTS",
    errors,
  );
  let lane = null;
  if (
    isPlainObject(value.lane) &&
    rejectUnknownKeys(value.lane, LANE_KEYS, "UNKNOWN_LANE_FIELD", errors)
  ) {
    const laneId = requiredAlias(value.lane.laneId, "INVALID_LANE_ID", errors);
    const laneType = normalizedEnum(value.lane.laneType);
    const baselineVariantId = requiredAlias(
      value.lane.baselineVariantId,
      "INVALID_BASELINE_VARIANT",
      errors,
    );
    const cohortSelectionDigest = requiredOpaqueId(
      value.lane.cohortSelectionDigest,
      "INVALID_COHORT_SELECTION_DIGEST",
      errors,
    );
    const cohortWindowId = requiredOpaqueId(
      value.lane.cohortWindowId,
      "INVALID_COHORT_WINDOW_ID",
      errors,
    );
    const allowedDifferenceAxes = normalizeDifferenceAxes(
      value.lane.allowedDifferenceAxes,
      errors,
    );
    const executionMode = normalizedEnum(value.lane.executionMode);
    if (!LANE_TYPES.has(laneType)) {
      errors.push(issue("INVALID_LANE_TYPE", "Unsupported lane type."));
    }
    if (!EXECUTION_MODES.has(executionMode)) {
      errors.push(issue("INVALID_EXECUTION_MODE", "Unsupported execution mode."));
    }
    if (
      laneId &&
      LANE_TYPES.has(laneType) &&
      baselineVariantId &&
      cohortSelectionDigest &&
      cohortWindowId &&
      allowedDifferenceAxes &&
      EXECUTION_MODES.has(executionMode)
    ) {
      lane = {
        laneId,
        laneType,
        baselineVariantId,
        cohortSelectionDigest,
        cohortWindowId,
        allowedDifferenceAxes,
        executionMode,
      };
    }
  } else {
    errors.push(issue("INVALID_LANE", "Manifest lane contract is missing."));
  }
  let sliceTaxonomy = null;
  if (
    isPlainObject(value.sliceTaxonomy) &&
    rejectUnknownKeys(
      value.sliceTaxonomy,
      SLICE_TAXONOMY_KEYS,
      "UNKNOWN_SLICE_TAXONOMY_FIELD",
      errors,
    )
  ) {
    const taxonomyId = requiredAlias(
      value.sliceTaxonomy.taxonomyId,
      "INVALID_SLICE_TAXONOMY_ID",
      errors,
    );
    const version = isNonEmptyString(value.sliceTaxonomy.version)
      ? value.sliceTaxonomy.version
      : null;
    const sliceIds = normalizeStringArray(
      value.sliceTaxonomy.sliceIds,
      "INVALID_SLICE_IDS",
      errors,
    );
    if (taxonomyId && version && sliceIds) {
      sliceTaxonomy = { taxonomyId, version, sliceIds };
    }
  } else {
    errors.push(issue("INVALID_SLICE_TAXONOMY", "Manifest slice taxonomy is missing."));
  }
  let productionBaselineContracts = null;
  if (
    isPlainObject(value.productionBaselineContracts) &&
    rejectUnknownKeys(
      value.productionBaselineContracts,
      BASELINE_CONTRACT_KEYS,
      "UNKNOWN_BASELINE_CONTRACT_FIELD",
      errors,
    )
  ) {
    const result = {};
    for (const field of BASELINE_CONTRACT_KEYS) {
      result[field] = requiredAlias(
        value.productionBaselineContracts[field],
        "INVALID_" + field.toUpperCase(),
        errors,
      );
    }
    if ([...BASELINE_CONTRACT_KEYS].every((field) => result[field])) {
      productionBaselineContracts = result;
    }
  } else {
    errors.push(
      issue(
        "INVALID_PRODUCTION_BASELINE_CONTRACTS",
        "Production baseline contracts are missing.",
      ),
    );
  }
  if (
    value.schemaVersion !== 1 ||
    !corpusId ||
    !exporterVersion ||
    !exportedAt ||
    !caseIds ||
    !variantIds ||
    !rubricId ||
    !labelVersion ||
    !pricingSnapshotId ||
    !lane ||
    !sliceTaxonomy ||
    !productionBaselineContracts
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    corpusId,
    exporterVersion,
    exportedAt,
    caseIds,
    variantIds,
    rubricId,
    labelVersion,
    pricingSnapshotId,
    redactionPolicyVersion: isNonEmptyString(value.redactionPolicyVersion)
      ? value.redactionPolicyVersion
      : null,
    lane,
    sliceTaxonomy,
    productionBaselineContracts,
    structuralReceipts,
  };
}

/** @param {unknown} value @returns {unknown[]} */
function recordArray(value) {
  if (!isPlainObject(value)) {
    return [];
  }
  const source =
    value.runs ??
    value.exports ??
    value.exportRecords ??
    value.canonicalRunRecords ??
    value.records;
  if (!Array.isArray(source)) {
    return [];
  }
  return source.map((record) =>
    isPlainObject(record) && isPlainObject(record.runRecord)
      ? record.runRecord
      : isPlainObject(record) && isPlainObject(record.run)
        ? record.run
        : record,
  );
}

/** @param {unknown} value @returns {unknown[]} */
function caseLabelArray(value) {
  if (!isPlainObject(value)) {
    return [];
  }
  return Array.isArray(value.caseLabels) ? value.caseLabels : [];
}

/** @param {unknown} value @returns {unknown[]} */
function candidateArray(value) {
  if (!isPlainObject(value)) {
    return [];
  }
  const candidates = value.candidateConfigs ?? value.candidates;
  return Array.isArray(candidates) ? candidates : [];
}

/**
 * @param {any} value
 * @param {Record<string, unknown>[]} errors
 * @returns {any}
 */
function exportSummary(value, errors) {
  if (!isPlainObject(value) || !Array.isArray(value.exports)) {
    return {
      sourceMode: Array.isArray(value?.canonicalRunRecords)
        ? "CANONICAL_RECORDS"
        : Array.isArray(value?.runs) || Array.isArray(value?.records)
          ? "CANONICAL_RECORDS"
          : "SANITIZED_EXPORT",
      exportIds: [],
      exporterVersions: [],
    };
  }
  const exportIds = [];
  const exporterVersions = [];
  for (const record of value.exports) {
    if (
      !isPlainObject(record) ||
      !rejectUnknownKeys(record, EXPORT_KEYS, "UNKNOWN_EXPORT_FIELD", errors) ||
      record.schemaVersion !== 1 ||
      !isOpaqueDigestId(record.exportId) ||
      typeof record.exporterVersion !== "string" ||
      !TOOL_VERSION.test(record.exporterVersion) ||
      !isPlainObject(record.runRecord) ||
      !normalizeProvenance(record.provenance)
    ) {
      errors.push(
        issue("INVALID_EXPORT_RECORD", "Sanitized export wrapper is malformed."),
      );
      continue;
    }
    exportIds.push(record.exportId);
    exporterVersions.push(record.exporterVersion);
  }
  if (new Set(exportIds).size !== exportIds.length) {
    errors.push(issue("DUPLICATE_EXPORT_ID", "Export IDs must be unique."));
  }
  return {
    sourceMode: "SANITIZED_EXPORT",
    exportIds: uniqueSortedStrings(exportIds),
    exporterVersions: uniqueSortedStrings(exporterVersions),
  };
}

/**
 * @param {any} run
 * @param {any} caseLabel
 * @param {any} rubric
 * @param {Record<string, unknown>[]} errors
 */
function validateRootCauseReferences(run, caseLabel, rubric, errors) {
  if (!run.adjudication || !caseLabel) {
    return;
  }
  const groundTruthIds = new Set(caseLabel.groundTruth.map((item) => item.rootCauseId));
  const matching = rubric?.matching ?? rubric?.matchingRules ?? {};
  const matchesByRootCause = new Map();
  for (const label of run.adjudication.findingLabels) {
    for (const rootCauseId of label.matchedRootCauseIds) {
      if (!groundTruthIds.has(rootCauseId)) {
        errors.push(
          issue(
            "UNKNOWN_ROOT_CAUSE_MATCH",
            "Adjudication references a root cause outside case labels.",
          ),
        );
      }
      const count = matchesByRootCause.get(rootCauseId) ?? 0;
      matchesByRootCause.set(rootCauseId, count + 1);
    }
    if (
      label.matchedRootCauseIds.length > 1 &&
      matching.oneFindingMayMatchManyRootCauses !== true &&
      matching.allowOneFindingMultipleRootCauses !== true
    ) {
      errors.push(
        issue(
          "CONTRADICTORY_ROOT_CAUSE_MATCH",
          "One finding matches multiple root causes without rubric permission.",
        ),
      );
    }
  }
  if (
    matching.manyFindingsMayMatchOneRootCause !== true &&
    matching.allowMultipleFindingsPerRootCause !== true &&
    [...matchesByRootCause.values()].some((count) => count > 1)
  ) {
    errors.push(
      issue(
        "CONTRADICTORY_ROOT_CAUSE_MATCH",
        "Multiple findings match one root cause without rubric permission.",
      ),
    );
  }
  for (const assessment of run.adjudication.rootCauseAssessments) {
    if (!groundTruthIds.has(assessment.rootCauseId)) {
      errors.push(
        issue(
          "UNKNOWN_ROOT_CAUSE_ASSESSMENT",
          "Quality assessment references an unknown root cause.",
        ),
      );
    }
    if (assessment.qualityRubricId !== run.adjudication.rubricId) {
      errors.push(
        issue(
          "ROOT_CAUSE_QUALITY_RUBRIC_MISMATCH",
          "Quality assessment uses a different rubric.",
        ),
      );
    }
  }
}

/**
 * @param {unknown} protocol
 * @param {string | null} caseId
 * @returns {boolean}
 */
function isSafeDeclaredExclusion(protocol, caseId) {
  if (!caseId || !isPlainObject(protocol)) {
    return false;
  }
  if (protocol.missingReplicatePolicy !== "SYMMETRIC_EXCLUDE_CASE") {
    return false;
  }
  const exclusions = protocol.predeclaredExclusions;
  if (!Array.isArray(exclusions)) {
    return false;
  }
  return exclusions.some(
    (entry) =>
      isPlainObject(entry) &&
      entry.caseId === caseId &&
      entry.symmetric === true &&
      isOpaqueDigestId(entry.provenanceDigest),
  );
}

/**
 * Normalize one already-loaded lane bundle. The returned report is safe to
 * render; canonical records remain available only on the in-memory result.
 *
 * @param {unknown} input
 * @returns {any}
 */
export function normalizeLaneBundle(input) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(input)) {
    const invalid = issue(
      "INVALID_LANE_BUNDLE",
      "Lane bundle must be an already-loaded object.",
    );
    return {
      schemaVersion: 1,
      status: "BLOCKED",
      bundleId: null,
      laneId: null,
      laneType: null,
      errors: [invalid],
      warnings: [],
      reasonCodes: ["INVALID_LANE_BUNDLE"],
      report: {
        schemaVersion: 1,
        status: "BLOCKED",
        errors: [invalid],
        warnings: [],
        reasonCodes: ["INVALID_LANE_BUNDLE"],
      },
      runs: [],
      caseLabels: [],
      caseLabelsById: new Map(),
      candidateConfigs: [],
      candidatesById: new Map(),
      manifest: null,
      lane: null,
      pricingSnapshot: null,
      rubric: null,
      evalProtocol: null,
      adjudicationProtocol: null,
      rankingEligible: false,
    };
  }
  const forbidden = forbiddenPaths(input);
  if (forbidden.length > 0) {
    errors.push(
      issue("UNSAFE_RAW_FIELD", "Bundle includes forbidden raw-data fields.", {
        paths: forbidden.slice(0, 16).sort(compareText),
      }),
    );
  }
  const bundleId = isPublicAlias(input.bundleId) ? input.bundleId : null;
  if (!bundleId) {
    errors.push(issue("INVALID_BUNDLE_ID", "Bundle ID must be a public alias."));
  }
  const manifest = normalizeManifest(input.manifest ?? input.benchmarkManifest, errors);
  const pricingSnapshot = normalizePricingSnapshot(input.pricingSnapshot, errors);
  const rubric = isPlainObject(input.rubric) ? input.rubric : null;
  if (!rubric) {
    warnings.push(issue("MISSING_RUBRIC", "Rubric evidence is missing."));
  }
  const evalProtocol = normalizeEvalProtocol(input.evalProtocol, errors);
  const adjudicationProtocol = normalizeAdjudicationProtocol(
    input.adjudicationProtocol,
    errors,
  );
  if (manifest && Array.isArray(evalProtocol?.predeclaredExclusions)) {
    for (const exclusion of evalProtocol.predeclaredExclusions) {
      if (!manifest.caseIds.includes(exclusion.caseId)) {
        errors.push(
          issue(
            "UNKNOWN_PREDECLARED_EXCLUSION_CASE",
            "A predeclared exclusion references a case outside the manifest.",
          ),
        );
      }
    }
  }
  const suppliedSources = [
    "runs",
    "exports",
    "exportRecords",
    "canonicalRunRecords",
    "records",
  ].filter((field) => Array.isArray(input[field]));
  if (suppliedSources.length > 1) {
    errors.push(
      issue(
        "AMBIGUOUS_SOURCE_MODE",
        "Lane bundle must supply exactly one in-memory run source.",
      ),
    );
  }
  const rawRuns = recordArray(input);
  const sourceSummary = exportSummary(input, errors);
  const rawLabels = caseLabelArray(input);
  const rawCandidates = candidateArray(input);
  const rejectedRecords = [];
  const runs = [];
  for (let index = 0; index < rawRuns.length; index += 1) {
    const recordErrors = [];
    const run = normalizeRun(rawRuns[index], pricingSnapshot, recordErrors);
    if (!run || recordErrors.length > 0) {
      const rawRun = /** @type {any} */ (rawRuns[index]);
      const caseId = isPlainObject(rawRun) ? rawRun.caseId : null;
      rejectedRecords.push({
        kind: "RUN",
        index,
        caseId: isOpaqueDigestId(caseId) ? caseId : null,
        reasonCodes: uniqueSortedStrings(recordErrors.map((entry) => entry.code)),
        symmetricDeclaredExclusion: isSafeDeclaredExclusion(
          evalProtocol,
          isOpaqueDigestId(caseId) ? caseId : null,
        ),
      });
      warnings.push(
        issue("REJECTED_RUN_RECORD", "A whole run record was rejected.", {
          index,
          reasonCodes: uniqueSortedStrings(recordErrors.map((entry) => entry.code)),
        }),
      );
      continue;
    }
    runs.push(run);
  }
  const caseLabels = [];
  for (let index = 0; index < rawLabels.length; index += 1) {
    const recordErrors = [];
    const label = normalizeCaseLabel(rawLabels[index], recordErrors);
    if (!label || recordErrors.length > 0) {
      const rawLabel = /** @type {any} */ (rawLabels[index]);
      rejectedRecords.push({
        kind: "CASE_LABEL",
        index,
        caseId:
          isPlainObject(rawLabel) && isOpaqueDigestId(rawLabel.caseId)
            ? rawLabel.caseId
            : null,
        reasonCodes: uniqueSortedStrings(recordErrors.map((entry) => entry.code)),
        symmetricDeclaredExclusion: false,
      });
      warnings.push(
        issue("REJECTED_CASE_LABEL", "A whole case-label record was rejected.", {
          index,
          reasonCodes: uniqueSortedStrings(recordErrors.map((entry) => entry.code)),
        }),
      );
      continue;
    }
    caseLabels.push(label);
  }
  const candidateConfigs = [];
  for (let index = 0; index < rawCandidates.length; index += 1) {
    const recordErrors = [];
    const candidate = normalizeCandidate(rawCandidates[index], recordErrors);
    if (!candidate || recordErrors.length > 0) {
      rejectedRecords.push({
        kind: "CANDIDATE",
        index,
        caseId: null,
        reasonCodes: uniqueSortedStrings(recordErrors.map((entry) => entry.code)),
        symmetricDeclaredExclusion: false,
      });
      warnings.push(
        issue("REJECTED_CANDIDATE_CONFIG", "A candidate config was rejected.", {
          index,
          reasonCodes: uniqueSortedStrings(recordErrors.map((entry) => entry.code)),
        }),
      );
      continue;
    }
    candidateConfigs.push(candidate);
  }
  const caseLabelsById = new Map();
  for (const label of caseLabels) {
    if (caseLabelsById.has(label.caseId)) {
      errors.push(issue("DUPLICATE_CASE_LABEL", "A case has duplicate labels."));
    }
    caseLabelsById.set(label.caseId, label);
  }
  const candidatesById = new Map();
  for (const candidate of candidateConfigs) {
    if (candidatesById.has(candidate.variantId)) {
      errors.push(
        issue("DUPLICATE_CANDIDATE_CONFIG", "A variant has duplicate configs."),
      );
    }
    candidatesById.set(candidate.variantId, candidate);
  }
  const runIds = new Set();
  const runKeys = new Set();
  const replicateCounts = new Map();
  for (const run of runs) {
    const runKey = [run.caseId, run.variantId, run.replicateId].join("\u0000");
    const caseVariantKey = [run.caseId, run.variantId].join("\u0000");
    const replicateCount = (replicateCounts.get(caseVariantKey) ?? 0) + 1;
    replicateCounts.set(caseVariantKey, replicateCount);
    if (replicateCount === MAX_REPLICATES_PER_CASE_VARIANT + 1) {
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
    if (runIds.has(run.runId)) {
      errors.push(issue("DUPLICATE_RUN_ID", "Run ID is duplicated."));
    }
    if (runKeys.has(runKey)) {
      errors.push(
        issue(
          "DUPLICATE_CASE_VARIANT_REPLICATE",
          "Case, variant, and replicate must be unique.",
        ),
      );
    }
    runIds.add(run.runId);
    runKeys.add(runKey);
    const candidate = candidatesById.get(run.variantId);
    if (
      candidate &&
      (run.architectureId !== candidate.architectureId ||
        run.architectureStructuralDigest !== candidate.architectureStructuralDigest)
    ) {
      errors.push(
        issue(
          "RUN_CANDIDATE_ARCHITECTURE_MISMATCH",
          "Run architecture provenance disagrees with its candidate config.",
        ),
      );
    }
    const label = caseLabelsById.get(run.caseId);
    validateRootCauseReferences(run, label, rubric, errors);
    if (manifest) {
      if (!manifest.caseIds.includes(run.caseId)) {
        errors.push(issue("RUN_OUTSIDE_MANIFEST", "Run case is undeclared."));
      }
      if (!manifest.variantIds.includes(run.variantId)) {
        errors.push(issue("RUN_OUTSIDE_MANIFEST", "Run variant is undeclared."));
      }
      if (
        run.adjudication &&
        (run.adjudication.rubricId !== manifest.rubricId ||
          run.adjudication.labelVersion !== manifest.labelVersion)
      ) {
        errors.push(
          issue(
            "ADJUDICATION_VERSION_MISMATCH",
            "Run adjudication disagrees with manifest versions.",
          ),
        );
      }
    }
  }
  if (manifest) {
    if (
      sourceSummary.exporterVersions.length > 0 &&
      sourceSummary.exporterVersions.some(
        (version) => version !== manifest.exporterVersion,
      )
    ) {
      errors.push(
        issue(
          "EXPORTER_VERSION_MISMATCH",
          "Export wrappers disagree with the manifest exporter version.",
        ),
      );
    }
    if (pricingSnapshot && manifest.pricingSnapshotId !== pricingSnapshot.snapshotId) {
      errors.push(issue("MANIFEST_PRICING_MISMATCH", "Manifest and pricing disagree."));
    }
    if (
      manifest.lane &&
      !manifest.variantIds.includes(manifest.lane.baselineVariantId)
    ) {
      errors.push(
        issue("UNKNOWN_BASELINE_VARIANT", "Lane baseline is not a manifest variant."),
      );
    }
    for (const variantId of manifest.variantIds) {
      if (!candidatesById.has(variantId)) {
        warnings.push(
          issue(
            "MISSING_CANDIDATE_CONFIG",
            "Manifest variant lacks candidate config.",
            {
              variantId,
            },
          ),
        );
      }
    }
    for (const caseId of manifest.caseIds) {
      const label = caseLabelsById.get(caseId);
      if (!label) {
        warnings.push(
          issue("MISSING_CASE_LABEL", "Manifest case lacks independent labels.", {
            caseId,
          }),
        );
      } else if (
        label.rubricId !== manifest.rubricId ||
        label.labelVersion !== manifest.labelVersion
      ) {
        errors.push(
          issue(
            "CASE_LABEL_VERSION_MISMATCH",
            "Case label disagrees with manifest versions.",
          ),
        );
      }
    }
  }
  if (rawRuns.length === 0) {
    warnings.push(issue("MISSING_RUN_RECORDS", "No run records were supplied."));
  }
  if (rawLabels.length === 0) {
    warnings.push(issue("MISSING_CASE_LABELS", "No case labels were supplied."));
  }
  if (rawCandidates.length === 0) {
    warnings.push(
      issue("MISSING_CANDIDATE_CONFIGS", "No candidate configs were supplied."),
    );
  }
  const rejectedAffectCohort = rejectedRecords.some(
    (record) => !record.symmetricDeclaredExclusion,
  );
  if (rejectedAffectCohort) {
    warnings.push(
      issue(
        "REJECTED_RECORDS_AFFECT_COHORT",
        "Rejected records are not symmetric provenance-backed exclusions.",
      ),
    );
  }
  const orderedRuns = stableSort(runs, (run) =>
    [run.caseId, run.variantId, run.replicateId].join("\u0000"),
  );
  const orderedLabels = stableSort(caseLabels, (label) => label.caseId);
  const orderedCandidates = stableSort(
    candidateConfigs,
    (candidate) => candidate.variantId,
  );
  if (errors.length === 0 && rejectedRecords.length === 0 && forbidden.length === 0) {
    verifyStructuralReceipts(input, manifest, errors);
  }
  const blocked = errors.length > 0;
  const status = blocked
    ? "BLOCKED"
    : rejectedRecords.length > 0 || warnings.length > 0
      ? "PARTIAL"
      : "COMPLETE";
  const reasonCodes = uniqueSortedStrings([
    ...errors.map((entry) => entry.code),
    ...warnings.map((entry) => entry.code),
  ]);
  const counts = {
    sourceRecords: rawRuns.length,
    acceptedRuns: orderedRuns.length,
    rejectedRecords: rejectedRecords.length,
    cases: orderedLabels.length,
    variants: orderedCandidates.length,
    findings: orderedRuns.reduce((total, run) => total + run.findings.length, 0),
  };
  const report = {
    schemaVersion: 1,
    status,
    bundleId,
    laneId: manifest?.lane?.laneId ?? null,
    laneType: manifest?.lane?.laneType ?? null,
    counts,
    ...sourceSummary,
    reasonCodes,
    errors,
    warnings,
    rejectedRecords,
    structuralReceipts: manifest?.structuralReceipts ?? [],
    redactionCounts: isPlainObject(input.redactionCounts)
      ? input.redactionCounts
      : { total: 0 },
  };
  return {
    schemaVersion: 1,
    status,
    bundleId,
    laneId: manifest?.lane?.laneId ?? null,
    laneType: manifest?.lane?.laneType ?? null,
    errors,
    warnings,
    reasonCodes,
    report,
    runs: orderedRuns,
    caseLabels: orderedLabels,
    caseLabelsById: new Map(orderedLabels.map((label) => [label.caseId, label])),
    candidateConfigs: orderedCandidates,
    candidatesById: new Map(
      orderedCandidates.map((candidate) => [candidate.variantId, candidate]),
    ),
    manifest,
    lane: manifest?.lane ?? null,
    pricingSnapshot,
    rubric,
    evalProtocol,
    adjudicationProtocol,
    rejectedRecords,
    rankingEligible: !blocked && !rejectedAffectCohort,
  };
}

/**
 * Normalize one to eight already-loaded lane bundles without any filesystem
 * or network behavior.
 *
 * @param {unknown} input
 * @returns {any}
 */
export function normalizeLaneBundles(input) {
  const source = Array.isArray(input)
    ? input
    : isPlainObject(input) && Array.isArray(input.laneBundles)
      ? input.laneBundles
      : isPlainObject(input)
        ? [input]
        : [];
  if (source.length === 0 || source.length > 8) {
    const error = issue(
      "INVALID_LANE_BUNDLE_COUNT",
      "Expected one to eight already-loaded lane bundles.",
    );
    return {
      schemaVersion: 1,
      status: "BLOCKED",
      lanes: [],
      reports: [],
      errors: [error],
      warnings: [],
      reasonCodes: ["INVALID_LANE_BUNDLE_COUNT"],
    };
  }
  const lanes = source.map((bundle) => normalizeLaneBundle(bundle));
  const duplicateErrors = [];
  const bundleIds = lanes.map((lane) => lane.bundleId).filter(Boolean);
  const laneIds = lanes.map((lane) => lane.laneId).filter(Boolean);
  if (new Set(bundleIds).size !== bundleIds.length) {
    duplicateErrors.push(
      issue("DUPLICATE_BUNDLE_ID", "Lane bundle IDs must be unique."),
    );
  }
  if (new Set(laneIds).size !== laneIds.length) {
    duplicateErrors.push(issue("DUPLICATE_LANE_ID", "Lane IDs must be unique."));
  }
  const errors = [...lanes.flatMap((lane) => lane.errors), ...duplicateErrors];
  const warnings = lanes.flatMap((lane) => lane.warnings);
  const status =
    errors.length > 0 || lanes.some((lane) => lane.status === "BLOCKED")
      ? "BLOCKED"
      : lanes.every((lane) => lane.status === "COMPLETE")
        ? "COMPLETE"
        : "PARTIAL";
  return {
    schemaVersion: 1,
    status,
    lanes,
    reports: lanes.map((lane) => lane.report),
    errors,
    warnings,
    reasonCodes: uniqueSortedStrings([
      ...errors.map((entry) => entry.code),
      ...warnings.map((entry) => entry.code),
    ]),
  };
}

export const normalizeReviewRuns = normalizeLaneBundles;
