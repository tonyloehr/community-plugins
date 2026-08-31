import { z } from 'zod/v4';
import type { AutomationPrepareContext, PreparedAutomationJob } from './cloud-automation.js';
import type { CloudJobRecord } from './cloud-coordinator.js';
import { cloudHash, redactCloudData } from './cloud-http.js';
import { FusionError, assertJson, hash, redact } from './safety.js';

const ref = z.string().min(1).max(2048);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const variantId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const inputs = z.record(z.string().min(1).max(256), z.union([z.string().max(8192), z.number().finite(), z.boolean()]));
export const cloudBatchPrepareSchema = z.strictObject({
  request_key: z.string().regex(/^[A-Za-z0-9._:-]{8,160}$/),
  recipe_id: ref,
  context: z.strictObject({
    tenantId: ref,
    sources: z.array(z.strictObject({ hubId: ref, projectId: ref, itemId: ref, versionId: ref, configurationId: ref.nullable(), resourceHash: sha })).max(100),
    destinationAlias: ref,
    requireHardCap: z.boolean().optional(),
    requireImmutableEngine: z.boolean().optional(),
    requireImmutableDependencies: z.boolean().optional()
  }),
  variants: z.array(z.strictObject({ variant_id: variantId, inputs })).min(1).max(100)
});
export type CloudBatchPrepareInput = z.infer<typeof cloudBatchPrepareSchema>;
export type CloudBatchRequest = Omit<CloudBatchPrepareInput, 'request_key'>;
export interface CloudBatchOwner { batch_id: string; variant_id: string; request_hash: string }
export interface CloudBatchVariant {
  variant_id: string;
  idempotency_key: string;
  /** Immutable initial job, used only before the materialization fence is sealed. */
  initial_job: CloudJobRecord;
}
export interface CloudBatchRecord {
  schema_version: 1;
  id: string;
  plan_hash: string;
  request_hash: string;
  request_key_hash: string;
  request: CloudBatchRequest;
  created_at: string;
  expires_at: string;
  profile_id: string;
  profile_hash: string;
  scope_hash: string;
  authorization_binding: string;
  budget_period: string;
  currency: string;
  estimated_reservation: number;
  variants: CloudBatchVariant[];
  /** Progress is separate from immutable plan content; it does not grant submission authority. */
  phase: 'materializing' | 'ready';
}

