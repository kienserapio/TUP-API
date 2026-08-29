import { createHash } from 'node:crypto';

/**
 * Strong ETag over the serialized body.
 *
 * docs/13 §10: cache TTL and data age are independent. A five-minute-old cache of a
 * nineteen-year-old fact still tells the truth about that fact, because
 * last_verified_at is inside the cached body.
 */
export function etagFor(body: unknown): string {
  return `"${createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 27)}"`;
}

export const CACHE_REFERENCE = 'public, max-age=300, stale-while-revalidate=3600';
export const CACHE_ANNOUNCEMENTS = 'public, max-age=60';
export const CACHE_NONE = 'no-store';
