// @ts-check

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { assertRecordCount, assertStdoutBytes, DEFAULT_LIMITS } from "./bounds.mjs";
import { fail, publicError, ReviewOpsError } from "./errors.mjs";
import {
  createTrustedPathContext,
  readApprovedFile,
  readTrustedConfigFile,
} from "./paths.mjs";
import {
  escapeUntrustedText,
  redactJsonValue,
  redactText,
  redactedTextShape,
  stripUnsafeControls,
} from "./redact.mjs";
import { createSchemaRegistry, parseJsonLines, parseJsonText } from "./schema.mjs";
import { structuralDigest, stableJson } from "./utils.mjs";

const TOOL_VERSION = "0.1.0";
const ANALYSIS_TIMEOUT_MS = 5_000;
const ANALYSIS_RESOURCE_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 128,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4,
});
const COMMANDS = new Set([
  "validate-config",
  "normalize",
  "audit-eval",
  "benchmark",
  "recommend-architecture",
]);
const HELP_TEXT = [
  "ReviewOps Auditor + Benchmark",
  "",
  "Usage:",
  "  node ./scripts/reviewops.mjs <command> (--fixture synthetic | --config <relative-path>) [--format markdown|json]",
  "",
  "Commands:",
  "  validate-config         Validate config shape and approved roots.",
  "  normalize               Normalize declared sanitized review-run exports.",
  "  audit-eval              Check whether lane evidence supports its claim.",
  "  benchmark               Score valid paired lanes and risk slices.",
  "  recommend-architecture  Emit shadow-only reference-architecture guidance.",
  "",
  "Safe first run:",
  "  node ./scripts/reviewops.mjs normalize --fixture synthetic --format markdown",
  "",
  "The CLI reads only declared local files and writes reports to stdout.",
].join("\n");
const pluginRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const analysisWorkerUrl = import.meta.url.includes("/src/cli.mjs")
  ? new URL("./worker.mjs", import.meta.url)
  : new URL("./reviewops-worker.mjs", import.meta.url);
const METRIC_IDS = Object.freeze({
  highCriticalRootCauseRecall: ["high_critical_root_cause_recall", "MAXIMIZE"],
  criticalMissRate: ["critical_miss_rate", "MINIMIZE"],
  actionablePrecision: ["actionable_precision", "MAXIMIZE"],
  crossSystemTruePositives: ["cross_system_true_positives", "MAXIMIZE"],
  symptomsPerRootCause: ["symptoms_per_root_cause", "MINIMIZE"],
  hallucinationRate: ["hallucination_rate", "MINIMIZE"],
  humanReviewMinutesPerCase: ["human_review_minutes", "MINIMIZE"],
  fullyLoadedCostPerConfirmedHighCriticalRootCause: [
    "fully_loaded_cost_per_confirmed_high_critical_root_cause",
    "MINIMIZE",
  ],
  fullyLoadedCostPerConfirmedRootCause: [
    "fully_loaded_cost_per_confirmed_root_cause",
    "MINIMIZE",
  ],
  rootCauseQuality: ["root_cause_quality", "MAXIMIZE"],
  findingStability: ["finding_stability", "MAXIMIZE"],
  latencyP50: ["latency_p50", "MINIMIZE"],
  latencyP95: ["latency_p95", "MINIMIZE"],
  latencyP99: ["latency_p99", "MINIMIZE"],
  costP50: ["cost_p50", "MINIMIZE"],
  costP95: ["cost_p95", "MINIMIZE"],
  costP99: ["cost_p99", "MINIMIZE"],
  costPerReviewedCase: ["cost_per_reviewed_case", "MINIMIZE"],
  modelOnlyCostPerReviewedCase: ["model_only_cost", "MINIMIZE"],
  tokenUsagePerCase: ["token_usage", "MINIMIZE"],
  rawFindingCount: ["raw_finding_count", "MINIMIZE"],
  acceptedFindingCount: ["accepted_finding_count", "MAXIMIZE"],
  commentVolume: ["comment_volume", "MINIMIZE"],
  crossFileFindingCount: ["cross_file_finding_count", "MAXIMIZE"],
});
const METRIC_UNITS = Object.freeze({
  highCriticalRootCauseRecall: "RATIO",
  criticalMissRate: "RATIO",
  actionablePrecision: "RATIO",
  crossSystemTruePositives: "COUNT",
  symptomsPerRootCause: "RATIO",
  hallucinationRate: "RATIO",
  humanReviewMinutesPerCase: "MINUTES_PER_CASE",
  fullyLoadedCostPerConfirmedHighCriticalRootCause: "MICROS_PER_CONFIRMED_ROOT_CAUSE",
  fullyLoadedCostPerConfirmedRootCause: "MICROS_PER_CONFIRMED_ROOT_CAUSE",
  rootCauseQuality: "SCORE",
  findingStability: "RATIO",
  latencyP50: "MILLISECONDS",
  latencyP95: "MILLISECONDS",
  latencyP99: "MILLISECONDS",
  costP50: "MICROS",
  costP95: "MICROS",
  costP99: "MICROS",
  costPerReviewedCase: "MICROS_PER_CASE",
  modelOnlyCostPerReviewedCase: "MICROS_PER_CASE",
  tokenUsagePerCase: "TOKENS_PER_CASE",
  rawFindingCount: "COUNT",
  acceptedFindingCount: "COUNT",
  commentVolume: "COUNT",
  crossFileFindingCount: "COUNT",
});

/** @param {unknown} value @returns {value is Record<string, any>} */
function objectValue(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @returns {Record<string, any>[]} */
function records(value) {
  return Array.isArray(value) ? value.filter((item) => objectValue(item)) : [];
}

/** @param {unknown} value @returns {string[]} */
function strings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

/** @param {string} operation @param {Record<string, unknown>} payload */
function runBoundedAnalysis(operation, payload) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(analysisWorkerUrl, {
      env: {},
      resourceLimits: ANALYSIS_RESOURCE_LIMITS,
    });
    let settled = false;
    /** @param {() => void} callback */
    const finish = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      callback();
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new ReviewOpsError(
            "RO_ANALYSIS_TIMEOUT",
            "Bounded analysis exceeded its hard timeout.",
          ),
        ),
      );
    }, ANALYSIS_TIMEOUT_MS);
    worker.once("message", (message) => {
      finish(() => {
        if (objectValue(message) && message.ok === true && "value" in message) {
          resolve(message.value);
          return;
        }
        if (
          objectValue(message) &&
          message.ok === false &&
          objectValue(message.error) &&
          typeof message.error.code === "string" &&
          typeof message.error.message === "string"
        ) {
          reject(
            new ReviewOpsError(message.error.code, message.error.message, {
              status:
                message.error.status === "ERROR"
                  ? "ERROR"
                  : message.error.status === "INSUFFICIENT_EVIDENCE"
                    ? "INSUFFICIENT_EVIDENCE"
                    : "BLOCKED",
            }),
          );
          return;
        }
        reject(
          new ReviewOpsError("RO_WORKER_FAILED", "Bounded analysis worker failed.", {
            status: "ERROR",
          }),
        );
      });
    });
    worker.once("error", () => {
      finish(() =>
        reject(
          new ReviewOpsError("RO_WORKER_FAILED", "Bounded analysis worker failed.", {
            status: "ERROR",
          }),
        ),
      );
    });
    worker.once("exit", (code) => {
      if (!settled && code !== 0) {
        finish(() =>
          reject(
            new ReviewOpsError("RO_WORKER_FAILED", "Bounded analysis worker failed.", {
              status: "ERROR",
            }),
          ),
        );
      }
    });
    worker.postMessage({ operation, payload });
  });
}

/** @param {unknown} value */
function safeText(value) {
  return escapeUntrustedText(String(value), { maxChars: 1024 }).text || "Unavailable";
}

/** @param {unknown} value */
function safeJsonText(value) {
  const redacted = redactText(stripUnsafeControls(String(value)));
  return redacted.text.replace(/\s+/gu, " ").trim().slice(0, 1024) || "Unavailable";
}

/** @param {unknown} value */
function safeOutputPath(value) {
  const original = String(value);
  const cleaned = stripUnsafeControls(original);
  const redacted = redactText(cleaned);
  return redacted.count > 0 || cleaned !== original ? "redacted-path" : redacted.text;
}

/** @param {string} output */
function writeBoundedOutput(output) {
  assertStdoutBytes(output);
  process.stdout.write(output);
}

/** @param {Record<string, any>[]} loaded */
function outputPathRedactions(loaded) {
  return loaded.reduce((total, item) => {
    const original = String(item.relativePath);
    const cleaned = stripUnsafeControls(original);
    const redacted = redactText(cleaned);
    return total + redacted.count + (cleaned === original ? 0 : 1);
  }, 0);
}

