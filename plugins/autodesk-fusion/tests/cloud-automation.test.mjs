import assert from "node:assert/strict";
import test from "node:test";
import { AutomationClient, BudgetLedger, CloudError, APS_ORIGIN, activityDefinitionHash, bundleDefinitionHash, cloudHash, cloudSourceHash, validateAutomationRecipe } from "../dist/index.mjs";

// Protocol fixtures do not run Fusion and are not evidence of geometry, engine compatibility or paid access.
const now = Date.parse("2026-08-28T12:00:00.000Z");
const scope = { tenantId: "enterprise-a", hubIds: ["hub-a"], projects: [{ hubId: "hub-a", projectId: "project-a" }] };
const source = "// Reviewed protocol-test TypeScript. Not a deployed or geometry-qualified recipe.\nexport function run(context: string) { return JSON.parse(context); }\n";
const activity = overrides => ({ engine: "Autodesk.Fusion+Latest", version: 7, commandLine: [], parameters: { TaskScript: { verb: "read", required: true }, TaskParameters: { verb: "read", required: true } }, appbundles: [], settings: {}, ...overrides });
const recipe = overrides => ({ id: "fixture-configure", version: "1.0.0", tenantId: scope.tenantId, delivery: "inline_script", script: { source, sha256: cloudSourceHash(source), language: "typescript", entryPoint: "run", typeDefinitionsVersion: "fixture-only" }, activity: { reference: "enterprise.Configure+release7", version: 7, definitionHash: activityDefinitionHash(activity()), engine: "Autodesk.Fusion+Latest" }, bundles: [], inputSchema: { widthMm: { type: "number", required: true, minimum: 1, maximum: 500 }, label: { type: "string", required: false, maxLength: 40 } }, allowedSources: [], destinations: [{ alias: "quarantine", kind: "object_storage", origin: "https://artifacts.example", keyPrefix: "/enterprise-a/quarantine/" }], limits: { maxVariants: 10, maxInputBytes: 100_000, maxOutputBytes: 10_000_000, maxProcessingSeconds: 300, maxAttempts: 1, minimumDelegatedTokenLifetimeMs: 600_000 }, cost: { kind: "estimated", currency: "USD", amountPerVariant: 2, priceAsOf: new Date(now).toISOString(), evidence: "Protocol-test estimate; not an Autodesk price quote." }, authority: "managed_service", dependencyImmutability: "release_alias_revalidated", verification: { procedure: "Validate artifact manifest, dimensions and geometry before publication.", validatorIds: ["test-validator"] }, ...overrides });
const context = overrides => ({ tenantId: scope.tenantId, sources: [], destinationAlias: "quarantine", variantCount: 1, ...overrides });
const grant = overrides => ({ accessToken: "PRIVATE_APP_ACCESS_TOKEN", expiresAt: now + 3_600_000, scopes: ["code:all", "data:read", "data:write"], tenantId: scope.tenantId, issuer: APS_ORIGIN, resource: APS_ORIGIN, grantType: "client_credentials", ...overrides });
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
const options = overrides => ({ scope, recipes: [recipe()], authMode: "app_only", tokenProvider: { async getToken() { return grant(); } }, limiter: { async acquire() {} }, now: () => now, sleep: async () => {}, permittedTransferOrigins: ["https://artifacts.example"], stageTransfers: async () => [{ name: "result", verb: "put", url: "https://artifacts.example/enterprise-a/quarantine/output.step?X-Amz-Signature=PRIVATE_TRANSFER_SIGNATURE", bytes: 1000 }], fetch: async url => String(url).includes("/activities/") ? json(activity()) : json({ id: "workitem-1", status: "pending" }), ...overrides });
const code = expected => error => error instanceof CloudError && error.code === expected;

