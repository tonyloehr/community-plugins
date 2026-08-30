/** Pure fixture-fact validation/scoring. No files, profiles, providers or models are opened. */
const DOCUMENT = 'fixture:bracket';
const BODY = 'fixture:body:bracket';
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const SOURCES = new Set(['connection', 'capabilities', 'document_summary', 'document_inspection', 'parameter_values', 'geometry_measure', 'geometry_check', 'cam_inspection']);
const PHASES = new Set(['any', 'before_change', 'after_change']);
const KINDS = new Set(['equals', 'approx', 'exists', 'length_equals', 'length_at_least']);
const MISSING = Symbol('missing JSON value');
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, maximum = 4096) => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
const integer = (value, minimum = 0, maximum = 10_000) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const exact = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const stringArray = (value, maximum = 100, minimum = 0) => Array.isArray(value) && value.length >= minimum && value.length <= maximum && value.every(item => text(item));
const fail = (code, message) => { throw Object.assign(new TypeError(message), { code }); };
const requireThat = (condition, code, message) => { if (!condition) fail(code, message); };

// Validate descriptors before reading values: no accessors, toJSON hooks, sparse
// arrays, cycles, prototype-bearing instances or non-JSON numeric values.
function boundedJson(value, { bytes, depth, nodes, array = 50_000 }, code) {
  const ancestors = new Set(); let visited = 0, estimatedBytes = 0;
  const spend = amount => { estimatedBytes += amount; if (estimatedBytes > bytes) fail(code, 'JSON byte limit exceeded.'); };
  function visit(current, level) {
    if (++visited > nodes || level > depth) fail(code, 'JSON nesting or node limit exceeded.');
    if (current === null) { spend(4); return; }
    if (typeof current === 'boolean') { spend(current ? 4 : 5); return; }
    if (typeof current === 'number') { if (!Number.isFinite(current)) fail(code, 'JSON numbers must be finite.'); spend(String(current).length); return; }
    if (typeof current === 'string') { spend(Buffer.byteLength(JSON.stringify(current), 'utf8')); return; }
    if (!current || typeof current !== 'object') fail(code, 'Only JSON values are accepted.');
    const prototype = Object.getPrototypeOf(current);
    if (Array.isArray(current) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail(code, 'Only plain JSON objects and arrays are accepted.');
    if (ancestors.has(current)) fail(code, 'Cyclic JSON is not accepted.');
    ancestors.add(current);
    const keys = Reflect.ownKeys(current);
    if (keys.length > nodes - visited + 1) fail(code, 'JSON node limit exceeded.');
    const descriptors = Object.getOwnPropertyDescriptors(current);
    if (keys.some(key => typeof key !== 'string')) fail(code, 'Symbol properties are not JSON.');
    if (Array.isArray(current)) {
      if (current.length > array || keys.length !== current.length + 1) fail(code, 'JSON array size or shape is invalid.');
      spend(2 + Math.max(0, current.length - 1));
      for (let i = 0; i < current.length; i++) {
        const descriptor = descriptors[String(i)];
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail(code, 'Sparse arrays and accessors are not JSON.');
        visit(descriptor.value, level + 1);
      }
    } else {
      spend(2 + Math.max(0, keys.length - 1));
      for (const key of keys) {
        const descriptor = descriptors[key];
        if (RESERVED.has(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code, 'Reserved keys and accessors are not accepted.');
        spend(Buffer.byteLength(JSON.stringify(key), 'utf8') + 1);
        visit(descriptor.value, level + 1);
      }
    }
    ancestors.delete(current);
  }
  visit(value, 0);
}

function pointerParts(pointer) {
  requireThat(typeof pointer === 'string' && pointer.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(pointer) && (pointer === '' || pointer.startsWith('/')), 'INVALID_OBSERVATION_CHECKS', 'Use a bounded RFC 6901 JSON pointer, not JSONPath or a URI fragment.');
  if (pointer === '') return [];
  const parts = pointer.slice(1).split('/');
  requireThat(parts.length <= 32, 'INVALID_OBSERVATION_CHECKS', 'JSON pointers may contain at most 32 segments.');
  return parts.map(part => {
    requireThat(!/~(?![01])/u.test(part), 'INVALID_OBSERVATION_CHECKS', 'Invalid JSON pointer escape.');
    const key = part.replace(/~1/gu, '/').replace(/~0/gu, '~');
    requireThat(!RESERVED.has(key), 'INVALID_OBSERVATION_CHECKS', 'Reserved JSON pointer keys are not accepted.');
    return key;
  });
}

function atPointer(value, pointer) {
  let current = value;
  for (const key of pointerParts(pointer)) {
    if (!current || typeof current !== 'object') return MISSING;
    if (Array.isArray(current) && (!/^(0|[1-9]\d*)$/u.test(key) || !integer(Number(key), 0, current.length - 1))) return MISSING;
    if (!Object.hasOwn(current, key)) return MISSING;
    current = current[key];
  }
  return current;
}

function jsonEqual(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== typeof right || typeof left !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => jsonEqual(value, right[index]));
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
}

/** Strict author-owned schema. Empty checks are permitted for externally gated cases. */
export function validateObservationChecks(checks) {
  boundedJson(checks, { bytes: 262_144, depth: 20, nodes: 25_000, array: 10_000 }, 'INVALID_OBSERVATION_CHECKS');
  requireThat(Array.isArray(checks) && checks.length <= 32, 'INVALID_OBSERVATION_CHECKS', 'Use at most 32 required observations.');
  const ids = new Set(); let assertionCount = 0;
  for (const check of checks) {
    requireThat(exact(check, ['id', 'source', 'phase', 'assertions']) && typeof check.id === 'string' && /^[a-z][a-z0-9_-]{0,95}$/u.test(check.id) && !ids.has(check.id) && SOURCES.has(check.source) && PHASES.has(check.phase), 'INVALID_OBSERVATION_CHECKS', 'Observation identity, source, phase or keys are invalid.');
    ids.add(check.id);
    requireThat(Array.isArray(check.assertions) && check.assertions.length >= 1 && check.assertions.length <= 32 && (assertionCount += check.assertions.length) <= 256, 'INVALID_OBSERVATION_CHECKS', 'Use 1–32 assertions per observation and at most 256 in total.');
    for (const assertion of check.assertions) {
      requireThat(object(assertion) && KINDS.has(assertion.kind), 'INVALID_OBSERVATION_CHECKS', 'Unsupported assertion kind.');
      const expected = assertion.kind !== 'exists';
      requireThat(exact(assertion, ['kind', 'pointer', ...(expected ? ['expected'] : [])], ['select', ...(assertion.kind === 'approx' ? ['absolute_tolerance', 'relative_tolerance'] : [])]), 'INVALID_OBSERVATION_CHECKS', 'Assertion fields do not match its kind.');
      pointerParts(assertion.pointer);
      if (assertion.kind === 'approx') {
        requireThat(typeof assertion.expected === 'number' && Number.isFinite(assertion.expected), 'INVALID_OBSERVATION_CHECKS', 'Approximate targets must be finite numbers.');
        for (const [key, maximum] of [['absolute_tolerance', 1000], ['relative_tolerance', 0.01]]) if (Object.hasOwn(assertion, key)) requireThat(typeof assertion[key] === 'number' && Number.isFinite(assertion[key]) && assertion[key] >= 0 && assertion[key] <= maximum, 'INVALID_OBSERVATION_CHECKS', 'Approximation tolerances exceed their finite nonnegative bounds.');
      }
      if (assertion.kind.startsWith('length_')) requireThat(integer(assertion.expected), 'INVALID_OBSERVATION_CHECKS', 'Length targets must be integers from 0 to 10000.');
      if (Object.hasOwn(assertion, 'select')) {
        requireThat(exact(assertion.select, ['pointer', 'equals', 'value_pointer']) && text(assertion.select.equals, 1024), 'INVALID_OBSERVATION_CHECKS', 'Selection requires a bounded nonempty string identity and exact pointer fields.');
        pointerParts(assertion.select.pointer); pointerParts(assertion.select.value_pointer);
      }
    }
  }
  return checks;
}

function assertionIssue(value, assertion, budget) {
  let actual = atPointer(value, assertion.pointer);
  if (actual === MISSING) return 'path_missing';
  if (assertion.select) {
    if (!Array.isArray(actual) || actual.length > 10_000) return 'selection_array_invalid';
    const identities = new Set(); let selected = MISSING;
    for (const item of actual) {
      if (--budget.remaining < 0) return 'evaluation_budget_exceeded';
      const identity = atPointer(item, assertion.select.pointer);
      if (!text(identity, 1024) || identities.has(identity)) return 'selection_identity_missing_or_duplicated';
      identities.add(identity);
      if (identity === assertion.select.equals) selected = item;
    }
    if (selected === MISSING) return 'selected_identity_missing';
    actual = atPointer(selected, assertion.select.value_pointer);
    if (actual === MISSING) return 'selected_value_missing';
  }
  if (assertion.kind === 'exists') return null;
  if (assertion.kind === 'equals') return jsonEqual(actual, assertion.expected) ? null : 'value_not_equal';
  if (assertion.kind === 'approx') return typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - assertion.expected) <= (assertion.absolute_tolerance ?? 0) + Math.abs(assertion.expected) * (assertion.relative_tolerance ?? 0) ? null : 'value_outside_tolerance';
  if (!Array.isArray(actual) && typeof actual !== 'string') return 'length_value_invalid';
  return (assertion.kind === 'length_equals' ? actual.length === assertion.expected : actual.length >= assertion.expected) ? null : 'length_not_satisfied';
}

