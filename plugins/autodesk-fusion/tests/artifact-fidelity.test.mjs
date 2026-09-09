import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
const {
  ArtifactManager, FusionEngine, FixtureDesktopProvider, RecordStore, fixtureProfile,
  hash, hashBytes, parseOperation, parseProfile, validatePngContent, validateStlContent,
} = await import(process.env.FUSION_ARTIFACT_TEST_ENTRY ?? new URL('../dist/index.mjs', import.meta.url).href);

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type), result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); name.copy(result, 4); data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), result.length - 4);
  return result;
}
function ihdr(width = 108, height = 108, color = 6, depth = 8) {
  const data = Buffer.alloc(13); data.writeUInt32BE(width); data.writeUInt32BE(height, 4);
  data[8] = depth; data[9] = color; return data;
}
function png(width = 108, height = 108) {
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr(width, height)), chunk('IDAT', deflateSync(pixels)), chunk('IEND')]);
}
const TRIANGLE = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
function binaryStl(triangles = [TRIANGLE], { header = 'Synthetic triangular parser fixture', attributes = 0 } = {}) {
  const bytes = Buffer.alloc(84 + 50 * triangles.length); bytes.write(header, 0, 80, 'ascii'); bytes.writeUInt32LE(triangles.length, 80);
  triangles.forEach((vertices, triangle) => {
    const offset = 84 + 50 * triangle; bytes.writeFloatLE(1, offset + 8);
    vertices.flat().forEach((value, index) => bytes.writeFloatLE(value, offset + 12 + index * 4));
    bytes.writeUInt16LE(attributes, offset + 48);
  });
  return bytes;
}
const ASCII_STL = 'solid fixture\n facet normal 0 0 1\n outer loop\n vertex 0 0 0\n vertex 1e0 0 0\n vertex 0 .1E1 0\n endloop\n endfacet\nendsolid fixture\n';
const partial = code => error => error.code === code && error.outcome === 'partial';

test('PNG container validates exact requested dimensions, CRCs and an explicit limited grade', () => {
  const bytes = png(108, 216), result = validatePngContent(bytes, { width: 108, height: 216 });
  assert.equal(result.width, 108); assert.equal(result.height, 216); assert.equal(result.chunk_count, 3);
  assert.deepEqual(result.requested_dimensions, { width: 108, height: 216 });
  assert.equal(result.dimensions_match_request, true); assert.equal(result.pixel_data_decoded, false);
  assert.equal(validatePngContent(bytes).dimensions_match_request, null);
  assert.throws(() => validatePngContent(bytes, { width: 216, height: 108 }), partial('INVALID_ARTIFACT'));
  const corrupt = Buffer.from(bytes); corrupt[20] ^= 1;
  assert.throws(() => validatePngContent(corrupt), partial('INVALID_ARTIFACT'));
});

test('PNG rejects framing, critical chunk, palette and trailer contradictions', () => {
  const head = chunk('IHDR', ihdr()), data = chunk('IDAT', Buffer.from([1])), end = chunk('IEND');
  const invalid = [
    [head, data], [head, end], [head, chunk('IDAT'), end], [data, head, end], [head, head, data, end],
    [head, data, end, Buffer.from('trailing')], [head, chunk('ABCD'), data, end],
    [head, chunk('abca'), data, end], [head, data, chunk('tEXt', Buffer.from('key\0text')), data, end],
    [chunk('IHDR', ihdr(108, 108, 3)), data, end],
    [chunk('IHDR', ihdr(108, 108, 0)), chunk('PLTE', Buffer.from([0, 0, 0])), data, end],
    [head, data, chunk('PLTE', Buffer.from([0, 0, 0])), end],
    [head, chunk(Buffer.from([0xc9, 0x44, 0x41, 0x54]), Buffer.from([1])), end],
    [head, chunk('IEND', Buffer.from([1]))],
  ];
  for (const records of invalid) assert.throws(() => validatePngContent(Buffer.concat([SIGNATURE, ...records])), partial('INVALID_ARTIFACT'));
  const invalidLength = png(); invalidLength.writeUInt32BE(0x7fffffff, 33);
  assert.throws(() => validatePngContent(invalidLength), partial('INVALID_ARTIFACT'));
  assert.throws(() => validatePngContent(png().subarray(0, -1)), partial('INVALID_ARTIFACT'));
  const indexed = Buffer.concat([SIGNATURE, chunk('IHDR', ihdr(1, 1, 3, 1)), chunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255])), data, end]);
  assert.equal(validatePngContent(indexed).width, 1);
});

