/**
 * `pnpm ingest:decay` — the daily 03:00 PHT confidence recompute (PRD F28, docs/09 §3).
 *
 * Three properties the job must have, all of which fall out of implementing it as a
 * recompute rather than a decrement:
 *
 *   reversible  a successful verification restores confidence
 *   idempotent  running it twice in a day changes nothing
 *   audited     a downgrade writes a change_event, because a cautious consumer
 *               reacting to `GET /v1/changes` most wants to see exactly that transition
 */
import { computeConfidence, stalenessDays, type Confidence, type EntityType } from '@tup/core';
import { createDb, schema } from '@tup/db';
import { eq } from 'drizzle-orm';

const { academicUnits, campuses, changeEvents, programOfferings, programs, sources } = schema;

interface Target {
  entityType: EntityType;
  table: typeof academicUnits | typeof programOfferings | typeof programs | typeof campuses;
}

const TARGETS: Target[] = [
  { entityType: 'campus', table: campuses },
  { entityType: 'academic_unit', table: academicUnits },
  { entityType: 'program', table: programs },
  { entityType: 'program_offering', table: programOfferings },
];

async function main(): Promise<void> {
  const { sql, db } = createDb();
  const now = new Date();
  let changed = 0;
  let examined = 0;

  try {
    for (const { entityType, table } of TARGETS) {
      const rows = await db
        .select({
          ref: table.ref,
          confidence: table.confidence,
          lastVerifiedAt: table.lastVerifiedAt,
          method: sources.method,
          sourceStatus: sources.status,
        })
        .from(table)
        .innerJoin(sources, eq(table.sourceId, sources.id));

      for (const row of rows) {
        examined++;
        // `ref` is a stored generated column, so Drizzle types it nullable. It never is.
        const ref = row.ref;
        if (!ref) continue;
        const next: Confidence = computeConfidence({
          method: row.method,
          entityType,
          stalenessDays: stalenessDays(row.lastVerifiedAt, now),
          sourceStatus: row.sourceStatus,
          now,
        });
        if (next === row.confidence) continue;

        await db.update(table).set({ confidence: next }).where(eq(table.ref, ref));
        await db.insert(changeEvents).values({
          entityType,
          entityRef: ref,
          operation: 'updated',
          diff: { confidence: { from: row.confidence, to: next } },
        });
        changed++;
        console.log(`  ${entityType} ${ref}: ${row.confidence} → ${next}`);
      }
    }

    console.log(`\nRecomputed ${examined} entities, ${changed} confidence change(s).`);
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error('decay failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
