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
function jobBinding(job: CloudJobRecord) { return { id: job.id, created_at: job.created_at, prepared: job.prepared, profile: job.profile_hash, scope: job.scope_hash, authorization: job.authorization_binding, profile_id: job.profile_id, budget_period: job.budget_period }; }
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
      const id = newId('cloudjob');
      const record: CloudJobRecord = { id, prepared, plan_hash: '', profile_hash: profileHash(this.options.profile), scope_hash: this.scopeBinding(), authorization_binding: binding, profile_id: this.options.profile.id, status: 'prepared', created_at: now(), updated_at: now(), reserved_units: 0, budget_period: this.options.profile.cloud?.budget?.period ?? 'unconfigured', submitted: false };
      record.plan_hash = hash(jobBinding(record));
      await this.options.store.put('cloudjob', id, record);
      await this.options.store.audit('cloud_job_prepared', { id, plan_hash: record.plan_hash, recipe_id: recipeId, reservation: prepared.reservation });
      return record;
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
    return record;
  }
  async submitJob(id: string, expectedHash: string, key: string): Promise<CloudJobRecord> {
    if (!this.automation) throw new FusionError('AUTOMATION_NOT_CONFIGURED', 'No reviewed Automation client is configured.');
    if (!/^[A-Za-z0-9._:-]{8,160}$/.test(key)) throw new FusionError('INVALID_IDEMPOTENCY_KEY', 'Use a unique safe idempotency key.');
    return this.guarded(async () => {
      const record = await this.inspectJob(id);
      if (record.plan_hash !== expectedHash || record.profile_hash !== profileHash(this.options.profile)) throw new FusionError('PLAN_BINDING_CHANGED', 'Cloud plan hash or profile changed.');
      const keyId = hash({ cloud: this.options.profile.id, key });
      const previous = await this.options.store.get<{ job_id: string }>('idempotency', keyId);
      if (previous && previous.job_id !== id) throw new FusionError('IDEMPOTENCY_CONFLICT', 'This key is bound to another cloud submission.');
      if (record.status !== 'prepared') {
        if (record.idempotency_key !== key) throw new FusionError('ALREADY_ATTEMPTED', 'This cloud job was already attempted with another key.');
        if (record.status === 'submitting') { record.status = 'outcome_unknown'; record.error = { code: 'OUTCOME_UNKNOWN', message: 'Submission intent has no final provider receipt. Do not resubmit; retain the reservation and reconcile with Autodesk.', outcome: 'unknown' }; await this.options.store.put('cloudjob', id, record); }
        return record;
      }
      const expiresAt = Math.min(Date.parse(record.prepared.expiresAt), Date.parse(record.created_at) + this.options.profile.policy.planMaxAgeMs);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new FusionError('PLAN_EXPIRED', 'Cloud preparation expired before submission. Prepare and review a fresh job.');
      authorize(this.options.profile, 'cloud.job_submit', 'cloud_compute');
      const budget = this.options.profile.cloud?.budget;
      if (!budget) throw new FusionError('BUDGET_REQUIRED', 'Cloud submission requires an explicit admission budget.');
      const allJobs = await this.options.store.list<CloudJobRecord>('cloudjob');
      const jobs = allJobs.filter(job => job.profile_id === this.options.profile.id && job.prepared.context.tenantId === this.options.profile.cloud!.tenantId);
      jobs.forEach(assertJobIntegrity);
      const active = jobs.filter(j => ['submitting', 'queued', 'running', 'validating', 'outcome_unknown', 'cancel_requested'].includes(j.status));
      const period = jobs.filter(j => j.budget_period === budget.period && j.submitted);
      const exposure = jobs.filter(job => job.submitted && !job.settlement);
      if (exposure.some(job => job.prepared.reservation.currency !== budget.currency)) throw new FusionError('BUDGET_UNIT_MISMATCH', 'Unsettled job exposure has a different currency; reconcile it before changing this budget pool.');
      const reserved = period.reduce((sum, j) => sum + (j.settlement?.actual_amount ?? j.reserved_units), 0) + exposure.filter(j => j.budget_period !== budget.period).reduce((sum, j) => sum + j.reserved_units, 0);
      if (active.length >= budget.maxConcurrentJobs || period.length >= budget.maxSubmissions || reserved + record.prepared.reservation.amount > budget.maxReservedUnits) throw new FusionError('BUDGET_EXHAUSTED', 'Cloud admission exceeds concurrency, submission count or reserved-cost limits. Unknown work retains its reservation.');
      if (record.prepared.reservation.currency !== budget.currency) throw new FusionError('BUDGET_UNIT_MISMATCH', 'Recipe cost units do not match the profile budget.');
      record.status = 'submitting'; record.submitted = true; record.idempotency_key = key; record.reserved_units = record.prepared.reservation.amount; record.updated_at = now();
      await this.options.store.put('idempotency', keyId, { job_id: id, plan_hash: expectedHash });
      await this.options.store.put('cloudjob', id, record);
      await this.options.store.audit('cloud_submission_intent', { id, plan_hash: expectedHash, reserved_units: record.reserved_units, budget_period: record.budget_period });
      try {
        const status = await this.automation!.submit(record.prepared);
        if (typeof status.providerId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(status.providerId)) throw new FusionError('OUTCOME_UNKNOWN', 'Submission response has no valid provider identity; retain the intent and reservation.', 'unknown');
        record.provider_id = status.providerId; this.applyProviderStatus(record, status);
      } catch (error) {
        record.error = errorResult(error); record.status = record.error.outcome === 'none' ? 'failed' : 'outcome_unknown';
        if (record.error.outcome === 'none') { record.submitted = false; record.reserved_units = 0; }
      }
      record.updated_at = now(); await this.options.store.put('cloudjob', id, record);
      await this.options.store.audit('cloud_submission_result', { id, status: record.status, provider_id: record.provider_id ?? null, error: record.error ?? null });
      return record;
    });
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
      if (record.cancellation) return { job: record, cancellation_requested: true, acknowledgement: record.cancellation.acknowledgement, rollback_promised: false };
      if (!record.provider?.cancelSupported) return { job: record, cancellation_requested: false, reason: 'Cancellation is not qualified for this provider activity. Its reservation remains held.' };
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
      let receipt: CloudValidationReceipt;
      try { receipt = structuredClone(await validateOutputs(structuredClone(record))); }
      catch { throw new FusionError('VALIDATION_FAILED', 'The trusted output validator could not produce a complete receipt; no successful validation was recorded.'); }
      assertJson(receipt, 1_048_576);
      if (!exactKeys(receipt, ['job_id', 'provider_id', 'request_hash', 'recipe_hash', 'observed_at', 'artifacts', 'checks']) || receipt.job_id !== id || receipt.provider_id !== record.provider_id || receipt.request_hash !== record.prepared.requestHash || receipt.recipe_hash !== record.prepared.recipeHash || !freshEvidence(receipt.observed_at, record.created_at)) throw new FusionError('INVALID_VALIDATION_EVIDENCE', 'Output evidence is stale or does not match the exact stored job and recipe.');
      if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length < 1 || receipt.artifacts.length > 100 || receipt.artifacts.some(artifact => !exactKeys(artifact, ['artifact_id', 'sha256', 'bytes']) || !evidenceRef(artifact.artifact_id) || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1) || new Set(receipt.artifacts.map(artifact => artifact.artifact_id)).size !== receipt.artifacts.length || receipt.artifacts.reduce((bytes, artifact) => bytes + artifact.bytes, 0) > recipe.limits.maxOutputBytes) throw new FusionError('INVALID_VALIDATION_EVIDENCE', 'Validated artifact identities, hashes or byte totals are invalid.');
      if (!Array.isArray(receipt.checks) || receipt.checks.length !== recipe.verification.validatorIds.length || receipt.checks.some(check => !exactKeys(check, ['validator_id', 'outcome', 'evidence_ref']) || !recipe.verification.validatorIds.includes(check.validator_id) || !['passed', 'failed'].includes(check.outcome) || !evidenceRef(check.evidence_ref)) || new Set(receipt.checks.map(check => check.validator_id)).size !== receipt.checks.length) throw new FusionError('INVALID_VALIDATION_EVIDENCE', 'Every required recipe validator must supply exactly one bound pass/fail result and an opaque evidence reference.');
      record.validation = { ...receipt, receipt_hash: hash(receipt) };
      record.status = receipt.checks.every(check => check.outcome === 'passed') ? 'succeeded' : 'failed';
      record.updated_at = now();
      await this.options.store.put('cloudjob', id, record);
      await this.options.store.audit('cloud_output_validation', { id, status: record.status, validation: record.validation, publication_performed: false });
      return record;
    });
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
