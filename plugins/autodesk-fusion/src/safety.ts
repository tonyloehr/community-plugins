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

export function redact(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').replace(/([?&](?:access_token|refresh_token|token|code|client_secret)=)[^&#\s]+/gi, '$1[REDACTED]').replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED JWT]');
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[circular]';
      seen.add(v);
      if (Array.isArray(v)) return v.map(walk);
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /^(access.?token|refresh.?token|client.?secret|authorization|cookie|password|code_verifier|adsk3LeggedToken)$/i.test(k) ? '[REDACTED]' : walk(x)]));
    }
    return v;
  };
  return walk(value);
}

export function errorResult(error: unknown): { code: string; message: string; outcome: string; details?: unknown } {
  if (error instanceof FusionError) return { code: error.code, message: String(redact(error.message)), outcome: error.outcome, ...(error.details === undefined ? {} : { details: redact(error.details) }) };
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
