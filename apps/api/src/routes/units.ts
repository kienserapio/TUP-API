import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { academicUnit, collectionLinks, collectionMeta, problemDetails } from '@tup/schemas';
import { schema } from '@tup/db';
import { and, asc, eq, sql as raw } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { CACHE_REFERENCE, etagFor } from '../lib/etag.js';
import { notFound } from '../lib/problem.js';
import { toProvenance } from '../lib/provenance.js';
import { cacheablePart, collection } from '../lib/collection.js';
import { decodeCursor, paginate } from '../lib/pagination.js';
import { after, atLeastConfidence, campusParam, minConfidenceParam, paginationParams } from '../lib/query.js';

const { academicUnits, sources } = schema;

const selection = {
  ref: academicUnits.ref,
  campusSlug: academicUnits.campusSlug,
  slug: academicUnits.slug,
  name: academicUnits.name,
  abbreviation: academicUnits.abbreviation,
  unitType: academicUnits.unitType,
  description: academicUnits.description,
  headName: academicUnits.headName,
  headTitle: academicUnits.headTitle,
  emails: academicUnits.emails,
  website: academicUnits.website,
  status: academicUnits.status,
  firstSeenAt: academicUnits.firstSeenAt,
  lastVerifiedAt: academicUnits.lastVerifiedAt,
  confidence: academicUnits.confidence,
  sourceUrl: sources.url,
  method: sources.method,
};

type Row = {
  [K in keyof typeof selection]: unknown;
};

function present(row: Row) {
  return {
    ref: row.ref as string,
    campus: row.campusSlug as 'manila' | 'cavite' | 'visayas' | 'taguig',
    slug: row.slug as string,
    name: row.name as string,
    abbreviation: (row.abbreviation as string | null) ?? null,
    // docs/13 §5.2: never omitted, never flattened to 'college'.
    unit_type: row.unitType as 'college' | 'department',
    description: (row.description as string | null) ?? null,
    head_name: (row.headName as string | null) ?? null,
    head_title: (row.headTitle as string | null) ?? null,
    emails: (row.emails as string[] | null) ?? [],
    website: (row.website as string | null) ?? null,
    status: row.status as string,
    provenance: toProvenance({
      sourceUrl: row.sourceUrl as string,
      method: row.method as string,
      firstSeenAt: row.firstSeenAt as Date,
      lastVerifiedAt: row.lastVerifiedAt as Date,
      confidence: row.confidence as 'low' | 'medium' | 'high',
    }),
  };
}

const listQuery = z
  .object({
    campus: campusParam,
    type: z
      .enum(['college', 'department', 'institute', 'center', 'program_group'])
      .optional()
      .meta({ description: 'Filter by organisational vocabulary. See ADR-002.' }),
    min_confidence: minConfidenceParam,
    ...paginationParams,
  })
  .strict();

const listRoute = createRoute({
  method: 'get',
  path: '/v1/units',
  tags: ['units'],
  summary: 'List academic units across the TUP system',
  description:
    'Colleges, departments, institutes and centres. **Always read `unit_type`** — ' +
    'Manila and Visayas are organised into colleges, Cavite into departments, and an ' +
    'integration that assumes "college" is wrong for a third of the system (ADR-002).',
  request: { query: listQuery },
  responses: {
    200: {
      description: 'A page of academic units.',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(academicUnit),
            meta: collectionMeta,
            links: collectionLinks,
          }),
        },
      },
    },
    304: { description: 'Not modified — the If-None-Match ETag still matches.' },
    400: {
      description: 'Unknown parameter, limit above 100, or a cursor from a different query.',
      content: { 'application/problem+json': { schema: problemDetails } },
    },
  },
});

const getRoute = createRoute({
  method: 'get',
  path: '/v1/units/{campus}/{unit}',
  tags: ['units'],
  summary: 'Get one academic unit',
  description:
    'Unit slugs are only unique within a campus — `coe` exists at both Manila and ' +
    'Visayas — so the path carries the campus (docs/13 §2.2).',
  request: {
    params: z.object({
      campus: z.string().meta({ example: 'manila' }),
      unit: z.string().meta({ example: 'coe' }),
    }),
    // docs/13 §6: unknown query parameters are rejected on EVERY endpoint, not only
    // the filterable ones. Silently ignoring a typo'd parameter returns data that
    // looks filtered and is not — the worst failure for an API whose value is precision.
    query: z.object({}).strict(),
  },
  responses: {
    200: {
      description: 'The academic unit.',
      content: { 'application/json': { schema: z.object({ data: academicUnit }) } },
    },
    304: { description: 'Not modified.' },
    404: {
      description: 'No such unit. Includes trigram-similar suggestions.',
      content: { 'application/problem+json': { schema: problemDetails } },
    },
  },
});

