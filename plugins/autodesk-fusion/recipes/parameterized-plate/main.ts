// Reference only: keep inactive until qualified against the target service declarations and a live canary.
// Current service import: https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/TypeScriptSpecific_UM.htm
// The older pinned APS sample uses @adsk/fas; those module names are not assumed interchangeable.
import { adsk } from "@adsk/fusion/automation";

interface FrozenSource {
  hubId: string;
  projectId: string;
  itemId: string;
  versionId: string;
  configurationId: null;
  resourceHash: string;
}
interface ReviewBindings {
  tenantId: string;
  qualificationRef: string;
  typeDefinitionsSha256: string;
  source: FrozenSource;
  destination: { alias: string; hubId: string; projectId: string; folderId: string };
  templateKind: "unconfigured_single_body_plate";
}

// An administrator replaces this literal only after reviewing the template, service API and destination.
// Its resulting source bytes/hash are installed as one reviewed recipe. Tool arguments cannot enable it.
const REVIEW_BINDINGS: ReviewBindings | null = null;

const PARAMETER_RULES = [
  { input: "width_mm", parameter: "Width", minimum: 20, maximum: 200 },
  { input: "height_mm", parameter: "Height", minimum: 20, maximum: 200 },
  { input: "thickness_mm", parameter: "Thickness", minimum: 2, maximum: 20 },
  { input: "hole_diameter_mm", parameter: "HoleDiameter", minimum: 2, maximum: 20 }
] as const;

