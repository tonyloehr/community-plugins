// @ts-check

import { fail } from "../errors.mjs";
import { stableSort } from "../utils.mjs";
import { auditPrompt, PROMPT_RULES } from "./prompt.mjs";
import { sortFindings } from "./common.mjs";
import { auditTelemetryEvidence, TELEMETRY_RULES } from "./telemetry.mjs";
import { auditWorkflow, WORKFLOW_RULES } from "./workflow.mjs";

/** @import {Limits} from "../bounds.mjs" */
/** @import {LoadedTextInput} from "./common.mjs" */

/**
 * @param {unknown} value
 * @returns {value is LoadedTextInput}
 */
function isLoadedTextInput(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return (
    "relativePath" in value &&
    typeof value.relativePath === "string" &&
    "text" in value &&
    typeof value.text === "string"
  );
}

/**
 * @param {unknown} values
 * @returns {LoadedTextInput[]}
 */
function normalizeInputs(values) {
  if (values === undefined) {
    return [];
  }
  if (!Array.isArray(values) || !values.every((value) => isLoadedTextInput(value))) {
    fail("RO_AUDIT_INPUT_INVALID", "Audit inputs must be loaded bounded text files.");
  }
  return stableSort(values, (left, right) =>
    left.relativePath.localeCompare(right.relativePath, "en"),
  );
}

/**
 * Pure audit entrypoint for callers that already loaded files through the path
 * safety module. It has no filesystem, network, subprocess, model, or clock
 * dependency.
 *
 * @param {{
 *   workflows?: unknown,
 *   prompts?: unknown,
 *   telemetry?: unknown,
 *   toolContracts?: unknown,
 *   validatorResults?: unknown
 * }} inputs
 * @param {{limits?: Limits, optional?: boolean}} [options]
 * @returns {{
 *   status: "COMPLETE" | "PARTIAL",
 *   findings: import("./common.mjs").AuditFinding[],
 *   inputs: {
 *     workflows: ReturnType<typeof auditWorkflow>["summary"][],
 *     prompts: ReturnType<typeof auditPrompt>["summary"][],
 *     telemetry: ReturnType<typeof auditTelemetryEvidence>["summaries"]
 *   },
 *   inputDigests: string[],
 *   redactionCount: number,
 *   warnings: string[],
 *   rules: readonly ({id: string, category: string, title: string})[]
 * }}
 */
export function auditLoadedInputs(inputs, options = {}) {
  const workflows = normalizeInputs(inputs.workflows);
  const prompts = normalizeInputs(inputs.prompts);
  const telemetry = normalizeInputs(inputs.telemetry);
  const workflowResults = workflows.map((input) =>
    auditWorkflow(input, { limits: options.limits }),
  );
  const promptResults = prompts.map((input) => auditPrompt(input));
  const telemetryResult = auditTelemetryEvidence({
    telemetry,
    toolContracts: inputs.toolContracts,
    validatorResults: inputs.validatorResults,
  });
  const findings = sortFindings([
    ...workflowResults.flatMap((result) => result.findings),
    ...promptResults.flatMap((result) => result.findings),
    ...telemetryResult.findings,
  ]);
  const workflowSummaries = workflowResults.map((result) => result.summary);
  const promptSummaries = promptResults.map((result) => result.summary);
  const summaries = [
    ...workflowSummaries,
    ...promptSummaries,
    ...telemetryResult.summaries,
  ];
  const warnings = [...telemetryResult.warnings];
  if (!options.optional && workflows.length === 0) {
    warnings.push("No declared workflow input was provided.");
  }
  if (!options.optional && prompts.length === 0) {
    warnings.push("No declared prompt input was provided.");
  }
  const hasTypedTelemetry =
    (Array.isArray(inputs.toolContracts) && inputs.toolContracts.length > 0) ||
    (Array.isArray(inputs.validatorResults) && inputs.validatorResults.length > 0);

  return {
    status:
      workflows.length === 0 &&
      prompts.length === 0 &&
      telemetry.length === 0 &&
      !hasTypedTelemetry
        ? "PARTIAL"
        : "COMPLETE",
    findings,
    inputs: {
      workflows: workflowSummaries,
      prompts: promptSummaries,
      telemetry: telemetryResult.summaries,
    },
    inputDigests: summaries
      .map((summary) => summary.structuralDigest)
      .sort((left, right) => left.localeCompare(right, "en")),
    redactionCount: summaries.reduce(
      (total, summary) => total + summary.redactionCount,
      0,
    ),
    warnings,
    rules: [...WORKFLOW_RULES, ...PROMPT_RULES, ...TELEMETRY_RULES],
  };
}