function successfulContent(item) {
  if (!exact(item, ['id', 'type', 'server', 'tool', 'arguments', 'status', 'result'], ['error']) || !text(item.id, 256) || item.type !== 'mcp_tool_call' || item.server !== 'fusion_eval' || item.status !== 'completed' || item.error !== undefined && item.error !== null || !object(item.arguments)) return null;
  const result = item.result;
  if (!exact(result, [], ['structured_content', 'structuredContent', 'content', 'is_error', 'isError', '_meta']) || ['is_error', 'isError'].some(key => Object.hasOwn(result, key) && result[key] !== false)) return null;
  const fields = ['structured_content', 'structuredContent'].filter(key => Object.hasOwn(result, key));
  if (fields.length !== 1 || !object(result[fields[0]]) || Object.hasOwn(result[fields[0]], 'error')) return null;
  const value = result[fields[0]];
  try { boundedJson(value, { bytes: 4_194_304, depth: 48, nodes: 100_000, array: 10_000 }, 'INVALID_OBSERVATION_EVIDENCE'); } catch { return null; }
  if (Object.hasOwn(result, 'content')) {
    if (!Array.isArray(result.content) || result.content.length !== 1 || !exact(result.content[0], ['type', 'text']) || result.content[0].type !== 'text' || typeof result.content[0].text !== 'string' || result.content[0].text.length > 4_194_304) return null;
    try { const parsed = JSON.parse(result.content[0].text); boundedJson(parsed, { bytes: 4_194_304, depth: 48, nodes: 100_000, array: 10_000 }, 'INVALID_OBSERVATION_EVIDENCE'); if (!jsonEqual(parsed, value)) return null; } catch { return null; }
  }
  return value;
}

