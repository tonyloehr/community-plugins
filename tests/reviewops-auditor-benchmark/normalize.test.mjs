import assert from "node:assert/strict";
import test from "node:test";

import {
  computeStructuralReceipts,
  normalizeLaneBundle,
  normalizeLaneBundles,
} from "../../plugins/reviewops-auditor-benchmark/src/normalize/index.mjs";

const digest = (number) => "sha256:" + number.toString(16).padStart(64, "0");

function refreshReceipts(source) {
  source.manifest.structuralReceipts = computeStructuralReceipts(source);
  return source;
}

function candidate(variantId, modelAlias) {
  return {
    schemaVersion: 1,
    variantId,
    architectureId: variantId + "-architecture",
    architectureStructuralDigest: digest(902),
    modelAlias,
    reasoningClass: "standard",
    promptStructuralDigest: digest(900),
    configStructuralDigest: digest(901),
    contextClass: "same-context",
    toolContractId: "tools-v1",
    controllerContractId: "controller-v1",
    validatorContractId: "validator-v1",
    dedupePolicyId: "dedupe-v1",
    postingPolicyId: "posting-v1",
    retryPolicyId: "retry-v1",
    timeoutPolicyId: "timeout-v1",
    routingPolicyId: "routing-v1",
  };
}

function bundle() {
  const caseId = digest(1);
  const rootCauseId = digest(2);
  const findingId = digest(3);
  const source = {
    bundleId: "portable-core",
    manifest: {
      schemaVersion: 1,
      corpusId: digest(10),
      exporterVersion: "0.1.0",
      exportedAt: "2026-08-01T00:00:00Z",
      caseIds: [caseId],
      variantIds: ["baseline", "candidate"],
      rubricId: "rubric-v1",
      labelVersion: "v1",
      pricingSnapshotId: "pricing-v1",
      redactionPolicyVersion: "redaction-v1",
      lane: {
        laneId: "portable-core-v1",
        laneType: "PORTABLE_CORE_MODEL",
        baselineVariantId: "baseline",
        cohortSelectionDigest: digest(11),
        cohortWindowId: digest(12),
        allowedDifferenceAxes: ["modelAlias"],
        executionMode: "OFFLINE_REPLAY",
      },
      sliceTaxonomy: {
        taxonomyId: "risk-v1",
        version: "1",
        sliceIds: ["auth"],
      },
      productionBaselineContracts: {
        controllerContractId: "controller-v1",
        validatorContractId: "validator-v1",
        dedupePolicyId: "dedupe-v1",
        postingPolicyId: "posting-v1",
      },
      structuralReceipts: [],
    },
    evalProtocol: {
      schemaVersion: 1,
      protocolId: "eval-v1",
      protocolVersion: "v1",
      laneId: "portable-core-v1",
      intendedClaim: "MODEL_ONLY",
      samplingFrame: "paired-cases",
      cohortSelectionDigest: digest(11),
      cohortWindowId: digest(12),
      inclusionPolicyId: "include-v1",
      exclusionPolicyId: "exclude-v1",
      assignmentMethod: "PAIRED_SAME_CASE",
      pairingMethod: "CASE_VARIANT_REPLICATE",
      replicateAggregation: "CASE_PRIMITIVES",
      missingReplicatePolicy: "BLOCK",
      leakageControls: [
        {
          controlId: "holdout",
          status: "DECLARED",
          evidenceStatus: "DECLARED",
        },
      ],
      knownContamination: "NONE_DECLARED",
      heldConstantFields: [
        "promptStructuralDigest",
        "configStructuralDigest",
        "contextClass",
        "toolContractId",
        "controllerContractId",
        "validatorContractId",
        "dedupePolicyId",
        "postingPolicyId",
        "reasoningClass",
        "retryPolicyId",
        "timeoutPolicyId",
        "routingPolicyId",
      ],
      preservationContracts: {
        controllerContractId: "controller-v1",
        validatorContractId: "validator-v1",
        dedupePolicyId: "dedupe-v1",
        postingPolicyId: "posting-v1",
        toolContractId: "tools-v1",
        contextClass: "same-context",
        retryPolicyId: "retry-v1",
        timeoutPolicyId: "timeout-v1",
        routingPolicyId: "routing-v1",
      },
      expectedExecutionMode: "OFFLINE_REPLAY",
      provenance: {
        kind: "SYNTHETIC_FIXTURE",
        sourceLabel: "synthetic-fixture",
      },
    },
    adjudicationProtocol: {
      schemaVersion: 1,
      protocolId: "adjudication-v1",
      protocolVersion: "v1",
      laneId: "portable-core-v1",
      rubricId: "rubric-v1",
      labelVersion: "v1",
      variantIdentity: "HIDDEN",
      presentationOrder: "RANDOMIZED",
      highCriticalReview: "HUMAN",
      adjudicatorIndependence: {
        status: "DECLARED",
        evidenceStatus: "DECLARED",
        provenanceId: "review-panel-v1",
      },
      disagreement: {
        policyId: "disagreement-v1",
        count: 0,
        status: "COMPLETE",
      },
      provenance: {
        kind: "SYNTHETIC_FIXTURE",
        sourceLabel: "synthetic-fixture",
      },
    },
    candidateConfigs: [
      candidate("baseline", "model-a"),
      candidate("candidate", "model-b"),
    ],
    rubric: {
      rubricId: "rubric-v1",
      matchingRules: {
        allowOneFindingMultipleRootCauses: false,
        allowMultipleFindingsPerRootCause: false,
      },
    },
    pricingSnapshot: {
      schemaVersion: 1,
      snapshotId: "pricing-v1",
      currency: "USD",
      effectiveAt: "2026-08-01T00:00:00Z",
      costBasis: "FULLY_LOADED",
      provenance: { kind: "user-supplied" },
      rates: [
        {
          variantId: "baseline",
          inputMicrosPerMillion: 1,
          cachedInputMicrosPerMillion: 1,
          outputMicrosPerMillion: 1,
          toolingMicrosPerRun: 0,
          humanReviewMicrosPerMinute: 0,
        },
        {
          variantId: "candidate",
          inputMicrosPerMillion: 1,
          cachedInputMicrosPerMillion: 1,
          outputMicrosPerMillion: 1,
          toolingMicrosPerRun: 0,
          humanReviewMicrosPerMinute: 0,
        },
      ],
    },
    caseLabels: [
      {
        schemaVersion: 1,
        caseId,
        rubricId: "rubric-v1",
        labelVersion: "v1",
        riskSliceIds: ["auth"],
        groundTruth: [
          { rootCauseId, severity: "CRITICAL", tags: ["cross-system"] },
        ],
      },
    ],
    runs: [
      {
        schemaVersion: 1,
        caseId,
        variantId: "baseline",
        architectureId: "baseline-architecture",
        architectureStructuralDigest: digest(902),
        runId: digest(20),
        replicateId: "replicate_001",
        contextDigest: digest(30),
        toolContractId: "tools-v1",
        controllerContractId: "controller-v1",
        validatorContractId: "validator-v1",
        dedupePolicyId: "dedupe-v1",
        postingPolicyId: "posting-v1",
        reasoningClass: "standard",
        retryPolicyId: "retry-v1",
        timeoutPolicyId: "timeout-v1",
        routingPolicyId: "routing-v1",
        startedAt: "2026-08-01T00:00:00Z",
        latencyMs: 100,
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
        humanReviewMinutes: 1,
        cost: {
          currency: "USD",
          amountMicros: 100,
          costBasis: "FULLY_LOADED",
          costSource: "SUPPLIED_TOTAL",
          pricingSnapshotId: "pricing-v1",
          components: {
            modelMicros: 50,
            toolingMicros: 25,
            humanReviewMicros: 25,
          },
        },
        findings: [
          {
            findingId,
            severity: "CRITICAL",
            category: "security",
            verification: "VERIFIED",
            tags: ["cross-system"],
          },
        ],
        adjudication: {
          status: "ADJUDICATED",
          rubricId: "rubric-v1",
          labelVersion: "v1",
          findingLabels: [
            {
              findingId,
              outcome: "ACCEPTED",
              matchedRootCauseIds: [rootCauseId],
            },
          ],
          rootCauseAssessments: [
            {
              rootCauseId,
              qualityScore: 1,
              qualityRubricId: "rubric-v1",
            },
          ],
        },
      },
    ],
  };
  return refreshReceipts(source);
}

