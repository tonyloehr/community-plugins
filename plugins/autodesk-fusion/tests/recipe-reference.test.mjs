import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { transform } from "esbuild";
import { validateAutomationRecipe, CloudError } from "../dist/index.mjs";

const recipeUrl = new URL("../recipes/parameterized-plate/", import.meta.url);
const source = await readFile(new URL("main.ts", recipeUrl), "utf8");
const template = JSON.parse(await readFile(new URL("manifest.template.json", recipeUrl), "utf8"));
const frozen = { hubId: "hub-a", projectId: "project-source", itemId: "urn:adsk.wipprod:dm.lineage:plate", versionId: "urn:adsk.wipprod:fs.file:vf.plate?version=2", configurationId: null, resourceHash: "a".repeat(64) };
const bindings = { tenantId: "tenant-fixture", qualificationRef: "synthetic-contract-only", typeDefinitionsSha256: "b".repeat(64), source: frozen, destination: { alias: "candidate-designs", hubId: "hub-a", projectId: "project-output", folderId: "urn:adsk.wipprod:fs.folder:co.candidates" }, templateKind: "unconfigured_single_body_plate" };
function request() {
  return { schemaVersion: 1, requestId: "f205d395-b0f2-4bc1-b8c3-1c47b62cbcb6", inputs: { width_mm: 60, height_mm: 40, thickness_mm: 5, hole_diameter_mm: 8 }, sources: [structuredClone(frozen)], destination: { alias: "candidate-designs", kind: "fusion_project", hubId: "hub-a", projectId: "project-output" }, variantCount: 1, limits: structuredClone(template.recipe.limits) };
}

// This is a documented-method protocol double, not Autodesk declarations or a geometry kernel.
async function harness(options = {}) {
  const events = { application: 0, open: 0, parameterWrites: 0, saves: [], close: [], pumps: 0 };
  const folder = { id: bindings.destination.folderId, parentProject: { id: bindings.destination.projectId } };
  const sourceFile = { id: frozen.itemId, versionId: frozen.versionId, parentProject: { id: frozen.projectId }, isComplete: true, childReferences: { count: 0 }, ...options.sourceFile };
  let current = sourceFile, active = false, clock = 0;
  class Design {
    constructor() {
      this.designType = 1;
      const names = ["Width", "Height", "Thickness", "HoleDiameter"];
      this.values = new Map(names.filter(name => name !== options.missingParameter).map(name => {
        let expression = "30 mm";
        return [name, { name, unit: options.badUnits ? "deg" : "mm", get expression() { return expression; }, set expression(value) { events.parameterWrites++; expression = value; }, get value() { return options.badReadback ? -1 : parseFloat(expression) / 10; } }];
      }));
      this.userParameters = { itemByName: name => this.values.get(name) ?? null };
      this.unitsManager = { isValidExpression: (_expression, unit) => unit === "mm", evaluateExpression: expression => parseFloat(expression) / 10 };
      this.timeline = { count: 4, item: () => ({ healthState: options.unhealthy ? 1 : 0 }) };
      this.rootComponent = { occurrences: { count: 0 }, bRepBodies: { count: 1, item: () => ({ isSolid: true, volume: 2 }) } };
    }
    computeAll() { return options.computeFails ? false : true; }
  }
  const design = new Design();
  const document = { get dataFile() { return current; }, products: { itemByProductType: type => { assert.equal(type, "DesignProductType"); return design; } }, saveAs(name, target, description, tag) {
    events.saves.push({ name, folderId: target.id, description, tag });
    if (options.saveThrows) throw new Error("PRIVATE_PROVIDER_DIAGNOSTIC");
    if (options.saveRejected) return false;
    active = true; return true;
  }, close(saveChanges) { events.close.push(saveChanges); } };
  const app = { data: { dataHubs: { itemById: id => id === frozen.hubId ? { id } : null }, activeHub: null, findFileById: id => { assert.equal(id, frozen.versionId, "The source is requested by exact version, not a mutable latest alias"); return sourceFile; }, findFolderById: id => { assert.equal(id, folder.id); return options.wrongFolder ? { ...folder, parentProject: { id: "other-project" } } : folder; } }, documents: { open: (file, visible) => { events.open++; assert.equal(file.versionId, frozen.versionId); assert.equal(visible, true); return document; } }, get hasActiveJobs() { return active; } };
  const adsk = { parameters: JSON.stringify(options.request ?? request()), result: undefined, core: { Application: { get: () => { events.application++; return app; } } }, fusion: { Design, DesignTypes: { ParametricDesignType: 1 }, FeatureHealthStates: { HealthyFeatureHealthState: 0 } }, log: () => assert.fail("Reference must not log task inputs or provider diagnostics"), doEvents: () => { events.pumps++; if (!options.neverCompletes) { active = false; current = { id: "urn:adsk.wipprod:dm.lineage:new-candidate", versionId: "urn:adsk.wipprod:fs.file:vf.new-candidate?version=1", parentFolder: folder, parentProject: folder.parentProject, isComplete: true, ...(options.savedFile ?? {}) }; } } };
  const qualifiedSource = options.disabled ? source : source.replace("const REVIEW_BINDINGS: ReviewBindings | null = null;", "const REVIEW_BINDINGS: ReviewBindings | null = " + JSON.stringify(bindings) + ";");
  const transpiled = await transform(qualifiedSource, { loader: "ts", format: "cjs", platform: "neutral", target: "es2022" });
  const module = { exports: {} };
  class TestClock extends Date { static now() { clock += 1000; return clock; } }
  const sandbox = { module, exports: module.exports, Date: TestClock, require: name => { assert.equal(name, "@adsk/fusion/automation"); return { adsk }; } };
  vm.runInNewContext(transpiled.code, sandbox, { filename: "synthetic-recipe-contract.cjs", timeout: 1000 });
  assert.equal(events.application, 0, "Module evaluation must not execute the exported run function twice");
  return { events, adsk, run: () => module.exports.run("{}"), result: () => JSON.parse(adsk.result) };
}

