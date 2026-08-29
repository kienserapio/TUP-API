/**
 * The M6 gate. docs/checkpoints/m06-pipeline.md is explicit:
 *
 *   "Do not proceed to M7 until sabotage-then-quarantine is demonstrated. This is the
 *    failure mode that destroys data in production; prove it in a sandbox first."
 *
 * And docs/14 §4.1 calls the guard-scoping case "the single most important integration
 * test in the repo. Without it, the first incremental run in production quarantines
 * everything and then marks live data removed."
 *
 * Both are here, against a real Postgres, in a schema of their own.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { and, eq, sql as raw } from 'drizzle-orm';
import { schema } from '@tup/db';
import { Fetcher, MemorySnapshotStore, runIngest, type SnapshotStore } from '@tup/core';
import { createTestSchema, type TestDb } from '../helpers/schema.js';
import { offering, StubSite, unit } from '../helpers/stub-adapter.js';

const { academicUnits, campuses, changeEvents, excludedSources, programOfferings, programs, quarantine, sources } =
  schema;

let ctx: TestDb;
let store: SnapshotStore;

beforeAll(async () => {
  ctx = await createTestSchema('pipeline');
});

afterAll(async () => {
  await ctx.drop();
});

/** A clean slate per test: campuses and the canonical registry, nothing crawled. */
beforeEach(async () => {
  // `sources.campus_slug` references `campuses(slug)`, so TRUNCATE … CASCADE takes
  // `sources` with it — including the synthetic seed source migration 003 created.
  // Recreate it here rather than depending on truncation order.
  await ctx.sql.unsafe(
    `TRUNCATE academic_units, program_offerings, change_events, quarantine, snapshots,
              slug_aliases, ingest_runs, excluded_sources, campuses, programs, sources
     RESTART IDENTITY CASCADE`,
  );
  await ctx.sql`
    INSERT INTO sources (url, origin, domain, entity_types, method, status, crawl_enabled, notes)
    VALUES ('seed://tup-open-api/seeds', 'seed://tup-open-api', 'seed',
            ARRAY['campus','academic_unit','program']::entity_type[], 'seed', 'active', false,
            'Hand-curated seed data. Not fetched.')
    ON CONFLICT (url) DO NOTHING`;

  const [seed] = await ctx.db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.url, 'seed://tup-open-api/seeds'));

  await ctx.db.insert(campuses).values({
    slug: 'manila',
    name: 'Technological University of the Philippines - Manila',
    kind: 'main',
    website: 'https://tup.edu.ph',
    sourceId: seed!.id,
  });

  await ctx.db.insert(programs).values([
    {
      slug: 'bsce',
      name: 'Bachelor of Science in Civil Engineering',
      level: 'baccalaureate',
      aliases: ['BSCE'],
      sourceId: seed!.id,
    },
    {
      slug: 'bsee',
      name: 'Bachelor of Science in Electrical Engineering',
      level: 'baccalaureate',
      aliases: ['BSEE'],
      sourceId: seed!.id,
    },
  ]);

  store = new MemorySnapshotStore();
});

interface RunOptions {
  paths: string[];
  expectations?: Record<string, { min: number; max: number }>;
  mode?: 'incremental' | 'full';
}

async function ingest(site: StubSite, options: RunOptions) {
  const fetcher = new Fetcher({
    mode: 'live',
    client: site.client(),
    sleep: () => Promise.resolve(),
  });
  return runIngest({
    adapter: site.adapter(options.paths, options.expectations),
    db: ctx.db,
    fetcher,
    store,
    mode: options.mode ?? 'incremental',
  });
}

const offerings = (n: number, prefix = 'p') =>
  Array.from({ length: n }, (_, i) => offering(`${prefix}${i}`, `Program ${prefix}${i}`));

async function counts() {
  const [row] = await ctx.sql<{ units: number; offerings: number; events: number; quarantined: number }[]>`
    SELECT (SELECT count(*) FROM academic_units)::int   AS units,
           (SELECT count(*) FROM program_offerings)::int AS offerings,
           (SELECT count(*) FROM change_events)::int     AS events,
           (SELECT count(*) FROM quarantine)::int        AS quarantined`;
  return row!;
}

