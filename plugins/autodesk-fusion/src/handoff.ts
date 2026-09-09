import { z } from 'zod/v4';
import { getOperation, parseOperation } from './catalog.js';
import { FusionError, assertJson, errorResult, hash, newId, now, redact } from './safety.js';
import type { ArtifactReservation } from './artifacts.js';
import type { ManagedPlan } from './engine.js';
import type { RecordStore } from './storage.js';
import type { OperationInput } from './types.js';

const ref = z.string().min(1).max(128);
const label = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().min(1).max(4_000);
const refs = z.array(ref).max(100).default([]);
const labels = z.array(label).max(50).default([]);
const pointer = z.string().max(512).refine(value => (value === '' || value.startsWith('/')) && !/~(?![01])/u.test(value), 'Use a valid JSON pointer.');
const operationRequest = z.strictObject({ operation: ref, document_id: ref, args: z.record(z.string(), z.unknown()), expected_state: ref.optional() });

export const handoffAssertionSchema = z.union([
  z.strictObject({ kind: z.literal('equals'), pointer, expected: z.union([z.string().max(2_000), z.boolean(), z.null()]) }),
  z.strictObject({ kind: z.literal('numeric_range'), pointer, minimum: z.number().finite().optional(), maximum: z.number().finite().optional(), unit: z.strictObject({ pointer, expected: z.string().min(1).max(64) }) })
    .refine(value => value.minimum !== undefined || value.maximum !== undefined, 'A numeric bound is required.')
    .refine(value => value.minimum === undefined || value.maximum === undefined || value.minimum <= value.maximum, 'Minimum must not exceed maximum.')
]);
const commonCheck = { id: label, requirement_ids: labels, artifact_ids: refs, reviewer_id: label.optional() };
export const handoffInputSchema = z.strictObject({
  title: z.string().min(1).max(300),
  plan_ids: refs,
  document_ids: z.array(ref).max(20).default([]),
  requirements: z.array(z.strictObject({ id: label, statement: text, reference: z.string().max(2_048).optional() })).max(50).default([]),
  assumptions: z.array(z.strictObject({ id: label, statement: text, requirement_ids: labels })).max(50).default([]),
  reviewers: z.array(z.strictObject({ id: label, label: z.string().min(1).max(300), role: z.string().min(1).max(200), requirement_ids: labels })).max(30).default([]),
  checks: z.array(z.union([
    z.strictObject({ ...commonCheck, kind: z.literal('typed_read'), request: operationRequest, assertions: z.array(handoffAssertionSchema).min(1).max(20) }),
    z.strictObject({ ...commonCheck, kind: z.literal('manual'), procedure: text })
  ])).max(50).default([]),
  external_evidence: z.array(z.strictObject({ id: label, description: text, reference: z.string().min(1).max(2_048), reported_sha256: digest.optional(), requirement_ids: labels })).max(50).default([])
});

export type HandoffInput = z.infer<typeof handoffInputSchema>;
type HandoffCheck = HandoffInput['checks'][number];
type Assertion = z.infer<typeof handoffAssertionSchema>;
type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;
const READ_CHECKS = new Set(['document.inspect', 'parameters.list', 'geometry.measure', 'geometry.check', 'cam.inspect']);

export interface HandoffContext {
  profileId: string;
  profileHash: string;
  handlerHash: string;
  executionContractHash: string;
  verifyAccess(): Promise<void>;
  authorizeDocument(documentId: string): Promise<void>;
  inspectPlan(id: string): Promise<ManagedPlan>;
  read(request: OperationInput): Promise<unknown>;
  inspectArtifact(id: string): Promise<ArtifactReservation>;
}
export interface HandoffSource {
  document_id: string;
  state: string | null;
  observed_at: string;
  observation_sha256: string | null;
  metadata: JsonRecord;
  evidence: string;
  engineering_qualified: false;
  status: 'observed' | 'incomplete' | 'unavailable';
  freshness: HandoffFreshness | null;
  collection_check: { status: 'matching' | 'unavailable_or_changed'; observed_at: string; state: string | null; freshness: HandoffFreshness | null };
  error?: ReturnType<typeof errorResult>;
}
export interface HandoffFreshness {
  status: 'complete' | 'incomplete';
  freshness_scope: JsonRecord | null;
  freshness_gaps: string[];
  freshness_unavailable: string | null;
  issues: string[];
}
export interface HandoffCheckResult {
  id: string;
  kind: HandoffCheck['kind'];
  requirement_ids: string[];
  artifact_ids: string[];
  reviewer_id: string | null;
  status: 'criteria_met' | 'criteria_not_met' | 'incomplete' | 'not_run';
  source_document_id: string | null;
  source_state: string | null;
  observed_at: string | null;
  observation_sha256: string | null;
  evidence: string;
  engineering_qualified: false;
  freshness: HandoffFreshness | null;
  assertions: Array<{ criterion: Assertion; result: 'met' | 'not_met' | 'unresolved'; actual: unknown; actual_unit: unknown; reason?: string }>;
  procedure?: string;
  error?: ReturnType<typeof errorResult>;
}
export interface HandoffManifest {
  schema_version: 2;
  id: string;
  created_at: string;
  state: 'draft';
  title: string;
  profile_id: string;
  profile_hash: string;
  handler_sha256: string;
  execution_contract_sha256: string;
  integrity: string;
  input: HandoffInput;
  sources: HandoffSource[];
  plans: JsonRecord[];
  artifacts: JsonRecord[];
  checks: HandoffCheckResult[];
  requirements: JsonRecord[];
  assumptions: JsonRecord[];
  reviewer_assignments: JsonRecord[];
  external_evidence: JsonRecord[];
  unresolved: Array<{ code: string; reference: string; message: string }>;
  engineering_approval: false;
  regulatory_compliance_established: false;
  external_release_performed: false;
  portability: JsonRecord;
  limitations: string[];
}

function unique(values: string[], description: string): void {
  if (new Set(values).size !== values.length) throw new FusionError('INVALID_HANDOFF', `${description} must be unique.`);
}
function parseInput(input: unknown): HandoffInput {
  assertJson(input, 1_048_576);
  const parsed = handoffInputSchema.safeParse(input);
  if (!parsed.success) throw new FusionError('INVALID_HANDOFF', 'Engineering handoff input does not match its bounded schema.');
  const value = parsed.data;
  for (const [description, entries] of [['plan references', value.plan_ids], ['document references', value.document_ids], ['requirements', value.requirements.map(x => x.id)], ['checks', value.checks.map(x => x.id)], ['reviewers', value.reviewers.map(x => x.id)], ['assumptions', value.assumptions.map(x => x.id)], ['external evidence', value.external_evidence.map(x => x.id)]] as const) unique([...entries], description);
  const requirements = new Set(value.requirements.map(x => x.id)), reviewers = new Set(value.reviewers.map(x => x.id));
  for (const item of [...value.assumptions, ...value.reviewers, ...value.checks, ...value.external_evidence]) {
    unique(item.requirement_ids, 'Linked requirements');
    if (item.requirement_ids.some(id => !requirements.has(id))) throw new FusionError('INVALID_HANDOFF', 'An evidence entry refers to an undeclared requirement.');
  }
  for (const check of value.checks) {
    unique(check.artifact_ids, 'Check artifact references');
    if (check.reviewer_id && !reviewers.has(check.reviewer_id)) throw new FusionError('INVALID_HANDOFF', 'A check refers to an undeclared reviewer.');
    if (check.kind === 'typed_read') {
      const operation = parseOperation(check.request);
      if (getOperation(operation.operation).effect !== 'read' || !READ_CHECKS.has(operation.operation)) throw new FusionError('UNSUPPORTED_HANDOFF_CHECK', 'Handoff checks are limited to documented inspection, parameter, measurement, model-health and CAM-inspection reads. Use a manual procedure for unavailable solvers or other workflows.');
      for (const assertion of check.assertions) for (const value of [assertion.pointer, ...(assertion.kind === 'numeric_range' ? [assertion.unit.pointer] : [])]) {
        if (value.split('/').length > 33 || value.split('/').some(part => ['__proto__', 'constructor', 'prototype'].includes(part.replaceAll('~1', '/').replaceAll('~0', '~')))) throw new FusionError('INVALID_HANDOFF', 'Assertion pointers must remain within bounded own JSON properties.');
        if (!visibleAssertionPointer(value)) throw new FusionError('INVALID_HANDOFF', 'Assertion value and unit pointers cannot traverse credential-redacted properties or contain credential-bearing text.');
      }
    }
  }
  return value;
}

