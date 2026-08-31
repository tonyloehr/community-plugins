import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { profileHash, type FusionProfile } from './profile.js';
import type { DesktopResponse, PlanRecord } from './types.js';
import { parseOperation } from './catalog.js';
import { FusionError, assertJson, hash, hashBytes, newId, now } from './safety.js';
import { ensurePrivateDirectory, RecordStore } from './storage.js';
import { validatePngContent, validateStlContent, type ArtifactContentValidation, type PngExpectation } from './artifact-validation.js';

export type { ArtifactContentValidation, PngValidation, StlValidation } from './artifact-validation.js';
export { validatePngContent, validateStlContent } from './artifact-validation.js';

export interface ArtifactCompletionEvidence {
  provider_kind: 'native_mcp' | 'typed_addin' | 'synthetic_fixture' | 'unverified_provider';
  /** Actual successful dispatch/poll response retained by the broker, never a tool input. */
  response: Extract<DesktopResponse, { ok: true }>;
  provider_job_id?: string;
  /** An already observed documents.list payload. A trusted profile is not a diagnostic. */
  diagnostic?: unknown;
}
export interface ArtifactCompletion {
  plan_id: string; plan_hash: string; evidence: ArtifactCompletionEvidence;
}
export interface ArtifactProvenance {
  schema: 1;
  producer: {
    plan_id: string; plan_hash: string; operation: string; handler_sha256: string;
    execution_contract_sha256: string; profile_sha256: string;
    provider_kind: ArtifactCompletionEvidence['provider_kind'];
    evidence: 'synthetic_fixture' | 'provider_reported' | 'unverified_provider_response';
    fusion_version: string | null; diagnostic_session_id: string | null;
    independently_verified: false;
  };
  source: {
    document_id: string; observed_document_id: string | null; session_id: string | null;
    state_at_preparation: string; state_at_completion: string | null;
    completion_state_matches_preparation: boolean | null;
    cloud: Record<string, string | number | null> | null;
    configuration: Record<string, string | boolean | null> | null;
    internal_units: Record<string, string | null> | null;
    reported_units: Record<string, string | null> | null;
    display_length_unit: string | null;
    scope: string;
  };
  request: { format: string; options: Record<string, unknown>; options_basis: string; png_dimensions: PngExpectation | null };
  completion: {
    recorded_at: string; response_sha256: string; provider_job_id: string | null;
    provider_status: string | null;
    reported_output: { format: string | null; sha256: string | null; size_bytes: number | null; options: Record<string, unknown> } | null;
  };
  known_losses: string[]; unknown_fields: string[];
}

type ArtifactProducerPlan = PlanRecord & {
  execution_contract_hash: string; artifact: ArtifactReservation;
  provider_args: Record<string, unknown>; before: unknown; limitations: string[];
};

export interface ArtifactReservation {
  id: string; root: string; filename: string; format: string;
  directory: string; path: string; status: 'prepared' | 'generating' | 'succeeded' | 'pending' | 'failed';
  created_at: string; plan_id?: string; files?: ArtifactFile[]; limitation?: string;
  producer_plan_hash?: string; completed_at?: string; manifest_sha256?: string;
  /** Missing means the original version 1 manifest/validation contract. */
  manifest_version?: 1 | 2; provenance?: ArtifactProvenance;
}
export interface ArtifactFile { name: string; size: number; sha256: string; media_type: string; checks: string[]; validation?: ArtifactContentValidation }

