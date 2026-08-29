import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { health } from '@tup/schemas';
import { sql as raw } from 'drizzle-orm';
import { CACHE_NONE } from '../lib/etag.js';
import { db } from '../lib/db.js';

const route = createRoute({
  method: 'get',
  path: '/v1/health',
  tags: ['meta'],
  summary: 'Liveness and ingestion freshness',
  description:
    'Reports whether the API is serving and how long since ingestion last succeeded. ' +
    '`hours_since_ingest` is public on purpose: the API reports its own staleness ' +
    'rather than asking anyone to take freshness on faith.',
  responses: {
    200: {
      description: 'Service is reachable.',
      content: { 'application/json': { schema: health } },
    },
  },
});

export const healthRoutes = new OpenAPIHono().openapi(route, async (c) => {
  c.header('Cache-Control', CACHE_NONE);

  let lastIngest: Date | null = null;
  let reachable = true;
  try {
    const rows = await db.execute<{ finished_at: Date | null }>(
      raw`SELECT max(finished_at) AS finished_at FROM ingest_runs WHERE status = 'ok'`,
    );
    lastIngest = rows[0]?.finished_at ?? null;
  } catch {
    reachable = false;
  }

  const hours =
    lastIngest === null ? null : (Date.now() - lastIngest.getTime()) / 3_600_000;

  return c.json(
    {
      status: reachable ? ('ok' as const) : ('degraded' as const),
      version: process.env['npm_package_version'] ?? '0.0.0',
      last_successful_ingest_at: lastIngest ? lastIngest.toISOString() : null,
      hours_since_ingest: hours === null ? null : Math.round(hours * 10) / 10,
    },
    200,
  );
});

export { z };
