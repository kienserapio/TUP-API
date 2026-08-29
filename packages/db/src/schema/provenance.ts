import { integer, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { confidenceLevel } from './enums.js';

/**
 * ADR-004: every canonical row carries provenance, and every API response echoes it
 * in the default payload. Defined once so it cannot drift across seventeen tables.
 *
 * `source_id` is NOT NULL: every row must be attributable. Hand-seeded rows point at
 * the synthetic seed:// source created in migration 003 — hand curation is a stronger
 * provenance claim than a scrape, not a weaker one.
 */
export const provenance = {
  sourceId: uuid('source_id').notNull(),
  contentHash: text('content_hash'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }).notNull().defaultNow(),
  confidence: confidenceLevel('confidence').notNull().default('medium'),
  missCount: integer('miss_count').notNull().default(0),
};
