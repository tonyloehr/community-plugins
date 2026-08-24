import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateEvalValidity,
  evaluateLaneValidity,
} from "../../plugins/reviewops-auditor-benchmark/src/eval/index.mjs";
import {
  computeStructuralReceipts,
  normalizeLaneBundle,
} from "../../plugins/reviewops-auditor-benchmark/src/normalize/index.mjs";

const digest = (number) => "sha256:" + number.toString(16).padStart(64, "0");

function refreshReceipts(source) {
  source.manifest.structuralReceipts = computeStructuralReceipts(source);
  return source;
}

function candidate(variantId, overrides = {}) {
  return {
    schemaVersion: 1,
    variantId,
    architectureId: variantId + "-architecture",
    architectureStructuralDigest: digest(82),
    modelAlias: variantId === "baseline" ? "model-a" : "model-b",
    reasoningClass: "standard",
    promptStructuralDigest: digest(80),
    configStructuralDigest: digest(81),
    contextClass: "same-context",
    toolContractId: "tools-v1",
    controllerContractId: "controller-v1",
    validatorContractId: "validator-v1",
    dedupePolicyId: "dedupe-v1",
    postingPolicyId: "posting-v1",
    retryPolicyId: "retry-v1",
    timeoutPolicyId: "timeout-v1",
    routingPolicyId: "routing-v1",
    ...overrides,
  };
}