/** Separate durable evidence keeps the original batch plan/hash immutable. */
export interface CloudBatchConflictRecord {
  schema_version: 1;
  id: string;
  batch_id: string;
  batch_plan_hash: string;
  request_hash: string;
  detected_at: string;
  trigger_job_id: string;
  code: 'OUTPUT_IDENTITY_CONFLICT';
  source: 'trusted_output_validator';
  resolution: 'blocked_no_reconciliation_api';
  candidate_receipt_sha256: string;
  conflicts: { artifact_id: string; job_ids: string[] }[];
  job_bindings: { job_id: string; plan_hash: string; validation_receipt_sha256: string }[];
  receipt_hash: string;
}
export function cloudBatchConflictBinding(record: CloudBatchConflictRecord): unknown {
  const { receipt_hash: _receiptHash, ...fields } = record;
  return fields;
}
/** May validate the standalone receipt for retention; admission also passes its owning batch. */
export function assertCloudBatchConflictIntegrity(record: CloudBatchConflictRecord, batch?: CloudBatchRecord): void {
  try {
    assertJson(record, 2_097_152);
    const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const jobId = (value: unknown) => typeof value === 'string' && /^cloudjob_[a-f0-9-]{36}$/.test(value);
    if (record.schema_version !== 1 || !/^cloudbatch_[a-f0-9]{64}$/.test(record.id) || record.id !== record.batch_id || !digest(record.batch_plan_hash) || !digest(record.request_hash) || !digest(record.candidate_receipt_sha256) || !jobId(record.trigger_job_id) || record.code !== 'OUTPUT_IDENTITY_CONFLICT' || record.source !== 'trusted_output_validator' || record.resolution !== 'blocked_no_reconciliation_api' || !Number.isFinite(Date.parse(record.detected_at)) || hash(cloudBatchConflictBinding(record)) !== record.receipt_hash) throw new FusionError('BATCH_CONFLICT_TAMPERED', 'The durable output-conflict receipt changed or has an invalid binding.');
    if (!Array.isArray(record.conflicts) || record.conflicts.length < 1 || record.conflicts.length > 100 || new Set(record.conflicts.map(conflict => conflict.artifact_id)).size !== record.conflicts.length || record.conflicts.some(conflict => typeof conflict.artifact_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,2047}$/.test(conflict.artifact_id) || conflict.artifact_id.includes('://') || /token|secret|bearer/i.test(conflict.artifact_id) || !Array.isArray(conflict.job_ids) || conflict.job_ids.length < 2 || conflict.job_ids.length > 100 || new Set(conflict.job_ids).size !== conflict.job_ids.length || !conflict.job_ids.every(jobId) || !conflict.job_ids.includes(record.trigger_job_id))) throw new FusionError('BATCH_CONFLICT_TAMPERED', 'Output-conflict identities are incomplete or unbounded.');
    const involved = new Set(record.conflicts.flatMap(conflict => conflict.job_ids));
    if (!Array.isArray(record.job_bindings) || record.job_bindings.length !== involved.size || new Set(record.job_bindings.map(job => job.job_id)).size !== involved.size || record.job_bindings.some(job => !involved.has(job.job_id) || !digest(job.plan_hash) || !digest(job.validation_receipt_sha256)) || record.job_bindings.find(job => job.job_id === record.trigger_job_id)?.validation_receipt_sha256 !== record.candidate_receipt_sha256) throw new FusionError('BATCH_CONFLICT_TAMPERED', 'Output-conflict job/evidence bindings are incomplete.');
    if (batch && (record.batch_id !== batch.id || record.batch_plan_hash !== batch.plan_hash || record.request_hash !== batch.request_hash || record.job_bindings.some(job => !batch.variants.some(variant => variant.initial_job.id === job.job_id && variant.initial_job.plan_hash === job.plan_hash)))) throw new FusionError('BATCH_CONFLICT_TAMPERED', 'Output-conflict evidence belongs to another immutable batch or child plan.');
  } catch (error) {
    if (error instanceof FusionError) throw error;
    throw new FusionError('BATCH_CONFLICT_TAMPERED', 'The durable output-conflict receipt is incomplete.');
  }
}

export function parseCloudBatchInput(value: unknown): CloudBatchPrepareInput {
  assertJson(value, 2_097_152);
  const parsed = cloudBatchPrepareSchema.safeParse(value);
  if (!parsed.success) throw new FusionError('INVALID_BATCH_INPUT', 'A batch requires a bounded reviewed recipe, frozen context, unique variant IDs and scalar input sets.');
  if (new Set(parsed.data.variants.map(variant => variant.variant_id)).size !== parsed.data.variants.length) throw new FusionError('DUPLICATE_VARIANT', 'Every batch variant requires a distinct explicit identity.');
  return parsed.data;
}
export function cloudBatchId(profileId: string, requestKeyHash: string): string {
  return `cloudbatch_${hash({ profile_id: profileId, request_key_hash: requestKeyHash })}`;
}
export function cloudBatchChildKey(batchId: string, variant: string): string {
  return `batch:${hash({ batch_id: batchId, variant_id: variant })}`;
}
export function cloudBatchBinding(batch: CloudBatchRecord): unknown {
  const { plan_hash: _planHash, phase: _phase, ...immutable } = batch;
  return immutable;
}
export function cloudBatchContext(request: CloudBatchRequest): AutomationPrepareContext {
  return { ...structuredClone(request.context), variantCount: 1 };
}