test("recipe registry validates reviewed source hashes, typed bounds, scoped destinations and explicit verification", () => {
  const original = recipe();
  assert.equal(validateAutomationRecipe(original, scope).script.sha256, cloudSourceHash(source));
  const changes = [
    { script: { ...original.script, sha256: "0".repeat(64) } },
    { tenantId: "other-company" },
    { activity: { ...original.activity, reference: "enterprise.Generic+$LATEST" } },
    { inputSchema: { script: { type: "string", required: true, maxLength: 9999 } } },
    { inputSchema: { width: { type: "number", required: true } } },
    { destinations: [{ alias: "remote", kind: "object_storage", origin: "http://127.0.0.1:8080", keyPrefix: "/other/" }] },
    { destinations: [{ alias: "remote", kind: "fusion_project", hubId: "hub-a", projectId: "other-project" }] },
    { limits: { ...original.limits, maxAttempts: 2 } },
    { verification: { procedure: "none", validatorIds: [] } },
  ];
  for (const change of changes) assert.throws(() => validateAutomationRecipe(recipe(change), scope), CloudError);
});

test("prepare resolves activity versions, reserves an estimate, and discloses rolling engine and alias limitations", async () => {
  const client = new AutomationClient(options());
  const prepared = await client.prepare("fixture-configure", { widthMm: 42 }, context({ variantCount: 3 }));
  assert.equal(prepared.activity.version, 7);
  assert.equal(prepared.activity.rollingEngine, true);
  assert.equal(prepared.activity.aliasRacePossible, true);
  assert.equal(prepared.reservation.amount, 6);
  assert.equal(prepared.reservation.hardCap, false);
  assert.ok(prepared.warnings.some(value => /actual provider billing may exceed/i.test(value)));
  assert.ok(prepared.warnings.some(value => /Open Network/.test(value)));
  assert.equal(JSON.stringify(prepared).includes(source), false);
  assert.equal(JSON.stringify(client.listRecipes()).includes(source), false);
});

test("unbounded values, unapproved fields, hard billing caps and impossible immutability are blocked before submission", async () => {
  let requests = 0;
  const client = new AutomationClient(options({ fetch: async () => { requests++; return json(activity()); } }));
  for (const [input, ctx, expected] of [
    [{ widthMm: 501 }, context(), "INVALID_ARGUMENT"],
    [{ widthMm: Infinity }, context(), "INVALID_ARGUMENT"],
    [{ widthMm: 42, execute: "anything" }, context(), "INVALID_ARGUMENT"],
    [{ widthMm: 42, label: "https://attacker.example/script.ts" }, context(), "INVALID_ARGUMENT"],
    [{ widthMm: 42 }, context({ variantCount: 11 }), "BUDGET_EXCEEDED"],
    [{ widthMm: 42 }, context({ requireHardCap: true }), "BUDGET_UNENFORCEABLE"],
    [{ widthMm: 42 }, context({ requireImmutableEngine: true }), "IMMUTABILITY_UNAVAILABLE"],
    [{ widthMm: 42 }, context({ requireImmutableDependencies: true }), "IMMUTABILITY_UNAVAILABLE"],
    [{ widthMm: 42 }, context({ destinationAlias: "supplier-email" }), "SCOPE_DENIED"],
    [{ widthMm: 42 }, context({ tenantId: "other-company" }), "TENANT_MISMATCH"],
  ]) await assert.rejects(client.prepare("fixture-configure", input, ctx), code(expected));
  assert.equal(requests, 0);
});

test("provider-enforced cost claims reserve the full configured ceiling, not the lower estimate", async () => {
  const configured = recipe({ cost: { kind: "provider_enforced", currency: "USD", amountPerVariant: 2, providerCeiling: 20, priceAsOf: new Date(now).toISOString(), evidence: "Customer-verified deployment constraint fixture, not a generic APS ceiling." } });
  const client = new AutomationClient(options({ recipes: [configured] }));
  const prepared = await client.prepare(configured.id, { widthMm: 10 }, context({ requireHardCap: true }));
  assert.equal(prepared.reservation.amount, 20);
  assert.equal(prepared.reservation.hardCap, true);
});

test("changed activity aliases, engine references and bundle dependencies invalidate a prepared recipe", async () => {
  let current = activity(), posts = 0;
  const client = new AutomationClient(options({ fetch: async (_url, init) => { if (init.method === "POST") posts++; return json(current); } }));
  const prepared = await client.prepare("fixture-configure", { widthMm: 20 }, context());
  current = activity({ version: 8 });
  await assert.rejects(client.submit(prepared), code("STALE_RECIPE"));
  current = activity({ engine: "Autodesk.Fusion+Other" });
  await assert.rejects(client.submit(prepared), code("STALE_RECIPE"));
  current = activity({ appbundles: ["other.Unreviewed+release"] });
  await assert.rejects(client.submit(prepared), code("STALE_RECIPE"));
  assert.equal(posts, 0);
});

