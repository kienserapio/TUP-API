/**
 * `pnpm ingest --adapter=manila [--dry-run] [--full] [--live]`
 *
 * Defaults are the safe ones: fixtures, incremental, writing. `--live` is the only way
 * to reach a TUP host and is never set in CI or in a test (docs/15 §1).
 *
 * `--full` forces every source to be parsed regardless of content hash. That is what
 * makes the adapter's `expectations` meaningful, because they are full-run ranges —
 * on an incremental run the counts are legitimately partial (errata E3).
 */
import { adapterFor } from '@tup/adapters';
import {
  Fetcher,
  closeHttpClients,
  createSnapshotStore,
  runIngest,
  undiciClient,
  type IngestMode,
} from '@tup/core';
import { createDb } from '@tup/db';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

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

async function main(): Promise<void> {
  const args = flags(process.argv.slice(2));
  const campus = args.get('adapter');
  if (!campus) {
    throw new Error('Usage: pnpm ingest --adapter=manila [--dry-run] [--full] [--live]');
  }

  const adapter = adapterFor(campus);
  const dryRun = args.has('dry-run');
  const mode: IngestMode = args.has('full') ? 'full' : 'incremental';
  const live = args.has('live');

  // Ingestion runs on ephemeral CI runners against the transaction pooler, which does
  // not support prepared statements. Errata E19, docs/15 §3.1.
  const { sql, db } = createDb({ pooled: true, max: 1 });

  const fetcher = new Fetcher({
    mode: live ? 'live' : 'fixtures',
    ...(live ? { client: undiciClient } : {}),
  });

  console.log(
    `ingest ${campus} — mode=${mode} fetch=${fetcher.mode}${dryRun ? ' (dry run, no writes)' : ''}`,
  );

  try {
    const summary = await runIngest({
      adapter,
      db,
      fetcher,
      store: createSnapshotStore(workspaceRoot()),
      mode,
      dryRun,
      // Log at stage boundaries with counts, never per record.
      // docs/05-deployment-and-operations.md §5.1
      log: (event, data) => console.log(`  ${event}`, data ? JSON.stringify(data) : ''),
    });

    console.log('');
    console.log(`  sources     discovered=${summary.sourcesDiscovered} fetched=${summary.sourcesFetched} unchanged=${summary.sourcesUnchanged} failed=${summary.sourcesFailed} excluded=${summary.sourcesExcluded} blocked=${summary.sourcesBlocked}`);
    console.log(`  parsed      ${Object.entries(summary.parsed).map(([k, v]) => `${k}=${v}`).join(' ') || '(none)'}`);
    console.log(`  reconciled  created=${summary.created} updated=${summary.updated} unchanged=${summary.unchanged} missing=${summary.missing}`);
    console.log(`  published   ${summary.published} rows, ${summary.changeEvents} change_events`);

    if (summary.quarantined.length > 0) {
      console.log('');
      console.log('  QUARANTINED — existing data preserved, nothing published for:');
      for (const q of summary.quarantined) console.log(`    ${q.entityType}: ${q.reason}`);
    }
    if (summary.unmatched.length > 0) {
      console.log('');
      console.log(`  ${summary.unmatched.length} unmatched offering(s) — run \`pnpm ingest:unmatched\``);
    }
    if (summary.warnings.length > 0) {
      console.log('');
      console.log(`  ${summary.warnings.length} warning(s):`);
      for (const warning of summary.warnings.slice(0, 20)) console.log(`    ${warning}`);
      if (summary.warnings.length > 20) console.log(`    … ${summary.warnings.length - 20} more`);
    }

    console.log('');
    console.log(`  status      ${summary.status}${summary.runId ? ` (run ${summary.runId})` : ''}`);
    // A quarantined run is not a crashed run: the data is intact and a human decides.
    // But CI must see it, so the exit code is non-zero. ADR-006, RB-01.
    if (summary.status !== 'ok') process.exitCode = 1;
  } finally {
    await sql.end();
    await closeHttpClients();
  }
}

main().catch((error: unknown) => {
  console.error('\ningest failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
