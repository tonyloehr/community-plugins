import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createSandbox, DOCUMENT_ID, inspectDocument, parameter, readJson,
  runCli, sha256, snapshotTree, toolData, widthRequest,
} from "../support/packaged-client.mjs";

test("cold copied package negotiates MCP and completes one reviewed fixture edit across restart", { timeout: 90_000 }, async t => {
  const sandbox = createSandbox(t);
  for (const omitted of ["node_modules", "src", "tests"]) {
    assert.equal(existsSync(path.join(sandbox.pluginRoot, omitted)), false);
  }
  const packageBefore = snapshotTree(sandbox.pluginRoot);
  const client = await sandbox.start();
  assert.deepEqual(client.initialization.serverInfo, { name: "autodesk-fusion", version: readJson(path.join(sandbox.pluginRoot, "package.json")).version });
  const status = toolData(await client.callTool("fusion_connection_status"));
  assert.equal(status.mode, "fixture");
  assert.equal(status.live_fusion_verified, false);
  assert.equal(status.live_fusion_exercised, false);
  assert.equal(status.cloud_configured, false);
  assert.equal(status.desktop.data.provider, "synthetic_fixture");
  assert.equal(status.execution_contract_kind, "installed_code");

  const listed = await client.request("tools/list");
  const byName = new Map(listed.tools.map(tool => [tool.name, tool]));
  assert.equal(byName.size, listed.tools.length);
  for (const name of ["fusion_documents_list", "fusion_changes_prepare", "fusion_changes_execute", "fusion_handoff_prepare", "fusion_retention_inventory", "fusion_cloud_batch_prepare", "fusion_manage_item_draft_prepare", "fusion_manage_item_draft_inspect"]) {
    assert.ok(byName.has(name), `Missing packaged facade: ${name}`);
  }
  assert.equal(byName.has("fusion_native_invoke"), false);
  assert.equal(byName.has("fusion_native_tools_list"), false);
  assert.equal(byName.get("fusion_capabilities_list").inputSchema.required?.includes("include_schema") ?? false, false);
  const capabilities = toolData(await client.callTool("fusion_capabilities_list", { family: "parameters", include_schema: true }));
  assert.ok(capabilities.operations.find(operation => operation.id === "parameters.set")?.input_schema);
  const documents = toolData(await client.callTool("fusion_documents_list"));
  assert.deepEqual(documents.data.documents.map(document => document.document_id), [DOCUMENT_ID]);
  const before = await inspectDocument(client);
  assert.equal(parameter(before, "width").expression, "40 mm");
  const plan = toolData(await client.callTool("fusion_changes_prepare", widthRequest(before.state)));
  assert.equal(plan.status, "prepared");
  assert.equal(plan.policy_decision.authorized, true);
  assert.deepEqual(plan.summary.requested.changes, plan.operation.args.changes, "Public selection arrays must survive result serialization");
  assert.equal((await inspectDocument(client)).state, before.state, "Preparing a plan must not edit the fixture");
  const execute = { plan_id: plan.id, plan_hash: plan.hash, idempotency_key: "marketplace-fixture-edit-once" };
  const done = toolData(await client.callTool("fusion_changes_execute", execute));
  assert.equal(done.status, "succeeded");
  const after = await inspectDocument(client);
  assert.equal(parameter(after, "width").expression, "5 cm");
  assert.equal(parameter(after, "width").value_mm, 50);
  for (const name of ["height", "thickness"]) assert.deepEqual(parameter(after, name), parameter(before, name));
  const measured = toolData(await client.callTool("fusion_geometry_measure", { document_id: DOCUMENT_ID, args: { kind: "physical", entity_ids: ["fixture:body:bracket"] } }));
  assert.equal(measured.data.volume.value, 5_000);
  assert.equal(measured.data.volume.unit, "mm^3");
  assert.equal(measured.data.analytic_fixture, true);
  assert.equal(measured.data.live_fusion_verified, false);

  const persistedBeforeReplay = snapshotTree(sandbox.stateRoot);
  assert.deepEqual(toolData(await client.callTool("fusion_changes_execute", execute)), done);
  assert.deepEqual(snapshotTree(sandbox.stateRoot), persistedBeforeReplay, "An idempotent lookup must not dispatch or rewrite evidence");
  assert.deepEqual(await client.close(), { code: 0, signal: null });
  const reopened = await sandbox.start();
  assert.equal((await inspectDocument(reopened)).state, after.state);
  assert.deepEqual(toolData(await reopened.callTool("fusion_changes_execute", execute)), done);
  assert.deepEqual(snapshotTree(sandbox.stateRoot), persistedBeforeReplay, "Restart must retain the same no-replay result");
  assert.deepEqual(snapshotTree(sandbox.pluginRoot), packageBefore, "A copied install must not modify its own distribution");
});