test("official inline TaskScript/TaskParameters workitem payload is generated from the installed recipe and secret transfers stay private", async () => {
  const submissions = [];
  const client = new AutomationClient(options({ fetch: async (url, init) => {
    if (String(url).includes("/activities/")) return json(activity());
    submissions.push({ url: String(url), init, body: JSON.parse(init.body) });
    return json({ id: "workitem-1", status: "pending", reportUrl: "https://artifacts.example/report?sig=PRIVATE_REPORT" });
  } }));
  const prepared = await client.prepare("fixture-configure", { widthMm: 42, label: "bracket-A" }, context());
  const result = await client.submit(prepared);
  assert.equal(submissions.length, 1);
  const submission = submissions[0];
  assert.equal(submission.url, `${APS_ORIGIN}/da/us-east/v3/workitems`);
  assert.equal(submission.body.activityId, "enterprise.Configure+release7");
  assert.equal(submission.body.arguments.TaskScript, source);
  const parameters = JSON.parse(submission.body.arguments.TaskParameters);
  assert.equal(parameters.schemaVersion, 1);
  assert.deepEqual(parameters.inputs, { widthMm: 42, label: "bracket-A" });
  assert.equal(parameters.destination.alias, "quarantine");
  assert.equal(parameters.requestId, prepared.id);
  assert.equal(submission.body.limitProcessingTimeSec, 300);
  assert.equal(result.providerId, "workitem-1");
  assert.equal(result.status, "queued");
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  await assert.rejects(client.submit(prepared), code("OUTCOME_UNKNOWN"));
  assert.equal(submissions.length, 1);
});

test("lost submission acknowledgement and provider 5xx are never retried or converted to success", async () => {
  for (const failure of [async () => { throw new Error("Network lost with PRIVATE_APP_ACCESS_TOKEN"); }, async () => json({ message: "PRIVATE_APP_ACCESS_TOKEN" }, 503), async () => json({ status: "pending" })]) {
    let posts = 0, sleeps = 0;
    const client = new AutomationClient(options({ sleep: async () => { sleeps++; }, fetch: async (url, init) => {
      if (String(url).includes("/activities/")) return json(activity());
      posts++; return failure();
    } }));
    const prepared = await client.prepare("fixture-configure", { widthMm: 25 }, context());
    await assert.rejects(client.submit(prepared), error => code("OUTCOME_UNKNOWN")(error) && error.outcome === "unknown" && !JSON.stringify(error).includes("PRIVATE_APP_ACCESS_TOKEN"));
    assert.equal(posts, 1);
    assert.equal(sleeps, 0);
    await assert.rejects(client.submit(prepared), code("OUTCOME_UNKNOWN"));
    assert.equal(posts, 1);
  }
});

test("429 on submission is a surfaced rejection, never an automatically repeated billable request", async () => {
  let posts = 0;
  const client = new AutomationClient(options({ fetch: async url => String(url).includes("/activities/") ? json(activity()) : (++posts, json({ secret: "PRIVATE" }, 429, { "retry-after": "10" })) }));
  const prepared = await client.prepare("fixture-configure", { widthMm: 25 }, context());
  await assert.rejects(client.submit(prepared), error => code("RATE_LIMITED")(error) && error.outcome === "none");
  assert.equal(posts, 1);
});

test("tampered plans and expired preparation never submit", async () => {
  let clock = now, posts = 0;
  const client = new AutomationClient(options({ now: () => clock, fetch: async (url, init) => { if (init.method === "POST") posts++; return String(url).includes("/activities/") ? json(activity()) : json({ id: "job", status: "pending" }); } }));
  const prepared = await client.prepare("fixture-configure", { widthMm: 25 }, context());
  const tampered = structuredClone(prepared); tampered.inputs.widthMm = 200;
  await assert.rejects(client.submit(tampered), code("STALE_PLAN"));
  clock += 20 * 60_000;
  await assert.rejects(client.submit(prepared), code("STALE_PLAN"));
  assert.equal(posts, 0);
});

