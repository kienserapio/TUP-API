import { OpenAPIHono } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { requestId } from './middleware/request-id.js';
import { Problem, problemBody } from './lib/problem.js';
import { campusRoutes } from './routes/campuses.js';
import { healthRoutes } from './routes/health.js';
import { logger } from './lib/logger.js';

export interface AppEnv {
  Variables: { requestId: string };
}

export const DOCS_BASE = process.env['DOCS_BASE_URL'] ?? 'https://docs.tup-open-api.example';

export function createApp() {
  const app = new OpenAPIHono<AppEnv>({
    // Zod rejected the request. Surface it as RFC 9457 rather than Hono's default,
    // and name the offending parameter. docs/13 §8.2.
    defaultHook: (result, c) => {
      if (!result.success) {
        const first = result.error.issues[0];
        const path = first?.path.join('.') ?? 'request';
        const detail =
          first?.code === 'unrecognized_keys'
            ? `Unknown query parameter(s): ${(first as { keys?: string[] }).keys?.join(', ') ?? path}. This API rejects unknown parameters rather than ignoring them.`
            : `${path}: ${first?.message ?? 'invalid value'}`;
        return c.json(
          problemBody(
            c,
            { type: 'invalid-parameter', title: 'Invalid request parameter', detail },
            DOCS_BASE,
          ),
          400,
          { 'Content-Type': 'application/problem+json' },
        );
      }
      return undefined;
    },
  });

  app.use('*', requestId);
  app.use('*', secureHeaders({ referrerPolicy: 'no-referrer' }));
  // Public data. ADR: CORS is wide open for GET; there is no write path to protect.
  app.use('/v1/*', cors({ origin: '*', allowMethods: ['GET', 'HEAD', 'OPTIONS'] }));

  app.route('/', healthRoutes);
  app.route('/', campusRoutes);

  app.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'TUP Open Data API',
      version: '0.1.0',
      description:
        'An open, versioned, multi-campus API normalising public institutional data ' +
        'across the Technological University of the Philippines system.\n\n' +
        '**Every record carries provenance in the default payload.** Read ' +
        '`provenance.last_verified_at` and `provenance.confidence` before asserting ' +
        'anything to a student — some source pages have not been updated since 2006.\n\n' +
        'Unofficial. Aggregated from public TUP websites.',
      license: { name: 'See LICENSE-DATA', url: `${DOCS_BASE}/license` },
    },
    tags: [
      { name: 'meta', description: 'Service health and coverage.' },
      { name: 'campuses', description: 'The four campuses of the TUP system.' },
    ],
  });

  app.notFound((c) =>
    c.json(
      problemBody(
        c,
        {
          type: 'not-found',
          title: 'Endpoint not found',
          detail: `No route matches ${c.req.method} ${new URL(c.req.url).pathname}. See /openapi.json for the full contract.`,
        },
        DOCS_BASE,
      ),
      404,
      { 'Content-Type': 'application/problem+json' },
    ),
  );

  app.onError((err, c) => {
    if (err instanceof Problem) {
      return c.json(problemBody(c, err.problem, DOCS_BASE), err.status, {
        'Content-Type': 'application/problem+json',
      });
    }

    // Never leak SQL, stack traces, hostnames, or driver messages. docs/13 §8.2.
    logger.error(
      { err: err instanceof Error ? err.message : String(err), requestId: c.get('requestId') },
      'unhandled error',
    );
    return c.json(
      problemBody(
        c,
        {
          type: 'internal',
          title: 'Internal server error',
          detail: 'An unexpected error occurred. Quote the X-Request-Id header when reporting it.',
        },
        DOCS_BASE,
      ),
      500,
      { 'Content-Type': 'application/problem+json' },
    );
  });

  return app;
}

export const app = createApp();
