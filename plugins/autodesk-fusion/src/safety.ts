import { createHash, randomUUID } from 'node:crypto';

export class FusionError extends Error {
  constructor(public code: string, message: string, public outcome: 'none' | 'partial' | 'unknown' = 'none', public details?: unknown) {
    super(message); this.name = 'FusionError';
  }
}

export function assertJson(value: unknown, maxBytes = 1_048_576): void {
  let nodes = 0;
  const visit = (v: unknown, depth: number): void => {
    if (++nodes > 50_000 || depth > 32) throw new FusionError('INPUT_LIMIT', 'JSON exceeds the structural limit.');
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'string') {
      if (v.includes('\0')) throw new FusionError('INVALID_INPUT', 'NUL characters are forbidden.');
      return;
    }
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (Array.isArray(v)) { v.forEach(x => visit(x, depth + 1)); return; }
    if (typeof v !== 'object' || !v || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) {
      throw new FusionError('INVALID_INPUT', 'Only finite JSON data is accepted.');
    }
    for (const [k, x] of Object.entries(v)) {
      if (['__proto__', 'prototype', 'constructor'].includes(k)) throw new FusionError('INVALID_INPUT', 'Reserved JSON key.');
      visit(x, depth + 1);
    }
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) throw new FusionError('INPUT_LIMIT', 'JSON exceeds the byte limit.');
}

export function canonicalJson(value: unknown): string {
  assertJson(value, 16_777_216);
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([k, x]) => [k, sort(x)]));
    return v;
  };
  return JSON.stringify(sort(value));
}

export const hash = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
export const hashBytes = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const newId = (prefix: string): string => `${prefix}_${randomUUID()}`;
export const now = (): string => new Date().toISOString();

function redactBounded(value: unknown, maxDepth: number, maxNodes: number): unknown {
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  const walk = (v: unknown, depth = 0): unknown => {
    if (++nodes > maxNodes || depth > maxDepth) throw new FusionError('INPUT_LIMIT', 'Redacted data exceeds the structural limit.');
    if (typeof v === 'string') return v.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').replace(/([?&](?:access_token|refresh_token|token|code|client_secret)=)[^&#\s]+/gi, '$1[REDACTED]').replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED JWT]');
    if (v && typeof v === 'object') {
      if (ancestors.has(v)) return '[circular]';
      ancestors.add(v);
      try {
        // Plans share selection arrays between their public operation and the
        // reviewed provider arguments. Only an ancestor reference is a cycle.
        if (Array.isArray(v)) return v.map(x => walk(x, depth + 1));
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(/^(access.?token|refresh.?token|client.?secret|authorization|cookie|password|code_verifier|adsk3LeggedToken)$/i.test(k) ? '[REDACTED]' : x, depth + 1)]));
      } finally {
        ancestors.delete(v);
      }
    }
    return v;
  };
  return walk(value);
}

export function redact(value: unknown): unknown {
  return redactBounded(value, 32, 50_000);
}

function errorDetails(value: unknown): unknown {
  try {
    // Leave structural headroom for the plan, audit and protocol envelopes.
    // Diagnostic formatting must not discard a known partial/unknown outcome.
    const cleaned = redactBounded(value, 16, 5_000);
    assertJson(cleaned, 65_536);
    return cleaned;
  } catch {
    return { diagnostics_omitted: true, reason: 'Diagnostic details could not be safely represented as bounded JSON.' };
  }
}

export function errorResult(error: unknown): { code: string; message: string; outcome: string; details?: unknown } {
  if (error instanceof FusionError) return { code: error.code, message: String(redact(error.message)), outcome: error.outcome, ...(error.details === undefined ? {} : { details: errorDetails(error.details) }) };
  if (error instanceof Error && 'code' in error) {
    const e = error as Error & { code: string; outcome?: string };
    return { code: e.code, message: String(redact(e.message)), outcome: e.outcome ?? 'unknown' };
  }
  return { code: 'INTERNAL_ERROR', message: 'The operation failed. Consult the local diagnostic record; no automatic write retry was attempted.', outcome: 'unknown' };
}

export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(fn, fn);
    this.tail = pending.catch(() => undefined);
    return pending;
  }
}