describe('publish', () => {
  test('a first run creates rows, change events and a snapshot', async () => {
    const site = new StubSite();
    site.set('/units', { academic_unit: [unit('coe'), unit('cit')] });
    site.set('/programs', {
      program_offering: [
        offering('bsce', 'Bachelor of Science in Civil Engineering'),
        offering('x', 'Something Uncanonical'),
      ],
    });

    const summary = await ingest(site, { paths: ['/units', '/programs'] });

    expect(summary.status).toBe('ok');
    expect(await counts()).toMatchObject({ units: 2, offerings: 2, events: 4, quarantined: 0 });

    const [snapshotCount] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM snapshots`;
    expect(snapshotCount?.n).toBe(2);
  });

  test('matches against the canonical registry and never invents a program', async () => {
    const site = new StubSite();
    site.set('/programs', {
      program_offering: [
        offering('anything', 'BSCE'),
        offering('anything-else', 'Master of Science in Something Nobody Seeded'),
      ],
    });

    const summary = await ingest(site, { paths: ['/programs'] });

    const rows = await ctx.db
      .select({ ref: programOfferings.ref, programId: programOfferings.programId })
      .from(programOfferings);
    expect(rows.find((r) => r.ref === 'manila/bsce')?.programId).toBeTruthy();
    expect(rows.filter((r) => r.programId === null)).toHaveLength(1);
    expect(summary.unmatched).toHaveLength(1);

    // ADR-003: the registry only ever grows by a human's hand.
    const [programCount] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM programs`;
    expect(programCount?.n).toBe(2);
  });

  test('confidence is computed server-side, never taken from the adapter', async () => {
    const site = new StubSite();
    site.set('/units', { academic_unit: [unit('coe')] });
    await ingest(site, { paths: ['/units'] });

    const [row] = await ctx.db
      .select({ confidence: academicUnits.confidence })
      .from(academicUnits)
      .where(eq(academicUnits.slug, 'coe'));
    // crawl + academic_unit + 0 days stale = high. docs/09 §2.
    expect(row?.confidence).toBe('high');
  });
});

describe('content-hash gating [E2]', () => {
  test('unchanged content writes no snapshot and no change event', async () => {
    const site = new StubSite();
    site.set('/units', { academic_unit: [unit('coe'), unit('cit')] });

    await ingest(site, { paths: ['/units'] });
    const before = await counts();

    const second = await ingest(site, { paths: ['/units'] });

    expect(second.sourcesUnchanged).toBe(1);
    expect(second.sourcesFetched).toBe(0);
    expect(await counts()).toMatchObject({ events: before.events });

    const [snapshotCount] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM snapshots`;
    expect(snapshotCount?.n).toBe(1);
  });

  test('an unchanged source is verified, not missed — miss_count stays 0', async () => {
    const site = new StubSite();
    site.set('/units', { academic_unit: [unit('coe')] });
    await ingest(site, { paths: ['/units'] });
    await ingest(site, { paths: ['/units'] });
    await ingest(site, { paths: ['/units'] });
    await ingest(site, { paths: ['/units'] });

    const [row] = await ctx.db
      .select({ missCount: academicUnits.missCount, status: academicUnits.status })
      .from(academicUnits);
    expect(row).toMatchObject({ missCount: 0, status: 'active' });
  });
});

describe('reconcile', () => {
  test('a change event carries only the fields that changed', async () => {
    const site = new StubSite();
    site.set('/units', { academic_unit: [unit('coe', 'College of Engineering')] });
    await ingest(site, { paths: ['/units'] });

    site.set('/units', {
      academic_unit: [{ ...unit('coe', 'College of Engineering'), website: 'https://tup.edu.ph/coe' }],
    });
    await ingest(site, { paths: ['/units'] });

    const [event] = await ctx.db
      .select({ diff: changeEvents.diff, operation: changeEvents.operation })
      .from(changeEvents)
      .where(eq(changeEvents.operation, 'updated'));
    expect(event?.diff).toEqual({ website: { from: null, to: 'https://tup.edu.ph/coe' } });
  });

  test('removal takes three separate misses, and never a hard delete', async () => {
    const site = new StubSite();
    site.set('/programs', { program_offering: [...offerings(12), offering('gone', 'Doomed Program')] });
    await ingest(site, { paths: ['/programs'] });

    const status = async () => {
      const [row] = await ctx.db
        .select({ status: programOfferings.status, missCount: programOfferings.missCount })
        .from(programOfferings)
        .where(eq(programOfferings.slug, 'gone'));
      return row;
    };
    expect((await status())?.status).toBe('active');

    // The record disappears from a source that IS parsed — a real miss, not an
    // unexamined source. Each run must change the body so the hash gate lets it through.
    for (const [i, expected] of [
      [1, 'unknown'],
      [2, 'unknown'],
      [3, 'removed'],
    ] as const) {
      site.set('/programs', {
        program_offering: offerings(12).map((o) => ({ ...o, local_name: `run ${i}` })),
      });
      await ingest(site, { paths: ['/programs'] });
      expect((await status())?.missCount).toBe(i);
      expect((await status())?.status).toBe(expected);
    }

    const [row] = await ctx.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM program_offerings WHERE slug = 'gone'`;
    expect(row?.n, 'a removed offering is still a row').toBe(1);
  });
});