function atPointer(value: unknown, pointer: string): { found: boolean; value?: unknown } {
  let current = value;
  for (const raw of pointer === '' ? [] : pointer.slice(1).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key) || ['__proto__', 'constructor', 'prototype'].includes(key)) return { found: false };
    current = (current as JsonRecord)[key];
  }
  return { found: true, value: current };
}
function visibleAssertionPointer(pointer: string): boolean {
  // Probe property context using the ordinary output redactor. Selecting a
  // hidden field must not turn its raw value into a public generic `actual`.
  let probe: unknown = true;
  for (const key of (pointer === '' ? [] : pointer.slice(1).split('/')).reverse()) probe = { [key.replaceAll('~1', '/').replaceAll('~0', '~')]: probe };
  const selected = atPointer(redact(probe), pointer);
  return redact(pointer) === pointer && selected.found && selected.value === true;
}
function scalar(value: unknown): unknown {
  return value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.length <= 2_000 ? value : null;
}
function assessAssertion(payload: unknown, cleanedPayload: unknown, criterion: Assertion): HandoffCheckResult['assertions'][number] {
  const rawActual = atPointer(payload, criterion.pointer), actual = atPointer(cleanedPayload, criterion.pointer);
  const rawUnit = criterion.kind === 'numeric_range' ? atPointer(payload, criterion.unit.pointer) : { found: false };
  const unit = criterion.kind === 'numeric_range' ? atPointer(cleanedPayload, criterion.unit.pointer) : { found: false };
  const cleanedCriterion = redact(criterion) as Assertion;
  const result: HandoffCheckResult['assertions'][number] = { criterion: cleanedCriterion, result: 'unresolved', actual: actual.found ? scalar(actual.value) : null, actual_unit: unit.found ? scalar(unit.value) : null };
  const changed = (raw: ReturnType<typeof atPointer>, cleaned: ReturnType<typeof atPointer>) => raw.found !== cleaned.found || raw.found && scalar(raw.value) !== scalar(cleaned.value);
  if (changed(rawActual, actual) || changed(rawUnit, unit) || hash(criterion) !== hash(cleanedCriterion)) return { ...result, reason: 'Credential redaction altered the observation, unit or criterion. No comparison of hidden values was retained.' };
  if (!actual.found) return { ...result, reason: 'The requested observation is absent.' };
  if (typeof actual.value === 'string' && actual.value.length > 2_000) return { ...result, reason: 'The observed string exceeds the bounded scalar evidence limit.' };
  if (criterion.kind === 'equals') {
    if (actual.value !== null && !['string', 'boolean'].includes(typeof actual.value)) return { ...result, reason: 'The observed value has no admitted comparison type.' };
    return { ...result, result: actual.value === criterion.expected ? 'met' : 'not_met' };
  }
  if (!unit.found || unit.value !== criterion.unit.expected) return { ...result, reason: 'The exact observed unit is absent or differs; no implicit unit conversion was made.' };
  if (typeof actual.value !== 'number' || !Number.isFinite(actual.value)) return { ...result, reason: 'The observed quantity is not finite numeric data.' };
  return { ...result, result: (criterion.minimum === undefined || actual.value >= criterion.minimum) && (criterion.maximum === undefined || actual.value <= criterion.maximum) ? 'met' : 'not_met' };
}
function sourceMetadata(payload: unknown): JsonRecord {
  const data = record(record(payload)?.data) ?? {};
  const selected: JsonRecord = {};
  for (const key of ['document_id', 'session_id', 'name', 'creation_id', 'cloud', 'configuration', 'design_type', 'internal_units', 'display_length_unit', 'units', 'is_saved', 'is_modified', 'is_up_to_date', 'saved', 'fixture', 'provider', 'live_fusion_verified', 'freshness_semantics']) if (data[key] !== undefined) selected[key] = data[key];
  const cleaned = redact(selected); assertJson(cleaned, 65_536);
  return cleaned as JsonRecord;
}
function observationFreshness(payload: unknown): HandoffFreshness {
  const data = record(record(payload)?.data) ?? {};
  const result: HandoffFreshness = { status: 'complete', freshness_scope: null, freshness_gaps: [], freshness_unavailable: null, issues: [] };
  if (Object.hasOwn(data, 'freshness_scope')) {
    try {
      if (!record(data.freshness_scope)) throw new Error('shape');
      assertJson(data.freshness_scope, 16_384);
      result.freshness_scope = structuredClone(data.freshness_scope) as JsonRecord;
    } catch { result.issues.push('malformed_freshness_scope'); }
  }
  if (Object.hasOwn(data, 'freshness_gaps')) {
    const gaps = data.freshness_gaps;
    if (!Array.isArray(gaps) || gaps.length > 100 || gaps.some(gap => typeof gap !== 'string' || !gap.length || gap.length > 512) || new Set(gaps).size !== gaps.length) result.issues.push('malformed_freshness_gaps');
    else result.freshness_gaps = [...gaps];
  }
  if (Object.hasOwn(data, 'freshness_unavailable')) {
    if (typeof data.freshness_unavailable !== 'string' || !data.freshness_unavailable.length || data.freshness_unavailable.length > 4_000) result.issues.push('malformed_freshness_unavailable');
    else result.freshness_unavailable = data.freshness_unavailable;
  }
  if (result.freshness_gaps.length || result.issues.length || result.freshness_unavailable !== null) result.status = 'incomplete';
  return result;
}
function sameFreshness(left: HandoffFreshness | null, right: HandoffFreshness | null): boolean {
  return left?.status === 'complete' && right?.status === 'complete' && hash(left) === hash(right);
}
function payloadState(payload: unknown): string | null {
  const state = record(payload)?.state;
  return typeof state === 'string' && state.length > 0 && state.length <= 128 ? state : null;
}
function planDocumentIds(plan: ManagedPlan): string[] {
  const ids = new Set(plan.operation.document_id ? [plan.operation.document_id] : []);
  if (plan.status === 'succeeded' && ['documents.create', 'documents.import'].includes(plan.operation.operation)) {
    const data = record(record(plan.result)?.data);
    const created = plan.operation.operation === 'documents.import' ? record(data?.document)?.document_id : data?.document_id;
    if (typeof created === 'string' && created.length > 0 && created.length <= 128) ids.add(created);
  }
  return [...ids].sort();
}
function planSummary(plan: ManagedPlan, sources: readonly HandoffSource[], context: HandoffContext): JsonRecord {
  const result = record(plan.result), after = record(result?.after);
  const recorded = typeof after?.state === 'string' ? after.state : typeof result?.state === 'string' ? result.state : plan.status === 'prepared' ? plan.expected_state ?? null : null;
  const sourceIds = planDocumentIds(plan);
  const current = sourceIds.length === 1 ? sources.find(source => source.document_id === sourceIds[0]) : undefined;
  const contractCurrent = plan.handler_hash === context.handlerHash && plan.execution_contract_hash === context.executionContractHash;
  const fresh = !!recorded && current?.status === 'observed' && current.collection_check.status === 'matching' && recorded === current.state && contractCurrent;
  const job = record(result?.job), jobEvidence: JsonRecord = {};
  for (const key of ['id', 'provider', 'provider_id', 'document_id', 'status', 'created_at', 'updated_at', 'request_hash', 'execution_contract_hash', 'binding_hash', 'cancel_supported', 'submission_error']) if (job?.[key] !== undefined) jobEvidence[key] = job[key];
  return { id: plan.id, hash: plan.hash, record_sha256: hash(plan), operation: plan.operation, status: plan.status, handler_sha256: plan.handler_hash, execution_contract_sha256: plan.execution_contract_hash ?? null, recorded_source_state: recorded, source_document_ids: sourceIds, artifact_id: plan.artifact?.id ?? null, current_source_matches: !!fresh, outcome: record(result?.error)?.outcome ?? null, error: result?.error ?? null, effects: result?.effects ?? [], job: Object.keys(jobEvidence).length ? jobEvidence : null, completion: typeof result?.completion === 'string' ? result.completion : null, limitations: plan.limitations };
}
function artifactBinding(artifact: JsonRecord, plan: JsonRecord | undefined, sources: readonly HandoffSource[], context: Pick<HandoffContext, 'profileHash' | 'handlerHash' | 'executionContractHash'>): { status: 'matching' | 'historical_or_incomplete'; issues: string[]; source_document_id: string | null; source_state: string | null } {
  const issues: string[] = [], provenance = record(artifact.provenance), producer = record(provenance?.producer), source = record(provenance?.source);
  const documentId = typeof source?.document_id === 'string' ? source.document_id : null;
  const state = typeof source?.state_at_preparation === 'string' ? source.state_at_preparation : null;
  const observed = sources.find(item => item.document_id === documentId);
  const operation = record(plan?.operation);
  if (artifact.status !== 'succeeded') issues.push('artifact_not_complete');
  if (artifact.manifest_version !== 2 || provenance?.schema !== 1 || !producer || !source) issues.push('provenance_unavailable_or_legacy');
  if (!plan || plan.status !== 'succeeded' || artifact.producer_plan_hash !== plan.hash || producer?.plan_id !== plan.id || producer?.plan_hash !== plan.hash || producer?.operation !== operation?.operation) issues.push('producer_plan_mismatch_or_incomplete');
  if (producer?.profile_sha256 !== context.profileHash || producer?.handler_sha256 !== context.handlerHash || producer?.execution_contract_sha256 !== context.executionContractHash || plan?.handler_sha256 !== context.handlerHash || plan?.execution_contract_sha256 !== context.executionContractHash) issues.push('producer_implementation_changed');
  if (!documentId || operation?.document_id !== documentId || source?.observed_document_id !== documentId || !observed || observed.status !== 'observed' || observed.collection_check.status !== 'matching' || !state || state !== observed.state) issues.push('artifact_source_not_current');
  if (!state || source?.state_at_completion !== state || source?.completion_state_matches_preparation !== true) issues.push('artifact_completion_source_unconfirmed');
  return { status: issues.length ? 'historical_or_incomplete' : 'matching', issues, source_document_id: documentId, source_state: state };
}
function requirementCoverage(checks: readonly HandoffCheckResult[]): string {
  return !checks.length ? 'missing_checks' : checks.some(check => check.status === 'criteria_not_met') ? 'criteria_not_met' : checks.some(check => check.status !== 'criteria_met') ? 'incomplete' : 'observed_criteria_met';
}