/** @param {unknown} value */
function warning(value) {
  if (
    objectValue(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  ) {
    return { code: value.code, message: safeJsonText(value.message) };
  }
  return { code: "RO_WARNING", message: safeJsonText(value) };
}

/**
 * Core modules keep structured blocked details for pure callers. The CLI
 * surfaces the first stable blocked reason directly instead of trying to map
 * an intentionally incomplete blocked scorecard through a success schema.
 *
 * @param {unknown} core
 */
function failForBlockedCore(core) {
  if (!objectValue(core)) {
    return;
  }
  const candidates = [
    ...records(core.errors),
    ...records(core.normalization?.errors),
    ...records(core.normalization?.lanes).flatMap((lane) => records(lane.errors)),
    ...records(core.scorecard?.errors),
    ...records(core.scorecard?.lanes).flatMap((lane) => records(lane.errors)),
    ...records(core.lanes).flatMap((lane) => records(lane.errors)),
  ];
  const first = candidates.find(
    (entry) =>
      objectValue(entry) &&
      typeof entry.code === "string" &&
      typeof entry.message === "string",
  );
  if (first) {
    fail(first.code, safeJsonText(first.message));
  }
  const blocked =
    core.status === "BLOCKED" ||
    core.normalization?.status === "BLOCKED" ||
    core.scorecard?.status === "BLOCKED" ||
    records(core.lanes).some((lane) => lane.status === "BLOCKED") ||
    records(core.normalization?.lanes).some((lane) => lane.status === "BLOCKED") ||
    records(core.scorecard?.lanes).some((lane) => lane.status === "BLOCKED");
  if (blocked) {
    fail("RO_ANALYSIS_BLOCKED", "Analysis input was blocked.");
  }
}

/** @param {unknown} values */
function warnings(values) {
  return Array.isArray(values) ? values.map(warning) : [];
}

/** @param {unknown} values */
function safeStrings(values) {
  return strings(values).map(safeJsonText);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.has(command)) {
    fail(
      "RO_COMMAND_INVALID",
      "Command must be validate-config, normalize, audit-eval, benchmark, or recommend-architecture.",
    );
  }
  let configPath = null;
  let fixture = false;
  let format = "markdown";
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    const next = rest[index + 1];
    if (value === "--config" && next && !next.startsWith("--")) {
      configPath = next;
      index += 1;
    } else if (value === "--fixture" && next === "synthetic") {
      fixture = true;
      index += 1;
    } else if (value === "--format" && (next === "json" || next === "markdown")) {
      format = next;
      index += 1;
    } else {
      fail(
        "RO_ARGUMENT_INVALID",
        "Unsupported or incomplete argument; use --help for command syntax.",
      );
    }
  }
  if ((configPath === null && !fixture) || (configPath !== null && fixture)) {
    fail("RO_ARGUMENT_INVALID", "Use exactly one of --config or --fixture synthetic.");
  }
  return { command, configPath, fixture, format };
}

/** @param {Record<string, any>} limits */
function publicLimits(limits) {
  return {
    maxFiles: limits.maxFiles,
    maxBytesPerFile: limits.maxBytesPerFile,
    maxTotalBytes: limits.maxTotalBytes,
    maxRecords: limits.maxRecords,
  };
}

/** @param {Record<string, any>} config */
function configDigest(config) {
  return structuralDigest({
    kind: "config",
    schemaVersion: config.schemaVersion,
    analysisAsOf: config.analysisAsOf,
    inputRootCount: Array.isArray(config.inputRoots) ? config.inputRoots.length : 0,
    bundleIds: records(config.laneBundles)
      .map((bundle) => bundle.bundleId)
      .sort(),
    bundleShapes: records(config.laneBundles).map((bundle) => ({
      candidateConfigs: Array.isArray(bundle.candidateConfigPaths)
        ? bundle.candidateConfigPaths.length
        : 0,
      caseLabels: Array.isArray(bundle.caseLabelPaths)
        ? bundle.caseLabelPaths.length
        : 0,
      sourceMode: Array.isArray(bundle.exportPaths)
        ? "SANITIZED_EXPORT"
        : "CANONICAL_RECORDS",
    })),
    hasDecisionPolicy: typeof config.decisionPolicyPath === "string",
    hasStaticDiagnostics: objectValue(config.staticDiagnostics),
  });
}

/** @param {Record<string, any>} loaded */
function inputDigest(loaded) {
  const shape = redactedTextShape(loaded.text);
  return {
    kind: loaded.kind,
    path: safeOutputPath(loaded.relativePath),
    digest: structuralDigest({
      kind: loaded.kind,
      extension: path.posix.extname(loaded.relativePath),
      bytes: loaded.bytes,
      lines: loaded.lines,
      redactions: shape.redactions,
    }),
  };
}

/**
 * @param {Record<string, any>} config
 * @param {Record<string, any>} limits
 * @param {Record<string, any>[]} loaded
 */
function envelope(config, limits, loaded) {
  const redactionTotal =
    loaded.reduce((total, item) => total + redactedTextShape(item.text).redactions, 0) +
    outputPathRedactions(loaded);
  return {
    schemaVersion: 1,
    toolVersion: TOOL_VERSION,
    analysisAsOf: config.analysisAsOf,
    configDigest: configDigest(config),
    inputDigests: loaded
      .map(inputDigest)
      .sort((left, right) => left.path.localeCompare(right.path, "en")),
    appliedLimits: publicLimits(limits),
    redactionCounts: { total: redactionTotal },
  };
}

/** @param {string} text @param {string} label @param {import("./bounds.mjs").Limits} limits */
function recordsFromText(text, label, limits) {
  if (label.endsWith(".jsonl")) {
    return parseJsonLines(text, label, limits);
  }
  const parsed = parseJsonText(text, label, limits);
  const values = Array.isArray(parsed) ? parsed : [parsed];
  assertRecordCount(values.length, limits);
  return values;
}

/** @param {import("./bounds.mjs").Limits} limits @param {number} currentCount */
function remainingRecordLimits(limits, currentCount) {
  return { ...limits, maxRecords: Math.max(0, limits.maxRecords - currentCount) };
}

/**
 * @param {Awaited<ReturnType<typeof createSchemaRegistry>>} schemas
 * @param {Awaited<ReturnType<typeof createTrustedPathContext>>} context
 * @param {string[]} paths
 * @param {string} schemaName
 * @param {import("./bounds.mjs").InputKind} readKind
 * @param {string} digestKind
 * @param {Record<string, any>[]} loaded
 */
async function readRecords(
  schemas,
  context,
  paths,
  schemaName,
  readKind,
  digestKind,
  loaded,
) {
  const output = [];
  for (const declaredPath of paths) {
    const file = await readApprovedFile(context, declaredPath, { kind: readKind });
    loaded.push({ ...file, kind: digestKind });
    const values = recordsFromText(
      file.text,
      file.relativePath,
      remainingRecordLimits(context.limits, output.length),
    );
    assertRecordCount(output.length + values.length, context.limits);
    for (const value of values) {
      schemas.assert(schemaName, value);
      output.push(value);
    }
  }
  return output;
}

/**
 * @param {Awaited<ReturnType<typeof createSchemaRegistry>>} schemas
 * @param {Awaited<ReturnType<typeof createTrustedPathContext>>} context
 * @param {string} declaredPath
 * @param {string} schemaName
 * @param {string} digestKind
 * @param {Record<string, any>[]} loaded
 */
async function readJsonObject(
  schemas,
  context,
  declaredPath,
  schemaName,
  digestKind,
  loaded,
) {
  const file = await readApprovedFile(context, declaredPath, { kind: "json" });
  loaded.push({ ...file, kind: digestKind });
  const value = parseJsonText(file.text, file.relativePath, context.limits);
  schemas.assert(schemaName, value);
  return value;
}

/**
 * @param {Awaited<ReturnType<typeof createSchemaRegistry>>} schemas
 * @param {Awaited<ReturnType<typeof createTrustedPathContext>>} context
 * @param {Record<string, any>} declared
 * @param {Record<string, any>[]} loaded
 */
