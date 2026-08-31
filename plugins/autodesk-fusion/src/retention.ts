import { z } from 'zod/v4';
import { parseOperation } from './catalog.js';
import { assertCloudBatchConflictIntegrity, assertCloudBatchIntegrity, type CloudBatchConflictRecord, type CloudBatchRecord } from './cloud-batches.js';
import { cloudHash } from './cloud-http.js';
import { verifyHandoffManifest } from './handoff.js';
import { FusionError, assertJson, hash, hashBytes, now } from './safety.js';
import type { ReadOnlyRecordSnapshot, ReadOnlyRecordSnapshotEntry, ReadOnlyRecordSnapshotOptions, RecordStore } from './storage.js';

const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const reference = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@ -]*$/u);
const canonicalTime = z.string().max(24).refine(value => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, 'Use canonical UTC ISO time with milliseconds.');
const duration = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const retentionRecordReferenceSchema = z.string().regex(/^entry:[a-f0-9]{64}$/u);
const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

/** Trusted profile configuration only. No default legal or project retention periods. */
export const retentionPolicySchema = z.strictObject({
  version: z.literal(1), ownerRef: reference, policyRef: reference,
  periods: z.strictObject({ expiredPreparationMs: duration.optional(), terminalEvidenceMs: duration.optional(), auditMs: duration.optional() })
});
const hold = z.discriminatedUnion('scope', [
  z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u), scope: z.literal('profile'), reason: z.string().min(1).max(512) }),
  z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u), scope: z.literal('records'), recordRefs: z.array(retentionRecordReferenceSchema).min(1).max(1000).refine(unique, 'Hold references must be unique.'), reason: z.string().min(1).max(512) })
]);
/** A complete empty list is an explicit owner observation, not an assumed absence of holds. */
export const retentionHoldsSchema = z.strictObject({
  version: z.literal(1), ownerRef: reference, evidenceRef: reference,
  reviewedAt: canonicalTime, expiresAt: canonicalTime, complete: z.boolean(), holds: z.array(hold).max(100)
}).refine(value => Date.parse(value.reviewedAt) < Date.parse(value.expiresAt), 'Hold evidence requires an explicit positive validity interval.')
  .refine(value => unique(value.holds.map(item => item.id)), 'Hold IDs must be unique.');
export const retentionSelectionSchema = z.strictObject({ inventory_hash: sha, record_refs: z.array(retentionRecordReferenceSchema).min(1).max(250).refine(unique, 'Selections must be unique.') });
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;
export type RetentionHolds = z.infer<typeof retentionHoldsSchema>;
export type RetentionSelection = z.infer<typeof retentionSelectionSchema>;
export interface RetentionContext {
  profileId: string;
  profileHash: string;
  executionContractHash: string;
  policy?: RetentionPolicy;
  holds?: RetentionHolds;
  /** Omitted means the existing profile's unrestricted local-document read scope. */
  readDocumentIds?: readonly string[];
}
export type RetentionDecision = 'archive_review_candidate' | 'protected' | 'held' | 'unknown';
export interface RetentionInventoryEntry {
  record_ref: string;
  record_kind: string;
  record_id?: string;
  sha256?: string;
  bytes?: number;
  state?: string;
  decision: RetentionDecision;
  reasons: string[];
  terminal: boolean;
  age_anchor?: string;
  retention_period_ms?: number;
  dependency_count: number;
  removal_eligible: false;
}
export interface RetentionInventory {
  schema_version: 1;
  scope: 'local_ledger_metadata_only';
  profile_id: string;
  inventory_hash: string;
  observed_at: string;
  analyzed_at: string;
  inventory_complete: boolean;
  dependency_coverage_complete: boolean;
  complete: boolean;
  entry_count_lower_bound: number;
  unrepresented_entry_count_lower_bound: number;
  total_entry_count: number | null;
  counts: Record<RetentionDecision, number>;
  issues: string[];
  entries: RetentionInventoryEntry[];
  excluded: string[];
  provider_state_observed: false;
  archive_execution_supported: false;
  removal_eligible: false;
}
export interface RetentionPlan {
  schema_version: 1;
  kind: 'retention_archive_copy_review';
  id: string;
  hash: string;
  status: 'review_only';
  created_at: string;
  source_binding: { profile_id: string; profile_hash: string; execution_contract_hash: string; inventory_hash: string; policy_hash: string; holds_hash: string; holds_expires_at: string };
  selected_record_refs: string[];
  records: Array<{ record_ref: string; record_kind: string; sha256: string; bytes: number; age_anchor: string; retention_period_ms: number; dependencies: string[] }>;
  archive_execution_supported: false;
  removal_eligible: false;
  limitations: string[];
}

