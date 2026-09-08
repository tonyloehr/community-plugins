import { execFile } from 'node:child_process';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, opendir, readFile, realpath, rename, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { FusionError, assertJson, canonicalJson, hash, hashBytes, newId, now, redact } from './safety.js';

const execFileAsync = promisify(execFile);
const MAX_RECORD_BYTES = 16_777_216;

/** Internal input for retention analysis. Never return record payloads directly through MCP. */
export interface ReadOnlyRecordSnapshotEntry {
  ref: string;
  kind?: string;
  id?: string;
  entry_type: 'file' | 'directory' | 'symlink' | 'other';
  status: 'read' | 'protected' | 'unknown';
  bytes?: number;
  sha256?: string;
  value?: unknown;
  issue?: string;
}
export interface ReadOnlyRecordSnapshot {
  schema_version: 1;
  scope: 'top_level_local_state_records';
  root_hash: string;
  observed_at: string;
  complete: boolean;
  entries: ReadOnlyRecordSnapshotEntry[];
  entry_count_lower_bound: number;
  total_entry_count: number | null;
  issues: string[];
  excluded_subtrees: string[];
}
export interface ReadOnlyRecordSnapshotOptions {
  /** Only these known record kinds are read. All other payloads stay unopened. */
  readKinds: readonly string[];
  maxEntries?: number;
  maxTotalBytes?: number;
  maxDurationMs?: number;
}

function snapshotIdentity(info: BigIntStats): string {
  return hash({ dev: String(info.dev), ino: String(info.ino), size: String(info.size), mtime: String(info.mtimeNs), ctime: String(info.ctimeNs), mode: String(info.mode), uid: String(info.uid), links: String(info.nlink) });
}

async function snapshotRoot(root: string, expected?: BigIntStats): Promise<BigIntStats> {
  if (process.platform === 'win32') return windowsRootIdentity(root, expected);
  const info = await lstat(root, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== BigInt(process.getuid!()) || (info.mode & 0o077n) !== 0n || (expected && !sameIdentity(info, expected)) || await realpath(root) !== root) throw new FusionError('UNSAFE_PATH', 'Storage requires an existing private unchanged directory.');
  await checkPosixAncestors(root);
  return info;
}

async function checkPosixAncestors(directory: string): Promise<void> {
  const uid = BigInt(process.getuid!());
  for (let current = directory; ; current = path.dirname(current)) {
    const info = await lstat(current, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || (info.uid !== uid && info.uid !== 0n)) throw new FusionError('UNSAFE_PATH', 'Storage ancestry must consist of real directories owned by the current user or root.');
    // The sticky bit protects an owned child in shared temporary directories.
    // Without it, a writer to any ancestor can replace the private subtree.
    if ((info.mode & 0o022n) !== 0n && (info.mode & 0o1000n) === 0n) throw new FusionError('UNSAFE_PATH', 'Storage ancestry must not allow other users to replace the private directory.');
    if (current === path.dirname(current)) break;
  }
}

