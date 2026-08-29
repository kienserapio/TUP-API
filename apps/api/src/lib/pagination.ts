/**
 * Cursor pagination. ADR-009, docs/13 §7.
 *
 * `OFFSET` is banned: it is O(n) at depth, and it duplicates and skips rows whenever
 * the underlying set changes between fetches — which happens on **every ingestion
 * run**. Keyset over a unique, ordered column has neither problem.
 *
 * Cursors are opaque and documented as unparseable. They carry a hash of the filters
 * they were issued under, so re-using one against a different query is a `400` rather
 * than a silently wrong page.
 */
import { createHash } from 'node:crypto';
import { z } from '@hono/zod-openapi';
import { invalidParameter } from './problem.js';

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export const limitParam = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_LIMIT)
  .default(DEFAULT_LIMIT)
  .meta({
    description: `Page size. Default ${DEFAULT_LIMIT}, maximum ${MAX_LIMIT}; above that is a 400.`,
    example: 20,
  });

export const cursorParam = z.string().optional().meta({
  description:
    'Opaque continuation token from links.next. Do not decode or construct one — ' +
    'the format may change without a version bump.',
});

interface CursorPayload {
  v: 1;
  f: string;
  k: string;
}

function fingerprint(filters: Record<string, unknown>): string {
  const stable = Object.entries(filters)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return createHash('sha256').update(JSON.stringify(stable)).digest('base64url').slice(0, 12);
}

export function encodeCursor(filters: Record<string, unknown>, key: string): string {
  const payload: CursorPayload = { v: 1, f: fingerprint(filters), k: key };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Returns the keyset value to resume after. Throws a 400 for anything malformed. */
export function decodeCursor(cursor: string, filters: Record<string, unknown>): string {
  let payload: CursorPayload;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorPayload;
  } catch {
    throw invalidParameter(`cursor '${cursor}' is not a cursor this API issued.`);
  }
  if (payload.v !== 1 || typeof payload.k !== 'string') {
    throw invalidParameter(`cursor '${cursor}' is not a cursor this API issued.`);
  }
  if (payload.f !== fingerprint(filters)) {
    throw invalidParameter(
      `cursor '${cursor}' was issued for a different set of filters. Start the ` +
        `collection again without a cursor when you change a filter.`,
    );
  }
  return payload.k;
}

export interface Page<T> {
  items: T[];
  hasMore: boolean;
  nextKey: string | null;
}

/**
 * Fetch `limit + 1` rows and use the extra one as the has_more signal, so `has_more`
 * is authoritative rather than inferred from a full page (docs/13 §7).
 */
export function paginate<T>(rows: T[], limit: number, keyOf: (row: T) => string): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, hasMore, nextKey: hasMore && last ? keyOf(last) : null };
}

/** `links.self` and `links.next`, as paths with the query the caller actually sent. */
export function links(
  requestUrl: string,
  filters: Record<string, unknown>,
  nextKey: string | null,
): { self: string; next: string | null } {
  const url = new URL(requestUrl);
  const self = `${url.pathname}${url.search}`;
  if (!nextKey) return { self, next: null };

  const nextUrl = new URL(requestUrl);
  nextUrl.searchParams.set('cursor', encodeCursor(filters, nextKey));
  return { self, next: `${nextUrl.pathname}${nextUrl.search}` };
}