const KINDS = ['plan', 'job', 'artifact', 'idempotency', 'createddoc', 'cloudjob', 'cloudbatch', 'cloudbatchconflict', 'dataplan', 'audit', 'qualification', 'qualification_result', 'outbox', 'handoff', 'handoff_v2', 'retention', 'retention_plan', 'retention_inventory', 'batch', 'batch_plan', 'batch_result', 'fixture', 'tmp', 'refresh', 'cleanup'] as const;
const LIVE_STATES = new Set(['executing', 'pending', 'submitting', 'queued', 'running', 'validating', 'cancel_requested', 'outcome_unknown', 'generating']);
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled']);
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const MAX_EDGES = 10_000;
const DEPENDENCY_HASH_FIELDS: Readonly<Record<string, string>> = { plan: 'hash', dataplan: 'hash', cloudjob: 'plan_hash', cloudbatch: 'plan_hash', cloudbatchconflict: 'receipt_hash', artifact: 'manifest_sha256' };
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const string = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048;
const hashString = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const timestamp = (value: unknown): value is string => canonicalTime.safeParse(value).success;
function frozen<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); } return value; }
function recordId(kind: string, id: string): boolean {
  if (kind === 'idempotency' || kind === 'createddoc') return /^[a-f0-9]{64}$/u.test(id);
  const prefixes: Record<string, string> = { plan: 'plan', job: 'job', artifact: 'artifact', cloudjob: 'cloudjob', dataplan: 'data_plan', audit: 'event', qualification: 'qualification' };
  if (prefixes[kind]) return new RegExp(`^${prefixes[kind]}_${UUID}$`, 'u').test(id);
  if (kind === 'qualification_result') return new RegExp(`^qualification_${UUID}_[a-z][a-z0-9_-]{0,63}$`, 'u').test(id);
  return /^[A-Za-z0-9_-]{1,120}$/u.test(id);
}
function errorIsUnresolved(value: unknown): boolean {
  const error = object(value);
  return !!error && (error.outcome !== 'none' || object(error.details)?.diagnostics_omitted === true);
}
function planBinding(plan: Record<string, unknown>): unknown {
  return { id: plan.id, created_at: plan.created_at, expires_at: plan.expires_at, operation: plan.operation, expected_state: plan.expected_state ?? null, handler_hash: plan.handler_hash, profile_hash: plan.profile_hash, execution_contract_hash: plan.execution_contract_hash ?? null, effect: plan.effect, provider_args: plan.provider_args, artifact: plan.artifact ?? null, before: plan.before, summary: plan.summary, limitations: plan.limitations };
}
function artifactBinding(record: Record<string, unknown>): unknown {
  const version = record.manifest_version ?? 1;
  if (![1, 2].includes(Number(version)) || typeof version !== 'number' || version === 1 && (record.provenance !== undefined || Array.isArray(record.files) && record.files.some(file => object(file)?.validation !== undefined))) throw new Error('unsupported artifact version');
  // Exact versioned artifact-manifest binding; no byte validator is invoked and
  // legacy records receive neither provenance fields nor a new validation grade.
  const original = { version, id: record.id, root: record.root, filename: record.filename, format: record.format, plan_id: record.plan_id ?? null, producer_plan_hash: record.producer_plan_hash ?? null, completed_at: record.completed_at ?? null, files: record.files ?? [] };
  return version === 1 ? original : { ...original, provenance: record.provenance ?? null, limitation: record.limitation ?? null };
}
interface Node {
  source: ReadOnlyRecordSnapshotEntry;
  data?: Record<string, unknown>;
  view: RetentionInventoryEntry;
  dependencies: Set<string>;
  restricted: boolean;
  candidate: boolean;
  period?: keyof RetentionPolicy['periods'];
}
interface Analysis { inventory: RetentionInventory; nodes: Map<string, Node>; policy?: RetentionPolicy; holds?: RetentionHolds; analyzedAt: string }

/** No provider objects, credentials or native state are accepted by this service. */
export class RetentionPlanner {
  private readonly context: RetentionContext;
  constructor(private readonly store: Pick<RecordStore, 'snapshotReadOnly'>, context: RetentionContext, private readonly options: { now?: () => string; snapshotLimits?: Omit<ReadOnlyRecordSnapshotOptions, 'readKinds'> } = {}) {
    try {
      const configuration = { ...context };
      for (const key of ['policy', 'holds', 'readDocumentIds'] as const) if (configuration[key] === undefined) delete configuration[key];
      const { readDocumentIds: _scope, ...boundedConfiguration } = configuration;
      assertJson(boundedConfiguration, 1_048_576);
      // Match the existing profile contract. Retention-specific inventory limits
      // must not make otherwise valid profiles fail when an engine is created.
      const schema = z.strictObject({ profileId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u), profileHash: sha, executionContractHash: sha, policy: retentionPolicySchema.optional(), holds: retentionHoldsSchema.optional(), readDocumentIds: z.array(z.string().min(1)).optional() });
      this.context = frozen(schema.parse(structuredClone(configuration)));
    } catch { throw new FusionError('INVALID_RETENTION_CONFIGURATION', 'Retention requires bounded trusted profile, owner policy and holds configuration.'); }
  }
  async inventory(): Promise<RetentionInventory> { return (await this.analyze()).inventory; }
  async prepare(input: RetentionSelection): Promise<RetentionPlan> {
    let selected: RetentionSelection;
    try { assertJson(input, 65_536); selected = retentionSelectionSchema.parse(input); }
    catch { throw new FusionError('INVALID_RETENTION_SELECTION', 'Select unique opaque record references from one retained inventory hash.'); }
    const analysis = await this.analyze();
    if (selected.inventory_hash !== analysis.inventory.inventory_hash) throw new FusionError('RETENTION_INVENTORY_CHANGED', 'Ledger bytes, scope, policy or holds changed. Inspect a fresh inventory.');
    if (!analysis.inventory.complete || !analysis.policy || !analysis.holds) throw new FusionError('RETENTION_INCOMPLETE', 'Inventory, dependency coverage and current trusted policy/holds must be complete. Nothing was archived or removed.');
    const closure = new Set<string>(), visit = [...selected.record_refs];
    while (visit.length) {
      const ref = visit.pop()!;
      if (closure.has(ref)) continue;
      const node = analysis.nodes.get(ref);
      if (!node || node.view.decision !== 'archive_review_candidate') throw new FusionError('RETENTION_PROTECTED', 'A selected record or dependency remains protected, held or unknown.');
      closure.add(ref);
      if (closure.size > 250) throw new FusionError('RETENTION_PLAN_LIMIT', 'The complete dependency group exceeds the bounded review-plan limit.');
      visit.push(...node.dependencies);
    }
    const records = [...closure].sort().map(ref => {
      const node = analysis.nodes.get(ref)!, view = node.view;
      return { record_ref: ref, record_kind: view.record_kind, sha256: view.sha256!, bytes: view.bytes!, age_anchor: view.age_anchor!, retention_period_ms: view.retention_period_ms!, dependencies: [...node.dependencies].sort() };
    });
    const content = {
      schema_version: 1 as const, kind: 'retention_archive_copy_review' as const, status: 'review_only' as const, created_at: analysis.analyzedAt,
      source_binding: { profile_id: this.context.profileId, profile_hash: this.context.profileHash, execution_contract_hash: this.context.executionContractHash, inventory_hash: analysis.inventory.inventory_hash, policy_hash: hash(analysis.policy), holds_hash: hash(analysis.holds), holds_expires_at: analysis.holds.expiresAt },
      selected_record_refs: [...selected.record_refs].sort(), records, archive_execution_supported: false as const, removal_eligible: false as const,
      limitations: ['Copy-only review metadata; no archival, relocation, deletion, remote cleanup or hold release is implemented.', 'Only local ledger records were inventoried. Artifact bytes, credential/native subtrees, cloud staging and support bundles were not inspected.', 'Hashes detect changed local content; they are not signatures, WORM storage or regulatory certification.', 'Future execution requires a separately implemented authorized collector and fresh source/holds checks. This plan grants no removal authority.']
    };
    assertJson(content, 1_048_576);
    const digest = hash(content);
    return frozen({ ...content, id: `retention_${digest}`, hash: digest });
  }
  private async analyze(): Promise<Analysis> {
    const snapshot = await this.store.snapshotReadOnly({ ...this.options.snapshotLimits, maxEntries: Math.min(this.options.snapshotLimits?.maxEntries ?? 1000, 1000), readKinds: [...KINDS] });
    // Holds may expire during filesystem observation. Classify them using the
    // post-snapshot clock, while preserving the snapshot's separate start time.
    const analyzedAt = this.options.now?.() ?? now();
    if (!timestamp(analyzedAt)) throw new FusionError('RETENTION_CLOCK_UNAVAILABLE', 'Retention analysis requires an explicit valid UTC observation time.');
    const at = Date.parse(analyzedAt), policy = this.context.policy, holds = this.context.holds;
    return analyzeSnapshot(snapshot, this.context, policy, holds, analyzedAt, at);
  }
}

