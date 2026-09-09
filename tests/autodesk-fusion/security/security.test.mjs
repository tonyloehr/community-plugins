import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createSandbox, DOCUMENT_ID, inspectDocument, parameter, readJson,
  runCli, snapshotTree, toolData, toolError, widthRequest,
} from "../support/packaged-client.mjs";

test("packaged MCP rejects arbitrary code, caller approval, output traversal and undeclared providers", { timeout: 90_000 }, async t => {
  const sandbox = createSandbox(t);
  const client = await sandbox.start();
  const before = await inspectDocument(client);
  const stateBefore = snapshotTree(sandbox.stateRoot);
  const rejected = await client.callTool("fusion_changes_prepare", { operation: "execute_python", args: { code: "raise Exception('not a reviewed operation')" } });
  toolError(rejected, "UNSUPPORTED_OPERATION");
  const approval = await client.callTool("fusion_changes_prepare", { ...widthRequest(before.state), approved: true });
  assert.equal(approval.isError, true, "Caller approval fields are not authorization");
  const arbitraryPath = await client.callTool("fusion_artifact_prepare", {
    operation: "exports.generate", document_id: DOCUMENT_ID,
    args: { format: "step", output_path: path.join(sandbox.root, "escape.step") },
  });
  toolError(arbitraryPath, "INVALID_INPUT");
  const traversal = await client.callTool("fusion_artifact_prepare", {
    operation: "exports.generate", document_id: DOCUMENT_ID,
    args: { format: "step", output: { root: "artifacts", filename: "../escape.step" } },
  });
  toolError(traversal, "UNSAFE_PATH");
  toolError(await client.callTool("fusion_data_search", { operation: "data.hubs", args: {} }), "CLOUD_NOT_CONFIGURED");
  toolError(await client.callTool("fusion_manage_item_draft_prepare", { workspace_id: 10, item_id: 3, changes: [{ field_id: "DESCRIPTION", after: "Synthetic candidate", source_ref: "test:unverified" }] }), "CLOUD_NOT_CONFIGURED");
  toolError(await client.callTool("fusion_manage_item_draft_inspect", { draft_id: "managedraft_00000000-0000-4000-8000-000000000000" }), "CLOUD_NOT_CONFIGURED");
  const tools = (await client.request("tools/list")).tools;
  assert.ok(!tools.some(tool => tool.name === "fusion_native_invoke"));
  assert.deepEqual(snapshotTree(sandbox.stateRoot), stateBefore, "Rejected requests must not create plans or mutate the fixture");
  assert.equal((await inspectDocument(client)).state, before.state);
  assert.equal(existsSync(path.join(sandbox.root, "escape.step")), false);
  assert.equal(existsSync(sandbox.artifactRoot), false);
});

test("stale observations and changed plan hashes cannot dispatch a second fixture edit", { timeout: 90_000 }, async t => {
  const sandbox = createSandbox(t);
  const client = await sandbox.start();
  const before = await inspectDocument(client);
  const stalePlan = toolData(await client.callTool("fusion_changes_prepare", widthRequest(before.state, "6 cm")));
  const accepted = toolData(await client.callTool("fusion_changes_prepare", widthRequest(before.state)));
  const done = toolData(await client.callTool("fusion_changes_execute", { plan_id: accepted.id, plan_hash: accepted.hash, idempotency_key: "marketplace-fresh-plan" }));
  assert.equal(done.status, "succeeded");
  const after = await inspectDocument(client);
  const unchanged = snapshotTree(sandbox.stateRoot);
  toolError(await client.callTool("fusion_changes_execute", { plan_id: stalePlan.id, plan_hash: stalePlan.hash, idempotency_key: "marketplace-stale-plan" }), "STALE_STATE");
  toolError(await client.callTool("fusion_changes_execute", { plan_id: stalePlan.id, plan_hash: "0".repeat(64), idempotency_key: "marketplace-changed-hash" }), "PLAN_HASH_MISMATCH");
  toolError(await client.callTool("fusion_changes_execute", { plan_id: accepted.id, plan_hash: accepted.hash, idempotency_key: "marketplace-different-key" }), "ALREADY_ATTEMPTED");
  assert.equal((await inspectDocument(client)).state, after.state);
  assert.equal(parameter(after, "width").value_mm, 50);
  assert.deepEqual(snapshotTree(sandbox.stateRoot), unchanged, "Rejected executions must not replace receipts or consume another attempt");
  const inspected = toolData(await client.callTool("fusion_changes_inspect", { plan_id: stalePlan.id }));
  assert.equal(inspected.status, "prepared");
});

test("trusted mutation and read restrictions survive the packaged MCP boundary", { timeout: 90_000 }, async t => {
  const sandbox = createSandbox(t, { configure: profile => { profile.policy.mutationsEnabled = false; profile.policy.readDocuments = [DOCUMENT_ID]; } });
  const client = await sandbox.start();
  const before = await inspectDocument(client);
  toolError(await client.callTool("fusion_document_inspect", { document_id: "fixture:outside-scope", args: {} }), "READ_DOCUMENT_DENIED");
  const plan = toolData(await client.callTool("fusion_changes_prepare", widthRequest(before.state)));
  assert.equal(plan.policy_decision.authorized, false);
  assert.equal(plan.policy_decision.blocker, "MUTATIONS_DISABLED");
  toolError(await client.callTool("fusion_changes_execute", { plan_id: plan.id, plan_hash: plan.hash, idempotency_key: "marketplace-disabled-edit" }), "MUTATIONS_DISABLED");
  assert.equal((await inspectDocument(client)).state, before.state);
  assert.equal(existsSync(path.join(sandbox.stateRoot, "fixture--bracket.json")), false, "No fixture write should occur under a disabled grant");
});

test("an altered committed bundle is refused before CLI runtime initialization", { timeout: 60_000 }, t => {
  const sandbox = createSandbox(t);
  const filename = path.join(sandbox.pluginRoot, "dist/server.mjs");
  writeFileSync(filename, `${readFileSync(filename, "utf8")}\n// test-owned distribution drift\n`);
  const result = runCli(sandbox, ["status", "--profile", sandbox.profileFile]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  const error = JSON.parse(result.stderr).error;
  assert.equal(error.code, "PACKAGE_INTEGRITY");
  assert.equal(existsSync(sandbox.stateRoot), false, "A mismatched execution receipt must fail before state initialization");
  assert.equal(readJson(sandbox.profileFile).mode, "fixture");
});
