import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import {
  collectionLinks,
  collectionMeta,
  problemDetails,
  programOffering,
} from '@tup/schemas';
import { schema } from '@tup/db';
import { and, asc, eq, ilike, isNull, sql as raw } from 'drizzle-orm';
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
import { offeringSelection, presentOffering } from '../lib/present.js';

const { academicUnits, programOfferings, programs, sources } = schema;

const base = () =>
  db
    .select(offeringSelection)
    .from(programOfferings)
    .innerJoin(sources, eq(programOfferings.sourceId, sources.id))
    .leftJoin(programs, eq(programOfferings.programId, programs.id))
    .leftJoin(academicUnits, eq(programOfferings.unitId, academicUnits.id));

const listQuery = z
  .object({
    campus: campusParam,
    unit: z.string().optional().meta({ description: 'Unit ref, e.g. `manila/coe`.' }),
    program: z.string().optional().meta({
      description: 'Canonical program slug. Use `unmatched` for offerings not yet resolved.',
      example: 'bsce',
    }),
    status: z.enum(['active', 'suspended', 'phased_out', 'unknown', 'removed']).optional(),
    q: z.string().min(1).max(200).optional().meta({
      description: 'Case-insensitive substring of the verbatim source name.',
    }),
    min_confidence: minConfidenceParam,
    ...paginationParams,
  })
  .strict();

const listRoute = createRoute({
  method: 'get',
  path: '/v1/offerings',
  tags: ['programs'],
  summary: 'List degrees as each campus actually publishes them',
  description:
    'One row per degree per campus, carrying the verbatim `source_name`. This is the ' +
    'only view that includes offerings whose source name has not yet been resolved ' +
    'into the canonical registry (`program: null`) — they are real degrees a campus ' +
    'teaches, and hiding them until a human has classified them would misrepresent ' +
    'the catalogue. Filter them with `program=unmatched`.',
  request: { query: listQuery },
  responses: {
    200: {
      description: 'A page of offerings.',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(programOffering),
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
  path: '/v1/offerings/{campus}/{program}',
  tags: ['programs'],
  summary: 'Get one degree as taught at one campus',
  request: {
    params: z.object({
      campus: z.string().meta({ example: 'manila' }),
      program: z.string().meta({
        description: 'Offering slug — the canonical program slug where one is matched.',
        example: 'bsce',
      }),
    }),
    // docs/13 §6: unknown query parameters are rejected on EVERY endpoint, not only
    // the filterable ones. Silently ignoring a typo'd parameter returns data that
    // looks filtered and is not — the worst failure for an API whose value is precision.
    query: z.object({}).strict(),
  },
  responses: {
    200: {
      description: 'The offering.',
      content: { 'application/json': { schema: z.object({ data: programOffering }) } },
    },
    304: { description: 'Not modified.' },
    404: {
      description: 'No such offering. Includes trigram-similar suggestions.',
      content: { 'application/problem+json': { schema: problemDetails } },
    },
  },
});

export const offeringRoutes = new OpenAPIHono()
  .openapi(listRoute, async (c) => {
    const { campus, unit, program, status, q, min_confidence, limit, cursor } =
      c.req.valid('query');
    const filters = { campus, unit, program, status, q, min_confidence, limit };

    const rows = await base()
      .where(
        and(
          campus ? eq(programOfferings.campusSlug, campus) : undefined,
          unit ? eq(academicUnits.ref, unit) : undefined,
          program === 'unmatched'
            ? isNull(programOfferings.programId)
            : program
              ? eq(programs.slug, program)
              : undefined,
          status ? eq(programOfferings.status, status) : undefined,
          q ? ilike(programOfferings.sourceName, `%${q}%`) : undefined,
          atLeastConfidence(programOfferings.confidence, min_confidence),
          after(programOfferings.ref, cursor ? decodeCursor(cursor, filters) : undefined),
        ),
      )
      .orderBy(asc(programOfferings.ref))
      .limit(limit + 1);

    const page = paginate(rows.map(presentOffering), limit, (row) => row.ref);
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
    const { campus, program } = c.req.valid('param');
    const ref = `${campus}/${program}`;

    const [row] = await base().where(eq(programOfferings.ref, ref)).limit(1);

    if (!row) {
      const suggestions = await db.execute<{ ref: string }>(
        raw`SELECT ref FROM program_offerings
            WHERE similarity(ref, ${ref}) > 0.2
            ORDER BY similarity(ref, ${ref}) DESC
            LIMIT 3`,
      );
      throw notFound(
        'Offering not found',
        `No offering with ref '${ref}'.`,
        suggestions.map((s) => s.ref),
      );
    }

    const body = { data: presentOffering(row) };
    const etag = etagFor(body);
    c.header('ETag', etag);
    c.header('Cache-Control', CACHE_REFERENCE);
    c.header('Vary', 'Accept-Encoding');
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);
    return c.json(body, 200);
  });
