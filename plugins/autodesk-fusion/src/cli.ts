import { constants, type BigIntStats } from 'node:fs';
import { cp, lstat, open, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { NativeFusionClient, schemaFingerprint, validateEnrollment } from './native.js';
import { createRuntime } from './runtime.js';
import { defaultStateRoot, fixtureProfile, loadProfile, parseProfile, profileHash, readTrustedFile, type FusionProfile } from './profile.js';
import { FusionError, assertJson, errorResult, hashBytes, now, redact } from './safety.js';
import { ensurePrivateDirectory, recoverDeadLease } from './storage.js';
import { runQualification } from './qualification.js';

const MAX_PROFILE_BYTES = 1_048_576;
const MAX_FIXED_ARGUMENT_BYTES = 65_536;
const profileChanged = () => new FusionError('PROFILE_CHANGED', 'The trusted profile changed during native discovery. Review the current file before enrolling again.');
const sameRevision = (a: BigIntStats, b: BigIntStats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
  && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid && a.nlink === b.nlink;

async function fixedArgumentsFile(filename: string): Promise<Record<string, unknown>> {
  const { bytes } = await readTrustedFile(filename, MAX_FIXED_ARGUMENT_BYTES);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new FusionError('INVALID_INPUT', 'Fixed arguments must contain valid bounded UTF-8 JSON.'); }
  assertJson(value, MAX_FIXED_ARGUMENT_BYTES);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FusionError('INVALID_INPUT', 'Fixed arguments must be an explicit JSON object.');
  return value as Record<string, unknown>;
}

async function enrollmentSnapshot(filename: string, profile: FusionProfile) {
  const before = await lstat(filename, { bigint: true });
  const file = await readTrustedFile(filename, MAX_PROFILE_BYTES);
  const revision = await lstat(file.canonicalPath, { bigint: true });
  if (!sameRevision(before, revision)) throw profileChanged();
  try {
    if (profileHash(parseProfile(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)))) !== profileHash(profile)) throw profileChanged();
  } catch { throw profileChanged(); }
  return { ...file, revision };
}

async function saveEnrollment(filename: string, snapshot: Awaited<ReturnType<typeof enrollmentSnapshot>>, profile: FusionProfile): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(profile, null, 2) + '\n');
  if (bytes.length > MAX_PROFILE_BYTES) throw new FusionError('INPUT_LIMIT', 'The enrolled profile exceeds the trusted profile byte limit.');
  const current = await readTrustedFile(filename, MAX_PROFILE_BYTES);
  if (current.canonicalPath !== snapshot.canonicalPath || !current.bytes.equals(snapshot.bytes)) throw profileChanged();
  // Pin the existing regular file without truncating or following a replacement
  // symlink. These checks detect discovery-time changes, not a lock against the
  // local profile owner making another concurrent write after the final check.
  const handle = await open(snapshot.canonicalPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  let writeAttempted = false;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameRevision(opened, snapshot.revision)) throw profileChanged();
    const observed = Buffer.alloc(snapshot.bytes.length + 1);
    let length = 0;
    while (length < observed.length) {
      const result = await handle.read(observed, length, observed.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true }), linked = await lstat(snapshot.canonicalPath, { bigint: true });
    if (length !== snapshot.bytes.length || !observed.subarray(0, length).equals(snapshot.bytes)
      || !sameRevision(opened, after) || !sameRevision(opened, linked) || await realpath(filename) !== snapshot.canonicalPath) throw profileChanged();
    writeAttempted = true;
    await handle.writeFile(bytes);
    await handle.truncate(bytes.length);
    await handle.sync();
    const verified = await readTrustedFile(filename, MAX_PROFILE_BYTES);
    const final = await lstat(snapshot.canonicalPath, { bigint: true });
    if (verified.canonicalPath !== snapshot.canonicalPath || !verified.bytes.equals(bytes) || final.dev !== opened.dev || final.ino !== opened.ino) throw profileChanged();
  } catch (error) {
    if (writeAttempted) throw new FusionError('PROFILE_UPDATE_UNCONFIRMED', 'The enrollment profile write could not be confirmed. Inspect the current file before another enrollment.', 'unknown');
    throw error;
  } finally { await handle.close(); }
}