/** Compare actual prepared evidence with the requested variant, not a model-supplied success flag. */
export function assertPreparedBatchVariant(request: CloudBatchRequest, variant: CloudBatchRequest['variants'][number], prepared: PreparedAutomationJob): void {
  assertJson(prepared, 2_097_152);
  const { requestHash, ...fields } = prepared;
  if (cloudHash(fields) !== requestHash || prepared.recipeId !== request.recipe_id || hash(prepared.inputs) !== hash(variant.inputs) || hash(prepared.context) !== hash(cloudBatchContext(request))) throw new FusionError('BATCH_BINDING_CHANGED', 'A prepared child does not match the exact requested recipe, parameters or frozen source context.');
  if (prepared.destination.kind !== 'object_storage' || prepared.destination.alias !== request.context.destinationAlias) throw new FusionError('BATCH_STAGING_REQUIRED', 'Batches require a reviewed object-storage staging destination; saving or publishing Fusion project results is outside this batch contract.');
  if (typeof prepared.reservation.currency !== 'string' || !Number.isFinite(prepared.reservation.amount) || prepared.reservation.amount < 0 || !['estimated', 'provider_enforced'].includes(prepared.reservation.kind) || prepared.reservation.hardCap !== (prepared.reservation.kind === 'provider_enforced')) throw new FusionError('INVALID_JOB_RECORD', 'The prepared batch cost evidence is invalid.');
  if (request.context.requireHardCap && !prepared.reservation.hardCap) throw new FusionError('BUDGET_UNENFORCEABLE', 'A required hard cap cannot be replaced with an estimated batch admission budget.');
  if (request.context.requireImmutableEngine && (prepared.activity.rollingEngine || prepared.activity.engine.endsWith('+Latest')) || request.context.requireImmutableDependencies && prepared.activity.aliasRacePossible) throw new FusionError('IMMUTABILITY_UNAVAILABLE', 'Prepared activity evidence does not satisfy the batch\'s required immutable engine or dependency binding.');
  if (typeof prepared.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(prepared.id) || !/^[a-f0-9]{64}$/.test(prepared.recipeHash)) throw new FusionError('BATCH_IDENTITY_CONFLICT', 'The prepared provider request or recipe identity is invalid.');
  if (!Number.isFinite(Date.parse(prepared.createdAt)) || !Number.isFinite(Date.parse(prepared.expiresAt))) throw new FusionError('PLAN_EXPIRED', 'Prepared batch evidence has no usable freshness interval.');
}
function activityBinding(prepared: PreparedAutomationJob): unknown {
  const { observedAt: _observed, ...identity } = prepared.activity;
  return identity;
}