function provenanceError(message: string): never { throw new FusionError('ARTIFACT_PROVENANCE_CHANGED', message, 'partial'); }
function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function text(value: unknown, label: string, maximum = 2048): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.length || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) provenanceError(`${label} is not bounded observation text.`);
  return value;
}
function sha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) provenanceError(`${label} is not a SHA-256.`);
  return value;
}
function bool(value: unknown, label: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') provenanceError(`${label} is not an observed boolean.`);
  return value;
}
function projection(value: unknown, fields: readonly string[]): Record<string, string | null> | null {
  if (value === undefined || value === null) return null;
  const record = object(value); if (!record) provenanceError('Source observation has an invalid object shape.');
  return Object.fromEntries(fields.map(field => [field, text(record[field], field)]));
}
function version(record: ArtifactReservation): 1 | 2 {
  const value = record.manifest_version ?? 1;
  if (![1, 2].includes(value)) throw new FusionError('ARTIFACT_CHANGED', 'Artifact manifest version is unsupported.', 'partial');
  if (value === 1 && (record.provenance !== undefined || record.files?.some(file => file.validation !== undefined))) throw new FusionError('ARTIFACT_CHANGED', 'A legacy artifact cannot acquire version 2 provenance or validation grades.', 'partial');
  return value;
}
function assertProducerBinding(plan: ArtifactProducerPlan): void {
  let actual: string;
  try {
    actual = hash({ id: plan.id, created_at: plan.created_at, expires_at: plan.expires_at, operation: plan.operation,
      expected_state: plan.expected_state ?? null, handler_hash: plan.handler_hash, profile_hash: plan.profile_hash,
      execution_contract_hash: plan.execution_contract_hash ?? null, effect: plan.effect, provider_args: plan.provider_args,
      artifact: plan.artifact ?? null, before: plan.before, summary: plan.summary, limitations: plan.limitations });
  } catch { provenanceError('The stored producer content cannot be verified against its immutable plan binding.'); }
  if (actual !== plan.hash) provenanceError('The stored producer content changed after its plan hash was prepared.');
}