const help = `Autodesk Fusion interoperability CLI

  fusionctl status [--profile /absolute/profile.json]
  fusionctl capabilities [--family parameters] [--schema]
  fusionctl read --request /absolute/request.json
  fusionctl prepare --request /absolute/request.json
  fusionctl execute --plan PLAN --hash SHA256 --key UNIQUE_KEY
  fusionctl plan --plan PLAN
  fusionctl artifact --artifact ARTIFACT
  fusionctl profile-init --output /absolute/profile.json --mode managed|assisted|fixture
  fusionctl native-discover --url http://127.0.0.1:27182/mcp
  fusionctl native-enroll --profile /absolute/profile.json --tool NAME --argument FIELD --hash TOOL_SCHEMA_SHA256
    [--url http://127.0.0.1:27182/mcp] [--fixed-arguments-file /absolute/reviewed-values.json]
  fusionctl qualify [--live] [--scenario /absolute/scenario.json] [--profile /absolute/profile.json]
  fusionctl install-addin --output /absolute/new/CodexFusionInterop
  fusionctl auth-login|auth-status|auth-logout --profile /absolute/cloud-profile.json
  fusionctl cloud-read|cloud-prepare --request /absolute/request.json
  fusionctl cloud-submit --job JOB --hash SHA256 --key UNIQUE_KEY
  fusionctl cloud-job|cloud-cancel|cloud-validate|cloud-settle --job JOB
  fusionctl recover-lock --profile /absolute/profile.json

No command starts Fusion, installs packages at runtime, grants broad writes, merges a PR,
or submits paid compute implicitly. Profile mutation grants must be explicitly scoped
and expire. Review the setup skill for live qualification and enterprise host controls.

Native enrollment requires a managed or assisted native profile. Fixed arguments are
an optional trusted UTF-8 JSON object (64 KiB maximum), explicitly reviewed and never inferred.
They cannot override the script argument. The selected --url is saved with the mapping;
profiles changed during discovery are rejected. Enrollment does not qualify Fusion or
execute a tool. Full argument-schema validation remains required at each dispatch.
`;
export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, profile: { type: 'string' }, family: { type: 'string' }, schema: { type: 'boolean' },
    request: { type: 'string' }, plan: { type: 'string' }, hash: { type: 'string' }, key: { type: 'string' }, artifact: { type: 'string' },
    output: { type: 'string' }, mode: { type: 'string' }, url: { type: 'string' }, tool: { type: 'string' }, argument: { type: 'string' }, 'fixed-arguments-file': { type: 'string' }, live: { type: 'boolean' }, scenario: { type: 'string' }, job: { type: 'string' }
  } });
  const command = positionals[0] ?? 'help';
  if (values.help || command === 'help') { process.stdout.write(help); return 0; }
  if (values['fixed-arguments-file'] !== undefined && command !== 'native-enroll') throw new FusionError('INVALID_INPUT', '--fixed-arguments-file is only supported by native-enroll.');
  const emit = (value: unknown) => process.stdout.write(JSON.stringify(redact(value), null, 2) + '\n');
  const required = (name: keyof typeof values): string => {
    const value = values[name]; if (typeof value !== 'string' || !value) throw new FusionError('CLI_ARGUMENT_REQUIRED', `--${name} is required.`); return value;
  };
  if (command === 'profile-init') {
    const filename = required('output');
    if (!path.isAbsolute(filename)) throw new FusionError('UNSAFE_PATH', 'Profile output must be absolute.');
    const mode = values.mode ?? 'managed';
    const id = `fusion-${mode}`;
    const stateRoot = path.join(defaultStateRoot(), id);
    const profile = mode === 'fixture' ? fixtureProfile(stateRoot) : parseProfile({ version: 1, id, mode, stateRoot, desktop: { url: values.url ?? 'http://127.0.0.1:27182/mcp' }, policy: { mutationsEnabled: false }, outputs: [{ id: 'artifacts', path: path.join(stateRoot, 'artifacts') }] });
    await ensurePrivateDirectory(path.dirname(filename));
    await writeFile(filename, JSON.stringify(profile, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    emit({ created: filename, mode, mutations_enabled: profile.policy.mutationsEnabled,
      next: mode === 'fixture' ? 'Synthetic fixture only. Run fixture qualification; this profile grants no Autodesk access.' : 'Review the profile, discover and enroll the exact native script tool, then run read-only qualification.' }); return 0;
  }
  if (command === 'native-discover' || command === 'native-enroll') {
    const filename = command === 'native-enroll' ? required('profile') : values.profile;
    const profile = filename ? await loadProfile(filename) : undefined;
    if (profile && (profile.mode === 'fixture' || profile.desktop?.provider !== 'native')) throw new FusionError('NATIVE_PROFILE_REQUIRED', 'Native discovery and enrollment require a managed or assisted native desktop profile; fixture and add-in profiles are not converted.');
    const url = values.url ?? profile?.desktop?.url;
    if (!url) throw new FusionError('CLI_ARGUMENT_REQUIRED', '--url or a desktop profile is required.');
    const mapping = command === 'native-enroll' ? {
      tool: required('tool'), argument: required('argument'), schemaHash: required('hash'),
      ...(values['fixed-arguments-file'] !== undefined ? { fixedArguments: await fixedArgumentsFile(required('fixed-arguments-file')) } : {})
    } : undefined;
    const snapshot = mapping && filename && profile ? await enrollmentSnapshot(filename, profile) : undefined;
    const native = new NativeFusionClient({ url, ...(mapping ? { mapping } : {}), timeoutMs: 15_000 });
    try {
      const connection = await native.connect();
      const tools = await native.listTools();
      if (command === 'native-discover') emit({ connection, tools: tools.map(tool => ({ ...tool, schema_sha256: schemaFingerprint(tool) })), next: 'Select the actual Python execution tool and its string argument. Review every additional required argument and provide its fixed value through --fixed-arguments-file. Enroll the displayed schema hash only after review; no tool name or value is guessed.' });
      else {
        if (!profile || !filename || !profile.desktop || !mapping || !snapshot) throw new FusionError('CLI_ARGUMENT_REQUIRED', 'Enrollment requires an existing native desktop profile.');
        validateEnrollment(mapping, tools);
        const updated = parseProfile({ ...profile, desktop: { ...profile.desktop, url, mapping } });
        // A valid standalone arguments object can exceed profileHash's JSON
        // depth/node bound once nested inside the profile. Validate the whole
        // profile and serialize the exact sanitized confirmation before writing.
        assertJson(updated, MAX_PROFILE_BYTES);
        const confirmation = redact({ enrolled: mapping, profile: filename, endpoint: url, live_qualified: false, next: 'Run read-only qualification. Enrollment binds a schema and explicit fixed values; it does not prove the server is Autodesk or that a workflow works.' });
        assertJson(confirmation, MAX_PROFILE_BYTES);
        const confirmationJson = JSON.stringify(confirmation, null, 2) + '\n';
        if (Buffer.byteLength(confirmationJson) > MAX_PROFILE_BYTES) throw new FusionError('INPUT_LIMIT', 'The enrollment confirmation exceeds its bounded output limit.');
        await saveEnrollment(filename, snapshot, updated);
        process.stdout.write(confirmationJson);
      }
    } finally { await native.close(); }
    return 0;
  }
  if (command === 'recover-lock') { const profile = await loadProfile(required('profile')); await recoverDeadLease(profile.stateRoot); emit({ lock_removed: true, warning: 'An interrupted operation may still have committed. Inspect its durable plan; execution intent is never replayed.' }); return 0; }
  const runtime = await createRuntime(values.profile);
  try {
    const requestFile = async () => {
      const filename = required('request'); const stat = await lstat(filename);
      if (!stat.isFile() || stat.size > 2_097_152) throw new FusionError('INPUT_LIMIT', 'Request must be a bounded JSON file.');
      return JSON.parse(await readFile(filename, 'utf8')) as Record<string, unknown>;
    };
    const cloud = () => { if (!runtime.cloud) throw new FusionError('CLOUD_NOT_CONFIGURED', 'An explicit scoped cloud profile is required.'); return runtime.cloud; };
    const pkce = () => { const client = cloud().oauth; if (!client) throw new FusionError('EXTERNAL_AUTHORIZATION_OWNER', 'This profile uses enterprise-managed credentials. Sign in or revoke through that authorization owner; the plugin does not create an unrelated public-client grant.'); return client; };
    if (command === 'install-addin') {
      const destination = required('output'); if (!path.isAbsolute(destination)) throw new FusionError('UNSAFE_PATH', 'Choose an explicit absolute new add-in directory.');
      await cp(path.join(runtime.root, 'dist', 'addin', 'CodexFusionInterop'), destination, { recursive: true, errorOnExist: true, force: false });
      emit({ installed: destination, started: false, next: 'In Fusion Scripts and Add-Ins, add the installed CodexFusionInterop directory and run it. Review its displayed pairing path, then configure desktop.provider=addin; there is no silent fallback or autostart.' });
    } else if (command === 'auth-login') {
      const authorization = await pkce().beginAuthorization();
      emit({ authorization_url: authorization.authorizationUrl, expires_in: '5 minutes', action: 'Open this Autodesk authorization URL in your browser and complete sign-in. No browser is opened automatically.' });
      try { emit({ signed_in: await authorization.completion }); } finally { authorization.cancel(); }
    } else if (command === 'auth-status') emit(await cloud().status());
    else if (command === 'auth-logout') emit(await pkce().revoke());
    else if (command === 'cloud-read') { const request = await requestFile(); emit(await cloud().read(request.operation as string, request.args as Record<string, unknown>)); }
    else if (command === 'cloud-prepare') { const request = await requestFile(); emit(await cloud().prepareJob(request.recipe_id as string, request.inputs as Record<string, string | number | boolean>, request.context as never)); }
    else if (command === 'cloud-submit') { const result = await cloud().submitJob(required('job'), required('hash'), required('key')); emit(result); return ['failed', 'outcome_unknown'].includes(result.status) ? 2 : 0; }
    else if (command === 'cloud-job') emit(await cloud().jobStatus(required('job')));
    else if (command === 'cloud-cancel') emit(await cloud().cancelJob(required('job')));
    else if (command === 'cloud-validate') emit(await cloud().validateJob(required('job')));
    else if (command === 'cloud-settle') emit(await cloud().settleJob(required('job')));
    else if (command === 'status') emit(await runtime.engine.connectionStatus());
    else if (command === 'capabilities') emit(runtime.engine.capabilities(values.family, values.schema ?? false));
    else if (command === 'read' || command === 'prepare') {
      const request: unknown = await requestFile();
      emit(command === 'read' ? await runtime.engine.read(request) : await runtime.engine.prepare(request));
    } else if (command === 'execute') {
      const result = await runtime.engine.execute(required('plan'), required('hash'), required('key')); emit(result); return result.status === 'succeeded' ? 0 : 2;
    } else if (command === 'plan') emit(await runtime.engine.inspectPlan(required('plan')));
    else if (command === 'artifact') emit(await runtime.engine.artifacts.inspect(required('artifact'), true));
    else if (command === 'qualify') {
      if (values.scenario) {
        const stat = await lstat(values.scenario); if (!stat.isFile() || stat.size > 2_097_152) throw new FusionError('INPUT_LIMIT', 'Scenario must be a bounded JSON file.');
        if (values.live && runtime.profile.mode === 'fixture') throw new FusionError('LIVE_PROVIDER_REQUIRED', 'A fixture scenario cannot count as live Fusion qualification.');
        const report = await runQualification(runtime, JSON.parse(await readFile(values.scenario, 'utf8'))); emit(report); return report.status === 'scenario_passed' ? 0 : 2;
      }
      const report: Record<string, unknown> = { tested_at: now(), profile: runtime.profile.id, mode: runtime.profile.mode, package_handler_sha256: runtime.engine.handlerHash, tests: [] };
      const tests = report.tests as unknown[];
      try {
        const documents = await runtime.engine.read({ operation: 'documents.list', args: { limit: 100 } });
        tests.push({ name: 'desktop_read_roundtrip', status: 'passed', evidence: documents });
      } catch (error) { tests.push({ name: 'desktop_read_roundtrip', status: 'blocked', error: errorResult(error) }); }
      const isLive = values.live && runtime.profile.mode !== 'fixture';
      report.live_fusion_attempted = isLive;
      report.live_fusion_qualified = false;
      report.required_external_evidence = ['Licensed Fusion desktop on each supported OS/build.', 'Synthetic engineering model edit/measure/export/reopen checks in the real kernel.', 'Entitled CAM strategy, post and machine review by a manufacturing engineer.', 'Scoped APS hub/OAuth/compute checks using account-authorized test data.'];
      report.status = values.live ? 'incomplete' : 'diagnostic_only';
      const reportId = `qualification_${hashBytes(JSON.stringify(report)).slice(0, 24)}`;
      await runtime.engine.store.put('qualification', reportId, report);
      emit({ id: reportId, ...report });
      return values.live ? 2 : (tests.some(t => (t as { status: string }).status === 'blocked') ? 2 : 0);
    } else throw new FusionError('UNKNOWN_COMMAND', `Unknown command ${command}. Run fusionctl --help.`);
    return 0;
  } finally { await runtime.close(); }
}
export async function cliMain(): Promise<void> {
  try { process.exitCode = await runCli(); } catch (error) { process.stderr.write(JSON.stringify({ error: errorResult(error) }) + '\n'); process.exitCode = 1; }
}
