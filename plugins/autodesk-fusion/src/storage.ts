import { execFile } from 'node:child_process';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { FusionError, assertJson, canonicalJson, hash, newId, now, redact } from './safety.js';

const execFileAsync = promisify(execFile);
const MAX_RECORD_BYTES = 16_777_216;
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
  } catch {
    throw new FusionError('ACL_UNVERIFIED', 'Windows storage must be private to the current user, SYSTEM and administrators, with no reparse points or replaceable ancestors. Existing shared paths are never repermissioned.');
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
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new FusionError('UNSAFE_PATH', 'Storage root must be a real directory.');
  if (stat.uid !== process.getuid?.()) throw new FusionError('UNSAFE_PATH', 'Storage root must belong to the current user.');
  if (stat.mode & 0o077) throw new FusionError('UNSAFE_PATH', 'Use a private directory (mode 0700). Existing shared directories are not silently repermissioned.');
  // Parent symlinks are resolved once; all subsequent paths stay under the pinned root.
  return realpath(directory);
}

export class RecordStore {
  root: string;
  private ready?: Promise<void>;
  private windowsRoot?: BigIntStats;
  constructor(root: string) { this.root = root; }
  async init(): Promise<void> {
    this.ready ??= (async () => { this.root = await ensurePrivateDirectory(this.root); if (process.platform === 'win32') this.windowsRoot = await windowsRootIdentity(this.root); })();
    return this.ready;
  }
  private async checkWindows(file?: string, missingAllowed = false): Promise<void> {
    if (process.platform !== 'win32') return;
    await checkWindowsStorage(this.root, { ...(file ? { file } : {}), missingAllowed });
    await windowsRootIdentity(this.root, this.windowsRoot);
    if (file) {
      try { await windowsFileIdentity(file, MAX_RECORD_BYTES); }
      catch (error) { if (!missingAllowed || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  private async removeOwnedTemporary(filename: string, created?: BigIntStats): Promise<void> {
    if (process.platform === 'win32') {
      if (!created) return;
      await this.checkWindows(filename); await windowsFileIdentity(filename, MAX_RECORD_BYTES, created);
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
    let handle;
    try {
      if (process.platform === 'win32') {
        await this.checkWindows(filename, true);
        const value: unknown = JSON.parse(await readWindowsStateFile(this.root, filename, this.windowsRoot!, MAX_RECORD_BYTES));
        assertJson(value, MAX_RECORD_BYTES); return value as T;
      }
      handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 16_777_216) throw new FusionError('UNSAFE_RECORD', 'Stored record failed file validation.');
      const value: unknown = JSON.parse(await handle.readFile('utf8')); assertJson(value, 16_777_216); return value as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
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
    await this.checkWindows(destination, true);
    const file = await open(temporary, 'wx', 0o600);
    let created: BigIntStats | undefined;
    try {
      if (process.platform === 'win32') {
        created = await file.stat({ bigint: true });
        await windowsFileIdentity(temporary, MAX_RECORD_BYTES, created); await windowsRootIdentity(this.root, this.windowsRoot);
      }
      await file.writeFile(encoded); await file.sync();
    } catch (error) { await file.close(); await this.removeOwnedTemporary(temporary, created).catch(() => undefined); throw error; }
    await file.close();
    try {
      await this.checkWindows(destination, true);
      await rename(temporary, destination);
      if (created) await windowsFileIdentity(destination, MAX_RECORD_BYTES, created);
    } catch (error) { await this.removeOwnedTemporary(temporary, created).catch(() => undefined); throw error; }
    // fsync directory entries where the platform supports it.
    if (process.platform !== 'win32') { const dir = await open(this.root, 'r'); try { await dir.sync(); } finally { await dir.close(); } }
  }
  async list<T>(kind: string): Promise<T[]> {
    await this.init();
    await this.checkWindows();
    const files = (await readdir(this.root)).filter(n => n.startsWith(`${kind}--`) && n.endsWith('.json')).sort();
    if (files.length > 10_000) throw new FusionError('STORE_LIMIT', 'Archive old records before continuing.');
    const values: T[] = [];
    for (const name of files) { const value = await this.get<T>(kind, name.slice(kind.length + 2, -5)); if (value) values.push(value); }
    return values;
  }
  async acquireLease(): Promise<() => Promise<void>> {
    await this.init();
    const filename = path.join(this.root, '.execution.lock');
    await this.checkWindows(filename, true);
    let file;
    try { file = await open(filename, 'wx', 0o600); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new FusionError('EXECUTION_LOCKED', 'Another process holds this profile. If it crashed, use fusionctl recover-lock after verifying that it has stopped.');
      throw error;
    }
    let created: BigIntStats | undefined;
    try {
      if (process.platform === 'win32') created = await file.stat({ bigint: true });
      if (created) { await windowsFileIdentity(filename, 4096, created); await windowsRootIdentity(this.root, this.windowsRoot); }
      await file.writeFile(JSON.stringify({ pid: process.pid, created_at: now() })); await file.sync();
    } catch (error) {
      await file.close();
      if (process.platform === 'win32') await this.removeOwnedTemporary(filename, created).catch(() => undefined);
      throw error;
    }
    await file.close();
    return async () => {
      if (created) { await this.checkWindows(filename); await windowsFileIdentity(filename, 4096, created); }
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
