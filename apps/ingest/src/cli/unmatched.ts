/**
 * `pnpm ingest:unmatched`
 *
 * Every offering whose `source_name` did not match the canonical registry. ADR-003
 * forbids auto-creating a canonical program from a fuzzy match, so this report is the
 * hand-off: a human reads it, decides which are genuinely new degrees and which are
 * name variants, and resolves them into `seeds/programs.yaml`.
 *
 * docs/04 §1.4 is honest that this is "a real hour of work". It is meant to be.
 */
import { createDb, schema } from '@tup/db';
import { asc, eq, isNull } from 'drizzle-orm';

const { programOfferings, sources } = schema;

async function main(): Promise<void> {
  const { sql, db } = createDb();

  try {
    const rows = await db
      .select({
        campus: programOfferings.campusSlug,
        ref: programOfferings.ref,
        sourceName: programOfferings.sourceName,
        sourceUrl: sources.url,
        status: programOfferings.status,
      })
      .from(programOfferings)
      .innerJoin(sources, eq(programOfferings.sourceId, sources.id))
      .where(isNull(programOfferings.programId))
      .orderBy(asc(programOfferings.campusSlug), asc(programOfferings.sourceName));

    if (rows.length === 0) {
      console.log('No unmatched offerings. Every offering maps to a canonical program.');
      return;
    }

    console.log(`${rows.length} unmatched offering(s) — program_id IS NULL\n`);
    let campus = '';
    for (const row of rows) {
      if (row.campus !== campus) {
        campus = row.campus;
        console.log(`── ${campus} ${'─'.repeat(Math.max(0, 60 - campus.length))}`);
      }
      console.log(`  ${row.sourceName}`);
      console.log(`      ref=${row.ref}  status=${row.status}`);
      console.log(`      seen at ${row.sourceUrl}`);
    }

    console.log('');
    console.log('Resolve each one in seeds/programs.yaml: add it as an `alias` of an existing');
    console.log('program if it is a name variant, or as a new canonical entry if it is a new');
    console.log('degree. Never auto-create from a fuzzy match — ADR-003.');
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error('unmatched report failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
