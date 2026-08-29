import { z } from 'zod';
import { unitType } from './common.js';

/**
 * The validate stage of the pipeline (docs/03 §3.4): **reject, never coerce.**
 *
 * A program with a null name is a parser bug, not a data point. Coercion turns a
 * loud, catchable failure into published garbage, so every record shape here is
 * `.strict()` — an adapter emitting a field nobody modelled fails the run rather
 * than having it silently dropped.
 *
 * These are the shapes an adapter's `parse()` emits. They are NOT the API response
 * shapes: `confidence`, `first_seen_at`, ids and refs are all assigned downstream,
 * which is what keeps `parse` pure (ADR-005).
 */

const nonEmpty = z.string().trim().min(1);

/** URL-safe, lowercase, stable. Derived from a durable field, never an editable title. */
export const slugField = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase alphanumeric with single hyphens');

export const academicUnitRecord = z
  .object({
    slug: slugField,
    name: nonEmpty,
    abbreviation: nonEmpty.nullable().default(null),
    /** ADR-002. Never assume 'college' — Cavite uses departments. */
    unit_type: unitType,
    description: nonEmpty.nullable().default(null),
    head_name: nonEmpty.nullable().default(null),
    head_title: nonEmpty.nullable().default(null),
    emails: z.array(z.string()).default([]),
    website: z.string().nullable().default(null),
    status: z.enum(['active', 'unknown', 'removed']).default('active'),
  })
  .strict();

export const programOfferingRecord = z
  .object({
    /** Verbatim, before canonicalisation. What makes `ingest:unmatched` useful. */
    source_name: nonEmpty,
    slug: slugField,
    local_name: nonEmpty.nullable().default(null),
    unit_slug: slugField.nullable().default(null),
    majors: z.array(nonEmpty).default([]),
    years: z.number().positive().max(12).nullable().default(null),
    status: z.enum(['active', 'suspended', 'phased_out', 'unknown', 'removed']).default('active'),
    accreditation: z.record(z.string(), z.unknown()).nullable().default(null),
    curriculum_url: z.string().nullable().default(null),
  })
  .strict();

/** Only the entity types an adapter can currently emit have a schema. Adding one is
 *  a deliberate act: the pipeline refuses to publish an entity type it cannot validate. */
export const RECORD_SCHEMAS = {
  academic_unit: academicUnitRecord,
  program_offering: programOfferingRecord,
} as const;

export type AcademicUnitRecord = z.output<typeof academicUnitRecord>;
export type ProgramOfferingRecord = z.output<typeof programOfferingRecord>;
export type ValidatedEntityType = keyof typeof RECORD_SCHEMAS;
