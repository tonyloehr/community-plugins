import { McpServer, fromJsonSchema, type JsonSchemaType } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import { compareBoms, normalizeBom, planBomSync } from './bom.js';
import { redactCloudData } from './cloud.js';
import type { BomSnapshot, BomFieldOwnership, BomMapping } from './bom.js';
import type { Runtime } from './runtime.js';
import { FusionError, assertJson, errorResult, hash, newId, now, redact } from './safety.js';
import { cloudBatchPrepareSchema } from './cloud-batches.js';
import { manageDraftInspectSchema, manageDraftPrepareSchema } from './manage-drafts.js';

const ref = z.string().min(1).max(2048), scalar = z.union([z.string().max(8192), z.number().finite(), z.boolean(), z.null()]);
const page = { page_number: z.number().int().min(0).max(1_000_000).optional(), page_size: z.number().int().min(1).max(200).optional() };
const context = z.strictObject({ modelId: ref, timestamp: z.string().datetime({ offset: true }), composition: z.literal('AS_SAVED'), configurationId: ref.nullable().optional() });
const cloudReads = {
  'data.hubs': z.strictObject({}),
  'data.projects': z.strictObject({ hub_id: ref, ...page }),
  'data.top_folders': z.strictObject({ hub_id: ref, project_id: ref }),
  'data.folder_contents': z.strictObject({ project_id: ref, folder_id: ref, ...page }),
  'data.item': z.strictObject({ project_id: ref, item_id: ref }),
  'data.versions': z.strictObject({ project_id: ref, item_id: ref, ...page }),
  'data.version': z.strictObject({ project_id: ref, version_id: ref }),
  'mfg.model': context.extend({ cursor: ref.nullable().optional() }),
  'mfg.history': context,
  'mfg.physical_properties': context,
  'mfg.property': context.extend({ property_id: ref }),
  'manage.workspace': z.strictObject({ workspace_id: z.number().int().positive() }),
  'manage.fields': z.strictObject({ workspace_id: z.number().int().positive() }),
  'manage.item': z.strictObject({ workspace_id: z.number().int().positive(), item_id: z.number().int().positive() })
};
const property = z.strictObject({ value: scalar, unit: ref.nullable().optional(), source: z.enum(['computed', 'override', 'product', 'plm', 'erp']), observedAt: z.string().datetime({ offset: true }), sourceRef: ref });
const bom = z.strictObject({
  context: z.strictObject({ tenantId: ref, modelId: ref, timestamp: z.string().datetime({ offset: true }), composition: ref, configurationId: ref.nullable(), system: ref, revision: ref.nullable().optional(), complete: z.boolean() }),
  rows: z.array(z.strictObject({ occurrencePath: z.array(ref).min(1).max(128), modelId: ref, componentId: ref, quantity: z.strictObject({ value: z.number().finite().nonnegative().nullable(), unit: ref }), excluded: z.boolean(), suppressed: z.boolean(), virtual: z.boolean(), externalRef: z.strictObject({ tenantId: ref, modelId: ref, version: ref.nullable() }).nullable().optional(), properties: z.record(z.string().min(1).max(256), property) })).max(10_000)
});
const mapping = z.array(z.strictObject({ sourceKey: ref, targetKey: ref, evidence: ref })).max(10_000).optional();
const ownership = z.array(z.strictObject({ field: ref, sourceOfTruth: z.enum(['computed', 'override', 'product', 'plm', 'erp']), destination: z.enum(['computed', 'override', 'product', 'plm', 'erp']), allowSync: z.boolean(), allowNull: z.boolean(), maxAgeMs: z.number().nonnegative(), approvalClass: z.enum(['shared_business_change', 'release_review']) })).max(200);

