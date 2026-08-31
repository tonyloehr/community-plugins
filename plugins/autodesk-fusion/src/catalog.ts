import { z } from 'zod/v4';
import { FusionError, assertJson } from './safety.js';
import type { OperationDefinition, OperationInput } from './types.js';

const text = z.string().min(1).max(4096);
const ref = z.string().min(1).max(128);
const cloudRef = z.string().min(1).max(2048);
const libraryRef = z.string().min(1).max(1024);
const assetRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const name = z.string().min(1).max(256);
const expression = z.string().min(1).max(512);
const camExpression = z.string().min(1).max(1024);
const millingStrategy = z.enum(['face', 'adaptive', 'parallel']);
const limit = z.number().int().min(1).max(100).optional();
const offset = z.number().int().min(0).max(10_000).optional();
const refs = z.array(ref).min(1).max(100);
const point2 = z.tuple([expression, expression]);
const point3 = z.tuple([expression, expression, expression]);
const unit = z.enum(['mm', 'cm', 'm', 'in']);
const output = z.strictObject({ root: assetRef, filename: z.string().min(1).max(160) });
const transform = z.strictObject({ frame: z.literal('parent'), matrix: z.array(z.number().finite()).length(16), translation_unit: unit });
const operation = z.enum(['new_body', 'join', 'cut', 'intersect']);
const typedCamParameter = z.discriminatedUnion('type', [
  z.strictObject({ name, type: z.literal('expression'), value: camExpression }),
  z.strictObject({ name, type: z.literal('string'), value: z.string().max(4096) }),
  z.strictObject({ name, type: z.literal('boolean'), value: z.boolean() }),
  z.strictObject({ name, type: z.literal('integer'), value: z.number().int().min(-2147483648).max(2147483647) }),
  z.strictObject({ name, type: z.literal('float'), value: z.number().finite() }),
  z.strictObject({ name, type: z.literal('choice'), value: text }),
  z.strictObject({ name, type: z.literal('selection'), value: refs })
]);
type Entry = OperationDefinition & { schema: z.ZodType; document: boolean };
const entries: Entry[] = [];
function add(id: string, title: string, effect: OperationDefinition['effect'], schema: z.ZodType, api: string, options: Partial<Pick<Entry, 'document' | 'maturity' | 'cancellation' | 'notes' | 'implemented'>> = {}): void {
  entries.push({ id, title, family: id.split('.')[0]!, effect, schema, provider: 'desktop', maturity: 'released', implemented: true, document: true, cancellation: 'not_applicable', source: `https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/${api}.htm`, ...options });
}
add('documents.list', 'List open documents and session identity', 'read', z.strictObject({ limit: z.number().int().min(1).max(256).optional() }), 'Documents', { document: false });
add('documents.import', 'Import a reviewed STEP or F3D source into a new document', 'local_edit', z.strictObject({ format: z.enum(['step', 'f3d']), source: z.strictObject({ kind: z.enum(['asset', 'artifact']), id: assetRef }) }), 'ImportManager_importToNewDocument', { document: false, notes: 'Runs the Autodesk parser in the Fusion process. A new document is not a parser security sandbox; only explicitly trusted inputs are allowed.' });
add('documents.create', 'Create an unsaved Fusion design', 'local_edit', z.strictObject({ name: name.optional() }), 'Documents_add', { document: false });
add('documents.open', 'Open an explicitly pinned cloud file', 'local_edit', z.strictObject({ data_file_id: cloudRef, expected_version_id: cloudRef }), 'Documents_open', { document: false });
add('documents.activate', 'Activate the selected open document', 'local_edit', z.strictObject({}), 'Document_activate');
add('documents.close', 'Close an unmodified document without discarding edits', 'local_edit', z.strictObject({ discard_unsaved: z.literal(false) }), 'Document_close');
add('documents.save', 'Save the selected state to Autodesk cloud storage', 'cloud_write', z.strictObject({ description: z.string().max(2048), name: name.optional(), folder_id: cloudRef.optional() }), 'Document_save', { notes: 'Save acknowledgement is not cloud translation/index completion.' });
add('document.inspect', 'Inspect structure, units, state and feature health', 'read', z.strictObject({ limit }), 'Design');
add('bom.inspect', 'Inspect the desktop occurrence structure and explicit BOM limitations', 'read', z.strictObject({ limit, offset, include_suppressed: z.boolean().optional() }), 'Component_allOccurrences', { notes: 'Desktop occurrence structure does not imply MFGDM BOM override quantities or released PLM authority.' });
add('parameters.list', 'List user and model parameters', 'read', z.strictObject({ kind: z.enum(['user', 'all']).default('user'), limit }), 'Design_allParameters');
add('parameters.set', 'Atomically update a batch of parameter expressions', 'local_edit', z.strictObject({ changes: z.array(z.strictObject({ parameter_id: ref, expression })).min(1).max(200) }), 'Design_modifyParameters');
add('parameters.add', 'Add a named user parameter', 'local_edit', z.strictObject({ name: z.string().min(1).max(128), expression, unit: z.string().max(64), comment: z.string().max(2048).optional() }), 'UserParameters_add');
add('entities.find', 'Resolve bounded typed entity candidates', 'read', z.strictObject({ kind: z.enum(['component', 'occurrence', 'body', 'face', 'edge', 'sketch', 'profile', 'parameter', 'feature', 'sketch_line', 'sketch_circle', 'sketch_point', 'construction_axis', 'construction_plane']), parent_id: ref.optional(), name: name.optional(), limit, offset }), 'Design_findEntityByToken');
add('geometry.measure', 'Measure physical properties, bounds, distances or angles', 'read', z.strictObject({ entity_ids: refs, kind: z.enum(['physical', 'distance', 'angle', 'bounding_box']), accuracy: z.enum(['low', 'medium', 'high', 'very_high']).optional() }), 'MeasureManager');
add('geometry.check', 'Inspect feature health or static interference', 'read', z.strictObject({ kind: z.enum(['health', 'interference']), entity_ids: z.array(ref).min(1).max(50).optional() }), 'Design_analyzeInterference');
add('sketches.create', 'Create a sketch on an explicit plane', 'local_edit', z.strictObject({ component_id: ref.optional(), plane: z.union([z.enum(['xy', 'xz', 'yz']), z.strictObject({ entity_id: ref })]), name: name.optional() }), 'Sketches_add');
add('sketches.draw', 'Draw unit-aware sketch curves', 'local_edit', z.strictObject({ sketch_id: ref, frame: z.literal('sketch'), curves: z.array(z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('line'), start: point2, end: point2 }),
  z.strictObject({ kind: z.literal('circle'), center: point2, radius: expression }),
  z.strictObject({ kind: z.literal('rectangle'), corner1: point2, corner2: point2 })
])).min(1).max(100) }), 'SketchCurves');
const dimensionCommon = { sketch_id: ref, orientation: z.enum(['horizontal', 'vertical', 'aligned']).optional(), text_position: point2, expression };
add('sketches.dimension', 'Add a driving sketch dimension', 'local_edit', z.discriminatedUnion('kind', [
  z.strictObject({ ...dimensionCommon, kind: z.literal('distance'), entity_ids: z.tuple([ref, ref]) }),
  z.strictObject({ ...dimensionCommon, kind: z.enum(['diameter', 'radial']), entity_ids: z.tuple([ref]) })
]), 'SketchDimensions', { notes: 'Distance takes two sketch point IDs; diameter/radial take one sketch circle ID from the exact selected sketch.' });
add('sketches.constrain', 'Apply explicit typed geometric sketch constraints', 'local_edit', z.strictObject({ sketch_id: ref, constraints: z.array(z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(['horizontal', 'vertical']), entity_ids: z.tuple([ref]) }),
  z.strictObject({ kind: z.enum(['coincident', 'parallel', 'perpendicular', 'collinear', 'concentric', 'equal', 'tangent', 'midpoint', 'horizontal_points', 'vertical_points']), entity_ids: z.tuple([ref, ref]) })
])).min(1).max(100) }), 'GeometricConstraints');
add('features.extrude', 'Create a parametric extrude feature', 'local_edit', z.strictObject({ profile_ids: refs, distance: expression, operation, participant_body_ids: refs.optional(), name: name.optional() }), 'ExtrudeFeatures');
add('features.revolve', 'Create a parametric revolve feature', 'local_edit', z.strictObject({ profile_ids: refs, axis_id: ref, angle: expression, operation, participant_body_ids: refs.optional(), name: name.optional() }), 'RevolveFeatures');
add('construction_planes.offset', 'Create a parametric offset construction plane', 'local_edit', z.strictObject({ plane_id: ref, distance: expression, name: name.optional() }), 'ConstructionPlaneInput_setByOffset', { notes: 'Uses a native construction plane or planar face in the same editable component. Signed, unit-aware offset; no design-mode conversion or implicit occurrence transform.' });
add('features.sweep', 'Sweep one closed sketch profile along an explicit open path', 'local_edit', z.strictObject({ profile_id: ref, path_entity_ids: refs, operation, participant_body_ids: refs.optional(), name: name.optional() }), 'SweepFeatures_createInput', { notes: 'Solid full-path sweep, perpendicular orientation, zero twist/taper, no guides. Native sketch lines or BRep edges only; exact path membership is checked without automatic chain expansion. Fusion determines connected path order. Cut/intersect require explicit bodies; join requires a single-body component.' });
add('features.loft', 'Loft ordered closed sketch profiles into a solid', 'local_edit', z.strictObject({ profile_ids: z.array(ref).min(2).max(20), operation, participant_body_ids: refs.optional(), name: name.optional() }), 'LoftSections_add', { notes: 'Two to twenty ordered native computed sketch profiles in one component; solid, nonclosed loft with free section conditions and no rails. Cut/intersect require explicit bodies; join requires a single-body component.' });
add('features.draft', 'Apply a single-angle draft to explicitly selected solid-body faces', 'local_edit', z.strictObject({ face_ids: refs, plane_id: ref, angle: expression, symmetric: z.boolean().optional(), direction_flipped: z.boolean().optional(), tangent_chain: z.boolean().optional(), name: name.optional() }), 'DraftFeatures_createInput', { notes: 'Faces must belong to one persistent solid body. Signed, nonzero angle with magnitude below 90 degrees is a plugin limit. Flags default false; tangent chaining may include connected faces and symmetric mode splits at the parting plane. Fusion uses the first face pointOnFace, not a caller-picked point; angle sign and direction flip jointly control direction.' });
add('features.split_body', 'Split selected solid bodies with an explicit native cutting tool', 'local_edit', z.strictObject({ body_ids: refs, splitting_tool_id: ref, extend_tool: z.boolean(), name: name.optional() }), 'SplitBodyFeatures_createInput', { notes: 'Same-component persistent solid targets and a construction plane, planar face or persistent surface-body cutter. Extension is explicit and may not succeed. No copy of unsplit originals, deletion of pieces or guaranteed resulting body count; multiple targets are not an atomic transaction.' });
add('features.mirror', 'Mirror solid bodies as separate parametric bodies', 'local_edit', z.strictObject({ body_ids: refs, plane_id: ref, name: name.optional() }), 'MirrorFeatures_createInput', { notes: 'Same-component persistent native solid bodies and a construction plane or planar face. isCombine is always false: originals remain, mirrored bodies stay separate, and overlap is possible. Feature/occurrence mirrors and implicit joins are outside this variant.' });
add('features.hole', 'Create blind holes on a planar face', 'local_edit', z.strictObject({ face_id: ref, frame: z.literal('component'), positions: z.array(point3).min(1).max(50), diameter: expression, depth: expression }), 'HoleFeatures');
add('features.fillet', 'Fillet selected edge sets', 'local_edit', z.strictObject({ edge_ids: refs, radius: expression, tangent_chain: z.boolean().optional() }), 'FilletFeatures');
add('features.chamfer', 'Chamfer selected edge sets', 'local_edit', z.strictObject({ edge_ids: refs, distance: expression, tangent_chain: z.boolean().optional() }), 'ChamferFeatures_createInput2');
add('features.shell', 'Shell selected body faces', 'local_edit', z.strictObject({ face_ids: refs, thickness: expression }), 'ShellFeatures');
add('features.combine', 'Combine explicitly selected bodies', 'local_edit', z.strictObject({ target_id: ref, tool_ids: refs, operation: z.enum(['join', 'cut', 'intersect']), keep_tools: z.boolean().optional() }), 'CombineFeatures');
add('features.pattern', 'Create a circular BRep body pattern', 'local_edit', z.strictObject({ entity_ids: refs, axis_id: ref, quantity: expression, angle: expression, symmetric: z.boolean().optional() }), 'CircularPatternFeatures', { notes: 'This reviewed variant patterns BRep bodies; feature and occurrence patterns require separate handlers.' });
add('components.create', 'Create an occurrence with a new component', 'local_edit', z.strictObject({ parent_component_id: ref.optional(), name, transform: transform.optional() }), 'Occurrences_addNewComponent');
add('components.insert', 'Insert an explicitly versioned external component', 'local_edit', z.strictObject({ parent_component_id: ref.optional(), data_file_id: cloudRef, expected_version_id: cloudRef, is_referenced: z.literal(true), transform }), 'Occurrences_addByInsert');
add('components.transform', 'Change an occurrence transform in its parent frame', 'local_edit', z.strictObject({ occurrence_id: ref, transform }), 'Occurrence_transform2');
add('joints.create', 'Create an as-built rigid joint', 'local_edit', z.strictObject({ component_id: ref.optional(), occurrence_ids: z.tuple([ref, ref]), kind: z.literal('rigid') }), 'AsBuiltJoints');
add('configurations.list', 'Inspect configuration rows and editability', 'read', z.strictObject({}), 'ConfigurationTopTable');
add('configurations.activate', 'Activate an existing configuration row', 'local_edit', z.strictObject({ row_id: name }), 'ConfigurationRow_activate');
add('materials.list', 'Inspect available materials', 'read', z.strictObject({ library_id: libraryRef.optional(), limit, offset }), 'MaterialLibraries');
add('materials.assign', 'Assign a pinned physical material definition', 'local_edit', z.strictObject({ entity_id: ref, library_id: libraryRef, material_id: libraryRef, expected_material_sha256: z.string().regex(/^[a-f0-9]{64}$/) }), 'BRepBody_material', { notes: 'Use the current engineering_sha256 from materials.list; same-ID library property changes invalidate assignment.' });
add('exports.generate', 'Export STEP, STL or a local Fusion archive', 'local_artifact', z.strictObject({ format: z.enum(['step', 'stl', 'f3d']), output, entity_id: ref.optional(), unit: unit.optional(), mesh_refinement: z.enum(['low', 'medium', 'high']).optional() }), 'ExportManager');
add('drawings.export_pdf', 'Export all sheets of an existing drawing', 'local_artifact', z.strictObject({ output, all_sheets: z.literal(true) }), 'DrawingExportManager');
add('view.capture', 'Capture the current viewport without changing fit', 'local_artifact', z.strictObject({ output, width: z.number().int().min(108).max(4000), height: z.number().int().min(108).max(4000), fit: z.literal(false).optional() }), 'Viewport_saveAsImageFile');
add('render.start', 'Start a local render to an explicit local destination', 'local_artifact', z.strictObject({ output, width: z.number().int().min(108).max(4000), height: z.number().int().min(108).max(4000), quality: z.enum(['draft', 'standard', 'excellent']) }), 'Rendering_startLocalRender', { cancellation: 'unsupported' });
add('render.status', 'Read a local render future', 'read', z.strictObject({ job_id: ref }), 'RenderFuture', { notes: 'Use the durable plugin job ID from render.start, not the raw session-scoped Fusion future ID.' });
add('cam.inspect', 'Inspect setups, operations and generation state', 'read', z.strictObject({ limit }), 'CAM');
add('cam.setup_schema', 'Discover typed milling setup inputs and required safety fields', 'read', z.strictObject({ operation_type: z.literal('milling'), limit, offset }), 'Setups_createInput');
add('cam.operation_schema', 'Discover typed parameters and entitlement for a milling strategy', 'read', z.strictObject({ setup_id: ref, strategy: millingStrategy, limit, offset }), 'Operations_createInput');
add('cam.setup_create', 'Create a milling setup with explicit stock and fixtures', 'local_edit', z.strictObject({ name, model_ids: refs, fixture_ids: z.array(ref).max(100), operation_type: z.literal('milling'), stock_mode: z.enum(['relative_box', 'fixed_box']), parameters: z.array(typedCamParameter).max(500), machine_id: name.optional() }), 'Setups');
add('cam.operation_create', 'Create an entitled operation with typed parameters', 'local_edit', z.strictObject({ setup_id: ref, strategy: millingStrategy, tool_library_id: assetRef.optional(), tool_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), tool_json: z.string().min(1).max(1_048_576).optional(), parameters: z.array(typedCamParameter).max(500) }), 'Operations_createInput', { notes: 'Managed mode requires a tool selected by full definition hash from a pinned library. Raw tool_json is an assisted-mode input.' });
add('cam.tools_list', 'Inspect tools in an approved pinned tool library', 'read', z.strictObject({ tool_library_id: assetRef, limit, offset, tool_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }), 'ToolLibrary');
add('cam.machining_time', 'Estimate machining time with explicit feed assumptions', 'read', z.strictObject({ operation_ids: refs, feed_scale_percent: z.number().positive().max(1000), rapid_feed_cm_per_second: z.number().positive().max(100_000), tool_change_seconds: z.number().nonnegative().max(3600) }), 'CAM_getMachiningTime', { notes: 'Estimated time is not a measured cycle time, commercial quote or machine capability guarantee.' });
add('cam.setup_sheet', 'Generate a local HTML setup-sheet review package', 'local_artifact', z.strictObject({ operation_ids: refs, format: z.literal('html'), output }), 'CAM_generateSetupSheet', { notes: 'Review artifact only; no browser launch, sending or manufacturing signoff.' });
add('cam.template_apply', 'Apply a pinned reviewed CAM template', 'local_edit', z.strictObject({ setup_id: ref, template_id: assetRef }), 'Setup_createFromCAMTemplate2');
add('cam.generate', 'Generate selected toolpaths and track the future', 'local_edit', z.strictObject({ operation_ids: refs }), 'CAM_generateToolpath', { cancellation: 'unsupported' });
add('cam.status', 'Read a toolpath generation future', 'read', z.strictObject({ job_id: ref }), 'GenerateToolpathFuture', { notes: 'Use the durable plugin job ID from cam.generate or cam.nc_post, not the raw session-scoped Fusion future ID.' });
add('cam.nc_post', 'Post an operator-reviewed NC candidate to quarantine', 'local_artifact', z.strictObject({ operation_ids: refs, manufacturing_profile_id: assetRef, review_record_id: assetRef, output, program_name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), parameters: z.array(typedCamParameter).max(500).optional() }), 'NCProgram_postProcess', { notes: 'Requires pinned post, machine and operator evidence; never transfers to equipment.' });
add('flatpattern.create', 'Create a flat pattern from a stationary face', 'local_edit', z.strictObject({ component_id: ref.optional(), stationary_face_id: ref }), 'Component_createFlatPattern');
add('flatpattern.export', 'Export an existing sheet-metal flat pattern as DXF', 'local_artifact', z.strictObject({ component_id: ref.optional(), output }), 'ExportManager_createDXFFlatPatternExportOptions');