function analyzeSnapshot(snapshot: ReadOnlyRecordSnapshot, context: RetentionContext, policy: RetentionPolicy | undefined, holds: RetentionHolds | undefined, analyzedAt: string, at: number): Analysis {
  const issues = new Set(snapshot.issues), nodes = new Map<string, Node>(), keys = new Map<string, Node>();
  const allowed = context.readDocumentIds === undefined ? undefined : new Set(context.readDocumentIds);
  let dependencyComplete = true, edges = 0;
  const problem = (node: Node, reason: string, unknown = false): void => {
    if (!node.view.reasons.includes(reason)) node.view.reasons.push(reason);
    node.candidate = false;
    if (unknown) { node.view.decision = 'unknown'; dependencyComplete = false; }
  };
  const restrict = (node: Node, documentId: unknown): void => {
    if (allowed && (!string(documentId) || !allowed.has(documentId))) { node.restricted = true; problem(node, 'READ_SCOPE_UNPROVEN_OR_DENIED'); }
  };
  const connect = (node: Node, kind: string, id: unknown, expectedHash?: unknown, missingAllowed = false): Node | undefined => {
    if (!string(id)) { problem(node, 'INVALID_DEPENDENCY_REFERENCE', true); return undefined; }
    const target = keys.get(`${kind}:${id}`);
    if (!target) { if (!missingAllowed) problem(node, 'MISSING_DEPENDENCY', true); return undefined; }
    const hashField = DEPENDENCY_HASH_FIELDS[kind];
    if (expectedHash !== undefined && (!hashString(expectedHash) || !hashField || target.data?.[hashField] !== expectedHash)) problem(node, 'DEPENDENCY_HASH_MISMATCH', true);
    if (!node.dependencies.has(target.source.ref)) {
      if (++edges > MAX_EDGES) { problem(node, 'DEPENDENCY_LIMIT', true); return target; }
      // A retained dependent pins its dependency, and review copies include the
      // complete connected group so no record is silently orphaned.
      node.dependencies.add(target.source.ref); target.dependencies.add(node.source.ref);
    }
    return target;
  };
  const candidate = (node: Node, period: keyof RetentionPolicy['periods'], anchor: unknown): void => {
    node.view.terminal = true; node.period = period;
    if (!timestamp(anchor)) { problem(node, 'TERMINAL_TIMESTAMP_UNAVAILABLE'); return; }
    if (Date.parse(anchor) > at) { problem(node, 'TIMESTAMP_IN_FUTURE'); return; }
    node.view.age_anchor = anchor;
    const minimum = policy?.periods[period];
    if (minimum === undefined) { problem(node, 'OWNER_PERIOD_MISSING'); return; }
    node.view.retention_period_ms = minimum;
    if (at - Date.parse(anchor) < minimum) { problem(node, 'OWNER_PERIOD_NOT_ELAPSED'); return; }
    node.candidate = node.view.reasons.length === 0;
  };
  for (const source of snapshot.entries) {
    const known = !!source.kind && (KINDS as readonly string[]).includes(source.kind) && !!source.id && recordId(source.kind, source.id);
    const node: Node = { source, data: source.status === 'read' ? object(source.value) : undefined, restricted: false, candidate: false, dependencies: new Set(), view: { record_ref: source.ref, record_kind: known ? source.kind! : 'unknown', ...(known ? { record_id: source.id } : {}), ...(source.sha256 ? { sha256: source.sha256 } : {}), ...(source.bytes !== undefined ? { bytes: source.bytes } : {}), decision: source.status === 'unknown' ? 'unknown' : 'protected', reasons: [], terminal: false, dependency_count: 0, removal_eligible: false } };
    nodes.set(source.ref, node);
    if (source.kind && source.id) keys.set(`${source.kind}:${source.id}`, node);
    if (source.status !== 'read') { problem(node, source.issue ?? 'UNREAD_RECORD', source.status === 'unknown'); continue; }
    if (!known || !node.data) { problem(node, 'UNKNOWN_RECORD_SCHEMA', true); continue; }
    if (source.kind !== 'qualification_result' && node.data.id !== undefined && node.data.id !== source.id) problem(node, 'RECORD_ID_MISMATCH', true);
  }
  for (const node of nodes.values()) {
    if (node.source.status !== 'read' || !node.data || node.view.decision === 'unknown') continue;
    const value = node.data, kind = node.source.kind!, state = value.status;
    if (typeof state === 'string' && ['prepared', 'draft', 'draft_outbox', 'scenario_passed', ...LIVE_STATES, ...TERMINAL_STATES].includes(state)) node.view.state = state;
    if (kind !== 'qualification_result') node.view.terminal = typeof state === 'string' && TERMINAL_STATES.has(state);
    try {
      if (kind === 'plan') {
        const operation = object(value.operation), result = object(value.result), output = object(value.artifact);
        if (!operation || hash(planBinding(value)) !== value.hash) throw new Error('plan binding');
        parseOperation(operation);
        if (!hashString(value.profile_hash) || !hashString(value.execution_contract_hash) || !hashString(value.handler_hash) || !timestamp(value.created_at) || !timestamp(value.expires_at) || Date.parse(value.created_at) > Date.parse(value.expires_at)) throw new Error('plan shape');
        restrict(node, operation.document_id);
        if (value.profile_hash !== context.profileHash || value.execution_contract_hash !== context.executionContractHash) problem(node, 'SOURCE_BINDING_UNREVIEWED');
        if (output) {
          const target = connect(node, 'artifact', output.id, undefined, state === 'prepared');
          if (target && state === 'prepared') problem(node, 'PREPARATION_HAS_STAGED_ARTIFACT');
        }
        const imported = object(object(operation.args)?.source);
        if (operation.operation === 'documents.import' && imported?.kind === 'artifact') connect(node, 'artifact', imported.id);
        const job = object(result?.job);
        if (job) connect(node, 'job', job.id);
        if (state === 'prepared') {
          if (value.idempotency_key !== undefined || value.result !== undefined) problem(node, 'PREPARATION_HAS_EXECUTION_EVIDENCE');
          if (Date.parse(value.expires_at) <= at) candidate(node, 'expiredPreparationMs', value.expires_at);
          else problem(node, 'PREPARATION_NOT_EXPIRED');
        } else if (typeof state === 'string' && LIVE_STATES.has(state)) problem(node, 'NONTERMINAL_OR_UNCERTAIN_OPERATION');
        else if (typeof state === 'string' && TERMINAL_STATES.has(state)) {
          if (!result || errorIsUnresolved(result.error) || object(result.after)?.validation_incomplete === true || object(result.after)?.unavailable !== undefined || result.completion !== 'provider_completed' && !(state === 'failed' && object(result.error)?.outcome === 'none')) problem(node, 'UNRECONCILED_OUTCOME_OR_VALIDATION');
          // The current PlanRecord contract has no durable completion timestamp.
          problem(node, 'TERMINAL_TIMESTAMP_UNAVAILABLE');
        } else throw new Error('plan status');
      } else if (kind === 'idempotency') {
        problem(node, 'REPLAY_FENCE_REQUIRES_LIVE_LEDGER');
        const fields = Object.keys(value).sort();
        if (string(value.job_id) && fields.every(key => ['job_id', 'plan_hash'].includes(key))) connect(node, 'cloudjob', value.job_id, value.plan_hash);
        else if (string(value.plan_id) && fields.every(key => ['plan_id', 'hash'].includes(key))) connect(node, value.plan_id.startsWith('data_plan_') ? 'dataplan' : 'plan', value.plan_id, value.hash);
        else throw new Error('replay reference');
      } else if (kind === 'createddoc') {
        problem(node, 'CREATED_DOCUMENT_AUTHORITY_REQUIRES_LIVE_LEDGER');
        if (!string(value.document_id) || hash(value.document_id) !== node.source.id || !hashString(value.plan_hash)) throw new Error('created document identity');
        restrict(node, value.document_id); connect(node, 'plan', value.plan_id, value.plan_hash);
      } else if (kind === 'job') {
        problem(node, 'JOB_OWNERSHIP_REQUIRES_LIVE_LEDGER');
        if (!['desktop_cam', 'desktop_render'].includes(String(value.provider)) || !string(value.provider_id) || !timestamp(value.created_at) || !timestamp(value.updated_at)) throw new Error('job shape');
        const binding = { id: value.id, provider: value.provider, provider_id: value.provider_id, plan_id: value.plan_id, document_id: value.document_id, artifact_id: value.artifact_id ?? null, created_at: value.created_at, request_hash: value.request_hash, execution_contract_hash: value.execution_contract_hash, submission_error: value.submission_error ?? null };
        if (hash(binding) !== value.binding_hash) throw new Error('job binding');
        restrict(node, value.document_id); connect(node, 'plan', value.plan_id, value.request_hash);
        if (value.artifact_id !== undefined) connect(node, 'artifact', value.artifact_id);
        if (!node.view.terminal || errorIsUnresolved(value.submission_error) || errorIsUnresolved(object(value.data)?.error)) problem(node, 'NONTERMINAL_OR_UNRECONCILED_JOB');
      } else if (kind === 'cloudjob') {
        // Even settled rows count toward current-period admissions; this local
        // planner never asks credentials/provider state to release accounting.
        problem(node, 'CLOUD_ACCOUNTING_AND_OWNERSHIP_REQUIRES_LIVE_LEDGER');
        const prepared = object(value.prepared), reservation = object(prepared?.reservation), batch = object(value.batch);
        if (!prepared || !reservation || !hashString(value.plan_hash) || !hashString(prepared.requestHash) || typeof value.submitted !== 'boolean' || typeof value.reserved_units !== 'number' || !Number.isFinite(value.reserved_units) || value.reserved_units < 0) throw new Error('cloud ledger shape');
        const { requestHash: preparedHash, ...preparedFields } = prepared;
        if (cloudHash(preparedFields) !== preparedHash || !['id', 'recipeId', 'recipeVersion'].every(key => string(prepared[key])) || !hashString(prepared.recipeHash) || !object(prepared.context) || !object(prepared.activity) || !object(prepared.destination) || !object(prepared.inputs) || !Array.isArray(prepared.warnings) || !timestamp(prepared.createdAt) || !timestamp(prepared.expiresAt) || typeof reservation.amount !== 'number' || !Number.isFinite(reservation.amount) || reservation.amount < 0 || !string(reservation.currency) || !timestamp(value.created_at) || !timestamp(value.updated_at) || !string(value.profile_id) || !hashString(value.profile_hash) || !hashString(value.scope_hash) || !hashString(value.authorization_binding)) throw new Error('prepared cloud evidence');
        const binding = { id: value.id, created_at: value.created_at, prepared, profile: value.profile_hash, scope: value.scope_hash, authorization: value.authorization_binding, profile_id: value.profile_id, budget_period: value.budget_period, ...(batch ? { batch } : {}) };
        if (hash(binding) !== value.plan_hash) throw new Error('cloud ledger binding');
        const settlement = object(value.settlement);
        if (value.settlement !== undefined) {
          if (!settlement) throw new Error('settlement shape');
          const { receipt_hash, ...receipt } = settlement;
          if (hash(receipt) !== receipt_hash || receipt.job_id !== value.id || receipt.provider_id !== value.provider_id || receipt.request_hash !== prepared.requestHash || receipt.currency !== reservation.currency || receipt.final !== true || typeof receipt.actual_amount !== 'number' || !Number.isFinite(receipt.actual_amount) || receipt.actual_amount < 0 || value.submitted !== true || value.reserved_units !== 0) throw new Error('settlement evidence');
        } else if (value.reserved_units !== (value.submitted ? reservation.amount : 0)) throw new Error('cost exposure');
        const validation = object(value.validation);
        if (value.validation !== undefined) {
          if (!validation) throw new Error('validation shape');
          const { receipt_hash, ...receipt } = validation;
          if (hash(receipt) !== receipt_hash || receipt.job_id !== value.id || receipt.provider_id !== value.provider_id || receipt.request_hash !== prepared.requestHash || receipt.recipe_hash !== prepared.recipeHash) throw new Error('validation evidence');
        }
        if (allowed) node.restricted = true;
        if (batch) connect(node, 'cloudbatch', batch.batch_id);
        if (value.validation_in_progress !== undefined) {
          problem(node, 'CLOUD_VALIDATION_OUTCOME_UNRESOLVED');
          const intent = object(value.validation_in_progress);
          if (!intent || !batch || typeof intent.attempt_id !== 'string' || !new RegExp(`^validation_${UUID}$`, 'u').test(intent.attempt_id) || !timestamp(intent.started_at) || intent.job_id !== value.id || intent.batch_id !== batch.batch_id || intent.request_hash !== prepared.requestHash || value.submitted !== true || !string(value.provider_id)) throw new Error('validation intent binding');
        }
        if (value.output_identity_conflict !== undefined) {
          problem(node, 'HISTORICAL_OUTPUT_VALIDATION_UNUSABLE');
          const conflict = object(value.output_identity_conflict);
          if (!conflict || !batch || conflict.batch_id !== batch.batch_id || !hashString(conflict.receipt_hash) || conflict.disposition !== 'historical_validation_unusable') throw new Error('output conflict binding');
          connect(node, 'cloudbatchconflict', conflict.batch_id, conflict.receipt_hash);
        }
        if (value.submitted && !value.settlement) problem(node, 'UNSETTLED_CLOUD_EXPOSURE');
        if (!node.view.terminal || errorIsUnresolved(value.error)) problem(node, 'NONTERMINAL_OR_UNRECONCILED_JOB');
      } else if (kind === 'cloudbatch') {
        problem(node, 'BATCH_MANIFEST_REQUIRES_LIVE_LEDGER');
        assertCloudBatchIntegrity(value as unknown as CloudBatchRecord);
        if (allowed) node.restricted = true;
        const batch = value as unknown as CloudBatchRecord;
        for (const variant of batch.variants) {
          const child = connect(node, 'cloudjob', variant.initial_job.id, variant.initial_job.plan_hash, batch.phase === 'materializing');
          if (!child && batch.phase === 'materializing') problem(node, 'BATCH_MATERIALIZATION_INCOMPLETE', true);
          const replayId = hash({ cloud: batch.profile_id, key: variant.idempotency_key });
          connect(node, 'idempotency', replayId, undefined, true);
        }
      } else if (kind === 'cloudbatchconflict') {
        problem(node, 'OUTPUT_IDENTITY_CONFLICT_FENCE');
        if (allowed) node.restricted = true;
        const conflict = value as unknown as CloudBatchConflictRecord;
        assertCloudBatchConflictIntegrity(conflict);
        const parent = connect(node, 'cloudbatch', conflict.batch_id, conflict.batch_plan_hash);
        if (parent?.data) {
          const batch = parent.data as unknown as CloudBatchRecord;
          assertCloudBatchIntegrity(batch);
          assertCloudBatchConflictIntegrity(conflict, batch);
          if (batch.phase !== 'ready') throw new Error('conflict before ready batch');
        }
        for (const binding of conflict.job_bindings) connect(node, 'cloudjob', binding.job_id, binding.plan_hash);
      } else if (kind === 'dataplan') {
        problem(node, 'CLOUD_DATA_AUTHORITY_REQUIRES_LIVE_LEDGER');
        if (allowed) node.restricted = true;
        const binding = { id: value.id, profile_hash: value.profile_hash, scope_hash: value.scope_hash, authorization_binding: value.authorization_binding, created_at: value.created_at, expires_at: value.expires_at, operation: value.operation, draft: value.draft, require_atomic_concurrency: value.require_atomic_concurrency };
        if (value.operation !== 'mfg.property_set' || hash(binding) !== value.hash) throw new Error('data plan binding');
        if (errorIsUnresolved(object(value.result)?.error) || !node.view.terminal) problem(node, 'NONTERMINAL_OR_UNRECONCILED_DATA_WRITE');
        if (node.view.terminal) problem(node, 'TERMINAL_TIMESTAMP_UNAVAILABLE');
      } else if (kind === 'artifact') {
        const producer = connect(node, 'plan', value.plan_id, value.producer_plan_hash);
        if (allowed) restrict(node, object(producer?.data?.operation)?.document_id);
        if (state !== 'succeeded') { problem(node, 'QUARANTINED_OR_INCOMPLETE_ARTIFACT'); continue; }
        if (!Array.isArray(value.files) || !value.files.length || value.files.length > 500 || value.files.some(file => { const item = object(file); return !item || !string(item.name) || !hashString(item.sha256) || !Number.isSafeInteger(item.size) || Number(item.size) < 1; }) || !hashString(value.producer_plan_hash) || hash(artifactBinding(value)) !== value.manifest_sha256 || producer?.data?.hash !== value.producer_plan_hash || producer.data.status !== 'succeeded') throw new Error('artifact manifest');
        if (value.manifest_version === 2) {
          const provenance = object(value.provenance), provenanceProducer = object(provenance?.producer), source = object(provenance?.source);
          if (provenance?.schema !== 1 || provenanceProducer?.plan_id !== value.plan_id || provenanceProducer?.plan_hash !== value.producer_plan_hash || provenanceProducer?.independently_verified !== false || source?.document_id !== object(producer.data.operation)?.document_id) throw new Error('artifact provenance binding');
        }
        candidate(node, 'terminalEvidenceMs', value.completed_at);
      } else if (kind === 'audit') {
        const details = object(value.details);
        if (!details || !timestamp(value.time) || hash(details) !== value.integrity) throw new Error('audit integrity');
        const event = value.event;
        if (['plan_prepared', 'execution_intent', 'execution_result'].includes(String(event))) connect(node, 'plan', details.plan_id, event === 'execution_result' ? undefined : details.hash);
        else if (['data_plan_prepared', 'data_write_intent', 'data_write_result'].includes(String(event))) connect(node, 'dataplan', details.id, event === 'data_write_result' ? undefined : details.hash);
        else if (['cloud_job_prepared', 'cloud_submission_intent', 'cloud_submission_result', 'cloud_cancel_intent', 'cloud_cancel_requested', 'cloud_output_validation', 'cloud_billing_reconciled'].includes(String(event))) connect(node, 'cloudjob', details.id, details.plan_hash);
        else if (['cloud_batch_prepared', 'cloud_batch_materialized', 'cloud_batch_execution'].includes(String(event))) connect(node, 'cloudbatch', details.id ?? details.batch_id);
        else if (event === 'cloud_batch_output_conflict') {
          connect(node, 'cloudbatch', details.batch_id, details.batch_plan_hash);
          connect(node, 'cloudbatchconflict', details.batch_id, details.conflict_receipt_hash);
          if (!Array.isArray(details.job_ids) || details.job_ids.length < 2 || details.job_ids.length > 100 || !details.job_ids.every(string) || !unique(details.job_ids)) throw new Error('conflict audit references');
          for (const id of details.job_ids) connect(node, 'cloudjob', id);
        }
        else { problem(node, 'AUDIT_DEPENDENCY_SCHEMA_UNREVIEWED', true); continue; }
        candidate(node, 'auditMs', value.time);
      } else if (kind === 'qualification') {
        const { report_hash: expected, ...report } = value, cleanup = object(value.cleanup);
        if (hash(report) !== expected || !timestamp(value.tested_at) || !['scenario_passed', 'failed'].includes(String(state)) || !cleanup || !Array.isArray(value.evidence) || value.evidence.length > 130) throw new Error('qualification report');
        if (value.profile_id !== context.profileId || value.profile_sha256 !== context.profileHash || value.execution_contract_sha256 !== context.executionContractHash) problem(node, 'SOURCE_BINDING_UNREVIEWED');
        if (cleanup.review_required !== false || !['remaining_document_ids', 'unresolved_jobs', 'failed_step_ids'].every(key => Array.isArray(cleanup[key]) && cleanup[key].length === 0)) problem(node, 'QUALIFICATION_CLEANUP_UNRESOLVED');
        for (const evidence of value.evidence) {
          const step = object(evidence), receipt = object(step?.result_receipt);
          if (!step || !receipt || receipt.kind !== 'qualification_result' || !hashString(receipt.sha256)) { problem(node, 'QUALIFICATION_RECEIPT_MISSING', true); continue; }
          const result = connect(node, 'qualification_result', receipt.id);
          if (!result || hash(result.source.value) !== receipt.sha256) { problem(node, 'QUALIFICATION_RECEIPT_CHANGED', true); continue; }
          const payload = object(result.source.value);
          if (step.action === 'change') connect(node, 'plan', payload?.id, payload?.hash);
          else if (step.action === 'wait_job') connect(node, 'job', payload?.id);
          else if (step.action === 'artifact') connect(node, 'artifact', payload?.id);
          else if (step.action !== 'read') { problem(node, 'QUALIFICATION_DEPENDENCIES_UNREVIEWED', true); continue; }
          if (allowed) restrict(result, payload?.document_id);
          candidate(result, 'terminalEvidenceMs', value.tested_at);
        }
        candidate(node, 'terminalEvidenceMs', value.tested_at);
      } else if (kind === 'qualification_result') {
        // Only its hash-bound parent report may supply a final timestamp and
        // identify whether this payload references a plan/job/artifact.
      } else if (kind === 'handoff' && value.schema_version === 2) {
        problem(node, 'DRAFT_HANDOFF_REQUIRES_REVIEW');
        const manifest = verifyHandoffManifest(value);
        if (manifest.profile_id !== context.profileId || manifest.profile_hash !== context.profileHash) problem(node, 'SOURCE_BINDING_UNREVIEWED');
        for (const source of manifest.sources) restrict(node, source.document_id);
        for (const plan of manifest.plans) connect(node, 'plan', plan.id, plan.hash);
        for (const artifact of manifest.artifacts) {
          const target = connect(node, 'artifact', artifact.id, hashString(artifact.manifest_sha256) ? artifact.manifest_sha256 : undefined, artifact.status === 'unavailable');
          if (!target) problem(node, 'HANDOFF_ARTIFACT_UNAVAILABLE');
        }
      } else if (kind === 'handoff' && value.schema_version === undefined && value.state === 'draft' && Array.isArray(value.plans)) {
        problem(node, 'DRAFT_HANDOFF_REQUIRES_REVIEW');
        if (value.plans.length > 100) throw new Error('handoff size');
        for (const plan of value.plans) { const item = object(plan); connect(node, 'plan', item?.id, item?.hash); }
      } else if (kind === 'retention_plan' && verifyRetentionPlan(value)) {
        problem(node, 'RETENTION_REVIEW_RECORD_PROTECTED');
        const plan = value as unknown as RetentionPlan;
        for (const record of plan.records) {
          const target = nodes.get(record.record_ref);
          if (!target) { problem(node, 'RETENTION_REVIEW_SOURCE_MISSING', true); continue; }
          if (target.source.sha256 !== record.sha256) problem(node, 'RETENTION_REVIEW_SOURCE_CHANGED');
          if (target.source.kind && target.source.id) connect(node, target.source.kind, target.source.id);
        }
      } else {
        // Unsupported handoff and other batch/retention schemas must not acquire
        // disposal semantics from their names or a caller-supplied terminal flag.
        problem(node, 'PROTECTED_RECORD_DEPENDENCIES_UNREVIEWED', true);
        if (allowed) node.restricted = true;
      }
    } catch { problem(node, 'MALFORMED_OR_CHANGED_RECORD', true); }
  }
  for (const node of nodes.values()) if (node.source.kind === 'qualification_result' && !node.dependencies.size) problem(node, 'QUALIFICATION_PARENT_MISSING', true);

  if (!policy) issues.add('RETENTION_POLICY_MISSING');
  if (!holds) issues.add('TRUSTED_HOLDS_MISSING');
  else {
    if (!holds.complete) issues.add('TRUSTED_HOLDS_INCOMPLETE');
    if (Date.parse(holds.reviewedAt) > at) issues.add('TRUSTED_HOLDS_FROM_FUTURE');
    if (Date.parse(holds.expiresAt) <= at) issues.add('TRUSTED_HOLDS_EXPIRED');
    for (const hold of holds.holds) {
      const targets = hold.scope === 'profile' ? [...nodes.keys()] : hold.recordRefs;
      for (const ref of targets) {
        const target = nodes.get(ref);
        if (!target) { issues.add('TRUSTED_HOLD_TARGET_UNRESOLVED'); dependencyComplete = false; continue; }
        target.view.decision = 'held'; problem(target, 'TRUSTED_HOLD');
      }
    }
  }
  if (!dependencyComplete) issues.add('DEPENDENCY_COVERAGE_INCOMPLETE');
  const complete = snapshot.complete && dependencyComplete && issues.size === 0;
  const visited = new Set<string>();
  for (const initial of nodes.values()) {
    if (visited.has(initial.source.ref)) continue;
    const group: Node[] = [], pending = [initial];
    while (pending.length) {
      const node = pending.pop()!;
      if (visited.has(node.source.ref)) continue;
      visited.add(node.source.ref); group.push(node);
      for (const ref of node.dependencies) { const related = nodes.get(ref); if (related) pending.push(related); }
    }
    const held = group.some(node => node.view.decision === 'held'), restricted = group.some(node => node.restricted);
    const protectedGroup = group.some(node => !node.candidate || node.view.decision === 'unknown');
    for (const node of group) {
      if (restricted) { node.restricted = true; problem(node, 'READ_SCOPE_UNPROVEN_OR_DENIED'); }
      if (held) { node.view.decision = 'held'; problem(node, 'TRUSTED_HOLD_OR_HELD_DEPENDENCY'); }
      else if (node.view.decision !== 'unknown') {
        if (!complete) problem(node, 'ANALYSIS_INCOMPLETE');
        if (protectedGroup) problem(node, 'PROTECTED_DEPENDENCY_GROUP');
        node.view.decision = node.candidate && complete ? 'archive_review_candidate' : 'protected';
      }
      node.view.dependency_count = node.dependencies.size;
      node.view.reasons.sort();
      if (node.view.decision === 'unknown') {
        delete node.view.record_id; delete node.view.state; delete node.view.age_anchor; delete node.view.retention_period_ms;
        node.view.terminal = false;
      }
      if (node.restricted) node.view = { record_ref: node.source.ref, record_kind: 'restricted', decision: node.view.decision === 'held' ? 'held' : 'protected', reasons: ['READ_SCOPE_UNPROVEN_OR_DENIED', ...(node.view.decision === 'held' ? ['TRUSTED_HOLD_OR_HELD_DEPENDENCY'] : [])], terminal: false, dependency_count: 0, removal_eligible: false };
    }
  }
  const binding = {
    schema_version: 1, profile_id: context.profileId, profile_hash: context.profileHash, execution_contract_hash: context.executionContractHash,
    read_scope_hash: hashBytes(JSON.stringify(context.readDocumentIds ?? null)), policy_hash: policy ? hash(policy) : null, holds_hash: holds ? hash(holds) : null,
    root_hash: snapshot.root_hash, complete: snapshot.complete, issues: snapshot.issues, total_entry_count: snapshot.total_entry_count,
    entries: snapshot.entries.map(entry => ({ ref: entry.ref, status: entry.status, type: entry.entry_type, sha256: entry.sha256 ?? null, bytes: entry.bytes ?? null, issue: entry.issue ?? null }))
  };
  const entries = [...nodes.values()].map(node => node.view).sort((left, right) => left.record_ref < right.record_ref ? -1 : left.record_ref > right.record_ref ? 1 : 0);
  const counts: RetentionInventory['counts'] = { archive_review_candidate: 0, protected: 0, held: 0, unknown: 0 };
  for (const entry of entries) counts[entry.decision]++;
  const inventory: RetentionInventory = { schema_version: 1, scope: 'local_ledger_metadata_only', profile_id: context.profileId, inventory_hash: hash(binding), observed_at: snapshot.observed_at, analyzed_at: analyzedAt, inventory_complete: snapshot.complete, dependency_coverage_complete: dependencyComplete, complete, entry_count_lower_bound: snapshot.entry_count_lower_bound, unrepresented_entry_count_lower_bound: Math.max(0, snapshot.entry_count_lower_bound - nodes.size), total_entry_count: snapshot.total_entry_count, counts, issues: [...issues].sort(), entries, excluded: ['credential and native-state subtrees', 'artifact output bytes and directories', 'cloud staging and provider state', 'support bundles and external caches'], provider_state_observed: false, archive_execution_supported: false, removal_eligible: false };
  assertJson(inventory, 2_097_152);
  return { inventory: frozen(inventory), nodes, policy, holds, analyzedAt };
}

