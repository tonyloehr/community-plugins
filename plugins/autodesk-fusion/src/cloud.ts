import {
  APS_ORIGIN, ApsTransport, CloudError, cloudCanonical, cloudHash, cloudId, cloudString,
  cloudTimestamp, isCloudObject, redactCloudData, type CloudTransportOptions,
} from "./cloud-http.js";

export { APS_ORIGIN, CloudError, CloudRateLimiter, cloudHash, cloudSourceHash, parseRetryAfter, redactCloudData, validateAutodeskOrigin } from "./cloud-http.js";
export interface CloudScope {
  tenantId: string;
  hubIds: string[];
  projects: { hubId: string; projectId: string }[];
  mfgModels?: { modelId: string; hubId: string; projectId: string; configurationId?: string | null }[];
  manage?: { tenant: string; workspaceIds: number[] };
}
export interface CloudPageOptions { pageNumber?: number; pageSize?: number }
export interface CloudPage {
  data: unknown[];
  scope: { tenantId: string; hubId?: string; projectId?: string };
  pagination: { pageNumber: number; pageSize: number; nextPageNumber: number | null; complete: boolean };
}
export interface MfgContext {
  modelId: string;
  timestamp: string;
  composition: "AS_SAVED";
  configurationId?: string | null;
}
export interface MfgQueryResult {
  scope: CloudScope["mfgModels"] extends (infer T)[] | undefined ? T & { tenantId: string } : never;
  context: MfgContext;
  documentId: string;
  documentHash: string;
  data: unknown;
  errors: { code: string; path: (string | number)[] }[];
  partial: boolean;
  complete: boolean;
  cursor: string | null;
  snapshotHash: string;
}
export interface MfgPropertyRule {
  propertyDefinitionId: string;
  type: "string" | "number" | "boolean";
  allowNull: boolean;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  unit?: string;
  owner: "product";
}
export interface MfgPropertyObservation {
  tenantId: string;
  modelId: string;
  componentId: string;
  propertyDefinitionId: string;
  timestamp: string;
  value: string | number | boolean | null;
  snapshotHash: string;
  definitionHash?: string;
}
export interface MfgPropertyDraft {
  status: "draft";
  context: MfgContext;
  componentId: string;
  propertyDefinitionId: string;
  before: string | number | boolean | null;
  after: string | number | boolean | null;
  observationHash: string;
  ruleHash: string;
  documentHash: string;
  draftHash: string;
  requiresApproval: true;
  atomicConcurrency: false;
}
export interface ApsClientOptions extends Omit<CloudTransportOptions, "tenantId" | "manageTenant"> {
  scope: CloudScope;
  propertyRules?: MfgPropertyRule[];
  /** Enterprise adapter must supply a qualified, reviewed read projection for its custom property schema. */
  observeProperty?: (context: MfgContext, propertyDefinitionId: string) => Promise<MfgPropertyObservation>;
}

// Fixed documents, with user data passed exclusively as variables. Source: Autodesk v3 samples
// https://github.com/autodesk-platform-services/aps-mfgdm-samples/tree/6e1e6bd0aa9d024c72a68a145da0006306a24a50
// AS_SAVED semantics: https://aps.autodesk.com/blog/manufacturing-data-model-api-v3
const mfgDocuments = {
  propertySchema: `query CodexPropertySchema {
    componentType: __type(name: "Component") { fields { name args { name } } }
    setInput: __type(name: "SetPropertiesInput") { inputFields { name type { name ofType { name ofType { name ofType { name } } } } } }
  }`,
  propertyInputSchema: `query CodexPropertyInputSchema($typeName: String!) {
    __type(name: $typeName) { inputFields { name } }
  }`,
  currentProperty: `query CodexCurrentProperty($modelId: ID!, $cursor: String) {
    model(modelId: $modelId, composition: AS_SAVED) {
      id timestamp component {
        id customProperties(pagination: {cursor: $cursor}) {
          results { value definition { id isReadOnly isArchived specification propertyBehavior units { name } } }
          pagination { cursor }
        }
      }
    }
  }`,
  model: `query CodexInspectModel($modelId: ID!, $time: DateTime!, $cursor: String) {
    model(modelId: $modelId, time: $time, composition: AS_SAVED) {
      id timestamp name { value displayValue }
      component { id partNumber { value displayValue } description { value displayValue } }
      assemblyRelations(pagination: {cursor: $cursor}) {
        results { fromModel { id } toModel { id timestamp name { value displayValue } version { timestamp } } }
        pagination { cursor }
      }
    }
  }`,
  history: `query CodexInspectHistory($modelId: ID!, $time: DateTime!) {
    model(modelId: $modelId, time: $time, composition: AS_SAVED) {
      id timestamp history { results { timeStamp description } }
    }
  }`,
  physicalProperties: `query CodexInspectPhysicalProperties($modelId: ID!, $time: DateTime!) {
    model(modelId: $modelId, time: $time, composition: AS_SAVED) {
      id timestamp physicalProperties {
        status
        area { value displayValue definition { units { name } } }
        volume { value displayValue definition { units { name } } }
        mass { value displayValue definition { units { name } } }
        density { value displayValue definition { units { name } } }
      }
    }
  }`,
  setProperty: `mutation CodexSetProperty($propertyId: ID!, $componentId: ID!, $propertyValue: PropertyValue!) {
    setProperties(input: { targetId: $componentId, propertyInputs: [{ propertyDefinitionId: $propertyId, value: $propertyValue }] }) {
      properties { value }
    }
  }`,
  clearProperty: `mutation CodexClearProperty($propertyId: ID!, $componentId: ID!) {
    setProperties(input: { targetId: $componentId, propertyInputs: [{ propertyDefinitionId: $propertyId, shouldClear: true }] }) {
      properties { value }
    }
  }`,
} as const;
export const MFG_QUERY_DOCUMENTS = Object.freeze(Object.fromEntries(Object.entries(mfgDocuments).map(([id, document]) => [id, Object.freeze({ id, document, hash: cloudHash(document), kind: id === "setProperty" || id === "clearProperty" ? "mutation" : "query", endpoint: `${APS_ORIGIN}/mfg/v3/graphql/public` })])));