function provenance(plan: ArtifactProducerPlan, evidence: ArtifactCompletionEvidence, profile: FusionProfile): ArtifactProvenance {
  if (!evidence || !['native_mcp', 'typed_addin', 'synthetic_fixture', 'unverified_provider'].includes(evidence.provider_kind) || evidence.response?.ok !== true) provenanceError('Artifact completion requires a successful broker-retained provider response.');
  assertJson(evidence.response, 4_194_304);
  const response = evidence.response, data = object(response.data);
  if (!data) provenanceError('Artifact completion response lacks structured provider data.');
  if (data.status !== undefined && data.status !== 'succeeded') provenanceError('Pending, failed or unrecognized provider status cannot finalize an artifact.');
  if (plan.profile_hash !== profileHash(profile)) provenanceError('The artifact producer belongs to another profile configuration.');
  const op = parseOperation(plan.operation), before = object(plan.before) ?? {};
  const documentId = text(op.document_id, 'Producer document ID', 128);
  const observedDocumentId = text(before.document_id, 'Observed document ID', 128);
  if (!documentId || (observedDocumentId !== null && observedDocumentId !== documentId) || (data.source_document_id !== undefined && data.source_document_id !== documentId)) provenanceError('The artifact source observation does not match its producing document.');
  const expectedState = text(plan.expected_state, 'Prepared source state', 128);
  if (!expectedState || op.expected_state !== expectedState) provenanceError('The producer source-state binding is incomplete.');
  const providerJobId = text(evidence.provider_job_id, 'Provider future ID');
  if ((data.job_id !== undefined || providerJobId !== null) && data.job_id !== providerJobId) provenanceError('The completion response belongs to another provider future.');
  if (['render.start', 'cam.nc_post', 'cam.setup_sheet'].includes(op.operation) && data.status !== 'succeeded') provenanceError('Asynchronous artifact completion needs explicit successful provider status.');

  const args = op.args, internal = object(plan.provider_args);
  if (!internal) provenanceError('The producer has no bound provider arguments.');
  const destination = object(args.output);
  if (destination?.root !== plan.artifact.root || destination?.filename !== plan.artifact.filename) provenanceError('The reserved output identity differs from the bound request.');
  const optionKeys: Record<string, string[]> = {
    'exports.generate': ['format', 'entity_id', 'unit', 'mesh_refinement'],
    'view.capture': ['width', 'height', 'fit'], 'render.start': ['width', 'height', 'quality'],
    'drawings.export_pdf': ['all_sheets'], 'flatpattern.export': ['component_id'],
    'cam.nc_post': ['operation_ids', 'manufacturing_profile_id', 'review_record_id', 'program_name'],
    'cam.setup_sheet': ['operation_ids', 'format'],
  };
  const keys = optionKeys[op.operation]; if (!keys) provenanceError('The producer operation has no reviewed artifact provenance mapping.');
  const options = Object.fromEntries(keys.filter(key => args[key] !== undefined).map(key => [key, args[key]]));
  for (const key of keys) {
    // These two IDs are resolved to pinned post/machine/review inputs before
    // dispatch; they are source selectors, never newly observed approvals.
    if (!['manufacturing_profile_id', 'review_record_id'].includes(key) && args[key] !== undefined && (internal[key] === undefined || hash(args[key]) !== hash(internal[key]))) provenanceError('Provider options differ from the bound producer request.');
  }
  if (args.parameters !== undefined) options.post_parameters_sha256 = hash(args.parameters);
  if (op.operation === 'cam.nc_post') {
    options.resolved_output_unit = text(internal.units, 'Bound NC output unit', 32);
    options.resolved_post_sha256 = sha(internal.post_sha256, 'Bound post asset hash');
    options.resolved_machine_sha256 = sha(object(internal.machine_profile)?.sha256, 'Bound machine asset hash');
    options.resolved_tool_library_sha256 = sha(object(internal.tool_library)?.sha256, 'Bound tool-library asset hash');
  }
  const format = op.operation === 'exports.generate' ? args.format : op.operation === 'drawings.export_pdf' ? 'pdf' : op.operation === 'flatpattern.export' ? 'dxf' : op.operation === 'cam.nc_post' ? 'nc' : op.operation === 'cam.setup_sheet' ? 'html' : 'png';
  if (format !== plan.artifact.format) provenanceError('The reserved artifact format differs from the producer request.');
  let dimensions: PngExpectation | null = null;
  if (['view.capture', 'render.start'].includes(op.operation)) {
    if (internal.width !== args.width || internal.height !== args.height) provenanceError('The provider image dimensions differ from the bound request.');
    dimensions = { width: args.width as number, height: args.height as number };
  }
  if (format === 'stl') {
    options.unit = args.unit ?? 'mm'; options.mesh_refinement = args.mesh_refinement ?? 'high';
    options.binary = true; options.one_file_per_body = false;
    if ((internal.unit ?? 'mm') !== options.unit || (internal.mesh_refinement ?? 'high') !== options.mesh_refinement) provenanceError('The provider STL options differ from the bound request.');
  }
  if (op.operation === 'view.capture') options.fit = args.fit ?? false;

  const diagnostic = evidence.diagnostic === undefined ? undefined : object(evidence.diagnostic);
  if (evidence.diagnostic !== undefined && !diagnostic) provenanceError('Provider diagnostic observation has an invalid shape.');
  const diagnosticSession = text(diagnostic?.session_id, 'Diagnostic session ID', 256);
  const sourceSession = text(before.session_id, 'Source session ID', 256);
  if (diagnosticSession && sourceSession && diagnosticSession !== sourceSession) provenanceError('Provider diagnostics and source observation belong to different sessions.');
  const observedFusionVersion = text(diagnostic?.fusion_version, 'Observed Fusion version', 256);
  const fusionVersion = sourceSession && diagnosticSession === sourceSession ? observedFusionVersion : null;
  const cloud = projection(before.cloud, ['lineage_id', 'version_id', 'project_id', 'folder_id']) as Record<string, string | number | null> | null;
  if (cloud) {
    const number = object(before.cloud)?.version_number;
    if (number !== undefined && number !== null && (!Number.isSafeInteger(number) || (number as number) < 1)) provenanceError('Observed cloud version number is invalid.');
    cloud.version_number = (number as number | undefined) ?? null;
  }
  let configuration: Record<string, string | boolean | null> | null = null;
  if (before.configuration !== undefined && before.configuration !== null) {
    const value = object(before.configuration); if (!value) provenanceError('Observed configuration identity is invalid.');
    configuration = { is_configured_design: bool(value.is_configured_design, 'Configured-design flag'), is_configuration: bool(value.is_configuration, 'Configuration-instance flag'), row_id: text(value.row_id, 'Configuration row'), table_id: text(value.table_id, 'Configuration table') };
  }
  const output = data.artifact === undefined ? undefined : object(data.artifact);
  if (data.artifact !== undefined && !output) provenanceError('Provider artifact observation has an invalid shape.');
  let reportedOutput: ArtifactProvenance['completion']['reported_output'] = null;
  if (output) {
    const outputFormat = text(output.format, 'Reported output format', 32);
    const outputHash = output.sha256 === undefined ? null : sha(output.sha256, 'Reported output hash');
    const bytes = output.size_bytes;
    if (bytes !== undefined && (!Number.isSafeInteger(bytes) || (bytes as number) < 1)) provenanceError('Reported output byte count is invalid.');
    if (outputFormat !== null && outputFormat !== format) provenanceError('Reported output format differs from the reserved artifact.');
    const reportedOptions: Record<string, unknown> = {};
    for (const field of ['unit', 'mesh_refinement']) if (output[field] !== undefined) reportedOptions[field] = text(output[field], 'Reported ' + field, 64);
    if (output.binary !== undefined) reportedOptions.binary = bool(output.binary, 'Reported binary format');
    for (const field of ['surface_deviation_cm', 'normal_deviation_rad', 'maximum_edge_length_cm']) {
      if (output[field] !== undefined) { if (typeof output[field] !== 'number' || !Number.isFinite(output[field])) provenanceError('Reported mesh tolerance is nonfinite.'); reportedOptions[field] = output[field]; }
    }
    if (format === 'stl') for (const field of ['unit', 'mesh_refinement', 'binary']) if (reportedOptions[field] !== undefined && reportedOptions[field] !== options[field]) provenanceError('Reported STL options contradict the bound export request.');
    reportedOutput = { format: outputFormat, sha256: outputHash, size_bytes: (bytes as number | undefined) ?? null, options: reportedOptions };
  }
  const completionState = text(response.state, 'Completion source state', 128);
  const synthetic = evidence.provider_kind === 'synthetic_fixture' || before.fixture === true || data.fixture === true || data.provider === 'synthetic_fixture' || data.live_fusion_verified === false;
  const internalUnits = projection(before.internal_units, ['length', 'angle', 'mass']);
  const reportedUnits = projection(before.units, ['length', 'angle', 'mass']);
  const losses: Record<string, string[]> = {
    step: ['Neutral BRep exchange does not preserve Fusion parametric history or establish material/metadata parity.'],
    stl: ['STL stores tessellated coordinates without an embedded unit or parametric/material identity.', 'Unit and meshing settings are requested/provider-reported context; file parsing does not verify their physical correspondence.'],
    f3d: ['Native archive contents and target Fusion compatibility require a qualified reopen; archives are not extracted here.'],
    png: ['Images are not dimensional proof; compressed pixels, visual correctness and complete animation semantics are not verified.'],
    pdf: ['PDF signatures do not establish drawing sheet count, dimensions or engineering approval.'],
    dxf: ['DXF signatures do not establish dimensional fidelity or manufacturing suitability.'],
    html: ['HTML is an unsanitized review package, not manufacturing signoff; embedded content must not be opened automatically.'],
    nc: ['NC content is quarantined; program correctness, collision safety and machine release remain unverified.'],
  };
  const unknown: string[] = [];
  for (const [field, value] of Object.entries({ fusion_version: fusionVersion, source_document_observation: observedDocumentId, source_session: sourceSession, cloud_identity: cloud, configuration, internal_units: internalUnits, completion_state: completionState, provider_output_hash: reportedOutput?.sha256 ?? null })) if (value === null) unknown.push(field);
  const result: ArtifactProvenance = {
    schema: 1,
    producer: { plan_id: plan.id, plan_hash: sha(plan.hash, 'Producer plan hash'), operation: op.operation,
      handler_sha256: sha(plan.handler_hash, 'Handler hash'), execution_contract_sha256: sha(plan.execution_contract_hash, 'Execution contract hash'), profile_sha256: sha(plan.profile_hash, 'Profile hash'),
      provider_kind: evidence.provider_kind, evidence: synthetic ? 'synthetic_fixture' : evidence.provider_kind === 'unverified_provider' ? 'unverified_provider_response' : 'provider_reported',
      fusion_version: fusionVersion, diagnostic_session_id: diagnosticSession, independently_verified: false },
    source: { document_id: documentId, observed_document_id: observedDocumentId, session_id: sourceSession,
      state_at_preparation: expectedState, state_at_completion: completionState,
      completion_state_matches_preparation: completionState === null ? null : expectedState === completionState,
      cloud, configuration, internal_units: internalUnits, reported_units: reportedUnits,
      display_length_unit: text(before.display_length_unit, 'Display length unit', 64),
      scope: 'Historical source observation used to prepare the producer; completion state is separate and does not prove which intermediate geometry an asynchronous provider used.' },
    request: { format: format as string, options, options_basis: 'Bound producer request, resolved pinned asset settings and explicit reviewed-handler defaults; not inferred from profile qualification claims.', png_dimensions: dimensions },
    completion: { recorded_at: now(), response_sha256: hash(response), provider_job_id: providerJobId, provider_status: text(data.status, 'Provider status', 64), reported_output: reportedOutput },
    known_losses: [...(losses[format as string] ?? []), 'No kernel, physical, visual or manufacturing correctness is established by this receipt.'], unknown_fields: unknown,
  };
  assertJson(result, 131_072);
  return result;
}

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
  const manifestVersion = version(record);
  const original = { version: manifestVersion, id: record.id, root: record.root, filename: record.filename, format: record.format, plan_id: record.plan_id ?? null, producer_plan_hash: record.producer_plan_hash ?? null, completed_at: record.completed_at ?? null, files: record.files ?? [] };
  // Do not add even a null field to the version 1 canonical hash input.
  return manifestVersion === 1 ? original : { ...original, provenance: record.provenance ?? null, limitation: record.limitation ?? null };
}