test("shipped reference has an exact source hash and cannot be treated as an active recipe", async () => {
  assert.equal(template.enabled, false);
  assert.equal(Array.isArray(template), false);
  assert.equal(createHash("sha256").update(source).digest("hex"), template.sourceSha256);
  assert.equal(template.activationRequirements.confirmedExportedRunLifecycle, false);
  assert.equal(template.activationRequirements.typeDefinitionsSha256, null);
  assert.equal(template.recipe.script.source, null);
  assert.throws(() => validateAutomationRecipe(template.recipe, { tenantId: "tenant-fixture", hubIds: ["hub-a"], projects: [{ hubId: "hub-a", projectId: "project-source" }, { hubId: "hub-a", projectId: "project-output" }] }), error => error instanceof CloudError);
  const h = await harness({ disabled: true });
  assert.throws(h.run, { message: "REFERENCE_NOT_QUALIFIED" });
  assert.equal(h.events.application, 0); assert.equal(h.events.open, 0); assert.equal(h.events.saves.length, 0);
});

test("synthetic recipe creates one distinct unverified candidate with exact source, folder and parameter readback", async () => {
  const h = await harness(); h.run();
  const result = h.result();
  assert.equal(h.events.application, 1); assert.equal(h.events.open, 1);
  assert.equal(h.events.parameterWrites, 4); assert.equal(h.events.saves.length, 1);
  assert.equal(h.events.saves[0].name, "codex-plate-" + request().requestId);
  assert.equal(h.events.saves[0].folderId, bindings.destination.folderId);
  assert.deepEqual(h.events.close, [false]);
  assert.equal(result.status, "candidate_saved_unverified");
  assert.equal(result.source.versionId, frozen.versionId);
  assert.notEqual(result.output.itemId, frozen.itemId);
  assert.equal(result.output.versionId, "urn:adsk.wipprod:fs.file:vf.new-candidate?version=1");
  assert.equal(result.parameters.find(row => row.input === "width_mm").internalValue, 6);
  assert.equal(result.geometryValidationComplete, false);
  assert.equal(result.manufacturingReleaseApproved, false);
  assert.equal(result.downstreamIndexComplete, false);
});

test("unreviewed source versions, scopes, configurations, variants and arbitrary parameter expressions fail before opening", async () => {
  const mutations = [
    r => { r.sources[0].versionId = "urn:adsk.wipprod:fs.file:vf.plate?version=3"; },
    r => { r.sources[0].resourceHash = "c".repeat(64); },
    r => { r.sources[0].configurationId = "another-configuration"; },
    r => { r.destination.projectId = "another-project"; },
    r => { r.variantCount = 2; },
    r => { r.inputs.width_mm = "60 mm + PRIVATE_CODE"; },
    r => { r.inputs.width_mm = 201; },
    r => { r.inputs.access_token = "PRIVATE_CREDENTIAL"; },
    r => { r.approved = true; },
    r => { r.limits.maxAttempts = 2; }
  ];
  for (const mutate of mutations) {
    const input = request(); mutate(input); const h = await harness({ request: input });
    assert.throws(h.run);
    assert.equal(h.events.open, 0); assert.equal(h.events.parameterWrites, 0); assert.equal(h.events.saves.length, 0);
    assert.equal(JSON.stringify(h.result()).includes("PRIVATE_"), false);
  }
});

test("source version mismatch, unresolved children and wrong folder identities prevent edits", async () => {
  for (const options of [{ sourceFile: { versionId: "urn:adsk.wipprod:fs.file:vf.plate?version=4" } }, { sourceFile: { childReferences: { count: 1 } } }, { sourceFile: { isComplete: false } }, { sourceFile: { parentProject: { id: "other-project" } } }, { wrongFolder: true }]) {
    const h = await harness(options); assert.throws(h.run);
    assert.equal(h.events.open, 0); assert.equal(h.events.parameterWrites, 0); assert.equal(h.events.saves.length, 0);
  }
});

test("all required user parameters and their units are resolved before any expression is changed", async () => {
  for (const options of [{ missingParameter: "HoleDiameter" }, { badUnits: true }]) {
    const h = await harness(options); assert.throws(h.run);
    assert.equal(h.events.open, 1); assert.equal(h.events.parameterWrites, 0); assert.equal(h.events.saves.length, 0);
    assert.deepEqual(h.events.close, [false]);
  }
});

test("feature warnings, recompute failure and incorrect parameter readback never reach save", async () => {
  for (const options of [{ unhealthy: true }, { computeFails: true }, { badReadback: true }]) {
    const h = await harness(options); assert.throws(h.run);
    assert.equal(h.events.saves.length, 0); assert.equal(h.result().status, "failed_before_save");
    assert.deepEqual(h.events.close, [false]);
  }
});

test("save rejection, timeout and inconsistent output version remain uncertain without re-saving or leaking errors", async () => {
  for (const options of [{ saveThrows: true }, { saveRejected: true }, { neverCompletes: true }, { savedFile: { versionId: "" } }, { savedFile: { parentFolder: { id: "other-folder" } } }]) {
    const h = await harness(options); assert.throws(h.run, { message: "CANDIDATE_SAVE_OUTCOME_UNKNOWN" });
    assert.equal(h.events.saves.length, 1);
    assert.equal(h.result().status, "outcome_unknown");
    assert.equal(JSON.stringify(h.result()).includes("PRIVATE_"), false);
    assert.ok(h.events.pumps <= 120);
  }
});
