import { z } from 'zod/v4';
import os from 'node:os';
import type { Runtime } from './runtime.js';
import { getOperation, parseOperation } from './catalog.js';
import { FixtureDesktopProvider } from './fixture.js';
import { profileHash } from './profile.js';
import { boundedJson, cloneNativeJson } from './native-security.js';
import { FusionError, assertJson, errorResult, hash, newId, now } from './safety.js';

const assertionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('equals'), pointer: z.string().max(1024), expected: z.unknown() }),
  z.strictObject({ kind: z.literal('exists'), pointer: z.string().max(1024) }),
  z.strictObject({ kind: z.literal('approx'), pointer: z.string().max(1024), expected: z.number().finite(), absolute_tolerance: z.number().nonnegative().max(1000), relative_tolerance: z.number().min(0).max(0.01).default(0) }),
  z.strictObject({ kind: z.literal('length_at_least'), pointer: z.string().max(1024), expected: z.number().int().nonnegative().max(10_000) })
]);
const stepSchema = z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), action: z.enum(['read', 'change', 'artifact', 'wait_job']), input: z.unknown(), assertions: z.array(assertionSchema).min(1).max(100), max_polls: z.number().int().min(1).max(120).default(30), poll_interval_ms: z.number().int().min(20).max(1000).default(500) });
const scenarioSchema = z.strictObject({ version: z.literal(1), id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), purpose: z.string().min(1).max(4096), steps: z.array(stepSchema).min(1).max(100), cleanup: z.array(stepSchema).max(30).default([]) });
type Step = z.infer<typeof stepSchema>;
const MAX_REFERENCE_SELECTION_ITEMS = 10_000;
const selectionPointer = z.string().max(1024).refine(pointer => pointer === '' || (pointer.startsWith('/') && pointer.slice(1).split('/').every(part => !/~(?![01])/u.test(part) && !['__proto__', 'prototype', 'constructor'].includes(part.replace(/~1/g, '/').replace(/~0/g, '~')))), 'Use a bounded JSON pointer without reserved keys.');
const referenceSchema = z.strictObject({
  $ref: z.string().min(2).max(1089),
  select: z.strictObject({ pointer: selectionPointer, equals: z.string().min(1).max(1024), value_pointer: selectionPointer }).optional(),
});

