import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { ApsClient, type CloudScope, type MfgContext, type MfgPropertyDraft } from './cloud.js';
import { AutomationClient, type AutomationClientOptions, type AutomationRecipe, type AutomationPrepareContext, type PreparedAutomationJob, type AutomationJobStatus } from './cloud-automation.js';
import { compareBoms, normalizeBom, planBomSync, type BomSnapshot, type BomFieldOwnership, type BomMapping } from './bom.js';
import { ApsPkceClient, type TokenProvider, type TokenStore } from './oauth.js';
import { NativeTokenStore } from './credentials.js';
import { authorize, loadProfile, profileHash, type FusionProfile } from './profile.js';
import { FusionError, SerialQueue, errorResult, hash, newId, now, assertJson } from './safety.js';
import { RecordStore } from './storage.js';
import { assertCloudBatchConflictIntegrity, assertCloudBatchIntegrity, assertPreparedBatchVariant, batchArtifactConflicts, batchErrorCode, cloudBatchBinding, cloudBatchChildKey, cloudBatchConflictBinding, cloudBatchContext, cloudBatchId, inspectCloudBatch, parseCloudBatchInput, type CloudBatchConflictRecord, type CloudBatchInspection, type CloudBatchOwner, type CloudBatchRecord, type CloudBatchVariant } from './cloud-batches.js';

export interface CloudJobRecord {
  id: string; prepared: PreparedAutomationJob; plan_hash: string; profile_hash: string;
  status: 'prepared' | 'submitting' | 'queued' | 'running' | 'validating' | 'succeeded' | 'failed' | 'cancel_requested' | 'cancelled' | 'outcome_unknown';
  created_at: string; updated_at: string; provider_id?: string; idempotency_key?: string;
  reserved_units: number; budget_period: string; submitted: boolean; provider?: AutomationJobStatus;
  scope_hash: string; authorization_binding: string; profile_id: string;
  validation?: CloudValidationReceipt & { receipt_hash: string };
  settlement?: CloudBillingReceipt & { receipt_hash: string };
  cancellation?: { attempted_at: string; acknowledgement: 'pending' | 'confirmed' | 'unknown' | 'rejected' };
  error?: ReturnType<typeof errorResult>;
  batch?: CloudBatchOwner;
  validation_in_progress?: { attempt_id: string; started_at: string; job_id: string; batch_id: string; request_hash: string };
  output_identity_conflict?: { batch_id: string; receipt_hash: string; disposition: 'historical_validation_unusable' };
  validation_usable?: false;
}
export interface CloudCoordinatorOptions {
  profile: FusionProfile; profileFile?: string; root: string; store: RecordStore;
  tokenStore?: TokenStore; aps?: ApsClient; automation?: AutomationClient;
  /** Trusted host adapter; its opaque binding changes on account switch, not access-token refresh. */
  authorizationBinding?: () => Promise<string>;
  /** Trusted validators consume configured destinations; MCP supplies only a stored job ID. */
  validateOutputs?: (job: Readonly<CloudJobRecord>) => Promise<CloudValidationReceipt>;
  /** Trusted metering/invoice integration, never model-supplied prices or a boolean assertion. */
  reconcileBilling?: (job: Readonly<CloudJobRecord>) => Promise<CloudBillingReceipt>;
  /** Privileged deployment module services, never supplied through model/tool arguments. */
  enterpriseServices?: EnterpriseCloudServices;
  /** Host-owned source/hash/ownership revalidation; must not be supplied by the deployment module itself. */
  verifyEnterpriseAdapter?: () => Promise<void>;
}
export interface EnterpriseCloudServices {
  tokenProvider: TokenProvider;
  authMode: AutomationClientOptions['authMode'];
  /** Stable account/grant context. Must change on a different account or authorization grant, not token refresh. */
  authorizationBinding: () => Promise<string>;
  /** Optional separately authorized read/write principal for Data Management, MFGDM and Manage. */
  dataTokenProvider?: TokenProvider;
  delegatedTokenProvider?: TokenProvider;
  stageTransfers?: AutomationClientOptions['stageTransfers'];
  permittedTransferOrigins?: string[];
  cancelQualified?: boolean;
  validateOutputs?: CloudCoordinatorOptions['validateOutputs'];
  reconcileBilling?: CloudCoordinatorOptions['reconcileBilling'];
}
export interface CloudValidationReceipt {
  job_id: string; provider_id: string; request_hash: string; recipe_hash: string;
  observed_at: string;
  artifacts: { artifact_id: string; sha256: string; bytes: number }[];
  checks: { validator_id: string; outcome: 'passed' | 'failed'; evidence_ref: string }[];
}
export interface CloudBillingReceipt {
  job_id: string; provider_id: string; request_hash: string; currency: string; actual_amount: number;
  observed_at: string; evidence_ref: string; source: 'provider_meter' | 'provider_invoice' | 'enterprise_billing_reconciliation';
  final: true;
}
export interface CloudDataPlan {
  id: string; hash: string; profile_hash: string; created_at: string; expires_at: string;
  operation: 'mfg.property_set'; draft: MfgPropertyDraft; require_atomic_concurrency: boolean;
  status: 'prepared' | 'executing' | 'succeeded' | 'failed' | 'outcome_unknown';
  idempotency_key?: string; result?: unknown;
  scope_hash: string; authorization_binding: string;
}
function dataBinding(plan: CloudDataPlan): unknown {
  return { id: plan.id, profile_hash: plan.profile_hash, scope_hash: plan.scope_hash, authorization_binding: plan.authorization_binding, created_at: plan.created_at, expires_at: plan.expires_at, operation: plan.operation, draft: plan.draft, require_atomic_concurrency: plan.require_atomic_concurrency };
}
function jobBinding(job: CloudJobRecord) { return { id: job.id, created_at: job.created_at, prepared: job.prepared, profile: job.profile_hash, scope: job.scope_hash, authorization: job.authorization_binding, profile_id: job.profile_id, budget_period: job.budget_period, ...(job.batch ? { batch: job.batch } : {}) }; }
function assertJobIntegrity(job: CloudJobRecord): void {
  if (hash(jobBinding(job)) !== job.plan_hash) throw new FusionError('PLAN_TAMPERED', 'Cloud job does not match its prepared content hash.');
  if (!Number.isFinite(job.prepared.reservation.amount) || job.prepared.reservation.amount < 0 || !Number.isFinite(job.reserved_units) || job.reserved_units < 0 || typeof job.submitted !== 'boolean') throw new FusionError('INVALID_JOB_RECORD', 'Stored cost exposure is invalid; admissions are blocked until the ledger is reconciled.');
  if (job.settlement) {
    const { receipt_hash, ...receipt } = job.settlement;
    if (hash(receipt) !== receipt_hash || receipt.job_id !== job.id || receipt.provider_id !== job.provider_id || receipt.request_hash !== job.prepared.requestHash || receipt.currency !== job.prepared.reservation.currency || receipt.final !== true || !Number.isFinite(receipt.actual_amount) || receipt.actual_amount < 0 || !job.submitted || job.reserved_units !== 0) throw new FusionError('RECEIPT_TAMPERED', 'Stored billing evidence or its cost exposure changed.');
  } else if (job.reserved_units !== (job.submitted ? job.prepared.reservation.amount : 0)) throw new FusionError('INVALID_JOB_RECORD', 'Submitted work must retain its full reserved exposure until final actual-cost evidence is recorded.');
  if (job.validation) {
    const { receipt_hash, ...receipt } = job.validation;
    if (hash(receipt) !== receipt_hash || receipt.job_id !== job.id || receipt.provider_id !== job.provider_id || receipt.request_hash !== job.prepared.requestHash || receipt.recipe_hash !== job.prepared.recipeHash) throw new FusionError('RECEIPT_TAMPERED', 'Stored output validation evidence changed or belongs to another job.');
  }
  if (job.validation_in_progress) {
    const intent = job.validation_in_progress;
    if (!job.batch || !/^validation_[a-f0-9-]{36}$/.test(intent.attempt_id) || !Number.isFinite(Date.parse(intent.started_at)) || intent.job_id !== job.id || intent.batch_id !== job.batch.batch_id || intent.request_hash !== job.prepared.requestHash || !job.submitted || !job.provider_id) throw new FusionError('INVALID_JOB_RECORD', 'The unresolved batch-validation intent changed or belongs to another job.');
  }
}
async function readRecipes(filename: string): Promise<AutomationRecipe[]> {
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4_194_304 || (process.platform !== 'win32' && ((stat.mode & 0o022) || (stat.uid !== process.getuid?.() && stat.uid !== 0)))) throw new FusionError('UNTRUSTED_RECIPES', 'Recipes must be a bounded regular file owned by the user or administrator and not writable by group/others.');
    let raw: unknown;
    try { raw = JSON.parse(await handle.readFile('utf8')); assertJson(raw, 4_194_304); }
    catch { throw new FusionError('INVALID_RECIPES', 'Recipe registry is not bounded valid JSON. Its file content was withheld.'); }
    if (!Array.isArray(raw) || raw.length > 100) throw new FusionError('INVALID_RECIPES', 'Recipe registry must contain at most 100 reviewed recipes.');
    return raw as AutomationRecipe[];
  } catch (error) { if (error instanceof FusionError) throw error; throw new FusionError('UNTRUSTED_RECIPES', 'Recipe registry is unavailable or no longer a trusted regular file.'); }
  finally { await handle?.close(); }
}
function evidenceRef(value: unknown) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,2047}$/.test(value) && !value.includes('://') && !/token|secret|bearer/i.test(value); }
function freshEvidence(value: unknown, createdAt: string) {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(parsed) && parsed >= Date.parse(createdAt) && parsed <= Date.now() + 60_000 && Date.now() - parsed <= 300_000;
}
function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key));
}

