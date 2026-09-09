import test from 'node:test';
import assert from 'node:assert/strict';
import { assertJson, FusionError, errorResult, redact } from '../dist/index.mjs';

test('redaction preserves repeated selections and sanitizes every occurrence without changing the source', () => {
  const selection = ['body-left', 'body-right'];
  const metadata = { label: 'Reviewed bracket', authorization: 'Bearer SYNTHETIC_SECRET', nested: { client_secret: 'SYNTHETIC_SECRET' } };
  const original = { operation: { args: { body_ids: selection } }, provider_args: { body_ids: selection }, before: metadata, after: metadata };
  const result = redact(original);
  assert.deepEqual(result.operation.args.body_ids, selection);
  assert.deepEqual(result.provider_args.body_ids, selection);
  assert.deepEqual(result.before, { label: 'Reviewed bracket', authorization: '[REDACTED]', nested: { client_secret: '[REDACTED]' } });
  assert.deepEqual(result.after, result.before);
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_SECRET'), false);
  assertJson(result);
  assert.equal(original.before.authorization, 'Bearer SYNTHETIC_SECRET');
  assert.equal(original.before.nested.client_secret, 'SYNTHETIC_SECRET');
  assert.equal(original.operation.args.body_ids, original.provider_args.body_ids);
});

test('redaction still terminates actual object and array cycles while preserving adjacent aliases', () => {
  const shared = { label: 'Visible geometry', access_token: 'SYNTHETIC_SECRET' };
  const cyclic = { shared }; cyclic.self = cyclic;
  const array = [shared]; array.push(array);
  const result = redact({ first: shared, cyclic, array, again: shared });
  assert.deepEqual(result, {
    first: { label: 'Visible geometry', access_token: '[REDACTED]' },
    cyclic: { shared: { label: 'Visible geometry', access_token: '[REDACTED]' }, self: '[circular]' },
    array: [{ label: 'Visible geometry', access_token: '[REDACTED]' }, '[circular]'],
    again: { label: 'Visible geometry', access_token: '[REDACTED]' }
  });
  assertJson(result);
});

test('redaction bounds expanded alias graphs, deep structures and oversized collections', () => {
  let aliases = { label: 'leaf' };
  for (let level = 0; level < 16; level++) aliases = [aliases, aliases];
  assert.throws(() => redact(aliases), { code: 'INPUT_LIMIT' });
  let deep = 'leaf';
  for (let level = 0; level < 33; level++) deep = { child: deep };
  assert.throws(() => redact(deep), { code: 'INPUT_LIMIT' });
  assert.throws(() => redact(Array(50_001).fill('leaf')), { code: 'INPUT_LIMIT' });
  assert.throws(() => redact(Array(25_000).fill({ password: 'SYNTHETIC_SECRET' })), { code: 'INPUT_LIMIT' });
  assert.deepEqual(redact({ valid: ['later call'] }), { valid: ['later call'] });
});

test('shared diagnostic strings retain bearer, token-query and JWT filtering on every path', () => {
  const shared = { messages: [
    'Authorization failed: Bearer SYNTHETIC_BEARER',
    'https://example.invalid/callback?code=SYNTHETIC_CODE&access_token=SYNTHETIC_TOKEN#result',
    'eyJabcdefghijklmno.abcdefghijk.abcdefghijk'
  ], password: 'SYNTHETIC_PASSWORD', code_verifier: 'SYNTHETIC_VERIFIER' };
  const result = redact({ first: shared, second: shared });
  assert.deepEqual(result.first, result.second);
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes('SYNTHETIC_'), false);
  assert.equal(encoded.includes('eyJabcdefghijklmno'), false);
  assert.equal(result.first.messages[0], 'Authorization failed: Bearer [REDACTED]');
  assert.match(result.first.messages[1], /code=\[REDACTED\]&access_token=\[REDACTED\]#result$/u);
  assert.equal(result.first.messages[2], '[REDACTED JWT]');
});

