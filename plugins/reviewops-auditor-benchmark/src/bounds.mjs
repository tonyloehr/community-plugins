// @ts-check

import { fail } from "./errors.mjs";
import {
  isNonNegativeSafeInteger,
  isPlainObject,
  jsonDepth,
  textLineShape,
  utf8Bytes,
} from "./utils.mjs";

export const HARD_LIMITS = Object.freeze({
  maxFiles: 100,
  maxBytesPerFile: 8 * 1024 * 1024,
  maxWorkflowBytes: 2 * 1024 * 1024,
  maxPromptBytes: 2 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxRecords: 10_000,
  maxFindings: 1_000,
  maxEvidenceBytes: 128 * 1024,
  maxStdoutBytes: 2 * 1024 * 1024,
  maxLineBytes: 128 * 1024,
  maxJsonDepth: 32,
  maxYamlNodes: 20_000,
});

export const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 50,
  maxBytesPerFile: 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  maxRecords: 5_000,
  maxLineBytes: 64 * 1024,
  maxJsonDepth: 32,
  maxYamlNodes: 10_000,
});

/** @typedef {"workflow" | "prompt" | "config" | "json" | "jsonl" | "telemetry" | "run"} InputKind */

/**
 * @typedef {{
 *   maxFiles: number,
 *   maxBytesPerFile: number,
 *   maxTotalBytes: number,
 *   maxRecords: number,
 *   maxLineBytes: number,
 *   maxJsonDepth: number,
 *   maxYamlNodes: number
 * }} Limits
 */

/**
 * @param {unknown} requested
 * @returns {Limits}
 */
export function resolveLimits(requested = {}) {
  if (!isPlainObject(requested)) {
    fail("RO_LIMITS_INVALID", "Limits must be a JSON object.");
  }

  const allowed = new Set([
    "maxFiles",
    "maxBytesPerFile",
    "maxTotalBytes",
    "maxRecords",
    "maxLineBytes",
    "maxJsonDepth",
    "maxYamlNodes",
  ]);
  for (const key of Object.keys(requested)) {
    if (!allowed.has(key)) {
      fail("RO_LIMITS_UNKNOWN_FIELD", "Limits contain an unsupported field.");
    }
  }

  /** @type {Limits} */
  const limits = { ...DEFAULT_LIMITS };
  /** @type {Record<keyof Limits, number>} */
  const ceilings = {
    maxFiles: HARD_LIMITS.maxFiles,
    maxBytesPerFile: HARD_LIMITS.maxBytesPerFile,
    maxTotalBytes: HARD_LIMITS.maxTotalBytes,
    maxRecords: HARD_LIMITS.maxRecords,
    maxLineBytes: HARD_LIMITS.maxLineBytes,
    maxJsonDepth: HARD_LIMITS.maxJsonDepth,
    maxYamlNodes: HARD_LIMITS.maxYamlNodes,
  };

  for (const key of /** @type {(keyof Limits)[]} */ (Object.keys(limits))) {
    const value = requested[key];
    if (value === undefined) {
      continue;
    }
    if (!isNonNegativeSafeInteger(value) || value === 0 || value > ceilings[key]) {
      fail(
        "RO_LIMIT_EXCEEDS_CEILING",
        "A configured limit is invalid or exceeds its hard ceiling.",
      );
    }
    limits[key] = value;
  }

  return Object.freeze(limits);
}

/**
 * @param {InputKind} kind
 * @param {Limits} limits
 * @returns {number}
 */
export function maxBytesForKind(kind, limits) {
  if (kind === "workflow") {
    return Math.min(limits.maxBytesPerFile, HARD_LIMITS.maxWorkflowBytes);
  }
  if (kind === "prompt") {
    return Math.min(limits.maxBytesPerFile, HARD_LIMITS.maxPromptBytes);
  }
  return Math.min(limits.maxBytesPerFile, HARD_LIMITS.maxBytesPerFile);
}

/**
 * @param {string} text
 * @param {{kind: InputKind, limits?: Limits}} options
 * @returns {{bytes: number, lines: number}}
 */
export function assertBoundedText(text, options) {
  if (typeof text !== "string") {
    fail("RO_TEXT_INVALID", "Input must decode as UTF-8 text.");
  }
  if (text.includes("\0")) {
    fail("RO_TEXT_NUL", "Input contains a NUL byte.");
  }

  const limits = options.limits ?? resolveLimits();
  const bytes = utf8Bytes(text);
  if (bytes > maxBytesForKind(options.kind, limits)) {
    fail("RO_FILE_TOO_LARGE", "Input exceeds the per-file byte limit.");
  }
  const lineShape = textLineShape(text);
  if (lineShape.longestLineBytes > limits.maxLineBytes) {
    fail("RO_LINE_TOO_LONG", "Input contains a line that exceeds the byte limit.");
  }

  return { bytes, lines: lineShape.lines };
}

/**
 * @param {string} output
 */
export function assertStdoutBytes(output) {
  if (typeof output !== "string" || utf8Bytes(output) > HARD_LIMITS.maxStdoutBytes) {
    fail("RO_OUTPUT_TOO_LARGE", "Report exceeds the hard stdout byte limit.");
  }
}

/**
 * @param {unknown} value
 * @param {Limits} [limits]
 */
export function assertJsonDepth(value, limits = resolveLimits()) {
  if (jsonDepth(value, 0, limits.maxJsonDepth) > limits.maxJsonDepth) {
    fail("RO_JSON_TOO_DEEP", "JSON input exceeds the nesting limit.");
  }
}

/**
 * @param {number} records
 * @param {Limits} [limits]
 */
export function assertRecordCount(records, limits = resolveLimits()) {
  if (!isNonNegativeSafeInteger(records) || records > limits.maxRecords) {
    fail("RO_RECORD_LIMIT", "Input exceeds the record limit.");
  }
}

/**
 * Creates a per-invocation accounting object. It intentionally has no global
 * state, so concurrent analyses cannot affect one another.
 *
 * @param {Limits} [limits]
 * @returns {{
 *   readonly limits: Limits,
 *   readonly files: number,
 *   readonly totalBytes: number,
 *   consume: (entry: {kind: InputKind, bytes: number}) => void
 * }}
 */
export function createReadBudget(limits = resolveLimits()) {
  let files = 0;
  let totalBytes = 0;

  return {
    limits,
    get files() {
      return files;
    },
    get totalBytes() {
      return totalBytes;
    },
    consume(entry) {
      if (!isNonNegativeSafeInteger(entry.bytes)) {
        fail("RO_FILE_SIZE_INVALID", "Input has an invalid byte size.");
      }
      if (entry.bytes > maxBytesForKind(entry.kind, limits)) {
        fail("RO_FILE_TOO_LARGE", "Input exceeds the per-file byte limit.");
      }
      if (files + 1 > limits.maxFiles) {
        fail("RO_FILE_LIMIT", "Input exceeds the file count limit.");
      }
      if (totalBytes + entry.bytes > limits.maxTotalBytes) {
        fail("RO_TOTAL_BYTES_LIMIT", "Input exceeds the total byte limit.");
      }
      files += 1;
      totalBytes += entry.bytes;
    },
  };
}