export function jsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === '') return value;
  if (!pointer.startsWith('/') || pointer.length > 1024) throw new FusionError('INVALID_POINTER', 'Use a bounded JSON pointer.');
  let current = value;
  for (const part of pointer.slice(1).split('/')) {
    if (/~(?![01])/u.test(part)) throw new FusionError('INVALID_POINTER', 'Invalid JSON pointer escape.');
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (['__proto__', 'prototype', 'constructor'].includes(key) || !current || typeof current !== 'object' || !Object.hasOwn(current, key)) throw new FusionError('ASSERTION_PATH_MISSING', 'The qualification result does not contain the requested field.');
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
function resolve(value: unknown, results: Map<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map(item => resolve(item, results));
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (Object.hasOwn(object, '$ref')) {
      const parsed = referenceSchema.safeParse(object);
      if (!parsed.success) throw new FusionError('INVALID_REFERENCE', 'A scenario reference permits only $ref and an optional strict string-identity selection.');
      const reference = parsed.data;
      const split = reference.$ref.indexOf('#');
      const step = reference.$ref.slice(0, split), pointer = reference.$ref.slice(split + 1);
      if (split < 1 || !results.has(step)) throw new FusionError('INVALID_REFERENCE', 'Scenario reference must name an already completed step.');
      // Keep a reference temporarily; the bounded encoder below clones the
      // resolved input once. Repeated $refs cannot allocate gigabytes before
      // the final request byte limit is checked.
      const referenced = jsonPointer(results.get(step), pointer);
      if (!reference.select) return referenced;
      if (!Array.isArray(referenced) || referenced.length > MAX_REFERENCE_SELECTION_ITEMS) throw new FusionError('INVALID_REFERENCE', 'Scenario identity selection requires an array of at most 10000 items.');
      let selected: unknown, matches = 0;
      for (const item of referenced) {
        let identity: unknown;
        try { identity = jsonPointer(item, reference.select.pointer); }
        catch { throw new FusionError('INVALID_REFERENCE', 'A selected array item has no valid identity at the declared pointer.'); }
        if (typeof identity !== 'string' || !identity.length || identity.length > 1024) throw new FusionError('INVALID_REFERENCE', 'Every selected array identity must be a bounded nonempty string.');
        if (identity === reference.select.equals) {
          selected = item;
          if (++matches > 1) throw new FusionError('INVALID_REFERENCE', 'Scenario identity selection is ambiguous; exactly one match is required.');
        }
      }
      if (matches !== 1) throw new FusionError('INVALID_REFERENCE', 'Scenario identity selection has no match; exactly one match is required.');
      try { return jsonPointer(selected, reference.select.value_pointer); }
      catch { throw new FusionError('INVALID_REFERENCE', 'The uniquely selected item does not contain the declared value pointer.'); }
    }
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, resolve(item, results)]));
  }
  return value;
}
export function checkQualificationAssertions(value: unknown, assertions: z.infer<typeof assertionSchema>[]): void {
  for (const assertion of assertions) {
    const actual = jsonPointer(value, assertion.pointer);
    if (assertion.kind === 'exists') continue;
    if (assertion.kind === 'equals' && hash(actual) === hash(assertion.expected)) continue;
    if (assertion.kind === 'length_at_least' && (Array.isArray(actual) || typeof actual === 'string') && actual.length >= assertion.expected) continue;
    if (assertion.kind === 'approx' && typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - assertion.expected) <= assertion.absolute_tolerance + Math.abs(assertion.expected) * assertion.relative_tolerance) continue;
    throw new FusionError('QUALIFICATION_ASSERTION_FAILED', `A declared ${assertion.kind} check failed at ${assertion.pointer}.`, 'none', { actual, expected: 'expected' in assertion ? assertion.expected : null });
  }
}
export async function runQualification(runtime: Runtime, raw: unknown): Promise<Record<string, unknown>> {
  assertJson(raw, 2_097_152);
  const parsed = scenarioSchema.safeParse(raw);
  if (!parsed.success) throw new FusionError('INVALID_SCENARIO', 'Qualification scenario does not match the declarative schema.', 'none', parsed.error.issues);
  const scenario = parsed.data;
  const ids = [...scenario.steps, ...scenario.cleanup].map(s => s.id);
  if (new Set(ids).size !== ids.length) throw new FusionError('INVALID_SCENARIO', 'Scenario step IDs must be unique.');
  const runId = newId('qualification');
  const results = new Map<string, unknown>(), evidence: unknown[] = [];
  const resultSizes = new Map<string, number>();
  const createdDocuments = new Set<string>(), remainingDocuments = new Set<string>();
  const failedCleanupStepIds: string[] = [];
  const artifactIds = new Set<string>(), jobIds = new Set<string>();
  const operations: Array<{ step_id: string; operation: string; execution_status: string; assertions_passed: boolean; completion_assertions_passed?: boolean }> = [];
  const jobOperations = new Map<string, typeof operations[number]>(), jobStates = new Map<string, string>();
  let connection: Record<string, unknown>;
  try { connection = await runtime.engine.connectionStatus() as Record<string, unknown>; }
  catch (error) { connection = { desktop_evidence: { kind: 'unverified_provider', error: errorResult(error), handler_execution_reported: false } }; }
  const providerEvidence = connection.desktop_evidence as Record<string, unknown> | undefined;
  const fixture = runtime.profile.mode === 'fixture' || runtime.engine.desktop instanceof FixtureDesktopProvider || providerEvidence?.kind === 'synthetic_fixture';
  let inlineBytes = 0, retainedBytes = 0;
  let failed = false;
  const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const remember = (stepId: string, value: unknown): void => {
    const bytes = Buffer.byteLength(boundedJson(value, 16_777_216));
    const retained = retainedBytes - (resultSizes.get(stepId) ?? 0) + bytes;
    if (retained > 16_777_216) throw new FusionError('QUALIFICATION_EVIDENCE_LIMIT', 'Scenario results exceed the bounded reference cache. Use smaller scenarios; retained operation receipts still require review.');
    retainedBytes = retained; resultSizes.set(stepId, bytes); results.set(stepId, value);
  };
  const checkScope = async (documentId?: string): Promise<void> => {
    if (!fixture && documentId && !runtime.profile.policy.qualificationDocuments.includes(documentId) && !(runtime.profile.policy.allowCreatedDocuments && createdDocuments.has(documentId) && await runtime.engine.isCreatedDocument(documentId))) throw new FusionError('QUALIFICATION_SCOPE_DENIED', 'Use an explicitly allowlisted qualification document or a document created/imported by this run. Previously created work and production documents are not implicit test fixtures.');
  };
  const capture = async (record: Record<string, unknown>, result: unknown): Promise<void> => {
    if (result !== undefined) {
      const serialized = boundedJson(result, 16_777_216), size = Buffer.byteLength(serialized);
      const receiptId = `${runId}_${record.id as string}`;
      await runtime.engine.store.put('qualification_result', receiptId, result);
      record.result_receipt = { id: receiptId, kind: 'qualification_result', sha256: hash(result), size_bytes: size };
      if (size <= 65_536 && inlineBytes + size <= 1_000_000) { record.result = result; inlineBytes += size; }
      else record.result_omitted = 'Full result is retained in the private result receipt; it is omitted here to bound the report.';
    }
    evidence.push(record);
  };
  const run = async (step: Step, cleanup: boolean): Promise<void> => {
    const started = now();
    let result: unknown, operationEvidence: typeof operations[number] | undefined, completionEvidence: typeof operations[number] | undefined;
    try {
      const input = cloneNativeJson(resolve(step.input, results), 2_097_152); assertJson(input, 2_097_152);
      if (step.action === 'read') {
        const operation = parseOperation(input); await checkScope(operation.document_id);
        if (['cam.status', 'render.status'].includes(operation.operation) && !jobIds.has(operation.args.job_id as string)) throw new FusionError('QUALIFICATION_SCOPE_DENIED', 'Qualification may inspect only futures submitted by this run.');
        result = await runtime.engine.read(operation);
        operationEvidence = { step_id: step.id, operation: operation.operation, execution_status: 'succeeded', assertions_passed: false }; operations.push(operationEvidence);
      }
      else if (step.action === 'change') {
        const operation = parseOperation(input);
        const definition = getOperation(operation.operation);
        if (!['local_edit', 'local_artifact'].includes(definition.effect) || operation.operation === 'cam.nc_post') throw new FusionError('QUALIFICATION_EFFECT_DENIED', 'This local kernel harness does not save to cloud, post NC, submit compute or administer systems. Those need their own qualified fixtures and reviewer gates.');
        if (operation.operation === 'documents.open') throw new FusionError('QUALIFICATION_SCOPE_DENIED', 'Opening existing cloud work is not an isolated qualification fixture. Open and explicitly scope a reviewed fixture before this local harness runs.');
        if (cleanup && !definition.document) throw new FusionError('QUALIFICATION_CLEANUP_DENIED', 'Cleanup must not create, import or open another document. Use explicitly scoped compensating changes or leave a manual cleanup record.');
        await checkScope(operation.document_id);
        if (operation.operation === 'documents.import' && object(operation.args.source)?.kind === 'artifact' && !artifactIds.has(object(operation.args.source)!.id as string)) throw new FusionError('QUALIFICATION_SCOPE_DENIED', 'Round-trip qualification must import an artifact produced by this run.');
        const plan = await runtime.engine.prepare(operation);
        if (plan.artifact) artifactIds.add(plan.artifact.id);
        result = await runtime.engine.execute(plan.id, plan.hash, `${runId}:${step.id}`);
        const completed = object(result)!, payload = object(completed.result), data = object(payload?.data);
        const job = object(payload?.job); if (typeof job?.id === 'string') { jobIds.add(job.id); jobStates.set(job.id, String(job.status)); }
        operationEvidence = { step_id: step.id, operation: operation.operation, execution_status: String(completed.status), assertions_passed: false }; operations.push(operationEvidence);
        if (typeof job?.id === 'string') jobOperations.set(job.id, operationEvidence);
        if (completed.status === 'succeeded' && ['documents.create', 'documents.import'].includes(operation.operation)) {
          const id = operation.operation === 'documents.import' ? object(data?.document)?.document_id : data?.document_id;
          if (typeof id === 'string') { createdDocuments.add(id); remainingDocuments.add(id); }
        }
        if (completed.status === 'succeeded' && operation.operation === 'documents.close') remainingDocuments.delete(operation.document_id!);
      } else if (step.action === 'artifact') {
        const args = z.strictObject({ artifact_id: z.string().min(1) }).parse(input);
        if (!artifactIds.has(args.artifact_id)) throw new FusionError('QUALIFICATION_SCOPE_DENIED', 'Qualification may inspect only artifacts prepared by this run.');
        result = await runtime.engine.artifacts.inspect(args.artifact_id);
      } else {
        const args = z.strictObject({ job_id: z.string().min(1) }).parse(input);
        if (!jobIds.has(args.job_id)) throw new FusionError('QUALIFICATION_SCOPE_DENIED', 'Qualification may poll only jobs submitted by this run.');
        for (let poll = 0; poll < step.max_polls; poll++) {
          const job = await runtime.engine.jobStatus(args.job_id); result = job;
          jobStates.set(job.id, job.status);
          if (['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(job.status)) break;
          if (poll + 1 < step.max_polls) await new Promise(resolve => setTimeout(resolve, step.poll_interval_ms));
        }
        if (!['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(String(object(result)?.status))) throw new FusionError('QUALIFICATION_JOB_TIMEOUT', 'The bounded poll window ended before a terminal result. A pending future cannot pass completion qualification.');
        completionEvidence = jobOperations.get(args.job_id);
        if (completionEvidence) { completionEvidence.execution_status = String(object(result)?.status); completionEvidence.completion_assertions_passed = false; }
      }
      remember(step.id, result);
      checkQualificationAssertions(result, step.assertions);
      if (operationEvidence) operationEvidence.assertions_passed = true;
      if (completionEvidence) completionEvidence.completion_assertions_passed = true;
      // A cleanup operation that actually failed is not successful restoration
      // merely because a weak or negative assertion accepted its response.
      if (cleanup && ((step.action === 'change' && ['failed', 'cancelled', 'outcome_unknown'].includes(operationEvidence?.execution_status ?? '')) || (step.action === 'wait_job' && object(result)?.status !== 'succeeded'))) throw new FusionError('QUALIFICATION_CLEANUP_FAILED', 'The cleanup operation did not complete successfully; human reconciliation is required.');
      await capture({ id: step.id, action: step.action, cleanup, started_at: started, finished_at: now(), status: 'passed', assertions: step.assertions }, result);
    } catch (error) {
      failed = true;
      if (cleanup) failedCleanupStepIds.push(step.id);
      // Preserve an already produced result so explicit cleanup references can
      // still resolve after a failed assertion or exhausted polling window.
      if (result !== undefined && !results.has(step.id)) { try { remember(step.id, result); } catch { /* The bounded cache cannot admit this result. */ } }
      try { await capture({ id: step.id, action: step.action, cleanup, started_at: started, finished_at: now(), status: 'failed', error: errorResult(error) }, result); }
      catch (recordError) { evidence.push({ id: step.id, action: step.action, cleanup, status: 'failed', error: errorResult(error), receipt_error: errorResult(recordError) }); }
      if (!cleanup) throw error;
    }
  };
  try { for (const step of scenario.steps) await run(step, false); } catch { /* Receipt and explicit cleanup must still be produced. */ }
  finally { for (const step of scenario.cleanup) await run(step, true); }
  const successfulOperations = operations.filter(entry => entry.execution_status === 'succeeded' && entry.assertions_passed && entry.completion_assertions_passed !== false);
  const unresolvedJobs = [...jobStates].filter(([, status]) => !['succeeded', 'failed', 'cancelled'].includes(status)).map(([job_id, status]) => ({ job_id, status }));
  const report: Record<string, unknown> = {
    id: runId, scenario_id: scenario.id, scenario_hash: hash(scenario), purpose: scenario.purpose, tested_at: now(),
    profile_id: runtime.profile.id, profile_sha256: profileHash(runtime.profile), mode: runtime.profile.mode,
    handler_sha256: runtime.engine.handlerHash, execution_contract_sha256: runtime.engine.executionContractHash,
    execution_contract_kind: runtime.engine.executionContractKind,
    runtime_environment: { platform: process.platform, arch: process.arch, os_release: os.release() },
    status: failed ? 'failed' : 'scenario_passed', evidence_kind: fixture ? 'synthetic_fixture' : providerEvidence?.kind ?? 'unverified_provider',
    provider_evidence: providerEvidence ?? { kind: 'unverified_provider' },
    desktop_qualification_candidate: connection.desktop_qualification_candidate ?? null,
    desktop_qualification_candidate_observed_at: connection.desktop_qualification_candidate_observed_at ?? null,
    desktop_qualification_candidate_requires: 'Reviewed evidence, reviewer identity and expiry are supplied only by the trusted profile owner after scoped live qualification. This report does not promote the profile.',
    live_fusion_exercised: !fixture && providerEvidence?.handler_execution_reported === true && operations.some(entry => entry.execution_status === 'succeeded'),
    live_fusion_verified: false, live_fusion_qualified: false, operations_exercised: operations,
    successful_operations: successfulOperations, evidence,
    cleanup: { created_document_ids: [...createdDocuments], remaining_document_ids: [...remainingDocuments], unresolved_jobs: unresolvedJobs, failed_step_ids: failedCleanupStepIds, automatic_discard_or_save: false, review_required: remainingDocuments.size > 0 || unresolvedJobs.length > 0 || failedCleanupStepIds.length > 0 },
    remaining_gates: [
      'A responsible engineer must review the declared assertions, fixture provenance, supported OS/build and measured results. Provider-reported execution is not independent Autodesk verification.',
      'A passing negative test does not show that an operation succeeded. Pending asynchronous work is not complete.',
      'A passing scenario does not qualify other operation variants, materials, manufacturing profiles or cloud tenants.',
      'Failed cleanup steps, unsaved documents and unresolved jobs require explicit human reconciliation; this harness never discards work or silently saves to cloud.',
      'No automatic profile promotion or unsupported machine verification is performed.',
    ],
  };
  report.report_hash = hash(report); await runtime.engine.store.put('qualification', runId, report); return report;
}