describe('the guard preserves data', () => {
  async function seedTwelve(site: StubSite) {
    site.set('/programs', { program_offering: offerings(12) });
    await ingest(site, { paths: ['/programs'] });
    expect((await counts()).offerings).toBe(12);
  }

  test('zero records where data existed → quarantine, nothing touched', async () => {
    const site = new StubSite();
    await seedTwelve(site);

    site.set('/programs', { program_offering: [] });
    const summary = await ingest(site, { paths: ['/programs'] });

    expect(summary.status).toBe('quarantined');
    expect(summary.quarantined[0]?.reason).toContain('zero');
    expect((await counts()).offerings).toBe(12);

    const [row] = await ctx.db.select({ reason: quarantine.reason, incomingCount: quarantine.incomingCount, currentCount: quarantine.currentCount }).from(quarantine);
    expect(row).toMatchObject({ incomingCount: 0, currentCount: 12 });
  });

  test('a drop of more than 30% → quarantine, nothing touched', async () => {
    const site = new StubSite();
    await seedTwelve(site);

    site.set('/programs', { program_offering: offerings(7) });
    const summary = await ingest(site, { paths: ['/programs'] });

    expect(summary.status).toBe('quarantined');
    expect((await counts()).offerings).toBe(12);
  });

  test('a doubling → quarantine, nothing touched', async () => {
    const site = new StubSite();
    await seedTwelve(site);

    site.set('/programs', { program_offering: offerings(30) });
    const summary = await ingest(site, { paths: ['/programs'] });

    expect(summary.status).toBe('quarantined');
    expect((await counts()).offerings).toBe(12);
  });

  test('expectations apply on a full run and are skipped on an incremental one [E3]', async () => {
    const site = new StubSite();
    site.set('/programs', { program_offering: offerings(3) });

    const incremental = await ingest(site, {
      paths: ['/programs'],
      expectations: { program_offering: { min: 30, max: 120 } },
    });
    expect(incremental.status).toBe('ok');
    expect((await counts()).offerings).toBe(3);

    site.set('/programs', { program_offering: offerings(3, 'q') });
    const full = await ingest(site, {
      paths: ['/programs'],
      mode: 'full',
      expectations: { program_offering: { min: 30, max: 120 } },
    });
    expect(full.status).toBe('quarantined');
    expect(full.quarantined[0]?.reason).toContain('[30,120]');
  });

  /**
   * The sabotage case, run exactly as docs/checkpoints/m06-pipeline.md describes:
   * break the parser on purpose and confirm the guard fires and the data survives.
   */
  test('SABOTAGE — a broken selector quarantines rather than emptying the table', async () => {
    const site = new StubSite();
    site.set('/units', { academic_unit: [unit('coe'), unit('cit'), unit('cos')] });
    await ingest(site, { paths: ['/units'] });
    expect((await counts()).units).toBe(3);

    // The parser now returns nothing — the shape a redesigned page produces when a
    // selector stops matching. This is the single failure mode ADR-006 exists for.
    site.set('/units', { academic_unit: [] });
    const summary = await ingest(site, { paths: ['/units'] });

    expect(summary.status).toBe('quarantined');
    const rows = await ctx.db
      .select({ slug: academicUnits.slug, missCount: academicUnits.missCount, status: academicUnits.status })
      .from(academicUnits);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.missCount, 'quarantine must not increment miss_count').toBe(0);
      expect(row.status).toBe('active');
    }

    const [q] = await ctx.db.select({ adapter: quarantine.adapter, entityType: quarantine.entityType }).from(quarantine);
    expect(q).toMatchObject({ adapter: 'manila', entityType: 'academic_unit' });
  });
});

