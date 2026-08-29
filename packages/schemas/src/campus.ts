import { z } from 'zod';
import { campusSlug, provenance, sourceStatus } from './common.js';

export const campus = z
  .object({
    slug: campusSlug,
    ref: z.string().meta({
      description: 'Permanent, globally unique public identifier. For a campus this equals slug.',
      example: 'manila',
    }),
    name: z.string(),
    short_name: z.string().nullable(),
    kind: z.string().meta({ description: 'main | satellite | extension', example: 'main' }),
    website: z.string().nullable().meta({
      description: 'Canonical origin. Two campuses do not serve on the host you would guess.',
    }),
    website_status: sourceStatus,
    address: z
      .object({
        street: z.string().optional(),
        city: z.string().optional(),
        province: z.string().optional(),
        region: z.string().optional(),
        postal: z.string().optional(),
      })
      .nullable(),
    established: z.number().int().nullable(),
    description: z.string().nullable(),
    provenance,
  })
  .meta({ id: 'Campus' });

export const campusListResponse = z.object({
  data: z.array(campus),
  meta: z.object({ count: z.number().int(), has_more: z.boolean() }),
});

export const campusResponse = z.object({ data: campus });

export type Campus = z.infer<typeof campus>;