function readScope(value) {
  if (value?.mode === 'explicit_documents') return exact(value, ['mode', 'restricted', 'configured_document_count', 'includes_profile_created_documents']) && value.restricted === true && integer(value.configured_document_count) && typeof value.includes_profile_created_documents === 'boolean';
  return exact(value, ['mode', 'restricted', 'description']) && value.mode === 'current_user_open_documents' && value.restricted === false && text(value.description);
}

function environment(value) { return exact(value, ['platform', 'arch', 'os_release']) && [value.platform, value.arch, value.os_release].every(item => text(item, 256)); }
function fixtureMetadata(value) { return value?.provider === 'synthetic_fixture' && value.live_fusion_verified === false; }
function readEffects(value) { return Array.isArray(value) && value.length === 0; }

function documentRows(data) {
  if (!exact(data, ['documents', 'provider', 'live_fusion_verified'], ['next_cursor', 'total', 'truncated', 'restricted_document_count', 'content_scope']) || !fixtureMetadata(data) || !Array.isArray(data.documents) || data.documents.length > 256) return null;
  if (Object.hasOwn(data, 'next_cursor') && data.next_cursor !== null || Object.hasOwn(data, 'total') && !integer(data.total, data.documents.length, 256) || Object.hasOwn(data, 'truncated') && typeof data.truncated !== 'boolean' || Object.hasOwn(data, 'restricted_document_count') && !integer(data.restricted_document_count, 0, 256) || Object.hasOwn(data, 'content_scope') && !text(data.content_scope)) return null;
  const ids = new Set(); let selected = null;
  for (const row of data.documents) {
    if (!exact(row, ['document_id', 'name', 'saved', 'is_active', 'product_type']) || !text(row.document_id, 2048) || ids.has(row.document_id) || !text(row.name, 1024) || typeof row.saved !== 'boolean' || typeof row.is_active !== 'boolean' || !text(row.product_type, 256)) return null;
    ids.add(row.document_id); if (row.document_id === DOCUMENT) selected = row;
  }
  return selected;
}

