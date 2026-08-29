import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { campus, problemDetails } from '@tup/schemas';
import { schema } from '@tup/db';
import { asc, eq, sql as raw } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { CACHE_REFERENCE, etagFor } from '../lib/etag.js';
import { notFound } from '../lib/problem.js';
import { toProvenance } from '../lib/provenance.js';

const { campuses, sources } = schema;

/** Unknown query parameters are rejected, not ignored. docs/13 §6. */
const listQuery = z
  .object({
    kind: z
      .enum(['main', 'satellite', 'extension'])
      .optional()
      .meta({ description: 'Filter by campus kind.' }),
  })
  .strict();

const selection = {
  slug: campuses.slug,
  ref: campuses.ref,
  name: campuses.name,
  shortName: campuses.shortName,
  kind: campuses.kind,
  website: campuses.website,
  websiteStatus: campuses.websiteStatus,
  address: campuses.address,
  established: campuses.established,
  description: campuses.description,
  firstSeenAt: campuses.firstSeenAt,
  lastVerifiedAt: campuses.lastVerifiedAt,
  confidence: campuses.confidence,
  sourceUrl: sources.url,
  method: sources.method,
};

function present(row: Record<string, unknown>) {
  return {
    slug: row['slug'] as 'manila' | 'cavite' | 'visayas' | 'taguig',
    ref: row['ref'] as string,
    name: row['name'] as string,
    short_name: (row['shortName'] as string | null) ?? null,
    kind: row['kind'] as string,
    website: (row['website'] as string | null) ?? null,
    website_status: row['websiteStatus'] as 'active' | 'suspended',
    address: (row['address'] as Record<string, string> | null) ?? null,
    established: (row['established'] as number | null) ?? null,
    description: (row['description'] as string | null) ?? null,
    provenance: toProvenance({
      sourceUrl: row['sourceUrl'] as string,
      method: row['method'] as string,
      firstSeenAt: row['firstSeenAt'] as Date,
      lastVerifiedAt: row['lastVerifiedAt'] as Date,
      confidence: row['confidence'] as 'low' | 'medium' | 'high',
    }),
  };
}

const listRoute = createRoute({
  method: 'get',
  path: '/v1/campuses',
  tags: ['campuses'],
  summary: 'List every campus in the TUP system',
  description:
    'Four campuses, including Taguig, which has no live source. Taguig is modelled as ' +
    'a first-class campus with `website_status: "suspended"` rather than omitted — ' +
    'absence would be indistinguishable from "we did not look".',
  request: { query: listQuery },
  responses: {
    200: {
      description: 'All campuses.',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(campus),
            meta: z.object({ count: z.number().int(), has_more: z.boolean() }),
          }),
        },
      },
    },
    304: { description: 'Not modified — the If-None-Match ETag still matches.' },
    400: {
      description: 'Unknown or invalid query parameter.',
      content: { 'application/problem+json': { schema: problemDetails } },
    },
  },
});

const getRoute = createRoute({
  method: 'get',
  path: '/v1/campuses/{slug}',
  tags: ['campuses'],
  summary: 'Get one campus by slug',
  request: {
    params: z.object({
      slug: z.string().meta({ description: 'Campus slug.', example: 'manila' }),
    }),
  },
  responses: {
    200: {
      description: 'The campus.',
      content: { 'application/json': { schema: z.object({ data: campus }) } },
    },
    304: { description: 'Not modified — the If-None-Match ETag still matches.' },
    404: {
      description: 'No campus with that slug. Includes trigram-similar suggestions.',
      content: { 'application/problem+json': { schema: problemDetails } },
    },
  },
});

export const campusRoutes = new OpenAPIHono()
  .openapi(listRoute, async (c) => {
    const { kind } = c.req.valid('query');

    const rows = await db
      .select(selection)
      .from(campuses)
      .innerJoin(sources, eq(campuses.sourceId, sources.id))
      .where(kind ? eq(campuses.kind, kind) : undefined)
      .orderBy(asc(campuses.slug));

    const body = {
      data: rows.map((r) => present(r as Record<string, unknown>)),
      meta: { count: rows.length, has_more: false },
    };

    const etag = etagFor(body);
    c.header('ETag', etag);
    c.header('Cache-Control', CACHE_REFERENCE);
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);

    return c.json(body, 200);
  })
  .openapi(getRoute, async (c) => {
    const { slug } = c.req.valid('param');

    const [row] = await db
      .select(selection)
      .from(campuses)
      .innerJoin(sources, eq(campuses.sourceId, sources.id))
      .where(eq(campuses.slug, slug))
      .limit(1);

    if (!row) {
      // docs/13 §8.2: a 404 on a slug-shaped path must attempt did_you_mean.
      // pg_trgm makes this cheap, and it is the difference between a usable API
      // and a frustrating one.
      const suggestions = await db.execute<{ slug: string }>(
        raw`SELECT slug FROM campuses
            WHERE similarity(slug, ${slug}) > 0.2
            ORDER BY similarity(slug, ${slug}) DESC
            LIMIT 3`,
      );
      throw notFound(
        'Campus not found',
        `No campus with slug '${slug}'.`,
        suggestions.map((s) => s.slug),
      );
    }

    const body = { data: present(row as Record<string, unknown>) };
    const etag = etagFor(body);
    c.header('ETag', etag);
    c.header('Cache-Control', CACHE_REFERENCE);
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);

    return c.json(body, 200);
  });
