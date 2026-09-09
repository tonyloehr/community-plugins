import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod/v4';
import { retentionHoldsSchema, retentionPolicySchema } from './retention.js';
import { manageDraftRegistrySchema } from './manage-drafts.js';
import { FusionError, hash, hashBytes } from './safety.js';

const absolute = z.string().max(4096).refine(v => path.isAbsolute(v) && !v.includes('\0') && !/^[/\\]{2}/u.test(v), 'Use an absolute local path without network shares or NUL bytes.');
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const asset = z.strictObject({ id, path: absolute, sha256: sha });
const profileSchema = z.strictObject({
  version: z.literal(1), id, mode: z.enum(['fixture', 'managed', 'assisted']),
  stateRoot: absolute,
  desktop: z.strictObject({ provider: z.enum(['native', 'addin']).default('native'), url: z.string().url(), tokenFile: absolute.optional(), mapping: z.strictObject({ tool: z.string().min(1), argument: z.string().min(1), schemaHash: sha, fixedArguments: z.record(z.string(), z.unknown()).optional() }).optional(), timeoutMs: z.number().int().min(100).max(120_000).default(120_000) }).optional(),
  policy: z.strictObject({
    mutationsEnabled: z.boolean().default(false),
    effects: z.array(z.enum(['local_edit', 'local_artifact', 'cloud_write', 'cloud_compute', 'administration'])).default([]),
    operations: z.array(z.string().min(1)).default([]),
    documents: z.array(z.string().min(1)).default([]),
    readDocuments: z.array(z.string().min(1)).optional(),
    planMaxAgeMs: z.number().int().min(1_000).max(3_600_000).default(900_000),
    grantExpiresAt: z.string().datetime().optional(),
    allowUnsavedCreation: z.boolean().default(false),
    allowCreatedDocuments: z.boolean().default(false),
    qualificationDocuments: z.array(z.string().min(1)).default([]),
    allowNonAtomicCloudWrites: z.boolean().default(false),
    allowedDataFiles: z.array(z.strictObject({ id: z.string(), versionId: z.string() })).default([]),
    saveFolders: z.array(z.string()).default([]),
    qualifiedOperations: z.array(z.string()).default([]),
    qualificationEvidence: z.string().max(4096).optional(),
    desktopQualification: z.strictObject({
      version: z.literal(1), provider: z.enum(['native', 'addin']),
      fusionVersion: z.string().min(1).max(256), platform: z.string().min(1).max(32), arch: z.string().min(1).max(32), osRelease: z.string().min(1).max(256),
      handlerSha256: sha, executionContractSha256: sha,
      expiresAt: z.string().datetime(), evidence: z.string().min(1).max(4096), reviewer: z.string().min(1).max(256),
    }).optional(),
    maxPlansPerMinute: z.number().int().min(1).max(600).default(60)
  }),
  outputs: z.array(z.strictObject({ id, path: absolute })).default([]),
  assets: z.strictObject({ templates: z.array(asset).default([]), posts: z.array(asset).default([]), machines: z.array(asset).default([]), toolLibraries: z.array(asset).default([]), imports: z.array(asset.extend({ trusted: z.literal(true) })).default([]) }).default(() => ({ templates: [], posts: [], machines: [], toolLibraries: [], imports: [] })),
  manufacturing: z.array(z.strictObject({
    id, postId: id, machineId: id, toolLibrarySha256: sha,
    strategyIds: z.array(z.string()).min(1), units: z.enum(['mm', 'in']),
    qualificationEvidence: z.string().min(1),
    reviewRecords: z.array(z.strictObject({ id, sourceState: sha, method: z.string().min(1), reviewedBy: z.string().min(1), expiresAt: z.string().datetime() })).default([])
  })).default([]),
  retention: z.strictObject({ policy: retentionPolicySchema.optional(), holds: retentionHoldsSchema.optional() }).optional(),
  cloud: z.strictObject({
    clientId: z.string().min(1).optional(), tenantId: z.string().min(1), scopes: z.array(z.string()).min(1).optional(), redirectUri: z.string().url().optional(),
    hubIds: z.array(z.string()).default([]), projects: z.array(z.strictObject({ hubId: z.string(), projectId: z.string() })).default([]),
    mfgModels: z.array(z.strictObject({ modelId: z.string(), hubId: z.string(), projectId: z.string(), configurationId: z.string().nullable().optional() })).default([]),
    manage: z.strictObject({ tenant: z.string(), workspaceIds: z.array(z.number().int().positive()) }).optional(),
    manageDraftSchemas: manageDraftRegistrySchema.optional(),
    recipesFile: absolute.optional(),
    enterpriseAdapter: z.strictObject({ path: absolute, sha256: sha }).optional(),
    propertyRules: z.array(z.strictObject({ propertyDefinitionId: z.string().min(1), type: z.enum(['string', 'number', 'boolean']), allowNull: z.boolean(), maxLength: z.number().int().positive().optional(), minimum: z.number().finite().optional(), maximum: z.number().finite().optional(), unit: z.string().optional(), owner: z.literal('product') })).default([]),
    budget: z.strictObject({ maxConcurrentJobs: z.number().int().min(1).max(100), maxSubmissions: z.number().int().min(1), maxReservedUnits: z.number().positive(), currency: z.string().min(1).max(32), period: z.string().min(1) }).optional()
  }).optional()
});
export type FusionProfile = z.infer<typeof profileSchema>;
export const defaultStateRoot = (): string => path.join(os.homedir(), '.local', 'state', 'codex-fusion');
export function fixtureProfile(stateRoot = path.join(defaultStateRoot(), 'fixture')): FusionProfile {
  return profileSchema.parse({ version: 1, id: 'fixture', mode: 'fixture', stateRoot, policy: { mutationsEnabled: true, effects: ['local_edit', 'local_artifact'], operations: ['*'], documents: ['fixture:bracket'], qualifiedOperations: [], allowUnsavedCreation: false }, outputs: [{ id: 'artifacts', path: path.join(stateRoot, 'artifacts') }] });
}
export function parseProfile(value: unknown): FusionProfile {
  const result = profileSchema.safeParse(value);
  if (!result.success) throw new FusionError('INVALID_PROFILE', 'Profile does not match the versioned schema.', 'none', result.error.issues.map(x => ({ path: x.path, message: x.message })));
  const p = result.data;
  if (p.desktop?.provider === 'addin' && (!p.desktop.tokenFile || p.desktop.mapping)) throw new FusionError('INVALID_PROFILE', 'Add-in profiles require an explicit tokenFile and must not include a native script mapping.');
  if (p.desktop?.provider === 'native' && p.desktop.tokenFile) throw new FusionError('INVALID_PROFILE', 'Native MCP does not use the add-in token file.');
  if (p.cloud?.enterpriseAdapter && (p.cloud.clientId !== undefined || p.cloud.scopes !== undefined || p.cloud.redirectUri !== undefined)) throw new FusionError('INVALID_PROFILE', 'Enterprise adapters own authorization; omit public-client clientId/scopes/redirectUri fields. Their service grants are not inherited from interactive PKCE.');
  if (p.cloud && !p.cloud.enterpriseAdapter && (!p.cloud.clientId || !p.cloud.scopes || !p.cloud.redirectUri)) throw new FusionError('INVALID_PROFILE', 'Standard cloud profiles require an explicit public clientId, scopes and redirectUri.');
  for (const schema of p.cloud?.manageDraftSchemas ?? []) {
    if (!p.cloud?.manage || schema.tenant !== p.cloud.manage.tenant || !p.cloud.manage.workspaceIds.includes(schema.workspaceId)) throw new FusionError('INVALID_PROFILE', 'Every trusted Manage draft schema must belong to the exact configured tenant and an allowlisted workspace.');
  }
  for (const list of [p.outputs, p.assets.templates, p.assets.posts, p.assets.machines, p.assets.toolLibraries, p.assets.imports, p.manufacturing]) if (new Set(list.map(x => x.id)).size !== list.length) throw new FusionError('INVALID_PROFILE', 'Profile IDs must be unique within each registry.');
  if (p.mode !== 'fixture' && p.policy.operations.includes('*')) throw new FusionError('INVALID_PROFILE', 'Real provider grants must enumerate operations.');
  if (p.mode !== 'fixture' && p.policy.documents.includes('*')) throw new FusionError('INVALID_PROFILE', 'Real provider grants must enumerate document references.');
  if (p.policy.readDocuments?.includes('*')) throw new FusionError('INVALID_PROFILE', 'Restricted read scope must enumerate document references; omit readDocuments to explicitly use all current-user open documents.');
  if (p.mode !== 'fixture' && p.policy.mutationsEnabled && !p.policy.grantExpiresAt) throw new FusionError('INVALID_PROFILE', 'Real provider mutation grants require an expiry.');
  return p;
}
export async function loadProfile(filename?: string): Promise<FusionProfile> {
  if (!filename) return fixtureProfile();
  if (!path.isAbsolute(filename)) throw new FusionError('INVALID_PROFILE', 'FUSION_PROFILE must be an explicit absolute path.');
  const { bytes } = await readTrustedFile(filename, 1_048_576);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new FusionError('INVALID_PROFILE', 'Profile must contain valid bounded UTF-8 JSON.'); }
  const profile = parseProfile(value);
  if (profile.cloud?.enterpriseAdapter) await verifyTrustedExecutableAsset(profile.cloud.enterpriseAdapter);
  return profile;
}
export const profileHash = (profile: FusionProfile): string => hash(profile);

