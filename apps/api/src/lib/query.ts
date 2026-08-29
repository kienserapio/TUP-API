/**
 * Query fragments shared by every collection endpoint.
 *
 * `min_confidence` is `WHERE confidence >= $1`, which is only correct because the
 * enum is declared ascending — `('low','medium','high')`. The v2.0 docs had it
 * descending, which silently inverted every filter and is unfixable after migration
 * 001 ships. Errata E1, docs/13 §5.1.
 */
import { z } from '@hono/zod-openapi';
import { sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { CAMPUS_SLUGS, CONFIDENCE_LEVELS } from '@tup/schemas';
import { cursorParam, limitParam } from './pagination.js';

export const campusParam = z.enum(CAMPUS_SLUGS).optional().meta({
  description: 'Restrict to one campus. Validated against the four known slugs.',
  example: 'manila',
});

export const minConfidenceParam = z
  .enum(CONFIDENCE_LEVELS)
  .optional()
  .meta({
    description:
      'Inclusive lower bound: `confidence >= value`. Default is no filter — the API ' +
      'returns everything and labels it, because hiding low-confidence rows leaves a ' +
      'consumer unable to tell "none exist" from "none we vouch for".',
    example: 'medium',
  });

export const paginationParams = { limit: limitParam, cursor: cursorParam };

export function atLeastConfidence(
  column: PgColumn,
  level: string | undefined,
): SQL | undefined {
  if (!level) return undefined;
  return sql`${column} >= ${level}::confidence_level`;
}

/** Keyset resume. The ordering column is unique, so `>` neither skips nor duplicates. */
export function after(column: PgColumn, key: string | undefined): SQL | undefined {
  if (key === undefined) return undefined;
  return sql`${column} > ${key}`;
}
