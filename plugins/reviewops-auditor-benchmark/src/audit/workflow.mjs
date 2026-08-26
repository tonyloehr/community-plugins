// @ts-check

import { parseWorkflowYaml, lineForYamlPath } from "../yaml.mjs";
import {
  arrayValue,
  booleanValue,
  firstMatchingLine,
  makeFinding,
  objectValue,
  sortFindings,
  stringValue,
  structuralInputSummary,
} from "./common.mjs";

/** @import {Limits} from "../bounds.mjs" */
/** @import {AuditFinding, LoadedTextInput} from "./common.mjs" */

export const WORKFLOW_RULES = Object.freeze([
  { id: "RO-WF-001", category: "SECURITY", title: "Permissions are bounded" },
  {
    id: "RO-WF-002",
    category: "SECURITY",
    title: "Triggers avoid privileged untrusted code",
  },
  {
    id: "RO-WF-003",
    category: "SECURITY",
    title: "Remote actions are immutably pinned",
  },
  { id: "RO-WF-004", category: "COST", title: "Triggers avoid duplicate review runs" },
  { id: "RO-WF-005", category: "COST", title: "Concurrency cancels superseded runs" },
  { id: "RO-WF-006", category: "RELIABILITY", title: "Review jobs have timeouts" },
  { id: "RO-WF-007", category: "COST", title: "Context collection is bounded" },
  {
    id: "RO-WF-008",
    category: "SECURITY",
    title: "Untrusted interpolation stays out of shell text",
  },
  { id: "RO-WF-009", category: "NOISE", title: "Writeback is bounded and verified" },
]);

/**
 * @typedef {{
 *   jobName: string,
 *   job: Record<string, unknown>,
 *   steps: {index: number, step: Record<string, unknown>}[]
 * }} JobInfo
 */

/**
 * @typedef {{
 *   jobName: string,
 *   index: number,
 *   value: string,
 *   line?: number
 * }} UsesEntry
 */

/**
 * @param {Record<string, unknown>} workflow
 * @returns {JobInfo[]}
 */
function jobsFromWorkflow(workflow) {
  const jobs = objectValue(workflow.jobs);
  if (jobs === undefined) {
    return [];
  }

  return Object.keys(jobs)
    .sort((left, right) => left.localeCompare(right, "en"))
    .flatMap((jobName) => {
      const job = objectValue(jobs[jobName]);
      if (job === undefined) {
        return [];
      }
      const steps = arrayValue(job.steps).flatMap((value, index) => {
        const step = objectValue(value);
        return step === undefined ? [] : [{ index, step }];
      });
      return [{ jobName, job, steps }];
    });
}

/**
 * @param {unknown} value
 * @param {string[]} output
 */
function collectStrings(value, output) {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStrings(entry, output);
    }
    return;
  }
  const object = objectValue(value);
  if (object !== undefined) {
    for (const key of Object.keys(object).sort((left, right) =>
      left.localeCompare(right, "en"),
    )) {
      collectStrings(object[key], output);
    }
  }
}

/**
 * @param {Record<string, unknown>} workflow
 * @returns {string[]}
 */
function triggerNames(workflow) {
  const trigger = workflow.on;
  if (typeof trigger === "string") {
    return [trigger];
  }
  if (Array.isArray(trigger)) {
    return trigger.filter((value) => typeof value === "string");
  }
  const object = objectValue(trigger);
  return object === undefined
    ? []
    : Object.keys(object).sort((left, right) => left.localeCompare(right, "en"));
}

/**
 * @param {Record<string, unknown>} workflow
 * @returns {boolean}
 */