const execFileAsync = promisify(execFile);
// Paths are data in a private child-process environment, never PowerShell source.
// Read access is permitted; only trusted administrators/current user may change
// the profile/module or replace one of its parent directory entries.
const WINDOWS_TRUST_CHECK = String.raw`
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted = @($sid, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$paths = ConvertFrom-Json $env:CODEX_FUSION_TRUST_PATHS
foreach ($item in $paths) {
  $acl = Get-Acl -LiteralPath $item
  if ($trusted -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { exit 2 }
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
    if (($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
    $write = [int][System.Security.AccessControl.FileSystemRights]::Delete -bor [int][System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [int][System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [int][System.Security.AccessControl.FileSystemRights]::TakeOwnership
    if ($item -eq $paths[0]) { $write = $write -bor [int][System.Security.AccessControl.FileSystemRights]::Write }
    if (([int]$rule.FileSystemRights -band $write) -ne 0 -and $trusted -notcontains $rule.IdentityReference.Value) { exit 3 }
  }
}
Write-Output 'TRUSTED'
`;

/** Read a bounded, unchanged, administrator/current-user-owned local file. */
export async function readTrustedFile(filename: string, maxBytes = 32_000_000): Promise<{ bytes: Buffer; canonicalPath: string }> {
  if (!absolute.safeParse(filename).success || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256_000_000) throw new FusionError('UNTRUSTED_ASSET', 'Trusted file paths and byte limits must be explicit and bounded.');
  const before = await lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) throw new FusionError('UNTRUSTED_ASSET', 'Trusted configuration/code must be a bounded regular file without aliases.');
  const canonicalPath = await realpath(filename);
  const paths = [canonicalPath];
  let parent = path.dirname(canonicalPath);
  for (let depth = 0; ; depth++) {
    if (depth > 64) throw new FusionError('UNTRUSTED_ASSET', 'Trusted path nesting exceeds its limit.');
    paths.push(parent);
    const next = path.dirname(parent); if (next === parent) break; parent = next;
  }
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot || !path.isAbsolute(systemRoot)) throw new FusionError('ACL_UNVERIFIED', 'Windows configuration/code ownership cannot be verified.');
    try {
      const result = await execFileAsync(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_TRUST_CHECK, 'utf16le').toString('base64')], { env: { ...process.env, CODEX_FUSION_TRUST_PATHS: JSON.stringify(paths) }, timeout: 15_000, maxBuffer: 16_384, windowsHide: true });
      if (result.stdout.trim() !== 'TRUSTED') throw new Error('untrusted ACL');
    } catch { throw new FusionError('ACL_UNVERIFIED', 'Configuration/code and its canonical parent paths must be writable only by this user, SYSTEM or administrators. Windows qualification is required.'); }
  } else {
    for (const [index, candidate] of paths.entries()) {
      const info = await lstat(candidate);
      // A root-owned sticky shared directory (e.g. /private/tmp) cannot replace
      // the user-owned child entry checked on the preceding iteration.
      const sharedStickyParent = index > 0 && info.uid === 0 && (info.mode & 0o1000) !== 0;
      if (info.isSymbolicLink() || (index ? !info.isDirectory() : !info.isFile()) || (info.uid !== process.getuid?.() && info.uid !== 0) || ((info.mode & 0o022) !== 0 && !sharedStickyParent)) throw new FusionError('UNTRUSTED_PROFILE', 'Configuration/code and parent paths must be owned by this user or an administrator and not writable by group/others.');
    }
  }
  const handle = await open(canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs || opened.size > maxBytes) throw new FusionError('ASSET_CHANGED', 'Trusted file changed while being opened.');
    const bytes = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < bytes.length) { const result = await handle.read(bytes, length, bytes.length - length, length); if (!result.bytesRead) break; length += result.bytesRead; }
    const after = await handle.stat(), linked = await lstat(canonicalPath);
    if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || after.nlink !== 1 || linked.isSymbolicLink() || linked.dev !== opened.dev || linked.ino !== opened.ino || await realpath(filename) !== canonicalPath) throw new FusionError('ASSET_CHANGED', 'Trusted file changed while its bytes were read.');
    return { bytes: bytes.subarray(0, length), canonicalPath };
  } finally { await handle.close(); }
}