function pageValues(options: CloudPageOptions = {}) {
  const pageNumber = options.pageNumber ?? 0, pageSize = options.pageSize ?? 100;
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 0 || pageNumber > 1_000_000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new CloudError("INVALID_ARGUMENT", "Pagination requires pageNumber 0–1000000 and pageSize 1–200.");
  return { pageNumber, pageSize };
}
function withPage(path: string, page: ReturnType<typeof pageValues>) {
  return `${path}?${new URLSearchParams({ "page[number]": String(page.pageNumber), "page[limit]": String(page.pageSize) })}`;
}
function gqlErrors(value: unknown): { code: string; path: (string | number)[] }[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map(error => {
    const item = isCloudObject(error) ? error : {};
    const code = isCloudObject(item.extensions) && typeof item.extensions.code === "string" && /^[A-Z_]{1,64}$/.test(item.extensions.code) ? item.extensions.code : "GRAPHQL_ERROR";
    const path = Array.isArray(item.path) ? item.path.filter(part => typeof part === "string" && /^[A-Za-z_][A-Za-z_0-9]{0,63}$/.test(part) || typeof part === "number" && Number.isSafeInteger(part) && part >= 0).slice(0, 20) as (string | number)[] : [];
    return { code, path };
  });
}
function valueForRule(value: unknown, rule: MfgPropertyRule) {
  if (value === null) { if (!rule.allowNull) throw new CloudError("INVALID_ARGUMENT", "This property does not allow clearing its value."); return; }
  if (typeof value !== rule.type || typeof value === "number" && (!Number.isFinite(value) || value < (rule.minimum ?? -Number.MAX_VALUE) || value > (rule.maximum ?? Number.MAX_VALUE)) || typeof value === "string" && value.length > (rule.maxLength ?? 4096)) throw new CloudError("INVALID_ARGUMENT", "Property value does not satisfy its reviewed schema.");
}
export function validateCloudScope(scope: CloudScope): CloudScope {
  if (!isCloudObject(scope)) throw new CloudError("INVALID_ARGUMENT", "An explicit cloud scope is required.");
  cloudString(scope.tenantId, "Tenant context", 256);
  if (!Array.isArray(scope.hubIds) || !Array.isArray(scope.projects) || scope.hubIds.length > 1000 || scope.projects.length > 5000) throw new CloudError("INVALID_ARGUMENT", "Hub and project scope must be explicit and bounded.");
  scope.hubIds.forEach(cloudId);
  const keys = new Set<string>();
  for (const project of scope.projects) {
    cloudId(project.hubId); cloudId(project.projectId);
    if (!scope.hubIds.includes(project.hubId) || keys.has(project.projectId)) throw new CloudError("INVALID_ARGUMENT", "Project-to-hub bindings must be unique and belong to the configured scope.");
    keys.add(project.projectId);
  }
  if (scope.mfgModels !== undefined && (!Array.isArray(scope.mfgModels) || scope.mfgModels.length > 10_000)) throw new CloudError("INVALID_ARGUMENT", "MFG model bindings must be bounded.");
  const models = new Set<string>();
  for (const model of scope.mfgModels ?? []) {
    cloudId(model.modelId);
    if (!scope.projects.some(project => project.projectId === model.projectId && project.hubId === model.hubId) || models.has(model.modelId)) throw new CloudError("INVALID_ARGUMENT", "Model-to-project bindings must be unique and scoped.");
    models.add(model.modelId);
    if (model.configurationId !== undefined && model.configurationId !== null) cloudString(model.configurationId, "Configuration ID");
  }
  if (scope.manage && (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(scope.manage.tenant) || !Array.isArray(scope.manage.workspaceIds) || scope.manage.workspaceIds.length > 1000 || scope.manage.workspaceIds.some(id => !Number.isSafeInteger(id) || id < 1))) throw new CloudError("INVALID_ARGUMENT", "Fusion Manage requires an exact tenant and allowlisted workspace IDs.");
  return structuredClone(scope);
}