/**
 * docs/13 §2.3: a sub-collection is right when the child cannot exist without the
 * parent, and an academic unit belongs to exactly one campus. (Contrast
 * `/v1/campuses/{campus}/programs`, which the same section rejects: a program is
 * campus-agnostic, so campus is a filter over its offerings, not a parent path.)
 */
const campusUnitsRoute = createRoute({
  method: 'get',
  path: '/v1/campuses/{campus}/units',
  tags: ['units'],
  summary: 'List the academic units of one campus',
  request: {
    params: z.object({ campus: z.enum(['manila', 'cavite', 'visayas', 'taguig']) }),
    query: z
      .object({
        type: z
          .enum(['college', 'department', 'institute', 'center', 'program_group'])
          .optional(),
        min_confidence: minConfidenceParam,
        ...paginationParams,
      })
      .strict(),
  },
  responses: {
    200: {
      description: "The campus's academic units.",
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(academicUnit),
            meta: collectionMeta,
            links: collectionLinks,
          }),
        },
      },
    },
    304: { description: 'Not modified.' },
    400: {
      description: 'Unknown parameter, unknown campus, or a mismatched cursor.',
      content: { 'application/problem+json': { schema: problemDetails } },
    },
  },
});

interface ListParams {
  campus?: string | undefined;
  type?: 'college' | 'department' | 'institute' | 'center' | 'program_group' | undefined;
  min_confidence?: 'low' | 'medium' | 'high' | undefined;
  limit: number;
  cursor?: string | undefined;
}

/** One query, two routes. The envelope cannot drift between them if it is built once. */
async function listUnits(c: { req: { url: string } }, params: ListParams) {
  const { campus, type, min_confidence, limit, cursor } = params;
  const filters = { campus, type, min_confidence, limit };

  const rows = await db
    .select(selection)
    .from(academicUnits)
    .innerJoin(sources, eq(academicUnits.sourceId, sources.id))
    .where(
      and(
        campus ? eq(academicUnits.campusSlug, campus) : undefined,
        type ? eq(academicUnits.unitType, type) : undefined,
        atLeastConfidence(academicUnits.confidence, min_confidence),
        after(academicUnits.ref, cursor ? decodeCursor(cursor, filters) : undefined),
      ),
    )
    .orderBy(asc(academicUnits.ref))
    .limit(limit + 1);

  const page = paginate(rows.map(present), limit, (row) => row.ref);
  return collection({
    items: page.items,
    hasMore: page.hasMore,
    nextKey: page.nextKey,
    requestUrl: c.req.url,
    filters,
  });
}

export const unitRoutes = new OpenAPIHono()
  .openapi(listRoute, async (c) => {
    const body = await listUnits(c, c.req.valid('query'));

    const etag = etagFor(cacheablePart(body));
    c.header('ETag', etag);
    c.header('Cache-Control', CACHE_REFERENCE);
    c.header('Vary', 'Accept-Encoding');
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);
    return c.json(body, 200);
  })
  .openapi(campusUnitsRoute, async (c) => {
    const { campus } = c.req.valid('param');
    const body = await listUnits(c, { ...c.req.valid('query'), campus });

    const etag = etagFor(cacheablePart(body));
    c.header('ETag', etag);
    c.header('Cache-Control', CACHE_REFERENCE);
    c.header('Vary', 'Accept-Encoding');
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);
    return c.json(body, 200);
  })
  .openapi(getRoute, async (c) => {
    const { campus, unit } = c.req.valid('param');
    const ref = `${campus}/${unit}`;

    const [row] = await db
      .select(selection)
      .from(academicUnits)
      .innerJoin(sources, eq(academicUnits.sourceId, sources.id))
      .where(eq(academicUnits.ref, ref))
      .limit(1);

    if (!row) {
      const suggestions = await db.execute<{ ref: string }>(
        raw`SELECT ref FROM academic_units
            WHERE similarity(ref, ${ref}) > 0.2
            ORDER BY similarity(ref, ${ref}) DESC
            LIMIT 3`,
      );
      throw notFound(
        'Academic unit not found',
        `No academic unit with ref '${ref}'.`,
        suggestions.map((s) => s.ref),
      );
    }

    const body = { data: present(row) };
    const etag = etagFor(body);
    c.header('ETag', etag);
    c.header('Cache-Control', CACHE_REFERENCE);
    c.header('Vary', 'Accept-Encoding');
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);
    return c.json(body, 200);
  });
