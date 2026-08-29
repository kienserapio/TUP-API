/**
 * The ingestion contracts. docs/03-TDD.md §3.1.
 *
 * These types are the seam between the three layers that must never merge:
 * adapters know how to read a page, the fetcher knows how to ask for one politely,
 * and the pipeline knows how to write. An adapter that could fetch could bypass the
 * politeness layer, which is why `parse` receives bytes it did not request (ADR-005).
 */

export const ENTITY_TYPES = [
  'campus',
  'academic_unit',
  'program',
  'program_offering',
  'office',
  'official',
  'announcement',
  'document',
  'scholarship',
  'fee_estimate',
  'procedure',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export const INGEST_METHODS = ['crawl', 'manual', 'partner_feed', 'seed'] as const;
export type IngestMethod = (typeof INGEST_METHODS)[number];

export type Confidence = 'low' | 'medium' | 'high';

export interface SourceRef {
  url: string;
  entityTypes: EntityType[];
  method: IngestMethod;
  /** Postgres interval literal, e.g. '6 hours'. Defaults to the column default. */
  recrawlInterval?: string;
  /** Free-form adapter hint. `{ role: 'index' }` marks a two-pass discovery root. */
  hint?: Record<string, unknown>;
}

export interface RawSnapshot {
  sourceRef: SourceRef;
  fetchedAt: Date;
  httpStatus: number;
  etag?: string;
  lastModified?: string;
  contentType: string;
  body: Buffer;
  contentHash: string;
}

export interface ParseResult {
  byEntity: Partial<Record<EntityType, unknown[]>>;
  warnings: string[];
}

/**
 * A full-run range for one entity type.
 *
 * Counts **published rows**, not parsed records — canonicalisation can merge many
 * source records into one row before the guard sees them. And full-run means exactly
 * that: the guard skips these on an incremental run, where most sources are unchanged
 * and the count is legitimately partial (errata E3).
 */
export interface Expectation {
  min: number;
  max: number;
}

/**
 * `parse` must be pure — no network, no clock, no randomness. It is the precondition
 * for golden fixture testing, which docs/14 §2 ranks as half of all test effort here.
 */
export interface CampusAdapter {
  readonly campusSlug: string;
  readonly domains: string[];
  discover(): AsyncIterable<SourceRef>;
  parse(snapshot: RawSnapshot): Promise<ParseResult>;
  readonly expectations?: Partial<Record<EntityType, Expectation>>;
}
