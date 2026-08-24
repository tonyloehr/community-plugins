// @ts-check

import { structuralInputSummary, makeFinding, sortFindings } from "./common.mjs";

/** @import {LoadedTextInput, AuditFinding} from "./common.mjs" */

export const TELEMETRY_RULES = Object.freeze([
  {
    id: "RO-TL-001",
    category: "SECURITY",
    title: "Beyond-diff tools have a bounded read-only contract",
  },
  {
    id: "RO-TL-002",
    category: "RELIABILITY",
    title: "Verification checks are bounded and provenance-backed",
  },
  {
    id: "RO-TL-003",
    category: "QUALITY",
    title: "Validator results tie to findings",
  },
]);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>[]}
 */
function records(value) {
  return Array.isArray(value) ? value.filter((item) => isRecord(item)) : [];
}

/**
 * @param {readonly LoadedTextInput[]} telemetry
 * @returns {string}
 */
function evidencePath(telemetry) {
  return telemetry[0]?.relativePath ?? "telemetry-evidence";
}

/**
 * Audits schema-validated imported tool and validator metadata as inert
 * records. It never executes a check, follows a reference, or trusts a
 * command-like field.
 *
 * @param {{
 *   telemetry?: readonly LoadedTextInput[],
 *   toolContracts?: unknown,
 *   validatorResults?: unknown
 * }} [inputs]
 * @returns {{
 *   findings: AuditFinding[],
 *   summaries: ReturnType<typeof structuralInputSummary>[],
 *   redactionCount: number,
 *   warnings: string[]
 * }}
 */
