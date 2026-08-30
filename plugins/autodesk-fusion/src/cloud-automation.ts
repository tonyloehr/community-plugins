import { randomUUID } from "node:crypto";
import { ApsClient, validateCloudScope, type CloudScope } from "./cloud.js";
import { APS_ORIGIN, ApsTransport, CloudError, CloudRateLimiter, cloudCanonical, cloudHash, cloudId, cloudSourceHash, cloudString, cloudTimestamp, isCloudObject, type CloudTransportOptions } from "./cloud-http.js";
import type { TokenProvider } from "./oauth.js";

export interface RecipeInputRule {
  type: "string" | "number" | "boolean";
  required: boolean;
  enum?: (string | number | boolean)[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
}
export interface FrozenCloudSource {
  hubId: string;
  projectId: string;
  itemId: string;
  versionId: string;
  configurationId: string | null;
  /** Hash of the exact Data Management version resource; recomputed during prepare and submit. */
  resourceHash: string;
}
export interface RecipeDestination {
  alias: string;
  kind: "fusion_project" | "object_storage";
  hubId?: string;
  projectId?: string;
  /** Exact origin and prefix for approved object storage, never caller-provided signed URLs. */
  origin?: string;
  keyPrefix?: string;
}
export interface ActivityBinding {
  reference: string;
  version: number;
  definitionHash: string;
  engine: string;
  /** Signature is installed by the activity publisher; do not generate one using client secrets. */
  signature?: string;
}
export interface BundleBinding {
  reference: string;
  version: number;
  definitionHash: string;
  packageSha256: string;
}
export interface AutomationRecipe {
  id: string;
  version: string;
  tenantId: string;
  delivery: "inline_script" | "appbundle";
  script?: { source: string; sha256: string; language: "typescript"; entryPoint: string; typeDefinitionsVersion: string };
  activity: ActivityBinding;
  bundles: BundleBinding[];
  inputSchema: Record<string, RecipeInputRule>;
  allowedSources: { hubId: string; projectId: string; itemId: string }[];
  destinations: RecipeDestination[];
  limits: { maxVariants: number; maxInputBytes: number; maxOutputBytes: number; maxProcessingSeconds: number; maxAttempts: 1; minimumDelegatedTokenLifetimeMs: number };
  cost: { kind: "estimated" | "provider_enforced"; currency: string; amountPerVariant: number; priceAsOf: string; evidence: string; providerCeiling?: number };
  authority: "managed_service" | "assisted_public_client" | "provider_constrained_public_client";
  /** Required for constrained public-client claims; signing a generic script activity alone is insufficient. */
  providerEnforcementEvidence?: string;
  dependencyImmutability: "release_alias_revalidated" | "provider_enforced";
  immutabilityEvidence?: string;
  verification: { procedure: string; validatorIds: string[] };
}
export interface AutomationPrepareContext {
  tenantId: string;
  sources: FrozenCloudSource[];
  destinationAlias: string;
  variantCount: number;
  requireHardCap?: boolean;
  requireImmutableEngine?: boolean;
  requireImmutableDependencies?: boolean;
}
export interface ActivityEvidence {
  reference: string;
  version: number;
  engine: string;
  definitionHash: string;
  bundles: { reference: string; version: number; definitionHash: string }[];
  observedAt: string;
  rollingEngine: boolean;
  aliasRacePossible: boolean;
}
export interface PreparedAutomationJob {
  id: string;
  recipeId: string;
  recipeVersion: string;
  recipeHash: string;
  inputs: Record<string, string | number | boolean>;
  context: AutomationPrepareContext;
  activity: ActivityEvidence;
  destination: RecipeDestination;
  reservation: { amount: number; currency: string; kind: "estimated" | "provider_enforced"; hardCap: boolean };
  createdAt: string;
  expiresAt: string;
  warnings: string[];
  requestHash: string;
}
export interface AutomationJobStatus {
  providerId: string;
  providerStatus: string;
  status: "queued" | "running" | "validating" | "failed" | "cancelled" | "outcome_unknown";
  completionConfirmed: boolean;
  validationRequired: boolean;
  cancelSupported: boolean;
  observedAt: string;
  statistics: Record<string, string | number>;
}
export interface AutomationTransferArgument {
  name: string;
  verb: "get" | "put";
  url: string;
  bytes: number;
  sha256?: string;
}
export interface AutomationClientOptions extends Omit<CloudTransportOptions, "tenantId" | "manageTenant"> {
  scope: CloudScope;
  recipes: AutomationRecipe[];
  authMode: "app_only" | "app_with_user" | "public_pkce";
  delegatedTokenProvider?: TokenProvider;
  /** Trusted artifact stager only. Its returned URLs are never included in model-visible plans/status. */
  stageTransfers?: (job: PreparedAutomationJob) => Promise<AutomationTransferArgument[]>;
  permittedTransferOrigins?: string[];
  /** A trusted publisher must qualify provider cancellation for this Fusion activity; default false. */
  cancelQualified?: boolean;
  /** Resolve only provider IDs owned by this tenant in the host's durable job ledger. */
  authorizeExistingJob?: (providerId: string, tenantId: string) => Promise<void>;
  /** Recheck the host policy/account immediately after network preflights, before dispatching a mutation. */
  authorizeSubmission?: (job: Readonly<PreparedAutomationJob>) => Promise<void>;
}

function sha(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new CloudError("INVALID_RECIPE", `${label} must be a SHA-256 digest.`);
}
function reference(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\+[A-Za-z0-9_-]+$/.test(value) || value.length > 512) throw new CloudError("INVALID_RECIPE", "Automation references must be fully qualified, publisher-owned release aliases.");
}
function safeStorageOrigin(origin: string): string {
  let url: URL;
  try { url = new URL(origin); } catch { throw new CloudError("INVALID_RECIPE", "Invalid approved storage origin."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash || origin !== url.origin || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(url.hostname) || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)) throw new CloudError("INVALID_RECIPE", "Approved storage requires an exact public HTTPS origin without credentials or paths.");
  return url.origin;
}
function positive(value: unknown, max: number, label: string, minimum = 1): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > max) throw new CloudError("INVALID_RECIPE", `${label} is outside the configured admission range.`);
}
export function activityDefinitionHash(value: unknown): string {
  if (!isCloudObject(value) || typeof value.engine !== "string" || !Number.isSafeInteger(value.version) || !Array.isArray(value.commandLine) || value.commandLine.some(item => typeof item !== "string") || value.appbundles !== undefined && (!Array.isArray(value.appbundles) || value.appbundles.some(item => typeof item !== "string"))) throw new CloudError("INVALID_RESPONSE", "Activity metadata is incomplete or has an unrecognized schema.");
  return cloudHash({ version: value.version, engine: value.engine, commandLine: value.commandLine, parameters: value.parameters ?? {}, appbundles: value.appbundles ?? [], settings: value.settings ?? {} });
}
export function bundleDefinitionHash(value: unknown): string {
  if (!isCloudObject(value) || typeof value.engine !== "string" || !Number.isSafeInteger(value.version)) throw new CloudError("INVALID_RESPONSE", "App-bundle version metadata is incomplete.");
  // Provider download links can expire. Package digest is reviewed separately and version is re-resolved.
  return cloudHash({ version: value.version, engine: value.engine, settings: value.settings ?? {} });
}
export function validateAutomationRecipe(recipe: AutomationRecipe, scope: CloudScope): AutomationRecipe {
  validateCloudScope(scope);
  if (!isCloudObject(recipe)) throw new CloudError("INVALID_RECIPE", "A reviewed recipe is required.");
  cloudString(recipe.id, "Recipe ID", 128); cloudString(recipe.version, "Recipe version", 128);
  if (recipe.tenantId !== scope.tenantId) throw new CloudError("TENANT_MISMATCH", "Recipe belongs to another tenant context.");
  if (!["inline_script", "appbundle"].includes(recipe.delivery) || !isCloudObject(recipe.activity)) throw new CloudError("INVALID_RECIPE", "Recipe delivery model or activity binding is invalid.");
  reference(recipe.activity.reference); positive(recipe.activity.version, 1_000_000, "Activity version"); sha(recipe.activity.definitionHash, "Activity definition hash");
  if (!/^Autodesk\.Fusion\+[A-Za-z0-9_.-]+$/.test(recipe.activity.engine)) throw new CloudError("INVALID_RECIPE", "Recipe must bind an Autodesk Fusion engine reference.");
  if (recipe.activity.signature !== undefined) cloudString(recipe.activity.signature, "Activity signature", 8192);
  if (!Array.isArray(recipe.bundles) || recipe.bundles.length > 20) throw new CloudError("INVALID_RECIPE", "Recipe app-bundle dependencies must be bounded.");
  const bundles = new Set<string>();
  for (const bundle of recipe.bundles) {
    reference(bundle.reference); positive(bundle.version, 1_000_000, "Bundle version"); sha(bundle.definitionHash, "Bundle definition hash"); sha(bundle.packageSha256, "Bundle package hash");
    if (bundles.has(bundle.reference)) throw new CloudError("INVALID_RECIPE", "Duplicate app-bundle reference.");
    bundles.add(bundle.reference);
  }
  if (recipe.delivery === "inline_script") {
    if (!recipe.script || recipe.script.language !== "typescript") throw new CloudError("INVALID_RECIPE", "Inline recipes require reviewed TypeScript source and a qualified entry point.");
    if (typeof recipe.script.source !== "string" || !recipe.script.source.trim() || Buffer.byteLength(recipe.script.source) > 1_000_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(recipe.script.source)) throw new CloudError("INVALID_RECIPE", "Reviewed TypeScript source must be bounded text without binary control characters.");
    sha(recipe.script.sha256, "Script source hash");
    if (cloudSourceHash(recipe.script.source) !== recipe.script.sha256) throw new CloudError("STALE_RECIPE", "Reviewed recipe code hash does not match its installed source.");
    cloudString(recipe.script.entryPoint, "Recipe entry point", 128); cloudString(recipe.script.typeDefinitionsVersion, "Qualified TypeScript definitions", 128);
  } else if (recipe.script !== undefined || recipe.bundles.length === 0) throw new CloudError("INVALID_RECIPE", "Packaged recipes require reviewed bundle dependencies and cannot inject TaskScript.");
  if (!isCloudObject(recipe.inputSchema) || Object.keys(recipe.inputSchema).length > 100) throw new CloudError("INVALID_RECIPE", "Recipe input schema must be explicit and bounded.");
  for (const [name, rule] of Object.entries(recipe.inputSchema)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) || /token|secret|script|url|authorization|^code$/i.test(name) || !isCloudObject(rule) || !["string", "number", "boolean"].includes(rule.type) || typeof rule.required !== "boolean") throw new CloudError("INVALID_RECIPE", "Recipe inputs must be reviewed data fields, not executable code, credentials or URLs.");
    if (rule.type === "number" && (!Number.isFinite(rule.minimum) || !Number.isFinite(rule.maximum) || rule.minimum! > rule.maximum!)) throw new CloudError("INVALID_RECIPE", "Numeric recipe inputs require explicit finite bounds.");
    if (rule.type === "string") positive(rule.maxLength, 16_384, "String input length");
    if (rule.enum !== undefined && (!Array.isArray(rule.enum) || rule.enum.length === 0 || rule.enum.length > 100 || rule.enum.some(value => typeof value !== rule.type))) throw new CloudError("INVALID_RECIPE", "Recipe input enumerations must match their declared scalar type.");
  }
  if (!Array.isArray(recipe.allowedSources) || recipe.allowedSources.length > 100 || !Array.isArray(recipe.destinations) || recipe.destinations.length < 1 || recipe.destinations.length > 50) throw new CloudError("INVALID_RECIPE", "Recipe sources and destinations must be explicitly bounded.");
  for (const source of recipe.allowedSources) {
    cloudId(source.itemId);
    if (!scope.projects.some(project => project.hubId === source.hubId && project.projectId === source.projectId)) throw new CloudError("SCOPE_DENIED", "Recipe source project is outside the configured scope.");
  }
  const destinations = new Set<string>();
  for (const destination of recipe.destinations) {
    cloudString(destination.alias, "Destination alias", 128);
    if (destinations.has(destination.alias)) throw new CloudError("INVALID_RECIPE", "Recipe destination aliases must be unique.");
    destinations.add(destination.alias);
    if (destination.kind === "fusion_project") {
      if (!scope.projects.some(project => project.hubId === destination.hubId && project.projectId === destination.projectId) || destination.origin !== undefined || destination.keyPrefix !== undefined) throw new CloudError("SCOPE_DENIED", "Fusion destination must resolve to one authorized hub/project.");
    } else if (destination.kind === "object_storage") {
      if (!destination.origin || !destination.keyPrefix || destination.hubId !== undefined || destination.projectId !== undefined) throw new CloudError("INVALID_RECIPE", "Storage destination requires its own exact origin and tenant-specific prefix.");
      safeStorageOrigin(destination.origin);
      if (!/^\/[A-Za-z0-9_/-]+\/$/.test(destination.keyPrefix) || destination.keyPrefix.includes("//") || destination.keyPrefix.length > 1024) throw new CloudError("INVALID_RECIPE", "Object storage prefix must be an explicit absolute directory prefix without traversal.");
    } else throw new CloudError("INVALID_RECIPE", "Unknown recipe output destination kind.");
  }
  if (!isCloudObject(recipe.limits)) throw new CloudError("INVALID_RECIPE", "Recipe admission limits are required.");
  positive(recipe.limits.maxVariants, 10_000, "Variant limit");
  positive(recipe.limits.maxInputBytes, 2_000_000_000, "Input byte limit");
  positive(recipe.limits.maxOutputBytes, 2_000_000_000, "Output byte limit");
  positive(recipe.limits.maxProcessingSeconds, 86_400, "Processing duration");
  positive(recipe.limits.minimumDelegatedTokenLifetimeMs, 3_600_000, "Delegated token lifetime", 30_000);
  if (recipe.limits.maxAttempts !== 1) throw new CloudError("INVALID_RECIPE", "Automatic workitem resubmission is disabled; each retry needs a new reconciled plan.");
  if (!isCloudObject(recipe.cost) || !["estimated", "provider_enforced"].includes(recipe.cost.kind) || !/^[A-Z]{3}$/.test(recipe.cost.currency) || !Number.isFinite(recipe.cost.amountPerVariant) || recipe.cost.amountPerVariant < 0) throw new CloudError("INVALID_RECIPE", "A dated, explicit recipe cost model is required.");
  cloudTimestamp(recipe.cost.priceAsOf); cloudString(recipe.cost.evidence, "Cost model evidence", 2048);
  if (recipe.cost.kind === "provider_enforced" && (!Number.isFinite(recipe.cost.providerCeiling) || recipe.cost.providerCeiling! < 0)) throw new CloudError("INVALID_RECIPE", "Provider-enforced cost claims require a configured ceiling and verified evidence.");
  if (!["managed_service", "assisted_public_client", "provider_constrained_public_client"].includes(recipe.authority)) throw new CloudError("INVALID_RECIPE", "Recipe execution authority must be explicit.");
  if (recipe.authority === "provider_constrained_public_client") cloudString(recipe.providerEnforcementEvidence, "Provider input, scope and budget enforcement evidence", 4096);
  if (!["release_alias_revalidated", "provider_enforced"].includes(recipe.dependencyImmutability)) throw new CloudError("INVALID_RECIPE", "Dependency immutability must be classified explicitly.");
  if (recipe.dependencyImmutability === "provider_enforced") cloudString(recipe.immutabilityEvidence, "Provider dependency immutability evidence", 4096);
  if (!isCloudObject(recipe.verification) || !Array.isArray(recipe.verification.validatorIds) || recipe.verification.validatorIds.length === 0 || recipe.verification.validatorIds.length > 20) throw new CloudError("INVALID_RECIPE", "Recipe-specific artifact validation is required.");
  cloudString(recipe.verification.procedure, "Verification procedure", 4096);
  recipe.verification.validatorIds.forEach(id => cloudString(id, "Validator ID", 128));
  if (Buffer.byteLength(cloudCanonical(recipe)) > 1_500_000) throw new CloudError("INVALID_RECIPE", "Recipe configuration is too large.");
  return structuredClone(recipe);
}