const timestamp = z.string().datetime({ offset: true });
const nullableRef = ref.nullable(), nullableDigest = digest.nullable();
const boundedObject = (bytes: number) => z.record(z.string().max(256), z.unknown()).refine(value => {
  try { assertJson(value, bytes); return true; } catch { return false; }
}, 'Stored metadata exceeds its JSON bound.');
const storedError = z.strictObject({ code: z.string().min(1).max(512), message: z.string().max(4_000), outcome: z.enum(['none', 'partial', 'unknown']), details: z.unknown().optional() });
const freshnessSchema = z.strictObject({ status: z.enum(['complete', 'incomplete']), freshness_scope: boundedObject(16_384).nullable(), freshness_gaps: z.array(z.string().min(1).max(512)).max(100), freshness_unavailable: z.string().min(1).max(4_000).nullable(), issues: z.array(z.string().min(1).max(128)).max(10) });
const sourceSchema = z.strictObject({ document_id: ref, state: nullableRef, observed_at: timestamp, observation_sha256: nullableDigest, metadata: boundedObject(65_536), evidence: z.enum(['synthetic_fixture', 'provider_reported', 'unavailable']), engineering_qualified: z.literal(false), status: z.enum(['observed', 'incomplete', 'unavailable']), freshness: freshnessSchema.nullable(), collection_check: z.strictObject({ status: z.enum(['matching', 'unavailable_or_changed']), observed_at: timestamp, state: nullableRef, freshness: freshnessSchema.nullable() }), error: storedError.optional() });
const scalarSchema = z.union([z.string().max(2_000), z.number().finite(), z.boolean(), z.null()]);
const checkSchema = z.strictObject({ id: label, kind: z.enum(['typed_read', 'manual']), requirement_ids: z.array(label).max(50), artifact_ids: z.array(ref).max(100), reviewer_id: label.nullable(), status: z.enum(['criteria_met', 'criteria_not_met', 'incomplete', 'not_run']), source_document_id: nullableRef, source_state: nullableRef, observed_at: timestamp.nullable(), observation_sha256: nullableDigest, evidence: z.enum(['synthetic_fixture', 'provider_reported', 'unavailable', 'manual_review_required']), engineering_qualified: z.literal(false), freshness: freshnessSchema.nullable(), assertions: z.array(z.strictObject({ criterion: handoffAssertionSchema, result: z.enum(['met', 'not_met', 'unresolved']), actual: scalarSchema, actual_unit: scalarSchema, reason: z.string().max(4_000).optional() })).max(20), procedure: text.optional(), error: storedError.optional() });
const planSchema = z.strictObject({ id: ref, hash: digest, record_sha256: digest, operation: operationRequest.extend({ document_id: ref.optional() }), status: z.enum(['prepared', 'executing', 'pending', 'succeeded', 'failed', 'outcome_unknown']), handler_sha256: digest, execution_contract_sha256: nullableDigest, recorded_source_state: nullableRef, source_document_ids: z.array(ref).max(20), artifact_id: nullableRef, current_source_matches: z.boolean(), outcome: z.enum(['none', 'partial', 'unknown']).nullable(), error: storedError.nullable(), effects: z.array(z.string().max(4_000)).max(1_000), job: boundedObject(65_536).nullable(), completion: z.string().max(128).nullable(), limitations: z.array(z.string().max(4_000)).max(100) });
const artifactBindingSchema = z.strictObject({ status: z.enum(['matching', 'historical_or_incomplete']), issues: z.array(z.string().max(128)).max(20), source_document_id: nullableRef, source_state: nullableRef });
const artifactSchema = z.strictObject({ id: ref, status: z.enum(['prepared', 'generating', 'pending', 'succeeded', 'failed', 'unavailable']), manifest_version: z.union([z.literal(1), z.literal(2), z.null()]), manifest_sha256: nullableDigest, producer_plan_id: ref, producer_plan_hash: nullableDigest, completed_at: timestamp.nullable(), inspected_at: timestamp, receipt_sha256: nullableDigest, format: z.string().min(1).max(64).nullable(), filename: z.string().min(1).max(2_048).nullable(), files: z.array(boundedObject(65_536)).max(500), provenance: boundedObject(131_072).nullable(), validation: boundedObject(65_536).nullable(), limitation: z.string().max(4_000).nullable(), inspection: z.enum(['existing_receipt_checked_at_declared_grade', 'incomplete']), binding: artifactBindingSchema, error: storedError.optional() });
const manifestSchema = z.strictObject({
  schema_version: z.literal(2), id: z.string().regex(/^handoff_[a-f0-9-]{36}$/u), created_at: timestamp, state: z.literal('draft'), title: z.string().min(1).max(300), profile_id: z.string().min(1).max(160), profile_hash: digest, handler_sha256: digest, execution_contract_sha256: digest, integrity: digest, input: handoffInputSchema,
  sources: z.array(sourceSchema).max(20), plans: z.array(planSchema).max(100), artifacts: z.array(artifactSchema).max(100), checks: z.array(checkSchema).max(50),
  requirements: z.array(z.strictObject({ id: label, statement: text, reference: z.string().max(2_048).optional(), origin: z.literal('caller_supplied_requirement'), check_ids: z.array(label).max(50), coverage: z.enum(['missing_checks', 'criteria_not_met', 'incomplete', 'observed_criteria_met']), engineering_approval: z.literal(false) })).max(50),
  assumptions: z.array(z.strictObject({ id: label, statement: text, requirement_ids: z.array(label).max(50), origin: z.literal('caller_supplied_assumption'), verified: z.literal(false) })).max(50),
  reviewer_assignments: z.array(z.strictObject({ id: label, label: z.string().min(1).max(300), role: z.string().min(1).max(200), requirement_ids: z.array(label).max(50), origin: z.literal('requested_assignment_metadata'), notified: z.literal(false), review_performed: z.literal(false), approval_granted: z.literal(false) })).max(30),
  external_evidence: z.array(z.strictObject({ id: label, description: text, reference: z.string().min(1).max(2_048), reported_sha256: digest.optional(), requirement_ids: z.array(label).max(50), origin: z.literal('caller_supplied_reference'), bytes_read: z.literal(false), hash_verified: z.literal(false), engineering_qualified: z.literal(false) })).max(50),
  unresolved: z.array(z.strictObject({ code: ref, reference: z.string().min(1).max(160), message: text })).max(512), engineering_approval: z.literal(false), regulatory_compliance_established: z.literal(false), external_release_performed: z.literal(false),
  portability: z.strictObject({ format: z.literal('standalone_json_manifest'), artifact_storage_paths_included: z.literal(false), caller_supplied_references_may_be_paths: z.literal(true), referenced_artifact_bytes_copied: z.literal(false), provider_payloads: text }), limitations: z.array(text).max(50)
});