test('PNG parser has finite pixel/chunk bounds and does not claim to decode image data', () => {
  const enormous = Buffer.concat([SIGNATURE, chunk('IHDR', ihdr(8001, 8000)), chunk('IDAT', Buffer.from([1])), chunk('IEND')]);
  assert.throws(() => validatePngContent(enormous), partial('ARTIFACT_LIMIT'));
  const chunks = [SIGNATURE, chunk('IHDR', ihdr(1, 1)), ...Array.from({ length: 100_000 }, () => chunk('tEXt')), chunk('IDAT', Buffer.from([1])), chunk('IEND')];
  assert.throws(() => validatePngContent(Buffer.concat(chunks)), partial('ARTIFACT_LIMIT'));
  // Correct CRC/container with invalid compressed pixels is deliberately only
  // a container-grade result. No zlib expansion is performed on untrusted data.
  const notDecoded = Buffer.concat([SIGNATURE, chunk('IHDR', ihdr(1, 1)), chunk('acTL', Buffer.from([1])), chunk('IDAT', Buffer.from('not-zlib')), chunk('IEND')]);
  const result = validatePngContent(notDecoded);
  assert.equal(result.pixel_data_decoded, false); assert.equal(result.animation_chunks_present, true);
  assert.match(result.scope, /not decoded or verified/);
});

test('binary STL detects fixed records even with a solid-prefixed header and observes finite bounds', () => {
  const second = [[-4, 2, 8], [0, 0, 0], [1, -3, 0]];
  const result = validateStlContent(binaryStl([TRIANGLE, second], { header: 'solid this is still a binary STL', attributes: 0x8001 }));
  assert.equal(result.encoding, 'binary'); assert.equal(result.triangle_count, 2);
  assert.deepEqual(result.bounds, { min: [-4, -3, 0], max: [1, 2, 8], unit: 'file_coordinates_without_embedded_unit' });
  assert.equal(result.nonzero_attribute_word_count, 2); assert.equal(result.topology_checked, false);
});

test('binary STL rejects nonfinite normal and vertex components, empty and inconsistent records', () => {
  for (const offset of [84, 92, 96, 128]) for (const value of [NaN, Infinity, -Infinity]) {
    const bytes = binaryStl(); bytes.writeFloatLE(value, offset);
    assert.throws(() => validateStlContent(bytes), partial('INVALID_ARTIFACT'));
  }
  const count = binaryStl(); count.writeUInt32LE(2, 80);
  for (const bytes of [count, binaryStl().subarray(0, -1), Buffer.concat([binaryStl(), Buffer.from([0])]), binaryStl([])]) assert.throws(() => validateStlContent(bytes), partial('INVALID_ARTIFACT'));
});

test('ASCII STL parses bounded whitespace/exponent grammar and does not invent topology qualification', () => {
  const result = validateStlContent(Buffer.from(ASCII_STL.replaceAll('\n', '\r\n').replace('outer loop', 'outer\t  loop')));
  assert.equal(result.encoding, 'ascii'); assert.equal(result.triangle_count, 1);
  assert.deepEqual(result.bounds.min, [0, 0, 0]); assert.deepEqual(result.bounds.max, [1, 1, 0]);
  assert.equal(result.topology_checked, false); assert.match(result.scope, /degenerate facets/);
  const degenerate = validateStlContent(binaryStl([[[0, 0, 0], [0, 0, 0], [0, 0, 0]]]));
  assert.equal(degenerate.triangle_count, 1); assert.equal(degenerate.topology_checked, false);
});

