import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { entityType, ingestMethod, sourceStatus } from './enums.js';

export const sources = pgTable(
  'sources',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    url: text('url').notNull().unique(),
    origin: text('origin').notNull(),
    domain: text('domain').notNull(),
    campusSlug: text('campus_slug'),
    entityTypes: entityType('entity_types').array().notNull(),
    method: ingestMethod('method').notNull(),
    status: sourceStatus('status').notNull().default('active'),

    robotsAllowed: boolean('robots_allowed'),
    /** "allowed by robots.txt" and "allowed because there is no robots.txt" differ. E12. */
    robotsPresent: boolean('robots_present'),
    robotsCheckedAt: timestamp('robots_checked_at', { withTimezone: true }),
    /** Parsed Content-Signal. A changed signal fails the run rather than being logged. E11. */
    contentSignal: jsonb('content_signal'),

    crawlEnabled: boolean('crawl_enabled').notNull().default(true),
    recrawlInterval: text('recrawl_interval').notNull().default('7 days'),
    httpVersion: text('http_version'),

    lastFetchAt: timestamp('last_fetch_at', { withTimezone: true }),
    lastChangeAt: timestamp('last_change_at', { withTimezone: true }),
    lastStatusCode: integer('last_status_code'),
    probeNote: text('probe_note'),

    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('sources_domain_status_idx').on(t.domain, t.status),
    index('sources_campus_slug_idx').on(t.campusSlug),
  ],
);

export const ingestRuns = pgTable('ingest_runs', {
  id: uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`),
  adapter: text('adapter').notNull(),
  mode: text('mode').notNull().default('incremental'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  status: text('status').notNull().default('running'),
  /** Sources ACTUALLY parsed. Reconcile and guard scope to this array. Errata E3. */
  sourceIds: uuid('source_ids').array().notNull().default(sql`'{}'`),
  sourcesFetched: integer('sources_fetched').default(0),
  sourcesUnchanged: integer('sources_unchanged').default(0),
  sourcesFailed: integer('sources_failed').default(0),
  recordsPublished: integer('records_published').default(0),
  quarantined: integer('quarantined').default(0),
  error: text('error'),
});

export const snapshots = pgTable(
  'snapshots',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    runId: uuid('run_id').references(() => ingestRuns.id),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    httpStatus: integer('http_status'),
    etag: text('etag'),
    lastModified: text('last_modified'),
    contentHash: text('content_hash').notNull(),
    contentType: text('content_type'),
    byteSize: integer('byte_size'),
    /** Keyed by content_hash so identical content is stored once. E18. */
    storageKey: text('storage_key').notNull(),
    compression: text('compression').notNull().default('gzip'),
    parseStatus: text('parse_status').notNull().default('pending'),
    parseError: text('parse_error'),
  },
  (t) => [index('snapshots_source_fetched_idx').on(t.sourceId, t.fetchedAt)],
);

export const excludedSources = pgTable('excluded_sources', {
  urlPattern: text('url_pattern').primaryKey(),
  reason: text('reason').notNull(),
  requestedBy: text('requested_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const changeEvents = pgTable(
  'change_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    runId: uuid('run_id').references(() => ingestRuns.id),
    entityType: entityType('entity_type').notNull(),
    entityRef: text('entity_ref').notNull(),
    operation: text('operation').notNull(),
    diff: jsonb('diff'),
    snapshotId: uuid('snapshot_id').references(() => snapshots.id),
  },
  (t) => [index('change_events_cursor_idx').on(t.occurredAt, t.id)],
);