test("app-plus-user route injects a separately authorized delegated token outside model context and freezes exact sources", async () => {
  const versionId = "urn:adsk.wipprod:fs.file:vf.part?version=3";
  const versionData = { id: versionId, attributes: { versionNumber: 3 }, relationships: { item: { data: { id: "item-a" } } } };
  const selected = { hubId: "hub-a", projectId: "project-a", itemId: "item-a", versionId, configurationId: null, resourceHash: cloudHash(versionData) };
  const configured = recipe({ allowedSources: [{ hubId: "hub-a", projectId: "project-a", itemId: "item-a" }], destinations: [{ alias: "drafts", kind: "fusion_project", hubId: "hub-a", projectId: "project-a" }] });
  const calls = [];
  const client = new AutomationClient(options({ authMode: "app_with_user", recipes: [configured], stageTransfers: undefined, delegatedTokenProvider: { async getToken() { return grant({ accessToken: "PRIVATE_DELEGATED_USER_TOKEN", grantType: "authorization_code" }); } }, fetch: async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/versions/")) { assert.equal(init.headers.authorization, "Bearer PRIVATE_DELEGATED_USER_TOKEN"); return json({ data: versionData }); }
    if (String(url).includes("/activities/")) return json(activity());
    assert.equal(init.headers.authorization, "Bearer PRIVATE_APP_ACCESS_TOKEN");
    assert.equal(JSON.parse(init.body).arguments.adsk3LeggedToken, "PRIVATE_DELEGATED_USER_TOKEN");
    return json({ id: "workitem-delegated", status: "pending" });
  } }));
  const prepared = await client.prepare(configured.id, { widthMm: 25 }, context({ sources: [selected], destinationAlias: "drafts" }));
  const result = await client.submit(prepared);
  assert.equal(result.providerId, "workitem-delegated");
  assert.equal(calls.filter(call => call.url.includes("/versions/")).length, 2, "Version dependency is rechecked immediately before submission");
  assert.equal(JSON.stringify(prepared).includes("PRIVATE_DELEGATED_USER_TOKEN"), false);
  assert.equal(JSON.stringify(result).includes("PRIVATE_DELEGATED_USER_TOKEN"), false);
});

test("wrong or soon-expiring delegated grants cannot run against a user's Fusion account", async () => {
  const configured = recipe({ destinations: [{ alias: "drafts", kind: "fusion_project", hubId: "hub-a", projectId: "project-a" }] });
  for (const [delegated, expected] of [[grant({ grantType: "authorization_code", tenantId: "other" }), "TENANT_MISMATCH"], [grant({ grantType: "authorization_code", expiresAt: now + 60_000 }), "TOKEN_EXPIRED"], [grant(), "UNSUPPORTED_AUTH"]]) {
    let posts = 0;
    const client = new AutomationClient(options({ authMode: "app_with_user", recipes: [configured], stageTransfers: undefined, delegatedTokenProvider: { async getToken() { return delegated; } }, fetch: async (_url, init) => { if (init.method === "POST") posts++; return json(activity()); } }));
    const prepared = await client.prepare(configured.id, { widthMm: 20 }, context({ destinationAlias: "drafts" }));
    await assert.rejects(client.submit(prepared), code(expected));
    assert.equal(posts, 0);
  }
});