test('ASCII STL rejects truncated/extra triangles, nondecimal or nonfinite numbers and trailing objects', () => {
  const malformed = [
    ASCII_STL.replace('endfacet', ''), ASCII_STL.replace('endsolid fixture', ''),
    ASCII_STL.replace('vertex 0 .1E1 0\n', ''), ASCII_STL.replace('endloop', 'vertex 1 1 1\nendloop'),
    ASCII_STL + ASCII_STL, ASCII_STL + 'unframed data', 'solid x\nendsolid x\n',
    ASCII_STL.replace('normal 0 0 1', 'normal 0 0 NaN'),
    ...['Infinity', '-Infinity', 'NaN', '1e999', '0x1', '1_000', '\u00e9'].map(number => ASCII_STL.replace('1e0', number)),
  ];
  for (const text of malformed) assert.throws(() => validateStlContent(Buffer.from(text)), partial('INVALID_ARTIFACT'));
  assert.throws(() => validateStlContent(Buffer.from(ASCII_STL.replace('1e0', '1'.repeat(129)))), partial('ARTIFACT_LIMIT'));
  assert.throws(() => validateStlContent(Buffer.from(ASCII_STL.replace('solid fixture', 'solid ' + 'x'.repeat(1024)))), partial('ARTIFACT_LIMIT'));
});

const DOCUMENT = 'fixture:bracket';
const HANDLER = hashBytes('Artifact fidelity test handler; no Autodesk kernel');
const CONTRACT = hashBytes('Artifact fidelity synthetic execution contract');
const FUTURE = 'job_123456789012345678901234567890ab';
const STEP = Buffer.from('ISO-10303-21;\nHEADER;\n/* SYNTHETIC PROTOCOL SAMPLE */\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n');
const capture = () => ({ operation: 'view.capture', document_id: DOCUMENT, args: { output: { root: 'artifacts', filename: 'viewport.png' }, width: 108, height: 216, fit: false } });
const render = () => ({ operation: 'render.start', document_id: DOCUMENT, args: { output: { root: 'artifacts', filename: 'render.png' }, width: 108, height: 216, quality: 'draft' } });
const exportStl = () => ({ operation: 'exports.generate', document_id: DOCUMENT, args: { format: 'stl', unit: 'mm', mesh_refinement: 'high', output: { root: 'artifacts', filename: 'fixture.stl' } } });