/** Stored hashes detect changed records; they are not authentication against the local host owner. */
export function assertCloudBatchIntegrity(batch: CloudBatchRecord): void {
  try {
    assertJson(batch, 4_194_304);
    if (!batch || batch.schema_version !== 1 || !['materializing', 'ready'].includes(batch.phase) || !/^[a-f0-9]{64}$/.test(batch.request_key_hash) || cloudBatchId(batch.profile_id, batch.request_key_hash) !== batch.id || hash(cloudBatchBinding(batch)) !== batch.plan_hash || hash(batch.request) !== batch.request_hash) throw new FusionError('BATCH_TAMPERED', 'The stored batch identity or immutable plan hash changed.');
    const request = parseCloudBatchInput({ ...batch.request, request_key: 'record-validation' });
    if (batch.variants.length !== request.variants.length || !Number.isFinite(Date.parse(batch.created_at)) || !Number.isFinite(Date.parse(batch.expires_at))) throw new FusionError('BATCH_TAMPERED', 'The batch variant count or freshness interval changed.');
    const jobIds = new Set<string>(), requestIds = new Set<string>(), requestHashes = new Set<string>();
    let amount = 0;
    const first = batch.variants[0]!.initial_job;
    for (const [index, variant] of batch.variants.entries()) {
      const requested = request.variants[index]!, job = variant.initial_job;
      if (variant.variant_id !== requested.variant_id || variant.idempotency_key !== cloudBatchChildKey(batch.id, variant.variant_id) || job.status !== 'prepared' || job.submitted !== false || job.reserved_units !== 0 || job.idempotency_key !== undefined || job.provider_id !== undefined || job.provider !== undefined || job.validation !== undefined || job.settlement !== undefined || job.cancellation !== undefined || job.error !== undefined || job.validation_in_progress !== undefined || job.output_identity_conflict !== undefined || job.validation_usable !== undefined || hash(job.batch) !== hash({ batch_id: batch.id, variant_id: variant.variant_id, request_hash: batch.request_hash })) throw new FusionError('BATCH_TAMPERED', 'The immutable variant/job mapping or initial child state changed.');
      if (job.profile_id !== batch.profile_id || job.profile_hash !== batch.profile_hash || job.scope_hash !== batch.scope_hash || job.authorization_binding !== batch.authorization_binding || job.budget_period !== batch.budget_period || job.prepared.reservation.currency !== batch.currency) throw new FusionError('BATCH_TAMPERED', 'A child has a different profile, account or cost scope.');
      assertPreparedBatchVariant(batch.request, requested, job.prepared);
      if (job.prepared.recipeVersion !== first.prepared.recipeVersion || job.prepared.recipeHash !== first.prepared.recipeHash || hash(job.prepared.destination) !== hash(first.prepared.destination) || hash(activityBinding(job.prepared)) !== hash(activityBinding(first.prepared))) throw new FusionError('BATCH_BINDING_CHANGED', 'The reviewed recipe, activity, dependencies or staging destination changed during whole-batch preparation.');
      if (jobIds.has(job.id) || requestIds.has(job.prepared.id) || requestHashes.has(job.prepared.requestHash)) throw new FusionError('BATCH_IDENTITY_CONFLICT', 'Each variant requires its own immutable job and provider request identity.');
      jobIds.add(job.id); requestIds.add(job.prepared.id); requestHashes.add(job.prepared.requestHash);
      amount += job.prepared.reservation.amount;
    }
    if (!Number.isFinite(amount) || amount !== batch.estimated_reservation) throw new FusionError('BATCH_TAMPERED', 'The aggregate batch reservation differs from its child plans.');
  } catch (error) {
    if (error instanceof FusionError) throw error;
    throw new FusionError('BATCH_TAMPERED', 'The stored batch is not a complete valid immutable manifest.');
  }
}

/** Only explicit artifact IDs count as output identity. Equal content hashes may be legitimate variants. */
export function batchArtifactConflicts(jobs: readonly (CloudJobRecord | undefined)[]): { artifact_id: string; job_ids: string[] }[] {
  const owners = new Map<string, Set<string>>();
  for (const job of jobs) for (const artifact of job?.validation?.artifacts ?? []) {
    const ids = owners.get(artifact.artifact_id) ?? new Set<string>(); ids.add(job!.id); owners.set(artifact.artifact_id, ids);
  }
  return [...owners].filter(([, ids]) => ids.size > 1).map(([artifact_id, ids]) => ({ artifact_id, job_ids: [...ids] }));
}
export function batchErrorCode(error: unknown): { code: string; outcome: string } {
  const candidate = error as { code?: unknown; outcome?: unknown } | undefined;
  return { code: typeof candidate?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(candidate.code) ? candidate.code : 'CLOUD_OPERATION_FAILED', outcome: typeof candidate?.outcome === 'string' && ['none', 'partial', 'unknown'].includes(candidate.outcome) ? candidate.outcome : 'unknown' };
}