test("normalizes canonical lane evidence deterministically", () => {
  const first = normalizeLaneBundle(bundle());
  const second = normalizeLaneBundle(bundle());
  assert.equal(first.status, "COMPLETE");
  assert.deepEqual(first.report, second.report);
  assert.equal(first.report.counts.acceptedRuns, 1);
  assert.equal(first.runs[0].cost.amountMicros, 100);
  assert.equal(first.runs[0].findings[0].severity, "CRITICAL");
  assert.equal(first.rankingEligible, true);
});

test("reconstructs fully loaded micros from explicit snapshot rates", () => {
  const source = bundle();
  const run = source.runs[0];
  run.cost = {
    currency: "USD",
    costBasis: "FULLY_LOADED",
    costSource: "RECONSTRUCTED_COMPONENTS",
    pricingSnapshotId: "pricing-v1",
  };
  source.pricingSnapshot.rates[0] = {
    variantId: "baseline",
    inputMicrosPerMillion: 1_000_000,
    cachedInputMicrosPerMillion: 0,
    outputMicrosPerMillion: 2_000_000,
    toolingMicrosPerRun: 3,
    humanReviewMicrosPerMinute: 4,
  };
  refreshReceipts(source);
  const normalized = normalizeLaneBundle(source);
  assert.equal(normalized.status, "COMPLETE");
  assert.deepEqual(normalized.runs[0].cost.components, {
    modelMicros: 3,
    toolingMicros: 3,
    humanReviewMicros: 4,
  });
  assert.equal(normalized.runs[0].cost.amountMicros, 10);
});

