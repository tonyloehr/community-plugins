import { compareText, issue, stableSort } from "./shared.mjs";

/**
 * Restrict an already paired cohort to one declared exporter-supplied slice.
 * Cases may appear in multiple slices; this function never mutates global
 * pairing or invents membership from source text.
 *
 * @param {Record<string, any>} normalized
 * @param {Record<string, any>} pairing
 * @param {string} sliceId
 * @returns {Record<string, any>}
 */
export function pairingForSlice(normalized, pairing, sliceId) {
  const declared = normalized?.manifest?.sliceTaxonomy?.sliceIds ?? [];
  if (!declared.includes(sliceId)) {
    return {
      ...pairing,
      status: "INSUFFICIENT_EVIDENCE",
      pairedCaseIds: [],
      pairedCases: [],
      comparisons: [],
      errors: [],
      warnings: [
        issue("UNSUPPORTED_RISK_SLICE", "Risk slice is not declared.", {
          sliceId,
        }),
      ],
      sliceId,
    };
  }
  const pairedCases = (pairing?.pairedCases ?? []).filter((pairedCase) =>
    normalized.caseLabelsById?.get(pairedCase.caseId)?.riskSliceIds?.includes(sliceId),
  );
  const pairedCaseIds = pairedCases.map((item) => item.caseId);
  const comparisons = (pairing?.comparisons ?? []).map((comparison) => ({
    ...comparison,
    pairedCaseIds: [...pairedCaseIds],
    pairedCaseCount: pairedCaseIds.length,
  }));
  const excludedCases = (pairing?.excludedCases ?? []).filter((entry) =>
    normalized.caseLabelsById?.get(entry.caseId)?.riskSliceIds?.includes(sliceId),
  );
  return {
    ...pairing,
    status:
      pairedCaseIds.length === 0
        ? "INSUFFICIENT_EVIDENCE"
        : pairedCaseIds.length < (pairing?.pairedCaseIds?.length ?? 0)
          ? "PARTIAL"
          : pairing.status,
    pairedCaseIds,
    pairedCases,
    comparisons,
    excludedCases: stableSort(excludedCases, (item) => item.caseId),
    sliceId,
  };
}

/**
 * @param {Record<string, any>} normalized
 * @returns {string[]}
 */
export function declaredSliceIds(normalized) {
  return [...(normalized?.manifest?.sliceTaxonomy?.sliceIds ?? [])].sort(compareText);
}

export const slicePairing = pairingForSlice;