async function readSnapshotRecord(root: string, filename: string, rootIdentity: BigIntStats, expected: BigIntStats): Promise<Buffer> {
  if (process.platform === 'win32') {
    await checkWindowsStorage(root, { file: filename });
    await windowsFileIdentity(filename, MAX_RECORD_BYTES, expected);
  }
  if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1n || expected.size > BigInt(MAX_RECORD_BYTES) || (process.platform !== 'win32' && (expected.uid !== BigInt(process.getuid!()) || (expected.mode & 0o077n) !== 0n))) throw new FusionError('UNSAFE_RECORD', 'Read-only inventory does not read shared, linked or oversized records.');
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (snapshotIdentity(opened) !== snapshotIdentity(expected)) throw new FusionError('SNAPSHOT_CHANGED', 'A record changed while opening.');
    await snapshotRoot(root, rootIdentity);
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < bytes.length) { const result = await handle.read(bytes, length, bytes.length - length, length); if (!result.bytesRead) break; length += result.bytesRead; }
    const after = await handle.stat({ bigint: true }), linked = await lstat(filename, { bigint: true });
    if (length !== Number(opened.size) || snapshotIdentity(after) !== snapshotIdentity(opened) || snapshotIdentity(linked) !== snapshotIdentity(opened) || linked.isSymbolicLink()) throw new FusionError('SNAPSHOT_CHANGED', 'A record changed while reading.');
    await snapshotRoot(root, rootIdentity);
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
// Fixed code only: paths and operation choices are JSON data in the child's
// environment. Do not use ExecutionPolicy bypass or repair an existing ACL.
// The .NET Framework creation overload installs the DACL at creation time:
// https://learn.microsoft.com/dotnet/api/system.io.directory.createdirectory#system-io-directory-createdirectory(system-string-system-security-accesscontrol-directorysecurity)
const WINDOWS_STORAGE_CHECK = String.raw`
$ErrorActionPreference = 'Stop'
$request = ConvertFrom-Json $env:CODEX_FUSION_STORAGE_REQUEST
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$private = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
$ancestors = $private + @('S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$reparse = [System.IO.FileAttributes]::ReparsePoint
$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$inheritOnly = [System.Security.AccessControl.PropagationFlags]::InheritOnly
$noPropagate = [System.Security.AccessControl.PropagationFlags]::NoPropagateInherit
$modify = [int][System.Security.AccessControl.FileSystemRights]::Modify
$replacement = [int][System.Security.AccessControl.FileSystemRights]::Delete -bor [int][System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [int][System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [int][System.Security.AccessControl.FileSystemRights]::TakeOwnership -bor [int][System.Security.AccessControl.FileSystemRights]::WriteData -bor [int][System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor [int][System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes
function Read-StorageItem([string] $name, [bool] $missingAllowed) {
  try { return Get-Item -LiteralPath $name -Force -ErrorAction Stop }
  catch {
    if ($missingAllowed -and $_.CategoryInfo.Category -eq [System.Management.Automation.ErrorCategory]::ObjectNotFound) { return $null }
    throw
  }
}
function Assert-StorageItem($item, [bool] $directory, [bool] $privateAccess) {
  if (($item.Attributes -band $reparse) -ne 0 -or $item.PSIsContainer -ne $directory) { throw 'Unsafe storage object' }
  $acl = Get-Acl -LiteralPath $item.FullName
  $trusted = if ($privateAccess) { $private } else { $ancestors }
  if ($trusted -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { throw 'Untrusted storage owner' }
  $allowCount = 0
  $privateInheritance = $false
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
    $allowCount++
    if ($privateAccess) {
      # Include inherit-only rules: they determine privacy of future records.
      if ($private -notcontains $rule.IdentityReference.Value) { throw 'Shared storage ACL' }
      if ($rule.IdentityReference.Value -eq $sid.Value -and ([int]$rule.FileSystemRights -band $modify) -eq $modify -and ($rule.InheritanceFlags -band $inherit) -eq $inherit -and ($rule.PropagationFlags -band $noPropagate) -eq 0) { $privateInheritance = $true }
    } elseif (($rule.PropagationFlags -band $inheritOnly) -eq 0 -and ([int]$rule.FileSystemRights -band $replacement) -ne 0 -and $ancestors -notcontains $rule.IdentityReference.Value) {
      throw 'Replaceable storage ancestry'
    }
  }
  # Reject a null DACL and a root that cannot privately inherit to new records.
  if ($allowCount -eq 0 -or ($privateAccess -and $directory -and -not $privateInheritance)) { throw 'Unverified storage inheritance' }
}
$root = [System.IO.Path]::GetFullPath([string]$request.root)
$drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($root))
if ($drive.DriveType -eq [System.IO.DriveType]::Network -or $drive.DriveType -eq [System.IO.DriveType]::Unknown -or $drive.DriveType -eq [System.IO.DriveType]::NoRootDirectory) { throw 'Storage requires a verified local drive' }
$paths = [System.Collections.Generic.List[string]]::new()
for ($current = $root; $null -ne $current; $current = [System.IO.Path]::GetDirectoryName($current)) {
  if ($paths.Count -ge 64) { throw 'Storage ancestry limit' }
  $paths.Add($current)
}
for ($index = $paths.Count - 1; $index -ge 0; $index--) {
  $name = $paths[$index]
  $item = Read-StorageItem $name ([bool]$request.create)
  if ($null -eq $item) {
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($identity in $private) {
      $principal = [System.Security.Principal.SecurityIdentifier]::new($identity)
      $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', $inherit, 'None', 'Allow'))
    }
    # Existing directories, including a concurrent creator's directory, are
    # left unchanged by CreateDirectory. The following check must still pass.
    [System.IO.Directory]::CreateDirectory($name, $acl) | Out-Null
    $item = Read-StorageItem $name $false
  }
  Assert-StorageItem $item $true ($index -eq 0)
}
if ($null -ne $request.file) {
  $filename = [System.IO.Path]::GetFullPath([string]$request.file)
  if (-not [string]::Equals([System.IO.Path]::GetDirectoryName($filename), $root, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Storage file escaped root' }
  $item = Read-StorageItem $filename ([bool]$request.missingAllowed)
  if ($null -ne $item) { Assert-StorageItem $item $false $true }
}
Write-Output 'PRIVATE'
`;

