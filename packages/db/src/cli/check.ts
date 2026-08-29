import postgres from 'postgres';
import { env } from '../env.js';

async function main() {
  const sql = postgres(env.databaseUrl, { max: 1, onnotice: () => {} });
  const host = env.databaseUrl.replace(/\/\/[^@]+@/, '//<redacted>@').split('@')[1];
  console.log('connected to:', host);
  const [t] = await sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`;
  console.log('tables:', t?.['n']);
  const [c] = await sql`SELECT string_agg(e.enumlabel, ' < ' ORDER BY e.enumsortorder) AS o FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='confidence_level'`;
  console.log('confidence_level:', c?.['o']);
  const rows = await sql`SELECT name FROM _migrations ORDER BY name`;
  console.log('migrations applied:', rows.length);
  await sql.end();
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
