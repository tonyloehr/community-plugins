import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { FusionProfile } from './profile.js';
import { FusionError, hash, hashBytes, newId, now } from './safety.js';
import { ensurePrivateDirectory, RecordStore } from './storage.js';

export interface ArtifactReservation {
  id: string; root: string; filename: string; format: string;
  directory: string; path: string; status: 'prepared' | 'generating' | 'succeeded' | 'pending' | 'failed';
  created_at: string; plan_id?: string; files?: ArtifactFile[]; limitation?: string;
  producer_plan_hash?: string; completed_at?: string; manifest_sha256?: string;
}
export interface ArtifactFile { name: string; size: number; sha256: string; media_type: string; checks: string[] }

export function validateFilename(filename: string): string {
  if (!/^[\p{L}\p{N}][\p{L}\p{N}\p{M}._ -]{0,159}$/u.test(filename) || filename !== filename.normalize('NFC') || filename.endsWith('.') || filename.endsWith(' ') || filename.includes('..') || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(filename)) throw new FusionError('UNSAFE_PATH', 'Use a simple NFC filename without separators, traversal, device names, trailing dots or trailing spaces.');
  return filename;
}
export async function readPinnedAsset(asset: { path: string; sha256: string }, maxBytes = 32_000_000): Promise<string> {
  if (!path.isAbsolute(asset.path) || asset.path.includes('\0') || /^[/\\]{2}/u.test(asset.path) || !/^[a-f0-9]{64}$/u.test(asset.sha256)) throw new FusionError('UNSAFE_ASSET', 'Asset path must be absolute and local, with an explicit SHA-256.');
  const canonical = await realpath(asset.path);
  const bytes = await boundedFile(asset.path, maxBytes, 'asset');
  if (hashBytes(bytes) !== asset.sha256 || await realpath(asset.path) !== canonical) throw new FusionError('ASSET_CHANGED', 'Reviewed asset bytes or path changed; requalification is required.');
  return canonical;
}

async function boundedFile(filename: string, maxBytes: number, kind: 'asset' | 'artifact'): Promise<Buffer> {
  const outcome = kind === 'artifact' ? 'partial' : 'none';
  const code = kind === 'artifact' ? 'UNSAFE_ARTIFACT' : 'UNSAFE_ASSET';
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256_000_000) throw new FusionError(code, 'File byte limit is invalid.', outcome);
  const info = await lstat(filename);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || info.size > maxBytes) throw new FusionError(code, 'File must be a bounded regular file without aliases.', outcome);
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size || opened.mtimeMs !== info.mtimeMs) throw new FusionError('ASSET_CHANGED', 'File changed while being opened.', outcome);
    // Allocate at most the observed, already bounded size plus one byte. An
    // extending producer cannot make readFile allocate unbounded memory.
    const bytes = Buffer.alloc(opened.size + 1); let length = 0;
    while (length < bytes.length) { const result = await handle.read(bytes, length, bytes.length - length, length); if (!result.bytesRead) break; length += result.bytesRead; }
    const after = await handle.stat(), linked = await lstat(filename);
    if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || after.nlink !== 1 || linked.isSymbolicLink() || linked.dev !== opened.dev || linked.ino !== opened.ino) throw new FusionError(kind === 'artifact' ? 'ARTIFACT_CHANGED' : 'ASSET_CHANGED', 'File changed while being inspected.', outcome);
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

const samePath = (left: string, right: string): boolean => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
function manifest(record: ArtifactReservation): unknown {
  return { version: 1, id: record.id, root: record.root, filename: record.filename, format: record.format, plan_id: record.plan_id ?? null, producer_plan_hash: record.producer_plan_hash ?? null, completed_at: record.completed_at ?? null, files: record.files ?? [] };
}