export class CloudCoordinator {
  /** Present only for the direct public-client profile. Enterprise modules own their own authorization. */
  readonly oauth: ApsPkceClient | undefined;
  readonly aps: ApsClient;
  automation?: AutomationClient;
  private queue = new SerialQueue();
  private recipeFileHash?: string;
  private recipes: AutomationRecipe[] = [];
  private constructor(readonly options: CloudCoordinatorOptions) {
    const cloud = options.profile.cloud;
    if (!cloud) throw new FusionError('CLOUD_NOT_CONFIGURED', 'This profile has no scoped direct Autodesk cloud adapter. Native Fusion Data MCP has separate credentials.');
    const services = options.enterpriseServices;
    if (services) {
      if (!['app_only', 'app_with_user', 'public_pkce'].includes(services.authMode) || typeof services.authorizationBinding !== 'function' || typeof services.tokenProvider?.getToken !== 'function' || (services.authMode === 'app_with_user' && typeof services.delegatedTokenProvider?.getToken !== 'function')) throw new FusionError('INVALID_ENTERPRISE_SERVICES', 'Enterprise authorization must provide its explicit grant mode, token provider, stable account/grant binding, and delegated provider where required.');
      for (const provider of [services.dataTokenProvider, services.delegatedTokenProvider]) if (provider !== undefined && typeof provider?.getToken !== 'function') throw new FusionError('INVALID_ENTERPRISE_SERVICES', 'Enterprise token providers must implement the scoped token-provider contract.');
      for (const callback of [services.stageTransfers, services.validateOutputs, services.reconcileBilling]) if (callback !== undefined && typeof callback !== 'function') throw new FusionError('INVALID_ENTERPRISE_SERVICES', 'Enterprise service callbacks must be trusted functions.');
    }
    const scope: CloudScope = { tenantId: cloud.tenantId, hubIds: cloud.hubIds, projects: cloud.projects, mfgModels: cloud.mfgModels, ...(cloud.manage ? { manage: cloud.manage } : {}) };
    this.oauth = services || this.enterpriseDescriptor() ? undefined : new ApsPkceClient({ clientId: cloud.clientId!, tenantId: cloud.tenantId, scopes: cloud.scopes!, redirectUri: cloud.redirectUri!, credentialNamespace: hash({ profile: options.profile.id, stateRoot: options.profile.stateRoot }), store: options.tokenStore ?? new NativeTokenStore(options.root, undefined, { lockRoot: path.join(options.profile.stateRoot, 'credential-locks') }) });
    if (!services && !this.oauth) throw new FusionError('ENTERPRISE_ADAPTER_REQUIRED', 'This profile delegates authorization to its pinned enterprise module. Public-client PKCE credentials are not substituted.');
    this.aps = options.aps ?? new ApsClient({ scope, tokenProvider: services ? services.dataTokenProvider ?? (services.authMode === 'app_with_user' ? services.delegatedTokenProvider! : services.tokenProvider) : this.oauth!, propertyRules: cloud.propertyRules });
    this.automation = options.automation;
  }
  static async create(options: CloudCoordinatorOptions): Promise<CloudCoordinator> {
    const coordinator = new CloudCoordinator(options);
    await coordinator.verifyEnterprise();
    const filename = options.profile.cloud?.recipesFile;
    if (filename) {
      const raw = await readRecipes(filename);
      coordinator.recipes = raw;
      coordinator.recipeFileHash = hash(raw);
      if (options.profile.mode === 'managed' && coordinator.recipes.some(recipe => recipe.authority === 'assisted_public_client')) throw new FusionError('UNCONSTRAINED_CLOUD_AUTHORITY', 'A managed profile cannot advertise a generic signed public-client script activity as provider-constrained.');
      const services = options.enterpriseServices;
      coordinator.automation ??= new AutomationClient({ scope: coordinator.aps.scope, tokenProvider: services?.tokenProvider ?? coordinator.oauth!, recipes: coordinator.recipes, authMode: services?.authMode ?? 'public_pkce', ...(services?.delegatedTokenProvider ? { delegatedTokenProvider: services.delegatedTokenProvider } : {}), ...(services?.stageTransfers ? { stageTransfers: services.stageTransfers } : {}), ...(services?.permittedTransferOrigins ? { permittedTransferOrigins: services.permittedTransferOrigins } : {}), ...(services?.cancelQualified === undefined ? {} : { cancelQualified: services.cancelQualified }), authorizeExistingJob: async (providerId, tenantId) => {
        if (tenantId !== options.profile.cloud!.tenantId || !(await options.store.list<CloudJobRecord>('cloudjob')).some(job => job.provider_id === providerId && job.submitted && job.scope_hash === coordinator.scopeBinding() && job.prepared.context.tenantId === tenantId)) throw new FusionError('JOB_SCOPE_DENIED', 'Provider job is outside this tenant/profile ledger.');
      }, authorizeSubmission: async prepared => {
        await coordinator.check();
        const record = (await options.store.list<CloudJobRecord>('cloudjob')).find(job => job.prepared.id === prepared.id && job.prepared.requestHash === prepared.requestHash && job.scope_hash === coordinator.scopeBinding() && job.status === 'submitting' && job.submitted);
        if (!record) throw new FusionError('SUBMISSION_INTENT_REQUIRED', 'Dispatch requires the exact durable submitting intent and reservation.');
        await coordinator.ensureAccount(record.authorization_binding);
        authorize(options.profile, 'cloud.job_submit', 'cloud_compute');
      } });
    }
    return coordinator;
  }
  private scopeBinding(): string {
    const cloud = this.options.profile.cloud!;
    return hash({ profile: this.options.profile.id, clientId: cloud.clientId ?? null, tenantId: cloud.tenantId, scopes: [...(cloud.scopes ?? [])].sort(), hubIds: [...cloud.hubIds].sort(), projects: cloud.projects, mfgModels: cloud.mfgModels, manage: cloud.manage ?? null, enterpriseAdapter: this.enterpriseDescriptor() ?? null, authMode: this.options.enterpriseServices?.authMode ?? 'public_pkce' });
  }
  private enterpriseDescriptor(): { path: string; sha256: string } | undefined {
    // The strict profile schema is maintained by the deployment loader; no model argument reaches it.
    return (this.options.profile.cloud as NonNullable<FusionProfile['cloud']> & { enterpriseAdapter?: { path: string; sha256: string } }).enterpriseAdapter;
  }
  private async verifyEnterprise(): Promise<void> {
    const descriptor = this.enterpriseDescriptor();
    if (!descriptor && !this.options.enterpriseServices && !this.options.verifyEnterpriseAdapter) return;
    if (!descriptor || !this.options.enterpriseServices || typeof this.options.verifyEnterpriseAdapter !== 'function' || !path.isAbsolute(descriptor.path) || !/^[a-f0-9]{64}$/.test(descriptor.sha256)) throw new FusionError('ENTERPRISE_ADAPTER_REQUIRED', 'Enterprise services require a pinned trusted profile module and a host-owned integrity verifier. Native MCP or local PKCE grants are not substituted.');
    try { await this.options.verifyEnterpriseAdapter(); }
    catch { throw new FusionError('ENTERPRISE_ADAPTER_CHANGED', 'The pinned enterprise deployment module is unavailable, changed, or no longer trusted. No operation was authorized through it.'); }
  }
  private outputValidator() { return this.options.validateOutputs ?? this.options.enterpriseServices?.validateOutputs; }
  private billingReconciler() { return this.options.reconcileBilling ?? this.options.enterpriseServices?.reconcileBilling; }
  private async ensureAccount(binding: string): Promise<void> {
    if (binding !== await this.accountBinding()) throw new FusionError('ACCOUNT_CHANGED', 'The Autodesk authorization context changed during preparation; discard the observation and prepare again.');
  }
  private async accountBinding(): Promise<string> {
    const bindingProvider = this.options.enterpriseServices?.authorizationBinding ?? this.options.authorizationBinding;
    if (bindingProvider) {
      let binding: string;
      try { binding = await bindingProvider(); }
      catch { throw new FusionError('AUTHORIZATION_UNAVAILABLE', 'The trusted service authorization context could not be read.'); }
      if (typeof binding !== 'string' || binding.length < 1 || binding.length > 4096) throw new FusionError('AUTHORIZATION_UNAVAILABLE', 'The trusted service has no usable authorization binding.');
      return hash({ scope: this.scopeBinding(), binding });
    }
    const authorization = await this.oauth?.status();
    if (!authorization?.authorizationSessionId) throw new FusionError('NOT_AUTHENTICATED', 'Sign in through this profile before preparing cloud mutations. Its session binding must be known.');
    return hash({ scope: this.scopeBinding(), grant: authorization.grantId, session: authorization.authorizationSessionId });
  }
  private async check(): Promise<void> {
    if (this.options.profileFile && profileHash(await loadProfile(this.options.profileFile)) !== profileHash(this.options.profile)) throw new FusionError('PROFILE_CHANGED', 'Cloud scope or policy changed. Restart and prepare a new job.');
    if (this.options.profile.cloud?.recipesFile && hash(await readRecipes(this.options.profile.cloud.recipesFile)) !== this.recipeFileHash) throw new FusionError('RECIPE_CHANGED', 'Reviewed recipe registry changed. Restart before preparing or submitting jobs.');
    await this.verifyEnterprise();
  }
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    return this.queue.run(async () => {
      await this.check();
      const release = await this.options.store.acquireLease();
      try { await this.check(); return await fn(); } finally { await release(); }
    });
  }
  async status(): Promise<unknown> {
    await this.check();
    const authentication = this.options.enterpriseServices ? { source: 'enterprise_adapter', auth_mode: this.options.enterpriseServices.authMode, authorization_binding: await this.accountBinding(), token_state: 'not_requested' } : { source: 'public_client_pkce', grant: await this.oauth?.status() ?? null };
    return { configured: true, scope: this.aps.scope, authentication, credential_owner: 'This direct APS adapter or its pinned enterprise deployment module; native Fusion Data MCP grants are not reused.', recipes: this.automation?.listRecipes() ?? [], budget: this.options.profile.cloud?.budget ?? null, output_validator_configured: typeof this.outputValidator() === 'function', billing_reconciler_configured: typeof this.billingReconciler() === 'function', live_qualified: false };
  }
  async read(operation: string, args: Record<string, unknown>): Promise<unknown> {
    return this.guarded(async () => {
      const page = { ...(args.page_number === undefined ? {} : { pageNumber: args.page_number as number }), ...(args.page_size === undefined ? {} : { pageSize: args.page_size as number }) };
      switch (operation) {
        case 'data.hubs': return this.aps.listHubs();
        case 'data.projects': return this.aps.listProjects(args.hub_id as string, page);
        case 'data.top_folders': return this.aps.listTopFolders(args.hub_id as string, args.project_id as string);
        case 'data.folder_contents': return this.aps.listFolderContents(args.project_id as string, args.folder_id as string, page);
        case 'data.item': return this.aps.getItem(args.project_id as string, args.item_id as string);
        case 'data.versions': return this.aps.listItemVersions(args.project_id as string, args.item_id as string, page);
        case 'data.version': return this.aps.getVersion(args.project_id as string, args.version_id as string);
        case 'mfg.model': return this.aps.inspectMfgModel(args as unknown as MfgContext & { cursor?: string });
        case 'mfg.history': return this.aps.inspectMfgHistory(args as unknown as MfgContext);
        case 'mfg.physical_properties': return this.aps.inspectMfgPhysicalProperties(args as unknown as MfgContext);
        case 'mfg.property': { const { property_id, ...context } = args; return this.aps.observeMfgProperty(context as unknown as MfgContext, property_id as string); }
        case 'manage.workspace': return this.aps.getManageWorkspace(args.workspace_id as number);
        case 'manage.fields': return this.aps.getManageFields(args.workspace_id as number);
        case 'manage.item': return this.aps.getManageItem(args.workspace_id as number, args.item_id as number);
        default: throw new FusionError('UNSUPPORTED_OPERATION', 'This cloud read is not in the reviewed registry. Arbitrary URLs, REST routes and GraphQL documents are not accepted.');
      }
    });
  }
  async prepareJob(recipeId: string, inputs: Record<string, string | number | boolean>, context: AutomationPrepareContext): Promise<CloudJobRecord> {
    if (!this.automation) throw new FusionError('AUTOMATION_NOT_CONFIGURED', 'No reviewed Automation recipe registry is installed.');
    return this.guarded(async () => {
      const binding = await this.accountBinding();
      const prepared = await this.automation!.prepare(recipeId, inputs, context);
      await this.ensureAccount(binding);
      const record = this.initialJob(prepared, binding);
      await this.options.store.put('cloudjob', record.id, record);
      await this.options.store.audit('cloud_job_prepared', { id: record.id, plan_hash: record.plan_hash, recipe_id: recipeId, reservation: prepared.reservation });
      return record;
    });
  }
  private initialJob(prepared: PreparedAutomationJob, binding: string, batch?: CloudBatchOwner): CloudJobRecord {
    const record: CloudJobRecord = { id: newId('cloudjob'), prepared: structuredClone(prepared), plan_hash: '', profile_hash: profileHash(this.options.profile), scope_hash: this.scopeBinding(), authorization_binding: binding, profile_id: this.options.profile.id, status: 'prepared', created_at: now(), updated_at: now(), reserved_units: 0, budget_period: this.options.profile.cloud?.budget?.period ?? 'unconfigured', submitted: false, ...(batch ? { batch } : {}) };
    record.plan_hash = hash(jobBinding(record));
    return record;
  }
  private assertPreparedJob(record: CloudJobRecord): void {
    if (record.profile_hash !== profileHash(this.options.profile)) throw new FusionError('PLAN_BINDING_CHANGED', 'Cloud plan profile changed.');
    const expiresAt = Math.min(Date.parse(record.prepared.expiresAt), Date.parse(record.created_at) + this.options.profile.policy.planMaxAgeMs);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new FusionError('PLAN_EXPIRED', 'Cloud preparation expired before submission. Prepare and review a fresh job.');
  }
  private async admissionSnapshot() {
    const budget = this.options.profile.cloud?.budget;
    if (!budget) throw new FusionError('BUDGET_REQUIRED', 'Cloud submission requires an explicit admission budget.');
    const allJobs = await this.options.store.list<CloudJobRecord>('cloudjob');
    const jobs = allJobs.filter(job => job.profile_id === this.options.profile.id && job.prepared.context.tenantId === this.options.profile.cloud!.tenantId);
    jobs.forEach(assertJobIntegrity);
    const active = jobs.filter(job => ['submitting', 'queued', 'running', 'validating', 'outcome_unknown', 'cancel_requested'].includes(job.status));
    const period = jobs.filter(job => job.budget_period === budget.period && job.submitted);
    const exposure = jobs.filter(job => job.submitted && !job.settlement);
    if (exposure.some(job => job.prepared.reservation.currency !== budget.currency)) throw new FusionError('BUDGET_UNIT_MISMATCH', 'Unsettled job exposure has a different currency; reconcile it before changing this budget pool.');
    const reserved = period.reduce((sum, job) => sum + (job.settlement?.actual_amount ?? job.reserved_units), 0) + exposure.filter(job => job.budget_period !== budget.period).reduce((sum, job) => sum + job.reserved_units, 0);
    if (!Number.isFinite(reserved)) throw new FusionError('INVALID_JOB_RECORD', 'Stored aggregate cost exposure is invalid; admissions are blocked.');
    return { budget, jobs, active, period, reserved };
  }
  private async readBatchRecord(id: string): Promise<CloudBatchRecord> {
    await this.check();
    const batch = await this.options.store.get<CloudBatchRecord>('cloudbatch', id);
    if (!batch) throw new FusionError('NOT_FOUND', 'Cloud batch is outside this profile ledger.');
    assertCloudBatchIntegrity(batch);
    batch.variants.forEach(variant => assertJobIntegrity(variant.initial_job));
    if (batch.id !== id) throw new FusionError('BATCH_TAMPERED', 'The stored batch identity does not match its ledger reference.');
    if (batch.profile_id !== this.options.profile.id || batch.scope_hash !== this.scopeBinding() || batch.request.context.tenantId !== this.options.profile.cloud!.tenantId) throw new FusionError('JOB_SCOPE_DENIED', 'Cloud batch belongs to a different profile/account/data scope.');
    await this.ensureAccount(batch.authorization_binding);
    return batch;
  }
  private assertBatchChild(batch: CloudBatchRecord, variant: CloudBatchVariant, job: CloudJobRecord): void {
    assertJobIntegrity(job);
    if (job.id !== variant.initial_job.id || job.plan_hash !== variant.initial_job.plan_hash || !job.batch || hash(job.batch) !== hash(variant.initial_job.batch)) throw new FusionError('BATCH_BINDING_CHANGED', 'A batch child no longer matches its immutable variant mapping.');
    if (!['prepared', 'submitting', 'queued', 'running', 'validating', 'succeeded', 'failed', 'cancel_requested', 'cancelled', 'outcome_unknown'].includes(job.status) || job.status === 'prepared' && hash(job) !== hash(variant.initial_job) || job.status !== 'prepared' && job.idempotency_key !== variant.idempotency_key || !['prepared', 'failed'].includes(job.status) && !job.submitted) throw new FusionError('BATCH_LEDGER_INCOMPLETE', 'A batch child has inconsistent attempt state; reconcile the ledger before further admission.');
    if (batch.phase === 'materializing' && hash(job) !== hash(variant.initial_job)) throw new FusionError('BATCH_MATERIALIZATION_BLOCKED', 'An unsealed batch contains an attempted or changed child; missing records cannot be recreated.', 'unknown');
  }
  private async batchJobs(batch: CloudBatchRecord): Promise<(CloudJobRecord | undefined)[]> {
    const jobs: (CloudJobRecord | undefined)[] = [];
    const providers = new Set<string>();
    const conflict = await this.readBatchConflict(batch);
    for (const variant of batch.variants) {
      const job = await this.options.store.get<CloudJobRecord>('cloudjob', variant.initial_job.id);
      if (!job && batch.phase === 'ready') throw new FusionError('BATCH_LEDGER_INCOMPLETE', 'A ready batch has a missing child ledger record. It is never recreated because a previous submission cannot be excluded.', 'unknown');
      if (job) {
        this.assertBatchChild(batch, variant, job);
        if (job.provider_id && providers.has(job.provider_id)) throw new FusionError('BATCH_IDENTITY_CONFLICT', 'Two batch variants refer to the same provider job; do not submit further work.', 'unknown');
        if (job.provider_id) providers.add(job.provider_id);
        this.applyBatchConflict(job, conflict);
      }
      jobs.push(job);
    }
    return jobs;
  }
  private async readBatchConflict(batch: CloudBatchRecord): Promise<CloudBatchConflictRecord | undefined> {
    const conflict = await this.options.store.get<CloudBatchConflictRecord>('cloudbatchconflict', batch.id);
    if (conflict) {
      assertCloudBatchConflictIntegrity(conflict, batch);
      if (batch.phase !== 'ready') throw new FusionError('BATCH_CONFLICT_TAMPERED', 'Output-conflict evidence cannot precede the ready batch fence.');
    }
    return conflict;
  }
  private applyBatchConflict(job: CloudJobRecord, conflict?: CloudBatchConflictRecord): void {
    const involved = conflict?.job_bindings.some(binding => binding.job_id === job.id);
    if (job.output_identity_conflict && (!involved || job.output_identity_conflict.batch_id !== conflict!.batch_id || job.output_identity_conflict.receipt_hash !== conflict!.receipt_hash || job.output_identity_conflict.disposition !== 'historical_validation_unusable')) throw new FusionError('BATCH_CONFLICT_LEDGER_INCOMPLETE', 'An implicated job is missing its exact durable output-conflict receipt. Do not clear the flag or resume work.', 'unknown');
    if (involved) {
      job.output_identity_conflict = { batch_id: conflict!.batch_id, receipt_hash: conflict!.receipt_hash, disposition: 'historical_validation_unusable' };
      job.validation_usable = false;
      job.status = 'failed';
      job.error = { code: 'OUTPUT_IDENTITY_CONFLICT', message: 'A trusted output validator observed a shared artifact identity between variants. Cached validation remains historical evidence and is not usable for acceptance. This batch has no automatic reconciliation or clearing path.', outcome: 'partial' };
    } else if (job.validation_in_progress) job.validation_usable = false;
    else delete job.validation_usable;
  }
  private async batchView(batch: CloudBatchRecord, jobs: readonly (CloudJobRecord | undefined)[]): Promise<CloudBatchInspection> {
    return inspectCloudBatch(batch, jobs, await this.readBatchConflict(batch));
  }
  private async materializeBatch(batch: CloudBatchRecord): Promise<CloudJobRecord[]> {
    const jobs = await this.batchJobs(batch);
    if (batch.phase === 'ready') return jobs as CloudJobRecord[];
    // All existing children were checked before writing even one missing child.
    // No submission path accepts children until the durable ready fence exists.
    for (const [index, variant] of batch.variants.entries()) if (!jobs[index]) {
      await this.options.store.put('cloudjob', variant.initial_job.id, variant.initial_job);
      jobs[index] = structuredClone(variant.initial_job);
    }
    batch.phase = 'ready';
    await this.options.store.put('cloudbatch', batch.id, batch);
    await this.options.store.audit('cloud_batch_ready', { id: batch.id, plan_hash: batch.plan_hash, job_ids: batch.variants.map(variant => variant.initial_job.id) });
    return jobs as CloudJobRecord[];
  }
  async prepareBatch(input: unknown): Promise<CloudBatchInspection> {
    const parsed = parseCloudBatchInput(input), { request_key, ...request } = parsed;
    if (!this.automation) throw new FusionError('AUTOMATION_NOT_CONFIGURED', 'No reviewed Automation recipe registry is installed.');
    return this.guarded(async () => {
      const requestKeyHash = hash(request_key), id = cloudBatchId(this.options.profile.id, requestKeyHash), requestHash = hash(request);
      if (await this.options.store.get<CloudBatchRecord>('cloudbatch', id)) {
        const existing = await this.readBatchRecord(id);
        if (existing.request_hash !== requestHash) throw new FusionError('IDEMPOTENCY_CONFLICT', 'This batch request key is already bound to a different ordered request.');
        return this.batchView(existing, await this.materializeBatch(existing));
      }
      const binding = await this.accountBinding();
      const recipe = this.automation!.listRecipes().find(recipe => recipe.id === request.recipe_id);
      if (!recipe || !Number.isSafeInteger(recipe.limits.maxVariants) || request.variants.length > recipe.limits.maxVariants) throw new FusionError('BATCH_RECIPE_LIMIT', 'The whole batch must fit the installed reviewed recipe variant limit.');
      if (!this.options.profile.cloud?.budget) throw new FusionError('BUDGET_REQUIRED', 'Whole-batch preparation requires an explicit admission budget.');
      const variants: CloudBatchVariant[] = [];
      // Complete every input/source/activity preparation before creating durable
      // children. A malformed late variant therefore consumes no workitem.
      for (const variant of request.variants) {
        let prepared: PreparedAutomationJob;
        try { prepared = await this.automation!.prepare(request.recipe_id, variant.inputs, cloudBatchContext(request)); }
        catch (error) { throw new FusionError('BATCH_PREFLIGHT_FAILED', 'A variant failed whole-batch preparation. No workitem was submitted.', 'none', { variant_id: variant.variant_id, cause: batchErrorCode(error) }); }
        assertPreparedBatchVariant(request, variant, prepared);
        const job = this.initialJob(prepared, binding, { batch_id: id, variant_id: variant.variant_id, request_hash: requestHash });
        this.assertPreparedJob(job);
        variants.push({ variant_id: variant.variant_id, idempotency_key: cloudBatchChildKey(id, variant.variant_id), initial_job: job });
      }
      await this.check(); await this.ensureAccount(binding);
      const { budget, period, reserved } = await this.admissionSnapshot();
      const amount = variants.reduce((sum, variant) => sum + variant.initial_job.prepared.reservation.amount, 0);
      if (variants.some(variant => variant.initial_job.prepared.reservation.currency !== budget.currency)) throw new FusionError('BUDGET_UNIT_MISMATCH', 'Every batch child must use the configured budget currency.');
      if (!Number.isFinite(amount) || period.length + variants.length > budget.maxSubmissions || reserved + amount > budget.maxReservedUnits) throw new FusionError('BATCH_BUDGET_EXHAUSTED', 'The whole batch does not fit the current total submission and estimated reservation budget. Preparation reserves no capacity.');
      const batch: CloudBatchRecord = { schema_version: 1, id, plan_hash: '', request_hash: requestHash, request_key_hash: requestKeyHash, request, created_at: now(), expires_at: new Date(Math.min(...variants.map(variant => Math.min(Date.parse(variant.initial_job.prepared.expiresAt), Date.parse(variant.initial_job.created_at) + this.options.profile.policy.planMaxAgeMs)))).toISOString(), profile_id: this.options.profile.id, profile_hash: profileHash(this.options.profile), scope_hash: this.scopeBinding(), authorization_binding: binding, budget_period: budget.period, currency: budget.currency, estimated_reservation: amount, variants, phase: 'materializing' };
      batch.plan_hash = hash(cloudBatchBinding(batch));
      assertCloudBatchIntegrity(batch);
      // This single durable record binds the request key and the complete child
      // mapping before any child is exposed to a possible submission route.
      await this.options.store.put('cloudbatch', id, batch);
      await this.options.store.audit('cloud_batch_prepared', { id, plan_hash: batch.plan_hash, request_hash: requestHash, variants: variants.length, currency: budget.currency, estimated_reservation: amount });
      return this.batchView(batch, await this.materializeBatch(batch));
    });
  }
  async inspectBatch(id: string): Promise<CloudBatchInspection> {
    return this.guarded(async () => { const batch = await this.readBatchRecord(id); return this.batchView(batch, await this.batchJobs(batch)); });
  }
  async resumeBatch(id: string, expectedHash: string, maxSubmissions: number) {
    if (!/^[a-f0-9]{64}$/.test(expectedHash) || !Number.isSafeInteger(maxSubmissions) || maxSubmissions < 1 || maxSubmissions > 100) throw new FusionError('INVALID_BATCH_INPUT', 'Resume requires the exact plan hash and a submission-wave bound from 1 to 100.');
    if (!this.automation) throw new FusionError('AUTOMATION_NOT_CONFIGURED', 'No reviewed Automation client is configured.');
    return this.guarded(async () => {
      const batch = await this.readBatchRecord(id);
      if (batch.plan_hash !== expectedHash || batch.profile_hash !== profileHash(this.options.profile)) throw new FusionError('PLAN_BINDING_CHANGED', 'Cloud batch plan hash or profile changed.');
      let jobs = await this.materializeBatch(batch);
      const conflict = await this.readBatchConflict(batch);
      const attempted: string[] = [];
      let blocked: { code: string; outcome: string; variant_id?: string } | null = null;
      // Convert abandoned intents through the same durable per-job recovery
      // path. This never calls Automation.submit for an attempted child.
      if (!conflict) for (const [index, job] of jobs.entries()) if (job.status === 'submitting') jobs[index] = await this.submitJobLocked(job.id, job.plan_hash, batch.variants[index]!.idempotency_key, batch);
      if (conflict) blocked = { code: 'OUTPUT_IDENTITY_CONFLICT', outcome: 'partial' };
      else if (jobs.some(job => job.status === 'outcome_unknown' || job.validation_in_progress) || batchArtifactConflicts(jobs).length > 0) blocked = { code: 'BATCH_RECONCILIATION_REQUIRED', outcome: 'none' };
      const pending = jobs.flatMap((job, index) => job.status === 'prepared' ? [{ job, index }] : []);
      if (!blocked && pending.length > 0) {
        // Validate all remaining local plans before the first admission in this
        // wave. Provider source/activity revalidation still runs for each job.
        for (const { job } of pending) this.assertPreparedJob(job);
        await this.check(); await this.ensureAccount(batch.authorization_binding);
        authorize(this.options.profile, 'cloud.job_submit', 'cloud_compute');
        for (const { job, index } of pending.slice(0, maxSubmissions)) {
          const variant = batch.variants[index]!;
          try {
            const result = await this.submitJobLocked(job.id, job.plan_hash, variant.idempotency_key, batch);
            jobs[index] = result;
            if (result.status !== 'prepared') attempted.push(variant.variant_id);
            if (['failed', 'outcome_unknown', 'cancelled'].includes(result.status)) { blocked = { code: 'BATCH_CHILD_REQUIRES_REVIEW', outcome: 'none', variant_id: variant.variant_id }; break; }
          } catch (error) {
            // Admissions rejected before intent remain prepared. If persistence
            // failed after intent, the child ledger retains the recovery fence.
            jobs = await this.batchJobs(batch) as CloudJobRecord[];
            if (jobs[index]!.status !== 'prepared') attempted.push(variant.variant_id);
            blocked = { ...batchErrorCode(error), variant_id: variant.variant_id }; break;
          }
        }
      }
      const result = { ...await this.batchView(batch, jobs), wave: { max_submissions: maxSubmissions, attempted_variant_ids: attempted, admission_blocked: blocked } };
      await this.options.store.audit('cloud_batch_resume', { id, plan_hash: expectedHash, attempted_variant_ids: attempted, admission_blocked: blocked });
      return result;
    });
  }
  async inspectJob(id: string): Promise<CloudJobRecord> {
    await this.check();
    const record = await this.options.store.get<CloudJobRecord>('cloudjob', id);
    if (!record) throw new FusionError('NOT_FOUND', 'Cloud job is outside this profile ledger.');
    if (record.id !== id) throw new FusionError('PLAN_TAMPERED', 'The stored cloud job identity does not match its ledger reference.');
    if (record.scope_hash !== this.scopeBinding() || record.profile_id !== this.options.profile.id || record.prepared.context.tenantId !== this.options.profile.cloud!.tenantId) throw new FusionError('JOB_SCOPE_DENIED', 'Cloud job belongs to a different profile/account/data scope.');
    assertJobIntegrity(record);
    if (record.authorization_binding !== await this.accountBinding()) throw new FusionError('ACCOUNT_CHANGED', 'The Autodesk authorization session changed; an old account plan cannot be reused or read through the new account.');
    if (record.batch) {
      const batch = await this.readBatchRecord(record.batch.batch_id), variant = batch.variants.find(variant => variant.initial_job.id === id);
      if (!variant) throw new FusionError('BATCH_BINDING_CHANGED', 'Cloud job is not in its owning batch manifest.');
      this.assertBatchChild(batch, variant, record);
      this.applyBatchConflict(record, await this.readBatchConflict(batch));
      if (record.validation && (await this.batchJobs(batch)).some(job => job?.validation_in_progress)) record.validation_usable = false;
    }
    return record;
  }
  async submitJob(id: string, expectedHash: string, key: string): Promise<CloudJobRecord> {
    if (!this.automation) throw new FusionError('AUTOMATION_NOT_CONFIGURED', 'No reviewed Automation client is configured.');
    if (!/^[A-Za-z0-9._:-]{8,160}$/.test(key)) throw new FusionError('INVALID_IDEMPOTENCY_KEY', 'Use a unique safe idempotency key.');
    return this.guarded(() => this.submitJobLocked(id, expectedHash, key));
  }
  /** Caller holds the shared queue/lease; batch waves must not nest guarded(). */
  private async submitJobLocked(id: string, expectedHash: string, key: string, batch?: CloudBatchRecord): Promise<CloudJobRecord> {
      const record = await this.inspectJob(id);
      if (record.batch && (!batch || batch.phase !== 'ready' || record.batch.batch_id !== batch.id)) throw new FusionError('BATCH_SUBMISSION_REQUIRED', 'Submit a batch-owned child only through its unchanged ready batch manifest.');
      if (batch && await this.readBatchConflict(batch)) throw new FusionError('OUTPUT_IDENTITY_CONFLICT', 'A durable output conflict blocks all further submissions from this batch.', 'partial');
      if (record.plan_hash !== expectedHash || record.profile_hash !== profileHash(this.options.profile)) throw new FusionError('PLAN_BINDING_CHANGED', 'Cloud plan hash or profile changed.');
      const keyId = hash({ cloud: this.options.profile.id, key });
      const previous = await this.options.store.get<{ job_id: string }>('idempotency', keyId);
      if (previous && previous.job_id !== id) throw new FusionError('IDEMPOTENCY_CONFLICT', 'This key is bound to another cloud submission.');
      if (record.status !== 'prepared') {
        if (record.idempotency_key !== key) throw new FusionError('ALREADY_ATTEMPTED', 'This cloud job was already attempted with another key.');
        if (record.status === 'submitting') { record.status = 'outcome_unknown'; record.error = { code: 'OUTCOME_UNKNOWN', message: 'Submission intent has no final provider receipt. Do not resubmit; retain the reservation and reconcile with Autodesk.', outcome: 'unknown' }; await this.options.store.put('cloudjob', id, record); }
        return record;
      }
      this.assertPreparedJob(record);
      authorize(this.options.profile, 'cloud.job_submit', 'cloud_compute');
      const { budget, jobs, active, period, reserved } = await this.admissionSnapshot();
      if (active.length >= budget.maxConcurrentJobs || period.length >= budget.maxSubmissions || reserved + record.prepared.reservation.amount > budget.maxReservedUnits) throw new FusionError('BUDGET_EXHAUSTED', 'Cloud admission exceeds concurrency, submission count or reserved-cost limits. Unknown work retains its reservation.');
      if (record.prepared.reservation.currency !== budget.currency) throw new FusionError('BUDGET_UNIT_MISMATCH', 'Recipe cost units do not match the profile budget.');
      record.status = 'submitting'; record.submitted = true; record.idempotency_key = key; record.reserved_units = record.prepared.reservation.amount; record.updated_at = now();
      await this.options.store.put('idempotency', keyId, { job_id: id, plan_hash: expectedHash });
      await this.options.store.put('cloudjob', id, record);
      await this.options.store.audit('cloud_submission_intent', { id, plan_hash: expectedHash, reserved_units: record.reserved_units, budget_period: record.budget_period });
      try {
        const status = await this.automation!.submit(record.prepared);
        if (typeof status.providerId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(status.providerId)) throw new FusionError('OUTCOME_UNKNOWN', 'Submission response has no valid provider identity; retain the intent and reservation.', 'unknown');
        if (jobs.some(job => job.id !== record.id && job.submitted && job.provider_id === status.providerId)) throw new FusionError('PROVIDER_IDENTITY_CONFLICT', 'Submission returned another ledger job\'s provider identity; retain this intent and reservation without polling the ambiguous ID.', 'unknown');
        record.provider_id = status.providerId; this.applyProviderStatus(record, status);
      } catch (error) {
        record.error = errorResult(error); record.status = record.error.outcome === 'none' ? 'failed' : 'outcome_unknown';
        if (record.error.outcome === 'none') { record.submitted = false; record.reserved_units = 0; }
      }
      record.updated_at = now(); await this.options.store.put('cloudjob', id, record);
      await this.options.store.audit('cloud_submission_result', { id, status: record.status, provider_id: record.provider_id ?? null, error: record.error ?? null });
      return record;
  }
  async jobStatus(id: string): Promise<CloudJobRecord> {
    return this.guarded(async () => {
      const record = await this.inspectJob(id);
      if (record.provider_id && this.automation) {
        try { this.applyProviderStatus(record, await this.automation.status(record.provider_id)); record.updated_at = now(); }
        catch (error) { record.error = errorResult(error); }
        await this.options.store.put('cloudjob', id, record);
      }
      return record;
    });
  }
  private applyProviderStatus(record: CloudJobRecord, status: AutomationJobStatus): void {
    const terminal = ['validating', 'failed', 'cancelled'].includes(status.status);
    if (status.providerId !== record.provider_id || !['queued', 'running', 'validating', 'failed', 'cancelled', 'outcome_unknown'].includes(status.status) || terminal !== status.completionConfirmed || terminal && status.cancelSupported || record.provider?.completionConfirmed && !terminal) throw new FusionError('INVALID_PROVIDER_STATE', 'Provider job identity or completion evidence is inconsistent.', 'unknown');
    record.provider = status;
    if (record.output_identity_conflict) { record.status = 'failed'; record.validation_usable = false; return; }
    if (status.status === 'validating' && record.validation) {
      const { receipt_hash, ...receipt } = record.validation;
      if (hash(receipt) !== receipt_hash) throw new FusionError('RECEIPT_TAMPERED', 'Stored output validation receipt changed.', 'unknown');
      record.status = receipt.checks.every(check => check.outcome === 'passed') ? 'succeeded' : 'failed';
    } else if (record.status === 'cancel_requested' && ['queued', 'running'].includes(status.status)) {
      // A request to cancel is retained until the provider confirms a terminal state.
    } else record.status = status.status;
  }
  async cancelJob(id: string): Promise<unknown> {
    return this.guarded(async () => {
      const record = await this.inspectJob(id);
      if (!record.provider_id || !this.automation) throw new FusionError('PROVIDER_ID_REQUIRED', 'Cannot cancel a job without an unambiguous provider ID.');
      authorize(this.options.profile, 'cloud.job_cancel', 'cloud_compute');
      this.applyProviderStatus(record, await this.automation.status(record.provider_id));
      if (record.cancellation || !record.provider?.cancelSupported) {
        record.updated_at = now(); await this.options.store.put('cloudjob', id, record);
        if (record.cancellation) return { job: record, cancellation_requested: true, acknowledgement: record.cancellation.acknowledgement, rollback_promised: false };
        return { job: record, cancellation_requested: false, reason: 'Cancellation is not qualified or no longer applicable to this provider state. Its reservation remains held.' };
      }
      record.status = 'cancel_requested'; record.cancellation = { attempted_at: now(), acknowledgement: 'pending' }; record.updated_at = now();
      await this.options.store.put('cloudjob', id, record);
      await this.options.store.audit('cloud_cancel_intent', { id, provider_id: record.provider_id });
      let result: unknown;
      try { result = await this.automation.cancel(record.provider_id); record.cancellation.acknowledgement = 'confirmed'; }
      catch (error) { record.error = errorResult(error); record.cancellation.acknowledgement = record.error.outcome === 'none' ? 'rejected' : 'unknown'; result = { error: record.error }; }
      record.updated_at = now(); await this.options.store.put('cloudjob', id, record);
      await this.options.store.audit('cloud_cancel_requested', { id, provider_id: record.provider_id });
      return { job: record, cancellation: result, rollback_promised: false };
    });
  }
  async validateJob(id: string): Promise<CloudJobRecord> {
    return this.guarded(async () => {
      const record = await this.inspectJob(id);
      const batch = record.batch ? await this.readBatchRecord(record.batch.batch_id) : undefined;
      if (batch) {
        if (await this.readBatchConflict(batch)) throw new FusionError('OUTPUT_IDENTITY_CONFLICT', 'This batch has a durable output-identity conflict. Changing a later validation receipt cannot clear historical evidence; no reconciliation API is implemented.', 'partial');
        if ((await this.batchJobs(batch)).some(job => job?.validation_in_progress)) throw new FusionError('VALIDATION_RECONCILIATION_REQUIRED', 'An earlier batch validation has no durable outcome. Do not rerun it or submit remaining variants; preserve the ledger for explicit reconciliation.', 'unknown');
      }
      const validateOutputs = this.outputValidator();
      if (!validateOutputs) throw new FusionError('VALIDATION_NOT_CONFIGURED', 'This deployment has no trusted recipe output validator. Provider success remains validating; configure a qualified validator instead of asserting success through model input.');
      if (!record.provider_id || !this.automation) throw new FusionError('PROVIDER_ID_REQUIRED', 'Validation requires an unambiguous submitted workitem.');
      if (record.validation) {
        const { receipt_hash, ...receipt } = record.validation;
        if (hash(receipt) !== receipt_hash) throw new FusionError('RECEIPT_TAMPERED', 'Stored validation evidence changed.');
        return record;
      }
      this.applyProviderStatus(record, await this.automation.status(record.provider_id));
      if (record.provider?.status !== 'validating' || !record.provider.completionConfirmed) throw new FusionError('PROVIDER_NOT_COMPLETE', 'Output validation requires confirmed successful provider processing.');
      const recipe = this.automation.listRecipes().find(recipe => recipe.id === record.prepared.recipeId && recipe.version === record.prepared.recipeVersion);
      if (!recipe || recipe.verification.validatorIds.length === 0) throw new FusionError('RECIPE_CHANGED', 'The original recipe validation contract is not available.');
      if (batch) {
        // A validator can observe a collision just before the process/storage
        // fails. Persist an intent first so that lost conflict evidence cannot
        // make a later batch resume appear safe.
        record.validation_in_progress = { attempt_id: newId('validation'), started_at: now(), job_id: id, batch_id: batch.id, request_hash: record.prepared.requestHash };
        record.updated_at = now(); await this.options.store.put('cloudjob', id, record);
      }
      let receipt: CloudValidationReceipt;
      let conflictDetected = false;
      try {
        try { receipt = structuredClone(await validateOutputs(structuredClone(record))); }
        catch { throw new FusionError('VALIDATION_FAILED', 'The trusted output validator could not produce a complete receipt; no successful validation was recorded.'); }
        assertJson(receipt, 1_048_576);
        if (!exactKeys(receipt, ['job_id', 'provider_id', 'request_hash', 'recipe_hash', 'observed_at', 'artifacts', 'checks']) || receipt.job_id !== id || receipt.provider_id !== record.provider_id || receipt.request_hash !== record.prepared.requestHash || receipt.recipe_hash !== record.prepared.recipeHash || !freshEvidence(receipt.observed_at, record.created_at)) throw new FusionError('INVALID_VALIDATION_EVIDENCE', 'Output evidence is stale or does not match the exact stored job and recipe.');
        if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length < 1 || receipt.artifacts.length > 100 || receipt.artifacts.some(artifact => !exactKeys(artifact, ['artifact_id', 'sha256', 'bytes']) || !evidenceRef(artifact.artifact_id) || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1) || new Set(receipt.artifacts.map(artifact => artifact.artifact_id)).size !== receipt.artifacts.length || receipt.artifacts.reduce((bytes, artifact) => bytes + artifact.bytes, 0) > recipe.limits.maxOutputBytes) throw new FusionError('INVALID_VALIDATION_EVIDENCE', 'Validated artifact identities, hashes or byte totals are invalid.');
        if (!Array.isArray(receipt.checks) || receipt.checks.length !== recipe.verification.validatorIds.length || receipt.checks.some(check => !exactKeys(check, ['validator_id', 'outcome', 'evidence_ref']) || !recipe.verification.validatorIds.includes(check.validator_id) || !['passed', 'failed'].includes(check.outcome) || !evidenceRef(check.evidence_ref)) || new Set(receipt.checks.map(check => check.validator_id)).size !== receipt.checks.length) throw new FusionError('INVALID_VALIDATION_EVIDENCE', 'Every required recipe validator must supply exactly one bound pass/fail result and an opaque evidence reference.');
        if (batch) {
          const jobs = await this.batchJobs(batch);
          const candidate = { ...record, validation: { ...receipt, receipt_hash: hash(receipt) } };
          const conflicts = batchArtifactConflicts(jobs.map(job => job?.id === record.id ? candidate : job));
          if (conflicts.length > 0) {
            conflictDetected = true;
            await this.recordOutputConflict(batch, jobs as CloudJobRecord[], record, receipt, conflicts);
          }
        }
      } catch (error) {
        if (batch && !conflictDetected) {
          // A completed known validation failure has not produced an accepted
          // collision observation. It may be explicitly retried as a read; a
          // crash or failed write leaves the durable intent unresolved instead.
          delete record.validation_in_progress;
          record.updated_at = now(); await this.options.store.put('cloudjob', id, record);
        }
        throw error;
      }
      record.validation = { ...receipt, receipt_hash: hash(receipt) };
      record.status = receipt.checks.every(check => check.outcome === 'passed') ? 'succeeded' : 'failed';
      delete record.validation_in_progress;
      record.updated_at = now();
      await this.options.store.put('cloudjob', id, record);
      await this.options.store.audit('cloud_output_validation', { id, status: record.status, validation: record.validation, publication_performed: false });
      return record;
    });
  }
  private async recordOutputConflict(batch: CloudBatchRecord, jobs: CloudJobRecord[], trigger: CloudJobRecord, candidate: CloudValidationReceipt, conflicts: CloudBatchConflictRecord['conflicts']): Promise<never> {
    const involved = new Set(conflicts.flatMap(conflict => conflict.job_ids));
    const candidateHash = hash(candidate);
    const fence: CloudBatchConflictRecord = {
      schema_version: 1, id: batch.id, batch_id: batch.id, batch_plan_hash: batch.plan_hash, request_hash: batch.request_hash,
      detected_at: now(), trigger_job_id: trigger.id, code: 'OUTPUT_IDENTITY_CONFLICT', source: 'trusted_output_validator', resolution: 'blocked_no_reconciliation_api',
      candidate_receipt_sha256: candidateHash, conflicts: structuredClone(conflicts),
      job_bindings: jobs.filter(job => involved.has(job.id)).map(job => ({ job_id: job.id, plan_hash: job.plan_hash, validation_receipt_sha256: job.id === trigger.id ? candidateHash : job.validation!.receipt_hash })),
      receipt_hash: '',
    };
    fence.receipt_hash = hash(cloudBatchConflictBinding(fence));
    assertCloudBatchConflictIntegrity(fence, batch);
    // The deterministic separate receipt blocks the whole batch even if saving
    // one of the implicated job projections fails. It is never overwritten.
    if (await this.readBatchConflict(batch)) throw new FusionError('OUTPUT_IDENTITY_CONFLICT', 'This batch already has a durable output conflict.', 'partial');
    await this.options.store.put('cloudbatchconflict', batch.id, fence);
    for (const job of jobs.filter(job => involved.has(job.id))) {
      this.applyBatchConflict(job, fence); delete job.validation_in_progress;
      job.updated_at = now(); await this.options.store.put('cloudjob', job.id, job);
    }
    await this.options.store.audit('cloud_batch_output_conflict', { batch_id: batch.id, batch_plan_hash: batch.plan_hash, conflict_receipt_hash: fence.receipt_hash, job_ids: fence.job_bindings.map(job => job.job_id) });
    throw new FusionError('OUTPUT_IDENTITY_CONFLICT', 'A trusted validator observed a shared artifact identity between batch variants. The durable conflict blocks further batch submissions and invalidates implicated cached validation for acceptance. No clearing or reconciliation API is implemented.', 'partial');
  }
  async settleJob(id: string): Promise<CloudJobRecord> {
    return this.guarded(async () => {
      const record = await this.inspectJob(id);
      const reconcileBilling = this.billingReconciler();
      if (!reconcileBilling) throw new FusionError('BILLING_RECONCILIATION_NOT_CONFIGURED', 'This deployment has no trusted provider metering or invoice reconciler. Estimated reservations remain unresolved; no model-supplied amount can release them.');
      if (!record.provider_id || !this.automation || !record.submitted) throw new FusionError('PROVIDER_ID_REQUIRED', 'Settlement requires a submitted job with an unambiguous provider ID.');
      if (record.settlement) {
        const { receipt_hash, ...receipt } = record.settlement;
        if (hash(receipt) !== receipt_hash) throw new FusionError('RECEIPT_TAMPERED', 'Stored billing evidence changed.');
        return record;
      }
      this.applyProviderStatus(record, await this.automation.status(record.provider_id));
      if (!record.provider?.completionConfirmed || !['validating', 'failed', 'cancelled'].includes(record.provider.status)) throw new FusionError('PROVIDER_NOT_COMPLETE', 'Running, pending and uncertain workitems cannot release their billing exposure.');
      let receipt: CloudBillingReceipt;
      try { receipt = structuredClone(await reconcileBilling(structuredClone(record))); }
      catch { throw new FusionError('BILLING_UNRESOLVED', 'The trusted billing integration could not produce final actual-cost evidence; the reservation remains held.'); }
      assertJson(receipt, 65_536);
      if (!exactKeys(receipt, ['job_id', 'provider_id', 'request_hash', 'currency', 'actual_amount', 'observed_at', 'evidence_ref', 'source', 'final']) || receipt.job_id !== id || receipt.provider_id !== record.provider_id || receipt.request_hash !== record.prepared.requestHash || receipt.currency !== record.prepared.reservation.currency || !Number.isFinite(receipt.actual_amount) || receipt.actual_amount < 0 || receipt.final !== true || !['provider_meter', 'provider_invoice', 'enterprise_billing_reconciliation'].includes(receipt.source) || !evidenceRef(receipt.evidence_ref) || !freshEvidence(receipt.observed_at, record.created_at)) throw new FusionError('INVALID_BILLING_EVIDENCE', 'Final actual-cost evidence is stale, unqualified or does not match the exact stored job and currency.');
      record.settlement = { ...receipt, receipt_hash: hash(receipt) };
      record.reserved_units = 0;
      record.updated_at = now();
      await this.options.store.put('cloudjob', id, record);
      await this.options.store.audit('cloud_billing_reconciled', { id, actual_amount: receipt.actual_amount, currency: receipt.currency, evidence_ref: receipt.evidence_ref, cost_exceeds_estimate: receipt.actual_amount > record.prepared.reservation.amount });
      return record;
    });
  }
  async prepareBomSync(source: BomSnapshot, target: BomSnapshot, ownership: BomFieldOwnership[], mappings?: BomMapping[]): Promise<unknown> {
    if (source.context.tenantId !== this.options.profile.cloud?.tenantId || target.context.tenantId !== this.options.profile.cloud?.tenantId) throw new FusionError('TENANT_MISMATCH', 'BOMs must belong to this configured tenant context.');
    const draft = planBomSync(source, target, ownership, mappings ? { mappings } : {});
    const id = newId('data_draft');
    await this.options.store.put('outbox', id, JSON.parse(JSON.stringify({ id, ...draft, requested_rule_origin: 'Caller-provided comparison policy; this does not authorize publication.', created_at: now() })));
    return { id, ...draft };
  }
  async prepareProperty(context: MfgContext, propertyId: string, after: string | number | boolean | null, requireAtomic = true): Promise<CloudDataPlan> {
    return this.guarded(async () => {
      const binding = await this.accountBinding();
      const draft = await this.aps.prepareMfgPropertyChange(context, propertyId, after);
      await this.ensureAccount(binding);
      const plan: CloudDataPlan = { id: newId('data_plan'), hash: '', profile_hash: profileHash(this.options.profile), scope_hash: this.scopeBinding(), authorization_binding: binding, created_at: now(), expires_at: new Date(Date.now() + this.options.profile.policy.planMaxAgeMs).toISOString(), operation: 'mfg.property_set', draft, require_atomic_concurrency: requireAtomic, status: 'prepared' };
      plan.hash = hash(dataBinding(plan)); await this.options.store.put('dataplan', plan.id, plan);
      await this.options.store.audit('data_plan_prepared', { id: plan.id, hash: plan.hash, operation: plan.operation, require_atomic_concurrency: requireAtomic }); return plan;
    });
  }
  async inspectDataPlan(id: string): Promise<CloudDataPlan> {
    await this.check();
    const plan = await this.options.store.get<CloudDataPlan>('dataplan', id);
    if (!plan) throw new FusionError('NOT_FOUND', 'Data plan is outside this profile.');
    if (plan.scope_hash !== this.scopeBinding() || plan.draft.context.modelId && !this.options.profile.cloud!.mfgModels.some(model => model.modelId === plan.draft.context.modelId)) throw new FusionError('DATA_SCOPE_DENIED', 'Data plan belongs to a different profile/model scope.');
    if (plan.authorization_binding !== await this.accountBinding()) throw new FusionError('ACCOUNT_CHANGED', 'The Autodesk authorization session changed after this data plan was prepared.');
    if (hash(dataBinding(plan)) !== plan.hash) throw new FusionError('PLAN_TAMPERED', 'Data plan hash does not match.'); return plan;
  }
  async executeDataPlan(id: string, expectedHash: string, key: string): Promise<CloudDataPlan> {
    return this.guarded(async () => {
      const plan = await this.inspectDataPlan(id);
      if (!/^[A-Za-z0-9._:-]{8,160}$/.test(key)) throw new FusionError('INVALID_IDEMPOTENCY_KEY', 'Use a unique safe idempotency key.');
      if (plan.hash !== expectedHash || plan.profile_hash !== profileHash(this.options.profile)) throw new FusionError('PLAN_BINDING_CHANGED', 'Data plan or profile changed.');
      const keyId = hash({ data: this.options.profile.id, key });
      const previous = await this.options.store.get<{ plan_id: string }>('idempotency', keyId);
      if (previous && previous.plan_id !== id) throw new FusionError('IDEMPOTENCY_CONFLICT', 'This key is bound to another data mutation.');
      if (plan.status !== 'prepared') {
        if (plan.idempotency_key !== key) throw new FusionError('ALREADY_ATTEMPTED', 'This data plan has already been attempted.');
        if (plan.status === 'executing') { plan.status = 'outcome_unknown'; await this.options.store.put('dataplan', id, plan); }
        return plan;
      }
      if (Date.parse(plan.expires_at) <= Date.now()) throw new FusionError('PLAN_EXPIRED', 'Data plan has expired.');
      authorize(this.options.profile, plan.operation, 'cloud_write');
      if (!plan.require_atomic_concurrency && !this.options.profile.policy.allowNonAtomicCloudWrites) throw new FusionError('ATOMIC_CONCURRENCY_REQUIRED', 'The profile has not accepted the documented compare-and-set limitation.');
      plan.status = 'executing'; plan.idempotency_key = key;
      await this.options.store.put('idempotency', keyId, { plan_id: id }); await this.options.store.put('dataplan', id, plan);
      await this.options.store.audit('data_write_intent', { id, hash: expectedHash, operation: plan.operation });
      try {
        const result = await this.aps.executeMfgPropertyChange(plan.draft, { requireAtomicConcurrency: plan.require_atomic_concurrency, authorize: async () => { await this.check(); await this.ensureAccount(plan.authorization_binding); authorize(this.options.profile, plan.operation, 'cloud_write'); } });
        plan.result = result;
        const status = (result as { status?: string }).status;
        plan.status = status === 'verified' || status === 'succeeded' ? 'succeeded' : status === 'partial_failure' ? 'failed' : 'outcome_unknown';
      } catch (error) { const detail = errorResult(error); plan.status = detail.outcome === 'none' || detail.outcome === 'partial' ? 'failed' : 'outcome_unknown'; plan.result = { error: detail }; }
      await this.options.store.put('dataplan', id, plan); await this.options.store.audit('data_write_result', { id, status: plan.status, result: plan.result }); return plan;
    });
  }
}

export { compareBoms, normalizeBom };
