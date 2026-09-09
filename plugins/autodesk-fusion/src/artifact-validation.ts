import { FusionError } from './safety.js';

// These are parser admission limits, not claims about Fusion's format limits.
const MAX_BYTES = 256_000_000;
const MAX_PNG_CHUNKS = 100_000;
const MAX_PNG_PIXELS = 64_000_000;
const MAX_STL_TRIANGLES = 5_000_000;
const MAX_STL_LINE = 1024;

export interface PngExpectation { width: number; height: number }
export interface PngValidation {
  validator: 'png_container_v1'; width: number; height: number; chunk_count: number;
  requested_dimensions: PngExpectation | null; dimensions_match_request: boolean | null;
  pixel_data_decoded: false; animation_chunks_present: boolean;
  scope: string;
}
export interface StlValidation {
  validator: 'stl_triangles_v1'; encoding: 'binary' | 'ascii'; triangle_count: number;
  bounds: { min: number[]; max: number[]; unit: 'file_coordinates_without_embedded_unit' };
  nonzero_attribute_word_count: number; normal_check: 'finite_components_only';
  topology_checked: false; scope: string;
}
export type ArtifactContentValidation = PngValidation | StlValidation;

function invalid(message: string): never { throw new FusionError('INVALID_ARTIFACT', message, 'partial'); }
function limit(message: string): never { throw new FusionError('ARTIFACT_LIMIT', message, 'partial'); }
function input(bytes: Buffer): void {
  if (!Buffer.isBuffer(bytes) || !bytes.length) invalid('Artifact content must be a nonempty byte buffer.');
  if (bytes.length > MAX_BYTES) limit('Artifact content exceeds the 256 MB parser bound.');
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Buffer, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]!) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Validate the PNG container and IHDR dimensions without inflating image/text data.
 * Source: https://www.w3.org/TR/png-3/ (critical chunks, CRC and IHDR).
 * A passing result deliberately does not attest decoded pixels or appearance.
 */
export function validatePngContent(bytes: Buffer, expected?: PngExpectation): PngValidation {
  input(bytes);
  if (expected && (!Number.isSafeInteger(expected.width) || expected.width < 1 || !Number.isSafeInteger(expected.height) || expected.height < 1)) invalid('Requested PNG dimensions are invalid.');
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) invalid('PNG signature or minimum container length is invalid.');
  let cursor = 8, chunks = 0, width = 0, height = 0, bitDepth = 0, colorType = -1;
  let palette = false, idat = false, afterIdat = false, compressedBytes = 0, ended = false, animation = false;
  while (cursor < bytes.length) {
    if (++chunks > MAX_PNG_CHUNKS) limit('PNG exceeds the bounded chunk count.');
    if (bytes.length - cursor < 12) invalid('PNG has a truncated chunk.');
    const length = bytes.readUInt32BE(cursor);
    if (length > 0x7fffffff || length > bytes.length - cursor - 12) invalid('PNG chunk length escapes the file.');
    const typeBytes = bytes.subarray(cursor + 4, cursor + 8);
    if (typeBytes.some(value => !((value >= 65 && value <= 90) || (value >= 97 && value <= 122)))) invalid('PNG chunk type contains a non-letter byte.');
    const type = typeBytes.toString('ascii');
    if (type[2] !== type[2]!.toUpperCase()) invalid('PNG chunk type reserved bit is invalid.');
    const start = cursor + 8, end = start + length;
    if (crc32(bytes, cursor + 4, end) !== bytes.readUInt32BE(end)) invalid('PNG chunk CRC does not match its bytes.');
    if (chunks === 1 && type !== 'IHDR') invalid('PNG must begin with IHDR.');
    if (type === 'IHDR') {
      if (chunks !== 1 || length !== 13) invalid('PNG must have one 13-byte IHDR.');
      width = bytes.readUInt32BE(start); height = bytes.readUInt32BE(start + 4);
      bitDepth = bytes[start + 8]!; colorType = bytes[start + 9]!;
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || width > 0x7fffffff || height > 0x7fffffff || !depths[colorType]?.includes(bitDepth) || bytes[start + 10] !== 0 || bytes[start + 11] !== 0 || ![0, 1].includes(bytes[start + 12]!)) invalid('PNG IHDR dimensions or coding fields are invalid.');
      if (width * height > MAX_PNG_PIXELS) limit('PNG exceeds the 64-million-pixel admission bound.');
      if (expected && (width !== expected.width || height !== expected.height)) invalid('PNG dimensions differ from the bound producer request.');
    } else if (type === 'PLTE') {
      if (palette || idat || length === 0 || length % 3 !== 0 || length > 768 || [0, 4].includes(colorType) || (colorType === 3 && length / 3 > 2 ** bitDepth)) invalid('PNG palette is invalid or out of order.');
      palette = true;
    } else if (type === 'IDAT') {
      if (afterIdat || (colorType === 3 && !palette)) invalid('PNG image data is nonconsecutive or lacks its required palette.');
      idat = true; compressedBytes += length;
    } else if (type === 'IEND') {
      if (length !== 0 || !idat || compressedBytes === 0 || end + 4 !== bytes.length) invalid('PNG trailer or image-data framing is invalid.');
      ended = true;
    } else {
      if (type[0] === type[0]!.toUpperCase()) invalid('PNG contains an unsupported critical chunk.');
      if (['acTL', 'fcTL', 'fdAT'].includes(type)) animation = true;
    }
    if (idat && type !== 'IDAT') afterIdat = true;
    cursor = end + 4;
  }
  if (!ended) invalid('PNG lacks a terminal IEND chunk.');
  return { validator: 'png_container_v1', width, height, chunk_count: chunks,
    requested_dimensions: expected ? { ...expected } : null, dimensions_match_request: expected ? true : null,
    pixel_data_decoded: false, animation_chunks_present: animation,
    scope: 'Container, CRC and declared pixel dimensions only; compressed pixels/metadata, animation semantics and visual correctness are not decoded or verified.' };
}