class RecipeFailure extends Error {
  constructor(readonly code: string) { super(code); }
}
function fail(code: string): never { throw new RecipeFailure(code); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).length === allowed.length && Object.keys(value).every(key => allowed.includes(key));
}
function text(value: unknown, maximum = 2048): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}
function sameSource(source: unknown, expected: FrozenSource): source is FrozenSource {
  return keys(source, ["hubId", "projectId", "itemId", "versionId", "configurationId", "resourceHash"]) &&
    source.hubId === expected.hubId && source.projectId === expected.projectId &&
    source.itemId === expected.itemId && source.versionId === expected.versionId &&
    source.configurationId === null && source.resourceHash === expected.resourceHash;
}
function parameters(bindings: ReviewBindings) {
  // These service parameter/result channels are demonstrated by the pinned APS sample.
  // Activation also requires verifying them in the selected @adsk/fusion/automation declarations/runtime.
  if (typeof adsk.parameters !== "string" || adsk.parameters.length > 65536) fail("SERVICE_PARAMETER_CONTRACT_UNAVAILABLE");
  let request: unknown;
  try { request = JSON.parse(adsk.parameters); } catch { fail("INVALID_TASK_PARAMETERS"); }
  if (!keys(request, ["schemaVersion", "requestId", "inputs", "sources", "destination", "variantCount", "limits"]) ||
      request.schemaVersion !== 1 || typeof request.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(request.requestId) ||
      request.variantCount !== 1 || !Array.isArray(request.sources) || request.sources.length !== 1 ||
      !sameSource(request.sources[0], bindings.source)) fail("UNREVIEWED_SOURCE_OR_REQUEST");
  if (!keys(request.destination, ["alias", "kind", "hubId", "projectId"]) ||
      request.destination.kind !== "fusion_project" || request.destination.alias !== bindings.destination.alias ||
      request.destination.hubId !== bindings.destination.hubId || request.destination.projectId !== bindings.destination.projectId ||
      bindings.source.hubId !== bindings.destination.hubId) fail("UNREVIEWED_DESTINATION");
  if (!keys(request.limits, ["maxVariants", "maxInputBytes", "maxOutputBytes", "maxProcessingSeconds", "maxAttempts", "minimumDelegatedTokenLifetimeMs"]) ||
      request.limits.maxVariants !== 1 || request.limits.maxAttempts !== 1 ||
      typeof request.limits.maxProcessingSeconds !== "number" || request.limits.maxProcessingSeconds < 180 ||
      request.limits.maxProcessingSeconds > 600) fail("UNREVIEWED_LIMITS");
  if (!keys(request.inputs, PARAMETER_RULES.map(rule => rule.input))) fail("INVALID_PARAMETER_INPUTS");
  const inputs: Record<string, number> = {};
  for (const rule of PARAMETER_RULES) {
    const value = request.inputs[rule.input];
    if (typeof value !== "number" || !Number.isFinite(value) || value < rule.minimum || value > rule.maximum) fail("PARAMETER_OUT_OF_RANGE");
    inputs[rule.input] = value;
  }
  if (inputs.hole_diameter_mm >= Math.min(inputs.width_mm, inputs.height_mm) - 4 ||
      inputs.thickness_mm > Math.min(inputs.width_mm, inputs.height_mm) / 2) fail("INVALID_PLATE_PROPORTIONS");
  return { requestId: request.requestId, inputs, maximumWaitMs: Math.min(120000, request.limits.maxProcessingSeconds * 1000 - 30000) };
}
function healthy(design: adsk.fusion.Design): void {
  if (design.timeline.count < 1 || design.timeline.count > 1000) fail("TEMPLATE_TIMELINE_LIMIT");
  for (let index = 0; index < design.timeline.count; index++) {
    const item = design.timeline.item(index);
    if (!item || item.healthState !== adsk.fusion.FeatureHealthStates.HealthyFeatureHealthState) fail("TEMPLATE_HEALTH_NOT_CONFIRMED");
  }
  if (design.rootComponent.occurrences.count !== 0 || design.rootComponent.bRepBodies.count !== 1) fail("TEMPLATE_STRUCTURE_CHANGED");
  const body = design.rootComponent.bRepBodies.item(0);
  if (!body || !body.isSolid || !Number.isFinite(body.volume) || body.volume <= 0) fail("INVALID_SOLID");
}
function configuredBindings(): ReviewBindings {
  const bindings = REVIEW_BINDINGS as ReviewBindings | null;
  if (!bindings || bindings.templateKind !== "unconfigured_single_body_plate" || !text(bindings.qualificationRef) ||
      !/^[a-f0-9]{64}$/.test(bindings.typeDefinitionsSha256) || !text(bindings.tenantId) ||
      !text(bindings.destination.folderId) || !text(bindings.source.versionId) ||
      !/\?version=[1-9][0-9]*$/.test(bindings.source.versionId) || bindings.source.configurationId !== null ||
      !/^[a-f0-9]{64}$/.test(bindings.source.resourceHash)) fail("REFERENCE_NOT_QUALIFIED");
  return bindings;
}