/** @param {unknown} value @returns {Record<string, unknown>[]} */
function objectRecords(value) {
  return Array.isArray(value)
    ? value.filter(
        (entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
}

/**
 * A binding is intentionally narrow: static diagnostics can only become a
 * shadow blocker when the caller explicitly ties a rule and redacted path to
 * the lane under review. Unbound findings stay explanatory context.
 *
 * @param {import("./common.mjs").AuditFinding} finding
 * @param {unknown} bindings
 */
function bindingForFinding(finding, bindings) {
  const binding = objectRecords(bindings).find((candidate) => {
    return (
      candidate.ruleId === finding.ruleId &&
      candidate.path === finding.location.path &&
      candidate.applicableToShadowPath === true &&
      typeof candidate.laneId === "string" &&
      typeof candidate.variantId === "string" &&
      typeof candidate.architectureStructuralDigest === "string"
    );
  });
  return binding
    ? {
        laneId: binding.laneId,
        variantId: binding.variantId,
        architectureStructuralDigest: binding.architectureStructuralDigest,
      }
    : null;
}

/**
 * Produce the optional, secondary static diagnostic context used beside lane
 * evidence. This remains pure and content-safe: it reports only bounded
 * structural findings and never treats unbound static evidence as causal.
 *
 * @param {{
 *   workflows?: unknown,
 *   prompts?: unknown,
 *   telemetry?: unknown,
 *   toolContracts?: unknown,
 *   validatorResults?: unknown
 * }} inputs
 * @param {{
 *   limits?: Limits,
 *   bindings?: unknown,
 *   blockingStaticRuleIds?: unknown
 * }} [options]
 */
export function buildStaticDiagnostics(inputs, options = {}) {
  const core = auditLoadedInputs(inputs, { limits: options.limits, optional: true });
  const blockingRuleIds = new Set(
    Array.isArray(options.blockingStaticRuleIds)
      ? options.blockingStaticRuleIds.filter((value) => typeof value === "string")
      : [],
  );
  const findings = core.findings.map((finding) => {
    const binding = bindingForFinding(finding, options.bindings);
    const applicableToShadowPath = binding !== null;
    const blocksShadowPath =
      applicableToShadowPath &&
      blockingRuleIds.has(finding.ruleId) &&
      finding.evidenceStatus === "OBSERVED" &&
      finding.severity === "CRITICAL" &&
      finding.confidence === "HIGH";
    return {
      ruleId: finding.ruleId,
      category: finding.category,
      severity: finding.severity,
      evidenceStatus: finding.evidenceStatus,
      confidence: finding.confidence,
      summary: finding.evidenceSummary,
      claimBoundary: finding.claimBoundary,
      possibleContributorOnly: !blocksShadowPath,
      binding,
      applicableToShadowPath,
      blocksShadowPath,
      path: finding.location.path,
      ...(finding.location.line === undefined ? {} : { line: finding.location.line }),
    };
  });
  const observedCount = findings.filter(
    (finding) => finding.evidenceStatus === "OBSERVED",
  ).length;
  const inferredCount = findings.filter(
    (finding) => finding.evidenceStatus === "INFERRED",
  ).length;
  const unknownCount = findings.filter(
    (finding) => finding.evidenceStatus === "UNKNOWN",
  ).length;
  return {
    status: core.status,
    summary: {
      findingCount: findings.length,
      observedCount,
      inferredCount,
      unknownCount,
    },
    findings,
    limitations: [
      "Static diagnostics are secondary context and do not establish benchmark causality.",
      ...(findings.some((finding) => !finding.applicableToShadowPath)
        ? ["Unbound findings remain possible contributors only."]
        : []),
      ...core.warnings,
    ],
  };
}

export const auditStaticDiagnostics = buildStaticDiagnostics;

export { auditPrompt, PROMPT_RULES } from "./prompt.mjs";
export { auditTelemetryEvidence, TELEMETRY_RULES } from "./telemetry.mjs";
export { auditWorkflow, WORKFLOW_RULES } from "./workflow.mjs";
export { makeFinding, sortFindings } from "./common.mjs";
