import { z } from 'zod/v4';
import { cloudHash, redactCloudData, type ManageDraftField, type ManageDraftSchema } from './cloud.js';
import { FusionError, assertJson, hash, redact } from './safety.js';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const boundedText = (max: number) => z.string().min(1).max(max).refine(value => !/[\u0000-\u001f\u007f]/u.test(value), 'Control characters are not allowed.');
const numericId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const tenant = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const scalar = z.union([z.string().max(8192), z.number().finite(), z.boolean(), z.null()]);
const timestamp = z.string().datetime().refine(value => new Date(value).toISOString() === value, 'Use canonical UTC timestamps.');
const draftId = z.string().regex(/^managedraft_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);

const fieldRule = z.strictObject({
  fieldId: boundedText(256), type: z.enum(['string', 'number', 'boolean']),
  allowNull: z.boolean(), allowDraftUpdate: z.boolean(), lifecycle: z.boolean(),
  maxLength: z.number().int().min(1).max(8192).optional(),
  minimum: z.number().finite().optional(), maximum: z.number().finite().optional(),
}).superRefine((field, context) => {
  if (field.lifecycle && field.allowDraftUpdate) context.addIssue({ code: 'custom', message: 'Lifecycle fields cannot authorize draft updates.' });
  if (field.type !== 'string' && field.maxLength !== undefined) context.addIssue({ code: 'custom', message: 'Only string rules may set maxLength.' });
  if (field.type !== 'number' && (field.minimum !== undefined || field.maximum !== undefined)) context.addIssue({ code: 'custom', message: 'Only numeric rules may set minimum or maximum.' });
  if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum) context.addIssue({ code: 'custom', message: 'Numeric minimum cannot exceed maximum.' });
});

/** Local owner policy, not a provider response schema and never a tool input. */
export const manageDraftTrustedSchema = z.strictObject({
  tenant, workspaceId: numericId, schemaFingerprint: sha,
  fields: z.array(fieldRule).min(1).max(200),
}).superRefine((schema, context) => {
  if (new Set(schema.fields.map(field => field.fieldId)).size !== schema.fields.length) context.addIssue({ code: 'custom', message: 'Manage field IDs must be unique.' });
});
export const manageDraftRegistrySchema = z.array(manageDraftTrustedSchema).max(100).superRefine((schemas, context) => {
  if (new Set(schemas.map(schema => `${schema.tenant}:${schema.workspaceId}`)).size !== schemas.length) context.addIssue({ code: 'custom', message: 'Manage tenant/workspace schema bindings must be unique.' });
});

export const manageDraftPrepareSchema = z.strictObject({
  workspace_id: numericId, item_id: numericId,
  changes: z.array(z.strictObject({ field_id: boundedText(256), after: scalar, source_ref: boundedText(2048) })).min(1).max(100),
}).superRefine((request, context) => {
  if (new Set(request.changes.map(change => change.field_id)).size !== request.changes.length) context.addIssue({ code: 'custom', message: 'A draft may change each field at most once.' });
});
export const manageDraftInspectSchema = z.strictObject({ draft_id: draftId });
export type ManageDraftInput = z.infer<typeof manageDraftPrepareSchema>;

export function parseManageDraftInput(value: unknown): ManageDraftInput {
  assertJson(value, 262_144);
  const parsed = manageDraftPrepareSchema.safeParse(value);
  if (!parsed.success) throw new FusionError('INVALID_INPUT', 'Manage draft input must contain only bounded workspace/item IDs, unique scalar field changes and source references.');
  // Silently redacting a requested value would describe a different draft.
  if (cloudHash(redactCloudData(redact(parsed.data))) !== cloudHash(parsed.data)) throw new FusionError('INVALID_INPUT', 'Credential-bearing field values or source references cannot be included in a review draft.');
  return parsed.data;
}

/** Validate locally before any token request or provider read. */
export function manageDraftChanges(schema: ManageDraftSchema, request: ManageDraftInput): ManageDraftField[] {
  if (schema.workspaceId !== request.workspace_id) throw new FusionError('UNQUALIFIED_SCHEMA', 'The trusted schema does not match the requested Manage workspace.');
  return request.changes.map(change => {
    const rule = schema.fields.find(field => field.fieldId === change.field_id);
    if (!rule || !rule.allowDraftUpdate || rule.lifecycle) throw new FusionError('SCOPE_DENIED', 'The requested field is absent from the trusted draft rules, read-only, or a lifecycle/release field.');
    const value = change.after;
    if (value === null ? !rule.allowNull : typeof value !== rule.type ||
        typeof value === 'number' && (!Number.isFinite(value) || value < (rule.minimum ?? -Number.MAX_VALUE) || value > (rule.maximum ?? Number.MAX_VALUE)) ||
        typeof value === 'string' && value.length > (rule.maxLength ?? 4096)) throw new FusionError('INVALID_ARGUMENT', 'A requested Manage value does not satisfy its trusted scalar type or bounds.');
    return { fieldId: change.field_id, after: value, sourceRef: change.source_ref };
  });
}

