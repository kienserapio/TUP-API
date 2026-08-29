import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * ASCENDING — order is semantic. `min_confidence` filters with `confidence >= $1`.
 * This order cannot be changed after creation without rewriting nine tables. Errata E1.
 */
export const confidenceLevel = pgEnum('confidence_level', ['low', 'medium', 'high']);

export const ingestMethod = pgEnum('ingest_method', ['crawl', 'manual', 'partner_feed', 'seed']);

export const sourceStatus = pgEnum('source_status', [
  'active',
  'unavailable',
  'suspended',
  'blocked',
  'retired',
]);

/** ADR-002: Manila and Visayas have colleges; Cavite has departments. Never assume. */
export const unitType = pgEnum('unit_type', [
  'college',
  'department',
  'institute',
  'center',
  'program_group',
]);

export const degreeLevel = pgEnum('degree_level', [
  'certificate',
  'diploma',
  'associate',
  'baccalaureate',
  'masters',
  'doctorate',
  'post_baccalaureate',
]);

export const offeringStatus = pgEnum('offering_status', [
  'active',
  'suspended',
  'phased_out',
  'unknown',
  'removed',
]);

export const entityType = pgEnum('entity_type', [
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
]);

export const CONFIDENCE_ORDER = ['low', 'medium', 'high'] as const;
export type Confidence = (typeof CONFIDENCE_ORDER)[number];
