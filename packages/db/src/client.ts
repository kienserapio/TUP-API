import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from './env.js';
import * as schema from './schema/index.js';

export type Database = ReturnType<typeof createDb>['db'];

interface ClientOptions {
  /** Transaction-pooled connections cannot use prepared statements. Errata E19. */
  pooled?: boolean;
  max?: number;
}

export function createDb(options: ClientOptions = {}) {
  const pooled = options.pooled ?? false;
  const url = pooled ? env.pooledDatabaseUrl : env.databaseUrl;

  const sql = postgres(url, {
    max: options.max ?? (pooled ? 1 : 10),
    // Supavisor transaction mode does not support prepared statements, and
    // postgres.js prepares by default. Errata E19, docs/15 §3.1.
    prepare: !pooled,
    onnotice: () => {},
  });

  return { sql, db: drizzle(sql, { schema }) };
}
