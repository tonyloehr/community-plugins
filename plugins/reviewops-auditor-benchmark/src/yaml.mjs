// @ts-check

import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";

import { assertBoundedText, resolveLimits } from "./bounds.mjs";
import { fail } from "./errors.mjs";
import { isPlainObject } from "./utils.mjs";

/** @import {Limits} from "./bounds.mjs" */

/**
 * @typedef {{
 *   value: Record<string, unknown>,
 *   lineMap: Record<string, number>,
 *   bytes: number,
 *   lines: number,
 *   nodeCount: number
 * }} ParsedWorkflowYaml
 */

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * @param {readonly (string | number)[]} segments
 * @returns {string}
 */
function pointerFor(segments) {
  if (segments.length === 0) {
    return "/";
  }
  return (
    "/" +
    segments
      .map((segment) => String(segment).replace(/~/gu, "~0").replace(/\//gu, "~1"))
      .join("/")
  );
}

/**
 * @param {unknown} node
 * @param {LineCounter} lineCounter
 * @returns {number}
 */
function lineForNode(node, lineCounter) {
  if (
    node !== null &&
    typeof node === "object" &&
    "range" in node &&
    Array.isArray(node.range) &&
    typeof node.range[0] === "number"
  ) {
    return Math.max(1, lineCounter.linePos(node.range[0]).line);
  }
  return 1;
}

/**
 * @param {unknown} node
 * @returns {string | undefined}
 */
function explicitTag(node) {
  if (
    node !== null &&
    typeof node === "object" &&
    "tag" in node &&
    typeof node.tag === "string"
  ) {
    return node.tag;
  }
  return undefined;
}

/**
 * @param {unknown} node
 * @param {{
 *   depth: number,
 *   path: (string | number)[],
 *   lineCounter: LineCounter,
 *   lineMap: Record<string, number>,
 *   limits: Limits,
 *   state: {nodes: number}
 * }} context
 * @returns {unknown}
 */
function convertNode(node, context) {
  context.state.nodes += 1;
  if (context.state.nodes > context.limits.maxYamlNodes) {
    fail("RO_YAML_NODE_LIMIT", "YAML input exceeds the node limit.");
  }
  if (context.depth > context.limits.maxJsonDepth) {
    fail("RO_YAML_TOO_DEEP", "YAML input exceeds the nesting limit.");
  }

  const pointer = pointerFor(context.path);
  if (context.lineMap[pointer] === undefined) {
    context.lineMap[pointer] = lineForNode(node, context.lineCounter);
  }

  if (isAlias(node)) {
    fail("RO_YAML_ALIAS", "YAML aliases are not supported.");
  }
  if (explicitTag(node) !== undefined) {
    fail("RO_YAML_TAG", "Explicit YAML tags are not supported.");
  }

  if (isScalar(node)) {
    const value = node.value;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      return value;
    }
    fail("RO_YAML_SCALAR", "YAML contains an unsupported scalar.");
  }

  if (isSeq(node)) {
    return node.items.map((item, index) =>
      convertNode(item, {
        ...context,
        depth: context.depth + 1,
        path: [...context.path, index],
      }),
    );
  }

  if (isMap(node)) {
    /** @type {Record<string, unknown>} */
    const output = Object.create(null);
    const seen = new Set();
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
        fail("RO_YAML_KEY", "YAML mapping keys must be strings.");
      }
      const key = pair.key.value;
      if (key === "<<" || FORBIDDEN_KEYS.has(key)) {
        fail("RO_YAML_KEY", "YAML contains an unsupported mapping key.");
      }
      if (seen.has(key)) {
        fail("RO_YAML_DUPLICATE_KEY", "YAML contains a duplicate mapping key.");
      }
      seen.add(key);
      const childPath = [...context.path, key];
      context.lineMap[pointerFor(childPath)] = lineForNode(
        pair.key,
        context.lineCounter,
      );
      output[key] =
        pair.value === null
          ? null
          : convertNode(pair.value, {
              ...context,
              depth: context.depth + 1,
              path: childPath,
            });
    }
    return output;
  }

  fail("RO_YAML_NODE", "YAML contains an unsupported node.");
}

/**
 * Parses YAML 1.2/core as inert data. It rejects aliases, tags, merge keys,
 * duplicate keys, unsupported scalars, and ambiguous parser warnings.
 *
 * @param {string} text
 * @param {{limits?: Limits}} [options]
 * @returns {{value: unknown, lineMap: Record<string, number>, bytes: number, lines: number, nodeCount: number}}
 */
export function parseSafeYaml(text, options = {}) {
  const limits = options.limits ?? resolveLimits();
  const shape = assertBoundedText(text, { kind: "workflow", limits });
  const lineCounter = new LineCounter();
  const document = parseDocument(text, {
    version: "1.2",
    schema: "core",
    strict: true,
    uniqueKeys: true,
    stringKeys: true,
    merge: false,
    resolveKnownTags: false,
    customTags: [],
    prettyErrors: false,
    lineCounter,
  });

  if (document.errors.length > 0) {
    if (document.errors.some((error) => error.code === "DUPLICATE_KEY")) {
      fail("RO_YAML_DUPLICATE_KEY", "YAML contains a duplicate mapping key.");
    }
    fail("RO_YAML_INVALID", "YAML input is malformed or unsupported.");
  }
  if (document.warnings.length > 0) {
    fail("RO_YAML_AMBIGUOUS", "YAML input is ambiguous or unsupported.");
  }
  if (document.contents === null) {
    fail("RO_YAML_EMPTY", "YAML input must contain a mapping.");
  }

  /** @type {Record<string, number>} */
  const lineMap = Object.create(null);
  const state = { nodes: 0 };
  const value = convertNode(document.contents, {
    depth: 0,
    path: [],
    lineCounter,
    lineMap,
    limits,
    state,
  });

  return {
    value,
    lineMap,
    bytes: shape.bytes,
    lines: shape.lines,
    nodeCount: state.nodes,
  };
}

/**
 * @param {string} text
 * @param {{limits?: Limits}} [options]
 * @returns {ParsedWorkflowYaml}
 */
export function parseWorkflowYaml(text, options = {}) {
  const parsed = parseSafeYaml(text, options);
  if (!isPlainObject(parsed.value)) {
    fail("RO_WORKFLOW_ROOT", "Workflow YAML must contain a top-level mapping.");
  }
  return /** @type {ParsedWorkflowYaml} */ (parsed);
}

/**
 * @param {{lineMap: Record<string, number>}} parsed
 * @param {readonly (string | number)[]} segments
 * @returns {number | undefined}
 */
export function lineForYamlPath(parsed, segments) {
  return parsed.lineMap[pointerFor(segments)];
}