function validateArtifact(bytes: Buffer, format: string): Pick<ArtifactFile, 'checks' | 'media_type'> {
  if (!bytes.length) throw new FusionError('EMPTY_ARTIFACT', 'The provider produced an empty artifact.', 'partial');
  const start = bytes.subarray(0, 512).toString('utf8');
  const checks = ['regular_file', 'nonempty', 'sha256'];
  const media: Record<string, string> = { step: 'model/step', stl: 'model/stl', f3d: 'application/zip', pdf: 'application/pdf', png: 'image/png', jpeg: 'image/jpeg', dxf: 'image/vnd.dxf', nc: 'text/plain', html: 'text/html', css: 'text/css' };
  const matches = format === 'png' ? bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.subarray(12, 16).toString('ascii') === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0 && bytes.subarray(-12).equals(Buffer.from([0,0,0,0,73,69,78,68,174,66,96,130]))
    : format === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217
    : format === 'pdf' ? start.startsWith('%PDF-') && bytes.subarray(-2048).includes(Buffer.from('%%EOF'))
    : format === 'step' ? start.includes('ISO-10303-21;') && bytes.subarray(-1024).includes(Buffer.from('END-ISO-10303-21;'))
    : format === 'f3d' ? bytes[0] === 0x50 && bytes[1] === 0x4b
    : format === 'stl' ? (start.trimStart().startsWith('solid') && bytes.subarray(-4096).includes(Buffer.from('endsolid'))) || (bytes.length >= 84 && 84 + bytes.readUInt32LE(80) * 50 === bytes.length)
    : format === 'dxf' ? /SECTION|AutoCAD Binary DXF/.test(start)
    : format === 'nc' ? !bytes.includes(0)
    : format === 'html' ? !bytes.includes(0) && /<!doctype\s+html|<html\b/i.test(start)
    : format === 'css' ? !bytes.includes(0)
    : false;
  if (!matches) throw new FusionError('INVALID_ARTIFACT', `The output did not pass ${format} structural checks. It remains quarantined.`, 'partial');
  checks.push('format_signature');
  return { checks, media_type: media[format] ?? 'application/octet-stream' };
}

