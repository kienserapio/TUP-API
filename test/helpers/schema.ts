/**
 * A fresh Postgres schema per integration test file — docs/14 §4.2.
 *
 * Slower than sharing one database, and worth it: cross-test contamination in a suite
 * this stateful produces failures nobody can reproduce. Extensions stay in `public`
 * (they are cluster-wide anyway); only the tables are per-test.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { env, schema } from '@tup/db';

const migrationsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../packages/db/migrations',
);

export interface TestDb {
  sql: postgres.Sql;
  db: ReturnType<typeof drizzle<typeof schema>>;
  schemaName: string;
  drop(): Promise<void>;
}

export async function createTestSchema(name: string): Promise<TestDb> {
  const schemaName = `test_${name}`;

  const admin = postgres(env.databaseUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE; CREATE SCHEMA ${schemaName};`);
  await admin.end();

  const sql = postgres(env.databaseUrl, {
    max: 1,
    onnotice: () => {},
    connection: { search_path: `${schemaName},public,extensions` },
  });

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const body = await readFile(join(migrationsDir, file), 'utf8');
    await sql.unsafe(`BEGIN;\n${body}\nCOMMIT;`).simple();
  }

  const db = drizzle(sql, { schema });

  return {
    sql,
    db,
    schemaName,
    async drop() {
      await sql.end();
      const cleanup = postgres(env.databaseUrl, { max: 1, onnotice: () => {} });
      await cleanup.unsafe(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE;`);
      await cleanup.end();
    },
  };
}