function validateContent(bytes: Buffer, format: string, manifestVersion: 1 | 2, expected?: PngExpectation): Pick<ArtifactFile, 'checks' | 'media_type' | 'validation'> {
  if (manifestVersion === 2 && format === 'png') return {
    media_type: 'image/png', validation: validatePngContent(bytes, expected),
    checks: ['regular_file', 'nonempty', 'sha256', 'png_critical_chunk_structure', 'png_chunk_crc', ...(expected ? ['png_dimensions_match_request'] : [])],
  };
  if (manifestVersion === 2 && format === 'stl') return {
    media_type: 'model/stl', validation: validateStlContent(bytes),
    checks: ['regular_file', 'nonempty', 'sha256', 'stl_triangle_record_grammar', 'stl_finite_coordinates_and_normals', 'stl_coordinate_bounds'],
  };
  return validateArtifact(bytes, format);
}

function validateProvenance(record: ArtifactReservation): ArtifactProvenance {
  const value = record.provenance;
  if (!value || value.schema !== 1 || value.producer?.plan_id !== record.plan_id || value.producer?.plan_hash !== record.producer_plan_hash || value.request?.format !== record.format || value.producer.independently_verified !== false || !Array.isArray(value.known_losses) || !Array.isArray(value.unknown_fields)) throw new FusionError('ARTIFACT_CHANGED', 'Version 2 provenance is missing or contradicts the immutable artifact identity.', 'partial');
  assertJson(value, 131_072);
  if (record.format === 'png') {
    const dimensions = value.request.png_dimensions;
    if (!dimensions || !Number.isSafeInteger(dimensions.width) || dimensions.width < 108 || dimensions.width > 4000 || !Number.isSafeInteger(dimensions.height) || dimensions.height < 108 || dimensions.height > 4000) throw new FusionError('ARTIFACT_CHANGED', 'The completed PNG receipt lacks its bounded original dimension request.', 'partial');
  }
  return value;
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
    return { id, root: root.id, filename: destination.filename, format, directory, path: path.join(directory, destination.filename), status: 'prepared', created_at: now(), manifest_version: 2 };
  }
  async stage(reservation: ArtifactReservation): Promise<ArtifactReservation> {
    await this.validateAccess?.();
    version(reservation);
    if (reservation.status !== 'prepared' || reservation.files || reservation.manifest_sha256 || reservation.provenance || reservation.producer_plan_hash || reservation.completed_at) throw new FusionError('ARTIFACT_CHANGED', 'Only a fresh prepared reservation may be staged.');
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
  async complete(id: string, producer: ArtifactCompletion): Promise<ArtifactReservation> {
    await this.validateAccess?.();
    try {
      if (producer.evidence?.response?.ok !== true) provenanceError('Artifact completion requires the actual successful provider response.');
      const plan = await this.store.get<ArtifactProducerPlan>('plan', producer.plan_id);
      const record = await this.store.get<ArtifactReservation>('artifact', id);
      if (!plan || !record || plan.id !== producer.plan_id || plan.hash !== producer.plan_hash || plan.artifact?.id !== id || !['executing', 'pending', 'outcome_unknown', 'succeeded', 'failed'].includes(plan.status)) provenanceError('Only the verified producing execution may finalize this artifact.');
      // Reloaded source observations must still match the actual admitted plan;
      // comparing two unchanged hash fields would not detect changed content.
      assertProducerBinding(plan);
      if (record.plan_id !== plan.id || record.id !== plan.artifact.id || record.root !== plan.artifact.root || record.filename !== plan.artifact.filename || record.format !== plan.artifact.format || version(record) !== version(plan.artifact)) provenanceError('The staged artifact no longer matches its bound producer reservation.');
      // A completion retry may verify existing bytes, but never re-date or
      // re-grade an already completed receipt, including a legacy receipt.
      if (record.status === 'succeeded') return await this.inspectInternal(id, false, producer);
      const observed = version(record) === 2 ? provenance(plan, producer.evidence, this.profile) : undefined;
      return await this.inspectInternal(id, false, { ...producer, ...(observed ? { provenance: observed } : {}) });
    } catch (error) {
      if (error instanceof FusionError && error.outcome === 'none') throw new FusionError(error.code, error.message, 'partial', error.details);
      throw error;
    }
  }
  async quarantine(id: string, status: 'pending' | 'failed', limitation: string): Promise<ArtifactReservation> {
    const record = await this.store.get<ArtifactReservation>('artifact', id);
    if (!record || record.id !== id) throw new FusionError('NOT_FOUND', 'Artifact reference was not found in this profile.');
    if (record.status === 'succeeded' || record.manifest_sha256 || record.files) throw new FusionError('ARTIFACT_IMMUTABLE', 'A completed artifact manifest cannot be changed.');
    const result = { ...record, status, limitation };
    await this.store.put('artifact', id, result); return result;
  }
  private async inspectInternal(id: string, allowPending: boolean, completion?: ArtifactCompletion & { provenance?: ArtifactProvenance }): Promise<ArtifactReservation> {
    const reservation = await this.store.get<ArtifactReservation>('artifact', id);
    if (!reservation || reservation.id !== id || !/^artifact_[a-f0-9-]{36}$/u.test(id)) throw new FusionError('NOT_FOUND', 'Artifact reference was not found in this profile.');
    validateFilename(reservation.filename);
    const manifestVersion = version(reservation);
    if (completion && reservation.plan_id !== completion.plan_id) throw new FusionError('ARTIFACT_PROVENANCE_CHANGED', 'Artifact does not belong to this producing plan.');
    if (reservation.status === 'succeeded' && (!reservation.files?.length || !reservation.producer_plan_hash || !reservation.completed_at || !reservation.manifest_sha256 || hash(manifest(reservation)) !== reservation.manifest_sha256 || (completion && reservation.producer_plan_hash !== completion.plan_hash))) throw new FusionError('ARTIFACT_CHANGED', 'The immutable artifact manifest changed or is incomplete.', 'partial');
    if (reservation.status !== 'succeeded' && (reservation.files || reservation.manifest_sha256 || reservation.producer_plan_hash || reservation.provenance || reservation.completed_at)) throw new FusionError('ARTIFACT_CHANGED', 'An incomplete artifact cannot carry a completed manifest.', 'partial');
    const observed = manifestVersion === 2 && reservation.status === 'succeeded' ? validateProvenance(reservation) : completion?.provenance;
    if (completion && reservation.status !== 'succeeded' && manifestVersion === 2 && !observed) provenanceError('Version 2 completion requires bound provider provenance.');
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
      files.push({ name, size: bytes.length, sha256: hashBytes(bytes), ...validateContent(bytes, fileFormat, manifestVersion, !bundle && fileFormat === 'png' ? observed?.request.png_dimensions ?? undefined : undefined) });
    }
    if (reservation.format === 'stl' && manifestVersion === 2 && observed?.request.options.binary === true && files[0]?.validation?.validator === 'stl_triangles_v1' && files[0].validation.encoding !== 'binary') provenanceError('STL encoding differs from the bound binary export settings.');
    for (const previous of directories) { const current = await lstat(previous.filename); if (current.isSymbolicLink() || !current.isDirectory() || current.ino !== previous.ino || current.dev !== previous.dev || !samePath(await realpath(previous.filename), previous.filename)) throw new FusionError('ARTIFACT_CHANGED', 'Output directory changed during inspection.', 'partial'); }
    if (reservation.files && (reservation.files.length !== files.length || reservation.files.some(previous => !files.some(current => current.name === previous.name && current.sha256 === previous.sha256 && current.size === previous.size)))) throw new FusionError('ARTIFACT_CHANGED', 'The immutable artifact receipt no longer matches the output bytes.', 'partial');
    if (manifestVersion === 2 && reservation.files && hash(reservation.files) !== hash(files)) throw new FusionError('ARTIFACT_CHANGED', 'The completed validation grade no longer matches its declared validator and file bytes.', 'partial');
    const reported = observed?.completion.reported_output;
    if (!bundle && reported && ((reported.sha256 !== null && reported.sha256 !== files[0]!.sha256) || (reported.size_bytes !== null && reported.size_bytes !== files[0]!.size))) provenanceError('Provider-reported artifact hash or byte count differs from the independently inspected output.');
    if (reservation.status === 'succeeded') return reservation;
    const result: ArtifactReservation = { ...reservation, files, status: 'succeeded', producer_plan_hash: completion!.plan_hash, completed_at: now(), ...(observed ? { provenance: observed } : {}), ...(!bundle ? { path: path.join(directory, files[0]!.name) } : {}), limitation: reservation.format === 'nc' ? 'Quarantined NC candidate. Signature checks do not establish collision safety or authorize machine use.' : reservation.format === 'html' ? 'Quarantined HTML review package. It is not sanitized for active browser execution; do not publish or open untrusted embedded content automatically.' : 'Structural validation does not establish geometric fidelity; use round-trip/kernel qualification.' };
    if (manifestVersion === 2) validateProvenance(result);
    result.manifest_sha256 = hash(manifest(result));
    await this.store.put('artifact', id, result); return result;
  }
}