function windowsLocalPath(filename: string): string {
  if (filename.length > 4096 || !/^[a-z]:[\\/]/iu.test(filename) || /[\x00-\x1f<>"|?*]/u.test(filename) || filename.slice(2).includes(':')) throw new FusionError('UNSAFE_PATH', 'Windows storage requires an explicit local drive path without device, network or alternate-stream aliases.');
  const segments = filename.slice(3).split(/[\\/]/u);
  if (segments.some(segment => segment === '.' || segment === '..' || /[ .]$/u.test(segment) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(segment))) throw new FusionError('UNSAFE_PATH', 'Windows storage paths cannot contain ambiguous or reserved components.');
  return path.win32.normalize(filename);
}

async function checkWindowsStorage(root: string, options: { create?: boolean; file?: string; missingAllowed?: boolean } = {}): Promise<void> {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw new FusionError('ACL_UNVERIFIED', 'Cannot locate Windows storage ACL verification.');
  const request = { root: windowsLocalPath(root), ...options, ...(options.file ? { file: windowsLocalPath(options.file) } : {}) };
  try {
    const result = await execFileAsync(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_STORAGE_CHECK, 'utf16le').toString('base64')], { env: { ...process.env, CODEX_FUSION_STORAGE_REQUEST: JSON.stringify(request) }, timeout: 15_000, maxBuffer: 16_384, windowsHide: true });
    if (result.stdout.trim() !== 'PRIVATE') throw new Error('Unverified ACL');
  } catch (error) {
    const failure = error as { code?: string | number; killed?: boolean };
    // Keep subprocess status useful for diagnosing startup failures, without
    // returning PowerShell source, paths, environment values or stderr.
    const status = failure.killed ? 'verification_process_terminated' : typeof failure.code === 'number' ? 'verification_process_failed' : failure.code === 'ENOENT' ? 'verification_process_unavailable' : 'verification_failed';
    throw new FusionError('ACL_UNVERIFIED', 'Windows storage must be private to the current user, SYSTEM and administrators, with no reparse points or replaceable ancestors. Existing shared paths are never repermissioned.', 'none', { verification_status: status });
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean { return left.dev === right.dev && left.ino === right.ino; }
async function windowsRootIdentity(root: string, expected?: BigIntStats): Promise<BigIntStats> {
  const info = await lstat(root, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || (expected && !sameIdentity(info, expected)) || windowsLocalPath(await realpath(root)).toLowerCase() !== windowsLocalPath(root).toLowerCase()) throw new FusionError('UNSAFE_PATH', 'The pinned Windows storage root changed or became an alias.');
  return info;
}
async function windowsFileIdentity(filename: string, maximum: number, expected?: BigIntStats): Promise<BigIntStats> {
  const info = await lstat(filename, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > BigInt(maximum) || (expected && !sameIdentity(info, expected)) || windowsLocalPath(await realpath(filename)).toLowerCase() !== windowsLocalPath(filename).toLowerCase()) throw new FusionError('UNSAFE_RECORD', 'Windows state files must be bounded ordinary private files without links or aliases.');
  return info;
}
async function readWindowsStateFile(root: string, filename: string, rootIdentity: BigIntStats, maximum: number): Promise<string> {
  const before = await windowsFileIdentity(filename, maximum);
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameIdentity(before, opened) || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs) throw new FusionError('UNSAFE_RECORD', 'Windows state file changed while opening.');
    await windowsRootIdentity(root, rootIdentity);
    const buffer = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < buffer.length) { const result = await handle.read(buffer, length, buffer.length - length, length); if (!result.bytesRead) break; length += result.bytesRead; }
    const after = await handle.stat({ bigint: true });
    await windowsFileIdentity(filename, maximum, opened); await windowsRootIdentity(root, rootIdentity);
    if (length !== Number(opened.size) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs || after.nlink !== 1n) throw new FusionError('UNSAFE_RECORD', 'Windows state file changed while reading.');
    return buffer.subarray(0, length).toString('utf8');
  } finally { await handle.close(); }
}