/** Pure bounded validation for inspection and retention. This performs no I/O. */
export function verifyHandoffManifest(value: unknown): HandoffManifest {
  assertJson(value, 4_194_304);
  const raw = record(value);
  if (!raw || raw.schema_version !== 2) throw new FusionError('LEGACY_HANDOFF', 'This record has no supported source-bound evidence schema. It is preserved without migration or a new validation grade.');
  const { integrity, ...content } = raw;
  if (typeof integrity !== 'string' || !/^[a-f0-9]{64}$/u.test(integrity) || hash(content) !== integrity) throw new FusionError('HANDOFF_CHANGED', 'The stored evidence package no longer matches its content hash.');
  const parsed = manifestSchema.safeParse(value);
  const invalid = (message: string): never => { throw new FusionError('INVALID_HANDOFF_MANIFEST', message); };
  if (!parsed.success) invalid('The stored engineering draft does not match its bounded strict schema.');
  const manifest = parsed.data as unknown as HandoffManifest;
  if (hash(manifest) !== hash(value)) invalid('Stored defaults or fields cannot be silently normalized or upgraded.');
  const input = parseInput(manifest.input);
  if (hash(input) !== hash(manifest.input) || input.title !== manifest.title) invalid('The stored normalized request differs from the recorded draft.');
  const sameSet = (left: readonly string[], right: readonly string[]) => left.length === right.length && new Set(left).size === left.length && new Set(right).size === right.length && hash([...left].sort()) === hash([...right].sort());
  for (const entries of [manifest.sources.map(item => item.document_id), manifest.plans.map(item => String(item.id)), manifest.artifacts.map(item => String(item.id)), manifest.checks.map(item => item.id)]) if (new Set(entries).size !== entries.length) invalid('Stored source, plan, artifact and check identities must be unique.');
  if (!sameSet(input.plan_ids, manifest.plans.map(plan => String(plan.id))) || !sameSet(input.checks.map(check => check.id), manifest.checks.map(check => check.id))) invalid('Stored plan/check selections differ from the original request.');
  const sourceIds = new Set(input.document_ids);
  for (const plan of manifest.plans) {
    parseOperation(plan.operation);
    const ids = plan.source_document_ids as string[];
    if (new Set(ids).size !== ids.length || record(plan.operation)?.document_id && !ids.includes(String(record(plan.operation)!.document_id))) invalid('A stored producing plan has inconsistent source identities.');
    ids.forEach(id => sourceIds.add(id));
    const source = ids.length === 1 ? manifest.sources.find(item => item.document_id === ids[0]) : undefined;
    const expected = !!plan.recorded_source_state && source?.status === 'observed' && source.collection_check.status === 'matching' && source.state === plan.recorded_source_state && plan.handler_sha256 === manifest.handler_sha256 && plan.execution_contract_sha256 === manifest.execution_contract_sha256;
    if (plan.current_source_matches !== !!expected) invalid('A plan freshness claim contradicts its recorded source or implementation.');
  }
  for (const check of input.checks) if (check.kind === 'typed_read') sourceIds.add(check.request.document_id);
  if (!sameSet([...sourceIds], manifest.sources.map(source => source.document_id))) invalid('Stored source coverage does not match the explicit document, plan and check selections.');
  const completeFreshness = (freshness: HandoffFreshness | null) => {
    if (!freshness) return false;
    const complete = freshness.freshness_gaps.length === 0 && freshness.issues.length === 0 && freshness.freshness_unavailable === null;
    if (new Set(freshness.freshness_gaps).size !== freshness.freshness_gaps.length || (freshness.status === 'complete') !== complete) invalid('Stored fingerprint coverage has contradictory status or duplicate gaps.');
    return complete;
  };
  for (const source of manifest.sources) {
    const complete = completeFreshness(source.freshness);
    completeFreshness(source.collection_check.freshness);
    if (source.status === 'observed' && (!source.state || !source.observation_sha256 || !complete) || source.status === 'unavailable' && source.state !== null) invalid('A stored source claim lacks a usable complete fingerprint.');
    if (source.collection_check.status === 'matching' && (source.status !== 'observed' || source.collection_check.state !== source.state || !sameFreshness(source.freshness, source.collection_check.freshness))) invalid('A matching collection claim contradicts its source coverage.');
  }
  const expectedArtifacts = manifest.plans.flatMap(plan => typeof plan.artifact_id === 'string' ? [plan.artifact_id] : []);
  if (!sameSet(expectedArtifacts, manifest.artifacts.map(artifact => String(artifact.id)))) invalid('Artifact selection does not match the exact producing plan set.');
  const context = { profileHash: manifest.profile_hash, handlerHash: manifest.handler_sha256, executionContractHash: manifest.execution_contract_sha256 };
  for (const artifact of manifest.artifacts) {
    const producer = manifest.plans.find(plan => plan.artifact_id === artifact.id);
    if (!producer || artifact.producer_plan_id !== producer.id || hash(artifact.binding) !== hash(artifactBinding(artifact, producer, manifest.sources, context))) invalid('A stored artifact provenance/freshness claim contradicts its producer or source.');
    const provenance = record(artifact.provenance);
    if (provenance && record(provenance.producer)?.independently_verified !== false) invalid('Artifact producer claims must remain explicitly not independently qualified.');
  }
  for (const check of manifest.checks) {
    const requested = input.checks.find(item => item.id === check.id)!;
    if (check.kind !== requested.kind || hash(check.requirement_ids) !== hash(requested.requirement_ids) || hash(check.artifact_ids) !== hash(requested.artifact_ids) || check.reviewer_id !== (requested.reviewer_id ?? null) || check.artifact_ids.some(id => !expectedArtifacts.includes(id))) invalid('A stored check has changed requirements, reviewers or artifact references.');
    if (requested.kind === 'manual') {
      if (check.status !== 'not_run' || check.procedure !== requested.procedure || check.source_document_id !== null || check.source_state !== null || check.observed_at !== null || check.observation_sha256 !== null || check.freshness !== null || check.assertions.length || check.evidence !== 'manual_review_required') invalid('A manual procedure cannot acquire an execution or comparison result.');
      continue;
    }
    completeFreshness(check.freshness);
    if (check.source_document_id !== requested.request.document_id || check.procedure !== undefined || check.status === 'not_run' || check.assertions.length && (check.assertions.length !== requested.assertions.length || check.assertions.some((assertion, index) => hash(assertion.criterion) !== hash(requested.assertions[index])))) invalid('A typed check differs from its selected source or exact comparison criteria.');
    if (['criteria_met', 'criteria_not_met'].includes(check.status)) {
      const source = manifest.sources.find(item => item.document_id === check.source_document_id);
      const validArtifacts = check.artifact_ids.every(id => { const binding = record(manifest.artifacts.find(artifact => artifact.id === id)?.binding); return binding?.status === 'matching' && binding.source_document_id === check.source_document_id && binding.source_state === check.source_state; });
      if (!source || source.status !== 'observed' || source.collection_check.status !== 'matching' || source.state !== check.source_state || !sameFreshness(source.freshness, check.freshness) || !validArtifacts || !check.observation_sha256 || !check.observed_at || check.assertions.length !== requested.assertions.length || check.assertions.some(item => item.result === 'unresolved') || (check.status === 'criteria_met') !== check.assertions.every(item => item.result === 'met')) invalid('A completed criterion lacks matching source/artifact evidence or complete assertions.');
    }
    for (const assertion of check.assertions) if (assertion.result !== 'unresolved') {
      const criterion = assertion.criterion;
      let met: boolean;
      if (criterion.kind === 'equals') {
        if (assertion.actual !== null && typeof assertion.actual !== 'string' && typeof assertion.actual !== 'boolean') invalid('A stored comparison has an inadmissible scalar type.');
        met = assertion.actual === criterion.expected;
      } else {
        if (typeof assertion.actual !== 'number' || assertion.actual_unit !== criterion.unit.expected) invalid('A stored numeric comparison has missing or different units.');
        const value = assertion.actual as number;
        met = (criterion.minimum === undefined || value >= criterion.minimum) && (criterion.maximum === undefined || value <= criterion.maximum);
      }
      if ((assertion.result === 'met') !== met) invalid('Stored scalar evidence contradicts its comparison result.');
    }
  }
  const expectedRequirements = input.requirements.map(requirement => { const checks = manifest.checks.filter(check => check.requirement_ids.includes(requirement.id)); return { ...requirement, origin: 'caller_supplied_requirement', check_ids: checks.map(check => check.id), coverage: requirementCoverage(checks), engineering_approval: false }; });
  if (hash(manifest.requirements) !== hash(expectedRequirements) || hash(manifest.assumptions) !== hash(input.assumptions.map(item => ({ ...item, origin: 'caller_supplied_assumption', verified: false }))) || hash(manifest.reviewer_assignments) !== hash(input.reviewers.map(item => ({ ...item, origin: 'requested_assignment_metadata', notified: false, review_performed: false, approval_granted: false }))) || hash(manifest.external_evidence) !== hash(input.external_evidence.map(item => ({ ...item, origin: 'caller_supplied_reference', bytes_read: false, hash_verified: false, engineering_qualified: false })))) invalid('Stored requirements, assumptions or external/reviewer claims differ from their unverified input metadata.');
  const needs: Array<[string, string]> = [['ENGINEERING_REVIEW_REQUIRED', 'package']];
  if (!manifest.sources.length) needs.push(['NO_SOURCE_BASELINE', 'package']);
  if (!input.requirements.length) needs.push(['NO_REQUIREMENTS', 'package']);
  manifest.sources.filter(source => source.collection_check.status !== 'matching').forEach(source => needs.push(['SOURCE_UNAVAILABLE', source.document_id]));
  manifest.checks.filter(check => check.status !== 'criteria_met').forEach(check => needs.push([check.status === 'criteria_not_met' ? 'CRITERION_NOT_MET' : 'CHECK_INCOMPLETE', check.id]));
  manifest.artifacts.filter(artifact => record(artifact.binding)?.status !== 'matching').forEach(artifact => needs.push(['ARTIFACT_INCOMPLETE', String(artifact.id)]));
  for (const plan of manifest.plans) { if (!plan.current_source_matches) needs.push(['PLAN_EVIDENCE_NOT_CURRENT', String(plan.id)]); if (plan.status !== 'succeeded') needs.push(['PLAN_NOT_SUCCEEDED', String(plan.id)]); }
  manifest.requirements.filter(requirement => requirement.coverage === 'missing_checks').forEach(requirement => needs.push(['REQUIREMENT_UNCOVERED', String(requirement.id)]));
  if (needs.some(([code, reference]) => !manifest.unresolved.some(item => item.code === code && item.reference === reference))) invalid('Unresolved source, artifact, plan or review gates were removed.');
  return structuredClone(manifest);
}
function manifestContent(manifest: HandoffManifest): unknown {
  const { integrity: _integrity, ...content } = manifest;
  return content;
}
function handoffError(error: unknown): ReturnType<typeof errorResult> {
  const result = errorResult(error);
  return { ...result, code: String(result.code).slice(0, 512) || 'HANDOFF_EVIDENCE_UNAVAILABLE', message: String(result.message).slice(0, 4_000), outcome: ['none', 'partial', 'unknown'].includes(result.outcome) ? result.outcome : 'unknown' };
}