export class AutomationClient {
  #options: AutomationClientOptions;
  #scope: CloudScope;
  #transport: ApsTransport;
  #data: ApsClient;
  #delegated?: ApsTransport;
  #recipes = new Map<string, AutomationRecipe>();
  #knownJobs = new Set<string>();
  #attemptedJobs = new Set<string>();
  #now: () => number;
  constructor(options: AutomationClientOptions) {
    this.#scope = validateCloudScope(options.scope);
    if (!["app_only", "app_with_user", "public_pkce"].includes(options.authMode)) throw new CloudError("INVALID_ARGUMENT", "Select one documented Fusion Automation authorization path.");
    if (options.authMode === "app_with_user" && !options.delegatedTokenProvider || options.authMode !== "app_with_user" && options.delegatedTokenProvider) throw new CloudError("INVALID_ARGUMENT", "A delegated user token provider belongs only to the app-with-user authorization path.");
    if (!Array.isArray(options.recipes) || options.recipes.length > 100) throw new CloudError("INVALID_RECIPE", "The approved recipe registry is missing or too large.");
    this.#options = { ...options, permittedTransferOrigins: [...(options.permittedTransferOrigins ?? [])] };
    this.#options.permittedTransferOrigins!.forEach(safeStorageOrigin);
    this.#now = options.now ?? Date.now;
    const common = { ...options, limiter: options.limiter ?? new CloudRateLimiter(), tenantId: this.#scope.tenantId };
    this.#transport = new ApsTransport(common);
    this.#data = new ApsClient({ ...common, scope: this.#scope, tokenProvider: options.authMode === "app_with_user" ? options.delegatedTokenProvider! : options.tokenProvider });
    if (options.delegatedTokenProvider) this.#delegated = new ApsTransport({ ...common, tokenProvider: options.delegatedTokenProvider });
    for (const recipe of options.recipes) {
      if (this.#recipes.has(recipe.id)) throw new CloudError("INVALID_RECIPE", "Recipe IDs must be unique within a tenant registry.");
      this.#recipes.set(recipe.id, validateAutomationRecipe(recipe, this.#scope));
    }
  }
  toJSON() { return { type: "Fusion_Automation", tenantId: this.#scope.tenantId, authMode: this.#options.authMode, recipeIds: [...this.#recipes.keys()], cancelQualified: this.#options.cancelQualified === true }; }
  listRecipes() { return [...this.#recipes.values()].map(recipe => ({ id: recipe.id, version: recipe.version, delivery: recipe.delivery, inputSchema: structuredClone(recipe.inputSchema), destinations: recipe.destinations.map(destination => destination.alias), limits: structuredClone(recipe.limits), cost: structuredClone(recipe.cost), authority: recipe.authority, rollingEngine: recipe.activity.engine.endsWith("+Latest"), verification: structuredClone(recipe.verification) })); }
  #recipe(id: string) {
    const recipe = this.#recipes.get(id);
    if (!recipe) throw new CloudError("SCOPE_DENIED", "Recipe is not installed in this tenant's reviewed registry.");
    return recipe;
  }
  async resolveActivity(recipeId: string): Promise<ActivityEvidence> {
    const recipe = this.#recipe(recipeId);
    const response = await this.#transport.send({ path: `/da/us-east/v3/activities/${cloudId(recipe.activity.reference)}`, method: "GET", scopes: ["code:all"], safeRead: true });
    const data = response.data;
    const hash = activityDefinitionHash(data);
    if (!isCloudObject(data) || data.version !== recipe.activity.version || data.engine !== recipe.activity.engine || hash !== recipe.activity.definitionHash) throw new CloudError("STALE_RECIPE", "The activity alias, version, engine or executable definition changed after review.");
    const refs = (data.appbundles ?? []) as string[];
    if (cloudCanonical([...refs].sort()) !== cloudCanonical(recipe.bundles.map(bundle => bundle.reference).sort())) throw new CloudError("STALE_RECIPE", "The activity's app-bundle dependencies differ from the approved recipe.");
    if (!isCloudObject(data.parameters) || !isCloudObject(data.parameters.TaskParameters) || data.parameters.TaskParameters.verb !== "read") throw new CloudError("INVALID_RECIPE", "This adapter requires the reviewed Fusion TaskParameters string contract.");
    if (recipe.delivery === "inline_script" && (!isCloudObject(data.parameters.TaskScript) || data.parameters.TaskScript.verb !== "read")) throw new CloudError("INVALID_RECIPE", "The reviewed inline activity must accept Fusion TaskScript as a read argument.");
    if (Object.hasOwn(data.parameters, "PersonalAccessToken") && isCloudObject(data.parameters.PersonalAccessToken) && data.parameters.PersonalAccessToken.required === true) throw new CloudError("UNSUPPORTED_AUTH", "The activity still requires deprecated PAT authentication; republish it with supported OAuth.");
    const bundles: ActivityEvidence["bundles"] = [];
    for (const binding of recipe.bundles) {
      const reply = await this.#transport.send({ path: `/da/us-east/v3/appbundles/${cloudId(binding.reference)}`, method: "GET", scopes: ["code:all"], safeRead: true });
      const definitionHash = bundleDefinitionHash(reply.data);
      if (!isCloudObject(reply.data) || reply.data.version !== binding.version || definitionHash !== binding.definitionHash) throw new CloudError("STALE_RECIPE", "An app-bundle alias or executable dependency changed after review.");
      bundles.push({ reference: binding.reference, version: binding.version, definitionHash });
    }
    return { reference: recipe.activity.reference, version: recipe.activity.version, engine: recipe.activity.engine, definitionHash: hash, bundles, observedAt: new Date(this.#now()).toISOString(), rollingEngine: recipe.activity.engine.endsWith("+Latest"), aliasRacePossible: recipe.dependencyImmutability !== "provider_enforced" };
  }
  #inputs(recipe: AutomationRecipe, inputs: Record<string, string | number | boolean>) {
    if (!isCloudObject(inputs) || Object.keys(inputs).some(key => !Object.hasOwn(recipe.inputSchema, key))) throw new CloudError("INVALID_ARGUMENT", "Only approved recipe input fields are accepted.");
    for (const [key, rule] of Object.entries(recipe.inputSchema)) {
      const value = inputs[key];
      if (value === undefined && !rule.required) continue;
      if (typeof value !== rule.type || typeof value === "string" && (value.length > (rule.maxLength ?? 0) || /^\s*(?:https?|file|data|javascript):/i.test(value)) || typeof value === "number" && (!Number.isFinite(value) || value < rule.minimum! || value > rule.maximum!) || rule.enum && !rule.enum.includes(value!)) throw new CloudError("INVALID_ARGUMENT", "Recipe input does not satisfy its reviewed type, enumeration or bounds.");
    }
    if (Buffer.byteLength(JSON.stringify(inputs)) > recipe.limits.maxInputBytes) throw new CloudError("BUDGET_EXCEEDED", "Recipe input bytes exceed the reviewed limit.");
  }
  async #sources(recipe: AutomationRecipe, context: AutomationPrepareContext) {
    if (!Array.isArray(context.sources) || context.sources.length > 100) throw new CloudError("INVALID_ARGUMENT", "Source dependencies must be explicitly frozen and bounded.");
    const seen = new Set<string>();
    for (const source of context.sources) {
      if (!recipe.allowedSources.some(allowed => allowed.hubId === source.hubId && allowed.projectId === source.projectId && allowed.itemId === source.itemId)) throw new CloudError("SCOPE_DENIED", "Source dependency is outside this recipe's approved project/item scope.");
      cloudId(source.versionId); sha(source.resourceHash, "Source resource hash");
      if (source.configurationId !== null) cloudString(source.configurationId, "Source configuration ID");
      if (seen.has(source.versionId)) throw new CloudError("INVALID_ARGUMENT", "Duplicate source version dependency.");
      seen.add(source.versionId);
      const current = await this.#data.getVersion(source.projectId, source.versionId);
      const item = isCloudObject(current.data) && isCloudObject(current.data.relationships) && isCloudObject(current.data.relationships.item) ? current.data.relationships.item.data : null;
      if (!isCloudObject(item) || item.id !== source.itemId || current.fingerprint !== source.resourceHash) throw new CloudError("STALE_PLAN", "A source version, item binding or dependency resource changed after it was frozen.");
    }
  }
  async prepare(recipeId: string, inputs: Record<string, string | number | boolean>, context: AutomationPrepareContext): Promise<PreparedAutomationJob> {
    const recipe = this.#recipe(recipeId);
    if (!isCloudObject(context) || !Array.isArray(context.sources)) throw new CloudError("INVALID_ARGUMENT", "Automation requires an explicit tenant/source/destination context.");
    if (context.tenantId !== this.#scope.tenantId) throw new CloudError("TENANT_MISMATCH", "Automation context belongs to another tenant.");
    this.#inputs(recipe, inputs);
    if (!Number.isSafeInteger(context.variantCount) || context.variantCount < 1 || context.variantCount > recipe.limits.maxVariants) throw new CloudError("BUDGET_EXCEEDED", "Variant count exceeds the recipe admission limit.");
    const destination = recipe.destinations.find(value => value.alias === context.destinationAlias);
    if (!destination) throw new CloudError("SCOPE_DENIED", "Destination is not approved for this recipe.");
    if (this.#options.authMode === "app_only" && (context.sources.length > 0 || destination.kind === "fusion_project")) throw new CloudError("SCOPE_DENIED", "App-only Automation cannot inherit a user's Fusion account, sources or save destination.");
    if (context.requireHardCap && recipe.cost.kind !== "provider_enforced") throw new CloudError("BUDGET_UNENFORCEABLE", "This is an estimated admission budget, not a verified billing ceiling. A required hard cap cannot be satisfied.");
    if (context.requireImmutableEngine && recipe.activity.engine.endsWith("+Latest")) throw new CloudError("IMMUTABILITY_UNAVAILABLE", "Autodesk.Fusion+Latest is a rolling engine and cannot satisfy immutable-engine requirements.");
    if (context.requireImmutableDependencies && recipe.dependencyImmutability !== "provider_enforced") throw new CloudError("IMMUTABILITY_UNAVAILABLE", "Alias revalidation cannot eliminate an alias-repointing race.");
    const amount = recipe.cost.kind === "provider_enforced" ? recipe.cost.providerCeiling! : recipe.cost.amountPerVariant * context.variantCount;
    if (!Number.isFinite(amount) || amount < recipe.cost.amountPerVariant * context.variantCount) throw new CloudError("BUDGET_EXCEEDED", "The provider ceiling is below the estimated request cost.");
    await this.#sources(recipe, context);
    const activity = await this.resolveActivity(recipeId);
    const warnings = ["Provider success requires separate output, geometry and recipe-specific validation before publication.", "Autodesk Automation Open Network is not an egress isolation boundary."];
    if (activity.rollingEngine) warnings.push("The Fusion engine is rolling Latest; code and activity are recorded but engine immutability is not promised.");
    if (activity.aliasRacePossible) warnings.push("Activity and bundle aliases are revalidated before submission, but a repointing race cannot be excluded.");
    if (recipe.cost.kind === "estimated") warnings.push("The reservation is an estimated admission budget; actual provider billing may exceed it.");
    if (recipe.authority === "assisted_public_client") warnings.push("This public-client activity is assisted only; signing a generic TaskScript activity does not enforce recipe-only authority.");
    const fields = { id: randomUUID(), recipeId, recipeVersion: recipe.version, recipeHash: cloudHash(recipe), inputs: structuredClone(inputs), context: structuredClone(context), activity, destination: structuredClone(destination), reservation: { amount, currency: recipe.cost.currency, kind: recipe.cost.kind, hardCap: recipe.cost.kind === "provider_enforced" }, createdAt: new Date(this.#now()).toISOString(), expiresAt: new Date(this.#now() + 15 * 60_000).toISOString(), warnings };
    return { ...fields, requestHash: cloudHash(fields) };
  }
  async submit(prepared: PreparedAutomationJob): Promise<AutomationJobStatus> {
    const { requestHash, ...fields } = prepared;
    if (cloudHash(fields) !== requestHash || prepared.context.tenantId !== this.#scope.tenantId) throw new CloudError("STALE_PLAN", "The prepared job changed or belongs to another tenant.");
    if (this.#attemptedJobs.has(prepared.id)) throw new CloudError("OUTCOME_UNKNOWN", "This prepared job already had a submission attempt; reconcile its durable host ledger before preparing any new attempt.", "unknown");
    cloudTimestamp(prepared.expiresAt);
    if (Date.parse(prepared.expiresAt) <= this.#now()) throw new CloudError("STALE_PLAN", "The reviewed job preparation expired.");
    const recipe = this.#recipe(prepared.recipeId);
    if (cloudHash(recipe) !== prepared.recipeHash || recipe.version !== prepared.recipeVersion) throw new CloudError("STALE_RECIPE", "The installed recipe changed after job preparation.");
    if (recipe.authority === "assisted_public_client" || this.#options.authMode === "public_pkce" && recipe.authority !== "provider_constrained_public_client") throw new CloudError("ASSISTED_ONLY", "Managed submission requires a trusted service or qualified provider enforcement of recipe, data and budget authority.");
    if (this.#options.authMode === "public_pkce" && !recipe.activity.signature) throw new CloudError("ACTIVITY_UNSIGNED", "Public-client PKCE submission requires a publisher-signed activity.");
    const grant = await this.#transport.token(["code:all"]);
    if (this.#options.authMode === "public_pkce" && grant.grantType !== "authorization_code" || this.#options.authMode !== "public_pkce" && grant.grantType !== "client_credentials") throw new CloudError("UNSUPPORTED_AUTH", "The configured token grant does not match the selected Fusion Automation authorization path.");
    this.#inputs(recipe, prepared.inputs);
    await this.#sources(recipe, prepared.context);
    const activity = await this.resolveActivity(recipe.id);
    if (activity.definitionHash !== prepared.activity.definitionHash || activity.version !== prepared.activity.version || cloudCanonical(activity.bundles) !== cloudCanonical(prepared.activity.bundles)) throw new CloudError("STALE_RECIPE", "Activity dependencies changed between approval and submission.");
    const arguments_: Record<string, unknown> = Object.create(null);
    // Contract for installed recipe authors. This envelope is data, not executable source.
    arguments_.TaskParameters = JSON.stringify({ schemaVersion: 1, requestId: prepared.id, inputs: prepared.inputs, sources: prepared.context.sources, destination: prepared.destination, variantCount: prepared.context.variantCount, limits: recipe.limits });
    if (recipe.delivery === "inline_script") arguments_.TaskScript = recipe.script!.source;
    if (this.#delegated) {
      const delegated = await this.#delegated.token(["data:read", ...(prepared.destination.kind === "fusion_project" ? ["data:write"] : [])], recipe.limits.minimumDelegatedTokenLifetimeMs);
      if (delegated.grantType !== "authorization_code") throw new CloudError("UNSUPPORTED_AUTH", "adsk3LeggedToken requires a separately authorized user-delegated APS grant.");
      arguments_.adsk3LeggedToken = delegated.accessToken;
    }
    await this.#addTransfers(prepared, recipe, arguments_);
    await this.#options.authorizeSubmission?.(structuredClone(prepared));
    const body = { activityId: recipe.activity.reference, arguments: arguments_, limitProcessingTimeSec: recipe.limits.maxProcessingSeconds, ...(this.#options.authMode === "public_pkce" ? { signatures: { activityId: recipe.activity.signature } } : {}) };
    // No automatic retries here. Caller MUST persist intent and budget/capacity reservation before this call.
    this.#attemptedJobs.add(prepared.id);
    const reply = await this.#transport.send({ path: "/da/us-east/v3/workitems", method: "POST", scopes: ["code:all"], safeRead: false, body });
    if (!isCloudObject(reply.data) || typeof reply.data.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(reply.data.id)) throw new CloudError("OUTCOME_UNKNOWN", "Autodesk accepted the workitem but returned no valid durable provider ID. Reconcile before any retry.", "unknown");
    this.#knownJobs.add(reply.data.id);
    return this.#status(reply.data, reply.data.id);
  }
  async #addTransfers(job: PreparedAutomationJob, recipe: AutomationRecipe, arguments_: Record<string, unknown>) {
    if (!this.#options.stageTransfers) {
      if (job.destination.kind === "object_storage") throw new CloudError("DESTINATION_UNAVAILABLE", "Object-storage output requires a qualified trusted artifact stager.");
      return;
    }
    let transfers: AutomationTransferArgument[];
    try { transfers = await this.#options.stageTransfers(structuredClone(job)); }
    catch { throw new CloudError("DESTINATION_UNAVAILABLE", "The trusted artifact stager failed; transfer URLs were not exposed."); }
    if (!Array.isArray(transfers) || transfers.length > 50) throw new CloudError("INVALID_TRANSFER", "Artifact transfer count exceeds the reviewed limit.");
    let inputBytes = Buffer.byteLength(String(arguments_.TaskParameters)) + Buffer.byteLength(String(arguments_.TaskScript ?? "")), outputBytes = 0, outputCount = 0;
    for (const transfer of transfers) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(transfer.name) || /token|secret|script|parameter|callback|oncomplete|onprogress/i.test(transfer.name) || Object.hasOwn(arguments_, transfer.name)) throw new CloudError("INVALID_TRANSFER", "Transfer argument name is reserved or duplicated.");
      positive(transfer.bytes, 2_000_000_000, "Transfer byte limit", 0);
      if (!["get", "put"].includes(transfer.verb)) throw new CloudError("INVALID_TRANSFER", "Only approved artifact input/output transfers are supported.");
      let url: URL;
      try { url = new URL(transfer.url); } catch { throw new CloudError("INVALID_TRANSFER", "Artifact stager returned an invalid transfer URL."); }
      if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || !this.#options.permittedTransferOrigins!.includes(url.origin)) throw new CloudError("INVALID_TRANSFER", "Artifact stager returned a transfer outside its approved origin.");
      if (transfer.verb === "get") { sha(transfer.sha256, "Input artifact hash"); inputBytes += transfer.bytes; }
      else {
        outputCount++; outputBytes += transfer.bytes;
        let decoded: string;
        try { decoded = decodeURIComponent(url.pathname); } catch { throw new CloudError("INVALID_TRANSFER", "Artifact output path encoding is invalid."); }
        if (job.destination.kind !== "object_storage" || url.origin !== job.destination.origin || !decoded.startsWith(job.destination.keyPrefix!) || /[\\\u0000-\u001f]|%(?:2e|2f|5c)/i.test(decoded) || /(?:^|\/)\.\.?(?:\/|$)/.test(decoded)) throw new CloudError("SCOPE_DENIED", "Artifact output URL is outside the tenant's approved destination prefix.");
      }
      arguments_[transfer.name] = { url: url.href, verb: transfer.verb };
    }
    if (inputBytes > recipe.limits.maxInputBytes || outputBytes > recipe.limits.maxOutputBytes) throw new CloudError("BUDGET_EXCEEDED", "Staged transfer bytes exceed the recipe admission budget.");
    if (job.destination.kind === "object_storage" && outputCount === 0) throw new CloudError("DESTINATION_UNAVAILABLE", "No output transfer was staged for the approved storage destination.");
  }
  async #authorizeJob(id: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new CloudError("INVALID_ARGUMENT", "Invalid provider workitem ID.");
    if (this.#options.authorizeExistingJob) await this.#options.authorizeExistingJob(id, this.#scope.tenantId);
    else if (!this.#knownJobs.has(id)) throw new CloudError("SCOPE_DENIED", "Workitem is not bound to this tenant's job ledger.");
  }
  async status(providerId: string): Promise<AutomationJobStatus> {
    await this.#authorizeJob(providerId);
    const result = await this.#transport.send({ path: `/da/us-east/v3/workitems/${cloudId(providerId)}`, method: "GET", scopes: ["code:all"], safeRead: true });
    if (!isCloudObject(result.data) || result.data.id !== undefined && result.data.id !== providerId) throw new CloudError("INVALID_RESPONSE", "Workitem response has an unexpected identity.");
    return this.#status(result.data, providerId);
  }
  #status(data: Record<string, unknown>, providerId: string): AutomationJobStatus {
    const raw = typeof data.status === "string" && /^[A-Za-z0-9_]{1,64}$/.test(data.status) ? data.status : "unknown";
    const status: AutomationJobStatus["status"] = raw === "pending" ? "queued" : raw === "inprogress" ? "running" : raw === "success" ? "validating" : raw === "cancelled" || raw === "cancelledByUser" ? "cancelled" : ["failedLimitDataSize", "failedLimitProcessingTime", "failedDownload", "failedInstructions", "failedUpload", "failedProcessing", "failed", "failedEnvironment", "failedMissingOutput"].includes(raw) ? "failed" : "outcome_unknown";
    const statistics: Record<string, string | number> = Object.create(null);
    if (isCloudObject(data.stats)) for (const [key, value] of Object.entries(data.stats)) if (/^(?:timeQueued|timeDownloadStarted|timeInstructionsStarted|timeInstructionsEnded|timeUploadEnded|bytesDownloaded|bytesUploaded|timeFinished)$/.test(key) && (typeof value === "number" && Number.isFinite(value) || typeof value === "string" && value.length <= 128 && Number.isFinite(Date.parse(value)))) statistics[key] = value as string | number;
    return { providerId, providerStatus: raw, status, completionConfirmed: ["validating", "cancelled", "failed"].includes(status), validationRequired: status === "validating", cancelSupported: this.#options.cancelQualified === true && ["queued", "running"].includes(status), observedAt: new Date(this.#now()).toISOString(), statistics };
  }
  async cancel(providerId: string): Promise<{ providerId: string; status: "cancel_requested"; completionConfirmed: false; reservationMustRemain: true }> {
    await this.#authorizeJob(providerId);
    if (!this.#options.cancelQualified) throw new CloudError("UNSUPPORTED_CAPABILITY", "Cancellation has not been qualified for the deployed Fusion activity; timeout does not imply cancellation.");
    await this.#transport.send({ path: `/da/us-east/v3/workitems/${cloudId(providerId)}`, method: "DELETE", scopes: ["code:all"], safeRead: false });
    return { providerId, status: "cancel_requested", completionConfirmed: false, reservationMustRemain: true };
  }
}

export interface BudgetReservation { jobId: string; amount: number; state: "reserved" | "submitting" | "running" | "unknown" }
export interface BudgetSnapshot { currency: string; limit: number; spent: number; maxConcurrent: number; reservations: BudgetReservation[] }
/** Pure ledger; the host persists snapshot() atomically with its job intent before any submission. */
export class BudgetLedger {
  #snapshot: BudgetSnapshot;
  constructor(snapshot: Omit<BudgetSnapshot, "spent" | "reservations"> & { spent?: number; reservations?: BudgetReservation[] }) {
    if (!/^[A-Z]{3}$/.test(snapshot.currency) || !Number.isFinite(snapshot.limit) || snapshot.limit < 0 || !Number.isFinite(snapshot.spent ?? 0) || (snapshot.spent ?? 0) < 0 || !Number.isSafeInteger(snapshot.maxConcurrent) || snapshot.maxConcurrent < 1 || snapshot.maxConcurrent > 10_000) throw new CloudError("INVALID_ARGUMENT", "Invalid budget ledger configuration.");
    this.#snapshot = { ...structuredClone(snapshot), spent: snapshot.spent ?? 0, reservations: [] };
    const seen = new Set<string>();
    for (const reservation of snapshot.reservations ?? []) {
      cloudString(reservation.jobId, "Reserved job ID", 128);
      if (seen.has(reservation.jobId) || !Number.isFinite(reservation.amount) || reservation.amount < 0 || !["reserved", "submitting", "running", "unknown"].includes(reservation.state)) throw new CloudError("INVALID_ARGUMENT", "Invalid persisted budget reservation.");
      seen.add(reservation.jobId); this.#snapshot.reservations.push(structuredClone(reservation));
    }
  }
  snapshot(): BudgetSnapshot { return structuredClone(this.#snapshot); }
  get exposure() { return this.#snapshot.reservations.reduce((sum, item) => sum + item.amount, 0); }
  reserve(jobId: string, amount: number, currency = this.#snapshot.currency) {
    cloudString(jobId, "Job ID", 128);
    if (currency !== this.#snapshot.currency || !Number.isFinite(amount) || amount < 0) throw new CloudError("INVALID_ARGUMENT", "Reservation currency or amount is invalid.");
    const existing = this.#snapshot.reservations.find(item => item.jobId === jobId);
    if (existing) { if (existing.amount !== amount) throw new CloudError("IDEMPOTENCY_CONFLICT", "A job cannot change its reserved amount."); return; }
    if (this.#snapshot.reservations.length >= this.#snapshot.maxConcurrent || this.#snapshot.spent + this.exposure + amount > this.#snapshot.limit) throw new CloudError("BUDGET_EXCEEDED", "Budget or unresolved concurrency capacity is exhausted.");
    this.#snapshot.reservations.push({ jobId, amount, state: "reserved" });
  }
  mark(jobId: string, state: "submitting" | "running" | "unknown") {
    const reservation = this.#snapshot.reservations.find(item => item.jobId === jobId);
    if (!reservation) throw new CloudError("INVALID_ARGUMENT", "No budget reservation exists for this job.");
    if (!(["submitting", "running", "unknown"] as string[]).includes(state)) throw new CloudError("INVALID_ARGUMENT", "Invalid reservation transition.");
    if (state === "submitting" && reservation.state !== "reserved") throw new CloudError("OUTCOME_UNKNOWN", "An existing submission cannot be restarted until its outcome is reconciled.", "unknown");
    reservation.state = state;
  }
  releaseUnsubmitted(jobId: string) {
    const reservation = this.#snapshot.reservations.find(item => item.jobId === jobId);
    if (!reservation || reservation.state !== "reserved") throw new CloudError("OUTCOME_UNKNOWN", "Only a proven unsubmitted reservation can be released; cancellation requests and timeouts do not release spend exposure.", "unknown");
    this.#snapshot.reservations = this.#snapshot.reservations.filter(item => item.jobId !== jobId);
  }
  reconcile(jobId: string, terminalStatus: "succeeded" | "failed" | "cancelled", actualAmount: number) {
    if (!["succeeded", "failed", "cancelled"].includes(terminalStatus) || !Number.isFinite(actualAmount) || actualAmount < 0) throw new CloudError("INVALID_ARGUMENT", "Settlement requires a confirmed terminal status and actual cost.");
    const index = this.#snapshot.reservations.findIndex(item => item.jobId === jobId);
    if (index < 0) throw new CloudError("IDEMPOTENCY_CONFLICT", "This job has no unsettled reservation; do not double-count its billing.");
    this.#snapshot.spent += actualAmount;
    this.#snapshot.reservations.splice(index, 1);
  }
}
