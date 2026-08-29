/**
 * Forward-only SQL migrator.
 *
 * Applies packages/db/migrations/*.sql in filename order, one transaction each,
 * recording every applied file in _migrations. Never reorders, never re-runs,
 * never rolls back — docs/05-deployment-and-operations.md §3.3.
 *
 * A checksum change on an already-applied migration is a hard error: editing a
 * shipped migration means production and local have silently diverged.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { env } from '../env.js';

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');

async function main(): Promise<void> {
  const sql = postgres(env.databaseUrl, { max: 1, onnotice: () => {} });

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS _migrations (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `;

    const applied = new Map<string, string>(
      (await sql<{ name: string; checksum: string }[]>`SELECT name, checksum FROM _migrations`).map(
        (row) => [row.name, row.checksum],
      ),
    );

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    let ran = 0;

    for (const file of files) {
      const body = await readFile(join(migrationsDir, file), 'utf8');
      const checksum = createHash('sha256').update(body).digest('hex').slice(0, 16);
      const previous = applied.get(file);

      if (previous) {
        if (previous !== checksum) {
          throw new Error(
            `Migration ${file} was modified after being applied (checksum ${previous} -> ${checksum}). ` +
              `Migrations are immutable once shipped. Write a new forward migration instead.`,
          );
        }
        continue;
      }

      process.stdout.write(`  applying ${file} ... `);
      // Simple protocol: the file may contain $$-quoted function bodies and DO blocks.
      // Wrapping in BEGIN/COMMIT makes the whole file atomic — a failed ASSERT rolls back.
      await sql
        .unsafe(
          `BEGIN;\n${body}\nINSERT INTO _migrations (name, checksum) VALUES ('${file}', '${checksum}');\nCOMMIT;`,
        )
        .simple();
      process.stdout.write('ok\n');
      ran++;
    }

    console.log(ran === 0 ? 'No pending migrations.' : `Applied ${ran} migration(s).`);
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error('\nMigration failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
