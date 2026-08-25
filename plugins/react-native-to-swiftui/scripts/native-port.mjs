#!/usr/bin/env node

/**
 * Deterministic, dependency-free guardrails for bounded React Native to SwiftUI
 * work. This helper inspects and verifies; it never generates or edits files.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import {
  basename,
  extname,
  isAbsolute,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import process from "node:process";

const COMMANDS = new Set(["plan", "authorize-write", "verify", "toolchain", "audit"]);
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);
const SIMPLE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const SWIFT_FILE = /\.swift$/;

class CliError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new CliError(code, message, details);
}

function usage() {
  return `native-port.mjs

Read-only guardrails for a bounded React Native/Expo to SwiftUI feature slice.
This helper does not transpile, generate, install, or edit files.

Commands:
  plan --source-root DIR --source-file RELATIVE_FILE [--source-file ...] --feature NAME [--format json|markdown]
  authorize-write --contract FILE --target-dir DIR --module NAME --slice NAME --write-file RELATIVE_FILE [--write-file ...] [--format json|markdown]
                  (aliases: --target-module NAME and --approved-slice NAME)
  verify --target-dir DIR --module NAME --slice NAME --domain-file RELATIVE_FILE --ui-file RELATIVE_FILE --test-file RELATIVE_FILE [--contract FILE] [--format json|markdown]
  toolchain [--xcodebuild PATH] [--format json|markdown]
  audit --target-dir DIR --module NAME --slice NAME [--contract FILE] [--format json|markdown]
`;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    return { command: "help", options: new Map() };
  }
  if (!COMMANDS.has(command)) {
    fail("UNKNOWN_COMMAND", `Unknown command: ${command}`, { supported: [...COMMANDS] });
  }

  const options = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--help" || argument === "-h") {
      addOption(options, "help", "true");
      continue;
    }
    if (!argument.startsWith("--")) {
      fail("UNEXPECTED_ARGUMENT", `Expected an option, received: ${argument}`);
    }
    const withoutPrefix = argument.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    let key;
    let value;
    if (equalsIndex >= 0) {
      key = withoutPrefix.slice(0, equalsIndex);
      value = withoutPrefix.slice(equalsIndex + 1);
    } else {
      key = withoutPrefix;
      if (key === "json" || key === "markdown") {
        value = "true";
      } else {
        const next = rest[index + 1];
        if (!next || next.startsWith("--")) {
          fail("MISSING_OPTION_VALUE", `Option --${key} requires a value`);
        }
        value = next;
        index += 1;
      }
    }
    if (!key || value === "") {
      fail("INVALID_OPTION", `Invalid option: ${argument}`);
    }
    addOption(options, key, value);
  }
  return { command, options };
}

function addOption(options, key, value) {
  const values = options.get(key) ?? [];
  values.push(value);
  options.set(key, values);
}

function assertKnownOptions(options, allowed) {
  for (const key of options.keys()) {
    if (!allowed.has(key)) {
      fail("UNKNOWN_OPTION", `Unknown option: --${key}`);
    }
  }
}

function one(options, key, { required = true } = {}) {
  const values = options.get(key) ?? [];
  if (values.length === 0) {
    if (required) fail("MISSING_REQUIRED_OPTION", `Required option --${key} was not provided`);
    return undefined;
  }
  if (values.length > 1) {
    fail("REPEATED_SINGLE_OPTION", `Option --${key} may only be provided once`);
  }
  return values[0];
}

function many(options, key, { required = true } = {}) {
  const values = options.get(key) ?? [];
  if (required && values.length === 0) {
    fail("MISSING_REQUIRED_OPTION", `Provide at least one --${key} option`);
  }
  return values;
}

function outputFormat(options) {
  const explicit = one(options, "format", { required: false });
  const json = options.has("json");
  const markdown = options.has("markdown");
  if (json && markdown) fail("INVALID_FORMAT", "Choose only one of --json or --markdown");
  const format = explicit ?? (markdown ? "markdown" : "json");
  if (!new Set(["json", "markdown"]).has(format)) {
    fail("INVALID_FORMAT", "--format must be json or markdown");
  }
  return format;
}

function slashPath(value) {
  return value.split(sep).join("/");
}

function compareCodePoint(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function assertDirectory(path, code = "DIRECTORY_NOT_FOUND") {
  if (!existsSync(path)) fail(code, `Directory does not exist: ${path}`);
  const info = lstatSync(path);
  if (info.isSymbolicLink()) fail("SYMLINK_REJECTED", `Symbolic links are not accepted: ${path}`);
  if (!info.isDirectory()) fail(code, `Expected a directory: ${path}`);
}

function assertNoSymlinkBelow(root, candidate, { allowMissingLeaf = false } = {}) {
  assertDirectory(root);
  if (!isInside(root, candidate)) {
    fail("PATH_OUT_OF_SCOPE", "Path escapes its declared root", { path: slashPath(relative(root, candidate)) });
  }
  const rel = relative(root, candidate);
  if (rel === "") return;
  let cursor = root;
  const segments = rel.split(sep);
  for (let index = 0; index < segments.length; index += 1) {
    cursor = resolve(cursor, segments[index]);
    if (!existsSync(cursor)) {
      if (allowMissingLeaf) return;
      fail("PATH_NOT_FOUND", `Declared path does not exist: ${slashPath(rel)}`);
    }
    if (lstatSync(cursor).isSymbolicLink()) {
      fail("SYMLINK_REJECTED", `Symbolic links are not accepted: ${slashPath(relative(root, cursor))}`);
    }
    if (index < segments.length - 1 && !lstatSync(cursor).isDirectory()) {
      fail("PATH_NOT_DIRECTORY", "A parent segment is not a directory", {
        path: slashPath(relative(root, cursor)),
      });
    }
  }
}

function validateRelativePath(raw, label) {
  if (!raw || isAbsolute(raw) || raw.includes("\0") || raw.includes("\\")) {
    fail("INVALID_RELATIVE_PATH", `${label} must be a relative POSIX-style path`, { path: raw });
  }
  const segments = raw.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("PATH_TRAVERSAL_REJECTED", `${label} must not contain empty, dot, or parent segments`, { path: raw });
  }
  const normalized = normalize(raw);
  if (normalized === "." || normalized.startsWith(`..${sep}`) || normalized === "..") {
    fail("PATH_TRAVERSAL_REJECTED", `${label} escapes its declared root`, { path: raw });
  }
  return slashPath(normalized);
}

function declaredSourceFile(root, raw) {
  const candidate = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  if (!isInside(root, candidate)) {
    fail("SOURCE_FILE_OUT_OF_SCOPE", "A declared source file is outside --source-root", { sourceFile: raw });
  }
  assertNoSymlinkBelow(root, candidate);
  const info = lstatSync(candidate);
  if (!info.isFile()) fail("SOURCE_FILE_NOT_FOUND", `Declared source file is not a file: ${raw}`);
  if (!SOURCE_EXTENSIONS.has(extname(candidate))) {
    fail("UNSUPPORTED_SOURCE_FILE", "Declared source files must be JavaScript or TypeScript source", { sourceFile: raw });
  }
  const rel = slashPath(relative(root, candidate));
  return { absolute: candidate, relative: rel, text: readFileSync(candidate, "utf8") };
}

function targetFile(root, raw, { mustExist = true } = {}) {
  let rel;
  try {
    rel = validateRelativePath(raw, "target file");
  } catch (error) {
    if (error instanceof CliError && (error.code === "PATH_TRAVERSAL_REJECTED" || error.code === "INVALID_RELATIVE_PATH")) {
      fail("PATH_OUTSIDE_TARGET", "PATH_TRAVERSAL_REJECTED: target file must stay inside the explicit target directory", { path: raw });
    }
    throw error;
  }
  const candidate = resolve(root, rel);
  if (!isInside(root, candidate)) fail("TARGET_FILE_OUT_OF_SCOPE", "Target file escapes --target-dir", { path: raw });
  assertNoSymlinkBelow(root, candidate, { allowMissingLeaf: !mustExist });
  if (mustExist) {
    if (!existsSync(candidate) || !lstatSync(candidate).isFile()) {
      fail("TARGET_FILE_NOT_FOUND", `Target file does not exist: ${rel}`);
    }
  }
  return { absolute: candidate, relative: rel };
}

function readJson(path, label) {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    fail("JSON_FILE_NOT_FOUND", `${label} does not exist: ${path}`);
  }
  if (lstatSync(absolute).isSymbolicLink()) {
    fail("SYMLINK_REJECTED", `${label} must not be a symbolic link`);
  }
  if (!lstatSync(absolute).isFile()) {
    fail("JSON_FILE_NOT_FOUND", `${label} does not exist: ${path}`);
  }
  try {
    return JSON.parse(readFileSync(absolute, "utf8"));
  } catch {
    fail("INVALID_JSON", `${label} is not valid JSON`);
  }
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function locallyDeclaredNames(text) {
  const source = stripComments(text);
  const names = new Set();
  const declaration = /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  let match;
  while ((match = declaration.exec(source)) !== null) names.add(match[1]);

  const defaultName = /\bexport\s+default\s+(?!function\b|class\b)([A-Za-z_$][\w$]*)\b/g;
  while ((match = defaultName.exec(source)) !== null) names.add(match[1]);
  return [...names].sort();
}

function uniqueMatches(text, pattern) {
  const values = new Set();
  let match;
  while ((match = pattern.exec(text)) !== null) values.add(match[1] ?? match[0]);
  return [...values].sort();
}

function sourceSignals(files) {
  const joined = files.map((file) => file.text).join("\n");
  const imports = uniqueMatches(joined, /from\s+["']([^"']+)["']/g).filter(
    (name) => name === "react-native" || name.startsWith("expo") || name.startsWith("@expo/"),
  );
  const interactions = [
    ["onPress", /\bonPress\s*=/],
    ["onChangeText", /\bonChangeText\s*=/],
    ["onSubmitEditing", /\bonSubmitEditing\s*=/],
    ["onValueChange", /\bonValueChange\s*=/],
  ].filter(([, pattern]) => pattern.test(joined)).map(([name]) => name);
  const stateSignals = [
    ["useState", /\buseState\s*\(/],
    ["useReducer", /\buseReducer\s*\(/],
    ["useEffect", /\buseEffect\s*\(/],
  ].filter(([, pattern]) => pattern.test(joined)).map(([name]) => name);
  const renderedPrimitives = ["View", "Text", "Pressable", "Button", "TextInput", "FlatList", "Image"]
    .filter((name) => new RegExp(`<${name}\\b`).test(joined));
  const accessibilityIdentifiers = uniqueMatches(joined, /\btestID\s*=\s*["']([^"']+)["']/g);
  return { imports, interactions, stateSignals, renderedPrimitives, accessibilityIdentifiers };
}

function digestFiles(files) {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => compareCodePoint(a.relative, b.relative))) {
    hash.update(file.relative);
    hash.update("\0");
    hash.update(file.text);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function plan(options) {
  assertKnownOptions(options, new Set(["source-root", "source-file", "feature", "format", "json", "markdown", "help"]));
  const format = outputFormat(options);
  const sourceRoot = resolve(one(options, "source-root"));
  assertDirectory(sourceRoot, "SOURCE_ROOT_NOT_FOUND");
  const feature = one(options, "feature");
  if (!SIMPLE_NAME.test(feature)) fail("INVALID_FEATURE", "--feature must be a simple exported feature name");
  const sourceFiles = many(options, "source-file").map((raw) => declaredSourceFile(sourceRoot, raw));
  const duplicates = sourceFiles.map((file) => file.relative).filter((value, index, all) => all.indexOf(value) !== index);
  if (duplicates.length > 0) fail("DUPLICATE_SOURCE_FILE", "Each --source-file must be declared once", { files: [...new Set(duplicates)] });

  const matches = sourceFiles
    .filter((file) => locallyDeclaredNames(file.text).includes(feature))
    .map((file) => file.relative)
    .sort();
  if (matches.length === 0) {
    fail("FEATURE_NOT_FOUND", `Feature ${feature} is not exported by the declared source files`, { feature });
  }
  if (matches.length > 1) {
    fail("AMBIGUOUS_SOURCE_SCOPE", `AMBIGUOUS_FEATURE_EXPORT: feature ${feature} is exported by more than one declared source file`, {
      feature,
      matchingFiles: matches,
    });
  }
  const matchedFile = sourceFiles.find((file) => file.relative === matches[0]);
  const signals = sourceSignals([matchedFile]);
  if (signals.imports.length === 0) {
    fail("SOURCE_NOT_REACT_NATIVE", "Declared source does not import React Native or Expo APIs");
  }

  const contract = {
    schemaVersion: 1,
    kind: "react-native-swiftui-parity-contract",
    status: "proposal",
    mode: "read-only",
    readOnly: true,
    writesPerformed: false,
    feature,
    selectedSourceFile: matches[0],
    source: {
      root: ".",
      files: sourceFiles.map((file) => file.relative).sort(),
      matchedExport: { name: feature, file: basename(matches[0]), relativeFile: matches[0] },
      sha256: digestFiles(sourceFiles),
      detectedFrameworkImports: signals.imports,
    },
    sourceEvidence: {
      detectedFrameworkImports: signals.imports,
      observedStateSignals: signals.stateSignals,
      observedInteractions: signals.interactions,
      observedPrimitives: signals.renderedPrimitives,
      accessibilityIdentifiers: signals.accessibilityIdentifiers,
    },
    behavioralParity: {
      observedStateSignals: signals.stateSignals,
      observedInteractions: signals.interactions,
      observedPrimitives: signals.renderedPrimitives,
      accessibilityIdentifiers: signals.accessibilityIdentifiers,
      requiredOutcomes: [
        "Preserve the declared feature's visible initial state.",
        "Preserve user-triggered state transitions and observable labels.",
        "Preserve declared accessibility identifiers or map them explicitly.",
      ],
      unresolved: [
        "Confirm the target Swift module and feature-slice boundary.",
        "Confirm backend, persistence, and navigation contracts before writing.",
        "Confirm licensing and parity expectations for every declared source file.",
      ],
    },
    approval: {
      status: "draft",
      required: true,
      targetModule: null,
      slice: feature,
      allowedWrites: [],
      replaceableFiles: [],
    },
    boundaries: {
      scope: "Only the explicitly declared source files were inspected.",
      implementation: "No SwiftUI files were generated or modified.",
      separation: "Keep pure Swift domain logic free of SwiftUI and UIKit imports.",
    },
  };
  emit(contract, format, markdownPlan);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonEmptyStringArray(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => isNonEmptyString(item))
  );
}

function approvedContract(path) {
  const contract = readJson(path, "Approved contract");
  const approval = contract.approval ?? {};
  const target = contract.target ?? {};
  if (contract.kind !== "react-native-swiftui-parity-contract") {
    fail("INVALID_CONTRACT", "Contract kind must be react-native-swiftui-parity-contract");
  }
  if (contract.status !== "approved" || approval.status !== "approved") {
    fail("CONTRACT_NOT_APPROVED", "Contract must be explicitly approved before write authorization");
  }
  if (!isNonEmptyString(contract.feature)) {
    fail("AMBIGUOUS_CONTRACT", "Approved contract must name one feature slice");
  }
  if (!isNonEmptyStringArray(contract.source?.files)) {
    fail("AMBIGUOUS_CONTRACT", "Approved contract must preserve an explicit source-file scope");
  }
  if (!isNonEmptyString(contract.backendContract)) {
    fail("AMBIGUOUS_CONTRACT", "Approved contract must state the backend contract");
  }
  if (!isNonEmptyString(contract.licensing)) {
    fail("AMBIGUOUS_CONTRACT", "Approved contract must state licensing and provenance");
  }
  if (!isNonEmptyStringArray(contract.parityExpectations)) {
    fail("AMBIGUOUS_CONTRACT", "Approved contract must list behavioral parity expectations");
  }
  if (
    isNonEmptyString(target.module) &&
    isNonEmptyString(approval.targetModule) &&
    target.module !== approval.targetModule
  ) {
    fail("AMBIGUOUS_TARGET", "Contract target.module conflicts with approval.targetModule");
  }
  if (
    isNonEmptyString(target.slice) &&
    isNonEmptyString(approval.slice) &&
    target.slice !== approval.slice
  ) {
    fail("AMBIGUOUS_TARGET", "Contract target.slice conflicts with approval.slice");
  }
  if (!isNonEmptyString(target.module ?? approval.targetModule)) {
    fail("AMBIGUOUS_TARGET", "Approved contract must name one target module");
  }
  if (!isNonEmptyString(target.slice ?? approval.slice)) {
    fail("AMBIGUOUS_TARGET", "Approved contract must name one approved slice");
  }
  const allowedWrites = approval.allowedWrites ?? contract.allowedWrites;
  if (!isNonEmptyStringArray(allowedWrites)) {
    fail("AMBIGUOUS_TARGET", "Approved contract must list relative allowed write paths");
  }
  return contract;
}

function contractTarget(contract) {
  const approval = contract.approval ?? {};
  const target = contract.target ?? {};
  return {
    module: target.module ?? approval.targetModule,
    slice: target.slice ?? approval.slice ?? contract.feature,
    allowedWrites: approval.allowedWrites ?? contract.allowedWrites ?? [],
    replaceableFiles: approval.replaceableFiles ?? contract.replaceableFiles ?? [],
    verification: contract.verification ?? {},
  };
}

function hasOwnedMarker(text, slice) {
  const escaped = slice.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`react-native-to-swiftui:\\s*(?:owned\\s+)?(?:domain\\s+|ui\\s+|ui-test\\s+)?slice=${escaped}\\b`).test(text);
}

function authorizeWrite(options) {
  assertKnownOptions(options, new Set(["contract", "target-dir", "module", "slice", "target-module", "approved-slice", "write-file", "format", "json", "markdown", "help"]));
  const format = outputFormat(options);
  const contract = approvedContract(one(options, "contract"));
  const targetDir = resolve(one(options, "target-dir"));
  assertDirectory(targetDir, "TARGET_DIRECTORY_NOT_FOUND");
  const module = aliasedOne(options, "module", "target-module");
  const slice = aliasedOne(options, "slice", "approved-slice");
  if (!SIMPLE_NAME.test(module) || !SIMPLE_NAME.test(slice)) {
    fail("INVALID_TARGET", "--module and --slice must be simple names");
  }
  const declaredTarget = contractTarget(contract);
  if (!declaredTarget.module || declaredTarget.module !== module || declaredTarget.slice !== slice) {
    fail("TARGET_MISMATCH", "Explicit module and slice do not match the approved contract", {
      approvedModule: declaredTarget.module ?? null,
      approvedSlice: declaredTarget.slice ?? null,
    });
  }
  if (!Array.isArray(declaredTarget.allowedWrites) || declaredTarget.allowedWrites.length === 0) {
    fail("NO_APPROVED_WRITES", "Approved contract does not declare allowed write paths");
  }
  const allowed = new Set(declaredTarget.allowedWrites.map((path) => validateRelativePath(path, "contract allowed write")));
  const replaceable = new Set((declaredTarget.replaceableFiles ?? []).map((path) => validateRelativePath(path, "contract replaceable file")));
  const writes = many(options, "write-file").map((raw) => targetFile(targetDir, raw, { mustExist: false }));
  const duplicateWrites = writes.map((file) => file.relative).filter((value, index, all) => all.indexOf(value) !== index);
  if (duplicateWrites.length > 0) fail("DUPLICATE_WRITE_FILE", "Each --write-file must be declared once", { files: [...new Set(duplicateWrites)] });

  for (const file of writes) {
    if (!allowed.has(file.relative)) {
      fail("WRITE_NOT_APPROVED", "Requested write is not listed in the approved contract", { path: file.relative });
    }
    if (existsSync(file.absolute)) {
      const info = lstatSync(file.absolute);
      if (!info.isFile()) fail("EXISTING_UNRELATED_FILE", "Requested write path already exists and is not a file", { path: file.relative });
      const owned = hasOwnedMarker(readFileSync(file.absolute, "utf8"), slice);
      if (!replaceable.has(file.relative) && !owned) {
        fail("EXISTING_UNRELATED_FILE", "Refusing to authorize overwrite of an unrelated existing file", { path: file.relative });
      }
    }
  }

  const result = {
    ok: true,
    command: "authorize-write",
    authorized: true,
    writesPerformed: false,
    target: { module, slice },
    files: writes.map((file) => file.relative).sort(),
    constraints: [
      "Only the listed relative files are authorized.",
      "Existing unowned files remain protected.",
      "This command performed no writes.",
    ],
  };
  emit(result, format, markdownAuthorization);
}

function aliasedOne(options, preferred, alias) {
  const direct = one(options, preferred, { required: false });
  const alternate = one(options, alias, { required: false });
  if (direct && alternate && direct !== alternate) {
    fail("CONFLICTING_OPTIONS", `--${preferred} and --${alias} must agree when both are supplied`);
  }
  const value = direct ?? alternate;
  if (!value) fail("MISSING_REQUIRED_OPTION", `Required option --${preferred} was not provided`);
  return value;
}

function verificationFiles(options, contract) {
  const target = contract ? contractTarget(contract) : { verification: {} };
  const verification = target.verification ?? {};
  return {
    domain: many(options, "domain-file", { required: false }).length > 0
      ? many(options, "domain-file", { required: false })
      : (verification.domainFiles ?? []),
    ui: many(options, "ui-file", { required: false }).length > 0
      ? many(options, "ui-file", { required: false })
      : (verification.uiFiles ?? []),
    test: many(options, "test-file", { required: false }).length > 0
      ? many(options, "test-file", { required: false })
      : (verification.testFiles ?? []),
  };
}

function check(id, ok, detail) {
  return { id, ok, detail };
}

function verify(options) {
  assertKnownOptions(options, new Set(["contract", "target-dir", "module", "slice", "domain-file", "ui-file", "test-file", "format", "json", "markdown", "help"]));
  const format = outputFormat(options);
  const targetDir = resolve(one(options, "target-dir"));
  assertDirectory(targetDir, "TARGET_DIRECTORY_NOT_FOUND");
  const contract = approvedContract(one(options, "contract"));
  const declaredTarget = contractTarget(contract);
  const module = one(options, "module", { required: false }) ?? declaredTarget.module;
  const slice = one(options, "slice", { required: false }) ?? declaredTarget.slice;
  if (!module || !slice) fail("MISSING_REQUIRED_OPTION", "Verification requires --module and --slice, directly or through --contract");
  if (!SIMPLE_NAME.test(module) || !SIMPLE_NAME.test(slice)) fail("INVALID_TARGET", "Module and slice must be simple names");
  if (declaredTarget.module !== module || declaredTarget.slice !== slice) {
    fail("TARGET_MISMATCH", "Verification target does not match the approved contract");
  }
  const requested = verificationFiles(options, contract);
  if (requested.domain.length === 0 || requested.ui.length === 0 || requested.test.length === 0) {
    fail("MISSING_VERIFICATION_FILES", "Verification needs at least one domain, UI, and UI-test file");
  }
  const domainFiles = requested.domain.map((raw) => targetFile(targetDir, raw));
  const uiFiles = requested.ui.map((raw) => targetFile(targetDir, raw));
  const testFiles = requested.test.map((raw) => targetFile(targetDir, raw));
  const checks = [];
  const uiIds = new Set();

  for (const file of domainFiles) {
    if (!SWIFT_FILE.test(file.relative)) fail("INVALID_VERIFICATION_FILE", "Domain verification files must be Swift files", { path: file.relative });
    const text = readFileSync(file.absolute, "utf8");
    checks.push(check(`domain-marker:${file.relative}`, hasOwnedMarker(text, slice), "Pure domain file carries the slice ownership marker."));
    const clean = !/\bimport\s+(?:SwiftUI|UIKit)\b|\b(?:SwiftUI|UIKit)\.|\bUIView(?:Controller)?\b|\bUIColor\b/.test(text);
    checks.push(check(`domain-pure-swift:${file.relative}`, clean, "Pure domain file has no SwiftUI or UIKit dependency."));
  }
  for (const file of uiFiles) {
    if (!SWIFT_FILE.test(file.relative)) fail("INVALID_VERIFICATION_FILE", "UI verification files must be Swift files", { path: file.relative });
    const text = readFileSync(file.absolute, "utf8");
    checks.push(check(`ui-marker:${file.relative}`, hasOwnedMarker(text, slice), "SwiftUI file carries the slice ownership marker."));
    checks.push(check(`ui-swiftui:${file.relative}`, /\bimport\s+SwiftUI\b/.test(text), "UI file imports SwiftUI."));
    const ids = uniqueMatches(text, /\.accessibilityIdentifier\s*\(\s*"([^"]+)"\s*\)/g);
    for (const id of ids) uiIds.add(id);
    checks.push(check(`ui-accessibility:${file.relative}`, ids.length > 0, "UI file declares at least one accessibility identifier."));
  }
  const testTexts = [];
  for (const file of testFiles) {
    if (!SWIFT_FILE.test(file.relative)) fail("INVALID_VERIFICATION_FILE", "UI-test verification files must be Swift files", { path: file.relative });
    const text = readFileSync(file.absolute, "utf8");
    testTexts.push(text);
    checks.push(check(`test-marker:${file.relative}`, hasOwnedMarker(text, slice), "UI-test file carries the slice ownership marker."));
    checks.push(check(`test-xctest:${file.relative}`, /\bimport\s+XCTest\b/.test(text) && /\bXCUIApplication\b/.test(text), "UI-test file uses XCTest and XCUIApplication."));
  }
  const allTests = testTexts.join("\n");
  const sharedIds = [...uiIds].filter((id) => allTests.includes(`"${id}"`)).sort();
  checks.push(check("accessibility-id-parity", sharedIds.length > 0, "At least one SwiftUI accessibility identifier is exercised by UI tests."));
  const failed = checks.filter((entry) => !entry.ok);
  const result = {
    ok: failed.length === 0,
    status: failed.length === 0 ? "structural-checks-passed" : "failed",
    structuralOnly: true,
    deterministicChecks: true,
    behavioralParityProven: false,
    command: "verify",
    target: { module, slice },
    checkedFiles: {
      domain: domainFiles.map((file) => file.relative).sort(),
      ui: uiFiles.map((file) => file.relative).sort(),
      test: testFiles.map((file) => file.relative).sort(),
    },
    accessibilityIdentifiers: sharedIds,
    checks: checks.map((entry) => `${entry.ok ? "PASS" : "FAIL"} ${entry.id}: ${entry.detail}`),
    checkDetails: checks,
    failureCode: failed.length === 0 ? null : "PARITY_VERIFICATION_FAILED",
  };
  emit(result, format, markdownVerification);
  if (!result.ok) process.exitCode = 1;
}

function runProbe(command, args) {
  return spawnSync(command, args, { encoding: "utf8", timeout: 10000 });
}

function toolchain(options) {
  assertKnownOptions(options, new Set(["xcodebuild", "format", "json", "markdown", "help"]));
  const format = outputFormat(options);
  const xcodebuildCommand = one(options, "xcodebuild", { required: false }) ?? "xcodebuild";
  let result;
  if (process.platform !== "darwin") {
    result = unavailableToolchain("Xcode and Simulator verification are available only on macOS hosts.");
  } else {
    const xcodebuild = runProbe(xcodebuildCommand, ["-version"]);
    if (xcodebuild.error || xcodebuild.status !== 0) {
      result = unavailableToolchain("xcodebuild could not be inspected or is not ready.");
    } else {
      const simctl = runProbe("xcrun", ["simctl", "list", "devices", "available"]);
      const simulatorLines = (simctl.stdout ?? "")
        .split(/\r?\n/)
        .filter((line) => /\biPhone\b/.test(line) && /\((?:Booted|Shutdown)\)/.test(line));
      if (simctl.error || simctl.status !== 0 || simulatorLines.length === 0) {
        result = unavailableToolchain("No available iPhone Simulator destination could be inspected.");
      } else {
        result = {
          ok: true,
          command: "toolchain",
          available: true,
          probeSucceeded: true,
          platformGateRunnable: false,
          xcodebuildVersion: xcodebuild.stdout.trim().split("\n")[0] ?? "available",
          simulatorInspection: {
            availableIPhoneDestinations: simulatorLines.length,
            selection: "Choose an explicit project-owned destination before running XCUITest.",
          },
          installAttempted: false,
          nextGate: "Run project-owned xcodebuild and XCUITest commands only after the target, scheme, and destination are explicit.",
        };
      }
    }
  }
  if (!result.ok) {
    if (format === "markdown") console.error(markdownToolchain(result));
    else console.error(JSON.stringify(result, null, 2));
    process.exitCode = 2;
    return;
  }
  emit(result, format, markdownToolchain);
}

function unavailableToolchain(message) {
  return {
    ok: false,
    command: "toolchain",
    available: false,
    error: { code: "XCODE_TOOLCHAIN_UNAVAILABLE", message },
    installAttempted: false,
    nextGate: "This helper will not install Xcode, Simulator runtimes, or licenses; configure them outside the plugin, then rerun the check.",
  };
}

function walkFiles(root, limit = 500) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => compareCodePoint(a.name, b.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) fail("SYMLINK_REJECTED", "Audit refuses symbolic links", { path: slashPath(relative(root, path)) });
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      if (files.length > limit) fail("AUDIT_SCOPE_TOO_LARGE", "Audit target exceeds the deterministic file limit", { limit });
    }
  }
  visit(root);
  return files;
}

function audit(options) {
  assertKnownOptions(options, new Set(["contract", "target-dir", "module", "slice", "format", "json", "markdown", "help"]));
  const format = outputFormat(options);
  const targetDir = resolve(one(options, "target-dir"));
  assertDirectory(targetDir, "TARGET_DIRECTORY_NOT_FOUND");
  const contract = approvedContract(one(options, "contract"));
  const declaredTarget = contractTarget(contract);
  const module = one(options, "module", { required: false }) ?? declaredTarget.module;
  const slice = one(options, "slice", { required: false }) ?? declaredTarget.slice;
  if (!module || !slice) fail("MISSING_REQUIRED_OPTION", "Audit requires --module and --slice, directly or through --contract");
  if (!SIMPLE_NAME.test(module) || !SIMPLE_NAME.test(slice)) fail("INVALID_TARGET", "Module and slice must be simple names");
  if (declaredTarget.module !== module || declaredTarget.slice !== slice) {
    fail("TARGET_MISMATCH", "Audit target does not match the approved contract");
  }
  const files = walkFiles(targetDir);
  const relativeFiles = files.map((file) => slashPath(relative(targetDir, file))).sort();
  const swiftFiles = files.filter((file) => file.endsWith(".swift"));
  const swiftText = swiftFiles.map((file) => readFileSync(file, "utf8")).join("\n");
  const findings = [];
  if (!relativeFiles.some((file) => file.endsWith("PrivacyInfo.xcprivacy"))) {
    findings.push({ severity: "warning", code: "PRIVACY_MANIFEST_NOT_FOUND", message: "No privacy manifest was found in the declared target directory." });
  }
  if (!relativeFiles.some((file) => file.includes("AppIcon.appiconset"))) {
    findings.push({ severity: "warning", code: "APP_ICON_NOT_FOUND", message: "No app icon set was found in the declared target directory." });
  }
  if (/\bTODO\b|\bFIXME\b/.test(swiftText)) {
    findings.push({ severity: "warning", code: "PLACEHOLDER_MARKER_FOUND", message: "Swift source still contains TODO or FIXME markers." });
  }
  if (!hasOwnedMarker(swiftText, slice)) {
    findings.push({ severity: "warning", code: "SLICE_MARKER_NOT_FOUND", message: "No owned slice marker was found in Swift source." });
  }
  const result = {
    ok: true,
    status: "preflight-requires-human-review",
    command: "audit",
    target: { module, slice },
    preflightOnly: true,
    guaranteedApproval: false,
    inspectedFileCount: relativeFiles.length,
    checks: [
      { id: "bounded-target", ok: true, detail: "Only the explicit target directory was inspected." },
      { id: "no-store-claim", ok: true, detail: "This is a static readiness preflight, not an App Store approval prediction." },
    ],
    findings,
    limitations: [
      "Review signing, entitlements, privacy declarations, screenshots, and metadata in the real app project.",
      "Run project-owned builds and UI tests on an available Apple toolchain.",
      "App Review outcomes remain Apple-controlled and cannot be guaranteed by this preflight.",
    ],
  };
  emit(result, format, markdownAudit);
}

function emit(result, format, markdownRenderer) {
  if (format === "markdown") console.log(markdownRenderer(result));
  else console.log(JSON.stringify(result, null, 2));
}

function markdownPlan(result) {
  return `# Draft SwiftUI parity contract\n\n- Feature: ${result.feature}\n- Declared files: ${result.source.files.join(", ")}\n- Read-only: yes\n- Writes performed: no\n- Detected interactions: ${result.behavioralParity.observedInteractions.join(", ") || "none"}\n- Accessibility IDs: ${result.behavioralParity.accessibilityIdentifiers.join(", ") || "none"}\n\nApproval is required before any target write.\n`;
}

function markdownAuthorization(result) {
  return `# Write authorization\n\n- Authorized: ${result.authorized ? "yes" : "no"}\n- Module: ${result.target.module}\n- Slice: ${result.target.slice}\n- Files: ${result.files.join(", ")}\n- Writes performed: no\n`;
}

function markdownVerification(result) {
  const lines = result.checks.map((entry) => `- [${entry.ok ? "x" : " "}] ${entry.id}: ${entry.detail}`);
  return `# SwiftUI parity verification\n\n- Result: ${result.ok ? "pass" : "fail"}\n- Module: ${result.target.module}\n- Slice: ${result.target.slice}\n\n${lines.join("\n")}\n`;
}

function markdownToolchain(result) {
  if (!result.ok) return `# Apple toolchain\n\n- Result: unavailable\n- Code: ${result.error.code}\n- Install attempted: no\n- Detail: ${result.error.message}\n`;
  return `# Apple toolchain\n\n- Result: available\n- ${result.xcodebuildVersion}\n- Install attempted: no\n`;
}

function markdownAudit(result) {
  const findings = result.findings.length === 0
    ? "- No static warnings found."
    : result.findings.map((entry) => `- ${entry.severity}: ${entry.code} — ${entry.message}`).join("\n");
  return `# iOS readiness preflight\n\n- Preflight only: yes\n- Guaranteed approval: no\n- Module: ${result.target.module}\n- Slice: ${result.target.slice}\n\n${findings}\n`;
}

function emitError(error, format = "json") {
  const result = {
    ok: false,
    error: {
      code: error.code ?? "UNEXPECTED_ERROR",
      message: error.message,
      ...(error.details && Object.keys(error.details).length > 0 ? { details: error.details } : {}),
    },
  };
  if (format === "markdown") {
    console.error(`# Error\n\n- Code: ${result.error.code}\n- Detail: ${result.error.message}\n`);
  } else {
    console.error(JSON.stringify(result, null, 2));
  }
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
    if (parsed.command === "help" || parsed.options.has("help")) {
      console.log(usage());
      return;
    }
    if (parsed.command === "plan") plan(parsed.options);
    else if (parsed.command === "authorize-write") authorizeWrite(parsed.options);
    else if (parsed.command === "verify") verify(parsed.options);
    else if (parsed.command === "toolchain") toolchain(parsed.options);
    else if (parsed.command === "audit") audit(parsed.options);
  } catch (error) {
    let format = "json";
    try {
      if (parsed?.options) format = outputFormat(parsed.options);
    } catch {
      format = "json";
    }
    emitError(error, format);
    process.exitCode = 1;
  }
}

main();