const CONNECTION_KEYS = ['profile', 'mode', 'desktop', 'desktop_evidence', 'read_scope', 'mutations_enabled', 'cloud_configured', 'profile_sha256', 'handler_sha256', 'execution_contract_sha256', 'execution_contract_kind', 'runtime_environment', 'desktop_qualification_candidate', 'desktop_qualification_candidate_observed_at', 'desktop_qualification_candidate_requires', 'desktop_qualification_binding', 'local_native_authentication', 'live_fusion_exercised', 'live_fusion_verified', 'trusted_qualification_attestation'];
function connection(value, args, contract) {
  if (!exact(args, []) || !exact(value, CONNECTION_KEYS) || value.mode !== 'fixture' || value.execution_contract_sha256 !== contract || value.execution_contract_kind !== 'installed_code' || !text(value.profile, 160) || !sha256(value.handler_sha256) || !sha256(value.profile_sha256) || value.live_fusion_verified !== false || value.live_fusion_exercised !== false || value.trusted_qualification_attestation !== false || !readScope(value.read_scope) || !environment(value.runtime_environment) || typeof value.mutations_enabled !== 'boolean' || value.cloud_configured !== false) return null;
  const evidence = value.desktop_evidence;
  if (!exact(evidence, ['kind', 'provider', 'handler_execution_reported', 'independently_verified', 'limitation']) || evidence.kind !== 'synthetic_fixture' || evidence.provider !== 'synthetic_fixture' || evidence.handler_execution_reported !== false || evidence.independently_verified !== false || !text(evidence.limitation)) return null;
  if (value.desktop_qualification_candidate !== null || value.desktop_qualification_candidate_observed_at !== null || !stringArray(value.desktop_qualification_candidate_requires, 20, 1) || !exact(value.desktop_qualification_binding, ['configured']) || value.desktop_qualification_binding.configured !== false || !text(value.local_native_authentication)) return null;
  const desktop = value.desktop;
  if (!exact(desktop, ['data', 'state', 'effects']) || !sha256(desktop.state) || !readEffects(desktop.effects)) return null;
  const document = documentRows(desktop.data);
  return document ? { value, document, state: desktop.state } : null;
}