test("public PKCE requires signed and provider-constrained activities; a generic signed script remains assisted only", async () => {
  const base = recipe();
  for (const [configured, expected] of [[recipe({ authority: "assisted_public_client", activity: { ...base.activity, signature: "PUBLIC_SIGNATURE" } }), "ASSISTED_ONLY"], [recipe({ authority: "provider_constrained_public_client", providerEnforcementEvidence: "fixture-policy" }), "ACTIVITY_UNSIGNED"]]) {
    const client = new AutomationClient(options({ authMode: "public_pkce", recipes: [configured], tokenProvider: { async getToken() { return grant({ grantType: "authorization_code" }); } } }));
    const prepared = await client.prepare(configured.id, { widthMm: 20 }, context());
    await assert.rejects(client.submit(prepared), code(expected));
  }
  const configured = recipe({ authority: "provider_constrained_public_client", providerEnforcementEvidence: "Test fixture for publisher-enforced script, scope and budget restrictions.", activity: { ...base.activity, signature: "PUBLIC_ACTIVITY_SIGNATURE" } });
  let submission;
  const client = new AutomationClient(options({ authMode: "public_pkce", recipes: [configured], tokenProvider: { async getToken() { return grant({ grantType: "authorization_code" }); } }, fetch: async (url, init) => {
    if (String(url).includes("/activities/")) return json(activity());
    submission = JSON.parse(init.body); return json({ id: "public-job", status: "pending" });
  } }));
  await client.submit(await client.prepare(configured.id, { widthMm: 20 }, context()));
  assert.equal(submission.signatures.activityId, "PUBLIC_ACTIVITY_SIGNATURE");
  assert.equal(Object.hasOwn(submission.arguments, "adsk3LeggedToken"), false);
});

test("packaged recipe dependencies are resolved and submitted without injecting TaskScript", async () => {
  const bundle = { engine: "Autodesk.Fusion+Latest", version: 2, settings: {}, package: "https://download.example/package?sig=DO_NOT_HASH_TRANSIENT_URL" };
  const packagedActivity = activity({ appbundles: ["enterprise.Bundle+release2"], parameters: { TaskParameters: { verb: "read" } } });
  const configured = recipe({ delivery: "appbundle", script: undefined, activity: { ...recipe().activity, definitionHash: activityDefinitionHash(packagedActivity) }, bundles: [{ reference: "enterprise.Bundle+release2", version: 2, definitionHash: bundleDefinitionHash(bundle), packageSha256: "a".repeat(64) }] });
  // Optional keys absent from installed JSON, not JavaScript undefined values.
  delete configured.script;
  let submission, bundleReads = 0;
  const client = new AutomationClient(options({ recipes: [configured], fetch: async (url, init) => {
    if (String(url).includes("/activities/")) return json(packagedActivity);
    if (String(url).includes("/appbundles/")) { bundleReads++; return json(bundle); }
    submission = JSON.parse(init.body); return json({ id: "packaged-job", status: "pending" });
  } }));
  await client.submit(await client.prepare(configured.id, { widthMm: 20 }, context()));
  assert.equal(bundleReads, 2);
  assert.equal(Object.hasOwn(submission.arguments, "TaskScript"), false);
});

test("signed transfer URLs cannot escape tenant destination prefixes or override reserved workitem arguments", async () => {
  for (const transfer of [
    { name: "result", verb: "put", url: "https://attacker.example/enterprise-a/quarantine/out", bytes: 1 },
    { name: "result", verb: "put", url: "https://artifacts.example/enterprise-b/quarantine/out", bytes: 1 },
    { name: "result", verb: "put", url: "https://artifacts.example/enterprise-a/quarantine/%252e%252e/private", bytes: 1 },
    { name: "TaskScript", verb: "get", url: "https://artifacts.example/script", bytes: 1, sha256: "a".repeat(64) },
    { name: "onComplete", verb: "put", url: "https://artifacts.example/enterprise-a/quarantine/callback", bytes: 1 },
    { name: "result", verb: "put", url: "https://artifacts.example/enterprise-a/quarantine/out", bytes: 10_000_001 },
  ]) {
    let posts = 0;
    const client = new AutomationClient(options({ stageTransfers: async () => [transfer], fetch: async (_url, init) => { if (init.method === "POST") posts++; return json(activity()); } }));
    const prepared = await client.prepare("fixture-configure", { widthMm: 20 }, context());
    await assert.rejects(client.submit(prepared), CloudError);
    assert.equal(posts, 0);
  }
});