/** Local transport double only: all bytes are built above, never by Fusion. */
class ArtifactProducerDouble {
  revision = 0; calls = []; pollStatus = 'succeeded';
  before = {
    document_id: DOCUMENT, session_id: 'synthetic-session', fixture: true,
    cloud: { lineage_id: 'urn:fixture:lineage', version_id: 'urn:fixture:version:3', version_number: 3, project_id: 'fixture-project', folder_id: 'fixture-folder' },
    configuration: { is_configured_design: true, is_configuration: false, row_id: 'row-A', table_id: 'table-A' },
    internal_units: { length: 'cm', angle: 'rad', mass: 'kg' }, display_length_unit: 'mm',
  };
  dataExtra = {};
  state() { return hash({ synthetic_revision: this.revision }); }
  async dispatch(request) {
    this.calls.push(structuredClone(request));
    const ok = data => ({ ok: true, data, state: this.state(), effects: [] });
    if (request.operation === 'document.inspect') return ok(this.before);
    if (['exports.generate', 'view.capture', 'render.start'].includes(request.operation)) {
      const format = request.args.format ?? 'png';
      this.bytes = this.output ?? (format === 'stl' ? binaryStl() : format === 'png' ? png(request.args.width, request.args.height) : STEP);
      await writeFile(request.args.output_path, this.bytes);
      this.producer = request;
      if (request.operation === 'render.start') { this.revision++; return ok({ job_id: FUTURE, status: 'queued' }); }
      return ok(this.outputObservation(format));
    }
    if (request.operation === 'render.status') return ok({ ...this.outputObservation('png'), job_id: FUTURE, status: this.pollStatus });
    return { ok: false, error: { code: 'UNSUPPORTED', message: 'Unsupported parser-test operation' } };
  }
  outputObservation(format) {
    return { source_document_id: DOCUMENT, artifact: { format, sha256: hashBytes(this.bytes), size_bytes: this.bytes.length, ...this.artifactExtra }, ...this.dataExtra };
  }
}
async function setup(t, provider = new ArtifactProducerDouble(), configure = () => {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fusion-artifact-fidelity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const raw = fixtureProfile(directory); configure(raw); const profile = parseProfile(raw);
  const engine = new FusionEngine(profile, provider, HANDLER, { executionContractHash: CONTRACT });
  await engine.init(); t.after(() => engine.close());
  return { directory, profile, engine, provider };
}
async function execute(engine, input) {
  const prepared = await engine.prepare(input);
  return { prepared, result: await engine.execute(prepared.id, prepared.hash, 'artifact-fidelity-request') };
}

test('new receipt binds requested dimensions, observed source identity and actual provider class without approval inflation', async t => {
  const provider = new ArtifactProducerDouble();
  provider.before.approved = true; provider.before.build = 'unobserved-build';
  provider.dataExtra = { approved: true, provenance: { fusion_version: 'model-supplied', engineering_verified: true } };
  const { engine } = await setup(t, provider, profile => {
    profile.policy.desktopQualification = { version: 1, fusionVersion: 'profile-only-build', provider: 'native', platform: process.platform, arch: process.arch, osRelease: os.release(), handlerSha256: HANDLER, executionContractSha256: CONTRACT, reviewer: 'Fixture author', evidence: '/synthetic/not-observed', expiresAt: new Date(Date.now() + 60_000).toISOString() };
  });
  const { prepared, result } = await execute(engine, capture());
  assert.equal(result.status, 'succeeded');
  const receipt = result.result.artifact, evidence = receipt.provenance;
  assert.equal(receipt.manifest_version, 2); assert.match(receipt.manifest_sha256, /^[a-f0-9]{64}$/);
  assert.equal(evidence.producer.plan_id, prepared.id); assert.equal(evidence.producer.plan_hash, prepared.hash);
  assert.equal(evidence.producer.handler_sha256, HANDLER); assert.equal(evidence.producer.execution_contract_sha256, CONTRACT);
  assert.equal(evidence.producer.provider_kind, 'unverified_provider'); assert.equal(evidence.producer.evidence, 'synthetic_fixture');
  assert.equal(evidence.producer.fusion_version, null); assert.equal(evidence.producer.independently_verified, false);
  assert.equal(evidence.source.document_id, DOCUMENT); assert.equal(evidence.source.state_at_preparation, prepared.expected_state);
  assert.equal(evidence.source.cloud.version_id, provider.before.cloud.version_id); assert.equal(evidence.source.configuration.row_id, 'row-A');
  assert.deepEqual(evidence.source.internal_units, { length: 'cm', angle: 'rad', mass: 'kg' });
  assert.deepEqual(evidence.request.png_dimensions, { width: 108, height: 216 });
  assert.equal(receipt.files[0].validation.dimensions_match_request, true);
  assert.equal(evidence.completion.reported_output.sha256, receipt.files[0].sha256);
  assert.ok(evidence.unknown_fields.includes('fusion_version')); assert.match(evidence.known_losses.join(' '), /No kernel, physical, visual or manufacturing correctness/);
  assert.ok(!JSON.stringify(evidence).includes('model-supplied')); assert.ok(!JSON.stringify(evidence).includes('profile-only-build'));
  assert.ok(!JSON.stringify(evidence).includes('approved')); assert.ok(!JSON.stringify(evidence).includes(provider.producer.args.output_path));
  assert.deepEqual(await engine.artifacts.inspect(receipt.id), receipt);
});

test('STL receipt separates explicit units/options from observed unitless finite coordinates', async t => {
  const provider = new ArtifactProducerDouble();
  provider.artifactExtra = { unit: 'mm', mesh_refinement: 'high', binary: true, surface_deviation_cm: 0.001, normal_deviation_rad: 0.1, maximum_edge_length_cm: 2 };
  const { engine } = await setup(t, provider);
  const { result } = await execute(engine, exportStl()); assert.equal(result.status, 'succeeded');
  const receipt = result.result.artifact;
  assert.deepEqual(receipt.provenance.request.options, { format: 'stl', unit: 'mm', mesh_refinement: 'high', binary: true, one_file_per_body: false });
  assert.equal(receipt.provenance.completion.reported_output.options.unit, 'mm');
  assert.equal(receipt.files[0].validation.bounds.unit, 'file_coordinates_without_embedded_unit');
  assert.equal(receipt.files[0].validation.triangle_count, 1);
  assert.match(receipt.provenance.known_losses.join(' '), /does not verify their physical correspondence/);
});

for (const [label, configure, expected] of [
  ['wrong PNG dimensions', provider => { provider.output = png(108, 108); }, 'INVALID_ARTIFACT'],
  ['corrupt PNG CRC', provider => { provider.output = png(108, 216); provider.output[29] ^= 1; }, 'INVALID_ARTIFACT'],
  ['provider hash contradiction', provider => { provider.artifactExtra = { sha256: '0'.repeat(64) }; }, 'ARTIFACT_PROVENANCE_CHANGED'],
  ['provider length contradiction', provider => { provider.artifactExtra = { size_bytes: 1 }; }, 'ARTIFACT_PROVENANCE_CHANGED'],
  ['provider format contradiction', provider => { provider.artifactExtra = { format: 'stl' }; }, 'ARTIFACT_PROVENANCE_CHANGED'],
  ['wrong source document', provider => { provider.dataExtra = { source_document_id: 'fixture:other' }; }, 'ARTIFACT_PROVENANCE_CHANGED'],
]) test(`completion quarantines ${label} and cannot be silently retried`, async t => {
  const provider = new ArtifactProducerDouble(); configure(provider);
  const { engine } = await setup(t, provider), { prepared, result } = await execute(engine, capture());
  assert.equal(result.status, 'failed'); assert.equal(result.result.error.code, expected); assert.equal(result.result.error.outcome, 'partial');
  const record = await engine.artifacts.inspect(prepared.artifact.id);
  assert.equal(record.status, 'failed'); assert.equal(record.files, undefined); assert.equal(record.provenance, undefined); assert.equal(record.manifest_sha256, undefined);
  await engine.execute(prepared.id, prepared.hash, 'artifact-fidelity-request');
  assert.equal(provider.calls.filter(call => call.operation === 'view.capture').length, 1);
});

test('nonfinite STL geometry and contradictory provider options remain quarantined', async t => {
  for (const mutate of [provider => { provider.output = binaryStl(); provider.output.writeFloatLE(NaN, 96); }, provider => { provider.artifactExtra = { unit: 'cm' }; }, provider => { provider.output = Buffer.from(ASCII_STL); provider.artifactExtra = { binary: true }; }]) {
    const provider = new ArtifactProducerDouble(); mutate(provider);
    const { engine } = await setup(t, provider), { prepared, result } = await execute(engine, exportStl());
    assert.equal(result.status, 'failed'); assert.equal(result.result.error.outcome, 'partial');
    assert.equal((await engine.artifacts.inspect(prepared.artifact.id)).manifest_sha256, undefined);
  }
});

test('async completion keeps preparation and later source states separate and never promotes pending bytes', async t => {
  const { engine, provider } = await setup(t), { prepared, result } = await execute(engine, render());
  assert.equal(result.status, 'pending');
  const pending = await engine.artifacts.inspect(prepared.artifact.id);
  assert.equal(pending.status, 'pending'); assert.equal(pending.files, undefined); assert.equal(pending.provenance, undefined);
  assert.equal((await engine.store.get('artifact', pending.id)).manifest_sha256, undefined);
  provider.revision++;
  const completed = await engine.jobStatus(result.result.data.job_id, DOCUMENT);
  assert.equal(completed.status, 'succeeded');
  const receipt = await engine.artifacts.inspect(pending.id);
  assert.equal(receipt.provenance.source.state_at_preparation, prepared.expected_state);
  assert.equal(receipt.provenance.source.state_at_completion, provider.state());
  assert.equal(receipt.provenance.source.completion_state_matches_preparation, false);
  assert.equal(receipt.provenance.completion.provider_job_id, FUTURE);
  assert.equal(receipt.provenance.completion.provider_status, 'succeeded');
  assert.match(receipt.provenance.source.scope, /does not prove which intermediate geometry/);
  assert.equal(receipt.files[0].validation.dimensions_match_request, true);
});

test('successful future with wrong dimensions fails artifact validation without a render replay', async t => {
  const provider = new ArtifactProducerDouble(); provider.output = png(1, 1);
  const { engine } = await setup(t, provider), { prepared, result } = await execute(engine, render());
  const job = await engine.jobStatus(result.result.data.job_id, DOCUMENT);
  assert.equal(job.status, 'failed'); assert.equal(job.data.error.code, 'INVALID_ARTIFACT'); assert.equal(job.data.error.outcome, 'partial');
  assert.equal((await engine.artifacts.inspect(prepared.artifact.id)).status, 'failed');
  await engine.jobStatus(job.id); assert.equal(provider.calls.filter(call => call.operation === 'render.start').length, 1);
});

test('missing observations remain unknown and fixture display units are never promoted to internal units', async t => {
  const provider = new ArtifactProducerDouble(); provider.before = { document_id: DOCUMENT, fixture: true, units: { length: 'mm' } };
  provider.outputObservation = () => ({ fixture: true });
  const { engine } = await setup(t, provider), { result } = await execute(engine, capture());
  assert.equal(result.status, 'succeeded');
  const value = result.result.artifact.provenance;
  assert.equal(value.source.cloud, null); assert.equal(value.source.configuration, null); assert.equal(value.source.internal_units, null);
  assert.deepEqual(value.source.reported_units, { length: 'mm', angle: null, mass: null });
  assert.equal(value.producer.fusion_version, null); assert.equal(value.completion.reported_output, null);
  assert.ok(value.unknown_fields.includes('provider_output_hash'));
});

test('actual built-in fixture provider gets synthetic transport provenance on its labeled STEP output', async t => {
  const { engine } = await setup(t, new FixtureDesktopProvider());
  const { result } = await execute(engine, { operation: 'exports.generate', document_id: DOCUMENT, args: { format: 'step', output: { root: 'artifacts', filename: 'fixture.step' } } });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.result.artifact.provenance.producer.provider_kind, 'synthetic_fixture');
  assert.equal(result.result.artifact.provenance.producer.evidence, 'synthetic_fixture');
  assert.match((await readFile(result.result.artifact.path, 'utf8')), /fixture|synthetic/i);
});