const CAPABILITY_KEYS = ['profile', 'mode', 'implementation', 'handler_sha256', 'execution_contract_sha256', 'execution_contract_kind', 'runtime_environment', 'read_scope', 'operations', 'boundaries', 'guarantee_scope', 'evidence'];
const OPERATION_KEYS = ['id', 'title', 'family', 'effect', 'provider', 'maturity', 'implemented', 'cancellation', 'source', 'document_required', 'provider_configured', 'provider_available', 'availability_basis', 'live_qualified', 'prior_profile_qualification_attested', 'profile_grant_authorized', 'execution_authorized', 'authorization_basis', 'execution_requires_current_qualification'];
function capabilities(value, args, contract) {
  if (!exact(args, [], ['family', 'include_schema']) || Object.hasOwn(args, 'family') && !text(args.family, 128) || Object.hasOwn(args, 'include_schema') && typeof args.include_schema !== 'boolean' || !exact(value, CAPABILITY_KEYS) || value.mode !== 'fixture' || value.implementation !== 'typed_facade' || value.execution_contract_sha256 !== contract || value.execution_contract_kind !== 'installed_code' || !sha256(value.handler_sha256) || !text(value.profile, 160) || !environment(value.runtime_environment) || !readScope(value.read_scope) || !text(value.guarantee_scope) || !text(value.evidence) || !Array.isArray(value.operations) || value.operations.length > 512 || !Array.isArray(value.boundaries) || value.boundaries.length > 128) return null;
  const ids = new Set();
  for (const row of value.operations) {
    if (!exact(row, OPERATION_KEYS, ['notes', 'input_schema']) || !text(row.id, 128) || ids.has(row.id) || ![row.title, row.family, row.source, row.authorization_basis].every(item => text(item)) || Object.hasOwn(row, 'notes') && !text(row.notes) || row.provider !== 'desktop' || !['read', 'local_edit', 'local_artifact', 'cloud_write', 'cloud_compute', 'administration'].includes(row.effect) || !['released', 'preview', 'unverified'].includes(row.maturity) || !['supported', 'unsupported', 'not_applicable'].includes(row.cancellation)) return null;
    if (['implemented', 'document_required', 'provider_available', 'profile_grant_authorized', 'execution_authorized'].some(key => typeof row[key] !== 'boolean') || row.provider_configured !== true || row.live_qualified !== false || row.prior_profile_qualification_attested !== false || row.execution_requires_current_qualification !== false || row.availability_basis !== 'synthetic_fixture_implementation' || args.family !== undefined && row.family !== args.family || !!args.include_schema !== Object.hasOwn(row, 'input_schema') || Object.hasOwn(row, 'input_schema') && !object(row.input_schema)) return null;
    ids.add(row.id);
  }
  for (const row of value.boundaries) if (!exact(row, ['family', 'maturity', 'status', 'reason']) || !Object.values(row).every(item => text(item))) return null;
  return value;
}

function parameters(rows, maximum = 10_000) {
  if (!Array.isArray(rows) || rows.length > maximum) return false;
  const ids = new Set();
  for (const row of rows) {
    if (!exact(row, ['id', 'name', 'expression', 'value_mm']) || !text(row.name, 128) || !/^[A-Za-z][A-Za-z0-9_]*$/u.test(row.name) || row.id !== `fixture:param:${row.name}` || ids.has(row.id) || typeof row.expression !== 'string' || row.expression.length < 1 || row.expression.length > 512 || !Number.isFinite(row.value_mm) || row.value_mm <= 0 || row.value_mm > 1_000_000) return false;
    const expression = /^\s*(\d+(?:\.\d+)?)\s*(mm|cm|m|in)\s*$/u.exec(row.expression);
    if (!expression) return false;
    const numeric = Number(expression[1]) * { mm: 1, cm: 10, m: 1000, in: 25.4 }[expression[2]];
    if (!Number.isFinite(numeric) || Math.abs(row.value_mm - numeric) > Math.max(1e-9, Math.abs(numeric) * 1e-12)) return false;
    ids.add(row.id);
  }
  return true;
}

function inspectionData(data) {
  return exact(data, ['document_id', 'name', 'fixture', 'units', 'parameters', 'body_count', 'feature_health', 'saved', 'provider', 'live_fusion_verified']) && data.document_id === DOCUMENT && text(data.name, 1024) && data.fixture === true && exact(data.units, ['length', 'angle']) && data.units.length === 'mm' && data.units.angle === 'rad' && parameters(data.parameters) && integer(data.body_count) && text(data.feature_health, 256) && typeof data.saved === 'boolean' && fixtureMetadata(data);
}

