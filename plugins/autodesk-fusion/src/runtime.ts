import { lstat, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FusionEngine, createFixtureEngine } from './engine.js';
import { CloudCoordinator, type EnterpriseCloudServices } from './cloud-coordinator.js';
import { NativeFusionClient } from './native.js';
import { AddinDesktopProvider } from './addin.js';
import { loadProfile, verifyTrustedExecutableAsset, type FusionProfile } from './profile.js';
import { FusionError, hash, hashBytes } from './safety.js';
import type { DesktopProvider, DesktopRequest, DesktopResponse } from './types.js';

export async function pluginRoot(start = path.dirname(fileURLToPath(import.meta.url))): Promise<string> {
  let directory = start;
  for (let depth = 0; depth < 6; depth++) {
    try { const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')); if (pkg.name === '@community-plugins/autodesk-fusion') return directory; } catch { /* Resolve through a bundled chunk or source folder. */ }
    const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
  }
  throw new FusionError('PACKAGE_INCOMPLETE', 'Cannot locate the installed Autodesk Fusion plugin root.');
}
class DisconnectedDesktop implements DesktopProvider {
  async dispatch(_request: DesktopRequest): Promise<DesktopResponse> {
    return { ok: false, error: { code: 'DESKTOP_NOT_CONFIGURED', message: 'Configure and enroll the exact Fusion desktop endpoint; no endpoint scanning or guessed native tool names is performed.', outcome: 'none' } };
  }
}
export interface Runtime {
  profile: FusionProfile;
  engine: FusionEngine;
  native?: NativeFusionClient;
  cloud?: CloudCoordinator;
  root: string;
  close(): Promise<void>;
}
export async function installedExecutionContract(root: string): Promise<{ executionContractHash: string; executionContractFiles: { path: string; sha256: string }[] }> {
  const receiptFile = path.join(root, 'dist', 'build-receipt.json');
  const receiptInfo = await lstat(receiptFile);
  if (!receiptInfo.isFile() || receiptInfo.isSymbolicLink() || receiptInfo.size > 2_097_152) throw new FusionError('PACKAGE_INTEGRITY', 'Invalid execution build receipt.');
  const receipt = JSON.parse(await readFile(receiptFile, 'utf8')) as { schema: number; files: Record<string, string> };
  if (receipt.schema !== 1 || !receipt.files || typeof receipt.files !== 'object') throw new FusionError('PACKAGE_INTEGRITY', 'Unsupported build receipt schema.');
  const entries = Object.entries(receipt.files).filter(([name]) => /^dist\/[A-Za-z0-9._-]+\.mjs$/.test(name)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (entries.length < 3 || entries.length > 100 || !['dist/index.mjs', 'dist/server.mjs', 'dist/cli.mjs'].every(name => entries.some(([entry]) => entry === name))) throw new FusionError('PACKAGE_INTEGRITY', 'Execution receipt is missing the required entry points.');
  const files: { path: string; sha256: string }[] = [];
  for (const [relative, sha256] of entries) {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new FusionError('PACKAGE_INTEGRITY', 'Invalid code checksum.');
    const filename = path.join(root, relative), info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32_000_000 || hashBytes(await readFile(filename)) !== sha256) throw new FusionError('PACKAGE_INTEGRITY', 'Installed JavaScript differs from its build receipt. Reinstall a reviewed package.');
    files.push({ path: filename, sha256 });
  }
  return { executionContractHash: hash(Object.fromEntries(entries)), executionContractFiles: files };
}
export async function loadEnterpriseServices(profile: FusionProfile): Promise<{ enterpriseServices: EnterpriseCloudServices; verifyEnterpriseAdapter: () => Promise<void> } | undefined> {
  const descriptor = profile.cloud?.enterpriseAdapter;
  if (!descriptor) return undefined;
  let canonicalModulePath = '';
  const verifyEnterpriseAdapter = async (): Promise<void> => {
    canonicalModulePath = await verifyTrustedExecutableAsset(descriptor);
    if ((await lstat(canonicalModulePath)).size > 2_097_152) throw new FusionError('UNTRUSTED_ENTERPRISE_ADAPTER', 'Enterprise module exceeds the 2 MiB deployment limit.');
  };
  await verifyEnterpriseAdapter();
  const moduleUrl = pathToFileURL(canonicalModulePath); moduleUrl.searchParams.set('sha256', descriptor.sha256);
  const module = await import(moduleUrl.href) as { createFusionCloudServices?: (context: unknown) => Promise<EnterpriseCloudServices> };
  if (typeof module.createFusionCloudServices !== 'function') throw new FusionError('INVALID_ENTERPRISE_ADAPTER', 'Module must export createFusionCloudServices.');
  const cloud = profile.cloud!;
  const scope = { tenantId: cloud.tenantId, hubIds: cloud.hubIds, projects: cloud.projects, mfgModels: cloud.mfgModels, ...(cloud.manage ? { manage: cloud.manage } : {}) };
  const services = await module.createFusionCloudServices(structuredClone({ profileId: profile.id, scope }));
  await verifyEnterpriseAdapter();
  return { enterpriseServices: services, verifyEnterpriseAdapter };
}
export async function createRuntime(profileFile = process.env.FUSION_PROFILE): Promise<Runtime> {
  const root = await pluginRoot();
  const contract = await installedExecutionContract(root);
  const profile = await loadProfile(profileFile);
  if (profile.mode === 'fixture') {
    const engine = await createFixtureEngine(profile, contract);
    return { profile, engine, root, close: () => engine.close() };
  }
  const handlerFile = path.join(root, 'handlers', 'fusion_runtime.py');
  const info = await stat(handlerFile);
  if (!info.isFile() || info.size > 2_000_000) throw new FusionError('PACKAGE_INCOMPLETE', 'Reviewed desktop handlers are absent or exceed the package limit.');
  const handlerSource = await readFile(handlerFile, 'utf8');
  const native = profile.desktop?.provider === 'native' ? new NativeFusionClient({ url: profile.desktop.url, ...(profile.desktop.mapping ? { mapping: profile.desktop.mapping } : {}), handlerSource, timeoutMs: profile.desktop.timeoutMs }) : undefined;
  const addin = profile.desktop?.provider === 'addin' ? new AddinDesktopProvider({ url: profile.desktop.url, tokenFile: profile.desktop.tokenFile!, handlerHash: hashBytes(handlerSource), timeoutMs: profile.desktop.timeoutMs }) : undefined;
  const engine = new FusionEngine(profile, native ?? addin ?? new DisconnectedDesktop(), hashBytes(handlerSource), { ...(profileFile ? { profileFile } : {}), handlerFile, ...contract });
  await engine.init();
  const enterprise = await loadEnterpriseServices(profile);
  const cloud = profile.cloud ? await CloudCoordinator.create({ profile, ...(profileFile ? { profileFile } : {}), root, store: engine.store, ...enterprise }) : undefined;
  return { profile, engine, ...(native ? { native } : {}), ...(cloud ? { cloud } : {}), root, close: () => engine.close() };
}
