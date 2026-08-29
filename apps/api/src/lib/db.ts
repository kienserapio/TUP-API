import { createDb } from '@tup/db';

/**
 * One connection pool per process — or per serverless instance.
 *
 * Which pooler to use is a property of the runtime, not a preference:
 *
 *   long-lived process (pnpm dev, Fly, a VPS)  session pooler, port 5432,
 *                                              prepared statements fine, pool of 10
 *   serverless (Vercel)                        transaction pooler, port 6543,
 *                                              `prepare: false`, one connection each
 *
 * Supavisor in transaction mode does not support prepared statements, and Drizzle over
 * postgres.js prepares by default. Getting this wrong fails in both directions: the API
 * throws intermittent "prepared statement already exists" on the transaction port, and
 * exhausts the connection budget on the direct one. Errata E19, docs/15 §3.1.
 *
 * `VERCEL` is set by the platform on every deployment. `DATABASE_POOL_MODE` overrides
 * it for anything that autodetection cannot know about.
 */
const mode =
  process.env['DATABASE_POOL_MODE'] ?? (process.env['VERCEL'] ? 'transaction' : 'session');

const pooled = mode === 'transaction';

const { sql, db } = createDb(pooled ? { pooled: true, max: 1 } : { pooled: false });

export { sql, db };
