import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { campusCoverage } from '@tup/schemas';
import { sql as raw } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { CACHE_REFERENCE, etagFor } from '../lib/etag.js';

/**
 * Every campus-scoped canonical table. Listed rather than discovered so that adding a
 * table is a deliberate act — a table silently missing from coverage would understate
 * exactly what this endpoint exists to state.
 */
const ENTITY_TABLES: { entityType: string; table: string }[] = [
  { entityType: 'academic_unit', table: 'academic_units' },
  { entityType: 'program_offering', table: 'program_offerings' },
  { entityType: 'office', table: 'offices' },
  { entityType: 'official', table: 'officials' },
  { entityType: 'announcement', table: 'announcements' },
  { entityType: 'document', table: 'documents' },
  { entityType: 'scholarship', table: 'scholarships' },
  { entityType: 'fee_estimate', table: 'fee_estimates' },
  { entityType: 'procedure', table: 'procedures' },
];

const route = createRoute({
  method: 'get',
  path: '/v1/meta/coverage',
  tags: ['meta'],
  summary: 'What this API actually holds, per campus',
  description:
    'Entity counts for every campus, including the campuses with nothing. There is ' +
    'deliberately **no system-wide total** (ADR-012): an aggregate reads as coverage ' +
    'while hiding that one campus contributes none of it, which is the fact a student ' +
    'at that campus most needs. A campus with no adapter reports zeros and ' +
    '`has_adapter: false` rather than being omitted — absence would be ' +
    'indistinguishable from "we did not look".',
  responses: {
    200: {
      description: 'Per-campus coverage.',
      content: {
        'application/json': {
          schema: z.object({
            data: z.object({
              generated_at: z.iso.datetime(),
              by_campus: z.array(campusCoverage),
            }),
          }),
        },
      },
    },
    304: { description: 'Not modified.' },
  },
});

type CountRow = Record<string, unknown> & {
  campus_slug: string;
  entity_type: string;
  n: number;
};

export const metaRoutes = new OpenAPIHono().openapi(route, async (c) => {
  const campuses = await db.execute<{
    slug: string;
    name: string;
    website_status: string;
  }>(raw`SELECT slug, name, website_status::text AS website_status FROM campuses ORDER BY slug`);

  // One UNION ALL rather than nine round trips. Table names come from the constant
  // above, never from a request — docs/13 §11 bans string-built SQL from user input.
  const counts = await db.execute<CountRow>(
    raw.join(
      ENTITY_TABLES.map(
        ({ entityType, table }) =>
          raw`SELECT campus_slug, ${entityType} AS entity_type, count(*)::int AS n
              FROM ${raw.identifier(table)} WHERE campus_slug IS NOT NULL GROUP BY 1`,
      ),
      raw` UNION ALL `,
    ),
  );

  const sources = await db.execute<{
    campus_slug: string;
    total: number;
    active: number;
    blocked: number;
    unavailable: number;
  }>(raw`
    SELECT campus_slug,
           count(*)::int                                            AS total,
           count(*) FILTER (WHERE status = 'active')::int            AS active,
           count(*) FILTER (WHERE status = 'blocked')::int           AS blocked,
           count(*) FILTER (WHERE status IN ('unavailable','suspended','retired'))::int AS unavailable
    FROM sources WHERE campus_slug IS NOT NULL GROUP BY 1`);

  const runs = await db.execute<{ adapter: string; finished_at: Date | string | null }>(raw`
    SELECT adapter, max(finished_at) AS finished_at
    FROM ingest_runs WHERE status = 'ok' GROUP BY adapter`);

  const countsBy = new Map<string, Record<string, number>>();
  for (const row of counts) {
    const bucket = countsBy.get(row.campus_slug) ?? {};
    bucket[row.entity_type] = Number(row.n);
    countsBy.set(row.campus_slug, bucket);
  }
  const sourcesBy = new Map(sources.map((row) => [row.campus_slug, row]));
  const runBy = new Map(runs.map((row) => [row.adapter, row.finished_at]));

  const body = {
    data: {
      generated_at: new Date().toISOString(),
      by_campus: campuses.map((campus) => {
        const counted = countsBy.get(campus.slug) ?? {};
        const source = sourcesBy.get(campus.slug);
        const finished = runBy.get(campus.slug) ?? null;
        const lastIngest =
          finished === null ? null : finished instanceof Date ? finished : new Date(finished);

        return {
          campus: campus.slug,
          name: campus.name,
          website_status: campus.website_status,
          has_adapter: lastIngest !== null,
          last_ingest_at: lastIngest ? lastIngest.toISOString() : null,
          // Zero is reported, never omitted — see the endpoint description.
          counts: Object.fromEntries(
            ENTITY_TABLES.map(({ entityType }) => [entityType, counted[entityType] ?? 0]),
          ),
          sources: {
            total: Number(source?.total ?? 0),
            active: Number(source?.active ?? 0),
            blocked: Number(source?.blocked ?? 0),
            unavailable: Number(source?.unavailable ?? 0),
          },
        };
      }),
    },
  };

  const etag = etagFor({ by_campus: body.data.by_campus });
  c.header('ETag', etag);
  c.header('Cache-Control', CACHE_REFERENCE);
  c.header('Vary', 'Accept-Encoding');
  if (c.req.header('if-none-match') === etag) return c.body(null, 304);
  return c.json(body, 200);
});
