// @ts-check

import {
  redactRelativePath,
  redactedTextShape,
  safeEvidenceSummary,
} from "../redact.mjs";
import { stableSort, structuralDigest } from "../utils.mjs";

/** @typedef {"SECURITY" | "RELIABILITY" | "COST" | "LATENCY" | "QUALITY" | "NOISE" | "TELEMETRY"} FindingCategory */
/** @typedef {"OBSERVED" | "INFERRED" | "UNKNOWN"} EvidenceStatus */
/** @typedef {"INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"} Severity */
/** @typedef {"LOW" | "MEDIUM" | "HIGH"} Confidence */

/**
 * @typedef {{
 *   ruleId: string,
 *   ruleVersion: number,
 *   category: FindingCategory,
 *   evidenceStatus: EvidenceStatus,
 *   severity: Severity,
 *   confidence: Confidence,
 *   location: {path: string, line?: number, endLine?: number},
 *   evidenceSummary: string,
 *   remediation: string,
 *   verification: string,
 *   claimBoundary: string,
 *   missingEvidence: string[]
 * }} AuditFinding
 */

/**
 * @typedef {{
 *   relativePath: string,
 *   text: string,
 *   bytes?: number,
 *   lines?: number
 * }} LoadedTextInput
 */

/**
 * @param {{
 *   ruleId: string,
 *   category: FindingCategory,
 *   evidenceStatus: EvidenceStatus,
 *   severity: Severity,
 *   confidence: Confidence,
 *   path: string,
 *   line?: number,
 *   endLine?: number,
 *   evidenceSummary: string,
 *   remediation: string,
 *   verification: string,
 *   claimBoundary: string,
 *   missingEvidence?: readonly string[]
 * }} input
 * @returns {AuditFinding}
 */
export function makeFinding(input) {
  const pathResult = redactRelativePath(input.path);
  const summary = safeEvidenceSummary(input.evidenceSummary, { maxChars: 240 }).text;
  const remediation = safeEvidenceSummary(input.remediation, { maxChars: 240 }).text;
  const verification = safeEvidenceSummary(input.verification, { maxChars: 240 }).text;
  const claimBoundary = safeEvidenceSummary(input.claimBoundary, {
    maxChars: 240,
  }).text;
  const missingEvidence = [...(input.missingEvidence ?? [])]
    .map((value) => safeEvidenceSummary(value, { maxChars: 120 }).text)
    .sort((left, right) => left.localeCompare(right, "en"));
  const line = input.line;
  const endLine = input.endLine;
  const location = {
    path: pathResult.text,
    ...(typeof line === "number" && Number.isSafeInteger(line) && line > 0
      ? { line }
      : {}),
    ...(typeof endLine === "number" && Number.isSafeInteger(endLine) && endLine > 0
      ? { endLine }
      : {}),
  };

  return {
    ruleId: input.ruleId,
    ruleVersion: 1,
    category: input.category,
    evidenceStatus: input.evidenceStatus,
    severity: input.severity,
    confidence: input.confidence,
    location,
    evidenceSummary: summary,
    remediation,
    verification,
    claimBoundary,
    missingEvidence,
  };
}

/**
 * @param {readonly AuditFinding[]} findings
 * @returns {AuditFinding[]}
 */
export function sortFindings(findings) {
  return stableSort(findings, (left, right) => {
    return (
      left.ruleId.localeCompare(right.ruleId, "en") ||
      left.location.path.localeCompare(right.location.path, "en") ||
      (left.location.line ?? 0) - (right.location.line ?? 0) ||
      left.evidenceSummary.localeCompare(right.evidenceSummary, "en")
    );
  });
}

/**
 * @param {string} text
 * @param {RegExp} pattern
 * @returns {number | undefined}
 */
export function firstMatchingLine(text, pattern) {
  const safePattern = new RegExp(pattern.source, pattern.flags.replaceAll("g", ""));
  const match = safePattern.exec(text);
  if (match === null || match.index === undefined) {
    return undefined;
  }
  let line = 1;
  for (let index = 0; index < match.index; index += 1) {
    if (text[index] === "\n") {
      line += 1;
    }
  }
  return line;
}

/**
 * @param {LoadedTextInput} input
 * @param {Record<string, unknown>} facts
 * @returns {{path: string, bytes: number, lines: number, redactionCount: number, structuralDigest: string}}
 */
export function structuralInputSummary(input, facts) {
  const shape = redactedTextShape(input.text);
  const path = redactRelativePath(input.relativePath).text;
  return {
    path,
    bytes: input.bytes ?? shape.bytes,
    lines: input.lines ?? shape.lines,
    redactionCount: shape.redactions,
    structuralDigest: structuralDigest({
      kind: "text-structure",
      bytes: input.bytes ?? shape.bytes,
      lines: input.lines ?? shape.lines,
      redactionCount: shape.redactions,
      facts,
    }),
  };
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | undefined}
 */
export function objectValue(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} value
 * @returns {unknown[]}
 */
export function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function stringValue(value) {
  return typeof value === "string" ? value : undefined;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function booleanValue(value) {
  return value === true;
}
