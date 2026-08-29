import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import {
  collectionLinks,
  collectionMeta,
  problemDetails,
  program as programSchema,
  programWithOfferings,
} from '@tup/schemas';
import { schema } from '@tup/db';
import { and, asc, eq, exists, ilike, sql as raw } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { CACHE_REFERENCE, etagFor } from '../lib/etag.js';
import { notFound } from '../lib/problem.js';
import { cacheablePart, collection } from '../lib/collection.js';
import { decodeCursor, paginate } from '../lib/pagination.js';
import {
  after,
  atLeastConfidence,
  campusParam,
  minConfidenceParam,
  paginationParams,
} from '../lib/query.js';
import {
  offeringSelection,
  presentOffering,
  presentProgram,
  programSelection,
} from '../lib/present.js';

const { academicUnits, programOfferings, programs, sources } = schema;

const listQuery = z
  .object({
    campus: campusParam,
    level: z
      .enum([
        'certificate',
        'diploma',
        'associate',
        'baccalaureate',
        'masters',
        'doctorate',
        'post_baccalaureate',
      ])
      .optional(),
    unit: z.string().optional().meta({
      description: 'Unit ref, e.g. `manila/coe`. Matches programs offered by that unit.',
      example: 'manila/coe',
    }),
    discipline: z.string().optional().meta({ example: 'engineering' }),
    status: z
      .enum(['active', 'suspended', 'phased_out', 'unknown', 'removed'])
      .optional()
      .meta({ description: 'Status of the offering used to match `campus`/`unit`.' }),
    q: z.string().min(1).max(200).optional().meta({
      description: 'Case-insensitive substring of the program name.',
      example: 'civil',
    }),
    min_confidence: minConfidenceParam,
    ...paginationParams,
  })
  .strict();

const listRoute = createRoute({
  method: 'get',
  path: '/v1/programs',
  tags: ['programs'],
  summary: 'List canonical degree programs',
  description:
    'The campus-agnostic degree registry (ADR-003). `campus`, `unit` and `status` are ' +
    'filters over the *offerings* of each program — a program is not owned by a ' +
    'campus, which is why there is no `/v1/campuses/{campus}/programs` (docs/13 §2.3).',
  request: { query: listQuery },
  responses: {
    200: {
      description: 'A page of canonical programs.',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(programSchema),
            meta: collectionMeta,
            links: collectionLinks,
          }),
        },
      },
    },
    304: { description: 'Not modified.' },
    400: {
      description: 'Unknown parameter, limit above 100, or a mismatched cursor.',
      content: { 'application/problem+json': { schema: problemDetails } },
    },
  },
});

const getRoute = createRoute({
  method: 'get',
  path: '/v1/programs/{slug}',
  tags: ['programs'],
  summary: 'Get one degree and every campus that teaches it',
  description:
    'The endpoint the project exists for: one canonical degree with its `offerings[]` ' +
    'across campuses. Note that `unit.type` differs per campus — Manila and Visayas ' +
    'teach through colleges, Cavite through departments (ADR-002).',
  request: {
    params: z.object({ slug: z.string().meta({ example: 'bsce' }) }),
    query: z.object({ campus: campusParam }).strict(),
  },
  responses: {
    200: {
      description: 'The degree and its offerings.',
      content: { 'application/json': { schema: z.object({ data: programWithOfferings }) } },
    },
    304: { description: 'Not modified.' },
    404: {
      description: 'No program with that slug. Includes trigram-similar suggestions.',
      content: { 'application/problem+json': { schema: problemDetails } },
    },
  },
});

export const programRoutes = new OpenAPIHono()
  .openapi(listRoute, async (c) => {
    const { campus, level, unit, discipline, status, q, min_confidence, limit, cursor } =
      c.req.valid('query');
    const filters = { campus, level, unit, discipline, status, q, min_confidence, limit };

    // Campus, unit and status describe an offering, not the degree, so they narrow via
    // an EXISTS over program_offerings rather than by joining and de-duplicating.
    const offeringPredicate =
      campus || unit || status
        ? exists(
            db
              .select({ one: raw`1` })
              .from(programOfferings)
              .leftJoin(academicUnits, eq(programOfferings.unitId, academicUnits.id))
              .where(
                and(
                  eq(programOfferings.programId, programs.id),
                  campus ? eq(programOfferings.campusSlug, campus) : undefined,
                  unit ? eq(academicUnits.ref, unit) : undefined,
                  status ? eq(programOfferings.status, status) : undefined,
                ),
              ),
          )
        : undefined;

    const rows = await db
      .select(programSelection)
      .from(programs)
      .innerJoin(sources, eq(programs.sourceId, sources.id))
      .where(
        and(
          offeringPredicate,
          level ? eq(programs.level, level) : undefined,
          discipline ? eq(programs.discipline, discipline) : undefined,
          q ? ilike(programs.name, `%${q}%`) : undefined,
          atLeastConfidence(programs.confidence, min_confidence),
          after(programs.slug, cursor ? decodeCursor(cursor, filters) : undefined),
        ),
      )
      .orderBy(asc(programs.slug))
      .limit(limit + 1);

    const page = paginate(rows.map(presentProgram), limit, (row) => row.slug);
    const body = collection({
      items: page.items,
      hasMore: page.hasMore,
      nextKey: page.nextKey,
      requestUrl: c.req.url,
      filters,
    });

    const etag = etagFor(cacheablePart(body));
    c.header('ETag', etag);
    c.header('Cache-Control', CACHE_REFERENCE);
    c.header('Vary', 'Accept-Encoding');
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);
    return c.json(body, 200);
  })
  .openapi(getRoute, async (c) => {
    const { slug } = c.req.valid('param');
    const { campus } = c.req.valid('query');

    const [row] = await db
      .select(programSelection)
      .from(programs)
      .innerJoin(sources, eq(programs.sourceId, sources.id))
      .where(eq(programs.slug, slug))
      .limit(1);

    if (!row) {
      const suggestions = await db.execute<{ slug: string }>(
        raw`SELECT slug FROM programs
            WHERE similarity(slug, ${slug}) > 0.2 OR similarity(name, ${slug}) > 0.2
            ORDER BY greatest(similarity(slug, ${slug}), similarity(name, ${slug})) DESC
            LIMIT 3`,
      );
      throw notFound(
        'Program not found',
        `No program with slug '${slug}'.`,
        suggestions.map((s) => s.slug),
      );
    }

    const offeringRows = await db
      .select(offeringSelection)
      .from(programOfferings)
      .innerJoin(sources, eq(programOfferings.sourceId, sources.id))
      .innerJoin(programs, eq(programOfferings.programId, programs.id))
      .leftJoin(academicUnits, eq(programOfferings.unitId, academicUnits.id))
      .where(
        and(
          eq(programs.slug, slug),
          campus ? eq(programOfferings.campusSlug, campus) : undefined,
        ),
      )
      .orderBy(asc(programOfferings.campusSlug));

    const body = {
      data: { ...presentProgram(row), offerings: offeringRows.map(presentOffering) },
    };
    const etag = etagFor(body);
    c.header('ETag', etag);
    c.header('Cache-Control', CACHE_REFERENCE);
    c.header('Vary', 'Accept-Encoding');
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);
    return c.json(body, 200);
  });
