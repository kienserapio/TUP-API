import { z } from 'zod';

export const CAMPUS_SLUGS = ['manila', 'cavite', 'visayas', 'taguig'] as const;
export const campusSlug = z.enum(CAMPUS_SLUGS).meta({
  description: 'Campus identifier.',
  example: 'manila',
});

/** ASCENDING. `min_confidence` filters with `confidence >= value`. Errata E1. */
export const CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const;
export const confidenceLevel = z.enum(CONFIDENCE_LEVELS).meta({
  description:
    'How much this record should be trusted. Ascending: low < medium < high. ' +
    'Derived from source freshness and entity type, not from parser certainty.',
  example: 'high',
});

/** ADR-002: Manila and Visayas have colleges; Cavite has departments. Never assume. */
export const UNIT_TYPES = ['college', 'department', 'institute', 'center', 'program_group'] as const;
export const unitType = z.enum(UNIT_TYPES).meta({
  description:
    'Organisational vocabulary of this unit. Campuses differ: Manila and Visayas use ' +
    'colleges, Cavite uses departments. Always read this field; never assume "college".',
  example: 'college',
});

export const SOURCE_STATUSES = [
  'active',
  'unavailable',
  'suspended',
  'blocked',
  'retired',
] as const;
export const sourceStatus = z.enum(SOURCE_STATUSES).meta({
  description:
    "Liveness of the campus's public website, as last verified. 'suspended' means the " +
    "host serves a suspended-account page (HTTP 200), which differs from 'unavailable'. " +
    'This describes the site, not the data: a campus can be `active` here and still ' +
    'carry `confidence: low`, meaning nothing has been read from it yet.',
  example: 'active',
});

/**
 * ADR-004: provenance ships in the DEFAULT payload — not behind ?include=, not in a
 * debug mode. An opt-in trust signal is a trust signal nobody sees.
 */
export const provenance = z
  .object({
    source_url: z.string().meta({
      description: 'Where this record came from. A citable URL, or seed:// for curated rows.',
    }),
    first_seen_at: z.iso.datetime().meta({ description: 'When this record was first ingested.' }),
    last_verified_at: z.iso.datetime().meta({
      description: 'When the source was last confirmed to still say this. NOT when TUP updated it.',
    }),
    staleness_days: z.number().int().meta({
      description: 'Whole days since last_verified_at.',
    }),
    confidence: confidenceLevel,
    method: z.string().meta({ description: 'crawl | manual | partner_feed | seed', example: 'seed' }),
  })
  .meta({ id: 'Provenance' });

export const paginationMeta = z
  .object({
    count: z.number().int().meta({ description: 'Number of items in this page.' }),
    has_more: z
      .boolean()
      .meta({ description: 'Authoritative signal for "keep paginating". Prefer over links.next.' }),
  })
  .meta({ id: 'PaginationMeta' });

export const paginationLinks = z
  .object({
    self: z.string(),
    next: z.string().nullable().meta({
      description: 'Opaque. Do not decode or construct cursors — the format may change.',
    }),
  })
  .meta({ id: 'PaginationLinks' });

/** RFC 9457 Problem Details. Every error in this API uses this shape. */
export const problemDetails = z
  .object({
    type: z.string().meta({ description: 'URI identifying the error class. Resolves to docs.' }),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().meta({ description: 'Names the offending value, not just the class.' }),
    instance: z.string().optional(),
    did_you_mean: z.array(z.string()).optional().meta({
      description: 'Trigram-similar identifiers, on 404 for a slug-shaped path.',
    }),
  })
  .meta({ id: 'ProblemDetails' });

export type Provenance = z.infer<typeof provenance>;
export type CampusSlug = (typeof CAMPUS_SLUGS)[number];
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];
