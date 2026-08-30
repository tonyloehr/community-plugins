import { writeFile } from 'node:fs/promises';
import type { DesktopProvider, DesktopRequest, DesktopResponse } from './types.js';
import { parseOperation } from './catalog.js';
import { FusionError, errorResult, hash } from './safety.js';
import { RecordStore } from './storage.js';

interface FixtureState { revision: number; parameters: Record<string, { expression: string; value_mm: number }>; saved: boolean }
const initial = (): FixtureState => ({ revision: 1, parameters: { width: { expression: '40 mm', value_mm: 40 }, height: { expression: '20 mm', value_mm: 20 }, thickness: { expression: '5 mm', value_mm: 5 } }, saved: false });
function evaluate(expression: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(mm|cm|m|in)\s*$/.exec(expression);
  if (!match) throw new FusionError('INVALID_EXPRESSION', 'The fixture accepts positive literal lengths with mm/cm/m/in; real Fusion expressions are evaluated by Fusion.');
  const value = Number(match[1]) * ({ mm: 1, cm: 10, m: 1000, in: 25.4 }[match[2]!] ?? 0);
  if (!Number.isFinite(value) || value <= 0 || value > 1_000_000) throw new FusionError('INVALID_EXPRESSION', 'The fixture dimension must be positive and bounded.');
  return value;
}
export class FixtureDesktopProvider implements DesktopProvider {
  readonly kind = 'synthetic_fixture';
  readonly supported = ['documents.list', 'document.inspect', 'parameters.list', 'parameters.set', 'parameters.add', 'entities.find', 'geometry.measure', 'geometry.check', 'exports.generate', 'cam.inspect'];
  private current: FixtureState = initial();
  constructor(private store?: RecordStore) {}
  private state(): string { return hash({ fixture_schema: 1, ...this.current }); }
  async dispatch(request: DesktopRequest): Promise<DesktopResponse> {
    try {
      if (this.store) this.current = await this.store.get<FixtureState>('fixture', 'bracket') ?? initial();
      if (!this.supported.includes(request.operation)) throw new FusionError('FIXTURE_UNSUPPORTED', 'This synthetic fixture does not simulate that operation. It has not called Autodesk.');
      if (request.operation !== 'documents.list' && request.document_id !== 'fixture:bracket') throw new FusionError('DOCUMENT_NOT_FOUND', 'Select fixture:bracket.');
      const before = this.state();
      if (request.expected_state && request.expected_state !== before) throw new FusionError('STALE_STATE', 'The fixture changed since inspection.');
      let data: unknown;
      const p = this.current.parameters;
      switch (request.operation) {
        case 'documents.list': data = { documents: [{ document_id: 'fixture:bracket', name: 'Synthetic bracket', saved: this.current.saved, is_active: true, product_type: 'DesignProductType' }], next_cursor: null }; break;
        case 'document.inspect': data = { document_id: 'fixture:bracket', name: 'Synthetic bracket', fixture: true, units: { length: 'mm', angle: 'rad' }, parameters: Object.entries(p).map(([name, v]) => ({ id: `fixture:param:${name}`, name, ...v })), body_count: 1, feature_health: 'healthy', saved: this.current.saved }; break;
        case 'parameters.list': {
          const args = parseOperation({ operation: request.operation, document_id: request.document_id, args: request.args }).args;
          const limit = (args.limit as number | undefined) ?? 100;
          // Canonical ordering survives RecordStore's key normalization. This
          // synthetic ordering is not a promise about Fusion collection order.
          const names = Object.keys(p).sort();
          data = { parameters: names.slice(0, limit).map(name => ({ id: `fixture:param:${name}`, name, ...p[name] })),
            total: names.length, truncated: names.length > limit,
            units_note: 'Synthetic numeric lengths are in millimetres; no Fusion unit conversion has run.' }; break;
        }
        case 'parameters.set': {
          if (!request.expected_state) throw new FusionError('EXPECTED_STATE_REQUIRED', 'Mutations require a source state.');
          const changes = request.args.changes as Array<{ parameter_id: string; expression: string }>;
          const pending = changes.map(change => {
            const name = change.parameter_id.replace(/^fixture:param:/, '');
            if (!p[name] || change.parameter_id !== `fixture:param:${name}`) throw new FusionError('ENTITY_NOT_FOUND', 'Unknown fixture parameter.');
            return { name, expression: change.expression, value_mm: evaluate(change.expression) };
          });
          if (new Set(pending.map(v => v.name)).size !== pending.length) throw new FusionError('DUPLICATE_PARAMETER', 'A parameter may appear only once in a batch.');
          for (const change of pending) p[change.name] = { expression: change.expression, value_mm: change.value_mm };
          this.current.revision++; this.current.saved = false; data = { changed: pending, atomic: true }; break;
        }
        case 'parameters.add': {
          if (!request.expected_state) throw new FusionError('EXPECTED_STATE_REQUIRED', 'Mutations require a source state.');
          const name = request.args.name as string;
          if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || p[name]) throw new FusionError('INVALID_PARAMETER', 'Fixture parameter name is invalid or already exists.');
          const expression = request.args.expression as string;
          p[name] = { expression, value_mm: evaluate(expression) }; this.current.revision++; data = { id: `fixture:param:${name}` }; break;
        }
        case 'entities.find': {
          const args = parseOperation({ operation: request.operation, document_id: request.document_id, args: request.args }).args;
          const limit = (args.limit as number | undefined) ?? 100, offset = (args.offset as number | undefined) ?? 0;
          if (args.kind === 'parameter' && args.parent_id !== undefined) throw new FusionError('INVALID_ARGUMENT', 'Parameter discovery is scoped by document.');
          if (!['body', 'parameter'].includes(args.kind as string) || args.parent_id !== undefined) throw new FusionError('FIXTURE_UNSUPPORTED', 'This fixture simulates only document-scoped body and parameter discovery.');
          let entities = args.kind === 'body' ? [{ entity_id: 'fixture:body:bracket', name: 'Bracket', kind: 'body' }] : Object.keys(p).sort().map(name => ({ entity_id: `fixture:param:${name}`, name, kind: 'parameter' }));
          if (args.name !== undefined) entities = entities.filter(entity => entity.name === args.name);
          data = { entities: entities.slice(offset, offset + limit), total: entities.length, offset,
            next_offset: offset + limit < entities.length ? offset + limit : null,
            name_filter_semantics: 'Exact discovery filter only; mutations require opaque handles' }; break;
        }
        case 'geometry.measure': {
          if ((request.args.entity_ids as string[]).some(id => id !== 'fixture:body:bracket')) throw new FusionError('ENTITY_NOT_FOUND', 'Unknown fixture body.');
          if (!['physical', 'bounding_box'].includes(request.args.kind as string)) throw new FusionError('FIXTURE_UNSUPPORTED', 'This fixture does not simulate that measurement.');
          const [width, height, thickness] = ['width', 'height', 'thickness'].map(name => p[name]!.value_mm);
          data = { analytic_fixture: true, volume: { value: width! * height! * thickness!, unit: 'mm^3' }, bounding_box: { min: [0, 0, 0], max: [width, height, thickness], unit: 'mm', frame: 'component' } }; break;
        }
        case 'geometry.check': data = { checks: [{ name: 'synthetic_parameter_bounds', status: 'passed' }], limitations: ['No Autodesk kernel, interference, manufacturability or solver has been run.'] }; break;
        case 'cam.inspect': data = { setups: [], limitations: ['The fixture contains no CAM setup.'] }; break;
        case 'exports.generate': {
          if (request.args.format !== 'step') throw new FusionError('FIXTURE_UNSUPPORTED', 'The fixture emits only a labeled STEP protocol sample, not model geometry.');
          await writeFile(request.args.output_path as string, "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('SYNTHETIC PROTOCOL FIXTURE - NOT CAD GEOMETRY'),'2;1');\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n", { flag: 'wx', mode: 0o600 });
          data = { fixture: true, geometry_validated: false }; break;
        }
      }
      if (this.store && before !== this.state()) await this.store.put('fixture', 'bracket', this.current);
      return { ok: true, data: { ...(data as Record<string, unknown>), provider: 'synthetic_fixture', live_fusion_verified: false }, state: this.state(), effects: before !== this.state() ? ['synthetic_fixture_changed'] : [] };
    } catch (error) {
      const e = errorResult(error);
      return { ok: false, error: { ...e, outcome: e.outcome as 'none' | 'partial' | 'unknown' } };
    }
  }
}
