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