export class ApsClient {
  #scope: CloudScope;
  #transport: ApsTransport;
  #options: ApsClientOptions;
  #rules = new Map<string, MfgPropertyRule>();
  #mfgCursors = new Map<string, string>();
  #propertySchema?: { checkedAt: number; clearSupported: boolean };
  constructor(options: ApsClientOptions) {
    this.#scope = validateCloudScope(options.scope);
    this.#options = { ...options };
    this.#transport = new ApsTransport({ ...options, tenantId: this.#scope.tenantId, manageTenant: this.#scope.manage?.tenant });
    for (const rule of options.propertyRules ?? []) {
      cloudId(rule.propertyDefinitionId);
      if (rule.owner !== "product" || !["string", "number", "boolean"].includes(rule.type) || this.#rules.has(rule.propertyDefinitionId)) throw new CloudError("INVALID_ARGUMENT", "Custom property rules must have unique product-owned field identities.");
      this.#rules.set(rule.propertyDefinitionId, structuredClone(rule));
    }
  }
  get scope() { return structuredClone(this.#scope); }
  toJSON() { return { type: "direct_APS", scope: this.scope, nativeMcpCredentialsInherited: false }; }
  #hub(hubId: string) { cloudId(hubId); if (!this.#scope.hubIds.includes(hubId)) throw new CloudError("SCOPE_DENIED", "Hub is outside the configured scope."); }
  #project(projectId: string, hubId?: string) {
    cloudId(projectId);
    const project = this.#scope.projects.find(item => item.projectId === projectId && (hubId === undefined || hubId === item.hubId));
    if (!project) throw new CloudError("SCOPE_DENIED", "Project is outside the configured hub/project scope.");
    return project;
  }
  async #list(path: string, page: ReturnType<typeof pageValues>, scope: { hubId?: string; projectId?: string }, allowed?: (item: Record<string, unknown>) => boolean): Promise<CloudPage> {
    const { data } = await this.#transport.send({ path, method: "GET", scopes: ["data:read"], safeRead: true });
    if (!isCloudObject(data) || !Array.isArray(data.data)) throw new CloudError("INVALID_RESPONSE", "Autodesk returned an invalid collection envelope.");
    let nextPageNumber: number | null = null;
    const next = isCloudObject(data.links) ? data.links.next : undefined;
    if (next) {
      const href = typeof next === "string" ? next : isCloudObject(next) && typeof next.href === "string" ? next.href : "";
      let url: URL;
      try { url = new URL(href, APS_ORIGIN); } catch { throw new CloudError("INVALID_RESPONSE", "Provider pagination link is invalid."); }
      const expected = new URL(path, APS_ORIGIN);
      if (url.origin !== APS_ORIGIN || url.username || url.password || url.hash || url.pathname !== expected.pathname || [...url.searchParams.keys()].some(key => !["page[number]", "page[limit]"].includes(key)) || url.searchParams.getAll("page[number]").length !== 1) throw new CloudError("INVALID_RESPONSE", "Provider pagination attempted to leave the scoped collection.");
      const number = Number(url.searchParams.get("page[number]"));
      if (!Number.isSafeInteger(number) || number <= page.pageNumber || number > 1_000_000) throw new CloudError("INVALID_RESPONSE", "Provider pagination did not advance.");
      nextPageNumber = number;
    }
    const rows = data.data.filter(item => isCloudObject(item) && (!allowed || allowed(item)));
    if (rows.length > page.pageSize) throw new CloudError("RESPONSE_TOO_LARGE", "Provider ignored the requested collection limit; narrow the configured scope.");
    return { data: redactCloudData(rows) as unknown[], scope: { tenantId: this.#scope.tenantId, ...scope }, pagination: { ...page, nextPageNumber, complete: nextPageNumber === null } };
  }
  async listHubs(): Promise<CloudPage> {
    // Hubs do not advertise page[number]/page[limit]; filter locally against the fixed allowlist.
    return this.#list("/project/v1/hubs", { pageNumber: 0, pageSize: 1000 }, {}, item => typeof item.id === "string" && this.#scope.hubIds.includes(item.id));
  }
  async listProjects(hubId: string, options: CloudPageOptions = {}): Promise<CloudPage> {
    this.#hub(hubId);
    const page = pageValues(options);
    return this.#list(withPage(`/project/v1/hubs/${cloudId(hubId)}/projects`, page), page, { hubId }, item => typeof item.id === "string" && this.#scope.projects.some(project => project.hubId === hubId && project.projectId === item.id));
  }
  async listTopFolders(hubId: string, projectId: string): Promise<CloudPage> {
    this.#hub(hubId); this.#project(projectId, hubId);
    return this.#list(`/project/v1/hubs/${cloudId(hubId)}/projects/${cloudId(projectId)}/topFolders`, { pageNumber: 0, pageSize: 200 }, { hubId, projectId });
  }
  async listFolderContents(projectId: string, folderId: string, options: CloudPageOptions = {}): Promise<CloudPage> {
    const project = this.#project(projectId), page = pageValues(options);
    return this.#list(withPage(`/data/v1/projects/${cloudId(projectId)}/folders/${cloudId(folderId)}/contents`, page), page, project);
  }
  async getFolder(projectId: string, folderId: string) {
    return this.#getResource(projectId, "folders", folderId);
  }
  async getItem(projectId: string, itemId: string) { return this.#getResource(projectId, "items", itemId); }
  async getVersion(projectId: string, versionId: string) { return this.#getResource(projectId, "versions", versionId); }
  async #getResource(projectId: string, kind: "folders" | "items" | "versions", id: string) {
    const project = this.#project(projectId);
    const reply = await this.#transport.send({ path: `/data/v1/projects/${cloudId(projectId)}/${kind}/${cloudId(id)}`, method: "GET", scopes: ["data:read"], safeRead: true });
    if (!isCloudObject(reply.data) || !isCloudObject(reply.data.data) || reply.data.data.id !== id) throw new CloudError("INVALID_RESPONSE", "Autodesk returned a resource with an unexpected identity.");
    return { data: redactCloudData(reply.data.data), scope: { tenantId: this.#scope.tenantId, ...project }, etag: reply.etag ?? null, fingerprint: cloudHash(reply.data.data) };
  }
  async listItemVersions(projectId: string, itemId: string, options: CloudPageOptions = {}): Promise<CloudPage> {
    const project = this.#project(projectId), page = pageValues(options);
    return this.#list(withPage(`/data/v1/projects/${cloudId(projectId)}/items/${cloudId(itemId)}/versions`, page), page, project);
  }
  #model(context: MfgContext) {
    cloudId(context.modelId); cloudTimestamp(context.timestamp);
    if (context.composition !== "AS_SAVED") throw new CloudError("UNSUPPORTED_CAPABILITY", "This reviewed v3 adapter currently qualifies AS_SAVED composition only.");
    const model = this.#scope.mfgModels?.find(item => item.modelId === context.modelId);
    if (!model) throw new CloudError("SCOPE_DENIED", "Model has no approved tenant, hub and project binding.");
    if ((context.configurationId ?? null) !== (model.configurationId ?? null)) throw new CloudError("STALE_PLAN", "The requested configuration does not match this model's approved binding.");
    return { ...model, tenantId: this.#scope.tenantId };
  }
  async #mfg(documentId: keyof typeof mfgDocuments, variables: Record<string, unknown>, write = false) {
    if (write) {
      const token = await this.#transport.token(["data:write"]);
      if (token.grantType !== "authorization_code") throw new CloudError("SCOPE_DENIED", "MFGDM custom properties require a separate user-delegated APS grant.");
    }
    const result = await this.#transport.send({ path: "/mfg/v3/graphql/public", method: "POST", scopes: [write ? "data:write" : "data:read"], safeRead: !write, body: { query: mfgDocuments[documentId], variables } });
    if (!isCloudObject(result.data)) throw new CloudError(write ? "OUTCOME_UNKNOWN" : "INVALID_RESPONSE", "MFGDM returned an invalid GraphQL envelope.", write ? "unknown" : "none");
    const errors = gqlErrors(result.data.errors);
    if (!isCloudObject(result.data.data) && errors.length === 0) throw new CloudError(write ? "OUTCOME_UNKNOWN" : "INVALID_RESPONSE", "MFGDM returned no result data.", write ? "unknown" : "none");
    return { data: isCloudObject(result.data.data) ? result.data.data : null, errors, partial: errors.length > 0 };
  }
  async inspectMfgModel(context: MfgContext & { cursor?: string | null }): Promise<MfgQueryResult> {
    if (context.cursor !== undefined && context.cursor !== null) {
      cloudString(context.cursor, "MFG pagination cursor", 4096);
      if (this.#mfgCursors.get(context.cursor) !== this.#contextHash(context)) throw new CloudError("STALE_SNAPSHOT", "Pagination cursor is not bound to this model/time/composition/configuration snapshot. Restart inspection after reconnecting.");
    }
    return this.#inspectMfg("model", context, { modelId: context.modelId, time: context.timestamp, cursor: context.cursor ?? null });
  }
  #contextHash(context: MfgContext) { return cloudHash([context.modelId, context.timestamp, context.composition, context.configurationId ?? null]); }
  async inspectMfgHistory(context: MfgContext): Promise<MfgQueryResult> { return this.#inspectMfg("history", context, { modelId: context.modelId, time: context.timestamp }); }
  async inspectMfgPhysicalProperties(context: MfgContext): Promise<MfgQueryResult> { return this.#inspectMfg("physicalProperties", context, { modelId: context.modelId, time: context.timestamp }); }
  async #inspectMfg(documentId: "model" | "history" | "physicalProperties", context: MfgContext, variables: Record<string, unknown>): Promise<MfgQueryResult> {
    const scope = this.#model(context);
    const reply = await this.#mfg(documentId, variables);
    const model = reply.data?.model;
    if (model !== null && model !== undefined && (!isCloudObject(model) || model.id !== context.modelId)) throw new CloudError("INVALID_RESPONSE", "MFGDM returned the wrong model identity.");
    let cursor: string | null = null;
    const projected = isCloudObject(model) ? structuredClone(model) : null;
    if (projected && isCloudObject(projected.assemblyRelations)) {
      const relations = projected.assemblyRelations;
      const pagination = isCloudObject(relations.pagination) ? relations.pagination : {};
      if (pagination.cursor !== undefined && pagination.cursor !== null) { cloudString(pagination.cursor, "Provider cursor", 4096); cursor = pagination.cursor; }
      if (!Array.isArray(relations.results) || relations.results.length > 1000) throw new CloudError("RESPONSE_TOO_LARGE", "MFGDM assembly page exceeds the reviewed result limit.");
      relations.results = relations.results.map(relation => {
        if (!isCloudObject(relation)) return { outsideScope: true };
        const result = structuredClone(relation);
        for (const side of ["fromModel", "toModel"]) {
          const child = result[side];
          if (isCloudObject(child) && !this.#scope.mfgModels?.some(binding => binding.modelId === child.id)) result[side] = { outsideScope: true };
        }
        return result;
      });
    }
    const resultContext = { modelId: context.modelId, timestamp: context.timestamp, composition: context.composition, configurationId: context.configurationId ?? null };
    const data = redactCloudData(projected);
    if (cursor) {
      if (this.#mfgCursors.size >= 1000) this.#mfgCursors.delete(this.#mfgCursors.keys().next().value!);
      this.#mfgCursors.set(cursor, this.#contextHash(context));
    }
    return { scope, context: resultContext, documentId, documentHash: cloudHash(mfgDocuments[documentId]), data, errors: reply.errors, partial: reply.partial, complete: documentId === "model" && projected !== null && isCloudObject(projected.assemblyRelations) && cursor === null && !reply.partial, cursor, snapshotHash: cloudHash({ context: resultContext, data }) };
  }
  async prepareMfgPropertyChange(context: MfgContext, propertyDefinitionId: string, after: string | number | boolean | null): Promise<MfgPropertyDraft> {
    this.#model(context);
    const rule = this.#rules.get(propertyDefinitionId);
    if (!rule) throw new CloudError("SCOPE_DENIED", "No reviewed property schema is configured for this field. Part numbers and release fields are not generic properties.");
    valueForRule(after, rule);
    const before = await this.#observe(context, propertyDefinitionId);
    const document = after === null ? mfgDocuments.clearProperty : mfgDocuments.setProperty;
    if (after === null && !this.#options.observeProperty && !(await this.#qualifyPropertySchema()).clearSupported) throw new CloudError("UNQUALIFIED_SCHEMA", "The deployed schema does not expose the reviewed shouldClear property operation.");
    const fields = { status: "draft" as const, context: structuredClone(context), componentId: before.componentId, propertyDefinitionId, before: before.value, after, observationHash: before.snapshotHash, ruleHash: cloudHash(rule), documentHash: cloudHash(document), requiresApproval: true as const, atomicConcurrency: false as const };
    return { ...fields, draftHash: cloudHash(fields) };
  }
  async #observe(context: MfgContext, propertyDefinitionId: string) {
    const observation = this.#options.observeProperty ? await this.#options.observeProperty(structuredClone(context), propertyDefinitionId) : await this.#observeBuiltIn(context, propertyDefinitionId);
    if (!observation || observation.tenantId !== this.#scope.tenantId || observation.modelId !== context.modelId || observation.propertyDefinitionId !== propertyDefinitionId || observation.timestamp !== context.timestamp || !/^[a-f0-9]{64}$/.test(observation.snapshotHash)) throw new CloudError("STALE_PLAN", "Property observation does not match its authorized model/time context.");
    cloudId(observation.componentId);
    const rule = this.#rules.get(propertyDefinitionId)!;
    valueForRule(observation.value, { ...rule, allowNull: true });
    return observation;
  }
  async observeMfgProperty(context: MfgContext, propertyDefinitionId: string): Promise<MfgPropertyObservation> {
    this.#model(context);
    if (!this.#rules.has(propertyDefinitionId)) throw new CloudError("SCOPE_DENIED", "Property has no reviewed field ownership/schema rule.");
    return this.#observe(context, propertyDefinitionId);
  }
  async #qualifyPropertySchema() {
    const now = (this.#options.now ?? Date.now)();
    if (this.#propertySchema && now - this.#propertySchema.checkedAt < 300_000) return this.#propertySchema;
    // Public primary v2 customProperties example plus v3 migration semantics are checked against
    // the authenticated deployed v3 schema. Introspection never accepts a model-authored document.
    // https://github.com/autodesk-platform-services/aps-mfgdatamodel-demo/blob/90e7af94334c8ccfa3dd221f5c9ad5f4c25606f6/services/forge/fusiondata.js
    const reply = await this.#mfg("propertySchema", {});
    const fields = reply.data && isCloudObject(reply.data.componentType) ? reply.data.componentType.fields : null;
    const custom = Array.isArray(fields) ? fields.find(field => isCloudObject(field) && field.name === "customProperties") : null;
    if (reply.partial || !isCloudObject(custom) || !Array.isArray(custom.args) || !custom.args.some(arg => isCloudObject(arg) && arg.name === "pagination")) throw new CloudError("UNQUALIFIED_SCHEMA", "The deployed v3 schema does not qualify the reviewed Component.customProperties pagination projection. Configure a reviewed enterprise observer or qualify this schema before mutation.");
    let clearSupported = false;
    const inputs = reply.data && isCloudObject(reply.data.setInput) ? reply.data.setInput.inputFields : null;
    const propertyInputs = Array.isArray(inputs) ? inputs.find(field => isCloudObject(field) && field.name === "propertyInputs") : null;
    if (isCloudObject(propertyInputs) && isCloudObject(propertyInputs.type)) {
      let type = propertyInputs.type;
      for (let i = 0; i < 3 && !type.name && isCloudObject(type.ofType); i++) type = type.ofType;
      if (typeof type.name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(type.name)) {
        const inputReply = await this.#mfg("propertyInputSchema", { typeName: type.name });
        const inputFields = inputReply.data && isCloudObject(inputReply.data.__type) ? inputReply.data.__type.inputFields : null;
        clearSupported = !inputReply.partial && Array.isArray(inputFields) && inputFields.some(field => isCloudObject(field) && field.name === "shouldClear");
      }
    }
    this.#propertySchema = { checkedAt: now, clearSupported };
    return this.#propertySchema;
  }
  async #observeBuiltIn(context: MfgContext, propertyDefinitionId: string): Promise<MfgPropertyObservation> {
    await this.#qualifyPropertySchema();
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < 20; page++) {
      // Deliberately current, not time:$historicalSnapshot. Historical reads do not establish CAS.
      const reply = await this.#mfg("currentProperty", { modelId: context.modelId, cursor });
      if (reply.partial || !reply.data || !isCloudObject(reply.data.model)) throw new CloudError("UNQUALIFIED_SCHEMA", "Current custom-property observation was incomplete; no mutation is allowed.");
      const model = reply.data.model;
      if (model.id !== context.modelId || model.timestamp !== context.timestamp || !isCloudObject(model.component) || typeof model.component.id !== "string") throw new CloudError("STALE_PLAN", "The selected model/time is no longer the current writable component state.");
      const properties = model.component.customProperties;
      if (!isCloudObject(properties) || !Array.isArray(properties.results) || properties.results.length > 1000) throw new CloudError("UNQUALIFIED_SCHEMA", "Current custom-property projection did not match its reviewed schema.");
      const matches = properties.results.filter(property => isCloudObject(property) && isCloudObject(property.definition) && property.definition.id === propertyDefinitionId);
      if (matches.length > 1) throw new CloudError("UNQUALIFIED_SCHEMA", "Property definition did not resolve to a unique current value.");
      if (matches.length === 1) {
        const property = matches[0] as Record<string, unknown>, definition = property.definition as Record<string, unknown>;
        if (definition.isReadOnly !== false || definition.isArchived !== false || !["STANDARD", "TIMELESS"].includes(String(definition.propertyBehavior))) throw new CloudError("SCOPE_DENIED", "The field is read-only, archived or has unqualified temporal behavior.");
        const rule = this.#rules.get(propertyDefinitionId)!;
        if (rule.type === "string" && definition.specification !== "STRING" || rule.type === "boolean" && definition.specification !== "BOOLEAN") throw new CloudError("UNQUALIFIED_SCHEMA", "The current property definition disagrees with the reviewed scalar type.");
        const unit = isCloudObject(definition.units) ? definition.units.name : null;
        if ((rule.unit ?? null) !== (unit ?? null)) throw new CloudError("UNQUALIFIED_SCHEMA", "The current property units disagree with the reviewed field rule.");
        valueForRule(property.value, { ...rule, allowNull: true });
        const fields = { tenantId: this.#scope.tenantId, modelId: context.modelId, componentId: model.component.id, propertyDefinitionId, timestamp: model.timestamp as string, value: property.value as string | number | boolean | null, definitionHash: cloudHash(definition) };
        return { ...fields, snapshotHash: cloudHash(fields) };
      }
      const pagination = isCloudObject(properties.pagination) ? properties.pagination : {};
      if (pagination.cursor === undefined || pagination.cursor === null) throw new CloudError("UNQUALIFIED_SCHEMA", "No current value exists for the approved custom property; absence is not silently interpreted as null.");
      cloudString(pagination.cursor, "Property pagination cursor", 4096);
      if (seen.has(pagination.cursor)) throw new CloudError("INVALID_RESPONSE", "Property pagination did not advance.");
      cursor = pagination.cursor; seen.add(cursor);
    }
    throw new CloudError("RESPONSE_TOO_LARGE", "Custom-property lookup exceeded the bounded page count.");
  }
  async executeMfgPropertyChange(draft: MfgPropertyDraft, authority: {
    /** This is a trusted host-policy callback, not a model-provided approval boolean. */
    authorize: (draftHash: string, effect: "shared_business_change") => Promise<void>;
    requireAtomicConcurrency: boolean;
  }) {
    const { draftHash, ...fields } = draft;
    const documentId = draft.after === null ? "clearProperty" : "setProperty";
    if (cloudHash(fields) !== draftHash || draft.documentHash !== cloudHash(mfgDocuments[documentId])) throw new CloudError("STALE_PLAN", "The reviewed property draft or handler changed.");
    this.#model(draft.context);
    const rule = this.#rules.get(draft.propertyDefinitionId);
    if (!rule || cloudHash(rule) !== draft.ruleHash) throw new CloudError("STALE_PLAN", "The property ownership/schema rule changed.");
    if (authority.requireAtomicConcurrency) throw new CloudError("UNSUPPORTED_CAPABILITY", "The reviewed setProperties mutation has no qualified atomic compare-and-set; this workflow requires a stronger provider guarantee.");
    valueForRule(draft.after, rule);
    await authority.authorize(draftHash, "shared_business_change");
    const observed = await this.#observe(draft.context, draft.propertyDefinitionId);
    if (observed.snapshotHash !== draft.observationHash || observed.componentId !== draft.componentId || cloudCanonical(observed.value) !== cloudCanonical(draft.before)) throw new CloudError("STALE_PLAN", "The property changed after review.");
    const result = await this.#mfg(documentId, { propertyId: draft.propertyDefinitionId, componentId: draft.componentId, ...(draft.after === null ? {} : { propertyValue: draft.after }) }, true);
    let verified = false;
    if (!result.partial) {
      try { const after = await this.#observe(draft.context, draft.propertyDefinitionId); verified = after.componentId === draft.componentId && cloudCanonical(after.value) === cloudCanonical(draft.after); }
      catch { /* A write can advance the current model timestamp; retain uncertainty without resubmitting. */ }
    }
    return { status: result.partial ? "partial_failure" : verified ? "verified" : "submitted", data: redactCloudData(result.data), errors: result.errors, outcome: result.partial ? "partial" : verified ? "verified" : "unverified", warnings: ["Provider atomic concurrency is not established; this operation used a just-before-submit current-state recheck.", ...(!verified ? ["Post-write state is not yet confirmed; reconcile current data before another write."] : [])], draftHash };
  }
  #manage(workspaceId?: number) {
    const manage = this.#scope.manage;
    if (!manage) throw new CloudError("SCOPE_DENIED", "No Fusion Manage tenant is configured.");
    if (workspaceId !== undefined && (!Number.isSafeInteger(workspaceId) || !manage.workspaceIds.includes(workspaceId))) throw new CloudError("SCOPE_DENIED", "Fusion Manage workspace is outside the configured scope.");
    return manage;
  }
  async #manageRead(path: string, workspaceId?: number) {
    const manage = this.#manage(workspaceId);
    const grant = await this.#transport.token(["data:read"]);
    if (grant.grantType !== "authorization_code") throw new CloudError("SCOPE_DENIED", "Fusion Manage requires its own qualified user-delegated APS authorization.");
    const reply = await this.#transport.send({ origin: `https://${manage.tenant}.autodeskplm360.net`, path: `/api/v3${path}`, method: "GET", scopes: ["data:read"], safeRead: true, headers: { "x-tenant": manage.tenant } });
    return { data: redactCloudData(reply.data), fingerprint: cloudHash(reply.data), etag: reply.etag ?? null, scope: { tenantId: this.#scope.tenantId, manageTenant: manage.tenant, workspaceId: workspaceId ?? null } };
  }
  async getManageWorkspace(workspaceId: number) { return this.#manageRead(`/workspaces/${workspaceId}`, workspaceId); }
  async getManageFields(workspaceId: number) { return this.#manageRead(`/workspaces/${workspaceId}/fields`, workspaceId); }
  async getManageItem(workspaceId: number, itemId: number) {
    if (!Number.isSafeInteger(itemId) || itemId < 1) throw new CloudError("INVALID_ARGUMENT", "Fusion Manage item ID must be a positive integer.");
    return this.#manageRead(`/workspaces/${workspaceId}/items/${itemId}`, workspaceId);
  }
  async prepareManageItemDraft(workspaceId: number, itemId: number, schema: ManageDraftSchema, changes: ManageDraftField[]) {
    this.#manage(workspaceId);
    if (schema.workspaceId !== workspaceId || schema.tenant !== this.#scope.manage!.tenant || !/^[a-f0-9]{64}$/.test(schema.schemaFingerprint)) throw new CloudError("UNQUALIFIED_SCHEMA", "The reviewed workspace schema does not match this tenant/workspace.");
    if (!Array.isArray(changes) || changes.length < 1 || changes.length > 100) throw new CloudError("INVALID_ARGUMENT", "The draft requires 1–100 field changes.");
    const currentSchema = await this.getManageFields(workspaceId);
    if (currentSchema.fingerprint !== schema.schemaFingerprint) throw new CloudError("STALE_PLAN", "Fusion Manage workspace schema changed after qualification.");
    const currentItem = await this.getManageItem(workspaceId, itemId);
    const seen = new Set<string>();
    for (const change of changes) {
      cloudString(change.fieldId, "Manage field ID", 256);
      const field = schema.fields.find(field => field.fieldId === change.fieldId);
      if (!field || !field.allowDraftUpdate || field.lifecycle || seen.has(change.fieldId)) throw new CloudError("SCOPE_DENIED", "Field is not authorized for draft synchronization or is a lifecycle/release field.");
      seen.add(change.fieldId);
      valueForRule(change.after, { propertyDefinitionId: field.fieldId, owner: "product", type: field.type, allowNull: field.allowNull, maxLength: field.maxLength, minimum: field.minimum, maximum: field.maximum });
    }
    const draft = { status: "draft_outbox", tenantId: this.#scope.tenantId, manageTenant: schema.tenant, workspaceId, itemId, schemaFingerprint: schema.schemaFingerprint, expectedItemFingerprint: currentItem.fingerprint, expectedEtag: currentItem.etag, changes: structuredClone(changes), sourceItem: currentItem.data, requiresApproval: true, releaseApproved: false, publicationSupported: false, blocker: "Publication requires a separately qualified tenant-specific field mapping, current-state recheck and trusted destination authorization." };
    return { ...draft, draftHash: cloudHash(draft) };
  }
}

export interface ManageDraftSchema {
  tenant: string;
  workspaceId: number;
  schemaFingerprint: string;
  fields: { fieldId: string; type: "string" | "number" | "boolean"; allowNull: boolean; allowDraftUpdate: boolean; lifecycle: boolean; minimum?: number; maximum?: number; maxLength?: number }[];
}
export interface ManageDraftField { fieldId: string; after: string | number | boolean | null; sourceRef: string }