test('unrepresentable error details cannot replace known outcomes or expose raw diagnostics', () => {
  let deep = { password: 'SYNTHETIC_SECRET' };
  for (let index = 0; index < 31; index++) deep = { child: deep };
  const inaccessible = Object.defineProperty({}, 'field', { enumerable: true, get() { throw new Error('SYNTHETIC_SECRET'); } });
  for (const details of [deep, Array(5_001).fill('leaf'), 'x'.repeat(65_537), { value: NaN }, { value: 1n }, { value: undefined }, { value: () => 'SYNTHETIC_SECRET' }, { value: '\0' }, JSON.parse('{"constructor":"SYNTHETIC_SECRET"}'), inaccessible]) {
    for (const outcome of ['none', 'partial', 'unknown']) {
      const result = errorResult(new FusionError('SYNTHETIC_PROVIDER_ERROR', 'Provider failed: Bearer SYNTHETIC_SECRET', outcome, details));
      assert.equal(result.code, 'SYNTHETIC_PROVIDER_ERROR');
      assert.equal(result.outcome, outcome);
      assert.equal(result.message, 'Provider failed: Bearer [REDACTED]');
      assert.equal(result.details.diagnostics_omitted, true);
      assert.equal(JSON.stringify(result).includes('SYNTHETIC_SECRET'), false);
      assertJson({ audit: { details: { result: { error: result } } } });
    }
  }
});

test('bounded error details preserve shared evidence, original outcomes and safe recovery identities', () => {
  const selected = ['body-1', 'body-2'];
  const result = errorResult(new FusionError('SYNTHETIC_POST_ADD_ERROR', 'Synthetic result needs reconciliation.', 'partial', {
    selected, reported: selected, cause: { job_id: 'synthetic-job-reference', access_token: 'SYNTHETIC_SECRET' }
  }));
  assert.equal(result.outcome, 'partial');
  assert.deepEqual(result.details.selected, selected);
  assert.deepEqual(result.details.reported, selected);
  assert.deepEqual(result.details.cause, { job_id: 'synthetic-job-reference', access_token: '[REDACTED]' });
  assertJson({ audit: { details: { result: { error: result } } } });
});

test('signed transfer URLs and URL userinfo are redacted in repeated untrusted references', () => {
  const evidence = {
    references: [
      'https://files.example.invalid/file?X-Amz-Credential=SYNTHETIC_AWS_ID&X-Amz-Signature=SYNTHETIC_AWS_SIGNATURE&X-Amz-Security-Token=SYNTHETIC_AWS_TOKEN',
      'https://files.example.invalid/file?GoogleAccessId=SYNTHETIC_GOOGLE_ID&Signature=SYNTHETIC_GOOGLE_SIGNATURE',
      'https://files.example.invalid/file?X-Goog-Credential=SYNTHETIC_GOOGLE_CREDENTIAL&X-Goog-Signature=SYNTHETIC_GOOGLE_SIGNED',
      'https://files.example.invalid/file?sv=2025-01-05&sig=SYNTHETIC_SAS_SIGNATURE',
      'An external reference: https://SYNTHETIC_USER:SYNTHETIC_PASSWORD@files.example.invalid/private.',
      'https://SYNTHETIC_USER_ONLY@files.example.invalid/private'
    ]
  };
  const result = redact({ external_evidence: evidence, repeated: evidence });
  assert.deepEqual(result.external_evidence, result.repeated);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_/u);
  assert.match(result.external_evidence.references[0], /X-Amz-Signature=\[REDACTED\]/u);
  assert.match(result.external_evidence.references[3], /sv=2025-01-05&sig=\[REDACTED\]/u);
  assert.match(result.external_evidence.references[4], /\[REDACTED\]@files\.example\.invalid/u);
  assert.match(evidence.references[0], /SYNTHETIC_AWS_SIGNATURE/u);
  assertJson(result);
});

test('credential-bearing query names are recognized after bounded decoding and in fragments', () => {
  const values = [
    'https://files.example.invalid/?%58-Amz-Signature=SYNTHETIC_ENCODED',
    'https://files.example.invalid/?%2573ig=SYNTHETIC_DOUBLE_ENCODED',
    'https://files.example.invalid/#access_token=SYNTHETIC_FRAGMENT',
    '?api_key=SYNTHETIC_QUERY_KEY&safe=public',
    'Authentication failed: Basic SYNTHETIC_BASIC_VALUE',
    'https://files.example.invalid/?AWSAccessKeyId=SYNTHETIC_LEGACY_ID&Signature=SYNTHETIC_LEGACY_SIGNATURE'
  ];
  assert.doesNotMatch(JSON.stringify(redact(values)), /SYNTHETIC_/u);
  assert.equal(redact(values[4]), 'Authentication failed: Basic [REDACTED]');
  assert.equal(redact(values[3]), '?api_key=[REDACTED]&safe=public');
});