describe('guard scoping — the E3 defect', () => {
  test('a run touching sources A and B never quarantines or removes source C', async () => {
    const site = new StubSite();
    site.set('/a', { program_offering: offerings(6, 'a') });
    site.set('/b', { program_offering: offerings(6, 'b') });
    site.set('/c', { program_offering: offerings(20, 'c') });

    await ingest(site, { paths: ['/a', '/b', '/c'] });
    expect((await counts()).offerings).toBe(32);

    // The healthy incremental run from errata E3: A and B changed, C was not looked at.
    // Adapter-wide scoping would compare 12 incoming against 32 current and quarantine
    // with "count dropped 32→12", then take miss_count on all twenty of C's rows.
    site.set('/a', { program_offering: offerings(6, 'a').map((o) => ({ ...o, local_name: 'v2' })) });
    site.set('/b', { program_offering: offerings(6, 'b').map((o) => ({ ...o, local_name: 'v2' })) });
    const summary = await ingest(site, { paths: ['/a', '/b'] });

    expect(summary.status).toBe('ok');
    expect(summary.quarantined).toEqual([]);
    expect((await counts()).offerings).toBe(32);

    const cRows = await ctx.sql<{ miss_count: number; status: string }[]>`
      SELECT miss_count, status::text AS status FROM program_offerings WHERE slug LIKE 'c%'`;
    expect(cRows).toHaveLength(20);
    for (const row of cRows) {
      expect(row.miss_count, 'an unexamined source is not a missing one').toBe(0);
      expect(row.status).toBe('active');
    }
  });

  test('a failed fetch never increments miss_count [docs/10 §6.2]', async () => {
    const site = new StubSite();
    site.set('/programs', { program_offering: offerings(12) });
    await ingest(site, { paths: ['/programs'] });

    // The page is now a 404. Three of these in a row must not remove live data.
    site.pages.delete(site.url('/programs'));
    for (let i = 0; i < 3; i++) {
      const summary = await ingest(site, { paths: ['/programs'] });
      expect(summary.sourcesFailed).toBe(1);
    }

    const rows = await ctx.sql<{ miss_count: number; status: string }[]>`
      SELECT miss_count, status::text AS status FROM program_offerings`;
    expect(rows).toHaveLength(12);
    for (const row of rows) {
      expect(row.miss_count).toBe(0);
      expect(row.status).toBe('active');
    }
  });
});

describe('excluded_sources — RB-06', () => {
  test('an excluded URL is never fetched and never published, even on a re-crawl', async () => {
    const site = new StubSite();
    site.set('/units', { academic_unit: [unit('coe')] });
    site.set('/secret', { academic_unit: [unit('hidden')] });

    await ctx.db.insert(excludedSources).values({
      urlPattern: site.url('/secret'),
      reason: 'takedown request, test',
      requestedBy: 'integration test',
    });

    await ingest(site, { paths: ['/units', '/secret'] });

    expect(site.requested).not.toContain(site.url('/secret'));
    const rows = await ctx.db.select({ slug: academicUnits.slug }).from(academicUnits);
    expect(rows.map((r) => r.slug)).toEqual(['coe']);

    // A second run must not quietly resurrect it.
    site.set('/units', { academic_unit: [unit('coe'), unit('cit')] });
    await ingest(site, { paths: ['/units', '/secret'] });
    expect(site.requested).not.toContain(site.url('/secret'));
    const after = await ctx.db.select({ slug: academicUnits.slug }).from(academicUnits);
    expect(after.map((r) => r.slug).sort()).toEqual(['cit', 'coe']);
  });
});

