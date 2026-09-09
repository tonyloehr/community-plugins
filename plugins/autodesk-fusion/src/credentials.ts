import { createRequire } from 'node:module';
import { constants } from 'node:fs';
import { lstat, readFile, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { StoredApsGrant, TokenStore } from './oauth.js';
import { FusionError, assertJson, hashBytes } from './safety.js';
import { RecordStore, recoverDeadLease } from './storage.js';

export interface CredentialEntry {
  getPassword(signal?: AbortSignal): Promise<string | null | undefined>;
  setPassword(value: string, signal?: AbortSignal): Promise<void>;
  deleteCredential(signal?: AbortSignal): Promise<boolean>;
}
export type CredentialFactory = (service: string, account: string) => CredentialEntry;
export async function nativeCredentialFactory(root: string): Promise<CredentialFactory> {
  const platforms: Record<string, string> = {
    'darwin-arm64': 'darwin-arm64', 'darwin-x64': 'darwin-x64',
    'win32-x64': 'win32-x64-msvc', 'win32-arm64': 'win32-arm64-msvc',
    'linux-x64': 'linux-x64-gnu', 'linux-arm64': 'linux-arm64-gnu'
  };
  const platform = platforms[`${process.platform}-${process.arch}`];
  if (!platform) throw new FusionError('CREDENTIAL_STORE_UNAVAILABLE', 'No bundled native credential provider exists for this platform. Use a separately qualified enterprise TokenStore; plaintext fallback is forbidden.');
  const relative = `native/keyring.${platform}.node`;
  const filename = path.join(root, relative);
  let info;
  try { info = await lstat(filename); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new FusionError('CREDENTIAL_STORE_UNAVAILABLE', 'This package has no admitted native credential module for this host. Install a reviewed build for this platform or use a separately qualified enterprise TokenStore; plaintext fallback is forbidden.');
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 20_000_000) throw new FusionError('CREDENTIAL_STORE_UNAVAILABLE', 'Bundled credential provider failed file validation.');
  const receipt = JSON.parse(await readFile(path.join(root, 'dist', 'build-receipt.json'), 'utf8')) as { files: Record<string, string> };
  if (receipt.files[relative] !== hashBytes(await readFile(filename))) throw new FusionError('PACKAGE_INTEGRITY', 'Native credential provider does not match the package build receipt.');
  try {
    const binding = createRequire(import.meta.url)(filename) as { AsyncEntry: new (service: string, account: string) => CredentialEntry };
    if (typeof binding.AsyncEntry !== 'function') throw new Error('Missing async credential API.');
    return (service, account) => new binding.AsyncEntry(service, account);
  } catch { throw new FusionError('CREDENTIAL_STORE_UNAVAILABLE', 'The OS credential service could not be loaded. No token was written to a plaintext file.'); }
}

interface CredentialManifest { version: 1; generation: string; chunks: number; sha256: string }
interface CredentialCleanupRecord { version: 1; generations: CredentialManifest[] }
export interface CredentialCleanupStatus {
  trackedGenerations: number;
  pendingRetiredGenerations: number;
  currentManifestPresent: boolean;
  containsCredentialContents: false;
}
const MAX_TRACKED_GENERATIONS = 32;
function validManifest(value: unknown): value is CredentialManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as CredentialManifest;
  return Object.keys(item).length === 4 && item.version === 1 && typeof item.generation === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(item.generation) && Number.isSafeInteger(item.chunks) && item.chunks >= 1 && item.chunks <= 128 && typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256);
}
export class NativeTokenStore implements TokenStore {
  readonly service = 'community-plugins.autodesk-fusion.aps.v1';
  private factory?: Promise<CredentialFactory>;
  constructor(private root: string, private suppliedFactory?: CredentialFactory, private options: { lockRoot?: string } = {}) {}
  private async safe<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) {
      const allowed = new Set(['VAULT_LOCKED', 'CREDENTIAL_STORE_CORRUPT', 'CREDENTIAL_STORE_UNAVAILABLE', 'CREDENTIAL_STORE_LIMIT', 'INVALID_CREDENTIAL_REFERENCE', 'PACKAGE_INTEGRITY', 'CREDENTIAL_WRITE_OUTCOME_UNKNOWN', 'CREDENTIAL_CLEANUP_INCOMPLETE', 'CREDENTIAL_STORE_BUSY', 'REAUTHENTICATION_REQUIRED']);
      const code = error instanceof FusionError && allowed.has(error.code) ? error.code : 'CREDENTIAL_STORE_UNAVAILABLE';
      throw new FusionError(code, code === 'CREDENTIAL_STORE_BUSY' ? 'Another process is using this scoped credential grant. Retry after it finishes; refresh credentials were not reused concurrently.' : code === 'REAUTHENTICATION_REQUIRED' ? 'A previous credential refresh has no confirmed replacement grant. Sign in again; its potentially rotated refresh token will not be reused.' : code === 'CREDENTIAL_CLEANUP_INCOMPLETE' ? 'Local credential removal could not be verified. Nonsecret generation receipts were retained where possible; retry logout after the OS vault is accessible. Some entries may already have been removed.' : 'The OS credential operation could not be completed safely. No credential content was logged or returned.', code === 'CREDENTIAL_WRITE_OUTCOME_UNKNOWN' ? 'unknown' : code === 'CREDENTIAL_CLEANUP_INCOMPLETE' ? 'partial' : 'none');
    }
  }
  private grantDirectory(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new FusionError('INVALID_CREDENTIAL_REFERENCE', 'Credential references must be opaque scoped grant hashes.');
    return path.join(this.options.lockRoot ?? path.join(os.homedir(), '.local', 'state', 'codex-fusion', 'credential-locks'), key);
  }
  private async hasRefreshFence(key: string): Promise<boolean> {
    let handle;
    try {
      handle = await open(path.join(this.grantDirectory(key), 'refresh--intent.json'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      return true; // A corrupt or incomplete marker is also uncertainty; never interpret it as permission.
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    finally { await handle?.close(); }
  }
  async markRefreshPending(key: string): Promise<void> {
    return this.safe(async () => {
      const store = new RecordStore(this.grantDirectory(key));
      await store.put('refresh', 'intent', { version: 1, created_at: new Date().toISOString() });
    });
  }
  async clearRefreshPending(key: string): Promise<void> {
    return this.safe(async () => {
      const directory = this.grantDirectory(key);
      try { await unlink(path.join(directory, 'refresh--intent.json')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      if (process.platform !== 'win32') { const handle = await open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
    });
  }
  async withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new FusionError('INVALID_CREDENTIAL_REFERENCE', 'Credential references must be opaque scoped grant hashes.');
    const store = new RecordStore(this.grantDirectory(key));
    let release: () => Promise<void>;
    try { release = await store.acquireLease(); }
    catch (error) {
      if (!(error instanceof FusionError) || error.code !== 'EXECUTION_LOCKED') throw new FusionError('CREDENTIAL_STORE_UNAVAILABLE', 'The credential lease could not be acquired.');
      try { await recoverDeadLease(store.root); release = await store.acquireLease(); }
      catch { throw new FusionError('CREDENTIAL_STORE_BUSY', 'Another process holds this credential grant, or its ownership cannot be proven inactive.'); }
    }
    try { return await action(); }
    finally { await this.safe(release); }
  }
  private async entry(key: string, suffix = ''): Promise<CredentialEntry> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new FusionError('INVALID_CREDENTIAL_REFERENCE', 'Credential references must be opaque scoped grant hashes.');
    this.factory ??= this.suppliedFactory ? Promise.resolve(this.suppliedFactory) : nativeCredentialFactory(this.root);
    return (await this.factory)(this.service, key + suffix);
  }
  private async manifest(key: string): Promise<CredentialManifest | null> {
    const value = await (await this.entry(key)).getPassword(AbortSignal.timeout(30_000));
    if (value === null || value === undefined) return null;
    if (value.length > 1000) throw new FusionError('CREDENTIAL_STORE_CORRUPT', 'Credential metadata exceeds its limit.');
    let parsed: CredentialManifest;
    try { parsed = JSON.parse(value) as CredentialManifest; }
    catch { throw new FusionError('CREDENTIAL_STORE_CORRUPT', 'Credential metadata is not valid JSON.'); }
    if (!validManifest(parsed)) throw new FusionError('CREDENTIAL_STORE_CORRUPT', 'Credential metadata is invalid.');
    return parsed;
  }
  private mergeGenerations(...groups: CredentialManifest[][]): CredentialManifest[] {
    const generations = new Map<string, CredentialManifest>();
    for (const group of groups) for (const manifest of group) {
      if (!validManifest(manifest)) throw new FusionError('CREDENTIAL_STORE_CORRUPT', 'Credential cleanup metadata is invalid.');
      const existing = generations.get(manifest.generation);
      if (existing && (existing.chunks !== manifest.chunks || existing.sha256 !== manifest.sha256)) throw new FusionError('CREDENTIAL_STORE_CORRUPT', 'Credential cleanup generations conflict.');
      generations.set(manifest.generation, manifest);
    }
    if (generations.size > MAX_TRACKED_GENERATIONS) throw new FusionError('CREDENTIAL_STORE_LIMIT', 'Too many unresolved credential generations. Complete local logout before storing another grant.');
    return [...generations.values()];
  }
  private async cleanupGenerations(key: string): Promise<CredentialManifest[]> {
    const record = await new RecordStore(this.grantDirectory(key)).get<CredentialCleanupRecord>('cleanup', 'generations');
    if (record === undefined) return [];
    if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length !== 2 || record.version !== 1 || !Array.isArray(record.generations) || record.generations.length > MAX_TRACKED_GENERATIONS) throw new FusionError('CREDENTIAL_STORE_CORRUPT', 'Credential cleanup receipt is invalid.');
    return this.mergeGenerations(record.generations);
  }
  private async writeCleanupGenerations(key: string, generations: CredentialManifest[]): Promise<void> {
    const directory = this.grantDirectory(key);
    if (generations.length) {
      await new RecordStore(directory).put('cleanup', 'generations', { version: 1, generations: this.mergeGenerations(generations) } satisfies CredentialCleanupRecord);
      return;
    }
    try { await unlink(path.join(directory, 'cleanup--generations.json')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (process.platform !== 'win32') { const handle = await open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
  }
  /** Reports conservative receipts, not a vault enumeration. Contains no grant or native account values. */
  async cleanupStatus(key: string): Promise<CredentialCleanupStatus> {
    return this.safe(async () => {
      const generations = await this.cleanupGenerations(key), current = await this.manifest(key);
      return { trackedGenerations: generations.length, pendingRetiredGenerations: generations.filter(item => item.generation !== current?.generation).length, currentManifestPresent: current !== null, containsCredentialContents: false };
    });
  }
  async get(key: string): Promise<StoredApsGrant | null> {
    return this.safe(async () => {
    if (await this.hasRefreshFence(key)) throw new FusionError('REAUTHENTICATION_REQUIRED', 'A refresh intent has no confirmed replacement grant.');
    const manifest = await this.manifest(key); if (!manifest) return null;
    const chunks: string[] = [];
    for (let i = 0; i < manifest.chunks; i++) {
      const value = await (await this.entry(key, `.${manifest.generation}.${i}`)).getPassword(AbortSignal.timeout(30_000));
      if (!value || value.length > 1000 || !/^[A-Za-z0-9+/=]+$/.test(value)) throw new FusionError('CREDENTIAL_STORE_CORRUPT', 'A credential chunk is absent or invalid. Reauthorize this account.');
      chunks.push(value);
    }
    const bytes = Buffer.from(chunks.join(''), 'base64');
    if (hashBytes(bytes) !== manifest.sha256) throw new FusionError('CREDENTIAL_STORE_CORRUPT', 'Credential integrity check failed.');
    let grant: unknown;
    try { grant = JSON.parse(bytes.toString('utf8')); assertJson(grant, 96_000); }
    catch { throw new FusionError('CREDENTIAL_STORE_CORRUPT', 'Credential payload is invalid.'); }
    if (!grant || typeof grant !== 'object' || Array.isArray(grant)) throw new FusionError('CREDENTIAL_STORE_CORRUPT', 'Credential payload has no grant metadata.');
    return grant as StoredApsGrant;
    });
  }
  async set(key: string, grant: StoredApsGrant): Promise<void> {
    return this.safe(async () => {
    assertJson(grant, 96_000);
    const bytes = Buffer.from(JSON.stringify(grant));
    const encoded = bytes.toString('base64');
    const previous = await this.manifest(key);
    const manifest: CredentialManifest = { version: 1, generation: randomUUID(), chunks: Math.ceil(encoded.length / 1000), sha256: hashBytes(bytes) };
    if (manifest.chunks > 128) throw new FusionError('CREDENTIAL_STORE_LIMIT', 'Credential exceeds the native vault limit.');
    // Persist only generation IDs/counts/hashes before writing any secret chunk. A crash or
    // denied cleanup cannot make attempted generations undiscoverable to a later logout.
    const tracked = this.mergeGenerations(await this.cleanupGenerations(key), previous ? [previous] : [], [manifest]);
    await this.writeCleanupGenerations(key, tracked);
    let published = false, pointerAttempted = false;
    try {
      for (let i = 0; i < manifest.chunks; i++) await (await this.entry(key, `.${manifest.generation}.${i}`)).setPassword(encoded.slice(i * 1000, (i + 1) * 1000), AbortSignal.timeout(30_000));
      pointerAttempted = true;
      await (await this.entry(key)).setPassword(JSON.stringify(manifest), AbortSignal.timeout(30_000));
      published = true;
    } catch (error) {
      if (!pointerAttempted) { await this.removeRetiredBestEffort(key, tracked, [manifest]); throw error; }
      let observed: CredentialManifest | null;
      try { observed = await this.manifest(key); }
      catch { throw new FusionError('CREDENTIAL_WRITE_OUTCOME_UNKNOWN', 'Credential manifest acknowledgement was lost and cannot be reconciled. New chunks are retained in the OS vault.'); }
      if (observed?.generation === manifest.generation && observed.sha256 === manifest.sha256 && observed.chunks === manifest.chunks) published = true;
      else { await this.removeRetiredBestEffort(key, tracked, [manifest]); throw error; }
    }
    if (published) {
      await this.clearRefreshPending(key);
      await this.removeRetiredBestEffort(key, tracked, tracked.filter(item => item.generation !== manifest.generation));
    }
    });
  }
  private async removeEntryStrict(key: string, suffix = ''): Promise<void> {
    try {
      const entry = await this.entry(key, suffix);
      // false is idempotent NoEntry. Backend denial must reject; it must never be
      // represented as NoEntry by the native provider or an enterprise adapter.
      await entry.deleteCredential(AbortSignal.timeout(30_000));
      const observed = await entry.getPassword(AbortSignal.timeout(30_000));
      if (observed !== undefined && observed !== null) throw new Error('Credential remains after deletion.');
    } catch { throw new FusionError('CREDENTIAL_CLEANUP_INCOMPLETE', 'Credential removal was denied or could not be verified.', 'partial'); }
  }
  private async removeChunksStrict(key: string, manifest: CredentialManifest): Promise<void> {
    for (let i = 0; i < manifest.chunks; i++) {
      await this.removeEntryStrict(key, `.${manifest.generation}.${i}`);
    }
  }
  private async removeRetiredBestEffort(key: string, tracked: CredentialManifest[], retired: CredentialManifest[]): Promise<void> {
    const remaining = new Map(tracked.map(item => [item.generation, item]));
    for (const manifest of retired) {
      try { await this.removeChunksStrict(key, manifest); remaining.delete(manifest.generation); }
      catch { /* The already-durable receipt retains exact retry IDs; a published grant remains valid. */ }
    }
    if (remaining.size !== tracked.length) {
      try { await this.writeCleanupGenerations(key, [...remaining.values()]); }
      catch { /* Keep the earlier conservative receipt, including already-removed entries. */ }
    }
  }
  async delete(key: string): Promise<void> {
    return this.safe(async () => {
    const manifest = await this.manifest(key);
    const tracked = this.mergeGenerations(await this.cleanupGenerations(key), manifest ? [manifest] : []);
    await this.writeCleanupGenerations(key, tracked);
    // Keep the current manifest and all nonsecret generation receipts until every
    // known secret chunk is absent. Retry safely encounters NoEntry for prior deletions.
    for (const generation of tracked) await this.removeChunksStrict(key, generation);
    await this.removeEntryStrict(key);
    try { await this.writeCleanupGenerations(key, []); await this.clearRefreshPending(key); }
    catch { throw new FusionError('CREDENTIAL_CLEANUP_INCOMPLETE', 'Credential cleanup receipt could not be finalized.', 'partial'); }
    });
  }
  toJSON() { return { type: 'OS_native_credential_store', service: this.service, plaintext_fallback: false, cleanup: 'strict_verified_logout; best_effort_retired_cleanup_with_durable_nonsecret_receipts' }; }
}
