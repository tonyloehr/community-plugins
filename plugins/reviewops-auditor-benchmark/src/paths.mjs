// @ts-check

import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import {
  assertBoundedText,
  createReadBudget,
  maxBytesForKind,
  resolveLimits,
} from "./bounds.mjs";
import { ReviewOpsError, fail } from "./errors.mjs";

/** @import {InputKind, Limits} from "./bounds.mjs" */

/**
 * @typedef {{
 *   declared: string,
 *   absolute: string,
 *   canonical: string
 * }} ApprovedRoot
 */

/**
 * @typedef {{
 *   trustedRoot: string,
 *   roots: readonly ApprovedRoot[],
 *   limits: Limits,
 *   budget: ReturnType<typeof createReadBudget>
 * }} PathContext
 */

const EXTENSIONS = Object.freeze({
  workflow: [".yml", ".yaml"],
  prompt: [".md", ".txt"],
  config: [".json"],
  json: [".json"],
  jsonl: [".json", ".jsonl"],
  telemetry: [".json", ".jsonl"],
  run: [".json", ".jsonl"],
});

/**
 * @param {unknown} value
 * @param {{allowDot?: boolean}} [options]
 * @returns {string}
 */
export function normalizeDeclaredRelativePath(value, options = {}) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail("RO_PATH_INVALID", "Path must be a non-empty relative POSIX path.");
  }
  if (
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    value.startsWith("//")
  ) {
    fail("RO_PATH_ABSOLUTE", "Absolute and backslash paths are not supported.");
  }
  if (value === ".") {
    if (options.allowDot) {
      return value;
    }
    fail("RO_PATH_INVALID", "A file path must name a file.");
  }

  const segments = value.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    fail("RO_PATH_TRAVERSAL", "Path contains an unsupported segment.");
  }

  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized.startsWith("../") || normalized === "..") {
    fail("RO_PATH_TRAVERSAL", "Path escapes its approved root.");
  }
  return normalized;
}

/**
 * @param {string} root
 * @param {string} candidate
 * @returns {boolean}
 */
export function isContainedPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

/**
 * @param {string} absoluteRoot
 * @param {string} relativePath
 * @returns {Promise<void>}
 */
async function assertNoSymlinkComponents(absoluteRoot, relativePath) {
  if (relativePath === ".") {
    return;
  }

  let current = absoluteRoot;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        fail("RO_PATH_SYMLINK", "Symlinked paths are not allowed.");
      }
    } catch (error) {
      if (error instanceof ReviewOpsError) {
        throw error;
      }
      fail(
        "RO_PATH_UNAVAILABLE",
        "Declared path is unavailable; check the working directory and relative paths.",
      );
    }
  }
}

/**
 * @param {string} trustedRoot
 * @param {string} relativeRoot
 * @returns {Promise<ApprovedRoot>}
 */
async function resolveInputRoot(trustedRoot, relativeRoot) {
  const declared = normalizeDeclaredRelativePath(relativeRoot, { allowDot: true });
  const absolute = declared === "." ? trustedRoot : path.resolve(trustedRoot, declared);
  if (!isContainedPath(trustedRoot, absolute)) {
    fail("RO_ROOT_TRAVERSAL", "Input root escapes the trusted workspace.");
  }

  await assertNoSymlinkComponents(trustedRoot, declared);
  let canonical;
  try {
    canonical = await realpath(absolute);
    const stat = await lstat(absolute);
    if (!stat.isDirectory()) {
      fail("RO_ROOT_NOT_DIRECTORY", "Input root must be a directory.");
    }
  } catch (error) {
    if (error instanceof ReviewOpsError) {
      throw error;
    }
    fail("RO_ROOT_UNAVAILABLE", "Input root is unavailable.");
  }

  if (!isContainedPath(trustedRoot, canonical) || canonical !== absolute) {
    fail("RO_ROOT_SYMLINK", "Input root must be a direct workspace descendant.");
  }
  return { declared, absolute, canonical };
}

/**
 * Anchors all later reads to a host-supplied trusted workspace root. Config
 * data can narrow this root but cannot broaden it.
 *
 * @param {{
 *   trustedRoot: string,
 *   inputRoots?: readonly string[],
 *   limits?: unknown,
 *   budget?: ReturnType<typeof createReadBudget>
 * }} options
 * @returns {Promise<PathContext>}
 */
export async function createTrustedPathContext(options) {
  if (typeof options.trustedRoot !== "string" || options.trustedRoot.length === 0) {
    fail("RO_TRUSTED_ROOT_INVALID", "Trusted workspace root is required.");
  }

  let trustedRoot;
  try {
    trustedRoot = await realpath(options.trustedRoot);
    const stat = await lstat(trustedRoot);
    if (!stat.isDirectory()) {
      fail("RO_TRUSTED_ROOT_INVALID", "Trusted workspace root must be a directory.");
    }
  } catch (error) {
    if (error instanceof ReviewOpsError) {
      throw error;
    }
    fail("RO_TRUSTED_ROOT_UNAVAILABLE", "Trusted workspace root is unavailable.");
  }

  const limits = resolveLimits(options.limits ?? {});
  const declaredRoots = options.inputRoots ?? ["."];
  if (!Array.isArray(declaredRoots) || declaredRoots.length === 0) {
    fail("RO_ROOTS_INVALID", "At least one relative input root is required.");
  }

  /** @type {ApprovedRoot[]} */
  const roots = [];
  for (const declaredRoot of declaredRoots) {
    if (typeof declaredRoot !== "string") {
      fail("RO_ROOTS_INVALID", "Input roots must be relative strings.");
    }
    roots.push(await resolveInputRoot(trustedRoot, declaredRoot));
  }
  roots.sort((left, right) => left.declared.localeCompare(right.declared, "en"));

  return {
    trustedRoot,
    roots,
    limits,
    budget: options.budget ?? createReadBudget(limits),
  };
}