function inlineWithin(value: unknown, bytes: number, maximumNodes: number): boolean {
  if (Buffer.byteLength(JSON.stringify(value)) > bytes) return false;
  let nodes = 0;
  const visit = (current: unknown): boolean => {
    if (++nodes > maximumNodes) return false;
    return current === null || typeof current !== 'object' || Object.values(current).every(visit);
  };
  return visit(value);
}
function shortText(value: string, maximumBytes = 2048): string | null {
  return typeof value === 'string' && Buffer.byteLength(value) <= maximumBytes ? value : null;
}
function validationSummary(job: CloudJobRecord | undefined, usable: boolean) {
  const receipt = job?.validation;
  if (!job || !receipt) return null;
  const passed = receipt.checks.filter(check => check.outcome === 'passed').length;
  const failed = receipt.checks.filter(check => check.outcome === 'failed').length;
  return {
    kind: 'validation_receipt_summary' as const, receipt_hash: receipt.receipt_hash,
    observed_at: shortText(receipt.observed_at, 128),
    outcome: receipt.checks.length > 0 && passed === receipt.checks.length ? 'passed' : failed > 0 ? 'failed' : 'unresolved',
    usable_for_acceptance: usable,
    check_counts: { total: receipt.checks.length, passed, failed },
    artifact_count: receipt.artifacts.length, artifact_bytes: receipt.artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0),
    full_receipt_included: false as const, inspect_job_id: job.id,
  };
}
function billingSummary(job: CloudJobRecord | undefined) {
  const receipt = job?.settlement;
  if (!job || !receipt) return null;
  return { kind: 'billing_receipt_summary' as const, receipt_hash: receipt.receipt_hash, observed_at: shortText(receipt.observed_at, 128), actual_amount: receipt.actual_amount, currency: receipt.currency, source: receipt.source, final: receipt.final, full_receipt_included: false as const, inspect_job_id: job.id };
}

