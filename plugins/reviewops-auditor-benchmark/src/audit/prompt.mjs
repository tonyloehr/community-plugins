// @ts-check

import { utf8Bytes } from "../utils.mjs";
import {
  firstMatchingLine,
  makeFinding,
  sortFindings,
  structuralInputSummary,
} from "./common.mjs";

/** @import {AuditFinding, LoadedTextInput} from "./common.mjs" */

export const PROMPT_RULES = Object.freeze([
  {
    id: "RO-PR-001",
    category: "COST",
    title: "Prompt and context limits are explicit",
  },
  {
    id: "RO-PR-002",
    category: "QUALITY",
    title: "Evidence and uncertainty are required",
  },
  {
    id: "RO-PR-003",
    category: "QUALITY",
    title: "Findings are validated before publishing",
  },
  {
    id: "RO-PR-004",
    category: "NOISE",
    title: "Comment volume and duplicates are bounded",
  },
]);

const LARGE_PROMPT_BYTES = 16 * 1024;

/**
 * @param {string} text
 * @param {RegExp} pattern
 * @returns {boolean}
 */
function matches(text, pattern) {
  return new RegExp(pattern.source, pattern.flags.replaceAll("g", "")).test(text);
}

/**
 * Audits prompt text as inert data. It never renders, follows, interpolates,
 * or executes instructions found in the prompt.
 *
 * @param {LoadedTextInput} input
 * @returns {{
 *   kind: "prompt",
 *   summary: ReturnType<typeof structuralInputSummary> & {characters: number, words: number},
 *   findings: AuditFinding[]
 * }}
 */
export function auditPrompt(input) {
  const text = input.text;
  const bytes = input.bytes ?? utf8Bytes(text);
  const hasExplicitLimit = matches(
    text,
    /\b(?:max(?:imum)?|limit|budget|at most|no more than)\b[\s\S]{0,60}\b(?:tokens?|files?|lines?|comments?|findings?|characters?|bytes?|context)\b/iu,
  );
  const hasEvidence = matches(
    text,
    /\b(?:evidence|citation|cite|line number|file path|exact line|proof)\b/iu,
  );
  const hasUncertainty = matches(
    text,
    /\b(?:uncertain|uncertainty|unknown|cannot verify|insufficient evidence|confidence)\b/iu,
  );
  const hasValidation = matches(
    text,
    /\b(?:validate|validation|verify|verification|prune|suppress unverified|discard unverified)\b/iu,
  );
  const hasPublishingGate = matches(
    text,
    /\b(?:before (?:publishing|posting|commenting)|only (?:publish|post|comment)|require evidence)\b/iu,
  );
  const hasCommentBudget = matches(
    text,
    /\b(?:max(?:imum)?|at most|no more than|budget)\b[\s\S]{0,50}\b(?:comments?|findings?)\b/iu,
  );
  const hasDedupe = matches(
    text,
    /\b(?:deduplicat|de-duplicat|duplicate|suppress|noise)\b/iu,
  );
  const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/u).length;
  /** @type {AuditFinding[]} */
  const findings = [];

  if (bytes > LARGE_PROMPT_BYTES || !hasExplicitLimit) {
    findings.push(
      makeFinding({
        ruleId: "RO-PR-001",
        category: "COST",
        evidenceStatus: "INFERRED",
        severity: bytes > LARGE_PROMPT_BYTES ? "MEDIUM" : "LOW",
        confidence: "MEDIUM",
        path: input.relativePath,
        line: firstMatchingLine(text, /\b(?:max(?:imum)?|limit|budget|context)\b/iu),
        evidenceSummary:
          bytes > LARGE_PROMPT_BYTES
            ? "Prompt text exceeds the conservative 16 KiB review threshold."
            : "No explicit prompt or context limit is visible.",
        remediation: "Declare bounded context, file, token, and finding budgets.",
        verification:
          "Measure imported run context and token telemetry against the declared limits.",
        claimBoundary:
          "Static prompt heuristic only; actual context size requires run telemetry.",
        missingEvidence: ["Context receipts", "Token telemetry"],
      }),
    );
  }

  if (!hasEvidence || !hasUncertainty) {
    findings.push(
      makeFinding({
        ruleId: "RO-PR-002",
        category: "QUALITY",
        evidenceStatus: "INFERRED",
        severity: "MEDIUM",
        confidence: "MEDIUM",
        path: input.relativePath,
        line: firstMatchingLine(
          text,
          /\b(?:evidence|citation|uncertain|unknown|confidence)\b/iu,
        ),
        evidenceSummary:
          !hasEvidence && !hasUncertainty
            ? "No evidence or uncertainty requirement is visible."
            : !hasEvidence
              ? "No evidence requirement is visible."
              : "No uncertainty requirement is visible.",
        remediation:
          "Require file-and-line evidence plus explicit uncertainty for unverifiable claims.",
        verification:
          "Test the prompt on synthetic ambiguous changes and inspect evidence-bearing output.",
        claimBoundary:
          "Keyword-level heuristic only; prompt compliance requires adjudicated runs.",
        missingEvidence: ["Adjudicated finding evidence"],
      }),
    );
  }

  if (!hasValidation || !hasPublishingGate) {
    findings.push(
      makeFinding({
        ruleId: "RO-PR-003",
        category: "QUALITY",
        evidenceStatus: "INFERRED",
        severity: "MEDIUM",
        confidence: "MEDIUM",
        path: input.relativePath,
        line: firstMatchingLine(
          text,
          /\b(?:validate|verify|prune|publish|post|comment)\b/iu,
        ),
        evidenceSummary:
          !hasValidation && !hasPublishingGate
            ? "No validation or publishing gate is visible."
            : !hasValidation
              ? "No validation or pruning instruction is visible."
              : "No pre-publishing gate is visible.",
        remediation:
          "Require deterministic validation and suppress unverified findings before publishing.",
        verification:
          "Compare proposed and published finding IDs in imported validator telemetry.",
        claimBoundary:
          "Static prompt heuristic only; validator behavior is not observed.",
        missingEvidence: ["Validator results tied to finding IDs"],
      }),
    );
  }

  if (!hasCommentBudget || !hasDedupe) {
    findings.push(
      makeFinding({
        ruleId: "RO-PR-004",
        category: "NOISE",
        evidenceStatus: "INFERRED",
        severity: "LOW",
        confidence: "MEDIUM",
        path: input.relativePath,
        line: firstMatchingLine(
          text,
          /\b(?:comment|finding|deduplicat|duplicate|suppress|noise)\b/iu,
        ),
        evidenceSummary:
          !hasCommentBudget && !hasDedupe
            ? "No comment budget or duplicate-suppression rule is visible."
            : !hasCommentBudget
              ? "No comment or finding budget is visible."
              : "No duplicate-suppression rule is visible.",
        remediation:
          "Set a maximum comment budget and deduplicate or suppress repeated findings.",
        verification: "Run synthetic duplicate findings through the publishing policy.",
        claimBoundary:
          "Static prompt heuristic only; actual comment volume requires telemetry.",
        missingEvidence: ["Published comment telemetry"],
      }),
    );
  }

  const summary = structuralInputSummary(input, {
    characters: [...text].length,
    words,
    overConservativeThreshold: bytes > LARGE_PROMPT_BYTES,
    hasExplicitLimit,
    hasEvidence,
    hasUncertainty,
    hasValidation,
    hasPublishingGate,
    hasCommentBudget,
    hasDedupe,
  });
  return {
    kind: "prompt",
    summary: {
      ...summary,
      characters: [...text].length,
      words,
    },
    findings: sortFindings(findings),
  };
}
