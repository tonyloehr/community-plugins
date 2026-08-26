// @ts-check

import { assertJsonDepth, assertRecordCount, resolveLimits } from "./bounds.mjs";
import { fail } from "./errors.mjs";
import { iterateLines } from "./utils.mjs";

/** @import {Limits} from "./bounds.mjs" */

/**
 * JSON.parse silently keeps the last copy of a duplicate object key. That is
 * unsafe for a fail-closed evidence contract because a human reviewer and the
 * validator can appear to see different values. Scan the bounded input first
 * and reject duplicate decoded keys before parsing the value.
 *
 * @param {string} text
 * @param {Limits} limits
 */
function assertNoDuplicateJsonKeys(text, limits) {
  let index = 0;

  const invalid = () => fail("RO_JSON_INVALID", "JSON input is malformed.");

  const whitespace = () => {
    while (
      text[index] === " " ||
      text[index] === "\t" ||
      text[index] === "\n" ||
      text[index] === "\r"
    ) {
      index += 1;
    }
  };

  /**
   * @returns {string}
   */
  const stringValue = () => {
    const start = index;
    if (text[index] !== '"') {
      return invalid();
    }
    index += 1;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 0x22) {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index));
        } catch {
          return invalid();
        }
      }
      if (code === 0x5c) {
        index += 1;
        if (index >= text.length) {
          return invalid();
        }
        const escape = text[index];
        if ('"\\/bfnrt'.includes(escape)) {
          index += 1;
          continue;
        }
        if (
          escape === "u" &&
          /^[0-9A-Fa-f]{4}$/u.test(text.slice(index + 1, index + 5))
        ) {
          index += 5;
          continue;
        }
        return invalid();
      }
      if (code < 0x20) {
        return invalid();
      }
      index += 1;
    }
    return invalid();
  };

  const numberValue = () => {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
      text.slice(index),
    );
    if (match === null) {
      return invalid();
    }
    index += match[0].length;
  };

  /** @param {string} literal */
  const literalValue = (literal) => {
    if (text.slice(index, index + literal.length) !== literal) {
      return invalid();
    }
    index += literal.length;
  };

  /**
   * @param {number} depth
   */
  const value = (depth) => {
    whitespace();
    const character = text[index];
    if (character === "{") {
      if (depth + 1 > limits.maxJsonDepth) {
        fail("RO_JSON_TOO_DEEP", "JSON input exceeds the nesting limit.");
      }
      index += 1;
      whitespace();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      const keys = new Set();
      while (true) {
        whitespace();
        const key = stringValue();
        if (keys.has(key)) {
          fail("RO_JSON_DUPLICATE_KEY", "JSON input contains a duplicate object key.");
        }
        keys.add(key);
        whitespace();
        if (text[index] !== ":") {
          return invalid();
        }
        index += 1;
        value(depth + 1);
        whitespace();
        if (text[index] === "}") {
          index += 1;
          return;
        }
        if (text[index] !== ",") {
          return invalid();
        }
        index += 1;
      }
    }
    if (character === "[") {
      if (depth + 1 > limits.maxJsonDepth) {
        fail("RO_JSON_TOO_DEEP", "JSON input exceeds the nesting limit.");
      }
      index += 1;
      whitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      while (true) {
        value(depth + 1);
        whitespace();
        if (text[index] === "]") {
          index += 1;
          return;
        }
        if (text[index] !== ",") {
          return invalid();
        }
        index += 1;
      }
    }
    if (character === '"') {
      stringValue();
      return;
    }
    if (character === "t") {
      literalValue("true");
      return;
    }
    if (character === "f") {
      literalValue("false");
      return;
    }
    if (character === "n") {
      literalValue("null");
      return;
    }
    if (character === "-" || (character >= "0" && character <= "9")) {
      numberValue();
      return;
    }
    return invalid();
  };

  value(0);
  whitespace();
  if (index !== text.length) {
    invalid();
  }
}

/**
 * @param {string} text
 * @param {string} _label
 * @param {Limits} [limits]
 */
export function parseJsonText(text, _label, limits) {
  if (typeof text !== "string") {
    fail("RO_JSON_INVALID", "JSON input is malformed.");
  }
  const effectiveLimits = limits ?? resolveLimits();
  assertNoDuplicateJsonKeys(text, effectiveLimits);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("RO_JSON_INVALID", "JSON input is malformed.");
  }
  assertJsonDepth(value, effectiveLimits);
  return value;
}

/**
 * @param {string} text
 * @param {string} _label
 * @param {Limits} [limits]
 */
export function parseJsonLines(text, _label, limits) {
  if (typeof text !== "string") {
    fail("RO_JSON_INVALID", "JSON input is malformed.");
  }
  const effectiveLimits = limits ?? resolveLimits();
  const values = [];
  for (const line of iterateLines(text)) {
    if (line.trim().length === 0) {
      continue;
    }
    values.push(parseJsonText(line, "JSONL record", effectiveLimits));
    assertRecordCount(values.length, effectiveLimits);
  }
  return values;
}