export function inspectCloudBatch(batch: CloudBatchRecord, jobs: readonly (CloudJobRecord | undefined)[], conflict?: CloudBatchConflictRecord) {
  const artifactConflicts = conflict?.conflicts ?? batchArtifactConflicts(jobs);
  const validationUnknown = jobs.some(job => job?.validation_in_progress);
  const variants = batch.variants.map((variant, index) => {
    const job = jobs[index];
    const inputs = variant.initial_job.prepared.inputs;
    const inputComplete = Object.keys(inputs).length <= 32 && inlineWithin(inputs, 8192, 33);
    const usable = job?.status === 'succeeded' && !!job.validation && !job.output_identity_conflict && !validationUnknown;
    const reservation = variant.initial_job.prepared.reservation;
    return {
      variant_id: variant.variant_id, job_id: variant.initial_job.id, plan_hash: variant.initial_job.plan_hash, request_hash: variant.initial_job.prepared.requestHash,
      inputs: inputComplete ? inputs : null,
      input_summary: { sha256: hash(inputs), field_count: Object.keys(inputs).length, inline_complete: inputComplete, inspect_job_id: variant.initial_job.id },
      status: job?.status ?? 'not_materialized', submitted: job?.submitted ?? false,
      provider_id: job?.provider_id ?? null, reservation: { amount: reservation.amount, currency: reservation.currency, kind: reservation.kind, hardCap: reservation.hardCap }, reserved_units: job?.reserved_units ?? 0,
      validation: validationSummary(job, usable), settlement: billingSummary(job), cancellation: job?.cancellation ? { attempted_at: shortText(job.cancellation.attempted_at, 128), acknowledgement: job.cancellation.acknowledgement } : null,
      validation_usable: usable,
      validation_disposition: job?.output_identity_conflict ? 'historical_conflicted' : job?.validation ? 'accepted_receipt' : 'not_recorded',
      validation_outcome_unknown: !!job?.validation_in_progress,
      output_identity_conflict: job?.output_identity_conflict ?? null,
      // Raw provider messages can contain secrets and URLs outside the adapter contract.
      error: job?.error ? batchErrorCode(job.error) : null
    };
  });
  const count = (...states: string[]) => variants.filter(variant => states.includes(variant.status)).length;
  const allValidated = jobs.length === batch.variants.length && jobs.every(job => job?.status === 'succeeded' && job.validation?.checks.every(check => check.outcome === 'passed') && !job.output_identity_conflict && !job.validation_in_progress) && artifactConflicts.length === 0;
  const unsettled = jobs.filter(job => job?.submitted && !job.settlement).length;
  const initial = batch.variants[0]!.initial_job;
  const contextComplete = inlineWithin(batch.request.context, 32_768, 1024);
  const destinationComplete = inlineWithin(initial.prepared.destination, 8192, 64);
  const preparedWarnings = initial.prepared.warnings;
  const inlineWarnings = preparedWarnings.filter(warning => typeof warning === 'string' && Buffer.byteLength(warning) <= 1024).slice(0, 8);
  const view = {
    schema_version: 1, id: batch.id, plan_hash: batch.plan_hash, request_hash: batch.request_hash, phase: batch.phase,
    recipe_id: batch.request.recipe_id, recipe_version: shortText(initial.prepared.recipeVersion), recipe_version_sha256: hash(initial.prepared.recipeVersion), recipe_hash: initial.prepared.recipeHash,
    profile_id: batch.profile_id, created_at: batch.created_at, expires_at: batch.expires_at, context: contextComplete ? batch.request.context : null,
    context_summary: { sha256: hash(batch.request.context), hash_basis: 'batch_context_without_variantCount', source_count: batch.request.context.sources.length, inline_complete: contextComplete, inspect_job_id: initial.id },
    destination: destinationComplete ? initial.prepared.destination : null,
    destination_summary: { sha256: hash(initial.prepared.destination), inline_complete: destinationComplete, inspect_job_id: initial.id },
    admission_estimate: { amount: batch.estimated_reservation, currency: batch.currency, budget_period: batch.budget_period, reserved_at_preparation: false, all_child_caps_provider_enforced: batch.variants.every(variant => variant.initial_job.prepared.reservation.hardCap) },
    variants,
    progress: { total: variants.length, not_materialized: count('not_materialized'), prepared: count('prepared'), active: count('submitting', 'queued', 'running', 'cancel_requested'), uncertain: variants.filter(variant => ['submitting', 'outcome_unknown'].includes(variant.status) || variant.validation_outcome_unknown).length, validating: count('validating'), succeeded: count('succeeded'), failed: count('failed'), cancelled: count('cancelled'), unsettled_submitted_jobs: unsettled },
    all_outputs_validated: allValidated, billing_settled: unsettled === 0 && variants.every(variant => variant.status !== 'prepared' && variant.status !== 'not_materialized'),
    output_identity_conflicts: artifactConflicts, publication_performed: false,
    output_conflict_receipt: conflict ? { id: conflict.id, receipt_hash: conflict.receipt_hash, detected_at: conflict.detected_at, resolution: conflict.resolution } : null,
    projection: { kind: 'bounded_batch_summary', all_variants_included: true, full_validation_receipts_included: false, full_billing_receipts_included: false, credential_redaction_applied: true, max_response_bytes: 4_194_304, max_json_nodes: 50_000, details_tool: 'fusion_cloud_job_inspect' },
    prepared_warning_summary: { sha256: hash(preparedWarnings), total_count: preparedWarnings.length, inline_count: inlineWarnings.length, inline_complete: inlineWarnings.length === preparedWarnings.length, inspect_job_id: initial.id },
    warnings: ['Each prepared variant is a separate workitem. There is no whole-batch rollback or automatic retry.', 'Results remain in the approved staging destination. Validation and billing reconciliation are separate trusted steps.', 'The existing transfer contract exposes no final output key before submission; the trusted stager must isolate each prepared request. Artifact identity collisions are checked when validation evidence supplies identities.', ...inlineWarnings]
  };
  // Return only a safe view; local immutable hashes continue to bind the original stored bytes.
  const cleaned = JSON.parse(JSON.stringify(redactCloudData(redact(view)))) as typeof view;
  assertJson(cleaned, 4_194_304);
  return cleaned;
}
export type CloudBatchInspection = ReturnType<typeof inspectCloudBatch>;