const ALIASES = new Map([['fusion_document_inspect', 'document.inspect'], ['fusion_geometry_measure', 'geometry.measure'], ['fusion_design_check', 'geometry.check'], ['fusion_cam_inspect', 'cam.inspect']]);
function readRequest(item) {
  const args = item.arguments; let operation, data, state;
  if (item.tool === 'fusion_read') {
    if (!exact(args, ['operation', 'args'], ['document_id', 'expected_state'])) return null;
    operation = args.operation; data = args.args; state = args.expected_state;
  } else if (item.tool === 'fusion_documents_list') {
    if (!exact(args, [], ['limit', 'expected_state'])) return null;
    operation = 'documents.list'; data = Object.hasOwn(args, 'limit') ? { limit: args.limit } : {}; state = args.expected_state;
  } else if (ALIASES.has(item.tool)) {
    if (!exact(args, ['document_id', 'args'], ['expected_state'])) return null;
    operation = ALIASES.get(item.tool); data = args.args; state = args.expected_state;
  } else return null;
  if (state !== undefined && !sha256(state) || !object(data) || (operation === 'documents.list' ? Object.hasOwn(args, 'document_id') : args.document_id !== DOCUMENT)) return null;
  if (['documents.list', 'document.inspect', 'cam.inspect'].includes(operation)) {
    if (!exact(data, [], ['limit']) || Object.hasOwn(data, 'limit') && !integer(data.limit, 1, operation === 'documents.list' ? 256 : 100)) return null;
  } else if (operation === 'parameters.list') {
    if (!exact(data, [], ['kind', 'limit']) || Object.hasOwn(data, 'kind') && !['user', 'all'].includes(data.kind) || Object.hasOwn(data, 'limit') && !integer(data.limit, 1, 100)) return null;
  } else if (operation === 'geometry.measure') {
    if (!exact(data, ['entity_ids', 'kind'], ['accuracy']) || !Array.isArray(data.entity_ids) || data.entity_ids.length < 1 || data.entity_ids.length > 100 || data.entity_ids.some(id => id !== BODY) || !['physical', 'bounding_box'].includes(data.kind) || Object.hasOwn(data, 'accuracy') && !['low', 'medium', 'high', 'very_high'].includes(data.accuracy)) return null;
  } else if (operation === 'geometry.check') {
    if (!exact(data, ['kind'], ['entity_ids']) || !['health', 'interference'].includes(data.kind) || Object.hasOwn(data, 'entity_ids') && (!Array.isArray(data.entity_ids) || data.entity_ids.length < 1 || data.entity_ids.length > 50 || data.entity_ids.some(id => id !== BODY))) return null;
  } else return null;
  return { operation, args: data, expected_state: state };
}

function readObservation(item, value) {
  const request = readRequest(item);
  if (!request || !exact(value, ['data', 'state', 'effects', 'operation', 'document_id', 'evidence', 'content_trust']) || value.operation !== request.operation || value.document_id !== (request.operation === 'documents.list' ? null : DOCUMENT) || value.evidence !== 'synthetic_fixture' || !sha256(value.state) || request.expected_state !== undefined && request.expected_state !== value.state || !readEffects(value.effects) || !text(value.content_trust) || !fixtureMetadata(value.data)) return [];
  const data = value.data, base = { state: value.state };
  if (request.operation === 'documents.list') { const document = documentRows(data); return document ? [{ ...base, source: 'document_summary', value: document }] : []; }
  if (request.operation === 'document.inspect') return inspectionData(data) ? [{ ...base, source: 'document_inspection', value: data }, { ...base, source: 'parameter_values', value: data }] : [];
  if (request.operation === 'parameters.list') {
    if (!exact(data, ['parameters', 'total', 'truncated', 'units_note', 'provider', 'live_fusion_verified']) || !parameters(data.parameters, request.args.limit ?? 100) || !integer(data.total, data.parameters.length) || data.truncated !== (data.total > data.parameters.length) || !text(data.units_note)) return [];
    return [{ ...base, source: 'parameter_values', value: data }];
  }
  if (request.operation === 'geometry.measure') {
    if (!exact(data, ['analytic_fixture', 'volume', 'bounding_box', 'provider', 'live_fusion_verified']) || data.analytic_fixture !== true || !exact(data.volume, ['value', 'unit']) || data.volume.unit !== 'mm^3' || !Number.isFinite(data.volume.value) || data.volume.value <= 0 || !exact(data.bounding_box, ['min', 'max', 'unit', 'frame']) || data.bounding_box.unit !== 'mm' || data.bounding_box.frame !== 'component' || !jsonEqual(data.bounding_box.min, [0, 0, 0]) || !Array.isArray(data.bounding_box.max) || data.bounding_box.max.length !== 3 || data.bounding_box.max.some(value => !Number.isFinite(value) || value <= 0 || value > 1_000_000)) return [];
    const volume = data.bounding_box.max.reduce((product, value) => product * value, 1);
    if (Math.abs(data.volume.value - volume) > Math.max(1e-9, Math.abs(volume) * 1e-12)) return [];
    return [{ ...base, source: 'geometry_measure', value: data }];
  }
  if (request.operation === 'geometry.check') {
    if (!exact(data, ['checks', 'limitations', 'provider', 'live_fusion_verified']) || !Array.isArray(data.checks) || data.checks.length > 100 || !stringArray(data.limitations, 100, 1)) return [];
    const names = new Set();
    for (const check of data.checks) { if (!exact(check, ['name', 'status']) || !text(check.name, 256) || names.has(check.name) || !['passed', 'failed', 'warning', 'unavailable'].includes(check.status)) return []; names.add(check.name); }
    return [{ ...base, source: 'geometry_check', value: data }];
  }
  return exact(data, ['setups', 'limitations', 'provider', 'live_fusion_verified']) && Array.isArray(data.setups) && data.setups.length === 0 && stringArray(data.limitations, 100, 1) ? [{ ...base, source: 'cam_inspection', value: data }] : [];
}