test("unwraps sanitized exports while retaining bounded export receipts", () => {
  const source = bundle();
  source.exports = source.runs.map((run, index) => ({
    schemaVersion: 1,
    exportId: digest(700 + index),
    exporterVersion: "0.1.0",
    runRecord: run,
    provenance: {
      kind: "SYNTHETIC_FIXTURE",
      sourceLabel: "synthetic-fixture",
      exporterVersion: "0.1.0",
    },
  }));
  delete source.runs;
  refreshReceipts(source);
  const normalized = normalizeLaneBundle(source);
  assert.equal(normalized.status, "COMPLETE");
  assert.equal(normalized.runs.length, 1);
  assert.deepEqual(normalized.report.exportIds, [digest(700)]);
  assert.deepEqual(normalized.report.exporterVersions, ["0.1.0"]);
});

test("fails closed on raw fields, duplicate replicates, and contradictory roots", () => {
  const unsafe = bundle();
  unsafe.runs[0].prompt = "do not accept raw prompts";
  const unsafeResult = normalizeLaneBundle(unsafe);
  assert.equal(unsafeResult.status, "BLOCKED");
  assert.ok(unsafeResult.reasonCodes.includes("UNSAFE_RAW_FIELD"));

  const duplicate = bundle();
  duplicate.runs.push(structuredClone(duplicate.runs[0]));
  duplicate.runs[1].runId = digest(21);
  const duplicateResult = normalizeLaneBundle(duplicate);
  assert.equal(duplicateResult.status, "BLOCKED");
  assert.ok(
    duplicateResult.reasonCodes.includes("DUPLICATE_CASE_VARIANT_REPLICATE"),
  );

  const contradictory = bundle();
  contradictory.runs[0].adjudication.findingLabels[0].matchedRootCauseIds = [
    digest(999),
  ];
  const contradictoryResult = normalizeLaneBundle(contradictory);
  assert.equal(contradictoryResult.status, "BLOCKED");
  assert.ok(
    contradictoryResult.reasonCodes.includes("UNKNOWN_ROOT_CAUSE_MATCH"),
  );

  const architectureMismatch = bundle();
  architectureMismatch.runs[0].architectureId = "other-architecture";
  const architectureResult = normalizeLaneBundle(architectureMismatch);
  assert.equal(architectureResult.status, "BLOCKED");
  assert.ok(
    architectureResult.reasonCodes.includes(
      "RUN_CANDIDATE_ARCHITECTURE_MISMATCH",
    ),
  );

  const receiptMismatch = bundle();
  receiptMismatch.manifest.structuralReceipts[0].digest = digest(0);
  const receiptResult = normalizeLaneBundle(receiptMismatch);
  assert.equal(receiptResult.status, "BLOCKED");
  assert.ok(receiptResult.reasonCodes.includes("RO_RECEIPT_MISMATCH"));

  assert.deepEqual(
    computeStructuralReceipts({ prompt: "raw prompt must not be hashed" }),
    [],
  );
  const nonJsonReceipt = bundle();
  nonJsonReceipt.evalProtocol.nonJson = undefined;
  const nonJsonResult = normalizeLaneBundle(nonJsonReceipt);
  assert.equal(nonJsonResult.status, "BLOCKED");
  assert.ok(nonJsonResult.reasonCodes.includes("UNKNOWN_EVAL_PROTOCOL_FIELD"));
});

