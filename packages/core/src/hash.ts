import { createHash } from 'node:crypto';

/** Content-hash gating replaces conditional GET everywhere. Errata E2, docs/08 §2.1. */
export function contentHash(body: Buffer | string): string {
  return createHash('sha256').update(body).digest('hex');
}

/** Stable hash of a canonical record, used for per-row `content_hash`. */
export function recordHash(record: unknown): string {
  return createHash('sha256').update(stableStringify(record)).digest('hex');
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