const EXECUTE_TOOLS = new Set(['fusion_changes_execute', 'fusion_artifact_generate', 'fusion_view_capture', 'fusion_document_save', 'fusion_cam_generate', 'fusion_nc_generate']);
function successfulExecution(item, value, contract, attestation) {
  const planKeys = ['id', 'hash', 'created_at', 'expires_at', 'operation', 'expected_state', 'handler_hash', 'profile_hash', 'execution_contract_hash', 'effect', 'provider_args', 'before', 'summary', 'policy_decision', 'status', 'limitations', 'idempotency_key', 'result'];
  if (!EXECUTE_TOOLS.has(item.tool) || !exact(item.arguments, ['plan_id', 'plan_hash', 'idempotency_key']) || !text(item.arguments.plan_id, 128) || !sha256(item.arguments.plan_hash) || !text(item.arguments.idempotency_key, 160) || item.arguments.idempotency_key.length < 8 || !exact(value, planKeys, ['artifact']) || value.id !== item.arguments.plan_id || value.hash !== item.arguments.plan_hash || value.idempotency_key !== item.arguments.idempotency_key || value.status !== 'succeeded' || value.execution_contract_hash !== contract || value.handler_hash !== attestation.handler || !sha256(value.profile_hash) || attestation.profile_hash && value.profile_hash !== attestation.profile_hash || !sha256(value.expected_state) || !exact(value.operation, ['operation', 'document_id', 'args', 'expected_state']) || value.operation.document_id !== DOCUMENT || value.operation.expected_state !== value.expected_state || !['parameters.set', 'parameters.add', 'exports.generate'].includes(value.operation.operation) || value.effect !== (value.operation.operation === 'exports.generate' ? 'local_artifact' : 'local_edit') || !inspectionData(value.before) || !exact(value.policy_decision, ['authorized']) || value.policy_decision.authorized !== true || !stringArray(value.limitations, 100) || !Number.isFinite(Date.parse(value.created_at)) || !Number.isFinite(Date.parse(value.expires_at))) return null;
  if (item.tool !== 'fusion_changes_execute' && !(item.tool === 'fusion_artifact_generate' && value.operation.operation === 'exports.generate')) return null;
  const result = value.result;
  if (!exact(result, ['data', 'state', 'effects', 'after', 'effect_committed', 'completion', 'live_qualification'], ['artifact']) || result.effect_committed !== true || result.completion !== 'provider_completed' || result.live_qualification !== 'synthetic_only' || !fixtureMetadata(result.data) || !sha256(result.state) || !stringArray(result.effects, 20) || !exact(result.after, ['data', 'state', 'effects']) || !readEffects(result.after.effects) || result.after.state !== result.state || !inspectionData(result.after.data)) return null;
  if (value.operation.operation !== 'exports.generate' && (result.state === value.expected_state || !result.effects.includes('synthetic_fixture_changed'))) return null;
  return { before_state: value.expected_state, after_state: result.state };
}