const sdkDraftSchema = z.strictObject({
  status: z.literal('draft_outbox'), tenantId: boundedText(256), manageTenant: tenant,
  workspaceId: numericId, itemId: numericId, schemaFingerprint: sha,
  expectedItemFingerprint: sha, expectedEtag: z.string().max(8192).nullable(),
  changes: z.array(z.strictObject({ fieldId: boundedText(256), after: scalar, sourceRef: boundedText(2048) })).min(1).max(100),
  sourceItem: z.json(), requiresApproval: z.literal(true), releaseApproved: z.literal(false),
  publicationSupported: z.literal(false), blocker: boundedText(1024), draftHash: sha,
});
const recordSchema = z.strictObject({
  schema_version: z.literal(1), id: draftId, operation: z.literal('manage.item_draft'),
  profile_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/),
  profile_hash: sha, scope_hash: sha, authorization_binding: sha,
  schema_hash: sha, request_hash: sha, created_at: timestamp, observed_at: timestamp, expires_at: timestamp,
  trusted_schema: manageDraftTrustedSchema, request: manageDraftPrepareSchema, draft: sdkDraftSchema, record_hash: sha,
});
export type ManageDraftRecord = z.infer<typeof recordSchema>;
export type ManageSdkDraft = ManageDraftRecord['draft'];

export function manageDraftRecordBinding(record: ManageDraftRecord): Omit<ManageDraftRecord, 'record_hash'> {
  const { record_hash: _hash, ...binding } = record;
  return binding;
}

/** Pure immutable-shape/hash check; grants no current scope, freshness or release. */
export function verifyManageDraftRecord(value: unknown): ManageDraftRecord {
  try {
    assertJson(value, 1_048_576);
    const record = recordSchema.parse(value);
    const { draftHash, ...draft } = record.draft;
    const created = Date.parse(record.created_at), observed = Date.parse(record.observed_at), expires = Date.parse(record.expires_at);
    if (record.record_hash !== hash(manageDraftRecordBinding(record)) || record.request_hash !== hash(record.request) ||
        record.schema_hash !== hash(record.trusted_schema) || draftHash !== cloudHash(draft) ||
        record.draft.manageTenant !== record.trusted_schema.tenant || record.draft.workspaceId !== record.trusted_schema.workspaceId ||
        record.draft.workspaceId !== record.request.workspace_id || record.draft.itemId !== record.request.item_id ||
        record.draft.schemaFingerprint !== record.trusted_schema.schemaFingerprint ||
        hash(record.draft.changes) !== hash(manageDraftChanges(record.trusted_schema, parseManageDraftInput(record.request))) ||
        observed < created || observed >= expires || expires - created < 1000 || expires - created > 3_600_000) throw new Error('binding');
    return record;
  } catch { throw new FusionError('DRAFT_TAMPERED', 'The stored Manage draft shape, immutable content or source bindings do not verify.'); }
}

/** Verify the actual SDK result, without interpreting or inventing field values. */
export function verifyManageSdkDraft(value: unknown, expected: { tenantId: string; schema: ManageDraftSchema; request: ManageDraftInput }): ManageSdkDraft {
  try {
    assertJson(value, 786_432);
    const parsed = sdkDraftSchema.parse(value);
    const { draftHash, ...draft } = parsed;
    if (draftHash !== cloudHash(draft) || parsed.tenantId !== expected.tenantId || parsed.manageTenant !== expected.schema.tenant ||
        parsed.workspaceId !== expected.request.workspace_id || parsed.itemId !== expected.request.item_id ||
        parsed.schemaFingerprint !== expected.schema.schemaFingerprint ||
        hash(parsed.changes) !== hash(manageDraftChanges(expected.schema, expected.request))) throw new Error('binding');
    return parsed;
  } catch { throw new FusionError('INVALID_MANAGE_DRAFT', 'The Manage adapter did not return an intact draft for the exact tenant, workspace, item, schema and requested values.'); }
}

export function reviewManageDraft(record: ManageDraftRecord, observedAt: string) {
  const { draftHash, ...storedDraft } = record.draft;
  const review = JSON.parse(JSON.stringify(redactCloudData(redact(storedDraft)))) as Omit<ManageSdkDraft, 'draftHash'>;
  const reviewHash = cloudHash(review);
  const result = {
    id: record.id, operation: record.operation, status: 'draft_outbox' as const,
    record_hash: record.record_hash, stored_draft_hash: draftHash, review_hash: reviewHash,
    created_at: record.created_at, expires_at: record.expires_at,
    context: { profile_id: record.profile_id, profile_hash: record.profile_hash, scope_hash: record.scope_hash, account_context_hash: record.authorization_binding, schema_hash: record.schema_hash, request_hash: record.request_hash },
    review, review_redacted: reviewHash !== draftHash,
    freshness: { checked_at: observedAt, schema_and_item_match: true, atomic_snapshot: false, validity: 'Observation only; inspect again before review. Expiry is never extended.' },
    source_references_verified: false, provider_write_performed: false, publication_supported: false, release_approved: false, live_qualified: false,
  };
  assertJson(result, 1_048_576);
  // The MCP wrapper sanitizes once more. Do not advertise a projection digest
  // unless it also binds the bytes represented by that public JSON value.
  const wire = JSON.parse(JSON.stringify(redactCloudData(redact(result)))) as typeof result;
  if (cloudHash(wire.review) !== reviewHash) throw new FusionError('REVIEW_REDACTION_UNSTABLE', 'The Manage review projection could not retain a stable public hash after credential redaction. No new draft should be recorded.');
  return result;
}
export type ManageDraftReview = ReturnType<typeof reviewManageDraft>;