test("pure normalization enforces closed protocol identity and provenance", () => {
  const cases = [
    {
      name: "missing eval identity",
      mutate: (source) => {
        delete source.evalProtocol.protocolId;
      },
      code: "INVALID_EVAL_PROTOCOL_ID",
    },
    {
      name: "eval provenance is not closed",
      mutate: (source) => {
        source.evalProtocol.provenance.extra = "not-public";
      },
      code: "INVALID_EVAL_PROTOCOL_PROVENANCE",
    },
    {
      name: "missing adjudication identity",
      mutate: (source) => {
        delete source.adjudicationProtocol.protocolVersion;
      },
      code: "INVALID_ADJUDICATION_PROTOCOL_VERSION",
    },
    {
      name: "adjudication protocol has unknown field",
      mutate: (source) => {
        source.adjudicationProtocol.extra = "not-public";
      },
      code: "UNKNOWN_ADJUDICATION_PROTOCOL_FIELD",
    },
    {
      name: "missing eval protocol",
      mutate: (source) => {
        delete source.evalProtocol;
      },
      code: "MISSING_EVAL_PROTOCOL",
    },
  ];
  for (const entry of cases) {
    const source = bundle();
    entry.mutate(source);
    refreshReceipts(source);
    const normalized = normalizeLaneBundle(source);
    assert.equal(normalized.status, "BLOCKED", entry.name);
    assert.ok(normalized.reasonCodes.includes(entry.code), entry.name);
  }
});

test("normalization blocks case-variant replicate fan-out above 32", () => {
  const source = bundle();
  const first = source.runs[0];
  for (let index = 2; index <= 33; index += 1) {
    const replicate = structuredClone(first);
    replicate.runId = digest(20 + index);
    replicate.replicateId = "replicate_" + String(index).padStart(3, "0");
    source.runs.push(replicate);
  }
  refreshReceipts(source);
  const normalized = normalizeLaneBundle(source);
  assert.equal(normalized.status, "BLOCKED");
  assert.ok(normalized.reasonCodes.includes("REPLICATE_LIMIT_EXCEEDED"));
});

test("rejects malformed whole records and exposes bounded multi-lane reports", () => {
  const source = bundle();
  source.runs.push({ schemaVersion: 1, caseId: digest(1) });
  refreshReceipts(source);
  const normalized = normalizeLaneBundle(source);
  assert.equal(normalized.status, "PARTIAL");
  assert.equal(normalized.report.counts.rejectedRecords, 1);
  assert.equal(normalized.rankingEligible, false);
  assert.ok(normalized.reasonCodes.includes("REJECTED_RECORDS_AFFECT_COHORT"));

  const second = bundle();
  second.bundleId = "portable-core-two";
  second.manifest.lane.laneId = "portable-core-v2";
  second.evalProtocol.laneId = "portable-core-v2";
  second.adjudicationProtocol.laneId = "portable-core-v2";
  refreshReceipts(second);
  const multiple = normalizeLaneBundles([bundle(), second]);
  assert.equal(multiple.status, "COMPLETE");
  assert.equal(multiple.reports.length, 2);
  assert.equal(normalizeLaneBundles([]).status, "BLOCKED");
});