export function auditTelemetryEvidence(inputs = {}) {
  const telemetry = Array.isArray(inputs.telemetry) ? inputs.telemetry : [];
  const toolContracts = records(inputs.toolContracts);
  const validatorResults = records(inputs.validatorResults);
  const path = evidencePath(telemetry);
  /** @type {AuditFinding[]} */
  const findings = [];
  const warnings = [];

  if (toolContracts.length === 0) {
    findings.push(
      makeFinding({
        ruleId: "RO-TL-001",
        category: "SECURITY",
        evidenceStatus: "UNKNOWN",
        severity: "HIGH",
        confidence: "HIGH",
        path,
        evidenceSummary: "No schema-validated read-only tool contract was supplied.",
        remediation: "Export a versioned bounded read-only tool contract.",
        verification: "Validate the exported contract against the bundled schema.",
        claimBoundary: "No declared tool is invoked by this audit.",
        missingEvidence: ["Tool contract"],
      }),
    );
  } else {
    const unsafeContract = toolContracts.some((contract) => {
      const capabilities = Array.isArray(contract.capabilities)
        ? contract.capabilities
        : [];
      return (
        capabilities.length === 0 ||
        capabilities.some((capability) => capability !== "READ") ||
        contract.commandPolicy !== "NO_COMMANDS"
      );
    });
    if (unsafeContract) {
      findings.push(
        makeFinding({
          ruleId: "RO-TL-001",
          category: "SECURITY",
          evidenceStatus: "OBSERVED",
          severity: "HIGH",
          confidence: "HIGH",
          path,
          evidenceSummary:
            "A declared tool contract is not strictly read-only and command-free.",
          remediation: "Use READ-only capabilities and NO_COMMANDS for review context.",
          verification: "Revalidate the exported tool contract.",
          claimBoundary: "Contract metadata only; no declared tool was invoked.",
          missingEvidence: [],
        }),
      );
    }
  }

  if (validatorResults.length === 0) {
    findings.push(
      makeFinding({
        ruleId: "RO-TL-002",
        category: "RELIABILITY",
        evidenceStatus: "UNKNOWN",
        severity: "HIGH",
        confidence: "HIGH",
        path,
        evidenceSummary: "No schema-validated validator results were supplied.",
        remediation: "Export bounded validator-result records with provenance.",
        verification:
          "Validate synthetic validator results against the bundled schema.",
        claimBoundary: "No validator command is executed by this audit.",
        missingEvidence: ["Validator results"],
      }),
    );
    findings.push(
      makeFinding({
        ruleId: "RO-TL-003",
        category: "QUALITY",
        evidenceStatus: "UNKNOWN",
        severity: "HIGH",
        confidence: "HIGH",
        path,
        evidenceSummary: "Finding-linked validator evidence is unavailable.",
        remediation: "Export validator results tied to opaque finding IDs.",
        verification: "Check every imported validator result for a finding ID.",
        claimBoundary: "Missing imported evidence is not treated as a pass.",
        missingEvidence: ["Finding-linked validator results"],
      }),
    );
  } else {
    /** @type {Map<string, Record<string, unknown>[]>} */
    const contractsByCheck = new Map();
    for (const contract of toolContracts) {
      const checkIds = Array.isArray(contract.verificationCheckIds)
        ? contract.verificationCheckIds.filter((checkId) => typeof checkId === "string")
        : [];
      for (const checkId of checkIds) {
        const declaredBy = contractsByCheck.get(checkId) ?? [];
        declaredBy.push(contract);
        contractsByCheck.set(checkId, declaredBy);
      }
    }
    const unknownCheck = validatorResults.some(
      (result) =>
        typeof result.checkId !== "string" || !contractsByCheck.has(result.checkId),
    );
    const timeoutExceeded = validatorResults.some((result) => {
      const durationMs = result.durationMs;
      if (
        typeof durationMs !== "number" ||
        !Number.isFinite(durationMs) ||
        durationMs < 0
      ) {
        return true;
      }
      const declaredBy =
        typeof result.checkId === "string"
          ? (contractsByCheck.get(result.checkId) ?? [])
          : [];
      if (declaredBy.length === 0) {
        return true;
      }
      return declaredBy.some((contract) => {
        const timeoutMs = contract.timeoutMs;
        return (
          typeof timeoutMs !== "number" ||
          !Number.isFinite(timeoutMs) ||
          timeoutMs < 0 ||
          durationMs > timeoutMs
        );
      });
    });
    if (unknownCheck || timeoutExceeded) {
      findings.push(
        makeFinding({
          ruleId: "RO-TL-002",
          category: "RELIABILITY",
          evidenceStatus: "OBSERVED",
          severity: "HIGH",
          confidence: "HIGH",
          path,
          evidenceSummary:
            "A validator result is outside its declared check or timeout contract.",
          remediation: "Keep validator results within declared IDs and timeouts.",
          verification: "Compare imported result IDs and durations with the contract.",
          claimBoundary: "Imported metadata only; no validator command was executed.",
          missingEvidence: [],
        }),
      );
    }

    const seen = new Map();
    let untied = false;
    let contradictory = false;
    for (const result of validatorResults) {
      const runId = typeof result.runId === "string" ? result.runId : "";
      const findingId = typeof result.findingId === "string" ? result.findingId : "";
      const checkId = typeof result.checkId === "string" ? result.checkId : "";
      if (findingId.length === 0) {
        untied = true;
      }
      const key = `${runId}\u0000${findingId}\u0000${checkId}`;
      const status = typeof result.status === "string" ? result.status : "";
      if (seen.has(key) && seen.get(key) !== status) {
        contradictory = true;
      }
      seen.set(key, status);
    }
    if (untied || contradictory) {
      findings.push(
        makeFinding({
          ruleId: "RO-TL-003",
          category: "QUALITY",
          evidenceStatus: "OBSERVED",
          severity: "HIGH",
          confidence: "HIGH",
          path,
          evidenceSummary: untied
            ? "A validator result is not tied to an opaque finding ID."
            : "Validator results contain contradictory statuses for one finding.",
          remediation: "Export one consistent finding-linked result per check.",
          verification: "Reject untied or contradictory result records.",
          claimBoundary: "Imported evidence only; validator quality is not inferred.",
          missingEvidence: [],
        }),
      );
    }
  }

  if (
    telemetry.length > 0 &&
    toolContracts.length === 0 &&
    validatorResults.length === 0
  ) {
    warnings.push(
      "Generic telemetry was bounded and parsed, but no typed tool or validator evidence was supplied.",
    );
  }
  const summaries = telemetry.map((input) =>
    structuralInputSummary(input, {
      kind: "telemetry",
      hasToolContracts: toolContracts.length > 0,
      hasValidatorResults: validatorResults.length > 0,
    }),
  );
  return {
    findings: sortFindings(findings),
    summaries,
    redactionCount: summaries.reduce(
      (total, summary) => total + summary.redactionCount,
      0,
    ),
    warnings,
  };
}