test('completed v2 provenance, limitations, validation grade and bytes are immutable', async t => {
  const { engine } = await setup(t), { result } = await execute(engine, capture());
  const receipt = result.result.artifact;
  for (const mutate of [value => { value.provenance.source.configuration.row_id = 'altered'; }, value => { value.limitation = 'Approved for manufacture'; }, value => { value.files[0].validation.width = 999; }, value => { delete value.provenance; }, value => { delete value.manifest_version; }]) {
    const changed = structuredClone(receipt); mutate(changed); await engine.store.put('artifact', receipt.id, changed);
    await assert.rejects(engine.artifacts.inspect(receipt.id), { code: 'ARTIFACT_CHANGED' });
  }
  await engine.store.put('artifact', receipt.id, receipt);
  await writeFile(receipt.path, png(216, 108));
  await assert.rejects(engine.artifacts.inspect(receipt.id), partial('INVALID_ARTIFACT'));
});

test('stored v2 reservation cannot be downgraded while a producer future is pending', async t => {
  const { engine } = await setup(t), { prepared, result } = await execute(engine, render());
  const staged = await engine.store.get('artifact', prepared.artifact.id); delete staged.manifest_version;
  await engine.store.put('artifact', staged.id, staged);
  const job = await engine.jobStatus(result.result.data.job_id, DOCUMENT);
  assert.equal(job.status, 'failed'); assert.equal(job.data.error.code, 'ARTIFACT_PROVENANCE_CHANGED');
  assert.equal((await engine.store.get('artifact', staged.id)).manifest_sha256, undefined);
});

