import { z } from 'zod';
import { confidenceLevel, paginationLinks, paginationMeta } from './common.js';

/**
 * docs/09 §4. `min_confidence` here is the **minimum found in this page of results**,
 * not the filter that was applied — it answers "how much should I trust the worst row
 * I just got?", which is the question that matters when rendering a list.
 */
export const freshness = z
  .object({
    oldest_verified_at: z.iso.datetime().nullable().meta({
      description: 'The least recently verified record in this page.',
    }),
    max_staleness_days: z.number().int(),
    min_confidence: confidenceLevel.nullable(),
    counts_by_confidence: z.object({
      high: z.number().int(),
      medium: z.number().int(),
      low: z.number().int(),
    }),
  })
  .meta({ id: 'Freshness' });

export const collectionMeta = paginationMeta
  .extend({
    generated_at: z.iso.datetime().meta({
      description:
        'When this response was assembled. Independent of data age — read ' +
        'provenance.last_verified_at for that. Deliberately excluded from the ETag.',
    }),
    freshness,
  })
  .meta({ id: 'CollectionMeta' });

export const collectionLinks = paginationLinks.meta({ id: 'CollectionLinks' });

export type Freshness = z.infer<typeof freshness>;

/**
 * ADR-012: coverage is reported **per campus, never aggregated**.
 *
 * A system-wide total is the one number that must not exist here. "412 programs" reads
 * as coverage; it hides that one campus contributes none of them, which is exactly the
 * fact a student at that campus needs. Every figure below is scoped to one campus, and
 * a campus with nothing appears with zeros rather than being omitted.
 */
export const campusCoverage = z
  .object({
    campus: z.string().meta({ example: 'manila' }),
    name: z.string(),
    website_status: z.string().meta({
      description: 'Liveness of the campus site as last verified. Not a claim about the data.',
    }),
    has_adapter: z.boolean().meta({
      description: 'False means nothing has ever been crawled for this campus.',
    }),
    last_ingest_at: z.iso.datetime().nullable(),
    counts: z.record(z.string(), z.number().int()).meta({
      description: 'Row count per entity type. Zero is reported, never omitted.',
    }),
    sources: z.object({
      total: z.number().int(),
      active: z.number().int(),
      blocked: z.number().int(),
      unavailable: z.number().int(),
    }),
  })
  .meta({ id: 'CampusCoverage' });

export const coverageResponse = z.object({
  data: z.object({
    generated_at: z.iso.datetime(),
    by_campus: z.array(campusCoverage),
  }),
});