test("workitem provider success requires validation and unknown future status keeps outcome unresolved", async () => {
  let status = "pending";
  const client = new AutomationClient(options({ fetch: async url => String(url).includes("/activities/") ? json(activity()) : json({ id: "workitem-1", status, reportUrl: "https://reports.example/?sig=PRIVATE_REPORT", stats: { bytesDownloaded: 123, timeQueued: new Date(now).toISOString(), token: "PRIVATE" } }) }));
  await client.submit(await client.prepare("fixture-configure", { widthMm: 20 }, context()));
  status = "success";
  const successful = await client.status("workitem-1");
  assert.equal(successful.status, "validating");
  assert.equal(successful.validationRequired, true);
  assert.equal(successful.completionConfirmed, true);
  assert.equal(JSON.stringify(successful).includes("PRIVATE"), false);
  status = "newProviderStatus";
  assert.equal((await client.status("workitem-1")).status, "outcome_unknown");
  status = "failedLimitDataSize";
  assert.equal((await client.status("workitem-1")).status, "failed");
});

test("status and cancellation enforce durable job ownership and cancellation is a request, never rollback", async () => {
  let deletes = 0;
  const client = new AutomationClient(options({ cancelQualified: true, authorizeExistingJob: async (id, tenant) => { assert.equal(tenant, scope.tenantId); if (id !== "owned-job") throw new CloudError("SCOPE_DENIED", "Not owned by this tenant ledger."); }, fetch: async (_url, init) => {
    if (init.method === "DELETE") { deletes++; return new Response(null, { status: 204 }); }
    return json({ id: "owned-job", status: "inprogress" });
  } }));
  await assert.rejects(client.status("other-tenant-job"), code("SCOPE_DENIED"));
  await assert.rejects(client.cancel("other-tenant-job"), code("SCOPE_DENIED"));
  assert.equal((await client.status("owned-job")).cancelSupported, true);
  const cancellation = await client.cancel("owned-job");
  assert.equal(cancellation.status, "cancel_requested");
  assert.equal(cancellation.completionConfirmed, false);
  assert.equal(cancellation.reservationMustRemain, true);
  assert.equal(deletes, 1);
  const unqualified = new AutomationClient(options({ authorizeExistingJob: async () => {} }));
  await assert.rejects(unqualified.cancel("owned-job"), code("UNSUPPORTED_CAPABILITY"));
});

test("budget ledger retains running and unknown exposure across restore and permits only confirmed terminal settlement", () => {
  const ledger = new BudgetLedger({ currency: "USD", limit: 10, maxConcurrent: 2 });
  ledger.reserve("a", 6);
  ledger.mark("a", "submitting"); ledger.mark("a", "unknown");
  assert.throws(() => ledger.releaseUnsubmitted("a"), code("OUTCOME_UNKNOWN"));
  assert.throws(() => ledger.reserve("b", 5), code("BUDGET_EXCEEDED"));
  const restored = new BudgetLedger(ledger.snapshot());
  assert.equal(restored.exposure, 6);
  assert.throws(() => restored.mark("a", "submitting"), code("OUTCOME_UNKNOWN"));
  restored.reserve("b", 4); restored.mark("b", "running");
  assert.throws(() => restored.reserve("c", 0), code("BUDGET_EXCEEDED"));
  assert.throws(() => restored.reconcile("a", "cancel_requested", 0), code("INVALID_ARGUMENT"));
  restored.reconcile("a", "failed", 7);
  assert.equal(restored.snapshot().spent, 7);
  assert.equal(restored.exposure, 4);
  assert.throws(() => restored.reserve("c", 0), code("BUDGET_EXCEEDED"), "Actual cost overrun blocks further admission");
  assert.throws(() => restored.reconcile("a", "failed", 7), code("IDEMPOTENCY_CONFLICT"));
  restored.reconcile("b", "cancelled", 1);
  assert.equal(restored.snapshot().spent, 8);
  assert.equal(restored.exposure, 0);
});

test("unsubmitted budget reservations are reversible, currency-specific and idempotent", () => {
  const ledger = new BudgetLedger({ currency: "USD", limit: 10, maxConcurrent: 1 });
  ledger.reserve("a", 3); ledger.reserve("a", 3);
  assert.equal(ledger.exposure, 3);
  assert.throws(() => ledger.reserve("a", 4), code("IDEMPOTENCY_CONFLICT"));
  assert.throws(() => ledger.reserve("b", 1, "EUR"), code("INVALID_ARGUMENT"));
  ledger.releaseUnsubmitted("a");
  assert.equal(ledger.exposure, 0);
  ledger.reserve("b", 10);
  assert.equal(ledger.snapshot().reservations.length, 1);
});