async function pendingCompletion(t) {
  const context = await setup(t), { prepared } = await execute(context.engine, render());
  return { ...context, prepared, completion: { plan_id: prepared.id, plan_hash: prepared.hash, evidence: {
    provider_kind: 'unverified_provider', provider_job_id: FUTURE,
    response: { ok: true, state: context.provider.state(), data: { ...context.provider.outputObservation('png'), job_id: FUTURE, status: 'succeeded' }, effects: [] },
  } } };
}

test('broker-only completion evidence must identify success and the exact observed future/session', async t => {
  for (const mutate of [
    value => { value.evidence.response = { ok: false, error: { code: 'FAILED', message: 'Synthetic failure' } }; },
    value => { value.evidence.response.data.status = 'running'; },
    value => { delete value.evidence.response.data.status; },
    value => { value.evidence.response.data.job_id = 'job_another_future'; },
    value => { value.evidence.diagnostic = { session_id: 'another-session', fusion_version: 'Synthetic version' }; },
    value => { value.evidence.response.data.artifact.sha256 = 'not-a-hash'; },
    value => { value.evidence.response.data.artifact.size_bytes = -1; },
  ]) {
    const { engine, prepared, completion } = await pendingCompletion(t); mutate(completion);
    await assert.rejects(engine.artifacts.complete(prepared.artifact.id, completion), partial('ARTIFACT_PROVENANCE_CHANGED'));
    assert.equal((await engine.artifacts.inspect(prepared.artifact.id)).manifest_sha256, undefined);
  }
});

