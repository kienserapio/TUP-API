import { sql } from 'drizzle-orm';
import { integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { entityType } from './enums.js';
import { ingestRuns, snapshots } from './sources.js';

/**
 * ADR-006: quarantine preserves existing data. `incoming_count` and `current_count`
 * are stored so RB-01 can be diagnosed without re-deriving them from the snapshot.
 */
export const quarantine = pgTable('quarantine', {
  id: uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`),
  runId: uuid('run_id').references(() => ingestRuns.id),
  adapter: text('adapter').notNull(),
  entityType: entityType('entity_type').notNull(),
  reason: text('reason').notNull(),
  incomingCount: integer('incoming_count'),
  currentCount: integer('current_count'),
  /** The records that were NOT published. The starting point for the RB-01 diff. */
  payload: jsonb('payload').notNull(),
  snapshotId: uuid('snapshot_id').references(() => snapshots.id),
  issueUrl: text('issue_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolution: text('resolution'),
});

/** PRD C5: slugs are permanent. A rename writes an alias and serves a 301. */
export const slugAliases = pgTable(
  'slug_aliases',
  {
    entityType: entityType('entity_type').notNull(),
    oldRef: text('old_ref').notNull(),
    newRef: text('new_ref').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.entityType, t.oldRef] })],
);
