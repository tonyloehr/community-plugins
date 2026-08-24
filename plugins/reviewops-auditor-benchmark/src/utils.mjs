// @ts-check

import { createHash } from "node:crypto";

import { fail } from "./errors.mjs";

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * @param {string} value
 * @returns {number}
 */
export function utf8Bytes(value) {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Iterates logical lines without materializing an array. Empty text has no
 * lines; a trailing separator yields the same final empty line as String#split.
 *
 * @param {string} value
 * @returns {Generator<string>}
 */
export function* iterateLines(value) {
  if (value.length === 0) {
    return;
  }

  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code !== 10 && code !== 13) {
      continue;
    }

    yield value.slice(start, index);
    if (code === 13 && value.charCodeAt(index + 1) === 10) {
      index += 1;
    }
    start = index + 1;
  }
  yield value.slice(start);
}

/**
 * Counts lines and longest UTF-8 line bytes in one allocation-bounded pass.
 *
 * @param {string} value
 * @returns {{lines: number, longestLineBytes: number}}
 */
export function textLineShape(value) {
  if (value.length === 0) {
    return { lines: 0, longestLineBytes: 0 };
  }

  let lines = 1;
  let longestLineBytes = 0;
  let currentLineBytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 10 || code === 13) {
      longestLineBytes = Math.max(longestLineBytes, currentLineBytes);
      currentLineBytes = 0;
      lines += 1;
      if (code === 13 && value.charCodeAt(index + 1) === 10) {
        index += 1;
      }
      continue;
    }

    if (code <= 0x7f) {
      currentLineBytes += 1;
    } else if (code <= 0x7ff) {
      currentLineBytes += 2;
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      currentLineBytes += 4;
      index += 1;
    } else {
      currentLineBytes += 3;
    }
  }

  return {
    lines,
    longestLineBytes: Math.max(longestLineBytes, currentLineBytes),
  };
}

/**
 * Counts logical lines while treating an empty string as zero lines.
 *
 * @param {string} value
 * @returns {number}
 */
export function lineCount(value) {
  return textLineShape(value).lines;
}

/**
 * @param {string} value
 * @returns {number}
 */
export function longestLineBytes(value) {
  return textLineShape(value).longestLineBytes;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function stableJson(value) {
  /** @type {Set<object>} */
  const seen = new Set();

  /**
   * @param {unknown} item
   * @returns {string}
   */
  function serialize(item) {
    if (item === null) {
      return "null";
    }

    if (typeof item === "string" || typeof item === "boolean") {
      return JSON.stringify(item);
    }

    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        fail("RO_NON_FINITE_NUMBER", "Only finite JSON numbers are supported.");
      }
      return JSON.stringify(item);
    }

    if (Array.isArray(item)) {
      if (seen.has(item)) {
        fail("RO_CYCLIC_VALUE", "Cyclic values are not supported.");
      }
      seen.add(item);
      const output = "[" + item.map((entry) => serialize(entry)).join(",") + "]";
      seen.delete(item);
      return output;
    }

    if (isPlainObject(item)) {
      if (seen.has(item)) {
        fail("RO_CYCLIC_VALUE", "Cyclic values are not supported.");
      }
      seen.add(item);
      const entries = Object.keys(item)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + serialize(item[key]));
      seen.delete(item);
      return "{" + entries.join(",") + "}";
    }

    fail("RO_NON_JSON_VALUE", "Only JSON-compatible values are supported.");
  }

  return serialize(value);
}

/**
 * This digest is safe only for structural projections prepared by the caller.
 * Do not pass raw prompts, diffs, logs, low-entropy IDs, or file bytes.
 *
 * @param {unknown} projection
 * @returns {string}
 */
export function structuralDigest(projection) {
  return "sha256:" + createHash("sha256").update(stableJson(projection)).digest("hex");
}

/**
 * @template T
 * @param {readonly T[]} values
 * @param {(left: T, right: T) => number} compare
 * @returns {T[]}
 */
export function stableSort(values, compare) {
  return values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => compare(left.value, right.value) || left.index - right.index)
    .map(({ value }) => value);
}

/**
 * @param {readonly string[]} values
 * @returns {string[]}
 */
export function sortedUniqueStrings(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

/**
 * @param {string} text
 * @param {number} offset
 * @returns {number}
 */
export function lineAtOffset(text, offset) {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return 1;
  }

  let line = 1;
  const end = Math.min(offset, text.length);
  for (let index = 0; index < end; index += 1) {
    if (text[index] === "\n") {
      line += 1;
    }
  }
  return line;
}

/**
 * @param {unknown} value
 * @param {number} [depth]
 * @param {number} [ceiling]
 * @returns {number}
 */
export function jsonDepth(value, depth = 0, ceiling = Number.POSITIVE_INFINITY) {
  let maximum = depth;
  /** @type {{value: unknown, depth: number}[]} */
  const pending = [{ value, depth }];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    const item = current.value;
    if (!Array.isArray(item) && !isPlainObject(item)) {
      maximum = Math.max(maximum, current.depth);
      continue;
    }

    const childDepth = current.depth + 1;
    maximum = Math.max(maximum, childDepth);
    if (maximum > ceiling) {
      return maximum;
    }

    const entries = Array.isArray(item) ? item : Object.values(item);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      pending.push({ value: entries[index], depth: childDepth });
    }
  }

  return maximum;
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
export function isNonNegativeSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