test('only diagnostics linked to the observed source session supply a Fusion version', async t => {
  for (const session_id of ['synthetic-session', undefined]) {
    const { engine, prepared, completion } = await pendingCompletion(t);
    completion.evidence.diagnostic = { fusion_version: 'Synthetic observed version', ...(session_id ? { session_id } : {}), approved: true };
    const receipt = await engine.artifacts.complete(prepared.artifact.id, completion);
    assert.equal(receipt.provenance.producer.fusion_version, session_id ? 'Synthetic observed version' : null);
    assert.equal(receipt.provenance.producer.independently_verified, false);
    assert.ok(!JSON.stringify(receipt.provenance).includes('approved'));
    assert.equal(receipt.provenance.producer.diagnostic_session_id, session_id ?? null);
  }
});

test('provider evidence has a bounded receipt size and cannot smuggle a large payload into provenance', async t => {
  const { engine, prepared, completion } = await pendingCompletion(t);
  completion.evidence.response.data.unrelated = 'x'.repeat(4_194_304);
  await assert.rejects(engine.artifacts.complete(prepared.artifact.id, completion), partial('INPUT_LIMIT'));
  assert.equal((await engine.artifacts.inspect(prepared.artifact.id)).provenance, undefined);
});

test('stored producer selectors/options must still match its observed source and reservation', async t => {
  for (const mutate of [
    plan => { plan.provider_args.quality = 'excellent'; },
    plan => { plan.before.document_id = 'fixture:another-document'; },
    plan => { plan.operation.args.output.filename = 'another.png'; },
    plan => { plan.profile_hash = '0'.repeat(64); },
  ]) {
    const { engine, prepared, completion } = await pendingCompletion(t), plan = await engine.store.get('plan', prepared.id);
    mutate(plan); await engine.store.put('plan', plan.id, plan);
    await assert.rejects(engine.artifacts.complete(prepared.artifact.id, completion), partial('ARTIFACT_PROVENANCE_CHANGED'));
    assert.equal((await engine.artifacts.inspect(prepared.artifact.id)).files, undefined);
  }
});

