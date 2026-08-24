import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertBoundedText,
  assertJsonDepth,
  assertRecordCount,
  assertStdoutBytes,
  createReadBudget,
  HARD_LIMITS,
  resolveLimits,
} from "../../plugins/reviewops-auditor-benchmark/src/bounds.mjs";
import {
  auditLoadedInputs,
  auditPrompt,
  auditWorkflow,
} from "../../plugins/reviewops-auditor-benchmark/src/audit/index.mjs";
import { auditTelemetryEvidence } from "../../plugins/reviewops-auditor-benchmark/src/audit/telemetry.mjs";
import { publicError } from "../../plugins/reviewops-auditor-benchmark/src/errors.mjs";
import {
  createTrustedPathContext,
  isContainedPath,
  normalizeDeclaredRelativePath,
  readApprovedFile,
  readTrustedConfigFile,
} from "../../plugins/reviewops-auditor-benchmark/src/paths.mjs";
import {
  escapeUntrustedText,
  redactJsonValue,
  redactRelativePath,
  redactText,
  redactedTextShape,
  stripUnsafeControls,
} from "../../plugins/reviewops-auditor-benchmark/src/redact.mjs";
import {
  lineForYamlPath,
  parseSafeYaml,
  parseWorkflowYaml,
} from "../../plugins/reviewops-auditor-benchmark/src/yaml.mjs";
import {
  parseJsonLines,
  parseJsonText,
} from "../../plugins/reviewops-auditor-benchmark/src/schema.mjs";
import {
  isNonEmptyString,
  iterateLines,
  jsonDepth,
  lineAtOffset,
  lineCount,
  sortedUniqueStrings,
  stableJson,
} from "../../plugins/reviewops-auditor-benchmark/src/utils.mjs";

const PINNED_SHA = "0123456789012345678901234567890123456789";
const SAFE_WORKFLOW = `name: review
on:
  pull_request:
    paths:
      - src/**
permissions:
  contents: read
concurrency:
  group: review
  cancel-in-progress: true
jobs:
  review:
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@${PINNED_SHA}
        with:
          fetch-depth: 1
`;
const SAFE_PROMPT =
  "Limit context to 10 files and at most 5 comments. Require evidence with file path and line number. State uncertainty when unknown. Verify before publishing. Deduplicate duplicate findings.";

function tempWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewops-units-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function hasCode(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

test("bounds enforce hard ceilings, line safety, and per-run budgets", () => {
  const limits = resolveLimits({
    maxFiles: 2,
    maxBytesPerFile: 8,
    maxTotalBytes: 10,
    maxRecords: 2,
  });
  assert.equal(limits.maxFiles, 2);
  assert.throws(
    () => resolveLimits({ maxFiles: HARD_LIMITS.maxFiles + 1 }),
    hasCode("RO_LIMIT_EXCEEDS_CEILING"),
  );
  assert.throws(
    () => resolveLimits({ unexpected: 1 }),
    hasCode("RO_LIMITS_UNKNOWN_FIELD"),
  );
  assert.throws(
    () => assertBoundedText("a\0b", { kind: "prompt", limits }),
    hasCode("RO_TEXT_NUL"),
  );

  const budget = createReadBudget(limits);
  budget.consume({ kind: "config", bytes: 4 });
  budget.consume({ kind: "config", bytes: 6 });
  assert.equal(budget.files, 2);
  assert.equal(budget.totalBytes, 10);
  assert.throws(
    () => budget.consume({ kind: "config", bytes: 1 }),
    hasCode("RO_FILE_LIMIT"),
  );
});

test("paths stay under trusted declared roots and read only regular UTF-8 files", async (t) => {
  const root = tempWorkspace(t);
  fs.mkdirSync(path.join(root, "inputs"));
  fs.writeFileSync(path.join(root, "inputs", "prompt.md"), "safe prompt");
  fs.writeFileSync(path.join(root, "outside.md"), "outside");
  const context = await createTrustedPathContext({
    trustedRoot: root,
    inputRoots: ["inputs"],
  });

  const file = await readApprovedFile(context, "inputs/prompt.md", {
    kind: "prompt",
  });
  assert.equal(file.relativePath, "inputs/prompt.md");
  assert.equal(file.text, "safe prompt");
  await assert.rejects(
    readApprovedFile(context, "outside.md", { kind: "prompt" }),
    hasCode("RO_PATH_OUTSIDE_ROOTS"),
  );
  await assert.rejects(
    readApprovedFile(context, "inputs/prompt.md", { kind: "config" }),
    hasCode("RO_EXTENSION_UNSUPPORTED"),
  );
  assert.throws(
    () => normalizeDeclaredRelativePath("../secret.md"),
    hasCode("RO_PATH_TRAVERSAL"),
  );
  assert.throws(
    () => normalizeDeclaredRelativePath("/tmp/secret.md"),
    hasCode("RO_PATH_ABSOLUTE"),
  );
  assert.throws(
    () => normalizeDeclaredRelativePath("..\\secret.md"),
    hasCode("RO_PATH_ABSOLUTE"),
  );
});

test("paths reject symlinks, hard links, malformed UTF-8, and oversize input", async (t) => {
  const root = tempWorkspace(t);
  fs.mkdirSync(path.join(root, "inputs"));
  fs.writeFileSync(path.join(root, "outside.md"), "secret");
  fs.writeFileSync(path.join(root, "inputs", "good.md"), "ok");
  fs.writeFileSync(
    path.join(root, "inputs", "bad.md"),
    Buffer.from([0xc3, 0x28]),
  );
  fs.writeFileSync(path.join(root, "inputs", "large.md"), "12345");
  fs.linkSync(
    path.join(root, "inputs", "good.md"),
    path.join(root, "inputs", "hard.md"),
  );
  fs.symlinkSync(
    path.join(root, "outside.md"),
    path.join(root, "inputs", "link.md"),
  );

  const context = await createTrustedPathContext({
    trustedRoot: root,
    inputRoots: ["inputs"],
    limits: { maxBytesPerFile: 4 },
  });
  await assert.rejects(
    readApprovedFile(context, "inputs/link.md", { kind: "prompt" }),
    hasCode("RO_PATH_SYMLINK"),
  );
  await assert.rejects(
    readApprovedFile(context, "inputs/hard.md", { kind: "prompt" }),
    hasCode("RO_PATH_NOT_REGULAR"),
  );
  await assert.rejects(
    readApprovedFile(context, "inputs/bad.md", { kind: "prompt" }),
    hasCode("RO_TEXT_INVALID"),
  );
  await assert.rejects(
    readApprovedFile(context, "inputs/large.md", { kind: "prompt" }),
    hasCode("RO_FILE_TOO_LARGE"),
  );
});

test("YAML parsing is YAML 1.2, line-attributed, and fails closed on ambiguity", () => {
  const parsed = parseWorkflowYaml(SAFE_WORKFLOW);
  assert.equal(parsed.value.on.pull_request.paths[0], "src/**");
  assert.equal(
    lineForYamlPath(parsed, ["jobs", "review", "timeout-minutes"]),
    13,
  );

  for (const source of [
    "a: 1\na: 2\n",
    "a: &anchor value\nb: *anchor\n",
    "a: !custom value\n",
    "base: &base\n  x: 1\ncopy:\n  <<: *base\n",
  ]) {
    assert.throws(
      () => parseWorkflowYaml(source),
      (error) => {
        assert.match(error.code, /^RO_YAML_/u);
        return true;
      },
    );
  }
});

test("redaction is deterministic and output escaping neutralizes hostile rendering", () => {
  const token = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
  const raw = `Authorization: Bearer ${token}
https://private.example.com/hook?q=secret user@example.com /Users/alice/private
\u001b[31m# fake heading\u001b[0m \u202e| [link](https://example.invalid)`;
  const first = redactText(raw);
  const second = redactText(raw);
  assert.deepEqual(first, second);
  assert.doesNotMatch(first.text, new RegExp(token, "u"));
  assert.doesNotMatch(
    first.text,
    /example\.com|example\.invalid|user@example|\/Users\/alice/u,
  );

  const escaped = escapeUntrustedText(raw);
  assert.doesNotMatch(escaped.text, /\u001b|\u202e/u);
  assert.doesNotMatch(escaped.text, /(^|\s)#\s/u);
  assert.doesNotMatch(escaped.text, /\]\(/u);
  assert.match(escaped.text, /\\\|/u);

  const json = redactJsonValue({ token, "user@example.com": "value" });
  assert.equal(json.value.token, "[REDACTED]");
  assert.equal(Object.hasOwn(json.value, "[REDACTED]"), true);
  assert.equal(redactRelativePath("/Users/alice/secret.md").text, "[REDACTED]");
});

test("workflow audit separates safe structure from concrete static risks", () => {
  const safe = auditWorkflow({
    relativePath: ".github/workflows/review.yml",
    text: SAFE_WORKFLOW,
  });
  assert.deepEqual(safe.findings, []);

  const unsafe = auditWorkflow({
    relativePath: ".github/workflows/review.yml",
    text: `on:
  pull_request_target:
  pull_request:
  push:
permissions: write-all
jobs:
  review:
    steps:
      - uses: actions/checkout@v4
      - run: echo "\${{ github.event.pull_request.title }}" && gh pr comment
`,
  });
  const ids = unsafe.findings.map((finding) => finding.ruleId);
  for (const id of [
    "RO-WF-001",
    "RO-WF-002",
    "RO-WF-003",
    "RO-WF-004",
    "RO-WF-005",
    "RO-WF-006",
    "RO-WF-007",
    "RO-WF-008",
    "RO-WF-009",
  ]) {
    assert.ok(ids.includes(id), id);
  }
  assert.ok(
    unsafe.findings.every((finding) =>
      ["OBSERVED", "INFERRED", "UNKNOWN"].includes(finding.evidenceStatus),
    ),
  );
});

test("prompt audit is structural and composition is deterministic without leaking input", () => {
  assert.deepEqual(
    auditPrompt({ relativePath: "prompts/reviewer.md", text: SAFE_PROMPT })
      .findings,
    [],
  );
  const weak = auditPrompt({
    relativePath: "prompts/reviewer.md",
    text: "Review thoroughly.",
  });
  assert.deepEqual(
    weak.findings.map((finding) => finding.ruleId),
    ["RO-PR-001", "RO-PR-002", "RO-PR-003", "RO-PR-004"],
  );

  const token = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
  const inputs = {
    workflows: [
      { relativePath: ".github/workflows/review.yml", text: SAFE_WORKFLOW },
    ],
    prompts: [
      {
        relativePath: "prompts/reviewer.md",
        text: `${SAFE_PROMPT}
Authorization: Bearer ${token}`,
      },
    ],
  };
  const first = auditLoadedInputs(inputs);
  const second = auditLoadedInputs(inputs);
  assert.deepEqual(first, second);
  assert.equal(first.status, "COMPLETE");
  assert.equal(first.inputDigests.length, 2);
  assert.ok(first.redactionCount > 0);
  assert.doesNotMatch(JSON.stringify(first), new RegExp(token, "u"));

  const empty = auditLoadedInputs({});
  assert.equal(empty.status, "PARTIAL");
  assert.equal(empty.warnings.length, 2);
});

test("stable errors and JSON helpers reject unsafe values without reflecting them", () => {
  assert.deepEqual(publicError(new Error("secret path")), {
    code: "RO_INTERNAL_ERROR",
    message: "Internal analysis failure.",
    status: "ERROR",
  });
  assert.equal(stableJson({ z: 1, a: 2 }), '{"a":2,"z":1}');
  assert.throws(
    () => stableJson({ value: Number.NaN }),
    hasCode("RO_NON_FINITE_NUMBER"),
  );
  assert.throws(
    () =>
      assertJsonDepth(
        { a: { b: { c: true } } },
        resolveLimits({ maxJsonDepth: 1 }),
      ),
    hasCode("RO_JSON_TOO_DEEP"),
  );
  assert.throws(
    () => assertRecordCount(3, resolveLimits({ maxRecords: 2 })),
    hasCode("RO_RECORD_LIMIT"),
  );
});

test("telemetry audit distinguishes missing, valid, and unsafe contracts", () => {
  const missing = auditTelemetryEvidence();
  assert.deepEqual(
    missing.findings.map((finding) => finding.ruleId),
    ["RO-TL-001", "RO-TL-002", "RO-TL-003"],
  );

  const validContract = {
    capabilities: ["READ"],
    commandPolicy: "NO_COMMANDS",
    timeoutMs: 100,
    verificationCheckIds: ["check-a"],
  };
  const validResult = {
    runId: "run-a",
    findingId: "finding-a",
    checkId: "check-a",
    status: "PASS",
    durationMs: 50,
  };
  assert.deepEqual(
    auditTelemetryEvidence({
      toolContracts: [validContract],
      validatorResults: [validResult],
    }).findings,
    [],
  );

  const unsafe = auditTelemetryEvidence({
    toolContracts: [
      {
        capabilities: ["WRITE"],
        commandPolicy: "ALLOW_COMMANDS",
        timeoutMs: 100,
        verificationCheckIds: [],
      },
    ],
    validatorResults: [
      { ...validResult, checkId: "undeclared", durationMs: 101 },
    ],
  });
  assert.deepEqual(
    unsafe.findings.map((finding) => finding.ruleId),
    ["RO-TL-001", "RO-TL-002"],
  );
});

test("telemetry audit flags untied and contradictory validator evidence", () => {
  const contract = {
    capabilities: ["READ"],
    commandPolicy: "NO_COMMANDS",
    timeoutMs: 100,
    verificationCheckIds: ["check-a"],
  };
  const base = {
    runId: "run-a",
    findingId: "finding-a",
    checkId: "check-a",
    status: "PASS",
    durationMs: 50,
  };
  const untied = auditTelemetryEvidence({
    toolContracts: [contract],
    validatorResults: [{ ...base, findingId: "" }],
  });
  assert.deepEqual(
    untied.findings.map((finding) => finding.ruleId),
    ["RO-TL-003"],
  );

  const contradictory = auditTelemetryEvidence({
    toolContracts: [contract],
    validatorResults: [base, { ...base, status: "FAIL" }],
  });
  assert.deepEqual(
    contradictory.findings.map((finding) => finding.ruleId),
    ["RO-TL-003"],
  );

  const token = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
  const generic = auditTelemetryEvidence({
    telemetry: [
      {
        relativePath: "telemetry/runs.jsonl",
        text: "Authorization: Bearer " + token,
      },
    ],
  });
  assert.equal(generic.warnings.length, 1);
  assert.ok(generic.redactionCount > 0);
  assert.doesNotMatch(JSON.stringify(generic), new RegExp(token, "u"));
});

test("telemetry timeout uses only contracts declaring the check", () => {
  const contract = {
    capabilities: ["READ"],
    commandPolicy: "NO_COMMANDS",
  };
  const report = auditTelemetryEvidence({
    toolContracts: [
      { ...contract, timeoutMs: 100, verificationCheckIds: ["check-a"] },
      { ...contract, timeoutMs: 10_000, verificationCheckIds: ["check-b"] },
    ],
    validatorResults: [
      {
        runId: "run-a",
        findingId: "finding-a",
        checkId: "check-a",
        status: "PASS",
        durationMs: 500,
      },
    ],
  });

  assert.deepEqual(
    report.findings.map((finding) => finding.ruleId),
    ["RO-TL-002"],
  );
});

test("bounds fail closed for malformed text and every read-budget ceiling", () => {
  assert.throws(() => resolveLimits(null), hasCode("RO_LIMITS_INVALID"));
  const limits = resolveLimits({
    maxFiles: 2,
    maxBytesPerFile: 3,
    maxTotalBytes: 3,
    maxRecords: 2,
    maxLineBytes: 2,
  });
  assert.equal(assertBoundedText("", { kind: "prompt", limits }).lines, 0);
  assert.throws(
    () => assertBoundedText(42, { kind: "prompt", limits }),
    hasCode("RO_TEXT_INVALID"),
  );
  assert.throws(
    () => assertBoundedText("abcd", { kind: "prompt", limits }),
    hasCode("RO_FILE_TOO_LARGE"),
  );
  assert.throws(
    () => assertBoundedText("abc", { kind: "prompt", limits }),
    hasCode("RO_LINE_TOO_LONG"),
  );

  const budget = createReadBudget(limits);
  assert.throws(
    () => budget.consume({ kind: "config", bytes: -1 }),
    hasCode("RO_FILE_SIZE_INVALID"),
  );
  assert.throws(
    () => budget.consume({ kind: "config", bytes: 4 }),
    hasCode("RO_FILE_TOO_LARGE"),
  );
  budget.consume({ kind: "config", bytes: 2 });
  assert.throws(
    () => budget.consume({ kind: "config", bytes: 2 }),
    hasCode("RO_TOTAL_BYTES_LIMIT"),
  );
  assert.throws(
    () => assertRecordCount(-1, limits),
    hasCode("RO_RECORD_LIMIT"),
  );
});

test("deep JSON is rejected iteratively with a stable bounded error", () => {
  const depth = 20_000;
  const source = "[".repeat(depth) + "0" + "]".repeat(depth);
  assert.throws(
    () => parseJsonText(source, "hostile.json", resolveLimits()),
    hasCode("RO_JSON_TOO_DEEP"),
  );
});

test("stdout reports cannot exceed the hard byte ceiling", () => {
  assert.doesNotThrow(() => assertStdoutBytes("ok"));
  assert.throws(
    () => assertStdoutBytes("x".repeat(HARD_LIMITS.maxStdoutBytes + 1)),
    hasCode("RO_OUTPUT_TOO_LARGE"),
  );
});

test("line and JSONL scanning preserve newline semantics lazily", () => {
  const mixed = "a\r\nb\rc\n";
  assert.deepEqual([...iterateLines(mixed)], ["a", "b", "c", ""]);
  assert.equal(lineCount(mixed), 4);
  assert.deepEqual(
    assertBoundedText(mixed, {
      kind: "jsonl",
      limits: resolveLimits({ maxBytesPerFile: 7, maxLineBytes: 1 }),
    }),
    { bytes: 7, lines: 4 },
  );
  assert.deepEqual(
    parseJsonLines(
      " \r\n\r1\r\n2\n",
      "records.jsonl",
      resolveLimits({ maxRecords: 2 }),
    ),
    [1, 2],
  );

  const dense = "\n".repeat(100_000);
  const iterator = iterateLines(dense);
  assert.equal(iterator.next().value, "");
  assert.equal(
    assertBoundedText(dense, {
      kind: "jsonl",
      limits: resolveLimits({ maxBytesPerFile: dense.length }),
    }).lines,
    dense.length + 1,
  );
});

test("dense line scanning stays within a bounded heap", () => {
  const boundsUrl = new URL(
    "../../plugins/reviewops-auditor-benchmark/src/bounds.mjs",
    import.meta.url,
  ).href;
  const schemaUrl = new URL(
    "../../plugins/reviewops-auditor-benchmark/src/schema.mjs",
    import.meta.url,
  ).href;
  const script = [
    `import { assertBoundedText, resolveLimits } from ${JSON.stringify(boundsUrl)};`,
    `import { parseJsonLines } from ${JSON.stringify(schemaUrl)};`,
    'const text = "\\n".repeat(8 * 1024 * 1024);',
    "const limits = resolveLimits({ maxBytesPerFile: 8 * 1024 * 1024, maxLineBytes: 128 * 1024 });",
    'const shape = assertBoundedText(text, { kind: "jsonl", limits });',
    'console.log(shape.lines, parseJsonLines(text, "dense.jsonl", limits).length);',
  ].join(" ");
  const result = spawnSync(
    process.execPath,
    ["--max-old-space-size=64", "--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 10_000 },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "8388609 0");
});

test("path context rejects invalid roots and supports the bounded config bootstrap", async (t) => {
  const root = tempWorkspace(t);
  fs.mkdirSync(path.join(root, "inputs"));
  fs.writeFileSync(path.join(root, "reviewops.config.json"), "{}");
  fs.writeFileSync(path.join(root, "not-a-directory"), "x");
  fs.mkdirSync(path.join(root, "inputs", "directory.md"));

  await assert.rejects(
    createTrustedPathContext({ trustedRoot: "" }),
    hasCode("RO_TRUSTED_ROOT_INVALID"),
  );
  await assert.rejects(
    createTrustedPathContext({ trustedRoot: path.join(root, "missing") }),
    hasCode("RO_TRUSTED_ROOT_UNAVAILABLE"),
  );
  await assert.rejects(
    createTrustedPathContext({
      trustedRoot: path.join(root, "not-a-directory"),
    }),
    hasCode("RO_TRUSTED_ROOT_INVALID"),
  );
  await assert.rejects(
    createTrustedPathContext({ trustedRoot: root, inputRoots: [] }),
    hasCode("RO_ROOTS_INVALID"),
  );
  await assert.rejects(
    createTrustedPathContext({ trustedRoot: root, inputRoots: [42] }),
    hasCode("RO_ROOTS_INVALID"),
  );
  await assert.rejects(
    createTrustedPathContext({ trustedRoot: root, inputRoots: ["missing"] }),
    hasCode("RO_PATH_UNAVAILABLE"),
  );
  await assert.rejects(
    createTrustedPathContext({
      trustedRoot: root,
      inputRoots: ["not-a-directory"],
    }),
    hasCode("RO_ROOT_NOT_DIRECTORY"),
  );

  const context = await createTrustedPathContext({
    trustedRoot: root,
    inputRoots: ["inputs"],
  });
  await assert.rejects(
    readApprovedFile(context, "inputs/directory.md", { kind: "prompt" }),
    hasCode("RO_PATH_NOT_REGULAR"),
  );
  await assert.rejects(
    readApprovedFile(context, "inputs/missing.md", { kind: "prompt" }),
    hasCode("RO_PATH_UNAVAILABLE"),
  );
  const config = await readTrustedConfigFile({
    trustedRoot: root,
    configPath: "reviewops.config.json",
  });
  assert.equal(config.text, "{}");
  assert.equal(isContainedPath(root, root), true);
  assert.equal(
    isContainedPath(root, path.join(path.dirname(root), "sibling")),
    false,
  );
});

test("YAML bounds and structural edge cases reject unsupported documents", () => {
  const nullValue = parseSafeYaml("key:\n");
  assert.equal(nullValue.value.key, null);
  const escapedPointer = parseWorkflowYaml('"a/b~c": 1\n');
  assert.equal(lineForYamlPath(escapedPointer, ["a/b~c"]), 1);

  assert.throws(() => parseWorkflowYaml(""), hasCode("RO_YAML_EMPTY"));
  assert.throws(
    () => parseWorkflowYaml("- value\n"),
    hasCode("RO_WORKFLOW_ROOT"),
  );
  assert.throws(
    () => parseWorkflowYaml("__proto__: value\n"),
    hasCode("RO_YAML_KEY"),
  );
  assert.throws(
    () => parseWorkflowYaml("value: .nan\n"),
    hasCode("RO_YAML_SCALAR"),
  );
  assert.throws(
    () =>
      parseWorkflowYaml("a: 1\n", {
        limits: resolveLimits({ maxYamlNodes: 1 }),
      }),
    hasCode("RO_YAML_NODE_LIMIT"),
  );
  assert.throws(
    () =>
      parseWorkflowYaml("a:\n  b:\n    c: 1\n", {
        limits: resolveLimits({ maxJsonDepth: 1 }),
      }),
    hasCode("RO_YAML_TOO_DEEP"),
  );
});

test("workflow audit handles sparse, array-trigger, and job-scoped configurations", () => {
  const sparse = auditWorkflow({
    relativePath: "workflows/sparse.yml",
    text: "on: pull_request\npermissions: read-all\n",
  });
  assert.equal(
    sparse.findings.find((finding) => finding.ruleId === "RO-WF-006")
      ?.evidenceStatus,
    "UNKNOWN",
  );
  assert.ok(sparse.findings.some((finding) => finding.ruleId === "RO-WF-001"));

  const scoped = auditWorkflow({
    relativePath: "workflows/scoped.yml",
    text: "on:\n  pull_request:\n    paths: [src/**]\njobs:\n  review:\n    permissions:\n      contents: read\n    timeout-minutes: 1\n    steps: []\nconcurrency:\n  group: review\n  cancel-in-progress: true\n",
  });
  assert.equal(
    scoped.findings.some((finding) => finding.ruleId === "RO-WF-001"),
    false,
  );

  const arrayTrigger = auditWorkflow({
    relativePath: "workflows/array.yml",
    text: "on: [pull_request, push]\npermissions:\n  contents: read\nconcurrency:\n  group: review\n  cancel-in-progress: false\njobs:\n  review:\n    timeout-minutes: 1\n    steps:\n      - uses: ./local-action\n",
  });
  const arrayIds = arrayTrigger.findings.map((finding) => finding.ruleId);
  assert.ok(arrayIds.includes("RO-WF-004"));
  assert.ok(arrayIds.includes("RO-WF-005"));
  assert.equal(arrayIds.includes("RO-WF-003"), false);

  const targetOnly = auditWorkflow({
    relativePath: "workflows/target.yml",
    text: "on: pull_request_target\npermissions:\n  contents: read\njobs:\n  review:\n    timeout-minutes: 1\n    steps: []\nconcurrency:\n  group: review\n  cancel-in-progress: true\n",
  });
  assert.equal(
    targetOnly.findings.find((finding) => finding.ruleId === "RO-WF-002")
      ?.severity,
    "MEDIUM",
  );
});

test("redaction and deterministic utilities cover safe, truncated, and cyclic shapes", () => {
  assert.equal(redactRelativePath("safe/path.md").text, "safe/path.md");
  assert.equal(redactRelativePath("safe/\u202e/path.md").text, "[REDACTED]");
  assert.equal(
    redactRelativePath("user@example.com/file.md").text,
    "[REDACTED]",
  );
  assert.equal(stripUnsafeControls("a\r\nb\u001b[31mc"), "a\nbc");
  assert.equal(
    escapeUntrustedText("abcdefghij", { maxChars: 5 }).text,
    "abcd…",
  );
  assert.deepEqual(redactedTextShape(""), {
    bytes: 0,
    lines: 0,
    redactions: 0,
  });
  assert.equal(
    redactJsonValue([["nested"]], { maxDepth: 0 }).value[0],
    "[REDACTED]",
  );

  assert.equal(lineCount(""), 0);
  assert.equal(lineCount("a\r\nb"), 2);
  assert.equal(lineAtOffset("a\nb\nc", 4), 3);
  assert.equal(lineAtOffset("a", -1), 1);
  assert.deepEqual(sortedUniqueStrings(["b", "a", "b"]), ["a", "b"]);
  assert.equal(isNonEmptyString("x"), true);
  assert.equal(isNonEmptyString(""), false);
  assert.equal(jsonDepth([]), 1);
  assert.equal(jsonDepth({}), 1);
  assert.equal(stableJson([null, true, "x"]), '[null,true,"x"]');
  const cycle = [];
  cycle.push(cycle);
  assert.throws(() => stableJson(cycle), hasCode("RO_CYCLIC_VALUE"));
  assert.throws(() => stableJson(new Date(0)), hasCode("RO_NON_JSON_VALUE"));
});

test("PEM redaction avoids superlinear work on unmatched starts", () => {
  const complete = redactText(
    "before -----BEGIN RSA PRIVATE KEY-----secret-----END RSA PRIVATE KEY----- after",
  );
  assert.equal(complete.text, "before [REDACTED] after");
  assert.equal(complete.categories.PRIVATE_KEY, 1);

  const hostile = "-----BEGIN PRIVATE KEY-----".repeat(16_000);
  const started = performance.now();
  const unmatched = redactText(hostile);
  const elapsedMs = performance.now() - started;
  assert.equal(unmatched.text, "[REDACTED]");
  assert.equal(unmatched.count, 1);
  assert.equal(unmatched.categories.PRIVATE_KEY, 1);
  assert.ok(elapsedMs < 1_000, `redaction took ${elapsedMs} ms`);
});