/**
 * @param {string} relativePath
 * @param {InputKind} kind
 */
function assertAllowedExtension(relativePath, kind) {
  const allowed = EXTENSIONS[kind];
  const extension = path.posix.extname(relativePath).toLowerCase();
  if (!allowed.includes(extension)) {
    fail("RO_EXTENSION_UNSUPPORTED", "Input has an unsupported extension.");
  }
}

/**
 * @param {import("node:fs").Stats} left
 * @param {import("node:fs").Stats} right
 * @returns {boolean}
 */
function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * @param {PathContext} context
 * @param {string} declaredPath
 * @param {{kind: InputKind}} options
 * @returns {Promise<{relativePath: string, absolutePath: string, preOpenStat: import("node:fs").Stats}>}
 */
export async function resolveApprovedFile(context, declaredPath, options) {
  const relativePath = normalizeDeclaredRelativePath(declaredPath);
  assertAllowedExtension(relativePath, options.kind);
  const absolutePath = path.resolve(context.trustedRoot, relativePath);
  if (!isContainedPath(context.trustedRoot, absolutePath)) {
    fail("RO_PATH_TRAVERSAL", "Path escapes the trusted workspace.");
  }

  const containingRoot = context.roots.find((root) =>
    isContainedPath(root.canonical, absolutePath),
  );
  if (containingRoot === undefined) {
    fail("RO_PATH_OUTSIDE_ROOTS", "Path is outside declared input roots.");
  }

  await assertNoSymlinkComponents(context.trustedRoot, relativePath);
  let preOpenStat;
  let canonical;
  try {
    preOpenStat = await lstat(absolutePath);
    canonical = await realpath(absolutePath);
  } catch {
    fail(
      "RO_PATH_UNAVAILABLE",
      "Declared path is unavailable; check the working directory and relative paths.",
    );
  }

  if (!preOpenStat.isFile() || preOpenStat.nlink !== 1) {
    fail("RO_PATH_NOT_REGULAR", "Only single-link regular files are allowed.");
  }
  if (
    canonical !== absolutePath ||
    !isContainedPath(containingRoot.canonical, canonical)
  ) {
    fail("RO_PATH_SYMLINK", "Symlinked paths are not allowed.");
  }
  if (preOpenStat.size > maxBytesForKind(options.kind, context.limits)) {
    fail("RO_FILE_TOO_LARGE", "Input exceeds the per-file byte limit.");
  }

  return { relativePath, absolutePath, preOpenStat };
}

/**
 * Reads one approved regular file without following links. The returned path
 * is relative and safe to pass through the redactor; absolute paths remain
 * internal.
 *
 * @param {PathContext} context
 * @param {string} declaredPath
 * @param {{kind: InputKind}} options
 * @returns {Promise<{relativePath: string, text: string, bytes: number, lines: number, kind: InputKind}>}
 */
export async function readApprovedFile(context, declaredPath, options) {
  const resolved = await resolveApprovedFile(context, declaredPath, options);
  context.budget.consume({ kind: options.kind, bytes: resolved.preOpenStat.size });

  /** @type {import("node:fs/promises").FileHandle | undefined} */
  let handle;
  try {
    const noFollow =
      typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = await open(resolved.absolutePath, constants.O_RDONLY | noFollow);
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile() ||
      openedStat.nlink !== 1 ||
      !sameIdentity(resolved.preOpenStat, openedStat) ||
      openedStat.size > maxBytesForKind(options.kind, context.limits)
    ) {
      fail("RO_PATH_RACE", "File changed while it was being opened.");
    }

    const bytes = await handle.readFile();
    const finalStat = await handle.stat();
    if (
      !sameIdentity(openedStat, finalStat) ||
      finalStat.size !== openedStat.size ||
      bytes.byteLength !== openedStat.size
    ) {
      fail("RO_PATH_RACE", "File changed while it was being read.");
    }

    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail("RO_TEXT_INVALID", "Input must decode as UTF-8 text.");
    }
    const shape = assertBoundedText(text, {
      kind: options.kind,
      limits: context.limits,
    });

    const canonicalAfter = await realpath(resolved.absolutePath);
    const afterStat = await lstat(resolved.absolutePath);
    if (
      canonicalAfter !== resolved.absolutePath ||
      !sameIdentity(finalStat, afterStat) ||
      afterStat.isSymbolicLink()
    ) {
      fail("RO_PATH_RACE", "File changed while it was being read.");
    }

    return {
      relativePath: resolved.relativePath,
      text,
      bytes: shape.bytes,
      lines: shape.lines,
      kind: options.kind,
    };
  } catch (error) {
    if (error instanceof ReviewOpsError) {
      throw error;
    }
    fail("RO_FILE_READ_FAILED", "Approved input could not be read.");
  } finally {
    await handle?.close();
  }

  fail("RO_FILE_READ_FAILED", "Approved input could not be read.");
}

/**
 * Convenience entrypoint for reading a config before its own input roots are
 * known. It still stays inside the trusted workspace and uses all file safety
 * checks.
 *
 * @param {{trustedRoot: string, configPath: string, limits?: unknown}} options
 * @returns {Promise<{relativePath: string, text: string, bytes: number, lines: number, kind: InputKind}>}
 */
export async function readTrustedConfigFile(options) {
  const context = await createTrustedPathContext({
    trustedRoot: options.trustedRoot,
    inputRoots: ["."],
    limits: options.limits,
  });
  return readApprovedFile(context, options.configPath, { kind: "config" });
}
