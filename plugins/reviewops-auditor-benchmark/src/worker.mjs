// @ts-check

import { parentPort } from "node:worker_threads";

import { buildStaticDiagnostics } from "./audit/index.mjs";
import * as benchmarkPipeline from "./benchmark/index.mjs";
import { evaluateEvalValidity } from "./eval/index.mjs";
import { fail, publicError } from "./errors.mjs";
import { normalizeLaneBundles } from "./normalize/index.mjs";
import { recommendReferenceArchitecture } from "./recommend/index.mjs";

/** @param {unknown} value @returns {value is Record<string, any>} */
function objectValue(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {Record<string, any>} request */
function normalizedFor(request) {
  return normalizeLaneBundles(request.input ?? request.laneBundles ?? {});
}

/**
 * Static files are secondary evidence. A config binding becomes applicable
 * only after it matches the already-normalized lane and architecture receipt.
 *
 * @param {unknown} bindings
 * @param {Record<string, any>} normalization
 */
function verifiedStaticBindings(bindings, normalization) {
  if (!Array.isArray(bindings) || !Array.isArray(normalization.lanes)) {
    return [];
  }
  return bindings.filter((binding) => {
    if (!objectValue(binding)) {
      return false;
    }
    return normalization.lanes.some((lane) => {
      if (
        lane.status === "BLOCKED" ||
        lane.laneId !== binding.laneId ||
        !["BEST_SYSTEM", "SHADOW_PILOT"].includes(lane.laneType) ||
        !Array.isArray(lane.candidateConfigs)
      ) {
        return false;
      }
      return lane.candidateConfigs.some(
        (candidate) =>
          candidate.variantId === binding.variantId &&
          candidate.architectureStructuralDigest ===
            binding.architectureStructuralDigest,
      );
    });
  });
}

/**
 * Keep every downstream command on the same in-memory normalization and eval
 * path. No worker operation reads files, reaches the network, or writes back.
 *
 * @param {Record<string, any>} request
 */
function pipelineFor(request) {
  const normalization = normalizedFor(request);
  const evalValidity = evaluateEvalValidity(
    request.input ?? request.laneBundles ?? {},
    request.options ?? {},
  );
  const buildMany = benchmarkPipeline.buildMultiLaneScorecards;
  const scorecard =
    typeof buildMany === "function"
      ? buildMany(normalization, {
          ...(request.options ?? {}),
          evalValidity,
        })
      : benchmarkPipeline.buildBenchmarkScorecard(
          normalization.lanes?.[0] ?? request.input ?? {},
          request.options ?? {},
        );
  return { normalization, evalValidity, scorecard };
}

/**
 * @param {unknown} message
 * @returns {unknown}
 */
function runOperation(message) {
  if (
    !objectValue(message) ||
    typeof message.operation !== "string" ||
    !objectValue(message.payload)
  ) {
    fail("RO_WORKER_MESSAGE_INVALID", "Analysis worker received an invalid request.");
  }
  const request = message.payload;
  if (message.operation === "normalize") {
    return normalizedFor(request);
  }
  if (message.operation === "audit-eval") {
    const normalization = normalizedFor(request);
    const evalValidity = evaluateEvalValidity(
      request.input ?? request.laneBundles ?? {},
      request.options ?? {},
    );
    const staticDiagnostics = request.staticInputs
      ? buildStaticDiagnostics(request.staticInputs, {
          ...(request.options ?? {}),
          bindings: verifiedStaticBindings(request.staticBindings, normalization),
          blockingStaticRuleIds: request.decisionPolicy?.blockingStaticRuleIds,
        })
      : null;
    return { normalization, evalValidity, staticDiagnostics };
  }
  if (message.operation === "benchmark") {
    return pipelineFor(request);
  }
  if (message.operation === "recommend-architecture") {
    const pipeline = pipelineFor(request);
    const staticDiagnostics = request.staticInputs
      ? buildStaticDiagnostics(request.staticInputs, {
          ...(request.options ?? {}),
          bindings: verifiedStaticBindings(
            request.staticBindings,
            pipeline.normalization,
          ),
          blockingStaticRuleIds: request.decisionPolicy?.blockingStaticRuleIds,
        })
      : null;
    return {
      ...pipeline,
      staticDiagnostics,
      recommendation: recommendReferenceArchitecture({
        scorecard: pipeline.scorecard,
        normalizedLanes: pipeline.normalization.lanes,
        staticDiagnostics,
        decisionPolicy: request.decisionPolicy,
        analysisAsOf: request.analysisAsOf,
      }),
    };
  }
  fail(
    "RO_WORKER_OPERATION_INVALID",
    "Analysis worker received an unsupported operation.",
  );
}

if (parentPort) {
  parentPort.on("message", (message) => {
    try {
      parentPort.postMessage({ ok: true, value: runOperation(message) });
    } catch (error) {
      parentPort.postMessage({ ok: false, error: publicError(error) });
    }
  });
}