test('credential fields are filtered without changing public engineering identity and ordinary links', () => {
  const output = redact({
    apiKey: 'SYNTHETIC_API_KEY', secretKey: 'SYNTHETIC_SECRET_KEY', idToken: 'SYNTHETIC_ID_TOKEN',
    'Proxy-Authorization': 'SYNTHETIC_PROXY_AUTH', 'Set-Cookie': 'SYNTHETIC_COOKIE',
    awsAccessKeyId: 'SYNTHETIC_AWS_ID', awsSecretAccessKey: 'SYNTHETIC_AWS_SECRET', awsSessionToken: 'SYNTHETIC_AWS_TOKEN',
    normal: { source_state: 'state-1', volume: { value: 4000, unit: 'mm^3' }, signature: 'public-cryptographic-receipt', link: 'https://help.autodesk.com/view/fusion360/ENU/?guid=PUBLIC_GUID&lang=en', name: 'A bracket with a 40 mm width.' }
  });
  assert.doesNotMatch(JSON.stringify(output), /SYNTHETIC_/u);
  assert.deepEqual(output.normal, { source_state: 'state-1', volume: { value: 4000, unit: 'mm^3' }, signature: 'public-cryptographic-receipt', link: 'https://help.autodesk.com/view/fusion360/ENU/?guid=PUBLIC_GUID&lang=en', name: 'A bracket with a 40 mm width.' });
});

test('redacted signed-URL diagnostics preserve the original partial outcome and recovery identity', () => {
  const output = errorResult(new FusionError('OUTPUT_UNCERTAIN', 'Inspect https://files.example.invalid/?sig=SYNTHETIC_SIGNATURE before retrying.', 'partial', { job_id: 'job-test', link: 'https://files.example.invalid/?X-Amz-Credential=SYNTHETIC_CREDENTIAL', expected_output_count: 1 }));
  assert.equal(output.code, 'OUTPUT_UNCERTAIN'); assert.equal(output.outcome, 'partial');
  assert.equal(output.details.job_id, 'job-test'); assert.equal(output.details.expected_output_count, 1);
  assert.doesNotMatch(JSON.stringify(output), /SYNTHETIC_/u);
  assertJson(output);
});

test('ordinary redirect values cannot conceal credential query prefixes and separator runs stay bounded', () => {
  const reference = 'https://example.invalid/redirect?destination=https://files.example.invalid/?sig=SYNTHETIC_REDIRECT&safe=public';
  const result = redact(reference);
  assert.doesNotMatch(result, /SYNTHETIC_REDIRECT/u);
  assert.match(result, /sig=\[REDACTED\]&safe=public$/u);
  const separators = '?'.repeat(100_000);
  assert.equal(redact(separators), separators);
  const ordinaryNames = 'component.'.repeat(10_000);
  assert.equal(redact(ordinaryNames), ordinaryNames);
});

test('URL redaction removes userinfo through the final authority delimiter', () => {
  const reference = 'https://test-user:SYNTHETIC_LEFT@SYNTHETIC_RIGHT@files.example.invalid/path?public=1';
  assert.match(new URL(reference).password, /SYNTHETIC_LEFT.*SYNTHETIC_RIGHT/u);
  assert.equal(redact(reference), 'https://[REDACTED]@files.example.invalid/path?public=1');
  const result = errorResult(new FusionError('REFERENCE_UNAVAILABLE', `Inspect ${reference}`, 'partial', { reference }));
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_/u);
  assert.equal(result.outcome, 'partial');
});

test('encoded nested credential URLs are omitted without rewriting ordinary public encoded URLs', () => {
  const secret = 'https://files.example.invalid/path?X-Amz-Signature=SYNTHETIC_NESTED_SIGNATURE';
  for (const levels of [1, 2, 3, 8]) {
    let encoded = secret;
    for (let index = 0; index < levels; index++) encoded = encodeURIComponent(encoded);
    const reference = `https://example.invalid/redirect?url=${encoded}&safe=public`;
    assert.equal(redact(reference), 'https://example.invalid/redirect?url=[REDACTED]&safe=public');
    const result = errorResult(new FusionError('REFERENCE_UNAVAILABLE', reference, 'unknown', { reference }));
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_NESTED_SIGNATURE/u);
    assert.equal(result.outcome, 'unknown');
  }
  const publicReference = `https://example.invalid/redirect?url=${encodeURIComponent('https://help.autodesk.com/view/fusion360/?guid=PUBLIC_GUID&lang=en')}&label=40%20mm`;
  assert.equal(redact(publicReference), publicReference);
  const overlapping = '?redirect='.repeat(10_000) + 'public%20value';
  assert.match(redact(overlapping), /^\[REDACTED parameter expansion limit\]$/u);
});
