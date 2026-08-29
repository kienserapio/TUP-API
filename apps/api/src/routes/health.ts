import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { health } from '@tup/schemas';
import { sql as raw } from 'drizzle-orm';
import { CACHE_NONE } from '../lib/etag.js';
import { db } from '../lib/db.js';

/** docs/14 §8: the smoke test and the uptime monitor both use this threshold. */
export const STALE_AFTER_HOURS = 36;

const route = createRoute({
  method: 'get',
  path: '/v1/health',
  tags: ['meta'],
  summary: 'Liveness and ingestion freshness',
  description:
    'Reports whether the API is serving and how long since ingestion last succeeded. ' +
    '`hours_since_ingest` is public on purpose: the API reports its own staleness ' +
    'rather than asking anyone to take freshness on faith. `status` is `degraded` ' +
    'when the database is unreachable or ingestion has not succeeded in 36 hours.',
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
    const rows = await db.execute<{ finished_at: Date | string | null }>(
      raw`SELECT max(finished_at) AS finished_at FROM ingest_runs WHERE status = 'ok'`,
    );
    // A raw query returns whatever the driver decoded — a Date here, a string on some
    // pooler paths. Normalise rather than trusting one shape.
    const value = rows[0]?.finished_at ?? null;
    lastIngest = value === null ? null : value instanceof Date ? value : new Date(value);
    if (lastIngest && Number.isNaN(lastIngest.getTime())) lastIngest = null;
  } catch {
    reachable = false;
  }

  const hours =
    lastIngest === null ? null : (Date.now() - lastIngest.getTime()) / 3_600_000;

  // The external uptime check asserts `hours_since_ingest < 36`, and it is the second
  // defence against silent staleness — the project's named anti-metric. Reporting the
  // same judgment in `status` means a monitor that only reads `status` still catches a
  // dead ingestion pipeline. docs/12 §4, docs/14 §8, errata E14.
  const stale = hours === null || hours > STALE_AFTER_HOURS;

  return c.json(
    {
      status: reachable && !stale ? ('ok' as const) : ('degraded' as const),
      version: process.env['npm_package_version'] ?? '0.0.0',
      last_successful_ingest_at: lastIngest ? lastIngest.toISOString() : null,
      hours_since_ingest: hours === null ? null : Math.round(hours * 10) / 10,
    },
    200,
  );
});

export { z };