test("normalizer rejects ambiguous provenance and malformed nested evidence", () => {
  const blockedCases = [
    {
      name: "missing manifest",
      mutate: (source) => {
        delete source.manifest;
      },
      code: "MISSING_MANIFEST",
    },
    {
      name: "ambiguous source mode",
      mutate: (source) => {
        source.exports = [];
      },
      code: "AMBIGUOUS_SOURCE_MODE",
    },
    {
      name: "missing structural receipt",
      mutate: (source) => {
        source.manifest.structuralReceipts.pop();
      },
      code: "INVALID_STRUCTURAL_RECEIPTS",
    },
    {
      name: "duplicate bundle ids",
      multiple: true,
      code: "DUPLICATE_BUNDLE_ID",
    },
  ];
  for (const entry of blockedCases) {
    const result = entry.multiple
      ? normalizeLaneBundles([bundle(), bundle()])
      : (() => {
          const source = bundle();
          entry.mutate(source);
          return normalizeLaneBundle(source);
        })();
    assert.equal(result.status, "BLOCKED", entry.name);
    assert.ok(result.reasonCodes.includes(entry.code), entry.name);
  }

  const rejectedCases = [
    {
      name: "bad output count",
      mutate: (source) => {
        source.runs[0].outputCounts = {
          proposedFindings: -1,
          publishedComments: 0,
        };
      },
      code: "INVALID_OUTPUT_COUNTS",
    },
    {
      name: "unknown run field",
      mutate: (source) => {
        source.runs[0].surprise = true;
      },
      code: "UNKNOWN_RUN_FIELD",
    },
    {
      name: "bad finding outcome",
      mutate: (source) => {
        source.runs[0].adjudication.findingLabels[0].outcome = "MAYBE";
      },
      code: "INVALID_FINDING_OUTCOME",
    },
    {
      name: "bad cost total",
      mutate: (source) => {
        source.runs[0].cost.amountMicros = 101;
      },
      code: "COST_COMPONENT_MISMATCH",
    },
  ];
  for (const entry of rejectedCases) {
    const source = bundle();
    entry.mutate(source);
    refreshReceipts(source);
    const result = normalizeLaneBundle(source);
    assert.equal(result.status, "PARTIAL", entry.name);
    assert.ok(
      result.rejectedRecords[0].reasonCodes.includes(entry.code),
      entry.name,
    );
  }
});