class StlBounds {
  min = [Infinity, Infinity, Infinity];
  max = [-Infinity, -Infinity, -Infinity];
  vertex(values: number[]): void {
    for (let axis = 0; axis < 3; axis++) {
      const value = values[axis]!;
      if (!Number.isFinite(value)) invalid('STL contains a nonfinite vertex coordinate.');
      this.min[axis] = Math.min(this.min[axis]!, value); this.max[axis] = Math.max(this.max[axis]!, value);
    }
  }
}

function stlResult(encoding: 'binary' | 'ascii', triangles: number, bounds: StlBounds, attributes = 0): StlValidation {
  if (!triangles) invalid('STL contains no triangular facets.');
  return { validator: 'stl_triangles_v1', encoding, triangle_count: triangles,
    bounds: { min: bounds.min, max: bounds.max, unit: 'file_coordinates_without_embedded_unit' },
    nonzero_attribute_word_count: attributes, normal_check: 'finite_components_only', topology_checked: false,
    scope: 'Bounded triangular record grammar and finite numbers only; normal direction/unit length, degenerate facets, winding, watertightness, intersections, embedded attribute/color conventions and source-shape equivalence are not verified.' };
}

function binaryStl(bytes: Buffer, triangles: number): StlValidation {
  if (triangles > MAX_STL_TRIANGLES) limit('STL exceeds the five-million-triangle admission bound.');
  const bounds = new StlBounds(); let attributes = 0;
  for (let i = 0, offset = 84; i < triangles; i++, offset += 50) {
    for (let n = 0; n < 3; n++) if (!Number.isFinite(bytes.readFloatLE(offset + n * 4))) invalid('STL contains a nonfinite normal component.');
    for (let vertex = 0; vertex < 3; vertex++) {
      const start = offset + 12 + vertex * 12;
      bounds.vertex([bytes.readFloatLE(start), bytes.readFloatLE(start + 4), bytes.readFloatLE(start + 8)]);
    }
    if (bytes.readUInt16LE(offset + 48) !== 0) attributes++;
  }
  return stlResult('binary', triangles, bounds, attributes);
}

function* asciiLines(bytes: Buffer): Generator<string> {
  let start = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i - start > MAX_STL_LINE) limit('ASCII STL exceeds the 1024-byte line bound.');
    if (i === bytes.length || bytes[i] === 10 || bytes[i] === 13) {
      const line = bytes.toString('ascii', start, i).trim();
      if (line) yield line;
      if (bytes[i] === 13 && bytes[i + 1] === 10) i++;
      start = i + 1;
    } else if (bytes[i] !== 9 && (bytes[i]! < 32 || bytes[i]! > 126)) invalid('ASCII STL contains non-ASCII or control bytes.');
  }
}

function stlNumber(token: string): number {
  if (token.length > 128) limit('ASCII STL numeric token exceeds its bound.');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(token)) invalid('ASCII STL contains a malformed numeric token.');
  const value = Number(token);
  if (!Number.isFinite(value)) invalid('ASCII STL contains a nonfinite number.');
  return value;
}

function asciiStl(bytes: Buffer): StlValidation {
  const lines = asciiLines(bytes), bounds = new StlBounds();
  const next = (): string => { const line = lines.next(); if (line.done) invalid('ASCII STL ended inside its triangular record grammar.'); return line.value; };
  if (!/^solid(?:\s.*)?$/.test(next())) invalid('ASCII STL must begin with a solid record.');
  let triangles = 0;
  for (;;) {
    const line = next();
    if (/^endsolid(?:\s.*)?$/.test(line)) {
      if (!lines.next().done) invalid('ASCII STL has data after its single endsolid record.');
      break;
    }
    const normal = line.split(/\s+/);
    if (normal.length !== 5 || normal[0] !== 'facet' || normal[1] !== 'normal') invalid('ASCII STL requires a facet normal record with three components.');
    normal.slice(2).forEach(stlNumber);
    if (!/^outer\s+loop$/.test(next())) invalid('ASCII STL requires one outer loop per facet.');
    for (let i = 0; i < 3; i++) {
      const vertex = next().split(/\s+/);
      if (vertex.length !== 4 || vertex[0] !== 'vertex') invalid('ASCII STL requires exactly three vertices per facet.');
      bounds.vertex(vertex.slice(1).map(stlNumber));
    }
    if (next() !== 'endloop' || next() !== 'endfacet') invalid('ASCII STL facet terminators are invalid.');
    if (++triangles > MAX_STL_TRIANGLES) limit('STL exceeds the five-million-triangle admission bound.');
  }
  return stlResult('ascii', triangles, bounds);
}

/** STL has both ASCII and fixed-record binary encodings; header text is not magic.
 * https://www.iana.org/assignments/media-types/model/stl
 * No mesh-sized arrays, archive extraction or geometry repair are performed.
 */
export function validateStlContent(bytes: Buffer): StlValidation {
  input(bytes);
  if (bytes.length >= 84) {
    const triangles = bytes.readUInt32LE(80);
    if (84 + triangles * 50 === bytes.length) return binaryStl(bytes, triangles);
  }
  return asciiStl(bytes);
}