describe('ingest_runs records what the run actually covered [E3]', () => {
  test('source_ids holds only the sources that were parsed', async () => {
    const site = new StubSite();
    site.set('/a', { academic_unit: [unit('coe')] });
    site.set('/b', { academic_unit: [unit('cit')] });
    await ingest(site, { paths: ['/a', '/b'] });

    site.set('/a', { academic_unit: [unit('coe', 'Renamed')] });
    const summary = await ingest(site, { paths: ['/a', '/b'] });

    const [run] = await ctx.sql<{ source_ids: string[]; status: string; sources_unchanged: number }[]>`
      SELECT source_ids, status, sources_unchanged FROM ingest_runs WHERE id = ${summary.runId!}`;
    expect(run?.source_ids).toHaveLength(1);
    expect(run?.sources_unchanged).toBe(1);
    expect(run?.status).toBe('ok');

    const [aSource] = await ctx.db
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.url, site.url('/a')));
    expect(run?.source_ids[0]).toBe(aSource?.id);
  });
});

describe('dry run', () => {
  test('writes nothing at all', async () => {
    const site = new StubSite();
    site.set('/units', { academic_unit: [unit('coe')] });

    const fetcher = new Fetcher({ mode: 'live', client: site.client(), sleep: () => Promise.resolve() });
    const summary = await runIngest({
      adapter: site.adapter(['/units']),
      db: ctx.db,
      fetcher,
      store,
      dryRun: true,
    });

    expect(summary.created).toBe(1);
    expect(summary.runId).toBeNull();
    expect(await counts()).toMatchObject({ units: 0, events: 0 });
    const [runCount] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ingest_runs`;
    expect(runCount?.n).toBe(0);
    const [sourceCount] = await ctx.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM sources WHERE url <> 'seed://tup-open-api/seeds'`;
    expect(sourceCount?.n).toBe(0);
  });
});

describe('slug renames leave a forwarding address — PRD C5', () => {
  test('an offering that becomes canonically matched keeps its identity', async () => {
    const site = new StubSite();
    // Verbatim source name that no seeded alias matches yet.
    site.set('/programs', { program_offering: [offering('bs-civil-eng', 'BS Civil Eng')] });
    await ingest(site, { paths: ['/programs'] });

    const [before] = await ctx.db
      .select({ ref: programOfferings.ref, programId: programOfferings.programId })
      .from(programOfferings);
    expect(before?.ref).toBe('manila/bs-civil-eng');
    expect(before?.programId).toBeNull();

    // A human resolves it into the registry.
    await ctx.db
      .update(programs)
      .set({ aliases: ['BSCE', 'BS Civil Eng'] })
      .where(eq(programs.slug, 'bsce'));

    site.set('/programs', { program_offering: [offering('bs-civil-eng', 'BS Civil Eng')] });
    await ctx.sql`UPDATE snapshots SET content_hash = 'force-reparse'`;
    await ingest(site, { paths: ['/programs'] });

    const rows = await ctx.db
      .select({ ref: programOfferings.ref, programId: programOfferings.programId })
      .from(programOfferings);
    expect(rows, 'a rename must not create a second row').toHaveLength(1);
    expect(rows[0]?.ref).toBe('manila/bsce');
    expect(rows[0]?.programId).toBeTruthy();

    const [alias] = await ctx.sql<{ old_ref: string; new_ref: string }[]>`
      SELECT old_ref, new_ref FROM slug_aliases`;
    expect(alias).toMatchObject({ old_ref: 'manila/bs-civil-eng', new_ref: 'manila/bsce' });
  });
});

/** Unused imports kept honest: `raw` and `and` are used by the queries above. */
void raw;
void and;