test("lane normalization blocks malformed manifest and pricing contracts", () => {
  const cases = [
    {
      name: "non-object bundle",
      source: () => null,
      code: "INVALID_LANE_BUNDLE",
    },
    {
      name: "bad bundle alias",
      mutate: (source) => {
        source.bundleId = "Bad Bundle";
      },
      code: "INVALID_BUNDLE_ID",
    },
    {
      name: "bad manifest schema",
      mutate: (source) => {
        source.manifest.schemaVersion = 2;
      },
      code: "UNSUPPORTED_MANIFEST_SCHEMA",
    },
    {
      name: "bad exporter version",
      mutate: (source) => {
        source.manifest.exporterVersion = "latest";
      },
      code: "INVALID_EXPORTER_VERSION",
    },
    {
      name: "non-UTC manifest time",
      mutate: (source) => {
        source.manifest.exportedAt = "2026-08-01T00:00:00";
      },
      code: "INVALID_EXPORTED_AT",
    },
    {
      name: "duplicate manifest cases",
      mutate: (source) => {
        source.manifest.caseIds.push(source.manifest.caseIds[0]);
      },
      code: "INVALID_MANIFEST_CASES",
    },
    {
      name: "duplicate manifest variants",
      mutate: (source) => {
        source.manifest.variantIds = ["baseline", "baseline"];
      },
      code: "INVALID_MANIFEST_VARIANTS",
    },
    {
      name: "unknown difference axis",
      mutate: (source) => {
        source.manifest.lane.allowedDifferenceAxes = ["vendorName"];
      },
      code: "INVALID_DIFFERENCE_AXES",
    },
    {
      name: "unsupported lane type",
      mutate: (source) => {
        source.manifest.lane.laneType = "ONLINE";
      },
      code: "INVALID_LANE_TYPE",
    },
    {
      name: "unsupported execution mode",
      mutate: (source) => {
        source.manifest.lane.executionMode = "POSTING";
      },
      code: "INVALID_EXECUTION_MODE",
    },
    {
      name: "missing slice taxonomy",
      mutate: (source) => {
        delete source.manifest.sliceTaxonomy;
      },
      code: "INVALID_SLICE_TAXONOMY",
    },
    {
      name: "missing baseline contracts",
      mutate: (source) => {
        delete source.manifest.productionBaselineContracts;
      },
      code: "INVALID_PRODUCTION_BASELINE_CONTRACTS",
    },
    {
      name: "malformed receipt",
      mutate: (source) => {
        source.manifest.structuralReceipts[0].digest = "not-a-digest";
      },
      code: "INVALID_STRUCTURAL_RECEIPT",
    },
    {
      name: "bad pricing currency",
      mutate: (source) => {
        source.pricingSnapshot.currency = "usd";
      },
      code: "INVALID_PRICING_CURRENCY",
    },
    {
      name: "bad pricing rates",
      mutate: (source) => {
        source.pricingSnapshot.rates = null;
      },
      code: "INVALID_PRICING_RATES",
    },
  ];
  for (const entry of cases) {
    const source = entry.source ? entry.source() : bundle();
    entry.mutate?.(source);
    const result = normalizeLaneBundle(source);
    assert.equal(result.status, "BLOCKED", entry.name);
    assert.ok(result.reasonCodes.includes(entry.code), entry.name);
  }
});

test("lane normalization rejects whole runs for malformed typed evidence", () => {
  const cases = [
    {
      name: "run schema",
      mutate: (source) => {
        source.runs[0].schemaVersion = 2;
      },
      code: "UNSUPPORTED_RUN_SCHEMA",
    },
    {
      name: "non-UTC run time",
      mutate: (source) => {
        source.runs[0].startedAt = "2026-08-01T00:00:00";
      },
      code: "INVALID_STARTED_AT",
    },
    {
      name: "negative latency",
      mutate: (source) => {
        source.runs[0].latencyMs = -1;
      },
      code: "INVALID_LATENCY",
    },
    {
      name: "negative human review",
      mutate: (source) => {
        source.runs[0].humanReviewMinutes = -1;
      },
      code: "INVALID_HUMAN_REVIEW_MINUTES",
    },
    {
      name: "cached tokens exceed input",
      mutate: (source) => {
        source.runs[0].usage.cachedInputTokens = 2;
      },
      code: "INVALID_USAGE",
    },
    {
      name: "bad finding verification",
      mutate: (source) => {
        source.runs[0].findings[0].verification = "maybe";
      },
      code: "INVALID_FINDING_VERIFICATION",
    },
    {
      name: "bad finding category",
      mutate: (source) => {
        source.runs[0].findings[0].category = "mystery";
      },
      code: "INVALID_FINDING_CATEGORY",
    },
    {
      name: "bad finding tags",
      mutate: (source) => {
        source.runs[0].findings[0].tags = ["Not Safe"];
      },
      code: "INVALID_FINDING_TAGS",
    },
    {
      name: "unknown adjudicated finding",
      mutate: (source) => {
        source.runs[0].adjudication.findingLabels[0].findingId = digest(999);
      },
      code: "UNKNOWN_ADJUDICATED_FINDING",
    },
    {
      name: "duplicate finding",
      mutate: (source) => {
        source.runs[0].findings.push(
          structuredClone(source.runs[0].findings[0]),
        );
      },
      code: "DUPLICATE_FINDING_ID",
    },
    {
      name: "duplicate finding label",
      mutate: (source) => {
        source.runs[0].adjudication.findingLabels.push(
          structuredClone(source.runs[0].adjudication.findingLabels[0]),
        );
      },
      code: "DUPLICATE_FINDING_LABEL",
    },
    {
      name: "bad root-cause quality",
      mutate: (source) => {
        source.runs[0].adjudication.rootCauseAssessments[0].qualityScore = 2;
      },
      code: "INVALID_ROOT_CAUSE_QUALITY",
    },
    {
      name: "cost pricing mismatch",
      mutate: (source) => {
        source.runs[0].cost.pricingSnapshotId = "other-pricing";
      },
      code: "PRICING_MISMATCH",
    },
    {
      name: "incomplete fully-loaded cost",
      mutate: (source) => {
        delete source.runs[0].cost.components;
      },
      code: "INCOMPLETE_FULLY_LOADED_COST",
    },
    {
      name: "unreconstructable cost",
      mutate: (source) => {
        delete source.runs[0].usage;
        source.runs[0].cost = {
          currency: "USD",
          costBasis: "FULLY_LOADED",
          costSource: "RECONSTRUCTED_COMPONENTS",
          pricingSnapshotId: "pricing-v1",
        };
      },
      code: "UNRECONSTRUCTABLE_COST",
    },
  ];
  for (const entry of cases) {
    const source = bundle();
    entry.mutate(source);
    refreshReceipts(source);
    const result = normalizeLaneBundle(source);
    assert.equal(result.status, "PARTIAL", entry.name);
    assert.ok(
      result.rejectedRecords[0].reasonCodes.includes(entry.code),
      entry.name,
    );
  }
});