async function loadLaneBundle(schemas, context, declared, loaded) {
  const manifest = await readJsonObject(
    schemas,
    context,
    declared.manifestPath,
    "benchmark-manifest",
    "BENCHMARK_MANIFEST",
    loaded,
  );
  const evalProtocol = await readJsonObject(
    schemas,
    context,
    declared.evalProtocolPath,
    "eval-protocol",
    "EVAL_PROTOCOL",
    loaded,
  );
  const adjudicationProtocol = await readJsonObject(
    schemas,
    context,
    declared.adjudicationProtocolPath,
    "adjudication-protocol",
    "ADJUDICATION_PROTOCOL",
    loaded,
  );
  const candidateConfigs = await readRecords(
    schemas,
    context,
    declared.candidateConfigPaths,
    "candidate-config",
    "json",
    "CANDIDATE_CONFIG",
    loaded,
  );
  const rubric = await readJsonObject(
    schemas,
    context,
    declared.rubricPath,
    "rubric",
    "RUBRIC",
    loaded,
  );
  const pricingSnapshot = await readJsonObject(
    schemas,
    context,
    declared.pricingSnapshotPath,
    "pricing-snapshot",
    "PRICING_SNAPSHOT",
    loaded,
  );
  const caseLabels = await readRecords(
    schemas,
    context,
    declared.caseLabelPaths,
    "case-label",
    "jsonl",
    "CASE_LABEL",
    loaded,
  );
  const hasExports = Array.isArray(declared.exportPaths);
  const sourceRecords = await readRecords(
    schemas,
    context,
    hasExports ? declared.exportPaths : declared.canonicalRunRecordPaths,
    hasExports ? "review-run-export" : "run-record",
    "run",
    hasExports ? "REVIEW_RUN_EXPORT" : "CANONICAL_RUN_RECORD",
    loaded,
  );
  return {
    bundleId: declared.bundleId,
    manifest,
    evalProtocol,
    adjudicationProtocol,
    candidateConfigs,
    rubric,
    pricingSnapshot,
    caseLabels,
    ...(hasExports
      ? { exports: sourceRecords }
      : { canonicalRunRecords: sourceRecords }),
    sourceMode: hasExports ? "SANITIZED_EXPORT" : "CANONICAL_RECORDS",
  };
}

/**
 * @param {Awaited<ReturnType<typeof createSchemaRegistry>>} schemas
 * @param {Awaited<ReturnType<typeof createTrustedPathContext>>} context
 * @param {Record<string, any>} config
 * @param {Record<string, any>[]} loaded
 */
async function loadLaneBundles(schemas, context, config, loaded) {
  const laneBundles = [];
  for (const declared of records(config.laneBundles)) {
    laneBundles.push(await loadLaneBundle(schemas, context, declared, loaded));
  }
  return laneBundles;
}

/**
 * @param {Awaited<ReturnType<typeof createSchemaRegistry>>} schemas
 * @param {Awaited<ReturnType<typeof createTrustedPathContext>>} context
 * @param {Record<string, any>} config
 * @param {Record<string, any>[]} loaded
 */
async function loadDecisionPolicy(schemas, context, config, loaded) {
  if (typeof config.decisionPolicyPath !== "string") {
    return null;
  }
  return readJsonObject(
    schemas,
    context,
    config.decisionPolicyPath,
    "decision-policy",
    "DECISION_POLICY",
    loaded,
  );
}

/**
 * @param {Awaited<ReturnType<typeof createSchemaRegistry>>} schemas
 * @param {Awaited<ReturnType<typeof createTrustedPathContext>>} context
 * @param {Record<string, any>} config
 * @param {Record<string, any>[]} loaded
 */
async function loadStaticDiagnostics(schemas, context, config, loaded) {
  const declared = config.staticDiagnostics;
  if (!objectValue(declared)) {
    return null;
  }
  const workflows = [];
  for (const declaredPath of declared.workflowPaths ?? []) {
    const file = await readApprovedFile(context, declaredPath, { kind: "workflow" });
    loaded.push({ ...file, kind: "WORKFLOW" });
    workflows.push(file);
  }
  const prompts = [];
  for (const declaredPath of declared.promptPaths ?? []) {
    const file = await readApprovedFile(context, declaredPath, { kind: "prompt" });
    loaded.push({ ...file, kind: "PROMPT" });
    prompts.push(file);
  }
  const telemetry = [];
  for (const declaredPath of declared.telemetryPaths ?? []) {
    const file = await readApprovedFile(context, declaredPath, { kind: "telemetry" });
    loaded.push({ ...file, kind: "TELEMETRY" });
    telemetry.push(file);
  }
  const toolContracts = await readRecords(
    schemas,
    context,
    declared.toolContractPaths ?? [],
    "tool-contract",
    "json",
    "TOOL_CONTRACT",
    loaded,
  );
  const validatorResults = await readRecords(
    schemas,
    context,
    declared.validatorResultPaths ?? [],
    "validator-result",
    "jsonl",
    "VALIDATOR_RESULT",
    loaded,
  );
  return {
    inputs: { workflows, prompts, telemetry, toolContracts, validatorResults },
    bindings: declared.bindings ?? [],
  };
}

/** @param {unknown} value */
function status(value) {
  return ["COMPLETE", "PARTIAL", "INSUFFICIENT_EVIDENCE", "BLOCKED", "ERROR"].includes(
    String(value),
  )
    ? value
    : "INSUFFICIENT_EVIDENCE";
}