/** Privileged deployment extension, never a model-provided code path. */
export async function verifyTrustedExecutableAsset(asset: { path: string; sha256: string }): Promise<string> {
  if (path.extname(asset.path).toLowerCase() !== '.mjs' || !sha.safeParse(asset.sha256).success) throw new FusionError('UNTRUSTED_ADAPTER', 'Enterprise adapters require an explicit .mjs module and reviewed SHA-256.');
  const result = await readTrustedFile(asset.path);
  if (hashBytes(result.bytes) !== asset.sha256) throw new FusionError('ADAPTER_CHANGED', 'The trusted enterprise adapter bytes changed. Restart and review the exact new module before use.');
  return result.canonicalPath;
}

export function authorize(profile: FusionProfile, operation: string, effect: string, documentId?: string): void {
  if (effect === 'read') {
    if (documentId && profile.policy.readDocuments && !profile.policy.readDocuments.includes(documentId)) throw new FusionError('READ_DOCUMENT_DENIED', 'Document is outside the trusted read scope.');
    return;
  }
  const p = profile.policy;
  if (!p.mutationsEnabled) throw new FusionError('MUTATIONS_DISABLED', 'Mutations are disabled by the active profile.');
  if (p.grantExpiresAt && Date.parse(p.grantExpiresAt) <= Date.now()) throw new FusionError('GRANT_EXPIRED', 'The trusted scoped grant has expired.');
  if (!p.effects.includes(effect as typeof p.effects[number])) throw new FusionError('EFFECT_DENIED', `The profile does not authorize ${effect}.`);
  if (!p.operations.includes(operation) && !(profile.mode === 'fixture' && p.operations.includes('*'))) throw new FusionError('OPERATION_DENIED', `The profile does not authorize ${operation}.`);
  if (documentId && !p.documents.includes(documentId)) throw new FusionError('DOCUMENT_DENIED', 'The document is outside the trusted grant.');
  if (profile.mode === 'managed' && (!p.qualifiedOperations.includes(operation) || !p.qualificationEvidence)) throw new FusionError('QUALIFICATION_REQUIRED', 'Managed writes require operation-specific live qualification evidence in the trusted profile. Use assisted mode only with its disclosed limits.');
}