export class HandoffManager {
  constructor(private store: RecordStore, private context: HandoffContext) {}

  private async source(documentId: string, expectedState?: string): Promise<HandoffSource> {
    const observed = now();
    let state: string | null = null, metadata: JsonRecord = {}, freshness: HandoffFreshness | null = null, observationHash: string | null = null;
    try {
      const payload = await this.context.read({ operation: 'document.inspect', document_id: documentId, args: { limit: 1 }, ...(expectedState ? { expected_state: expectedState } : {}) });
      assertJson(payload, 4_194_304);
      if (record(record(payload)?.data)?.document_id !== documentId) throw new FusionError('HANDOFF_SOURCE_IDENTITY', 'The observed document identity differs from the selected source.');
      state = payloadState(payload); metadata = sourceMetadata(payload); freshness = observationFreshness(payload); observationHash = hash(payload);
      if (!state) throw new FusionError('FRESHNESS_UNAVAILABLE', 'Source inspection did not return an observed fingerprint.');
      if (expectedState && state !== expectedState) throw new FusionError('STALE_STATE', 'The provider response no longer matches the requested source fingerprint.');
      if (freshness.status !== 'complete') throw new FusionError('FRESHNESS_UNAVAILABLE', 'The source fingerprint has known or malformed coverage gaps. It cannot bind current engineering evidence.');
      return { document_id: documentId, state, observed_at: observed, observation_sha256: observationHash, metadata, freshness, evidence: record(payload)?.evidence === 'synthetic_fixture' ? 'synthetic_fixture' : 'provider_reported', engineering_qualified: false, status: 'observed', collection_check: { status: 'matching', observed_at: observed, state, freshness } };
    } catch (error) {
      return { document_id: documentId, state, observed_at: observed, observation_sha256: observationHash, metadata, freshness, evidence: 'unavailable', engineering_qualified: false, status: state ? 'incomplete' : 'unavailable', collection_check: { status: 'unavailable_or_changed', observed_at: observed, state, freshness }, error: handoffError(error) };
    }
  }