/** @param {unknown} value */
function count(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

/** @param {unknown} value */
function fraction(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0;
}

/** @param {unknown} value @param {string} fallback */
function safeAlias(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/** @param {Record<string, any>} core @param {string} sourceMode */
function normalizationBundle(core, sourceMode) {
  const report = objectValue(core.report) ? core.report : {};
  const counts = objectValue(report.counts) ? report.counts : {};
  const duplicateRecordCount = records(core.errors ?? report.errors).filter(
    (entry) => typeof entry.code === "string" && entry.code.startsWith("DUPLICATE_"),
  ).length;
  return {
    bundleId: safeAlias(core.bundleId ?? report.bundleId, "unknown-bundle"),
    sourceMode,
    status: status(core.status ?? report.status),
    sourceRecordCount: count(counts.sourceRecords),
    acceptedRecordCount: count(counts.acceptedRuns),
    rejectedRecordCount: count(counts.rejectedRecords),
    duplicateRecordCount,
    normalizedRecordCount: count(counts.acceptedRuns),
    exporterVersions: safeStrings(report.exporterVersions),
    reasonCodes: safeStrings(core.reasonCodes ?? report.reasonCodes),
    receipts: Array.isArray(report.structuralReceipts) ? report.structuralReceipts : [],
  };
}

/** @param {Record<string, any>} lane @param {unknown} bundleId */
function publicEvalLane(lane, bundleId) {
  const pairing = objectValue(lane.pairing) ? lane.pairing : {};
  const paired = Array.isArray(pairing.pairedCaseIds)
    ? pairing.pairedCaseIds.length
    : count(pairing.pairedCaseCount);
  const declared = Array.isArray(pairing.pairedCaseIds)
    ? paired + (Array.isArray(pairing.excludedCases) ? pairing.excludedCases.length : 0)
    : paired;
  return {
    bundleId: safeAlias(bundleId ?? lane.bundleId, lane.laneId ?? "unknown-bundle"),
    laneId: safeAlias(lane.laneId, "unknown-lane"),
    laneType: safeAlias(lane.laneType, "PORTABLE_CORE_MODEL"),
    status: status(lane.status),
    attributionStatus: safeAlias(lane.attributionStatus, "UNKNOWN"),
    claimBoundary: safeJsonText(
      lane.claimBoundary ??
        "Lane evidence supports only the declared comparison scope.",
    ),
    reasonCodes: safeStrings(lane.reasonCodes),
    pairedCaseCount: paired,
    pairingCoverage: declared > 0 ? fraction(paired / declared) : 0,
    checks: records(lane.checks).map((check) => ({
      ruleId: safeAlias(check.id ?? check.ruleId, "RO-EV-001"),
      status:
        check.status === "PASS" ||
        check.status === "FAIL" ||
        check.status === "UNKNOWN" ||
        check.status === "BLOCKED"
          ? check.status
          : "UNKNOWN",
      reason: safeJsonText(check.reasonCode ?? check.reason ?? "MISSING_CHECK_REASON"),
      evidenceStatus: check.status === "PASS" ? "DECLARED" : "UNKNOWN",
    })),
    exclusions: records(pairing.excludedCases).map((entry) => ({
      caseId: entry.caseId,
      reasonCodes: safeStrings(entry.reasonCodes),
    })),
    heldConstantDimensions: safeStrings(lane.heldConstantDimensions),
    intentionallyChangedDimensions: safeStrings(lane.intentionallyChangedDimensions),
    unexpectedDimensions: safeStrings(lane.unexpectedDimensions),
    missingDimensions: safeStrings(lane.missingDimensions),
    evidenceRequired: safeStrings(lane.evidenceRequired),
    limitations: safeStrings(lane.limitations),
  };
}

/** @param {unknown} interval */
function publicInterval(interval) {
  if (!objectValue(interval)) {
    return null;
  }
  const lower = interval.lower;
  const upper = interval.upper;
  const confidenceLevel = interval.confidenceLevel;
  if (
    typeof lower !== "number" ||
    !Number.isFinite(lower) ||
    typeof upper !== "number" ||
    !Number.isFinite(upper) ||
    typeof confidenceLevel !== "number" ||
    !Number.isFinite(confidenceLevel)
  ) {
    return null;
  }
  return {
    lower,
    upper,
    confidenceLevel,
    method: "SEEDED_PAIRED_BOOTSTRAP",
  };
}

/** @param {Record<string, any>} metric @param {string} key */
function publicMetric(metric, key) {
  const descriptor = METRIC_IDS[key];
  const unit = METRIC_UNITS[key];
  if (!descriptor || !unit) {
    return null;
  }
  const value =
    typeof metric.value === "number" && Number.isFinite(metric.value)
      ? metric.value
      : typeof metric.delta === "number" && Number.isFinite(metric.delta)
        ? metric.delta
        : null;
  const denominator =
    typeof metric.denominator === "number" && Number.isFinite(metric.denominator)
      ? Math.max(0, metric.denominator)
      : count(metric.pairedCaseCount);
  const available = metric.status === "AVAILABLE" || metric.status === "PARTIAL";
  const eligibleCount = count(metric.eligibleCount ?? metric.pairedCaseCount);
  const totalCount =
    metric.totalCount !== undefined
      ? count(metric.totalCount)
      : fraction(metric.coverage) > 0
        ? Math.max(eligibleCount, Math.round(eligibleCount / fraction(metric.coverage)))
        : eligibleCount;
  const reasonCodes = safeStrings(metric.reasonCodes);
  const suppliedMissingness = objectValue(metric.missingness)
    ? metric.missingness
    : null;
  return {
    metricId: descriptor[0],
    direction: descriptor[1],
    unit,
    value,
    denominator,
    coverage: fraction(metric.coverage),
    confidenceInterval: publicInterval(metric.interval),
    eligibility: available ? "ELIGIBLE" : "UNKNOWN",
    reasons: reasonCodes,
    missingness: {
      count: suppliedMissingness
        ? count(suppliedMissingness.count)
        : Math.max(0, totalCount - eligibleCount),
      reasonCodes: suppliedMissingness
        ? safeStrings(suppliedMissingness.reasonCodes)
        : reasonCodes,
    },
    exclusions: records(metric.exclusions).map((entry) => ({
      caseId: entry.caseId,
      reasonCodes: safeStrings(entry.reasonCodes),
    })),
  };
}

/** @param {unknown} metrics */
function publicMetrics(metrics) {
  if (!objectValue(metrics)) {
    return [];
  }
  return Object.keys(metrics)
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((key) => publicMetric(metrics[key], key))
    .filter((metric) => metric !== null);
}

/** @param {unknown} frontier */
function publicFrontier(frontier) {
  const value = objectValue(frontier) ? frontier : {};
  return [
    ...records(value.frontier).map((point) => ({
      variantId: point.variantId,
      status: "NON_DOMINATED",
    })),
    ...records(value.dominated).map((point) => ({
      variantId: point.variantId,
      status: "DOMINATED",
      ...(Array.isArray(point.dominatedBy) ? { dominatedBy: point.dominatedBy } : {}),
    })),
    ...records(value.unknown).map((point) => ({
      variantId: point.variantId,
      status: "UNKNOWN",
    })),
  ].sort((left, right) =>
    String(left.variantId).localeCompare(String(right.variantId), "en"),
  );
}

/** @param {unknown} variants */
function publicVariants(variants) {
  return records(variants).map((variant) => ({
    variantId: safeAlias(variant.variantId, "unknown-variant"),
    eligible: variant.eligible !== false,
    metrics: publicMetrics(variant.metrics),
    reasons: safeStrings(variant.reasonCodes ?? variant.reasons),
  }));
}

/** @param {unknown} comparisons */
function publicComparisons(comparisons) {
  return records(comparisons).map((comparison) => ({
    baselineVariantId: safeAlias(comparison.baselineVariantId, "unknown-variant"),
    candidateVariantId: safeAlias(comparison.candidateVariantId, "unknown-variant"),
    pairedCaseCount: count(comparison.pairedCaseCount),
    metrics: publicMetrics(comparison.metrics),
  }));
}

/** @param {unknown} value */
function publicMultiplicity(value) {
  if (
    !objectValue(value) ||
    value.method !== "HOLM_BONFERRONI" ||
    !Number.isSafeInteger(value.familySize) ||
    value.familySize < 1 ||
    value.familySize > 8 ||
    typeof value.adjustedConfidenceLevel !== "number" ||
    !Number.isFinite(value.adjustedConfidenceLevel) ||
    value.adjustedConfidenceLevel <= 0 ||
    value.adjustedConfidenceLevel >= 1
  ) {
    return null;
  }
  return {
    method: "HOLM_BONFERRONI",
    familySize: value.familySize,
    adjustedConfidenceLevel: value.adjustedConfidenceLevel,
  };
}

/** @param {Record<string, any>} lane @param {Record<string, any> | undefined} normalizedLane */
function publicBenchmarkLane(lane, normalizedLane) {
  const global = objectValue(lane.global) ? lane.global : lane;
  const pairing = objectValue(lane.pairing) ? lane.pairing : {};
  const pricingSnapshot = objectValue(lane.pricingSnapshot) ? lane.pricingSnapshot : {};
  return {
    bundleId: safeAlias(lane.bundleId, lane.laneId ?? "unknown-bundle"),
    laneId: safeAlias(lane.laneId, "unknown-lane"),
    laneType: safeAlias(lane.laneType, "PORTABLE_CORE_MODEL"),
    status: status(lane.status),
    attributionStatus: safeAlias(lane.attributionStatus, "UNKNOWN"),
    claimBoundary: safeJsonText(
      lane.claimBoundary ??
        "Lane evidence supports only the declared comparison scope.",
    ),
    currency:
      typeof pricingSnapshot.currency === "string" ? pricingSnapshot.currency : null,
    costBasis:
      typeof pricingSnapshot.costBasis === "string" ? pricingSnapshot.costBasis : null,
    decisionEligible: lane.eligibleForRanking === true,
    replicateAggregation:
      typeof (
        lane.replicateAggregation ?? normalizedLane?.evalProtocol?.replicateAggregation
      ) === "string"
        ? (lane.replicateAggregation ??
          normalizedLane?.evalProtocol?.replicateAggregation)
        : null,
    missingReplicatePolicy:
      typeof (
        lane.missingReplicatePolicy ??
        normalizedLane?.evalProtocol?.missingReplicatePolicy
      ) === "string"
        ? (lane.missingReplicatePolicy ??
          normalizedLane?.evalProtocol?.missingReplicatePolicy)
        : null,
    pairedCaseCount: count(lane.pairedCaseCount),
    exclusions: records(pairing.excludedCases).map((entry) => ({
      caseId: entry.caseId,
      reasonCodes: safeStrings(entry.reasonCodes),
    })),
    global: {
      variants: publicVariants(global.variants),
      frontier: publicFrontier(global.frontier),
    },
    slices: records(lane.slices).map((slice) => ({
      sliceId: safeAlias(slice.sliceId, "unknown-slice"),
      status: status(slice.status),
      decisionEligible: slice.decisionEligible === true,
      descriptiveOnly: slice.descriptiveOnly === true,
      multiplicity: publicMultiplicity(slice.multiplicity),
      pairedCaseCount: count(slice.pairedCaseCount),
      variants: publicVariants(slice.variants),
      comparisons: publicComparisons(slice.comparisons),
      frontier: publicFrontier(slice.frontier),
      limitations: safeStrings(slice.limitations),
    })),
    comparisons: publicComparisons(global.comparisons ?? lane.comparisons),
    limitations: safeStrings(lane.limitations),
  };
}

/** @param {Record<string, any>} config @param {Record<string, any>} limits @param {Record<string, any>[]} loaded @param {Record<string, any>} core @param {Record<string, any>[]} loadedBundles */
function normalizationReport(config, limits, loaded, core, loadedBundles) {
  return {
    ...envelope(config, limits, loaded),
    status: status(core.status),
    warnings: warnings(core.warnings),
    claimBoundary:
      "Normalization reports bounded structural receipts only; canonical run content is not emitted.",
    bundles: records(core.lanes).map((lane, index) =>
      normalizationBundle(
        lane,
        loadedBundles[index]?.sourceMode ?? "CANONICAL_RECORDS",
      ),
    ),
    limitations: [
      "Normalization is deterministic and in-memory; downstream commands recompute it from declared inputs.",
    ],
  };
}

/** @param {Record<string, any>} config @param {Record<string, any>} limits @param {Record<string, any>[]} loaded @param {Record<string, any>} core */
function evalReport(config, limits, loaded, core) {
  const evalValidity = objectValue(core.evalValidity) ? core.evalValidity : core;
  const normalizedLanes = records(core.normalization?.lanes);
  const staticDiagnostics = objectValue(core.staticDiagnostics)
    ? core.staticDiagnostics
    : null;
  return {
    ...envelope(config, limits, loaded),
    status: status(evalValidity.status),
    warnings: warnings(evalValidity.warnings),
    claimBoundary:
      "Eval validity describes declared causal evidence; it does not prove private runtime behavior.",
    lanes: records(evalValidity.lanes).map((lane, index) =>
      publicEvalLane(lane, normalizedLanes[index]?.bundleId),
    ),
    staticDiagnosticContext: staticDiagnostics ? "SUPPLIED" : "NOT_SUPPLIED",
    ...(staticDiagnostics ? { staticDiagnostics } : {}),
    limitations: [
      "Static diagnostics are secondary and cannot establish benchmark causality.",
      ...safeStrings(evalValidity.reasonCodes),
    ],
  };
}

/** @param {Record<string, any>} config @param {Record<string, any>} limits @param {Record<string, any>[]} loaded @param {Record<string, any>} core */
function benchmarkReport(config, limits, loaded, core) {
  const scorecard = objectValue(core.scorecard) ? core.scorecard : core;
  const normalizedLanes = records(core.normalization?.lanes);
  const methodology = objectValue(scorecard.methodology) ? scorecard.methodology : {};
  return {
    ...envelope(config, limits, loaded),
    status: status(scorecard.status),
    warnings: warnings(scorecard.warnings),
    claimBoundary:
      "Benchmark lanes are compared only within declared compatible cohorts; incompatible lanes are not pooled.",
    lanes: records(scorecard.lanes).map((lane, index) =>
      publicBenchmarkLane(lane, normalizedLanes[index]),
    ),
    methodology: {
      quantile: "LINEAR_INTERPOLATION",
      confidence: "PAIRED_BOOTSTRAP_PERCENTILE",
      confidenceLevel:
        typeof methodology.confidenceLevel === "number"
          ? methodology.confidenceLevel
          : 0.95,
      bootstrapIterations: count(methodology.bootstrapIterations) || 10_000,
      bootstrapSeed: safeAlias(methodology.bootstrapSeed, "reviewops-v1"),
    },
    limitations: [
      ...safeStrings(scorecard.limitations),
      "Point estimates and intervals are descriptive unless eval validity is complete.",
    ],
  };
}

/** @param {Record<string, any>} config @param {Record<string, any>} limits @param {Record<string, any>[]} loaded @param {Record<string, any>} core */
function recommendationReport(config, limits, loaded, core) {
  const recommendation = objectValue(core.recommendation) ? core.recommendation : {};
  const policyRedaction = objectValue(recommendation.decisionPolicy)
    ? redactJsonValue(recommendation.decisionPolicy)
    : { value: null, count: 0 };
  const reportEnvelope = envelope(config, limits, loaded);
  const recommendationStatus =
    typeof recommendation.recommendationStatus === "string"
      ? recommendation.recommendationStatus
      : "INSUFFICIENT_EVIDENCE";
  const topStatus =
    recommendationStatus === "BLOCKED_BY_SAFETY_GATE"
      ? "BLOCKED"
      : recommendationStatus === "INSUFFICIENT_EVIDENCE"
        ? "INSUFFICIENT_EVIDENCE"
        : "COMPLETE";
  return {
    ...reportEnvelope,
    redactionCounts: {
      total: reportEnvelope.redactionCounts.total + policyRedaction.count,
    },
    status: topStatus,
    warnings: warnings(core.scorecard?.warnings),
    claimBoundary:
      "Reference architecture is shadow-only guidance; it does not authorize posting or production changes.",
    recommendationStatus,
    decisionPolicyId: recommendation.decisionPolicyId ?? null,
    decisionPolicy: policyRedaction.value,
    gates: records(recommendation.gates),
    lanes: records(recommendation.lanes),
    ...(typeof recommendation.defaultArchitectureId === "string"
      ? { defaultArchitectureId: recommendation.defaultArchitectureId }
      : {}),
    perSliceArchitectures: records(recommendation.perSliceArchitectures),
    preservedContracts: objectValue(recommendation.preservedContracts)
      ? recommendation.preservedContracts
      : null,
    ...(objectValue(recommendation.shadowPilot)
      ? { shadowPilot: recommendation.shadowPilot }
      : {}),
    rationale: safeStrings(recommendation.rationale),
    limitations: safeStrings(recommendation.limitations),
  };
}

/** @param {unknown} value */
function markdownValue(value) {
  if (value === null || value === undefined) {
    return "Unavailable";
  }
  return safeText(value).replaceAll("|", "\\|");
}

/** @param {unknown} value */
function plainReason(value) {
  const code = String(value);
  /** @type {Record<string, string>} */
  const explanations = {
    DECISION_POLICY_VALID: "The versioned decision policy is complete and valid.",
    MISSING_OR_INVALID_DECISION_POLICY:
      "A complete, valid decision policy is required.",
    INPUT_INTEGRITY_SATISFIED: "No unresolved input-integrity issue was found.",
    UNRESOLVED_INPUT_INTEGRITY_WARNING:
      "An unresolved input-integrity issue blocks the recommendation.",
    EVAL_VALIDITY_SATISFIED:
      "The selected lane has complete evaluation-validity evidence.",
    NO_ELIGIBLE_EVAL_LANE: "No lane has complete, attributable evaluation evidence.",
    MISSING_LANE_EVIDENCE: "No lane evidence was supplied.",
    MINIMUM_PAIRED_CASES_SATISFIED:
      "The selected lane meets the required paired-case count.",
    INSUFFICIENT_PAIRED_CASES:
      "The selected lane has fewer paired cases than the policy requires.",
    FULLY_LOADED_COST_EVIDENCE_SATISFIED:
      "The selected lane uses fully loaded cost evidence.",
    MISSING_FULLY_LOADED_COST_EVIDENCE: "Fully loaded cost evidence is missing.",
    STALE_OR_FUTURE_PRICING:
      "Pricing is missing, stale, or dated after the analysis time.",
    SHADOW_NO_POSTING_SATISFIED: "The shadow lane is configured with posting disabled.",
    SHADOW_POSTING_NOT_DISABLED:
      "The shadow lane does not prove that posting is disabled.",
    COMPARISON_VARIANTS_PRESENT:
      "The baseline and candidate comparison are both present.",
    MISSING_COMPARISON_VARIANT:
      "The selected baseline or candidate comparison is missing.",
    CANDIDATE_IS_NON_DOMINATED: "The candidate is on the non-dominated frontier.",
    CANDIDATE_IS_DOMINATED: "The candidate is dominated by another variant.",
    MISSING_PARETO_FRONTIER: "No eligible Pareto frontier is available.",
    METRIC_COVERAGE_SATISFIED: "Required metrics meet the policy coverage threshold.",
    INSUFFICIENT_METRIC_COVERAGE: "One or more required metrics lack enough coverage.",
    NON_INFERIORITY_SATISFIED:
      "The confidence interval meets the non-inferiority bound.",
    NON_INFERIORITY_NOT_SATISFIED:
      "The confidence interval does not meet the non-inferiority bound.",
    MISSING_CONFIDENCE_INTERVAL: "A required confidence interval is unavailable.",
    COST_IMPROVEMENT_SATISFIED: "The cost interval meets the required improvement.",
    COST_IMPROVEMENT_NOT_SATISFIED:
      "The cost interval does not meet the required improvement.",
    MISSING_COST_EVIDENCE: "Required cost evidence is unavailable.",
    GUARDRAIL_SATISFIED: "The confidence interval stays within the guardrail.",
    GUARDRAIL_NOT_SATISFIED: "The confidence interval exceeds the guardrail.",
    MISSING_GUARDRAIL_EVIDENCE:
      "A required guardrail metric or interval is unavailable.",
    APPROVED_EXCEPTION_APPLIED: "A scoped, unexpired policy exception applies.",
    FINDING_STABILITY_SATISFIED: "Finding stability meets the policy threshold.",
    FINDING_STABILITY_NOT_SATISFIED: "Finding stability is below the policy threshold.",
    MISSING_STABILITY_EVIDENCE: "Finding-stability evidence is unavailable.",
    PRODUCTION_CONTRACTS_PRESERVED:
      "Controller, validator, dedupe, and posting contracts are preserved.",
    PRODUCTION_CONTRACT_NOT_PRESERVED: "A protected production contract changed.",
    STATIC_DIAGNOSTICS_NOT_SUPPLIED: "No optional static diagnostics were supplied.",
    STATIC_DIAGNOSTICS_NON_BLOCKING:
      "Supplied static diagnostics do not meet the blocking predicate.",
    STATIC_DIAGNOSTICS_BLOCKED: "Static diagnostics could not be evaluated safely.",
    STATIC_SAFETY_FINDING_BLOCKS_SHADOW:
      "A policy-bound observed critical finding blocks the shadow path.",
    LANE_SCOPED_EVIDENCE: "The recommendation uses one lane's verified evidence.",
    RECOMMENDATION_LANES_COMPATIBLE:
      "All recommendation lanes have compatible provenance.",
    MISSING_LANE_PROVENANCE: "Lane provenance is missing, so lanes cannot be combined.",
    INCOMPATIBLE_RECOMMENDATION_LANES:
      "Recommendation lanes have incompatible provenance.",
    INCOMPATIBLE_ARCHITECTURE_PROVENANCE:
      "The architecture identity differs across recommendation lanes.",
  };
  if (Object.hasOwn(explanations, code)) {
    return explanations[code];
  }
  const words = code.toLowerCase().replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1) + ".";
}

/** @param {Record<string, any>} metric */
function metricMissingness(metric) {
  const missingness = objectValue(metric.missingness) ? metric.missingness : {};
  const countValue = count(missingness.count);
  const reasons = safeStrings(missingness.reasonCodes);
  return (
    String(countValue) + (reasons.length > 0 ? " (" + reasons.join(", ") + ")" : "")
  );
}

/** @param {Record<string, any>} metric */
function metricExclusions(metric) {
  const exclusions = records(metric.exclusions);
  if (exclusions.length === 0) {
    return "0";
  }
  const reasons = [
    ...new Set(exclusions.flatMap((entry) => safeStrings(entry.reasonCodes))),
  ].sort((left, right) => left.localeCompare(right, "en"));
  return (
    String(exclusions.length) +
    (reasons.length > 0 ? " (" + reasons.join(", ") + ")" : "")
  );
}

/** @param {unknown} value */
function multiplicitySummary(value) {
  if (!objectValue(value)) {
    return "None";
  }
  return (
    String(value.method ?? "Unknown") +
    "; family " +
    String(value.familySize ?? "unknown") +
    "; confidence " +
    String(value.adjustedConfidenceLevel ?? "unknown")
  );
}

/** @param {Record<string, any>} report @param {string} command */
function renderMarkdown(report, command) {
  const title = {
    "validate-config": "ReviewOps config validation",
    normalize: "ReviewOps normalization report",
    "audit-eval": "ReviewOps eval validity report",
    benchmark: "ReviewOps benchmark scorecard",
    "recommend-architecture": "ReviewOps reference architecture",
  }[command];
  const lines = [
    "# " + title,
    "",
    "Status: " + markdownValue(report.status),
    "Analysis as of: " + markdownValue(report.analysisAsOf),
    "Claim boundary: " + markdownValue(report.claimBoundary ?? "Unavailable"),
    "",
    "## Inputs",
    "",
  ];
  if (report.inputDigests.length === 0) {
    lines.push("No input digests are available.");
  } else {
    lines.push("| Kind | Path | Digest |", "| --- | --- | --- |");
    for (const input of report.inputDigests) {
      lines.push(
        "| " +
          markdownValue(input.kind) +
          " | " +
          markdownValue(input.path) +
          " | " +
          markdownValue(input.digest) +
          " |",
      );
    }
  }
  lines.push("");
  if (command === "normalize") {
    lines.push(
      "## Bundles",
      "",
      "| Bundle | Source mode | Status | Source | Accepted | Rejected | Duplicates | Normalized | Exporters | Reasons |",
      "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |",
    );
    for (const bundle of report.bundles) {
      lines.push(
        "| " +
          markdownValue(bundle.bundleId) +
          " | " +
          markdownValue(bundle.sourceMode) +
          " | " +
          markdownValue(bundle.status) +
          " | " +
          markdownValue(bundle.sourceRecordCount) +
          " | " +
          markdownValue(bundle.acceptedRecordCount) +
          " | " +
          markdownValue(bundle.rejectedRecordCount) +
          " | " +
          markdownValue(bundle.duplicateRecordCount) +
          " | " +
          markdownValue(bundle.normalizedRecordCount) +
          " | " +
          markdownValue(bundle.exporterVersions.join(", ") || "None") +
          " | " +
          markdownValue(bundle.reasonCodes.join(", ") || "None") +
          " |",
      );
    }
    lines.push(
      "",
      "### Structural receipts",
      "",
      "| Bundle | Kind | Digest |",
      "| --- | --- | --- |",
    );
    for (const bundle of report.bundles) {
      for (const receipt of bundle.receipts) {
        lines.push(
          "| " +
            markdownValue(bundle.bundleId) +
            " | " +
            markdownValue(receipt.kind) +
            " | " +
            markdownValue(receipt.digest) +
            " |",
        );
      }
    }
    lines.push("");
  }
  if (command === "audit-eval") {
    lines.push(
      "## Lanes",
      "",
      "| Lane | Type | Status | Attribution | Paired cases | Pairing coverage | Claim boundary |",
      "| --- | --- | --- | --- | ---: | ---: | --- |",
    );
    for (const lane of report.lanes) {
      lines.push(
        "| " +
          markdownValue(lane.laneId) +
          " | " +
          markdownValue(lane.laneType) +
          " | " +
          markdownValue(lane.status) +
          " | " +
          markdownValue(lane.attributionStatus) +
          " | " +
          markdownValue(lane.pairedCaseCount) +
          " | " +
          markdownValue(lane.pairingCoverage) +
          " | " +
          markdownValue(lane.claimBoundary) +
          " |",
      );
    }
    lines.push(
      "",
      "### Declared dimensions and evidence still required",
      "",
      "| Lane | Held constant | Intentionally changed | Unexpected | Missing | Evidence required | Reasons |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const lane of report.lanes) {
      lines.push(
        "| " +
          markdownValue(lane.laneId) +
          " | " +
          markdownValue(lane.heldConstantDimensions.join(", ") || "None") +
          " | " +
          markdownValue(lane.intentionallyChangedDimensions.join(", ") || "None") +
          " | " +
          markdownValue(lane.unexpectedDimensions.join(", ") || "None") +
          " | " +
          markdownValue(lane.missingDimensions.join(", ") || "None") +
          " | " +
          markdownValue(lane.evidenceRequired.join(", ") || "None") +
          " | " +
          markdownValue(lane.reasonCodes.join(", ") || "None") +
          " |",
      );
    }
    lines.push(
      "",
      "### Eval checks",
      "",
      "| Lane | Rule | Status | Evidence | Reason |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const lane of report.lanes) {
      for (const check of lane.checks) {
        lines.push(
          "| " +
            markdownValue(lane.laneId) +
            " | " +
            markdownValue(check.ruleId) +
            " | " +
            markdownValue(check.status) +
            " | " +
            markdownValue(check.evidenceStatus) +
            " | " +
            markdownValue(check.reason) +
            " |",
        );
      }
    }
    lines.push(
      "",
      "### Exclusions and lane limitations",
      "",
      "| Lane | Case | Reasons |",
      "| --- | --- | --- |",
    );
    for (const lane of report.lanes) {
      if (lane.exclusions.length === 0) {
        lines.push(
          "| " +
            markdownValue(lane.laneId) +
            " | None | " +
            markdownValue(lane.limitations.join(", ") || "None") +
            " |",
        );
      }
      for (const exclusion of lane.exclusions) {
        lines.push(
          "| " +
            markdownValue(lane.laneId) +
            " | " +
            markdownValue(exclusion.caseId) +
            " | " +
            markdownValue(exclusion.reasonCodes.join(", ") || "None") +
            " |",
        );
      }
    }
    lines.push(
      "",
      "## Static diagnostic context",
      "",
      "Status: " + markdownValue(report.staticDiagnosticContext),
      "",
    );
    if (report.staticDiagnostics) {
      lines.push(
        "Static diagnostics are secondary context. A possible contributor is not causal evidence.",
        "",
        "| Rule | Evidence | Severity | Binding | Applicable to shadow | Blocks shadow | Possible contributor | Interpretation | Summary |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      );
      for (const finding of report.staticDiagnostics.findings ?? []) {
        const binding = finding.binding
          ? finding.binding.laneId +
            "/" +
            finding.binding.variantId +
            "/" +
            finding.binding.architectureStructuralDigest
          : "None";
        lines.push(
          "| " +
            markdownValue(finding.ruleId) +
            " | " +
            markdownValue(finding.evidenceStatus) +
            " | " +
            markdownValue(finding.severity) +
            " | " +
            markdownValue(binding) +
            " | " +
            markdownValue(finding.applicableToShadowPath) +
            " | " +
            markdownValue(finding.blocksShadowPath) +
            " | " +
            markdownValue(finding.possibleContributorOnly) +
            " | " +
            markdownValue(
              finding.possibleContributorOnly
                ? "Possible contributor; not causal evidence."
                : "Policy-bound safety blocker; not causal evidence.",
            ) +
            " | " +
            markdownValue(finding.summary) +
            " |",
        );
      }
      lines.push("");
    }
  }
  if (command === "benchmark") {
    lines.push(
      "## Lanes",
      "",
      "| Lane | Type | Status | Attribution | Currency | Cost basis | Decision eligible | Replicate aggregation | Missing replicate policy | Paired cases | Claim boundary |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | ---: | --- |",
    );
    for (const lane of report.lanes) {
      lines.push(
        "| " +
          markdownValue(lane.laneId) +
          " | " +
          markdownValue(lane.laneType) +
          " | " +
          markdownValue(lane.status) +
          " | " +
          markdownValue(lane.attributionStatus) +
          " | " +
          markdownValue(lane.currency) +
          " | " +
          markdownValue(lane.costBasis) +
          " | " +
          markdownValue(lane.decisionEligible) +
          " | " +
          markdownValue(lane.replicateAggregation) +
          " | " +
          markdownValue(lane.missingReplicatePolicy) +
          " | " +
          markdownValue(lane.pairedCaseCount) +
          " | " +
          markdownValue(lane.claimBoundary) +
          " |",
      );
    }
    lines.push(
      "",
      "### Variant metrics",
      "",
      "| Lane | Variant | Eligible | Metric | Unit | Value | Denominator | Coverage | Interval | Missingness | Exclusions | Reasons |",
      "| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- | --- |",
    );
    for (const lane of report.lanes) {
      for (const variant of lane.global.variants) {
        for (const metric of variant.metrics) {
          const interval = metric.confidenceInterval
            ? "[" +
              metric.confidenceInterval.lower +
              ", " +
              metric.confidenceInterval.upper +
              "]"
            : "Unavailable";
          lines.push(
            "| " +
              markdownValue(lane.laneId) +
              " | " +
              markdownValue(variant.variantId) +
              " | " +
              markdownValue(variant.eligible) +
              " | " +
              markdownValue(metric.metricId) +
              " | " +
              markdownValue(metric.unit) +
              " | " +
              markdownValue(metric.value) +
              " | " +
              markdownValue(metric.denominator) +
              " | " +
              markdownValue(metric.coverage) +
              " | " +
              markdownValue(interval) +
              " | " +
              markdownValue(metricMissingness(metric)) +
              " | " +
              markdownValue(metricExclusions(metric)) +
              " | " +
              markdownValue(metric.reasons.join(", ") || "None") +
              " |",
          );
        }
      }
    }
    lines.push(
      "",
      "### Pareto frontier",
      "",
      "| Lane | Variant | Status | Dominated by |",
      "| --- | --- | --- | --- |",
    );
    for (const lane of report.lanes) {
      for (const point of lane.global.frontier) {
        lines.push(
          "| " +
            markdownValue(lane.laneId) +
            " | " +
            markdownValue(point.variantId) +
            " | " +
            markdownValue(point.status) +
            " | " +
            markdownValue((point.dominatedBy ?? []).join(", ") || "None") +
            " |",
        );
      }
    }
    lines.push(
      "",
      "### Paired comparisons",
      "",
      "| Lane | Baseline | Candidate | Paired cases | Metric | Unit | Value | Denominator | Coverage | Interval | Missingness | Exclusions |",
      "| --- | --- | --- | ---: | --- | --- | ---: | ---: | ---: | --- | --- | --- |",
    );
    for (const lane of report.lanes) {
      for (const comparison of lane.comparisons) {
        if (comparison.metrics.length === 0) {
          lines.push(
            "| " +
              markdownValue(lane.laneId) +
              " | " +
              markdownValue(comparison.baselineVariantId) +
              " | " +
              markdownValue(comparison.candidateVariantId) +
              " | " +
              markdownValue(comparison.pairedCaseCount) +
              " | None | None | Unavailable | 0 | 0 | Unavailable | 0 | 0 |",
          );
        }
        for (const metric of comparison.metrics) {
          const interval = metric.confidenceInterval
            ? "[" +
              metric.confidenceInterval.lower +
              ", " +
              metric.confidenceInterval.upper +
              "]"
            : "Unavailable";
          lines.push(
            "| " +
              markdownValue(lane.laneId) +
              " | " +
              markdownValue(comparison.baselineVariantId) +
              " | " +
              markdownValue(comparison.candidateVariantId) +
              " | " +
              markdownValue(comparison.pairedCaseCount) +
              " | " +
              markdownValue(metric.metricId) +
              " | " +
              markdownValue(metric.unit) +
              " | " +
              markdownValue(metric.value) +
              " | " +
              markdownValue(metric.denominator) +
              " | " +
              markdownValue(metric.coverage) +
              " | " +
              markdownValue(interval) +
              " | " +
              markdownValue(metricMissingness(metric)) +
              " | " +
              markdownValue(metricExclusions(metric)) +
              " |",
          );
        }
      }
    }
    lines.push(
      "",
      "### Slice eligibility",
      "",
      "| Lane | Slice | Status | Decision eligible | Descriptive only | Multiplicity | Paired cases | Limitations |",
      "| --- | --- | --- | --- | --- | --- | ---: | --- |",
    );
    for (const lane of report.lanes) {
      for (const slice of lane.slices) {
        lines.push(
          "| " +
            markdownValue(lane.laneId) +
            " | " +
            markdownValue(slice.sliceId) +
            " | " +
            markdownValue(slice.status) +
            " | " +
            markdownValue(slice.decisionEligible) +
            " | " +
            markdownValue(slice.descriptiveOnly) +
            " | " +
            markdownValue(multiplicitySummary(slice.multiplicity)) +
            " | " +
            markdownValue(slice.pairedCaseCount) +
            " | " +
            markdownValue(slice.limitations.join(", ") || "None") +
            " |",
        );
      }
    }
    lines.push(
      "",
      "### Slice metric evidence",
      "",
      "| Lane | Slice | Variant | Metric | Unit | Value | Denominator | Coverage | Interval | Missingness | Exclusions | Reasons |",
      "| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- | --- |",
    );
    for (const lane of report.lanes) {
      for (const slice of lane.slices) {
        for (const variant of slice.variants) {
          for (const metric of variant.metrics) {
            const interval = metric.confidenceInterval
              ? "[" +
                metric.confidenceInterval.lower +
                ", " +
                metric.confidenceInterval.upper +
                "]"
              : "Unavailable";
            lines.push(
              "| " +
                markdownValue(lane.laneId) +
                " | " +
                markdownValue(slice.sliceId) +
                " | " +
                markdownValue(variant.variantId) +
                " | " +
                markdownValue(metric.metricId) +
                " | " +
                markdownValue(metric.unit) +
                " | " +
                markdownValue(metric.value) +
                " | " +
                markdownValue(metric.denominator) +
                " | " +
                markdownValue(metric.coverage) +
                " | " +
                markdownValue(interval) +
                " | " +
                markdownValue(metricMissingness(metric)) +
                " | " +
                markdownValue(metricExclusions(metric)) +
                " | " +
                markdownValue(metric.reasons.join(", ") || "None") +
                " |",
            );
          }
        }
      }
    }
    lines.push(
      "",
      "### Slice paired comparisons",
      "",
      "| Lane | Slice | Baseline | Candidate | Paired cases | Metric | Unit | Value | Denominator | Coverage | Interval | Missingness | Exclusions |",
      "| --- | --- | --- | --- | ---: | --- | --- | ---: | ---: | ---: | --- | --- | --- |",
    );
    for (const lane of report.lanes) {
      for (const slice of lane.slices) {
        for (const comparison of slice.comparisons) {
          for (const metric of comparison.metrics) {
            const interval = metric.confidenceInterval
              ? "[" +
                metric.confidenceInterval.lower +
                ", " +
                metric.confidenceInterval.upper +
                "]"
              : "Unavailable";
            lines.push(
              "| " +
                markdownValue(lane.laneId) +
                " | " +
                markdownValue(slice.sliceId) +
                " | " +
                markdownValue(comparison.baselineVariantId) +
                " | " +
                markdownValue(comparison.candidateVariantId) +
                " | " +
                markdownValue(comparison.pairedCaseCount) +
                " | " +
                markdownValue(metric.metricId) +
                " | " +
                markdownValue(metric.unit) +
                " | " +
                markdownValue(metric.value) +
                " | " +
                markdownValue(metric.denominator) +
                " | " +
                markdownValue(metric.coverage) +
                " | " +
                markdownValue(interval) +
                " | " +
                markdownValue(metricMissingness(metric)) +
                " | " +
                markdownValue(metricExclusions(metric)) +
                " |",
            );
          }
        }
      }
    }
    lines.push(
      "",
      "### Lane exclusions",
      "",
      "| Lane | Case | Reasons |",
      "| --- | --- | --- |",
    );
    for (const lane of report.lanes) {
      if (lane.exclusions.length === 0) {
        lines.push("| " + markdownValue(lane.laneId) + " | None | None |");
      }
      for (const exclusion of lane.exclusions) {
        lines.push(
          "| " +
            markdownValue(lane.laneId) +
            " | " +
            markdownValue(exclusion.caseId) +
            " | " +
            markdownValue(exclusion.reasonCodes.join(", ") || "None") +
            " |",
        );
      }
    }
    lines.push(
      "",
      "## Methodology",
      "",
      "- Quantile: " + markdownValue(report.methodology.quantile),
      "- Confidence: " + markdownValue(report.methodology.confidence),
      "- Confidence level: " + markdownValue(report.methodology.confidenceLevel),
      "- Bootstrap iterations: " +
        markdownValue(report.methodology.bootstrapIterations),
      "- Bootstrap seed: " + markdownValue(report.methodology.bootstrapSeed),
      "",
    );
  }
  if (command === "recommend-architecture") {
    lines.push(
      "## Recommendation",
      "",
      "Recommendation status: " + markdownValue(report.recommendationStatus),
      "Default architecture: " + markdownValue(report.defaultArchitectureId),
      "Decision policy: " + markdownValue(report.decisionPolicyId),
      "",
      "### Decision policy",
      "",
    );
    if (report.decisionPolicy) {
      lines.push("| Field | Value |", "| --- | --- |");
      for (const name of Object.keys(report.decisionPolicy).sort()) {
        const value = report.decisionPolicy[name];
        lines.push(
          "| " +
            markdownValue(name) +
            " | " +
            markdownValue(
              name === "exceptions"
                ? String(Array.isArray(value) ? value.length : 0) + " declared"
                : Array.isArray(value)
                  ? value.join(", ") || "None"
                  : value,
            ) +
            " |",
        );
      }
      lines.push(
        "",
        "#### Policy exceptions",
        "",
        "| Type | Scope | Approved by | Expires at | Reason |",
        "| --- | --- | --- | --- | --- |",
      );
      for (const exception of records(report.decisionPolicy.exceptions)) {
        lines.push(
          "| " +
            markdownValue(exception.type) +
            " | " +
            markdownValue(exception.scope) +
            " | " +
            markdownValue(exception.approvedBy) +
            " | " +
            markdownValue(exception.expiresAt) +
            " | " +
            markdownValue(exception.reason) +
            " |",
        );
      }
      if (records(report.decisionPolicy.exceptions).length === 0) {
        lines.push("| None | None | None | None | No policy exceptions. |");
      }
    } else {
      lines.push("No decision policy was supplied.");
    }
    lines.push(
      "",
      "### Safety gates",
      "",
      "| Gate | Status | Reason code | Plain-language meaning |",
      "| --- | --- | --- | --- |",
    );
    for (const gate of report.gates) {
      lines.push(
        "| " +
          markdownValue(gate.gateId) +
          " | " +
          markdownValue(gate.status) +
          " | " +
          markdownValue(gate.reason) +
          " | " +
          markdownValue(plainReason(gate.reason)) +
          " |",
      );
    }
    lines.push(
      "",
      "### Lane evidence",
      "",
      "| Lane | Type | Status | Attribution | Claim boundary |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const lane of report.lanes) {
      lines.push(
        "| " +
          markdownValue(lane.laneId) +
          " | " +
          markdownValue(lane.laneType) +
          " | " +
          markdownValue(lane.status) +
          " | " +
          markdownValue(lane.attributionStatus) +
          " | " +
          markdownValue(lane.claimBoundary) +
          " |",
      );
    }
    lines.push("", "### Preserved production contracts", "");
    if (report.preservedContracts) {
      for (const [name, value] of Object.entries(report.preservedContracts)) {
        lines.push("- " + markdownValue(name) + ": " + markdownValue(value));
      }
    } else {
      lines.push("No preserved contract evidence is available.");
    }
    lines.push(
      "",
      "### Per-slice architecture",
      "",
      "| Slice | Status | Architecture | Evidence | Reasons |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const slice of report.perSliceArchitectures) {
      lines.push(
        "| " +
          markdownValue(slice.sliceId) +
          " | " +
          markdownValue(slice.status) +
          " | " +
          markdownValue(slice.architectureId) +
          " | " +
          markdownValue(
            slice.status === "COMPLETE"
              ? "Adjusted interval-backed gates passed; see benchmark slice comparisons."
              : "No eligible adjusted interval evidence.",
          ) +
          " | " +
          markdownValue((slice.reasonCodes ?? []).join(", ") || "None") +
          " |",
      );
    }
    lines.push("");
    if (report.shadowPilot) {
      lines.push(
        "### Shadow-only pilot",
        "",
        "- Execution mode: " + markdownValue(report.shadowPilot.executionMode),
        "- Minimum cases: " + markdownValue(report.shadowPilot.minimumCases),
        "- Observation days: " + markdownValue(report.shadowPilot.observationDays),
        "- Human approval required: " +
          markdownValue(report.shadowPilot.humanApprovalRequired),
        "- Rollback critical misses: " +
          markdownValue(report.shadowPilot.rollbackCriticalMisses),
        "",
      );
    }
    lines.push("### Rationale", "");
    for (const reason of report.rationale) {
      lines.push("- " + markdownValue(reason));
    }
    lines.push("");
  }
  if (report.warnings.length > 0) {
    lines.push("## Warnings", "");
    for (const item of report.warnings) {
      lines.push("- " + markdownValue(item.code) + ": " + markdownValue(item.message));
    }
    lines.push("");
  }
  if (report.limitations.length > 0) {
    lines.push("## Limitations", "");
    for (const limitation of report.limitations) {
      lines.push("- " + markdownValue(limitation));
    }
    lines.push("");
  }
  lines.push(
    "## Safety notes",
    "",
    "- Redactions: " + markdownValue(report.redactionCounts.total),
    "- Maximum files: " + markdownValue(report.appliedLimits.maxFiles),
    "- Maximum bytes per file: " + markdownValue(report.appliedLimits.maxBytesPerFile),
    "- Maximum total bytes: " + markdownValue(report.appliedLimits.maxTotalBytes),
    "- Maximum records: " + markdownValue(report.appliedLimits.maxRecords),
    "",
  );
  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  if (
    argv.length === 1 &&
    (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help")
  ) {
    writeBoundedOutput(HELP_TEXT + "\n");
    return;
  }
  const args = parseArgs(argv);
  const schemas = await createSchemaRegistry(pluginRoot);
  const trustedRoot = args.fixture
    ? path.join(pluginRoot, "fixtures", "synthetic")
    : process.cwd();
  const configPath = args.fixture ? "reviewops.config.json" : args.configPath;
  const configFile = await readTrustedConfigFile({ trustedRoot, configPath });
  const config = parseJsonText(
    configFile.text,
    configFile.relativePath,
    DEFAULT_LIMITS,
  );
  schemas.assert("config", config);
  const context = await createTrustedPathContext({
    trustedRoot,
    inputRoots: config.inputRoots,
    limits: config.limits,
  });
  const loaded = [{ ...configFile, kind: "CONFIG" }];
  if (args.command === "validate-config") {
    const report = {
      ...envelope(config, context.limits, loaded),
      status: "COMPLETE",
      warnings: [],
      claimBoundary:
        "Validation checks declared config shape and bounded roots; it does not inspect analysis inputs.",
      limitations: [
        "Input files are inspected only by the requested analysis command.",
      ],
    };
    schemas.assert("config-validation", report);
    writeBoundedOutput(
      args.format === "json"
        ? stableJson(report) + "\n"
        : renderMarkdown(report, args.command),
    );
    return;
  }

  const laneBundles = await loadLaneBundles(schemas, context, config, loaded);
  const decisionPolicy = await loadDecisionPolicy(schemas, context, config, loaded);
  const staticDiagnostics = await loadStaticDiagnostics(
    schemas,
    context,
    config,
    loaded,
  );
  const payload = {
    input: { laneBundles },
    options: { limits: context.limits, decisionPolicy },
    decisionPolicy,
    analysisAsOf: config.analysisAsOf,
    ...(staticDiagnostics
      ? {
          staticInputs: staticDiagnostics.inputs,
          staticBindings: staticDiagnostics.bindings,
        }
      : {}),
  };
  let report;
  if (args.command === "normalize") {
    const core = await runBoundedAnalysis("normalize", payload);
    failForBlockedCore(core);
    report = normalizationReport(config, context.limits, loaded, core, laneBundles);
    schemas.assert("normalization-report", report);
  } else if (args.command === "audit-eval") {
    const core = await runBoundedAnalysis("audit-eval", payload);
    failForBlockedCore(core);
    report = evalReport(config, context.limits, loaded, core);
    schemas.assert("eval-validity-report", report);
  } else if (args.command === "benchmark") {
    const core = await runBoundedAnalysis("benchmark", payload);
    failForBlockedCore(core);
    report = benchmarkReport(config, context.limits, loaded, core);
    schemas.assert("benchmark-scorecard", report);
  } else {
    const core = await runBoundedAnalysis("recommend-architecture", payload);
    failForBlockedCore(core);
    report = recommendationReport(config, context.limits, loaded, core);
    schemas.assert("reference-architecture-recommendation", report);
  }
  const output =
    args.format === "json"
      ? stableJson(report) + "\n"
      : renderMarkdown(report, args.command);
  writeBoundedOutput(output);
  if (report.status === "INSUFFICIENT_EVIDENCE") {
    process.exitCode = 3;
  } else if (report.status === "BLOCKED" || report.status === "ERROR") {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  const safeError = publicError(error);
  process.stderr.write(stableJson(safeError) + "\n");
  process.exitCode = safeError.status === "ERROR" ? 4 : 2;
});