export class ArtifactManager {
  constructor(private profile: FusionProfile, private store: RecordStore, private validateAccess?: () => Promise<void>) {}
  reserve(destination: { root: string; filename: string }, format: string): ArtifactReservation {
    const root = this.profile.outputs.find(x => x.id === destination.root);
    if (!root) throw new FusionError('OUTPUT_DENIED', 'The output root is not in the trusted profile.');
    validateFilename(destination.filename);
    const suffix: Record<string, string[]> = { step: ['.step', '.stp'], stl: ['.stl'], f3d: ['.f3d'], pdf: ['.pdf'], png: ['.png'], dxf: ['.dxf'], nc: ['.nc', '.tap', '.cnc'], html: ['.html', '.htm'] };
    if (!suffix[format]?.includes(path.extname(destination.filename).toLowerCase())) throw new FusionError('INVALID_EXTENSION', 'Filename extension does not match the requested format.');
    const id = newId('artifact');
    const directory = path.join(root.path, id);
    return { id, root: root.id, filename: destination.filename, format, directory, path: path.join(directory, destination.filename), status: 'prepared', created_at: now() };
  }
  async stage(reservation: ArtifactReservation): Promise<ArtifactReservation> {
    await this.validateAccess?.();
    const configured = this.profile.outputs.find(x => x.id === reservation.root);
    if (!configured) throw new FusionError('OUTPUT_DENIED', 'The output root was removed.');
    const root = await ensurePrivateDirectory(configured.path);
    const directory = path.join(root, reservation.id);
    if (!/^artifact_[a-f0-9-]{36}$/.test(reservation.id)) throw new FusionError('INVALID_REFERENCE', 'Invalid artifact reference.');
    validateFilename(reservation.filename);
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new FusionError('ARTIFACT_ALREADY_STAGED', 'This artifact directory already exists. Resolve the previous outcome; do not overwrite it.');
      throw error;
    }
    const staged = { ...reservation, directory, path: path.join(directory, reservation.filename), status: 'generating' as const };
    await this.store.put('artifact', reservation.id, staged); return staged;
  }
  /** A read never authorizes completion, even if a partial output looks valid. */
  async inspect(id: string, allowPending = false): Promise<ArtifactReservation> {
    await this.validateAccess?.();
    return this.inspectInternal(id, allowPending);
  }
  /** Called only by the engine after an explicit successful provider result. */
  async complete(id: string, producer: { plan_id: string; plan_hash: string }): Promise<ArtifactReservation> {
    await this.validateAccess?.();
    const plan = await this.store.get<{ id: string; hash: string; artifact?: { id: string }; status: string }>('plan', producer.plan_id);
    if (!plan || plan.id !== producer.plan_id || plan.hash !== producer.plan_hash || plan.artifact?.id !== id || !['executing', 'pending', 'outcome_unknown', 'succeeded', 'failed'].includes(plan.status)) throw new FusionError('ARTIFACT_PROVENANCE_CHANGED', 'Only the verified producing execution may finalize this artifact.');
    return this.inspectInternal(id, false, producer);
  }
  async quarantine(id: string, status: 'pending' | 'failed', limitation: string): Promise<ArtifactReservation> {
    const record = await this.store.get<ArtifactReservation>('artifact', id);
    if (!record || record.id !== id) throw new FusionError('NOT_FOUND', 'Artifact reference was not found in this profile.');
    if (record.status === 'succeeded' || record.manifest_sha256 || record.files) throw new FusionError('ARTIFACT_IMMUTABLE', 'A completed artifact manifest cannot be changed.');
    const result = { ...record, status, limitation };
    await this.store.put('artifact', id, result); return result;
  }
  private async inspectInternal(id: string, allowPending: boolean, completion?: { plan_id: string; plan_hash: string }): Promise<ArtifactReservation> {
    const reservation = await this.store.get<ArtifactReservation>('artifact', id);
    if (!reservation || reservation.id !== id || !/^artifact_[a-f0-9-]{36}$/u.test(id)) throw new FusionError('NOT_FOUND', 'Artifact reference was not found in this profile.');
    validateFilename(reservation.filename);
    if (completion && reservation.plan_id !== completion.plan_id) throw new FusionError('ARTIFACT_PROVENANCE_CHANGED', 'Artifact does not belong to this producing plan.');
    if (reservation.status === 'succeeded' && (!reservation.files?.length || !reservation.producer_plan_hash || !reservation.completed_at || !reservation.manifest_sha256 || hash(manifest(reservation)) !== reservation.manifest_sha256 || (completion && reservation.producer_plan_hash !== completion.plan_hash))) throw new FusionError('ARTIFACT_CHANGED', 'The immutable artifact manifest changed or is incomplete.', 'partial');
    if (reservation.status !== 'succeeded' && (reservation.files || reservation.manifest_sha256 || reservation.producer_plan_hash)) throw new FusionError('ARTIFACT_CHANGED', 'An incomplete artifact cannot carry a completed manifest.', 'partial');
    const configured = this.profile.outputs.find(x => x.id === reservation.root);
    if (!configured) throw new FusionError('OUTPUT_DENIED', 'This artifact root is no longer authorized.');
    const root = await realpath(configured.path);
    const directory = await realpath(reservation.directory);
    if (!samePath(directory, path.join(root, reservation.id)) || (await lstat(reservation.directory)).isSymbolicLink() || !samePath(path.dirname(reservation.path), reservation.directory) || path.basename(reservation.path).normalize('NFC') !== reservation.filename) throw new FusionError('UNSAFE_PATH', 'Artifact directory or reserved output path changed.');
    const names: string[] = [];
    const directories: Array<{ filename: string; ino: number; dev: number }> = [];
    const logicalNames = new Set<string>();
    let entries = 0, totalBytes = 0;
    const collect = async (current: string, depth = 0): Promise<void> => {
      if (depth > 8) throw new FusionError('ARTIFACT_LIMIT', 'Output nesting exceeds its limit.', 'partial');
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory() || !samePath(await realpath(current), current)) throw new FusionError('UNSAFE_ARTIFACT', 'Output directory was replaced or linked.', 'partial');
      directories.push({ filename: current, ino: info.ino, dev: info.dev });
      for await (const entry of await opendir(current)) {
        if (++entries > 500) throw new FusionError('ARTIFACT_LIMIT', 'Output contains too many entries.', 'partial');
        // macOS may enumerate decomposed filenames even when Fusion was given
        // NFC. Preserve actual disk spelling while checking normalized names.
        validateFilename(entry.name.normalize('NFC'));
        const filename = path.join(current, entry.name);
        const logical = path.relative(directory, filename).normalize('NFC').toLowerCase();
        if (logicalNames.has(logical)) throw new FusionError('UNSAFE_ARTIFACT', 'Output contains Unicode or case aliases that are ambiguous on supported filesystems.', 'partial');
        logicalNames.add(logical);
        if (entry.isSymbolicLink()) throw new FusionError('UNSAFE_ARTIFACT', 'Artifact contains a symbolic link.', 'partial');
        if (entry.isDirectory() && reservation.format === 'html') await collect(filename, depth + 1);
        else if (entry.isFile()) {
          const file = await lstat(filename);
          if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size > 256_000_000) throw new FusionError('UNSAFE_ARTIFACT', 'Output is not a bounded regular file without aliases.', 'partial');
          totalBytes += file.size;
          if (totalBytes > 256_000_000) throw new FusionError('ARTIFACT_LIMIT', 'Artifact bundle exceeds its aggregate byte limit.', 'partial');
          names.push(path.relative(directory, filename));
        }
        else throw new FusionError('UNSAFE_ARTIFACT', 'Unexpected output directory or file type.', 'partial');
      }
    };
    await collect(directory);
    names.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    if (!completion && reservation.status !== 'succeeded') return { ...reservation, status: reservation.status === 'failed' ? 'failed' : 'pending', limitation: reservation.limitation ?? 'Provider completion is unconfirmed. Existing output files remain quarantined and no immutable manifest has been issued.' };
    const bundle = reservation.format === 'nc' || reservation.format === 'html';
    const expectedNames = bundle ? names : names.filter(name => name.normalize('NFC') === reservation.filename);
    if (!names.length || (!bundle && expectedNames.length !== 1)) {
      throw new FusionError('MISSING_ARTIFACT', 'The expected output file is missing.', 'partial');
    }
    if (!bundle && names.length !== 1) throw new FusionError('UNEXPECTED_ARTIFACT', 'The provider wrote undeclared files; all outputs remain quarantined.', 'partial');
    if (reservation.format === 'html' && !names.some(name => ['.html', '.htm'].includes(path.extname(name).toLowerCase()))) throw new FusionError('MISSING_ARTIFACT', 'Setup-sheet package contains no HTML document.', 'partial');
    const files: ArtifactFile[] = [];
    totalBytes = 0;
    for (const name of expectedNames) {
      name.split(path.sep).forEach(part => validateFilename(part.normalize('NFC')));
      const filename = path.join(directory, name);
      if (!samePath(await realpath(path.dirname(filename)), path.dirname(filename))) throw new FusionError('UNSAFE_ARTIFACT', 'Output ancestor changed before validation.', 'partial');
      const bytes = await boundedFile(filename, 256_000_000 - totalBytes, 'artifact'); totalBytes += bytes.length;
      const fileFormat = reservation.format === 'html' ? ({ '.html': 'html', '.htm': 'html', '.css': 'css', '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg' }[path.extname(name).toLowerCase()] ?? 'unsupported') : reservation.format;
      files.push({ name, size: bytes.length, sha256: hashBytes(bytes), ...validateArtifact(bytes, fileFormat) });
    }
    for (const previous of directories) { const current = await lstat(previous.filename); if (current.isSymbolicLink() || !current.isDirectory() || current.ino !== previous.ino || current.dev !== previous.dev || !samePath(await realpath(previous.filename), previous.filename)) throw new FusionError('ARTIFACT_CHANGED', 'Output directory changed during inspection.', 'partial'); }
    if (reservation.files && (reservation.files.length !== files.length || reservation.files.some(previous => !files.some(current => current.name === previous.name && current.sha256 === previous.sha256 && current.size === previous.size)))) throw new FusionError('ARTIFACT_CHANGED', 'The immutable artifact receipt no longer matches the output bytes.', 'partial');
    if (reservation.status === 'succeeded') return reservation;
    const result: ArtifactReservation = { ...reservation, files, status: 'succeeded', producer_plan_hash: completion!.plan_hash, completed_at: now(), ...(!bundle ? { path: path.join(directory, files[0]!.name) } : {}), limitation: reservation.format === 'nc' ? 'Quarantined NC candidate. Signature checks do not establish collision safety or authorize machine use.' : reservation.format === 'html' ? 'Quarantined HTML review package. It is not sanitized for active browser execution; do not publish or open untrusted embedded content automatically.' : 'Structural validation does not establish geometric fidelity; use round-trip/kernel qualification.' };
    result.manifest_sha256 = hash(manifest(result));
    await this.store.put('artifact', id, result); return result;
  }
}
