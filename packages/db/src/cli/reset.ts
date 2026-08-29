/**
 * Drops and recreates the public schema, then migrates. LOCAL ONLY.
 * Refuses to run against anything that is not obviously a local database.
 */
import postgres from 'postgres';
import { env } from '../env.js';

const url = env.databaseUrl;
const isLocal = /@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(url);

if (!isLocal) {
  console.error(
    'refusing to reset a non-local database.\n' +
      'db:reset drops the public schema. It is a local development command only.',
  );
  process.exit(1);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });
await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;').simple();
await sql.end();
console.log('Schema dropped. Running migrations...');

await import('./migrate.js');