// The current documented service lifecycle calls exported run after module evaluation.
// Do not also invoke it at top level; that risks running twice on a qualified modern service.
export function run(_context: string): void {
  let document: adsk.core.Document | null = null;
  let saveAttempted = false;
  try {
    const bindings = configuredBindings();
    const request = parameters(bindings);
    const app = adsk.core.Application.get();
    if (!app) fail("FUSION_APPLICATION_UNAVAILABLE");
    const hub = app.data.dataHubs.itemById(bindings.source.hubId);
    if (!hub || hub.id !== bindings.source.hubId) fail("HUB_SCOPE_MISMATCH");
    app.data.activeHub = hub;
    // The full Data Management version URN, including ?version=N, is accepted by findFileById.
    const source = app.data.findFileById(bindings.source.versionId);
    if (!source || source.id !== bindings.source.itemId || source.versionId !== bindings.source.versionId ||
        source.parentProject.id !== bindings.source.projectId || !source.isComplete ||
        source.childReferences.count !== 0) fail("SOURCE_IDENTITY_OR_DEPENDENCIES_CHANGED");
    const folder = app.data.findFolderById(bindings.destination.folderId);
    if (!folder || folder.id !== bindings.destination.folderId || folder.parentProject.id !== bindings.destination.projectId) fail("DESTINATION_IDENTITY_CHANGED");
    document = app.documents.open(source, true);
    if (!document || document.dataFile.versionId !== bindings.source.versionId) fail("OPENED_VERSION_CHANGED");
    const product = document.products.itemByProductType("DesignProductType");
    if (!(product instanceof adsk.fusion.Design) || product.designType !== adsk.fusion.DesignTypes.ParametricDesignType) fail("UNSUPPORTED_TEMPLATE_DESIGN");
    const design = product;
    healthy(design);
    const changes: { parameter: adsk.fusion.UserParameter; expression: string; expectedValue: number; before: string; input: string }[] = [];
    // Resolve every required parameter and dimension before changing any of them.
    for (const rule of PARAMETER_RULES) {
      const parameter = design.userParameters.itemByName(rule.parameter);
      const expression = String(request.inputs[rule.input]) + " mm";
      if (!parameter || !design.unitsManager.isValidExpression(expression, parameter.unit)) fail("TEMPLATE_PARAMETER_MISMATCH");
      const expectedValue = design.unitsManager.evaluateExpression(expression, parameter.unit);
      if (!Number.isFinite(expectedValue) || expectedValue <= 0) fail("TEMPLATE_UNIT_MISMATCH");
      changes.push({ parameter, expression, expectedValue, before: parameter.expression, input: rule.input });
    }
    for (const change of changes) change.parameter.expression = change.expression;
    if (!design.computeAll()) fail("DESIGN_RECOMPUTE_FAILED");
    healthy(design); // computeAll alone does not establish that individual timeline features succeeded.
    for (const change of changes) {
      if (!Number.isFinite(change.parameter.value) || Math.abs(change.parameter.value - change.expectedValue) > 1e-8) fail("PARAMETER_READBACK_MISMATCH");
    }
    const name = "codex-plate-" + request.requestId;
    saveAttempted = true;
    if (!document.saveAs(name, folder, "Unreleased candidate; request " + request.requestId, "")) fail("SAVE_NOT_ACKNOWLEDGED");
    const deadline = Date.now() + request.maximumWaitMs;
    while (app.hasActiveJobs || !document.dataFile || document.dataFile.id === bindings.source.itemId || !document.dataFile.isComplete) {
      if (Date.now() >= deadline) fail("SAVE_COMPLETION_UNKNOWN");
      adsk.doEvents();
    }
    const saved = document.dataFile;
    if (!saved || !text(saved.versionId) || !/\?version=[1-9][0-9]*$/.test(saved.versionId) ||
        saved.versionId === bindings.source.versionId || saved.parentFolder.id !== bindings.destination.folderId ||
        saved.parentProject.id !== bindings.destination.projectId) fail("SAVED_IDENTITY_UNCONFIRMED");
    adsk.result = JSON.stringify({
      schemaVersion: 1,
      status: "candidate_saved_unverified",
      requestId: request.requestId,
      tenantId: bindings.tenantId,
      source: bindings.source,
      destination: bindings.destination,
      output: { itemId: saved.id, versionId: saved.versionId, name },
      parameters: changes.map(change => ({ input: change.input, before: change.before, after: change.parameter.expression, internalValue: change.parameter.value })),
      geometryValidationComplete: false,
      manufacturingReleaseApproved: false,
      downstreamIndexComplete: false
    });
  } catch (error) {
    const code = error instanceof RecipeFailure ? error.code : "FUSION_API_FAILURE";
    // Never copy provider error prose, TaskParameters, tokens, source contents or signed URLs into logs.
    adsk.result = JSON.stringify({ schemaVersion: 1, status: saveAttempted ? "outcome_unknown" : "failed_before_save", code });
    throw new Error(saveAttempted ? "CANDIDATE_SAVE_OUTCOME_UNKNOWN" : code);
  } finally {
    if (document) {
      try { document.close(false); } catch { /* Closing does not prove rollback or undo a completed save. */ }
    }
  }
}