  async prepare(input: unknown): Promise<HandoffManifest> {
    const request = parseInput(input);
    await this.context.verifyAccess();
    const plans: ManagedPlan[] = [];
    const documents = new Set(request.document_ids);
    for (const id of request.plan_ids) {
      const plan = await this.context.inspectPlan(id);
      if (plan.profile_hash !== this.context.profileHash) throw new FusionError('HANDOFF_SCOPE_CHANGED', 'A plan belongs to a different trusted profile configuration. Use its authorized profile to review it.');
      assertJson(plan, 4_194_304);
      plans.push(plan);
      for (const documentId of planDocumentIds(plan)) documents.add(documentId);
    }
    for (const check of request.checks) if (check.kind === 'typed_read') documents.add(check.request.document_id);
    if (documents.size > 20) throw new FusionError('HANDOFF_LIMIT', 'An evidence package supports at most twenty explicit source documents.');
    for (const documentId of documents) await this.context.authorizeDocument(documentId);

    const artifactIds = new Set(plans.flatMap(plan => plan.artifact ? [plan.artifact.id] : []));
    for (const check of request.checks) if (check.artifact_ids.some(id => !artifactIds.has(id))) throw new FusionError('HANDOFF_ARTIFACT_SCOPE', 'Check artifacts must belong to an explicitly selected producing plan.');
    const sources = await Promise.all([...documents].sort().map(id => this.source(id)));
    const byDocument = new Map(sources.map(source => [source.document_id, source]));
    const initialSummaries = plans.map(plan => planSummary(plan, sources, this.context));
    const artifacts: JsonRecord[] = [];
    for (const id of artifactIds) {
      const producer = initialSummaries.find(plan => plan.artifact_id === id)!;
      try {
        const artifact = await this.context.inspectArtifact(id);
        assertJson(artifact, 4_194_304);
        if (artifact.id !== id || artifact.plan_id !== producer.id) throw new FusionError('HANDOFF_ARTIFACT_IDENTITY', 'Artifact inspection did not return the exact selected producing plan and artifact identity.');
        const entry: JsonRecord = { id, status: artifact.status, manifest_version: record(artifact)?.manifest_version ?? 1, manifest_sha256: artifact.manifest_sha256 ?? null, producer_plan_id: producer.id, producer_plan_hash: artifact.producer_plan_hash ?? null, completed_at: artifact.completed_at ?? null, inspected_at: now(), receipt_sha256: hash(artifact), format: artifact.format, filename: artifact.filename, files: artifact.files ?? [], provenance: record(artifact)?.provenance ?? null, validation: record(artifact)?.validation ?? null, limitation: artifact.limitation ?? null, inspection: artifact.status === 'succeeded' ? 'existing_receipt_checked_at_declared_grade' : 'incomplete' };
        entry.binding = artifactBinding(entry, producer, sources, this.context); artifacts.push(entry);
      } catch (error) {
        const entry: JsonRecord = { id, status: 'unavailable', manifest_version: null, manifest_sha256: null, producer_plan_id: producer.id, producer_plan_hash: null, completed_at: null, inspected_at: now(), receipt_sha256: null, format: null, filename: null, files: [], provenance: null, validation: null, limitation: null, inspection: 'incomplete', error: handoffError(error) };
        entry.binding = artifactBinding(entry, producer, sources, this.context); artifacts.push(entry);
      }
    }
    const byArtifact = new Map(artifacts.map(artifact => [artifact.id, artifact]));
    const checks: HandoffCheckResult[] = [];
    for (const check of request.checks) {
      const entry: HandoffCheckResult = { id: check.id, kind: check.kind, requirement_ids: check.requirement_ids, artifact_ids: check.artifact_ids, reviewer_id: check.reviewer_id ?? null, status: check.kind === 'manual' ? 'not_run' : 'incomplete', source_document_id: check.kind === 'typed_read' ? check.request.document_id : null, source_state: null, observed_at: null, observation_sha256: null, evidence: check.kind === 'manual' ? 'manual_review_required' : 'unavailable', engineering_qualified: false, freshness: null, assertions: [] };
      if (check.kind === 'manual') entry.procedure = check.procedure;
      else {
        const source = byDocument.get(check.request.document_id)!;
        try {
          if (!source.state || source.status !== 'observed') throw new FusionError('FRESHNESS_UNAVAILABLE', 'The check has no current observed source baseline.');
          if (check.request.expected_state && check.request.expected_state !== source.state) throw new FusionError('STALE_STATE', 'The check requested a different source state. No check was run.');
          if (check.artifact_ids.some(id => byArtifact.get(id)?.status !== 'succeeded')) throw new FusionError('HANDOFF_ARTIFACT_INCOMPLETE', 'An explicitly linked artifact is unavailable or incomplete.');
          if (check.artifact_ids.some(id => { const binding = record(byArtifact.get(id)?.binding); return binding?.status !== 'matching' || binding.source_document_id !== check.request.document_id || binding.source_state !== source.state; })) throw new FusionError('HANDOFF_ARTIFACT_NOT_CURRENT', 'A linked artifact does not match this check\'s exact current producing plan, document, source and completion evidence. It remains historical evidence.');
          const response = await this.context.read({ ...check.request, expected_state: source.state });
          assertJson(response, 4_194_304);
          entry.freshness = observationFreshness(response);
          if (!sameFreshness(source.freshness, entry.freshness)) throw new FusionError('FRESHNESS_UNAVAILABLE', 'The check response has incomplete or changed fingerprint coverage.');
          if (payloadState(response) !== source.state) throw new FusionError('STALE_STATE', 'The check did not preserve its observed source fingerprint.');
          const responseDocument = record(record(response)?.data)?.document_id;
          if (responseDocument !== undefined && responseDocument !== check.request.document_id) throw new FusionError('HANDOFF_SOURCE_IDENTITY', 'The check response identifies another document.');
          entry.source_state = source.state; entry.observed_at = now(); entry.observation_sha256 = hash(response);
          entry.evidence = record(response)?.evidence === 'synthetic_fixture' ? 'synthetic_fixture' : 'provider_reported';
          const cleanedResponse = redact(response);
          entry.assertions = check.assertions.map(assertion => assessAssertion(response, cleanedResponse, assertion));
          entry.status = entry.assertions.some(value => value.result === 'unresolved') ? 'incomplete' : entry.assertions.some(value => value.result === 'not_met') ? 'criteria_not_met' : 'criteria_met';
        } catch (error) { entry.error = handoffError(error); }
      }
      checks.push(entry);
    }
    // Recheck after all observations. This is bounded source observation, not a
    // multi-document transaction or an Autodesk editing lock.
    const finalSources = await Promise.all(sources.map(source => source.status === 'observed' && source.state ? this.source(source.document_id, source.state) : Promise.resolve(source)));
    for (let index = 0; index < sources.length; index++) {
      const final = finalSources[index]!;
      const matching = final.status === 'observed' && sameFreshness(sources[index]!.freshness, final.freshness);
      sources[index]!.collection_check = { status: matching ? 'matching' : 'unavailable_or_changed', observed_at: final.observed_at, state: final.state, freshness: final.freshness };
    }
    const unstable = new Set(sources.filter(source => source.collection_check.status !== 'matching').map(source => source.document_id));
    for (const check of checks) if (check.source_document_id && unstable.has(check.source_document_id)) {
      check.status = 'incomplete';
      check.error = { code: 'HANDOFF_SOURCE_CHANGED', message: 'Source freshness was lost while collecting the package. Recorded comparisons are not current evidence.', outcome: 'none' };
    }
    const summaries = plans.map(plan => planSummary(plan, sources, this.context));
    for (const artifact of artifacts) artifact.binding = artifactBinding(artifact, summaries.find(plan => plan.artifact_id === artifact.id), sources, this.context);
    for (const check of checks) if (check.kind === 'typed_read' && check.artifact_ids.some(id => record(byArtifact.get(id)?.binding)?.status !== 'matching')) {
      check.status = 'incomplete';
      check.error ??= { code: 'HANDOFF_ARTIFACT_NOT_CURRENT', message: 'A linked artifact lost its current source/producer binding during collection.', outcome: 'none' };
    }
    const unresolved: HandoffManifest['unresolved'] = [];
    if (!documents.size) unresolved.push({ code: 'NO_SOURCE_BASELINE', reference: 'package', message: 'No source document was resolved.' });
    if (!request.requirements.length) unresolved.push({ code: 'NO_REQUIREMENTS', reference: 'package', message: 'Requirements and acceptance criteria have not been supplied.' });
    for (const source of sources) if (source.collection_check.status !== 'matching') unresolved.push({ code: 'SOURCE_UNAVAILABLE', reference: source.document_id, message: 'Source state or fingerprint coverage is incomplete, unavailable or changed during collection.' });
    for (const check of checks) if (check.status !== 'criteria_met') unresolved.push({ code: check.status === 'criteria_not_met' ? 'CRITERION_NOT_MET' : 'CHECK_INCOMPLETE', reference: check.id, message: check.kind === 'manual' ? 'The assigned manual procedure has not been run by this plugin.' : 'This check does not establish all requested criteria against a current source.' });
    for (const artifact of artifacts) if (record(artifact.binding)?.status !== 'matching') unresolved.push({ code: 'ARTIFACT_INCOMPLETE', reference: String(artifact.id), message: 'An artifact is pending, historical, invalid, unavailable or has no matching current producer/source evidence.' });
    for (const plan of summaries) {
      if (!plan.current_source_matches) unresolved.push({ code: 'PLAN_EVIDENCE_NOT_CURRENT', reference: String(plan.id), message: 'The historical receipt has no matching current source and implementation binding; it remains historical evidence only.' });
      if (plan.status !== 'succeeded') unresolved.push({ code: 'PLAN_NOT_SUCCEEDED', reference: String(plan.id), message: 'Prepared, pending, failed or uncertain execution remains visible and requires reconciliation.' });
    }
    const requirements = request.requirements.map(requirement => {
      const linked = checks.filter(check => check.requirement_ids.includes(requirement.id));
      const coverage = requirementCoverage(linked);
      if (!linked.length) unresolved.push({ code: 'REQUIREMENT_UNCOVERED', reference: requirement.id, message: 'No automated or manual check is linked to this requirement.' });
      return { ...requirement, origin: 'caller_supplied_requirement', check_ids: linked.map(check => check.id), coverage, engineering_approval: false };
    });
    unresolved.push({ code: 'ENGINEERING_REVIEW_REQUIRED', reference: 'package', message: 'Only the responsible reviewers can assess engineering sufficiency and any external release. No approval, sending or release transition occurred.' });
    const manifest: HandoffManifest = {
      schema_version: 2, id: newId('handoff'), created_at: now(), state: 'draft', title: request.title,
      profile_id: this.context.profileId, profile_hash: this.context.profileHash, handler_sha256: this.context.handlerHash, execution_contract_sha256: this.context.executionContractHash, integrity: '', input: request,
      sources, plans: summaries, artifacts, checks, requirements,
      assumptions: request.assumptions.map(item => ({ ...item, origin: 'caller_supplied_assumption', verified: false })),
      reviewer_assignments: request.reviewers.map(item => ({ ...item, origin: 'requested_assignment_metadata', notified: false, review_performed: false, approval_granted: false })),
      external_evidence: request.external_evidence.map(item => ({ ...item, origin: 'caller_supplied_reference', bytes_read: false, hash_verified: false, engineering_qualified: false })),
      unresolved, engineering_approval: false, regulatory_compliance_established: false, external_release_performed: false,
      portability: { format: 'standalone_json_manifest', artifact_storage_paths_included: false, caller_supplied_references_may_be_paths: true, referenced_artifact_bytes_copied: false, provider_payloads: 'Only bounded source metadata, assertion scalars and payload hashes are retained. Full provider payloads are not embedded.' },
      limitations: ['A matching observed source fingerprint is not an Autodesk document lock.', 'Criteria are caller-supplied comparisons, not engineering, regulatory or machine-release approval.', 'Synthetic and provider-reported observations remain distinguished; no new live qualification is issued.', 'External evidence and reviewer assignments are metadata only; references are not fetched and reviewers are not notified.', 'Transfer referenced artifacts only through an independently authorized destination workflow.']
    };
    const cleaned = redact(manifest) as HandoffManifest;
    assertJson(cleaned, 4_194_304);
    cleaned.integrity = hash(manifestContent(cleaned));
    verifyHandoffManifest(cleaned);
    await this.context.verifyAccess();
    await this.store.put('handoff', cleaned.id, cleaned);
    return cleaned;
  }

