import { cp, lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { NativeFusionClient, schemaFingerprint, validateEnrollment } from './native.js';
import { createRuntime } from './runtime.js';
import { defaultStateRoot, fixtureProfile, loadProfile, parseProfile } from './profile.js';
import { FusionError, errorResult, hashBytes, now, redact } from './safety.js';
import { ensurePrivateDirectory, recoverDeadLease } from './storage.js';
import { runQualification } from './qualification.js';

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
`;
export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, profile: { type: 'string' }, family: { type: 'string' }, schema: { type: 'boolean' },
    request: { type: 'string' }, plan: { type: 'string' }, hash: { type: 'string' }, key: { type: 'string' }, artifact: { type: 'string' },
    output: { type: 'string' }, mode: { type: 'string' }, url: { type: 'string' }, tool: { type: 'string' }, argument: { type: 'string' }, live: { type: 'boolean' }, scenario: { type: 'string' }, job: { type: 'string' }
  } });
  const command = positionals[0] ?? 'help';
  if (values.help || command === 'help') { process.stdout.write(help); return 0; }
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
    const profile = values.profile ? await loadProfile(values.profile) : undefined;
    const url = values.url ?? profile?.desktop?.url;
    if (!url) throw new FusionError('CLI_ARGUMENT_REQUIRED', '--url or a desktop profile is required.');
    const native = new NativeFusionClient({ url, timeoutMs: 15_000 });
    try {
      const connection = await native.connect();
      const tools = await native.listTools();
      if (command === 'native-discover') emit({ connection, tools: tools.map(tool => ({ ...tool, schema_sha256: schemaFingerprint(tool) })), next: 'Select the actual Python execution tool and its string argument. Enroll its displayed schema hash only after review; no tool name is guessed.' });
      else {
        if (!profile || !values.profile || !profile.desktop) throw new FusionError('CLI_ARGUMENT_REQUIRED', 'Enrollment requires an existing desktop profile.');
        const mapping = { tool: required('tool'), argument: required('argument'), schemaHash: required('hash') };
        validateEnrollment(mapping, tools);
        const updated = parseProfile({ ...profile, desktop: { ...profile.desktop, mapping } });
        const original = await lstat(values.profile);
        if (!original.isFile() || original.isSymbolicLink() || original.nlink !== 1) throw new FusionError('UNSAFE_PATH', 'Profile must be a regular file without aliases.');
        await writeFile(values.profile, JSON.stringify(updated, null, 2) + '\n', { mode: 0o600 });
        emit({ enrolled: mapping, profile: values.profile, live_qualified: false, next: 'Run read-only qualification. Enrollment binds a schema; it does not prove the server is Autodesk or that a workflow works.' });
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