/** Content validation only; this never grants authority to archive or remove anything. */
export function verifyRetentionPlan(value: unknown): value is RetentionPlan {
  try {
    assertJson(value, 1_048_576);
    const recordSchema = z.strictObject({ record_ref: retentionRecordReferenceSchema, record_kind: z.enum(KINDS), sha256: sha, bytes: z.number().int().min(1).max(16_777_216), age_anchor: canonicalTime, retention_period_ms: duration, dependencies: z.array(retentionRecordReferenceSchema).max(250).refine(unique) });
    const schema = z.strictObject({ schema_version: z.literal(1), kind: z.literal('retention_archive_copy_review'), id: z.string().regex(/^retention_[a-f0-9]{64}$/u), hash: sha, status: z.literal('review_only'), created_at: canonicalTime, source_binding: z.strictObject({ profile_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u), profile_hash: sha, execution_contract_hash: sha, inventory_hash: sha, policy_hash: sha, holds_hash: sha, holds_expires_at: canonicalTime }), selected_record_refs: z.array(retentionRecordReferenceSchema).min(1).max(250).refine(unique), records: z.array(recordSchema).min(1).max(250), archive_execution_supported: z.literal(false), removal_eligible: z.literal(false), limitations: z.array(z.string().min(1).max(1024)).min(1).max(10) });
    const parsed = schema.safeParse(value);
    if (!parsed.success) return false;
    const plan = parsed.data;
    const refs = new Set(plan.records.map(record => record.record_ref));
    if (plan.id !== `retention_${plan.hash}` || refs.size !== plan.records.length || plan.selected_record_refs.some(ref => !refs.has(ref)) || plan.records.some(record => record.dependencies.some(ref => !refs.has(ref))) || Date.parse(plan.created_at) >= Date.parse(plan.source_binding.holds_expires_at)) return false;
    const { id: _id, hash: expected, ...content } = plan;
    return hash(content) === expected;
  } catch { return false; }
}