function hasPathFilters(workflow) {
  const triggers = objectValue(workflow.on);
  if (triggers === undefined) {
    return false;
  }
  for (const trigger of Object.values(triggers)) {
    const config = objectValue(trigger);
    if (config !== undefined && ("paths" in config || "paths-ignore" in config)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {unknown} permissions
 * @returns {{missing: boolean, writes: boolean, broad: boolean}}
 */
function permissionShape(permissions) {
  if (permissions === undefined || permissions === null) {
    return { missing: true, writes: false, broad: false };
  }
  if (typeof permissions === "string") {
    return {
      missing: false,
      writes: permissions === "write-all",
      broad: permissions === "write-all" || permissions === "read-all",
    };
  }
  const object = objectValue(permissions);
  if (object === undefined) {
    return { missing: false, writes: false, broad: true };
  }
  const values = Object.values(object);
  return {
    missing: false,
    writes: values.some((value) => value === "write"),
    broad: values.some((value) => value === "write"),
  };
}

/**
 * @param {Record<string, unknown>} workflow
 * @param {JobInfo[]} jobs
 * @returns {{missing: boolean, writes: boolean, broad: boolean}}
 */
function effectivePermissionShape(workflow, jobs) {
  const global = permissionShape(workflow.permissions);
  let missing =
    global.missing &&
    (jobs.length === 0 || jobs.some((job) => !("permissions" in job.job)));
  let writes = global.writes;
  let broad = global.broad;
  for (const job of jobs) {
    if ("permissions" in job.job) {
      const local = permissionShape(job.job.permissions);
      writes ||= local.writes;
      broad ||= local.broad;
    }
  }
  return { missing, writes, broad };
}

/**
 * @param {JobInfo[]} jobs
 * @param {ReturnType<typeof parseWorkflowYaml>} parsed
 * @returns {UsesEntry[]}
 */
function usesEntries(jobs, parsed) {
  /** @type {UsesEntry[]} */
  const entries = [];
  for (const job of jobs) {
    for (const { index, step } of job.steps) {
      const uses = stringValue(step.uses);
      if (uses !== undefined) {
        entries.push({
          jobName: job.jobName,
          index,
          value: uses,
          line: lineForYamlPath(parsed, ["jobs", job.jobName, "steps", index, "uses"]),
        });
      }
    }
  }
  return entries;
}

/**
 * @param {string} uses
 * @returns {boolean}
 */
function isRemoteAction(uses) {
  return !uses.startsWith("./") && !uses.startsWith("../") && uses.includes("/");
}

/**
 * @param {string} uses
 * @returns {boolean}
 */
function isPinnedAction(uses) {
  return /@[0-9a-f]{40}$/iu.test(uses);
}

/**
 * @param {LoadedTextInput} input
 * @param {{limits?: Limits}} [options]
 * @returns {{
 *   kind: "workflow",
 *   summary: ReturnType<typeof structuralInputSummary> & {jobs: number, steps: number, remoteActions: number, triggers: number},
 *   findings: AuditFinding[]
 * }}
 */
export function auditWorkflow(input, options = {}) {
  const parsed = parseWorkflowYaml(input.text, { limits: options.limits });
  const workflow = parsed.value;
  const jobs = jobsFromWorkflow(workflow);
  const uses = usesEntries(jobs, parsed);
  const triggers = triggerNames(workflow);
  /** @type {string[]} */
  const strings = [];
  collectStrings(workflow, strings);
  const allText = strings.join("\n");
  const permissions = effectivePermissionShape(workflow, jobs);
  /** @type {AuditFinding[]} */
  const findings = [];

  if (permissions.missing || permissions.broad || permissions.writes) {
    findings.push(
      makeFinding({
        ruleId: "RO-WF-001",
        category: "SECURITY",
        evidenceStatus: "OBSERVED",
        severity: permissions.writes ? "HIGH" : "MEDIUM",
        confidence: "HIGH",
        path: input.relativePath,
        line:
          lineForYamlPath(parsed, ["permissions"]) ?? lineForYamlPath(parsed, ["jobs"]),
        evidenceSummary: permissions.writes
          ? "A workflow or job declares write-capable permissions."
          : permissions.missing
            ? "A workflow or job has no explicit permissions declaration."
            : "A workflow or job declares broad permissions.",
        remediation:
          "Declare the smallest read-only permissions needed by the reviewer.",
        verification:
          "Inspect effective workflow and job permissions in a synthetic pull request.",
        claimBoundary:
          "Static file indicator only; repository and organization defaults are not visible.",
        missingEvidence: ["Effective GitHub permission defaults"],
      }),
    );
  }

  const hasPullRequestTarget = triggers.includes("pull_request_target");
  const hasCheckout = uses.some((entry) => /^actions\/checkout@/iu.test(entry.value));
  const hasSecretReference = /\$\{\{\s*secrets\./iu.test(allText);
  if (hasPullRequestTarget) {
    findings.push(
      makeFinding({
        ruleId: "RO-WF-002",
        category: "SECURITY",
        evidenceStatus: "OBSERVED",
        severity: hasCheckout || hasSecretReference ? "HIGH" : "MEDIUM",
        confidence: "HIGH",
        path: input.relativePath,
        line: lineForYamlPath(parsed, ["on", "pull_request_target"]),
        evidenceSummary:
          hasCheckout || hasSecretReference
            ? "A privileged pull-request-target trigger appears with checkout or secret references."
            : "A privileged pull-request-target trigger is present.",
        remediation:
          "Use an unprivileged trigger or isolate trusted follow-up work from untrusted code.",
        verification:
          "Confirm the reviewed job never executes or checks out untrusted pull request content with secrets.",
        claimBoundary:
          "Static indicator only; runtime event data and repository settings are not visible.",
        missingEvidence: ["Runtime event provenance", "Repository secret policy"],
      }),
    );
  }

  const unpinned = uses.filter(
    (entry) => isRemoteAction(entry.value) && !isPinnedAction(entry.value),
  );
  if (unpinned.length > 0) {
    findings.push(
      makeFinding({
        ruleId: "RO-WF-003",
        category: "SECURITY",
        evidenceStatus: "OBSERVED",
        severity: "MEDIUM",
        confidence: "HIGH",
        path: input.relativePath,
        line: unpinned[0]?.line,
        evidenceSummary:
          String(unpinned.length) +
          " remote action reference(s) are not pinned to a 40-character commit SHA.",
        remediation: "Pin every remote action to a reviewed immutable commit SHA.",
        verification:
          "Reparse the workflow and confirm each remote uses reference ends in a 40-character SHA.",
        claimBoundary:
          "Static reference check only; action provenance is not verified.",
      }),
    );
  }

  if (
    triggers.includes("pull_request") &&
    triggers.includes("push") &&
    !hasPathFilters(workflow)
  ) {
    findings.push(
      makeFinding({
        ruleId: "RO-WF-004",
        category: "COST",
        evidenceStatus: "INFERRED",
        severity: "LOW",
        confidence: "MEDIUM",
        path: input.relativePath,
        line: lineForYamlPath(parsed, ["on"]),
        evidenceSummary:
          "Pull-request and push triggers are both broad enough to plausibly duplicate review runs.",
        remediation:
          "Narrow events or path filters after confirming the intended review coverage.",
        verification: "Compare run telemetry for the same commit across trigger types.",
        claimBoundary:
          "Static heuristic only; duplicate runs require telemetry to confirm.",
        missingEvidence: ["Run telemetry keyed by commit and trigger"],
      }),
    );
  }

  const concurrency = objectValue(workflow.concurrency);
  const cancels =
    concurrency !== undefined && booleanValue(concurrency["cancel-in-progress"]);
  if (concurrency === undefined || !cancels) {
    findings.push(
      makeFinding({
        ruleId: "RO-WF-005",
        category: "COST",
        evidenceStatus: "OBSERVED",
        severity: "LOW",
        confidence: "HIGH",
        path: input.relativePath,
        line: lineForYamlPath(parsed, ["concurrency"]),
        evidenceSummary:
          concurrency === undefined
            ? "Workflow concurrency is not declared."
            : "Workflow concurrency does not enable cancel-in-progress.",
        remediation:
          "Use a stable review concurrency group and cancel superseded runs when safe.",
        verification:
          "Push two synthetic updates and confirm only the newest review remains active.",
        claimBoundary:
          "Static configuration check only; cancellation behavior is not observed.",
      }),
    );
  }

  const jobsWithoutTimeout = jobs.filter(
    (job) => typeof job.job["timeout-minutes"] !== "number",
  );
  if (jobs.length === 0 || jobsWithoutTimeout.length > 0) {
    findings.push(
      makeFinding({
        ruleId: "RO-WF-006",
        category: "RELIABILITY",
        evidenceStatus: jobs.length === 0 ? "UNKNOWN" : "OBSERVED",
        severity: "MEDIUM",
        confidence: jobs.length === 0 ? "LOW" : "HIGH",
        path: input.relativePath,
        line:
          jobsWithoutTimeout.length > 0
            ? lineForYamlPath(parsed, ["jobs", jobsWithoutTimeout[0]?.jobName])
            : lineForYamlPath(parsed, ["jobs"]),
        evidenceSummary:
          jobs.length === 0
            ? "No analyzable jobs are declared in this workflow."
            : String(jobsWithoutTimeout.length) + " job(s) lack timeout-minutes.",
        remediation: "Set bounded job timeouts for review work.",
        verification:
          "Inspect a synthetic timeout run and confirm the job terminates within the declared bound.",
        claimBoundary:
          "Static configuration check only; runtime duration is not observed.",
        missingEvidence: jobs.length === 0 ? ["Declared review job"] : [],
      }),
    );
  }

  const broadCheckout = uses.some((entry) => {
    if (!/^actions\/checkout@/iu.test(entry.value)) {
      return false;
    }
    const job = jobs.find((candidate) => candidate.jobName === entry.jobName);
    const step = job?.steps.find((candidate) => candidate.index === entry.index)?.step;
    const withObject = objectValue(step?.with);
    return (
      withObject === undefined ||
      withObject["fetch-depth"] === 0 ||
      withObject["fetch-depth"] === "0"
    );
  });
  if (broadCheckout || !hasPathFilters(workflow)) {
    findings.push(
      makeFinding({
        ruleId: "RO-WF-007",
        category: "COST",
        evidenceStatus: "INFERRED",
        severity: "LOW",
        confidence: "MEDIUM",
        path: input.relativePath,
        line: broadCheckout
          ? firstMatchingLine(input.text, /actions\/checkout/iu)
          : lineForYamlPath(parsed, ["on"]),
        evidenceSummary: broadCheckout
          ? "Checkout appears to use full or implicit history."
          : "No workflow path filters are visible.",
        remediation:
          "Bound checkout history and reviewed paths only after validating review coverage.",
        verification:
          "Compare context receipts and accepted findings before and after narrowing scope.",
        claimBoundary:
          "Static heuristic only; savings and quality effects require run evidence.",
        missingEvidence: ["Context receipt", "Paired review telemetry"],
      }),
    );
  }

  const interpolationPattern =
    /\$\{\{\s*github\.event\.(?:pull_request\.)?(?:title|body|head_ref|ref|comment\.body|issue\.title|issue\.body)/iu;
  const interpolationLine = firstMatchingLine(input.text, interpolationPattern);
  if (interpolationLine !== undefined) {
    findings.push(
      makeFinding({
        ruleId: "RO-WF-008",
        category: "SECURITY",
        evidenceStatus: "OBSERVED",
        severity: "HIGH",
        confidence: "HIGH",
        path: input.relativePath,
        line: interpolationLine,
        evidenceSummary: "An untrusted event field appears in workflow interpolation.",
        remediation:
          "Pass untrusted event data as inert input and avoid shell or prompt interpolation.",
        verification:
          "Use hostile synthetic event text and confirm it cannot alter commands or prompts.",
        claimBoundary: "Static interpolation indicator only; no command is executed.",
      }),
    );
  }

  const writebackPattern =
    /\b(?:gh\s+pr\s+comment|create(?:-or-update)?-comment|sticky-pull-request-comment|issues\.createComment|pulls\.createReview)\b/iu;
  const writebackLine = firstMatchingLine(input.text, writebackPattern);
  if (permissions.writes || writebackLine !== undefined) {
    findings.push(
      makeFinding({
        ruleId: "RO-WF-009",
        category: "NOISE",
        evidenceStatus: "INFERRED",
        severity: permissions.writes && writebackLine !== undefined ? "MEDIUM" : "LOW",
        confidence: "MEDIUM",
        path: input.relativePath,
        line: writebackLine ?? lineForYamlPath(parsed, ["permissions"]),
        evidenceSummary:
          permissions.writes && writebackLine !== undefined
            ? "Write-capable permissions and comment-like writeback indicators are both visible."
            : "Writeback capability or comment-like behavior is visible without a bounded publishing contract.",
        remediation:
          "Require evidence, deduplication, and a maximum comment budget before publishing.",
        verification:
          "Review synthetic duplicate and unverified findings against the publishing gate.",
        claimBoundary:
          "Static indicator only; actual publishing behavior requires run telemetry.",
        missingEvidence: ["Publishing gate telemetry"],
      }),
    );
  }

  const summary = structuralInputSummary(input, {
    jobs: jobs.length,
    steps: jobs.reduce((total, job) => total + job.steps.length, 0),
    remoteActions: uses.filter((entry) => isRemoteAction(entry.value)).length,
    triggers: triggers.length,
    hasPathFilters: hasPathFilters(workflow),
    hasConcurrency: concurrency !== undefined,
  });
  return {
    kind: "workflow",
    summary: {
      ...summary,
      jobs: jobs.length,
      steps: jobs.reduce((total, job) => total + job.steps.length, 0),
      remoteActions: uses.filter((entry) => isRemoteAction(entry.value)).length,
      triggers: triggers.length,
    },
    findings: sortFindings(findings),
  };
}