/** Each required fact set must be satisfied by one complete, contract-bound observation. */
export function scoreObservationChecks(checks, options) {
  validateObservationChecks(checks);
  requireThat(exact(options, ['events', 'executionContract']) && sha256(options.executionContract) && Array.isArray(options.events) && options.events.length <= 50_000, 'INVALID_OBSERVATION_EVIDENCE', 'Supply bounded events and an exact SHA-256 execution contract.');
  boundedJson(options.events, { bytes: 16_777_216, depth: 64, nodes: 500_000 }, 'INVALID_OBSERVATION_EVIDENCE');
  const completedCounts = new Map();
  for (const event of options.events) if (event?.type === 'item.completed' && text(event.item?.id, 256)) completedCounts.set(event.item.id, (completedCounts.get(event.item.id) ?? 0) + 1);
  const observations = [], executions = [], rejected = new Set(); let attestation = null;
  for (const [index, event] of options.events.entries()) {
    if (!object(event)) { rejected.add('malformed_event'); continue; }
    if (event.type === 'thread.started') { attestation = null; continue; }
    if (event.type !== 'item.completed' || !object(event.item) || event.item.server !== 'fusion_eval') continue;
    const item = event.item;
    const isAttestation = ['fusion_connection_status', 'fusion_capabilities_list'].includes(item.tool);
    if (completedCounts.get(item.id) !== 1) { rejected.add('ambiguous_completed_item_id'); if (isAttestation) attestation = null; continue; }
    const value = successfulContent(item);
    if (!value) { rejected.add('malformed_or_failed_tool_result'); if (isAttestation) attestation = null; continue; }
    if (isAttestation) {
      const valid = item.tool === 'fusion_connection_status' ? connection(value, item.arguments, options.executionContract) : capabilities(value, item.arguments, options.executionContract);
      if (!valid) { attestation = null; rejected.add('fixture_attestation_invalid'); continue; }
      attestation = { index, profile: value.profile, handler: value.handler_sha256, profile_hash: value.profile_sha256 ?? (attestation?.profile === value.profile && attestation?.handler === value.handler_sha256 ? attestation.profile_hash : undefined) };
      if (item.tool === 'fusion_connection_status') observations.push({ index, item_id: item.id, source: 'connection', state: valid.state, value }, { index, item_id: item.id, source: 'document_summary', state: valid.state, value: valid.document });
      else observations.push({ index, item_id: item.id, source: 'capabilities', value });
      continue;
    }
    if (!attestation || attestation.index >= index) { rejected.add('preceding_fixture_attestation_missing'); continue; }
    for (const observed of readObservation(item, value)) observations.push({ ...observed, index, item_id: item.id });
    const execution = successfulExecution(item, value, options.executionContract, attestation);
    if (execution) executions.push({ ...execution, index });
  }
  const first = executions[0], last = executions.at(-1), budget = { remaining: 2_000_000 };
  const scored = checks.map(check => {
    if (check.phase !== 'any' && !first) return { id: check.id, passed: false, issues: ['successful_execution_boundary_missing'] };
    const source = observations.filter(observation => observation.source === check.source);
    const candidates = source.filter(observation => check.phase === 'any' || check.phase === 'before_change' && observation.index < first.index && (!observation.state || observation.state === first.before_state) || check.phase === 'after_change' && observation.index > last.index && (!observation.state || observation.state === last.after_state));
    if (!candidates.length) return { id: check.id, passed: false, issues: [source.length ? 'observation_phase_or_state_mismatch' : 'eligible_observation_missing', ...(!source.length ? [...rejected].sort() : [])] };
    let bestIssues;
    for (const observation of candidates) {
      const issues = check.assertions.map((assertion, index) => { const issue = assertionIssue(observation.value, assertion, budget); return issue ? `assertion_${index}:${issue}` : null; }).filter(Boolean);
      if (!issues.length) return { id: check.id, passed: true, matched_item_id: observation.item_id, source: observation.source, ...(observation.state ? { state: observation.state } : {}) };
      if (!bestIssues || issues.length < bestIssues.length) bestIssues = issues;
      if (budget.remaining < 0) return { id: check.id, passed: false, issues: ['evaluation_budget_exceeded'] };
    }
    return { id: check.id, passed: false, issues: bestIssues };
  });
  return { passed: scored.every(check => check.passed), checks: scored };
}