export async function ensurePrivateDirectory(directory: string): Promise<string> {
  if (!path.isAbsolute(directory)) throw new FusionError('UNSAFE_PATH', 'Storage root must be absolute.');
  if (process.platform === 'win32') {
    const root = windowsLocalPath(directory);
    await checkWindowsStorage(root, { create: true });
    await windowsRootIdentity(root);
    return realpath(root);
  }
  // Resolve existing parent aliases once, and validate before creating anything
  // beneath them. Later operations use this canonical path and pinned identity.
  let existing = directory;
  const missing: string[] = [];
  for (;;) {
    try {
      const info = await lstat(existing);
      if (!missing.length && info.isSymbolicLink()) throw new FusionError('UNSAFE_PATH', 'Storage root must be a real directory.');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing.unshift(path.basename(existing)); existing = path.dirname(existing);
    }
  }
  const ancestor = await realpath(existing);
  await checkPosixAncestors(ancestor);
  const root = path.join(ancestor, ...missing);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await snapshotRoot(root);
  return root;
}

export class RecordStore {
  root: string;
  private ready?: Promise<void>;
  private windowsRoot?: BigIntStats;
  private posixRoot?: BigIntStats;
  constructor(root: string) { this.root = root; }
  async init(): Promise<void> {
    this.ready ??= (async () => { this.root = await ensurePrivateDirectory(this.root); if (process.platform === 'win32') this.windowsRoot = await windowsRootIdentity(this.root); else this.posixRoot = await snapshotRoot(this.root); })();
    return this.ready;
  }
  private async checkStorage(file?: string, missingAllowed = false): Promise<void> {
    if (process.platform !== 'win32') { await snapshotRoot(this.root, this.posixRoot); return; }
    await checkWindowsStorage(this.root, { ...(file ? { file } : {}), missingAllowed });
    await windowsRootIdentity(this.root, this.windowsRoot);
    if (file) {
      try { await windowsFileIdentity(file, MAX_RECORD_BYTES); }
      catch (error) { if (!missingAllowed || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  private async removeOwnedTemporary(filename: string, created?: BigIntStats): Promise<void> {
    if (process.platform !== 'win32') await snapshotRoot(this.root, this.posixRoot);
    if (process.platform === 'win32') {
      if (!created) return;
      await this.checkStorage(filename); await windowsFileIdentity(filename, MAX_RECORD_BYTES, created);
    }
    await unlink(filename);
  }
  private filename(kind: string, id: string): string {
    if (!/^[a-z][a-z0-9_-]{0,40}$/.test(kind) || !/^[a-zA-Z0-9_-]{1,120}$/.test(id)) throw new FusionError('INVALID_REFERENCE', 'Invalid record reference.');
    return path.join(this.root, `${kind}--${id}.json`);
  }
  async get<T>(kind: string, id: string): Promise<T | undefined> {
    await this.init();
    const filename = this.filename(kind, id);
    await this.checkStorage(filename, true);
    let handle;
    try {
      if (process.platform === 'win32') {
        const value: unknown = JSON.parse(await readWindowsStateFile(this.root, filename, this.windowsRoot!, MAX_RECORD_BYTES));
        assertJson(value, MAX_RECORD_BYTES); return value as T;
      }
      handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_RECORD_BYTES || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0) throw new FusionError('UNSAFE_RECORD', 'Stored record failed file validation.');
      await snapshotRoot(this.root, this.posixRoot);
      const value: unknown = JSON.parse(await handle.readFile('utf8'));
      await snapshotRoot(this.root, this.posixRoot);
      assertJson(value, MAX_RECORD_BYTES); return value as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { await this.checkStorage(); return undefined; }
      throw error;
    } finally { await handle?.close(); }
  }
  async put(kind: string, id: string, value: unknown): Promise<void> {
    assertJson(value, MAX_RECORD_BYTES);
    const encoded = Buffer.from(canonicalJson(value) + '\n', 'utf8');
    if (encoded.length > MAX_RECORD_BYTES) throw new FusionError('RECORD_TOO_LARGE', 'The complete stored record exceeds its byte limit.');
    await this.init();
    const destination = this.filename(kind, id);
    const temporary = this.filename('tmp', newId('record'));
    await this.checkStorage(destination, true);
    const file = await open(temporary, 'wx', 0o600);
    let created: BigIntStats | undefined;
    try {
      if (process.platform === 'win32') {
        created = await file.stat({ bigint: true });
        await windowsFileIdentity(temporary, MAX_RECORD_BYTES, created); await windowsRootIdentity(this.root, this.windowsRoot);
      } else await snapshotRoot(this.root, this.posixRoot);
      await file.writeFile(encoded); await file.sync();
    } catch (error) { await file.close(); await this.removeOwnedTemporary(temporary, created).catch(() => undefined); throw error; }
    await file.close();
    try {
      await this.checkStorage(destination, true);
      await rename(temporary, destination);
      if (created) await windowsFileIdentity(destination, MAX_RECORD_BYTES, created);
      else await snapshotRoot(this.root, this.posixRoot);
    } catch (error) { await this.removeOwnedTemporary(temporary, created).catch(() => undefined); throw error; }
    // fsync directory entries where the platform supports it.
    if (process.platform !== 'win32') { const dir = await open(this.root, 'r'); try { await dir.sync(); } finally { await dir.close(); } }
  }
  async list<T>(kind: string): Promise<T[]> {
    await this.init();
    await this.checkStorage();
    const files = (await readdir(this.root)).filter(n => n.startsWith(`${kind}--`) && n.endsWith('.json')).sort();
    if (files.length > 10_000) throw new FusionError('STORE_LIMIT', 'Archive old records before continuing.');
    const values: T[] = [];
    for (const name of files) { const value = await this.get<T>(kind, name.slice(kind.length + 2, -5)); if (value) values.push(value); }
    return values;
  }
  /** Observes existing top-level ledger records only; never initializes, repairs or removes storage. */
  async snapshotReadOnly(options: ReadOnlyRecordSnapshotOptions): Promise<ReadOnlyRecordSnapshot> {
    const maxEntries = options.maxEntries ?? 10_000, maxTotalBytes = options.maxTotalBytes ?? 67_108_864, maxDurationMs = options.maxDurationMs ?? 30_000;
    if (!Array.isArray(options.readKinds) || options.readKinds.length > 64 || options.readKinds.some(kind => !/^[a-z][a-z0-9_-]{0,40}$/.test(kind)) || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000 || !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1 || maxTotalBytes > 268_435_456 || !Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 60_000) throw new FusionError('INVALID_SNAPSHOT_LIMIT', 'Read-only inventory requires bounded explicit record kinds and limits.');
    const result: ReadOnlyRecordSnapshot = { schema_version: 1, scope: 'top_level_local_state_records', root_hash: hash(this.root), observed_at: now(), complete: true, entries: [], entry_count_lower_bound: 0, total_entry_count: null, issues: [], excluded_subtrees: [] };
    const issue = (code: string): void => { result.complete = false; if (!result.issues.includes(code)) result.issues.push(code); };
    const deadline = Date.now() + maxDurationMs, kinds = new Set(options.readKinds);
    let root: string, rootIdentity: BigIntStats;
    try {
      if (!path.isAbsolute(this.root)) throw new Error('absolute root required');
      const named = await lstat(this.root, { bigint: true });
      if (named.isSymbolicLink() || !named.isDirectory()) throw new Error('ordinary root required');
      root = await realpath(this.root);
      if (root.split(/[\\/]/u).some(part => ['credential-locks', 'native-credentials'].includes(part.toLowerCase()))) {
        issue('CREDENTIAL_OR_NATIVE_ROOT_EXCLUDED'); return result;
      }
      if (process.platform === 'win32') await checkWindowsStorage(root);
      rootIdentity = await snapshotRoot(root, this.windowsRoot ?? this.posixRoot);
      if (!sameIdentity(named, rootIdentity)) throw new Error('root changed');
      result.root_hash = hash({ path: root, dev: String(rootIdentity.dev), ino: String(rootIdentity.ino) });
    } catch { issue('ROOT_UNAVAILABLE_OR_UNSAFE'); return result; }

    const enumerate = async (): Promise<{ names: string[]; complete: boolean }> => {
      const names: string[] = [];
      const directory = await opendir(root);
      for await (const entry of directory) {
        names.push(entry.name);
        if (names.length > maxEntries) return { names, complete: false };
        if (Date.now() > deadline) return { names, complete: false };
      }
      names.sort(); return { names, complete: true };
    };
    const identities = new Map<string, string>();
    let names: string[] = [], totalBytes = 0;
    try {
      const first = await enumerate(); names = first.names;
      result.entry_count_lower_bound = names.length;
      if (!first.complete) issue(Date.now() > deadline ? 'SNAPSHOT_TIME_LIMIT' : 'SNAPSHOT_ENTRY_LIMIT');
      else result.total_entry_count = names.length;
      for (const name of names.slice(0, maxEntries)) {
        const entry: ReadOnlyRecordSnapshotEntry = { ref: `entry:${hash(name)}`, entry_type: 'other', status: 'unknown' };
        result.entries.push(entry);
        if (Date.now() > deadline) { entry.issue = 'SNAPSHOT_TIME_LIMIT'; issue(entry.issue); continue; }
        const filename = path.join(root, name);
        try {
          const info = await lstat(filename, { bigint: true });
          identities.set(name, snapshotIdentity(info));
          entry.entry_type = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other';
          if (info.size <= BigInt(Number.MAX_SAFE_INTEGER)) entry.bytes = Number(info.size);
          if (name === 'credential-locks' && entry.entry_type === 'directory') {
            entry.status = 'protected'; entry.issue = 'CREDENTIAL_SUBTREE_EXCLUDED'; result.excluded_subtrees.push('credential-locks'); continue;
          }
          if (name === '.execution.lock') { entry.status = 'protected'; entry.issue = 'EXECUTION_LOCK_PRESENT'; issue(entry.issue); continue; }
          const match = /^([a-z][a-z0-9_-]{0,40})--([a-zA-Z0-9_-]{1,120})\.json$/u.exec(name);
          if (!match || !kinds.has(match[1]!)) { entry.issue = 'UNKNOWN_ENTRY_NOT_READ'; issue(entry.issue); continue; }
          entry.kind = match[1]!; entry.id = match[2]!;
          if (entry.entry_type !== 'file' || info.nlink !== 1n || (process.platform !== 'win32' && (info.uid !== BigInt(process.getuid!()) || (info.mode & 0o077n) !== 0n))) { entry.issue = 'UNSAFE_RECORD_TYPE_OR_ACCESS'; issue(entry.issue); continue; }
          if (['refresh', 'cleanup', 'fixture'].includes(entry.kind)) { entry.status = 'protected'; entry.issue = 'RUNTIME_STATE_NOT_READ'; continue; }
          if (entry.kind === 'tmp') { entry.status = 'protected'; entry.issue = 'UNFINISHED_WRITE_RECORD'; issue(entry.issue); continue; }
          if (entry.entry_type !== 'file' || info.size > BigInt(MAX_RECORD_BYTES) || totalBytes + Number(info.size) > maxTotalBytes) { entry.issue = entry.entry_type !== 'file' ? 'UNSAFE_RECORD_TYPE' : 'SNAPSHOT_BYTE_LIMIT'; issue(entry.issue); continue; }
          totalBytes += Number(info.size);
          const bytes = await readSnapshotRecord(root, filename, rootIdentity, info);
          entry.sha256 = hashBytes(bytes); entry.bytes = bytes.length;
          try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            const value: unknown = JSON.parse(text); assertJson(value, MAX_RECORD_BYTES);
            entry.value = value; entry.status = 'read';
          } catch { entry.issue = 'INVALID_RECORD_JSON'; issue(entry.issue); }
        } catch { entry.issue = 'RECORD_UNAVAILABLE_UNSAFE_OR_CHANGED'; issue(entry.issue); }
      }
      const last = await enumerate();
      if (!last.complete || first.complete !== last.complete || JSON.stringify(names) !== JSON.stringify(last.names)) {
        result.entry_count_lower_bound = Math.max(result.entry_count_lower_bound, last.names.length);
        result.total_entry_count = null;
        issue('SNAPSHOT_DIRECTORY_CHANGED_OR_INCOMPLETE');
      }
      for (const [name, expected] of identities) {
        if (Date.now() > deadline) { issue('SNAPSHOT_TIME_LIMIT'); break; }
        try { if (snapshotIdentity(await lstat(path.join(root, name), { bigint: true })) !== expected) issue('SNAPSHOT_RECORD_CHANGED'); }
        catch { issue('SNAPSHOT_RECORD_CHANGED'); }
      }
      if (process.platform === 'win32') await checkWindowsStorage(root);
      const after = await snapshotRoot(root, rootIdentity);
      if (snapshotIdentity(after) !== snapshotIdentity(rootIdentity) || await realpath(this.root) !== root) { result.total_entry_count = null; issue('SNAPSHOT_ROOT_CHANGED'); }
    } catch { result.total_entry_count = null; issue('SNAPSHOT_UNAVAILABLE_OR_CHANGED'); }
    result.entries.sort((left, right) => left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0);
    result.issues.sort(); result.excluded_subtrees.sort();
    return result;
  }
  async acquireLease(): Promise<() => Promise<void>> {
    await this.init();
    const filename = path.join(this.root, '.execution.lock');
    await this.checkStorage(filename, true);
    let file;
    try { file = await open(filename, 'wx', 0o600); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new FusionError('EXECUTION_LOCKED', 'Another process holds this profile. If it crashed, use fusionctl recover-lock after verifying that it has stopped.');
      throw error;
    }
    let created: BigIntStats | undefined;
    try {
      if (process.platform === 'win32') created = await file.stat({ bigint: true });
      if (created) { await windowsFileIdentity(filename, 4096, created); await windowsRootIdentity(this.root, this.windowsRoot); }
      else await snapshotRoot(this.root, this.posixRoot);
      await file.writeFile(JSON.stringify({ pid: process.pid, created_at: now() })); await file.sync();
    } catch (error) {
      await file.close();
      if (process.platform === 'win32') await this.removeOwnedTemporary(filename, created).catch(() => undefined);
      throw error;
    }
    await file.close();
    return async () => {
      if (created) { await this.checkStorage(filename); await windowsFileIdentity(filename, 4096, created); }
      else await this.checkStorage();
      await unlink(filename);
    };
  }
  async audit(event: string, details: unknown): Promise<void> {
    const id = newId('event');
    await this.put('audit', id, { id, event, time: now(), details: redact(details), integrity: hash(redact(details)) });
  }
}

export async function recoverDeadLease(root: string): Promise<void> {
  const directory = await ensurePrivateDirectory(root);
  const filename = path.join(directory, '.execution.lock');
  const windowsRoot = process.platform === 'win32' ? await windowsRootIdentity(directory) : undefined;
  if (windowsRoot) await checkWindowsStorage(directory, { file: filename });
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new FusionError('UNSAFE_RECORD', 'Invalid execution lock.');
  const windowsFile = windowsRoot ? await windowsFileIdentity(filename, 4096) : undefined;
  const contents = windowsRoot ? await readWindowsStateFile(directory, filename, windowsRoot, 4096) : await readFile(filename, 'utf8');
  const { pid } = JSON.parse(contents) as { pid: number };
  if (!Number.isSafeInteger(pid) || pid < 1) throw new FusionError('INVALID_LOCK', 'Cannot prove this lock owner stopped.');
  try { process.kill(pid, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      if (windowsRoot) { await checkWindowsStorage(directory, { file: filename }); await windowsRootIdentity(directory, windowsRoot); await windowsFileIdentity(filename, 4096, windowsFile); }
      await unlink(filename); return;
    }
    throw new FusionError('LOCK_OWNER_UNKNOWN', 'Cannot prove this lock owner stopped.');
  }
  throw new FusionError('LOCK_OWNER_RUNNING', 'The lock owner is still running; it has not been disturbed.');
}