export function registerCloudTools(server: McpServer, runtime: Runtime): void {
  const cloud = () => { if (!runtime.cloud) throw new FusionError('CLOUD_NOT_CONFIGURED', 'Configure a scoped direct APS profile and sign in separately; the synthetic fixture and native Data MCP credentials do not grant cloud access.'); return runtime.cloud; };
  const register = <S extends z.ZodType<Record<string, unknown>>>(name: string, description: string, schema: S, readOnly: boolean, callback: (args: z.infer<S>) => unknown | Promise<unknown>): void => {
    server.registerTool(name, { description, inputSchema: fromJsonSchema<z.infer<S>>(z.toJSONSchema(schema, { io: 'input' }) as unknown as JsonSchemaType), annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: true } }, async input => {
      try {
        assertJson(input, 2_097_152);
        const result = await callback(schema.parse(input) as z.infer<S>);
        // Omit optional undefined fields from library result objects, never from incoming model data.
        const cleaned = JSON.parse(JSON.stringify(redactCloudData(redact(result)))) as Record<string, unknown>; assertJson(cleaned, 4_194_304);
        return { content: [{ type: 'text' as const, text: JSON.stringify(cleaned) }], structuredContent: cleaned };
      } catch (error) { const result = { error: errorResult(error) }; return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result }; }
    });
  };
  register('fusion_cloud_status', 'Inspect direct APS authentication metadata, scoped hubs/projects, reviewed recipes and admission budget. Never returns tokens or reads Codex credential caches.', z.strictObject({}), true, () => cloud().status());
  register('fusion_data_operations_list', 'Discover exact scoped data-read contracts. APIs and native Fusion Data MCP have separate authorization and coverage.', z.strictObject({}), true, () => ({ operations: Object.entries(cloudReads).map(([operation, schema]) => ({ operation, input_schema: z.toJSONSchema(schema, { io: 'input' }) })), generic_url_or_graphql_execution: false }));
  register('fusion_data_search', 'Execute a reviewed bounded Autodesk data read. Follow returned page/cursor values explicitly. Read semantics preserve incomplete GraphQL results and do not turn file hierarchy or assembly relations into a released BOM.', z.strictObject({ operation: z.enum(Object.keys(cloudReads) as [keyof typeof cloudReads, ...(keyof typeof cloudReads)[]]), args: z.record(z.string(), z.unknown()) }), true, a => {
    const parsed = cloudReads[a.operation].safeParse(a.args);
    if (!parsed.success) throw new FusionError('INVALID_INPUT', 'Cloud read arguments do not match the operation contract.', 'none', parsed.error.issues);
    return cloud().read(a.operation, parsed.data);
  });
  register('fusion_manage_item_draft_prepare', 'Prepare a durable local Manage item review draft from bounded field changes. The exact tenant/workspace schema comes only from the trusted profile; caller source references are unverified metadata. Uses scoped GETs, pins schema/item/account/profile fingerprints and an expiry, and cannot publish, approve or advance lifecycle state.', manageDraftPrepareSchema, false, a => cloud().prepareManageDraft(a));
  register('fusion_manage_item_draft_inspect', 'Verify an exact local Manage draft ID and recheck its original schema/item with scoped GETs. Rejects stale, expired or changed account/profile bindings without modifying or renewing the draft. Returns a separately hashed redacted review projection, never provider-write or release authority.', manageDraftInspectSchema, true, a => cloud().inspectManageDraft(a.draft_id));
  register('fusion_bom_inspect', 'Inspect desktop occurrence structure or normalize an explicitly provided BOM snapshot. A provided snapshot is not a fresh provider read; quantity overrides, exclusions, configuration and authority must remain explicit.', z.discriminatedUnion('source', [
    z.strictObject({ source: z.literal('desktop'), document_id: z.string().min(1).max(128), expected_state: z.string().min(1).max(128).optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(10_000).optional(), include_suppressed: z.boolean().optional() }),
    z.strictObject({ source: z.literal('snapshot'), snapshot: bom })
  ]), true, a => {
    if (a.source === 'desktop') {
      return runtime.engine.read({ operation: 'bom.inspect', document_id: a.document_id, ...(a.expected_state ? { expected_state: a.expected_state } : {}), args: { ...(a.limit === undefined ? {} : { limit: a.limit }), ...(a.offset === undefined ? {} : { offset: a.offset }), ...(a.include_suppressed === undefined ? {} : { include_suppressed: a.include_suppressed }) } });
    }
    return { evidence: 'caller_supplied_snapshot', normalized: normalizeBom(a.snapshot), source_freshness_verified: false };
  });
  register('fusion_bom_compare', 'Compare two explicit BOM contexts with stable occurrence identity, quantities/units, suppression/exclusion and field authority. Never matches by names alone or treats unknown as zero.', z.strictObject({ source: bom, target: bom, mappings: mapping, absolute_tolerance: z.number().min(0).max(0.01).optional(), relative_tolerance: z.number().min(0).max(0.01).optional() }), true, a => ({ evidence: 'comparison_of_provided_snapshots', ...compareBoms(a.source, a.target, { ...(a.mappings ? { mappings: a.mappings } : {}), ...(a.absolute_tolerance === undefined ? {} : { absoluteTolerance: a.absolute_tolerance }), ...(a.relative_tolerance === undefined ? {} : { relativeTolerance: a.relative_tolerance }) }) }));
  register('fusion_data_changes_prepare', 'Prepare a scoped MFG custom-property mutation or a local BOM synchronization draft. Custom properties require trusted field rules and current-source checks. BOM drafts never publish or advance lifecycle states.', z.strictObject({ operation: z.enum(['mfg.property_set', 'bom.sync_draft']), context: context.optional(), property_id: ref.optional(), after: scalar.optional(), require_atomic_concurrency: z.boolean().default(true), source: bom.optional(), target: bom.optional(), ownership: ownership.optional(), mappings: mapping }), false, async a => {
    if (a.operation === 'mfg.property_set') {
      if (!a.context || !a.property_id || a.after === undefined || a.source || a.target || a.ownership || a.mappings) throw new FusionError('INVALID_INPUT', 'Property changes require context, property_id and after, without BOM fields.');
      return cloud().prepareProperty(a.context, a.property_id, a.after, a.require_atomic_concurrency);
    }
    if (!a.source || !a.target || !a.ownership || a.context || a.property_id || a.after !== undefined) throw new FusionError('INVALID_INPUT', 'BOM draft requires source, target and ownership, without property mutation fields.');
    if (runtime.cloud) return runtime.cloud.prepareBomSync(a.source as BomSnapshot, a.target as BomSnapshot, a.ownership as BomFieldOwnership[], a.mappings as BomMapping[] | undefined);
    const id = newId('data_draft'); const draft = { id, created_at: now(), ...planBomSync(a.source, a.target, a.ownership, a.mappings ? { mappings: a.mappings } : {}), authority: 'Draft only; supplied field ownership does not authorize publication.' };
    await runtime.engine.store.put('outbox', id, JSON.parse(JSON.stringify(draft))); return draft;
  });
  register('fusion_cloud_job_prepare', 'Prepare a reviewed Fusion Automation recipe, exact input versions, destination and cost reservation. Does not submit compute. A signed generic activity alone does not constrain code or scope.', z.strictObject({ recipe_id: ref, inputs: z.record(z.string(), z.union([z.string().max(8192), z.number().finite(), z.boolean()])), context: z.strictObject({ tenantId: ref, sources: z.array(z.strictObject({ hubId: ref, projectId: ref, itemId: ref, versionId: ref, configurationId: ref.nullable(), resourceHash: z.string().regex(/^[a-f0-9]{64}$/) })).max(100), destinationAlias: ref, variantCount: z.number().int().positive().max(100_000), requireHardCap: z.boolean().optional(), requireImmutableEngine: z.boolean().optional(), requireImmutableDependencies: z.boolean().optional() }) }), false, a => cloud().prepareJob(a.recipe_id, a.inputs, a.context));
  register('fusion_cloud_batch_prepare', 'Validate every variant of one reviewed recipe before preparing any compute submission. Requires a unique request key, 1–100 explicit variant identities, frozen common source context and approved object-storage staging. Preserves one immutable child job per variant; consumes no workitem and reserves no capacity.', cloudBatchPrepareSchema, false, a => cloud().prepareBatch(a));
  register('fusion_cloud_batch_inspect', 'Read the durable batch manifest and exact per-variant job outcomes without provider polling. Exposes missing child records, uncertain work, validation and billing gaps; never treats provider completion as engineering success or releases staged outputs.', z.strictObject({ batch_id: ref }), true, a => cloud().inspectBatch(a.batch_id));
  register('fusion_cloud_batch_resume', 'Admit a bounded sequential wave of unattempted children from an unchanged reviewed batch. Existing grant, tenant/account, source, expiry, concurrency and cost checks apply to each workitem. Never resubmits attempted or uncertain children, recreates a missing ready child, refreshes plans or publishes results.', z.strictObject({ batch_id: ref, plan_hash: z.string().regex(/^[a-f0-9]{64}$/), max_submissions: z.number().int().min(1).max(100) }), false, a => cloud().resumeBatch(a.batch_id, a.plan_hash, a.max_submissions));
  register('fusion_cloud_job_submit', 'Submit an unchanged reviewed cloud plan with an existing scoped compute grant and budget. Persist intent/reservation first; uncertain outcomes are never resubmitted automatically.', z.strictObject({ job_id: ref, plan_hash: z.string().regex(/^[a-f0-9]{64}$/), idempotency_key: z.string().min(8).max(160) }), false, a => cloud().submitJob(a.job_id, a.plan_hash, a.idempotency_key));
  register('fusion_cloud_job_inspect', 'Inspect a durable cloud plan without provider polling. Successful provider processing remains validating until the recipe output checks are completed.', z.strictObject({ job_id: ref }), true, a => cloud().inspectJob(a.job_id));
  register('fusion_cloud_job_validate', 'Run the trusted enterprise output validator for a completed provider job. Accepts only its stored ID; no model-provided success flag, artifact URL or validation receipt grants authority.', z.strictObject({ job_id: ref }), false, a => cloud().validateJob(a.job_id));
  register('fusion_cloud_job_settle', 'Reconcile a terminal job against the configured trusted billing source. Accepts only its stored ID. Missing billing integration retains reservations; caller-supplied costs are never accepted.', z.strictObject({ job_id: ref }), false, a => cloud().settleJob(a.job_id));
}
