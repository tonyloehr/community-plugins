// @ts-check

import { isPlainObject, lineCount, utf8Bytes } from "./utils.mjs";

const REDACTED = "[REDACTED]";
const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/giu;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/giu;

/** @typedef {{text: string, count: number, categories: Record<string, number>}} RedactionResult */

/** @type {readonly {category: string, pattern: RegExp, replacement?: string | ((match: string, ...captures: string[]) => string)}[]} */
const TEXT_RULES = Object.freeze([
  {
    category: "AUTH_HEADER",
    pattern:
      /\b(authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*[^\s,;]+/giu,
    replacement: (_match, name) => name + ": " + REDACTED,
  },
  {
    category: "SECRET_ASSIGNMENT",
    pattern:
      /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*[:=]\s*([^\s,;]+)/giu,
    replacement: (_match, name) => name + "=" + REDACTED,
  },
  {
    category: "TOKEN",
    pattern:
      /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/gu,
  },
  {
    category: "EMAIL",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
  },
  {
    category: "URL",
    pattern: /\b(?:https?|ssh):\/\/[^\s<>()\[\]{}"'`]+/giu,
  },
  {
    category: "GIT_REMOTE",
    pattern: /\bgit@[^\s:]+:[^\s]+/giu,
  },
  {
    category: "HOME_PATH",
    pattern:
      /(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|[A-Z]:\\Users\\[^\\\s]+)(?:[/\\][^\s"'`<>]*)?/giu,
  },
  {
    category: "PRIVATE_HOST",
    pattern:
      /\b(?:localhost|(?:[A-Z0-9-]+\.)+(?:internal|local|corp|private))(?::\d+)?\b/giu,
  },
]);

const SENSITIVE_KEY =
  /(?:token|secret|password|passwd|cookie|authorization|api[_-]?key|private[_-]?key|access[_-]?key)/iu;
const ANSI_ESCAPE =
  /[\u001B\u009B](?:\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~])/gu;
const CONTROL_AND_BIDI =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/**
 * @param {Record<string, number>} categories
 * @param {string} category
 * @param {number} amount
 */
function addCategory(categories, category, amount) {
  categories[category] = (categories[category] ?? 0) + amount;
}

/**
 * Finds PEM private-key blocks in one forward pass. An unmatched begin marker
 * is conservatively redacted through end-of-input.
 *
 * @param {string} value
 * @returns {{text: string, count: number}}
 */
function redactPrivateKeys(value) {
  let cursor = 0;
  let output = "";
  let count = 0;
  PRIVATE_KEY_BEGIN.lastIndex = 0;

  while (true) {
    const begin = PRIVATE_KEY_BEGIN.exec(value);
    if (begin === null) {
      break;
    }
    PRIVATE_KEY_END.lastIndex = PRIVATE_KEY_BEGIN.lastIndex;
    const end = PRIVATE_KEY_END.exec(value);
    if (end === null) {
      output += value.slice(cursor, begin.index) + REDACTED;
      cursor = value.length;
      count += 1;
      break;
    }

    output += value.slice(cursor, begin.index) + REDACTED;
    cursor = PRIVATE_KEY_END.lastIndex;
    PRIVATE_KEY_BEGIN.lastIndex = cursor;
    count += 1;
  }

  PRIVATE_KEY_BEGIN.lastIndex = 0;
  PRIVATE_KEY_END.lastIndex = 0;
  return {
    text: count === 0 ? value : output + value.slice(cursor),
    count,
  };
}

/**
 * Conservatively removes secret-like and identifying substrings before any
 * value can reach a report or error. Callers should still prefer structural
 * summaries over excerpts.
 *
 * @param {string} value
 * @returns {RedactionResult}
 */
export function redactText(value) {
  let text = stripUnsafeControls(String(value));
  let count = 0;
  /** @type {Record<string, number>} */
  const categories = Object.create(null);

  const privateKeys = redactPrivateKeys(text);
  text = privateKeys.text;
  if (privateKeys.count > 0) {
    count += privateKeys.count;
    addCategory(categories, "PRIVATE_KEY", privateKeys.count);
  }

  for (const rule of TEXT_RULES) {
    let matches = 0;
    text = text.replace(rule.pattern, (...args) => {
      matches += 1;
      if (typeof rule.replacement === "function") {
        const [match, ...captures] = /** @type {string[]} */ (args.slice(0, -2));
        return rule.replacement(match, ...captures);
      }
      return rule.replacement ?? REDACTED;
    });
    if (matches > 0) {
      count += matches;
      addCategory(categories, rule.category, matches);
    }
  }

  return { text, count, categories };
}

/**
 * @param {string} value
 * @returns {string}
 */
export function stripUnsafeControls(value) {
  return value
    .normalize("NFC")
    .replace(ANSI_ESCAPE, "")
    .replace(CONTROL_AND_BIDI, "")
    .replace(/\r\n|\r/gu, "\n");
}

/**
 * Converts untrusted text into a single Markdown-safe inline value. It cannot
 * open a code fence, table cell, HTML tag, heading, or link.
 *
 * @param {string} value
 * @param {{maxChars?: number}} [options]
 * @returns {RedactionResult}
 */
export function escapeUntrustedText(value, options = {}) {
  const redacted = redactText(value);
  const maxChars = options.maxChars ?? 240;
  let text = stripUnsafeControls(redacted.text).replace(/\s+/gu, " ").trim();
  const characters = [...text];
  if (characters.length > maxChars) {
    text = characters.slice(0, Math.max(0, maxChars - 1)).join("") + "…";
  }
  text = text.replace(/[\\`*_{}\[\]()<>#+.!|\-]/gu, "\\$&");
  return { ...redacted, text };
}

/**
 * @param {string} value
 * @param {{maxChars?: number}} [options]
 * @returns {RedactionResult}
 */
export function safeEvidenceSummary(value, options) {
  return escapeUntrustedText(value, options);
}

/**
 * Returns a safe relative display path or a redaction marker. Absolute,
 * parent-broadening, and backslash paths are never echoed.
 *
 * @param {string} value
 * @returns {RedactionResult}
 */
export function redactRelativePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    value
      .split("/")
      .some((segment) => segment === ".." || segment === "." || segment === "")
  ) {
    return { text: REDACTED, count: 1, categories: { PATH: 1 } };
  }
  const cleaned = stripUnsafeControls(value);
  const redacted = redactText(cleaned);
  if (cleaned !== value || redacted.count > 0 || redacted.text !== cleaned) {
    return {
      text: REDACTED,
      count: redacted.count + (cleaned === value ? 0 : 1),
      categories:
        redacted.count > 0 ? { ...redacted.categories } : { CONTROL_CHARACTERS: 1 },
    };
  }
  return { text: cleaned, count: 0, categories: {} };
}

/**
 * Recursively redacts JSON-compatible values. Sensitive-key values are
 * replaced wholesale so a novel credential format cannot leak through.
 *
 * @param {unknown} value
 * @param {{maxDepth?: number}} [options]
 * @returns {{value: unknown, count: number, categories: Record<string, number>}}
 */
export function redactJsonValue(value, options = {}) {
  const maxDepth = options.maxDepth ?? 32;
  /** @type {Record<string, number>} */
  const categories = Object.create(null);
  let count = 0;

  /**
   * @param {unknown} item
   * @param {number} depth
   * @param {string | undefined} key
   * @returns {unknown}
   */
  function visit(item, depth, key) {
    if (depth > maxDepth) {
      count += 1;
      addCategory(categories, "DEPTH", 1);
      return REDACTED;
    }
    if (key !== undefined && SENSITIVE_KEY.test(key)) {
      count += 1;
      addCategory(categories, "SENSITIVE_KEY", 1);
      return REDACTED;
    }
    if (typeof item === "string") {
      const result = redactText(item);
      count += result.count;
      for (const [category, amount] of Object.entries(result.categories)) {
        addCategory(categories, category, amount);
      }
      return result.text;
    }
    if (Array.isArray(item)) {
      return item.map((entry) => visit(entry, depth + 1, undefined));
    }
    if (isPlainObject(item)) {
      /** @type {Record<string, unknown>} */
      const output = Object.create(null);
      for (const entryKey of Object.keys(item).sort()) {
        const keyResult = redactText(entryKey);
        count += keyResult.count;
        for (const [category, amount] of Object.entries(keyResult.categories)) {
          addCategory(categories, category, amount);
        }
        const safeKey = keyResult.text;
        output[safeKey] = visit(item[entryKey], depth + 1, entryKey);
      }
      return output;
    }
    return item;
  }

  return { value: visit(value, 0, undefined), count, categories };
}

/**
 * @param {string} value
 * @returns {{bytes: number, lines: number, redactions: number}}
 */
export function redactedTextShape(value) {
  const redacted = redactText(value);
  return {
    bytes: utf8Bytes(redacted.text),
    lines: lineCount(redacted.text),
    redactions: redacted.count,
  };
}

export { REDACTED };