test('completion recomputes the whole producer binding before recording source provenance', async t => {
  for (const [name, mutate] of [
    ['cloud version', plan => { plan.before.cloud.version_id = 'synthetic-forged-source-version'; }],
    ['configuration row', plan => { plan.before.configuration.row_id = 'synthetic-forged-row'; }],
    ['handler', plan => { plan.handler_hash = 'e'.repeat(64); }],
    ['execution contract', plan => { plan.execution_contract_hash = 'f'.repeat(64); }],
    ['matching changed selectors', plan => { plan.provider_args.quality = 'excellent'; plan.operation.args.quality = 'excellent'; }]
  ]) await t.test(name, async t => {
    const { engine, prepared, completion } = await pendingCompletion(t);
    const plan = await engine.store.get('plan', prepared.id), originalHash = plan.hash;
    mutate(plan); await engine.store.put('plan', plan.id, plan);
    assert.equal(plan.hash, originalHash);
    await assert.rejects(engine.artifacts.complete(prepared.artifact.id, completion), partial('ARTIFACT_PROVENANCE_CHANGED'));
    const artifact = await engine.artifacts.inspect(prepared.artifact.id, true);
    assert.equal(artifact.provenance, undefined);
    assert.equal(artifact.manifest_sha256, undefined);
    assert.equal(artifact.files, undefined);
  });
});

test('model-facing operation inputs cannot supply observed producer or approval metadata', () => {
  for (const field of ['provenance', 'evidence', 'approval', 'fusion_version', 'provider_kind', 'handler_sha256']) {
    const operation = capture(); operation.args[field] = 'untrusted';
    assert.throws(() => parseOperation(operation), { code: 'INVALID_INPUT' });
  }
});

test('completed legacy receipt keeps its exact original hash and validation grade without rewriting', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fusion-artifact-v1-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const profile = fixtureProfile(directory), store = new RecordStore(directory), manager = new ArtifactManager(profile, store);
  const reservation = manager.reserve({ root: 'artifacts', filename: 'legacy.png' }, 'png');
  delete reservation.manifest_version; reservation.plan_id = 'plan_legacy';
  const staged = await manager.stage(reservation), bytes = png(1, 1);
  // Version 1 did not check chunk CRCs. Preserve that historical grade rather
  // than pretending a read has requalified the file against version 2.
  bytes[29] ^= 1;
  await writeFile(staged.path, bytes);
  const receipt = { ...staged, status: 'succeeded', completed_at: '2026-08-01T00:00:00.000Z', producer_plan_hash: hash('legacy producer'), files: [{ name: 'legacy.png', size: bytes.length, sha256: hashBytes(bytes), media_type: 'image/png', checks: ['regular_file', 'nonempty', 'sha256', 'format_signature'] }], limitation: 'Original signature-only grade.' };
  receipt.manifest_sha256 = hash({ version: 1, id: receipt.id, root: receipt.root, filename: receipt.filename, format: receipt.format, plan_id: receipt.plan_id, producer_plan_hash: receipt.producer_plan_hash, completed_at: receipt.completed_at, files: receipt.files });
  await store.put('artifact', receipt.id, receipt);
  const filename = path.join(directory, `artifact--${receipt.id}.json`), original = await readFile(filename);
  assert.deepEqual(await manager.inspect(receipt.id), receipt);
  assert.deepEqual(await readFile(filename), original, 'Read-only verification must not migrate the receipt');
  assert.equal((await manager.inspect(receipt.id)).files[0].validation, undefined);
  const changed = structuredClone(receipt); changed.files[0].validation = validatePngContent(png(1, 1));
  await store.put('artifact', receipt.id, changed);
  await assert.rejects(manager.inspect(receipt.id), { code: 'ARTIFACT_CHANGED' });
});
