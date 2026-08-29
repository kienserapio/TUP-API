/**
 * `pnpm ingest:replay --snapshot=<id>` — re-parse a stored snapshot.
 *
 * The first step of RB-01 when a parser breaks (docs/05 §6, docs/11 §9): the guard has
 * already preserved the published data, so there is no time pressure. Pull the snapshot
 * that triggered the quarantine, run the current parser over it, and see what it
 * produces — without fetching anything and without writing anything.
 *
 * `--diff=<id>` compares two snapshots' parse results, which is how you find the
 * selector a redesign moved.
 */
import { adapterFor } from '@tup/adapters';
import { createSnapshotStore, type ParseResult } from '@tup/core';
import { createDb, schema } from '@tup/db';
import { desc, eq } from 'drizzle-orm';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const { snapshots, sources } = schema;

function flags(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (match?.[1]) out.set(match[1], match[2] ?? 'true');
  }
  return out;
}

function workspaceRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

function summarise(result: ParseResult): string {
  const counts = Object.entries(result.byEntity)
    .map(([entity, rows]) => `${entity}=${rows?.length ?? 0}`)
    .join(' ');
  return counts || '(no records)';
}

async function main(): Promise<void> {
  const args = flags(process.argv.slice(2));
  const { sql, db } = createDb();
  const store = createSnapshotStore(workspaceRoot());

  try {
    const id = args.get('snapshot');
    const url = args.get('url');
    if (!id && !url) {
      throw new Error(
        'Usage: pnpm ingest:replay --snapshot=<uuid>  |  --url=<source url> [--diff=<uuid>]',
      );
    }

    const load = async (snapshotId?: string) => {
      const rows = await db
        .select({
          id: snapshots.id,
          fetchedAt: snapshots.fetchedAt,
          storageKey: snapshots.storageKey,
          contentType: snapshots.contentType,
          httpStatus: snapshots.httpStatus,
          contentHash: snapshots.contentHash,
          url: sources.url,
          campusSlug: sources.campusSlug,
        })
        .from(snapshots)
        .innerJoin(sources, eq(snapshots.sourceId, sources.id))
        .where(snapshotId ? eq(snapshots.id, snapshotId) : eq(sources.url, url!))
        .orderBy(desc(snapshots.fetchedAt))
        .limit(1);
      const row = rows[0];
      if (!row) throw new Error(`No snapshot found for ${snapshotId ?? url}.`);

      const body = await store.get(row.storageKey);
      if (!body) {
        throw new Error(
          `Snapshot ${row.id} is recorded but its object ${row.storageKey} is missing from storage.`,
        );
      }

      const adapter = adapterFor(row.campusSlug ?? 'manila');
      const result = await adapter.parse({
        sourceRef: { url: row.url, entityTypes: [], method: 'crawl' },
        fetchedAt: row.fetchedAt,
        httpStatus: row.httpStatus ?? 200,
        contentType: row.contentType ?? 'text/html',
        body,
        contentHash: row.contentHash,
      });
      return { row, result };
    };

    const current = await load(id);
    console.log(`snapshot   ${current.row.id}`);
    console.log(`url        ${current.row.url}`);
    console.log(`fetched    ${current.row.fetchedAt.toISOString()}`);
    console.log(`parsed     ${summarise(current.result)}`);
    for (const warning of current.result.warnings) console.log(`  warning: ${warning}`);

    const diffId = args.get('diff');
    if (diffId) {
      const other = await load(diffId);
      console.log('');
      console.log(`compared to ${other.row.id} (${other.row.fetchedAt.toISOString()})`);
      console.log(`  then: ${summarise(other.result)}`);
      console.log(`  now:  ${summarise(current.result)}`);
    }

    if (!args.has('json')) {
      console.log('\nAdd --json to print the full ParseResult.');
    } else {
      console.log(JSON.stringify(current.result, null, 2));
    }
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error('replay failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