test("copied artifact workflow binds actual synthetic bytes and never grants engineering approval", { timeout: 90_000 }, async t => {
  const sandbox = createSandbox(t);
  const client = await sandbox.start();
  const source = await inspectDocument(client);
  const plan = toolData(await client.callTool("fusion_artifact_prepare", {
    operation: "exports.generate", document_id: DOCUMENT_ID, expected_state: source.state,
    args: { format: "step", output: { root: "artifacts", filename: "synthetic-protocol.step" } },
  }));
  assert.equal(existsSync(sandbox.artifactRoot), false, "Preparation must not create output bytes");
  const done = toolData(await client.callTool("fusion_artifact_generate", { plan_id: plan.id, plan_hash: plan.hash, idempotency_key: "marketplace-artifact-once" }));
  assert.equal(done.status, "succeeded");
  const receipt = toolData(await client.callTool("fusion_artifact_inspect", { artifact_id: plan.artifact.id }));
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.manifest_version, 2);
  assert.equal(receipt.plan_id, plan.id);
  assert.equal(receipt.producer_plan_hash, plan.hash);
  assert.equal(receipt.provenance.producer.provider_kind, "synthetic_fixture");
  assert.equal(receipt.provenance.producer.independently_verified, false);
  assert.equal(receipt.provenance.source.document_id, DOCUMENT_ID);
  assert.equal(receipt.files.length, 1);
  const bytes = readFileSync(receipt.path);
  assert.equal(receipt.files[0].sha256, sha256(bytes));
  assert.equal(receipt.files[0].size, bytes.length);
  assert.match(bytes.toString("utf8"), /SYNTHETIC PROTOCOL FIXTURE - NOT CAD GEOMETRY/u);
  assert.ok(path.relative(sandbox.artifactRoot, receipt.path).startsWith(`${receipt.id}${path.sep}`));

  const stateBeforeInspect = snapshotTree(sandbox.stateRoot);
  assert.deepEqual(toolData(await client.callTool("fusion_artifact_inspect", { artifact_id: receipt.id })), receipt);
  assert.deepEqual(snapshotTree(sandbox.stateRoot), stateBeforeInspect, "Receipt inspection must not rewrite its provenance or grade");
  const draft = toolData(await client.callTool("fusion_handoff_prepare", { title: "Synthetic marketplace review", plan_ids: [plan.id] }));
  assert.equal(draft.state, "draft");
  assert.equal(draft.engineering_approval, false);
  assert.equal(draft.external_release_performed, false);
  assert.equal(draft.checks.length, 0, "Omitted checks cannot become invented acceptance criteria");
  assert.ok(draft.unresolved.length > 0);
  const reviewed = toolData(await client.callTool("fusion_handoff_inspect", { handoff_id: draft.id }));
  assert.equal(reviewed.inspection.checks_rerun, false);
  assert.equal(reviewed.inspection.stored_manifest_modified, false);
  assert.equal(reviewed.inspection.engineering_approval, false);
});

test("shipped CLI runs from an unrelated directory and refuses fixture-only live qualification", { timeout: 60_000 }, t => {
  const sandbox = createSandbox(t);
  const status = runCli(sandbox, ["status", "--profile", sandbox.profileFile]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stderr, "");
  assert.equal(JSON.parse(status.stdout).mode, "fixture");
  const live = runCli(sandbox, ["qualify", "--live", "--profile", sandbox.profileFile]);
  assert.equal(live.status, 2, live.stderr);
  const report = JSON.parse(live.stdout);
  assert.equal(report.status, "incomplete");
  assert.equal(report.live_fusion_attempted, false);
  assert.equal(report.live_fusion_qualified, false);
});