  async inspect(id: string): Promise<{ manifest: HandoffManifest; inspection: JsonRecord }> {
    await this.context.verifyAccess();
    const stored = await this.store.get<unknown>('handoff', id);
    if (!stored || record(stored)?.id !== id) throw new FusionError('NOT_FOUND', 'The engineering handoff is not in this profile ledger.');
    const manifest = verifyHandoffManifest(stored);
    if (manifest.profile_hash !== this.context.profileHash || manifest.profile_id !== this.context.profileId) throw new FusionError('HANDOFF_SCOPE_CHANGED', 'This package belongs to a different trusted profile configuration.');
    for (const source of manifest.sources) await this.context.authorizeDocument(source.document_id);
    const currentPlans = new Map<string, ManagedPlan>();
    const planChecks: JsonRecord[] = [];
    for (const previous of manifest.plans) {
      try {
        const current = await this.context.inspectPlan(String(previous.id));
        assertJson(current, 4_194_304);
        if (current.id !== previous.id || current.profile_hash !== this.context.profileHash) throw new FusionError('HANDOFF_SCOPE_CHANGED', 'The selected producer record belongs to another identity or trusted profile.');
        for (const documentId of planDocumentIds(current)) await this.context.authorizeDocument(documentId);
        const changed = current.hash !== previous.hash || hash(current) !== previous.record_sha256;
        currentPlans.set(current.id, current);
        planChecks.push({ id: previous.id, status: changed ? 'changed' : 'matching', recorded_status: previous.status, current_status: current.status, current_record_sha256: hash(current), current_outcome: record(record(current.result)?.error)?.outcome ?? null, requires_reconciliation: changed || current.status !== 'succeeded' });
      } catch (error) { planChecks.push({ id: previous.id, status: 'unavailable', recorded_status: previous.status, current_status: null, current_record_sha256: null, current_outcome: null, requires_reconciliation: true, error: handoffError(error) }); }
    }
    const currentSources = await Promise.all(manifest.sources.map(source => this.source(source.document_id)));
    const currentArtifacts = new Map<string, ArtifactReservation>();
    const artifactChecks: JsonRecord[] = [];
    for (const previous of manifest.artifacts) {
      try {
        const current = await this.context.inspectArtifact(String(previous.id));
        assertJson(current, 4_194_304);
        if (current.id !== previous.id || current.plan_id !== previous.producer_plan_id) throw new FusionError('HANDOFF_ARTIFACT_IDENTITY', 'The inspected artifact has a different producer or artifact identity.');
        currentArtifacts.set(current.id, current);
      } catch (error) { artifactChecks.push({ id: previous.id, status: 'unavailable', error: handoffError(error) }); }
    }
    // Local file/plan verification may take time. Observe the same source again
    // without rerunning criteria, and retain any changed coverage or gaps.
    const finalSources = await Promise.all(currentSources.map(source => source.status === 'observed' && source.state ? this.source(source.document_id, source.state) : Promise.resolve(source)));
    for (const [index, source] of currentSources.entries()) {
      const final = finalSources[index]!;
      source.collection_check = { status: final.status === 'observed' && sameFreshness(source.freshness, final.freshness) ? 'matching' : 'unavailable_or_changed', observed_at: final.observed_at, state: final.state, freshness: final.freshness };
    }
    const sourceChecks = manifest.sources.map((previous, index) => {
      const current = currentSources[index]!;
      const available = current.status === 'observed' && current.collection_check.status === 'matching' && previous.status === 'observed' && previous.collection_check.status === 'matching';
      return { document_id: previous.document_id, recorded_state: previous.state, current_state: current.state, observed_at: current.observed_at, freshness: current.freshness, collection_check: current.collection_check, status: !available || !previous.state ? 'unavailable' : previous.state === current.state && sameFreshness(previous.freshness, current.freshness) ? 'matching' : 'changed', ...(current.error ? { error: current.error } : {}) };
    });
    for (const previous of manifest.artifacts) {
      const current = currentArtifacts.get(String(previous.id));
      if (!current) continue;
      const producer = currentPlans.get(String(previous.producer_plan_id));
      const summary = producer ? planSummary(producer, currentSources, this.context) : undefined;
      const binding = artifactBinding({ ...current, manifest_version: current.manifest_version ?? 1 }, summary, currentSources, this.context);
      const producerMatches = planChecks.find(plan => plan.id === previous.producer_plan_id)?.status === 'matching';
      const matching = current.status === 'succeeded' && current.manifest_sha256 === previous.manifest_sha256 && hash(current) === previous.receipt_sha256 && producerMatches && binding.status === 'matching' && record(previous.binding)?.status === 'matching';
      artifactChecks.push({ id: previous.id, status: matching ? 'matching' : 'changed_or_incomplete', current_manifest_sha256: current.manifest_sha256 ?? null, producer_record_matches: producerMatches, binding });
    }
    const implementationMatches = manifest.handler_sha256 === this.context.handlerHash && manifest.execution_contract_sha256 === this.context.executionContractHash;
    const affectedChecks = manifest.checks.filter(check => check.status === 'incomplete' || check.status === 'not_run' || !implementationMatches || check.source_document_id && sourceChecks.some(source => source.document_id === check.source_document_id && source.status !== 'matching') || check.artifact_ids.some(id => artifactChecks.some(artifact => artifact.id === id && artifact.status !== 'matching'))).map(check => check.id);
    await this.context.verifyAccess();
    return { manifest, inspection: { inspected_at: now(), implementation_matches: implementationMatches, sources: sourceChecks, plans: planChecks, artifacts: artifactChecks, stale_or_unverifiable_check_ids: affectedChecks, changed_or_unavailable_plan_ids: planChecks.filter(plan => plan.status !== 'matching').map(plan => plan.id), unresolved_plan_ids: planChecks.filter(plan => plan.requires_reconciliation).map(plan => plan.id), engineering_approval: false, stored_manifest_modified: false, checks_rerun: false, meaning: 'This is a fresh comparison to an immutable draft, not renewed engineering approval.' } };
  }
}
