import { z } from 'zod';
import { campusSlug, provenance, unitType } from './common.js';
import { collectionLinks, collectionMeta } from './meta.js';

/**
 * ADR-002 in the payload. `unit_type` is never omitted and never flattened to
 * "college" for convenience: Manila and Visayas have colleges, Cavite has departments,
 * and a consumer that assumes otherwise is wrong on a third of the system.
 * docs/13 §5.2.
 */
export const academicUnit = z
  .object({
    ref: z.string().meta({
      description: 'Permanent public identifier, `{campus}/{slug}`. Never contains a UUID.',
      example: 'manila/coe',
    }),
    campus: campusSlug,
    slug: z.string().meta({ example: 'coe' }),
    name: z.string().meta({ example: 'College of Engineering' }),
    abbreviation: z.string().nullable(),
    unit_type: unitType,
    description: z.string().nullable(),
    head_name: z.string().nullable(),
    head_title: z.string().nullable(),
    emails: z.array(z.string()).meta({ description: 'Official addresses only. Never `null`.' }),
    website: z.string().nullable(),
    status: z.string().meta({
      description: "'active', or 'unknown'/'removed' once the source stopped listing it.",
      example: 'active',
    }),
    provenance,
  })
  .meta({ id: 'AcademicUnit' });

export const academicUnitListResponse = z.object({
  data: z.array(academicUnit),
  meta: collectionMeta,
  links: collectionLinks,
});

export const academicUnitResponse = z.object({ data: academicUnit });

export type AcademicUnit = z.infer<typeof academicUnit>;
