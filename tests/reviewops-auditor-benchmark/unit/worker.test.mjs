import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const workerUrl = new URL(
  "../../../plugins/reviewops-auditor-benchmark/src/worker.mjs",
  import.meta.url,
);
const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const fixtureRoot = path.join(
  repoRoot,
  "plugins",
  "reviewops-auditor-benchmark",
  "fixtures",
  "synthetic",
);

function request(worker, message) {
  return new Promise((resolve, reject) => {
    const onMessage = (value) => {
      worker.off("error", onError);
      resolve(value);
    };
    const onError = (error) => {
      worker.off("message", onMessage);
      reject(error);
    };
    worker.once("message", onMessage);
    worker.once("error", onError);
    worker.postMessage(message);
  });
}

function json(relativePath) {
  return JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, relativePath), "utf8"),
  );
}

function records(relativePaths) {
  return relativePaths.flatMap((relativePath) => {
    const text = fs.readFileSync(path.join(fixtureRoot, relativePath), "utf8");
    if (relativePath.endsWith(".jsonl")) {
      return text
        .split(/\r?\n/u)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
    }
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  });
}

function fixturePayload() {
  const config = json("reviewops.config.json");
  const laneBundles = config.laneBundles.map((bundle) => ({
    bundleId: bundle.bundleId,
    manifest: json(bundle.manifestPath),
    evalProtocol: json(bundle.evalProtocolPath),
    adjudicationProtocol: json(bundle.adjudicationProtocolPath),
    candidateConfigs: records(bundle.candidateConfigPaths),
    rubric: json(bundle.rubricPath),
    pricingSnapshot: json(bundle.pricingSnapshotPath),
    caseLabels: records(bundle.caseLabelPaths),
    exports: records(bundle.exportPaths),
  }));
  return {
    input: { laneBundles },
    decisionPolicy: json(config.decisionPolicyPath),
    analysisAsOf: config.analysisAsOf,
  };
}

test("analysis worker runs revised pure pipeline operations", async (t) => {
  const worker = new Worker(workerUrl);
  t.after(async () => {
    await worker.terminate();
  });
  const payload = fixturePayload();

  const normalization = await request(worker, {
    operation: "normalize",
    payload,
  });
  assert.equal(normalization.ok, true);
  assert.equal(normalization.value.status, "COMPLETE");
  assert.equal(normalization.value.lanes.length, 2);

  const evalValidity = await request(worker, {
    operation: "audit-eval",
    payload,
  });
  assert.equal(evalValidity.ok, true);
  assert.equal(evalValidity.value.evalValidity.status, "COMPLETE");
  assert.equal(evalValidity.value.staticDiagnostics, null);

  const benchmark = await request(worker, {
    operation: "benchmark",
    payload,
  });
  assert.equal(benchmark.ok, true);
  assert.equal(benchmark.value.scorecard.status, "COMPLETE");
  assert.equal(benchmark.value.scorecard.lanes.length, 2);

  const recommendation = await request(worker, {
    operation: "recommend-architecture",
    payload,
  });
  assert.equal(recommendation.ok, true);
  assert.equal(
    recommendation.value.recommendation.recommendationStatus,
    "RECOMMENDED_FOR_SHADOW",
  );
  assert.equal(
    recommendation.value.recommendation.defaultArchitectureId,
    "candidate-a",
  );
});

test("analysis worker sanitizes unsupported and malformed requests", async (t) => {
  const worker = new Worker(workerUrl);
  t.after(async () => {
    await worker.terminate();
  });
  const unsupported = await request(worker, {
    operation: "unknown",
    payload: {},
  });
  assert.deepEqual(unsupported, {
    ok: false,
    error: {
      code: "RO_WORKER_OPERATION_INVALID",
      message: "Analysis worker received an unsupported operation.",
      status: "BLOCKED",
    },
  });
  const malformed = await request(worker, {
    operation: "normalize",
    payload: null,
  });
  assert.deepEqual(malformed, {
    ok: false,
    error: {
      code: "RO_WORKER_MESSAGE_INVALID",
      message: "Analysis worker received an invalid request.",
      status: "BLOCKED",
    },
  });
});
