import { z } from 'zod';
import { campusSlug, provenance, unitType } from './common.js';
import { collectionLinks, collectionMeta } from './meta.js';

export const DEGREE_LEVELS = [
  'certificate',
  'diploma',
  'associate',
  'baccalaureate',
  'masters',
  'doctorate',
  'post_baccalaureate',
] as const;

export const degreeLevel = z.enum(DEGREE_LEVELS).meta({ example: 'baccalaureate' });

export const OFFERING_STATUSES = [
  'active',
  'suspended',
  'phased_out',
  'unknown',
  'removed',
] as const;

export const offeringStatus = z.enum(OFFERING_STATUSES).meta({ example: 'active' });

/** The unit an offering sits in. Carries `type` because campuses disagree (ADR-002). */
export const offeringUnit = z
  .object({
    ref: z.string().meta({ example: 'manila/coe' }),
    slug: z.string().meta({ example: 'coe' }),
    name: z.string().meta({ example: 'College of Engineering' }),
    type: unitType,
  })
  .meta({ id: 'OfferingUnit' });

/** ADR-003: the degree as taught at one campus. */
export const programOffering = z
  .object({
    ref: z.string().meta({ example: 'manila/bsce' }),
    campus: campusSlug,
    slug: z.string().meta({ example: 'bsce' }),
    program: z.string().nullable().meta({
      description:
        'Canonical program slug, or null when the source name has not been resolved ' +
        'into the registry. Never auto-created from a fuzzy match (ADR-003).',
      example: 'bsce',
    }),
    source_name: z.string().meta({
      description: 'Verbatim, as the campus publishes it, before canonicalisation.',
      example: 'Bachelor of Science in Civil Engineering',
    }),
    local_name: z.string().nullable(),
    unit: offeringUnit.nullable(),
    majors: z.array(z.string()).meta({ description: 'Never `null`.' }),
    years: z.number().nullable(),
    status: offeringStatus,
    curriculum_url: z.string().nullable(),
    accreditation: z.record(z.string(), z.unknown()).nullable(),
    provenance,
  })
  .meta({ id: 'ProgramOffering' });

/** ADR-003: the canonical, campus-agnostic degree. */
export const program = z
  .object({
    ref: z.string().meta({ example: 'bsce' }),
    slug: z.string().meta({ example: 'bsce' }),
    code: z.string().nullable(),
    name: z.string().meta({ example: 'Bachelor of Science in Civil Engineering' }),
    aliases: z.array(z.string()).meta({
      description: 'Source name variants the matching chain accepts. Never `null`.',
    }),
    level: degreeLevel,
    discipline: z.string().nullable(),
    description: z.string().nullable(),
    typical_years: z.number().nullable(),
    provenance,
  })
  .meta({ id: 'Program' });

/**
 * The endpoint that justifies the project (docs/03 §5.3): one degree, every campus
 * that teaches it, with `unit.type` differing per campus. That difference being
 * visible in the payload is ADR-002 paying off.
 */
export const programWithOfferings = program
  .extend({ offerings: z.array(programOffering) })
  .meta({ id: 'ProgramWithOfferings' });

export const programListResponse = z.object({
  data: z.array(program),
  meta: collectionMeta,
  links: collectionLinks,
});

export const programResponse = z.object({ data: programWithOfferings });

export const offeringListResponse = z.object({
  data: z.array(programOffering),
  meta: collectionMeta,
  links: collectionLinks,
});

export const offeringResponse = z.object({ data: programOffering });

export type Program = z.infer<typeof program>;
export type ProgramOffering = z.infer<typeof programOffering>;
