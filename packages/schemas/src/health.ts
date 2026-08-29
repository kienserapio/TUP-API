import { z } from 'zod';

/**
 * `hours_since_ingest` is deliberately public. The API reports its own staleness
 * rather than expecting anyone to take freshness on faith, and the external uptime
 * check asserts on it — the second defence against the project's named anti-metric,
 * silent staleness. docs/12-build-prerequisites.md §4.
 */
export const health = z
  .object({
    status: z.enum(['ok', 'degraded']),
    version: z.string(),
    last_successful_ingest_at: z.iso.datetime().nullable(),
    hours_since_ingest: z.number().nullable(),
  })
  .meta({ id: 'Health' });