test("lane normalization rejects malformed labels, candidates, and exports", () => {
  const rejectedCases = [
    {
      name: "duplicate risk slices",
      mutate: (source) => {
        source.caseLabels[0].riskSliceIds = ["auth", "auth"];
      },
      code: "INVALID_RISK_SLICES",
    },
    {
      name: "missing ground truth",
      mutate: (source) => {
        source.caseLabels[0].groundTruth = null;
      },
      code: "INVALID_GROUND_TRUTH",
    },
    {
      name: "duplicate root cause",
      mutate: (source) => {
        source.caseLabels[0].groundTruth.push(
          structuredClone(source.caseLabels[0].groundTruth[0]),
        );
      },
      code: "DUPLICATE_ROOT_CAUSE_ID",
    },
    {
      name: "bad candidate schema",
      mutate: (source) => {
        source.candidateConfigs[0].schemaVersion = 2;
      },
      code: "UNSUPPORTED_CANDIDATE_SCHEMA",
    },
    {
      name: "bad candidate alias",
      mutate: (source) => {
        source.candidateConfigs[0].modelAlias = "Model A";
      },
      code: "INVALID_MODELALIAS",
    },
  ];
  for (const entry of rejectedCases) {
    const source = bundle();
    entry.mutate(source);
    refreshReceipts(source);
    const result = normalizeLaneBundle(source);
    assert.equal(result.status, "PARTIAL", entry.name);
    assert.ok(
      result.rejectedRecords[0].reasonCodes.includes(entry.code),
      entry.name,
    );
  }

  const malformedExport = bundle();
  malformedExport.exports = malformedExport.runs.map((run) => ({
    schemaVersion: 1,
    exportId: digest(700),
    exporterVersion: "0.1.0",
    runRecord: run,
    provenance: { kind: "PRIVATE_EXPORT", sourceLabel: "Bad Label" },
  }));
  delete malformedExport.runs;
  refreshReceipts(malformedExport);
  const exportResult = normalizeLaneBundle(malformedExport);
  assert.equal(exportResult.status, "BLOCKED");
  assert.ok(exportResult.reasonCodes.includes("INVALID_EXPORT_RECORD"));
});