export const operationCatalog: ReadonlyMap<string, Entry> = new Map(entries.map(entry => [entry.id, entry]));
export function describeOperations(family?: string, includeSchema = false): unknown[] {
  return entries.filter(e => !family || e.family === family).map(({ schema, document, ...entry }) => ({ ...entry, document_required: document, ...(includeSchema ? { input_schema: z.toJSONSchema(schema, { io: 'input' }) } : {}) }));
}
export function getOperation(id: string): Entry {
  const entry = operationCatalog.get(id);
  if (!entry) throw new FusionError('UNSUPPORTED_OPERATION', 'This operation is not in the reviewed operation registry. Use capabilities discovery; arbitrary method names are not accepted.');
  return entry;
}
export function parseOperation(value: unknown): OperationInput {
  assertJson(value, 2_097_152);
  const envelope = z.strictObject({ operation: ref, args: z.record(z.string(), z.unknown()), document_id: ref.optional(), expected_state: ref.optional() }).safeParse(value);
  if (!envelope.success) throw new FusionError('INVALID_INPUT', 'Invalid operation envelope.', 'none', envelope.error.issues);
  const definition = getOperation(envelope.data.operation);
  const parsed = definition.schema.safeParse(envelope.data.args);
  if (!parsed.success) throw new FusionError('INVALID_INPUT', `Invalid arguments for ${definition.id}.`, 'none', parsed.error.issues);
  if (definition.document && !envelope.data.document_id) throw new FusionError('DOCUMENT_REQUIRED', 'Choose an explicit document reference from documents.list.');
  if (!definition.document && envelope.data.document_id) throw new FusionError('INVALID_INPUT', 'This session operation must not target a document.');
  const result = { ...envelope.data, args: parsed.data as Record<string, unknown> };
  if (['features.extrude', 'features.revolve', 'features.sweep', 'features.loft'].includes(result.operation)) {
    const needsParticipants = ['cut', 'intersect'].includes(result.args.operation as string);
    if (needsParticipants && !result.args.participant_body_ids) throw new FusionError('EXPLICIT_PARTICIPANTS_REQUIRED', 'Cut/intersect must enumerate participant bodies.');
    if (!needsParticipants && result.args.participant_body_ids) throw new FusionError('INVALID_INPUT', 'Participant bodies apply only to cut/intersect; create a separate body and use explicit combine when a join target is ambiguous.');
  }
  return result;
}

export const capabilityBoundaries = [
  { family: 'drawings.author', maturity: 'preview', status: 'research_only', reason: 'Automatic drawing creation is preview; existing drawing PDF export has its own released path.' },
  { family: 'electronics', maturity: 'preview', status: 'research_only', reason: 'Preview inspection is not unrestricted schematic/PCB authoring or fresh ERC/DRC execution.' },
  { family: 'simulation', maturity: 'preview', status: 'human_handoff', reason: 'Insider simulation APIs are not a released supported solver interface.' },
  { family: 'generative_design', maturity: 'unverified', status: 'human_handoff', reason: 'No qualified public generation/solve API is advertised.' },
  { family: 'manufacturing.release', maturity: 'unverified', status: 'human_handoff', reason: 'No structured machine collision proof or physical machine control is implemented.' },
  { family: 'sheet_metal.advanced', maturity: 'preview', status: 'research_only', reason: 'Released collection access is not authoring; fold/convert/join variants require separate API qualification.' },
  { family: 'ui.arbitrary', maturity: 'unverified', status: 'assisted_only', reason: 'Native raw tools are outside the typed managed facade. They cannot provide managed-policy guarantees.' }
] as const;