function run(caseId, variantId, runNumber, replicateId = "replicate_001") {
  const rootCauseId = digest(2);
  const findingId = digest(runNumber + 100);
  return {
    schemaVersion: 1,
    caseId,
    variantId,
    architectureId: variantId + "-architecture",
    architectureStructuralDigest: digest(82),
    runId: digest(runNumber),
    replicateId,
    contextDigest: digest(70),
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
    findings: [
      {
        findingId,
        severity: "CRITICAL",
        category: "security",
        verification: "VERIFIED",
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
  };
}

function laneBundle({
  laneType = "PORTABLE_CORE_MODEL",
  allowedDifferenceAxes = ["modelAlias"],
  candidateOverrides = {},
  executionMode = "OFFLINE_REPLAY",
} = {}) {
  const caseId = digest(1);
  const source = {
    bundleId: "lane-bundle",
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
        laneId: "lane-v1",
        laneType,
        baselineVariantId: "baseline",
        cohortSelectionDigest: digest(11),
        cohortWindowId: digest(12),
        allowedDifferenceAxes,
        executionMode,
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
      laneId: "lane-v1",
      intendedClaim:
        laneType === "PORTABLE_CORE_MODEL"
          ? "MODEL_ONLY"
          : laneType === "HARNESS_ABLATION"
            ? "ONE_FACTOR"
            : laneType === "BEST_SYSTEM"
              ? "HOLISTIC_SYSTEM"
              : "SHADOW_NO_POSTING",
      samplingFrame: "paired-cases",
      cohortSelectionDigest: digest(11),
      cohortWindowId: digest(12),
      inclusionPolicyId: "include-v1",
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
      exclusionPolicyId: "exclude-v1",
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
      expectedExecutionMode: executionMode,
      provenance: {
        kind: "SYNTHETIC_FIXTURE",
        sourceLabel: "synthetic-fixture",
      },
    },
    adjudicationProtocol: {
      schemaVersion: 1,
      protocolId: "adjudication-v1",
      protocolVersion: "v1",
      laneId: "lane-v1",
      rubricId: "rubric-v1",
      labelVersion: "v1",
      variantIdentity: "HIDDEN",
      presentationOrder: "RANDOMIZED",
      highCriticalReview: "HUMAN",
      adjudicatorIndependence: {
        status: "DECLARED",
        evidenceStatus: "DECLARED",
        provenanceId: "panel-v1",
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
      candidate("baseline"),
      candidate("candidate", candidateOverrides),
    ],
    rubric: {
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
      provenance: {
        kind: "SYNTHETIC_FIXTURE",
        sourceLabel: "synthetic-fixture",
      },
      rates: [],
    },
    caseLabels: [
      {
        schemaVersion: 1,
        caseId,
        rubricId: "rubric-v1",
        labelVersion: "v1",
        riskSliceIds: ["auth"],
        groundTruth: [
          {
            rootCauseId: digest(2),
            severity: "CRITICAL",
            tags: ["cross-system"],
          },
        ],
      },
    ],
    runs: [run(caseId, "baseline", 20), run(caseId, "candidate", 21)],
  };
  return refreshReceipts(source);
}

test("portable-core lane is single-factor only with complete declared evidence", () => {
  const normalized = normalizeLaneBundle(laneBundle());
  const report = evaluateLaneValidity(normalized);
  assert.equal(
    report.status,
    "COMPLETE",
    JSON.stringify(normalized.errors ?? report.reasonCodes),
  );
  assert.equal(report.attributionStatus, "SINGLE_FACTOR");
  assert.equal(
    report.claimBoundary,
    "Model comparison under equal declared conditions.",
  );
  assert.equal(report.pairing.pairedCaseIds.length, 1);
  assert.equal(report.eligibleForRecommendation, true);
  assert.ok(report.checks.every((entry) => entry.status === "PASS"));
});

test("best-system lane stays holistic while uncontrolled changes fail closed", () => {
  const holisticSource = laneBundle({
    laneType: "BEST_SYSTEM",
    allowedDifferenceAxes: ["modelAlias", "validatorContractId"],
    candidateOverrides: { validatorContractId: "validator-v2" },
  });
  holisticSource.evalProtocol.heldConstantFields =
    holisticSource.evalProtocol.heldConstantFields.filter(
      (field) => field !== "validatorContractId",
    );
  holisticSource.runs[1].validatorContractId = "validator-v2";
  refreshReceipts(holisticSource);
  const holistic = evaluateLaneValidity(holisticSource);
  assert.equal(holistic.status, "COMPLETE");
  assert.equal(holistic.attributionStatus, "HOLISTIC_VARIANT");
  assert.match(holistic.claimBoundary, /Holistic system comparison/u);

  const confoundedSource = laneBundle({
    candidateOverrides: { validatorContractId: "validator-v2" },
  });
  confoundedSource.runs[1].validatorContractId = "validator-v2";
  refreshReceipts(confoundedSource);
  const confounded = evaluateLaneValidity(confoundedSource);
  assert.equal(confounded.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(confounded.attributionStatus, "CONFOUNDED");
  assert.ok(confounded.unexpectedDimensions.includes("validatorContractId"));
});

test("blinding, leakage, and shadow no-posting gaps prevent ranking", () => {
  const visible = laneBundle();
  visible.adjudicationProtocol.variantIdentity = "VISIBLE";
  visible.evalProtocol.leakageControls[0].status = "UNKNOWN";
  refreshReceipts(visible);
  const visibleReport = evaluateLaneValidity(visible);
  assert.equal(visibleReport.status, "INSUFFICIENT_EVIDENCE");
  assert.ok(
    visibleReport.reasonCodes.includes(
      "INCOMPLETE_BLINDING_OR_HIGH_CRITICAL_REVIEW",
    ),
  );
  assert.ok(
    visibleReport.reasonCodes.includes("MISSING_LEAKAGE_OR_EXCLUSION_EVIDENCE"),
  );

  const shadow = laneBundle({
    laneType: "SHADOW_PILOT",
    allowedDifferenceAxes: ["modelAlias"],
  });
  const shadowReport = evaluateLaneValidity(shadow);
  assert.equal(shadowReport.status, "INSUFFICIENT_EVIDENCE");
  assert.ok(
    shadowReport.reasonCodes.includes("SHADOW_NO_POSTING_NOT_DECLARED"),
  );
});

test("unbalanced replicates and multi-lane status remain explicit", () => {
  const source = laneBundle();
  source.runs.push(run(digest(1), "baseline", 30, "replicate_002"));
  refreshReceipts(source);
  const report = evaluateLaneValidity(source);
  assert.equal(report.status, "INSUFFICIENT_EVIDENCE");
  assert.ok(
    report.pairing.excludedCases[0].reasonCodes.includes(
      "UNBALANCED_REPLICATES",
    ),
  );

  const second = visibleLane();
  second.bundleId = "lane-bundle-two";
  second.manifest.lane.laneId = "lane-v2";
  second.evalProtocol.laneId = "lane-v2";
  second.adjudicationProtocol.laneId = "lane-v2";
  refreshReceipts(second);
  const aggregate = evaluateEvalValidity({
    laneBundles: [laneBundle(), second],
  });
  assert.equal(aggregate.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(aggregate.lanes.length, 2);
});

test("valid harness and shadow lanes keep their narrower claim boundaries", () => {
  const harness = laneBundle({
    laneType: "HARNESS_ABLATION",
    allowedDifferenceAxes: ["validatorContractId"],
    candidateOverrides: {
      modelAlias: "model-a",
      validatorContractId: "validator-v2",
    },
  });
  harness.runs[1].validatorContractId = "validator-v2";
  harness.evalProtocol.heldConstantFields =
    harness.evalProtocol.heldConstantFields.filter(
      (field) => field !== "validatorContractId",
    );
  harness.evalProtocol.heldConstantFields.push("modelAlias");
  refreshReceipts(harness);
  const harnessReport = evaluateLaneValidity(harness);
  assert.equal(harnessReport.status, "COMPLETE");
  assert.equal(harnessReport.attributionStatus, "SINGLE_FACTOR");
  assert.match(
    harnessReport.claimBoundary,
    /Single declared workflow-component/u,
  );

  const shadow = laneBundle({
    laneType: "SHADOW_PILOT",
    allowedDifferenceAxes: ["modelAlias"],
    executionMode: "SHADOW_NO_POSTING",
  });
  const shadowReport = evaluateLaneValidity(shadow);
  assert.equal(shadowReport.status, "COMPLETE");
  assert.equal(shadowReport.attributionStatus, "HOLISTIC_VARIANT");
  assert.match(shadowReport.claimBoundary, /no posting or writeback/u);
});

test("missing protocols, contamination, and held constants remain insufficient", () => {
  const cases = [
    {
      name: "missing eval protocol",
      mutate: (source) => {
        delete source.evalProtocol;
      },
      code: "MISSING_EVAL_PROTOCOL",
      normalized: true,
    },
    {
      name: "missing adjudication protocol",
      mutate: (source) => {
        delete source.adjudicationProtocol;
      },
      code: "MISSING_ADJUDICATION_PROTOCOL",
      normalized: true,
    },
    {
      name: "declared contamination",
      mutate: (source) => {
        source.evalProtocol.knownContamination = "PRESENT";
      },
      code: "MISSING_LEAKAGE_OR_EXCLUSION_EVIDENCE",
    },
    {
      name: "missing held constant",
      mutate: (source) => {
        source.evalProtocol.heldConstantFields = [];
      },
      code: "MISSING_HELD_CONSTANT_EVIDENCE",
    },
    {
      name: "missing replicate policy",
      mutate: (source) => {
        delete source.evalProtocol.replicateAggregation;
      },
      code: "INCOMPLETE_COHORT_OR_PAIRING_EVIDENCE",
      normalized: true,
    },
  ];
  for (const entry of cases) {
    const source = entry.normalized
      ? normalizeLaneBundle(laneBundle())
      : laneBundle();
    entry.mutate(source);
    if (!entry.normalized) {
      refreshReceipts(source);
    }
    const report = evaluateLaneValidity(source);
    assert.equal(report.status, "INSUFFICIENT_EVIDENCE", entry.name);
    assert.ok(report.reasonCodes.includes(entry.code), entry.name);
  }

  const blocked = evaluateLaneValidity({});
  assert.equal(blocked.status, "BLOCKED");
  assert.ok(blocked.reasonCodes.includes("RO-EV-001"));
});

test("validity keeps protocol, preservation, and provenance gaps explicit", () => {
  const cases = [
    {
      name: "protocol lane mismatch",
      mutate: (source) => {
        source.evalProtocol.laneId = "other-lane";
      },
      code: "INCOMPLETE_COHORT_OR_PAIRING_EVIDENCE",
    },
    {
      name: "cohort digest mismatch",
      mutate: (source) => {
        source.evalProtocol.cohortSelectionDigest = digest(999);
      },
      code: "INCOMPLETE_COHORT_OR_PAIRING_EVIDENCE",
    },
    {
      name: "missing preservation contracts",
      mutate: (source) => {
        delete source.evalProtocol.preservationContracts;
      },
      code: "MISSING_PRESERVATION_CONTRACTS",
      normalized: true,
    },
    {
      name: "preservation mismatch",
      mutate: (source) => {
        source.evalProtocol.preservationContracts.toolContractId = "tools-v2";
      },
      code: "PRESERVATION_CONTRACT_MISMATCH",
    },
    {
      name: "run candidate contract mismatch",
      mutate: (source) => {
        source.runs[1].validatorContractId = "validator-v2";
      },
      code: "RUN_CANDIDATE_PROVENANCE_MISMATCH",
      attribution: "CONFOUNDED",
    },
    {
      name: "missing independence provenance",
      mutate: (source) => {
        delete source.adjudicationProtocol.adjudicatorIndependence.provenanceId;
      },
      code: "INCOMPLETE_INDEPENDENCE_OR_DISAGREEMENT_EVIDENCE",
      normalized: true,
    },
    {
      name: "unfinished disagreement",
      mutate: (source) => {
        source.adjudicationProtocol.disagreement.status = "PARTIAL";
      },
      code: "INCOMPLETE_INDEPENDENCE_OR_DISAGREEMENT_EVIDENCE",
    },
    {
      name: "undeclared leakage control",
      mutate: (source) => {
        source.evalProtocol.leakageControls[0].evidenceStatus = "UNKNOWN";
      },
      code: "MISSING_LEAKAGE_OR_EXCLUSION_EVIDENCE",
    },
  ];
  for (const entry of cases) {
    const source = entry.normalized
      ? normalizeLaneBundle(laneBundle())
      : laneBundle();
    entry.mutate(source);
    if (!entry.normalized) {
      refreshReceipts(source);
    }
    const report = evaluateLaneValidity(source);
    assert.equal(report.status, "INSUFFICIENT_EVIDENCE", entry.name);
    assert.ok(report.reasonCodes.includes(entry.code), entry.name);
    if (entry.attribution) {
      assert.equal(report.attributionStatus, entry.attribution, entry.name);
    }
  }

  const aggregate = evaluateEvalValidity([laneBundle(), visibleLane()]);
  assert.equal(aggregate.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(aggregate.lanes.length, 2);
});

function visibleLane() {
  const source = laneBundle();
  source.adjudicationProtocol.presentationOrder = "FIXED";
  return refreshReceipts(source);
}
