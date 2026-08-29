/**
 * The ten stages, wired.
 *
 *   discover → fetch → snapshot → parse → validate → reconcile → guard → publish
 *            → chunk → embed
 *
 * Three properties this file exists to guarantee, each of which has a named defect
 * behind it:
 *
 * - **Scoping.** Reconcile and guard operate only over rows whose `source_id` is in
 *   `ingest_runs.source_ids` — the sources this run actually parsed. A source that
 *   was unchanged was *verified*, not missed. Errata E3.
 * - **Content-hash gating.** No campus emits a cache validator, so freshness is
 *   decided by hashing the body and comparing it to the newest snapshot. Errata E2.
 * - **Quarantine preserves.** A guard trip writes to `quarantine` and publishes
 *   nothing for that entity type. Existing rows are untouched. ADR-006.
 */
import { and, eq, inArray, sql as raw } from 'drizzle-orm';
import type { Database } from '@tup/db';
import { schema } from '@tup/db';
import { RECORD_SCHEMAS } from '@tup/schemas';
import type {
  CampusAdapter,
  EntityType,
  RawSnapshot,
  SourceRef,
} from './contracts.js';
import { campusOf, hostOf } from './origins.js';
import { computeConfidence, RECRAWL_INTERVAL } from './confidence.js';
import { guard, type GuardResult } from './guard.js';
import { diffFields, reconcile, statusForMissCount, type Diff } from './reconcile.js';
import {
  matchProgramName,
  slugifyProgramName,
  TRIGRAM_THRESHOLD,
  type RegistryEntry,
} from './registry.js';
import { recordHash } from './hash.js';
import type { Fetcher } from './fetcher.js';
import type { SnapshotStore } from './storage.js';
import { matchesExcluded } from './fetcher.js';

const {
  academicUnits,
  campuses,
  changeEvents,
  excludedSources,
  ingestRuns,
  programOfferings,
  programs,
  quarantine,
  slugAliases,
  snapshots,
  sources,
} = schema;

export type IngestMode = 'incremental' | 'full';

export interface IngestOptions {
  adapter: CampusAdapter;
  db: Database;
  fetcher: Fetcher;
  store: SnapshotStore;
  mode?: IngestMode;
  dryRun?: boolean;
  now?: () => Date;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export interface UnmatchedOffering {
  campusSlug: string;
  sourceName: string;
  sourceUrl: string;
}

export interface IngestSummary {
  runId: string | null;
  adapter: string;
  mode: IngestMode;
  dryRun: boolean;
  status: 'ok' | 'quarantined' | 'failed';
  sourcesDiscovered: number;
  sourcesFetched: number;
  sourcesUnchanged: number;
  sourcesFailed: number;
  sourcesExcluded: number;
  sourcesBlocked: number;
  parsed: Partial<Record<EntityType, number>>;
  published: number;
  created: number;
  updated: number;
  unchanged: number;
  missing: number;
  changeEvents: number;
  quarantined: { entityType: EntityType; reason: string }[];
  unmatched: UnmatchedOffering[];
  warnings: string[];
  error?: string;
}

interface ParsedBatch {
  ref: SourceRef;
  sourceId: string;
  snapshotId: string | null;
  snapshot: RawSnapshot;
  byEntity: Partial<Record<EntityType, unknown[]>>;
}

interface Context {
  db: Database;
  adapter: CampusAdapter;
  campusSlug: string;
  campusId: string;
  runId: string | null;
  dryRun: boolean;
  now: Date;
  log: (event: string, data?: Record<string, unknown>) => void;
}

const noopLog = (): void => {};

/**
 * Stand-in `source_id` for a source a dry run would have created. A real UUID so the
 * scoped queries still parameterise correctly, and one that matches no row — which is
 * the truth: nothing has ever been published from a source that does not exist yet.
 */
const DRY_RUN_SOURCE_ID = '00000000-0000-7000-8000-000000000000';

/**
 * Publication order, by referential dependency — NOT by discovery order.
 *
 * `program_offerings.unit_id` points at `academic_units`, so units must land first or
 * every offering in the run publishes with a null unit. Taguig discovers `/progoff`
 * before its four department pages and would otherwise lose the unit on all 22 of its
 * offerings, silently: nothing errors, the guard sees the right counts, and the
 * payload just quietly stops saying which department teaches what.
 *
 * An entity type absent from this list is not publishable — adding one is a deliberate
 * act, in the same spirit as RECORD_SCHEMAS.
 */
const PUBLISH_ORDER: EntityType[] = ['academic_unit', 'program_offering'];

/** docs/03 §3.4 shape, normalized so reconcile can diff it against the DB. */
interface UnitRow {
  key: string;
  ref: string;
  slug: string;
  name: string;
  abbreviation: string | null;
  unit_type: string;
  description: string | null;
  head_name: string | null;
  head_title: string | null;
  emails: string[];
  website: string | null;
  status: string;
}

const UNIT_FIELDS = [
  'name',
  'abbreviation',
  'unit_type',
  'description',
  'head_name',
  'head_title',
  'emails',
  'website',
  'status',
] as const;

interface OfferingRow {
  key: string;
  ref: string;
  slug: string;
  source_name: string;
  local_name: string | null;
  unit_slug: string | null;
  majors: string[];
  years: number | null;
  status: string;
  accreditation: unknown;
  curriculum_url: string | null;
  program_slug: string | null;
}

const OFFERING_FIELDS = [
  'source_name',
  'local_name',
  'unit_slug',
  'majors',
  'years',
  'status',
  'accreditation',
  'curriculum_url',
  'program_slug',
] as const;

/**
 * Collapse rows that resolve to the same canonical key.
 *
 * `program_offerings` is UNIQUE (program_id, campus_id) — one offering per degree per
 * campus, not per college — so several source rows can legitimately land on one row.
 * Manila lists fourteen "Bachelor of Engineering Technology major in …" entries; the
 * day those are aliased to `bet` (seeds/programs.yaml, Phase 2) they become one
 * offering whose `majors[]` carries all fourteen. That is what `majors text[]` is for.
 *
 * Merging, not dropping, is the point: dropping would silently lose thirteen real
 * majors, which is the same class of failure as the slug truncation the Manila
 * fixtures caught.
 */
function mergeByKey<T extends { key: string; ref: string; majors?: string[] }>(
  rows: T[],
  entityType: EntityType,
  log: Context['log'],
): T[] {
  const seen = new Map<string, T>();
  for (const row of rows) {
    const existing = seen.get(row.key);
    if (!existing) {
      seen.set(row.key, { ...row, ...(row.majors ? { majors: [...row.majors] } : {}) });
      continue;
    }
    if (existing.majors && row.majors) {
      for (const major of row.majors) {
        if (!existing.majors.includes(major)) existing.majors.push(major);
      }
    }
    log('merged_duplicate', { entityType, ref: row.ref, majors: existing.majors?.length ?? 0 });
  }
  return [...seen.values()];
}

export async function runIngest(options: IngestOptions): Promise<IngestSummary> {
  const { adapter, db, fetcher, store } = options;
  const mode: IngestMode = options.mode ?? 'incremental';
  const dryRun = options.dryRun ?? false;
  const clock = options.now ?? (() => new Date());
  const log = options.log ?? noopLog;

  const summary: IngestSummary = {
    runId: null,
    adapter: adapter.campusSlug,
    mode,
    dryRun,
    status: 'ok',
    sourcesDiscovered: 0,
    sourcesFetched: 0,
    sourcesUnchanged: 0,
    sourcesFailed: 0,
    sourcesExcluded: 0,
    sourcesBlocked: 0,
    parsed: {},
    published: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    missing: 0,
    changeEvents: 0,
    quarantined: [],
    unmatched: [],
    warnings: [],
  };

  const [campus] = await db
    .select({ id: campuses.id, slug: campuses.slug })
    .from(campuses)
    .where(eq(campuses.slug, adapter.campusSlug))
    .limit(1);

  if (!campus) {
    throw new Error(
      `Campus '${adapter.campusSlug}' is not seeded. Run \`pnpm db:seed\` — campuses are ` +
        `hand-typed, never scraped (docs/04 §0.4).`,
    );
  }

  // Checked before every fetch AND before every publish, so a takedown survives a
  // re-crawl automatically (RB-06).
  const excluded = await db.select({ pattern: excludedSources.urlPattern }).from(excludedSources);
  fetcher.setExcludedPatterns(excluded.map((row) => row.pattern));

  let runId: string | null = null;
  if (!dryRun) {
    const [run] = await db
      .insert(ingestRuns)
      .values({ adapter: adapter.campusSlug, mode, status: 'running' })
      .returning({ id: ingestRuns.id });
    runId = run?.id ?? null;
    summary.runId = runId;
  }

  const ctx: Context = {
    db,
    adapter,
    campusSlug: campus.slug,
    campusId: campus.id,
    runId,
    dryRun,
    now: clock(),
    log,
  };

  try {
    // ── 1. discover ───────────────────────────────────────────────────────────
    const refs: SourceRef[] = [];
    for await (const ref of adapter.discover()) refs.push(ref);
    summary.sourcesDiscovered = refs.length;
    log('discover', { adapter: adapter.campusSlug, sources: refs.length });

    const sourceIdByUrl = await upsertSources(ctx, refs);

    // ── 2–4. fetch, snapshot, parse ───────────────────────────────────────────
    const batches: ParsedBatch[] = [];
    const parsedSourceIds: string[] = [];
    const unchangedSourceIds: string[] = [];

    for (const ref of refs) {
      const sourceId = sourceIdByUrl.get(ref.url);
      if (!sourceId) continue;

      const context = await fetchContextFor(ctx, sourceId, mode);
      const outcome = await fetcher.fetch(ref, context);

      switch (outcome.status) {
        case 'excluded':
          summary.sourcesExcluded++;
          log('excluded', { url: ref.url, pattern: outcome.pattern });
          continue;
        case 'blocked':
          summary.sourcesBlocked++;
          await recordRobots(ctx, sourceId, outcome.robots, 'blocked');
          log('blocked', { url: ref.url, reason: outcome.reason });
          continue;
        case 'failed':
          summary.sourcesFailed++;
          // A failed fetch must NEVER increment miss_count: three failed fetches
          // would otherwise mark healthy data removed. docs/10 §6.2.
          log('fetch_failed', { url: ref.url, error: outcome.error });
          continue;
        case 'unchanged':
          summary.sourcesUnchanged++;
          unchangedSourceIds.push(sourceId);
          await touchSource(ctx, sourceId, outcome.httpStatus);
          if (outcome.robots) await recordRobots(ctx, sourceId, outcome.robots, 'active');
          log('unchanged', { url: ref.url });
          continue;
        case 'fetched':
          break;
      }

      summary.sourcesFetched++;
      if (outcome.robots) await recordRobots(ctx, sourceId, outcome.robots, 'active');

      const snapshotId = await writeSnapshot(ctx, store, sourceId, outcome.snapshot);
      let parsed;
      try {
        parsed = await adapter.parse(outcome.snapshot);
      } catch (error) {
        await markParseFailed(ctx, snapshotId, error);
        throw error;
      }
      await markParsed(ctx, snapshotId, parsed.warnings.length);
      summary.warnings.push(...parsed.warnings.map((w) => `${ref.url}: ${w}`));

      parsedSourceIds.push(sourceId);
      batches.push({
        ref,
        sourceId,
        snapshotId,
        snapshot: outcome.snapshot,
        byEntity: parsed.byEntity,
      });
      await touchSource(ctx, sourceId, outcome.snapshot.httpStatus, outcome.snapshot.contentHash);
    }

    // ── 5. validate ───────────────────────────────────────────────────────────
    const validated = validateBatches(batches, summary);

    // Sources that were verified-unchanged are refreshed, not reconciled: bump
    // last_verified_at and reset miss_count. Errata E2 / E3.
    await markVerified(ctx, unchangedSourceIds);

    // ── 6–8. reconcile, guard, publish ────────────────────────────────────────
    // Derived from what the adapter EMITTED, not from what survived validation, and
    // widened to every entity type the adapter declares. Both matter: a parse that
    // returns `[]` — the shape a broken selector produces — and a parse that drops the
    // key altogether must both reach the guard. Deriving this from the validated
    // records instead means an emptied page publishes nothing, quarantines nothing,
    // and looks like a clean run.
    const entityTypesProduced = new Set<EntityType>();
    for (const batch of batches) {
      for (const entityType of Object.keys(batch.byEntity)) {
        entityTypesProduced.add(entityType as EntityType);
      }
    }
    if (batches.length > 0) {
      for (const entityType of Object.keys(ctx.adapter.expectations ?? {})) {
        entityTypesProduced.add(entityType as EntityType);
      }
    }

    for (const entityType of PUBLISH_ORDER) {
      if (!entityTypesProduced.has(entityType)) continue;

      const records = validated
        .filter((item) => item.entityType === entityType)
        .map((item) => ({ record: item.record, batch: item.batch }));

      if (entityType === 'academic_unit') {
        await publishAcademicUnits(ctx, records, parsedSourceIds, mode, summary);
      } else {
        await publishProgramOfferings(ctx, records, parsedSourceIds, mode, summary);
      }
    }

    for (const entityType of entityTypesProduced) {
      if (!PUBLISH_ORDER.includes(entityType)) {
        summary.warnings.push(
          `${entityType} records were parsed but nothing publishes them; add the entity ` +
            `type to PUBLISH_ORDER and give it a publish handler before an adapter emits it.`,
        );
      }
    }

    // ── 9–10. chunk, embed ────────────────────────────────────────────────────
    // Phase 3 (docs/04 §3.2–3.3). Deliberately a no-op rather than absent, so the
    // stage list in docs/03 §3.4 stays honest about where the pipeline stops today.
    log('chunk', { skipped: 'phase 3' });
    log('embed', { skipped: 'phase 3' });

    if (summary.quarantined.length > 0) summary.status = 'quarantined';

    await finishRun(ctx, summary, parsedSourceIds);
    return summary;
  } catch (error) {
    summary.status = 'failed';
    summary.error = error instanceof Error ? error.message : String(error);
    await finishRun(ctx, summary, []);
    throw error;
  }
}

// ── stage 1: discover ───────────────────────────────────────────────────────────

async function upsertSources(ctx: Context, refs: SourceRef[]): Promise<Map<string, string>> {
  const byUrl = new Map<string, string>();

  for (const ref of refs) {
    const origin = new URL(ref.url).origin;
    const values = {
      url: ref.url,
      origin,
      domain: hostOf(ref.url),
      campusSlug: campusOf(ref.url),
      entityTypes: ref.entityTypes,
      method: ref.method,
      recrawlInterval:
        ref.recrawlInterval ?? RECRAWL_INTERVAL[ref.entityTypes[0] ?? 'academic_unit'],
    };

    if (ctx.dryRun) {
      const [existing] = await ctx.db
        .select({ id: sources.id })
        .from(sources)
        .where(eq(sources.url, ref.url))
        .limit(1);
      byUrl.set(ref.url, existing?.id ?? DRY_RUN_SOURCE_ID);
      continue;
    }

    const [row] = await ctx.db
      .insert(sources)
      .values(values)
      .onConflictDoUpdate({
        target: sources.url,
        set: {
          origin: values.origin,
          domain: values.domain,
          campusSlug: values.campusSlug,
          entityTypes: values.entityTypes,
          method: values.method,
        },
      })
      .returning({ id: sources.id });
    if (row) byUrl.set(ref.url, row.id);
  }

  return byUrl;
}

// ── stage 2: fetch context ──────────────────────────────────────────────────────

async function fetchContextFor(
  ctx: Context,
  sourceId: string,
  mode: IngestMode,
): Promise<{
  previousContentHash?: string | null;
  previousEtag?: string | null;
  previousLastModified?: string | null;
  previousContentSignal?: Record<string, string> | null;
}> {
  // `--full` forces every source to be parsed regardless of hash, which is what makes
  // the adapter's full-run `expectations` meaningful. docs/10 §6.1.
  if (mode === 'full' || sourceId === DRY_RUN_SOURCE_ID) return {};

  const [previous] = await ctx.db
    .select({
      contentHash: snapshots.contentHash,
      etag: snapshots.etag,
      lastModified: snapshots.lastModified,
    })
    .from(snapshots)
    .where(eq(snapshots.sourceId, sourceId))
    .orderBy(raw`${snapshots.fetchedAt} DESC`)
    .limit(1);

  const [source] = await ctx.db
    .select({ contentSignal: sources.contentSignal })
    .from(sources)
    .where(eq(sources.id, sourceId))
    .limit(1);

  return {
    previousContentHash: previous?.contentHash ?? null,
    previousEtag: previous?.etag ?? null,
    previousLastModified: previous?.lastModified ?? null,
    previousContentSignal: (source?.contentSignal as Record<string, string> | null) ?? null,
  };
}

async function recordRobots(
  ctx: Context,
  sourceId: string,
  robots: { present: boolean; allowed: boolean; contentSignal: Record<string, string> | null; checkedAt: Date },
  status: 'active' | 'blocked',
): Promise<void> {
  if (ctx.dryRun || sourceId === DRY_RUN_SOURCE_ID) return;
  await ctx.db
    .update(sources)
    .set({
      robotsPresent: robots.present,
      robotsAllowed: robots.allowed,
      robotsCheckedAt: robots.checkedAt,
      contentSignal: robots.contentSignal,
      status,
      ...(status === 'blocked' ? { crawlEnabled: false } : {}),
    })
    .where(eq(sources.id, sourceId));
}

async function touchSource(
  ctx: Context,
  sourceId: string,
  httpStatus: number,
  contentHash?: string,
): Promise<void> {
  if (ctx.dryRun || sourceId === DRY_RUN_SOURCE_ID) return;
  await ctx.db
    .update(sources)
    .set({
      lastFetchAt: ctx.now,
      lastStatusCode: httpStatus,
      ...(contentHash ? { lastChangeAt: ctx.now } : {}),
    })
    .where(eq(sources.id, sourceId));
}

// ── stage 3: snapshot ───────────────────────────────────────────────────────────

async function writeSnapshot(
  ctx: Context,
  store: SnapshotStore,
  sourceId: string,
  snapshot: RawSnapshot,
): Promise<string | null> {
  if (ctx.dryRun) return null;

  const put = await store.put(ctx.campusSlug, snapshot.contentHash, snapshot.body);
  const [row] = await ctx.db
    .insert(snapshots)
    .values({
      sourceId,
      runId: ctx.runId,
      fetchedAt: snapshot.fetchedAt,
      httpStatus: snapshot.httpStatus,
      etag: snapshot.etag ?? null,
      lastModified: snapshot.lastModified ?? null,
      contentHash: snapshot.contentHash,
      contentType: snapshot.contentType,
      byteSize: put.byteSize,
      storageKey: put.storageKey,
      // Not 'ok' yet: the parse has not run. RB-04 reads parse_status to find the
      // snapshot that broke a parser, and a row that claims success before the work
      // happened would point the investigation at the wrong page.
      parseStatus: 'pending',
    })
    .returning({ id: snapshots.id });
  return row?.id ?? null;
}

async function markParsed(
  ctx: Context,
  snapshotId: string | null,
  warnings: number,
): Promise<void> {
  if (ctx.dryRun || !snapshotId) return;
  await ctx.db
    .update(snapshots)
    .set({ parseStatus: warnings > 0 ? 'ok_with_warnings' : 'ok' })
    .where(eq(snapshots.id, snapshotId));
}

async function markParseFailed(
  ctx: Context,
  snapshotId: string | null,
  error: unknown,
): Promise<void> {
  if (ctx.dryRun || !snapshotId) return;
  await ctx.db
    .update(snapshots)
    .set({
      parseStatus: 'failed',
      parseError: error instanceof Error ? error.message : String(error),
    })
    .where(eq(snapshots.id, snapshotId));
}

// ── stage 5: validate ───────────────────────────────────────────────────────────

interface ValidatedRecord {
  entityType: EntityType;
  record: Record<string, unknown>;
  batch: ParsedBatch;
}

/** Reject, never coerce. A rejected record is a warning and a hole the guard can see. */
function validateBatches(batches: ParsedBatch[], summary: IngestSummary): ValidatedRecord[] {
  const out: ValidatedRecord[] = [];

  for (const batch of batches) {
    for (const [entityType, records] of Object.entries(batch.byEntity)) {
      if (!records) continue;
      summary.parsed[entityType as EntityType] =
        (summary.parsed[entityType as EntityType] ?? 0) + records.length;

      const schemaFor = RECORD_SCHEMAS[entityType as keyof typeof RECORD_SCHEMAS];
      if (!schemaFor) {
        summary.warnings.push(
          `${batch.ref.url}: no record schema for entity type '${entityType}'; nothing published. ` +
            `Add one to packages/schemas/src/ingest.ts before the adapter emits it.`,
        );
        continue;
      }

      for (const record of records) {
        const parsed = schemaFor.safeParse(record);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          summary.warnings.push(
            `${batch.ref.url}: invalid ${entityType} rejected — ${issue?.path.join('.') ?? '?'}: ${issue?.message ?? 'invalid'}`,
          );
          continue;
        }
        out.push({
          entityType: entityType as EntityType,
          record: parsed.data as Record<string, unknown>,
          batch,
        });
      }
    }
  }

  return out;
}

async function markVerified(ctx: Context, sourceIds: string[]): Promise<void> {
  if (ctx.dryRun || sourceIds.length === 0) return;
  for (const table of [academicUnits, programOfferings]) {
    await ctx.db
      .update(table)
      .set({ lastVerifiedAt: ctx.now, missCount: 0 })
      .where(inArray(table.sourceId, sourceIds));
  }
}

// ── stages 6–8: reconcile, guard, publish ───────────────────────────────────────

async function loadRegistry(ctx: Context): Promise<RegistryEntry[]> {
  const rows = await ctx.db
    .select({ slug: programs.slug, name: programs.name, aliases: programs.aliases })
    .from(programs);
  return rows.map((row) => ({ slug: row.slug, name: row.name, aliases: row.aliases ?? [] }));
}

/**
 * Step 3 of the matching chain. pg_trgm is the authority on this number — a
 * TypeScript reimplementation would drift from the `similarity() >= 0.85` the schema
 * indexes for. Never auto-creates: a miss returns null and the offering is written
 * unmatched (ADR-003).
 */
async function trigramMatch(ctx: Context, sourceName: string): Promise<{ slug: string; score: number } | null> {
  const rows = await ctx.db.execute<{ slug: string; score: number }>(
    raw`SELECT slug, similarity(name, ${sourceName}) AS score
        FROM programs
        WHERE similarity(name, ${sourceName}) >= ${TRIGRAM_THRESHOLD}
        ORDER BY score DESC
        LIMIT 1`,
  );
  const best = rows[0];
  return best ? { slug: best.slug, score: Number(best.score) } : null;
}

async function publishAcademicUnits(
  ctx: Context,
  records: { record: Record<string, unknown>; batch: ParsedBatch }[],
  parsedSourceIds: string[],
  mode: IngestMode,
  summary: IngestSummary,
): Promise<void> {
  const incoming: (UnitRow & { sourceId: string; snapshotId: string | null })[] = records.map(
    ({ record, batch }) => {
      const slug = record['slug'] as string;
      return {
        key: slug,
        ref: `${ctx.campusSlug}/${slug}`,
        slug,
        name: record['name'] as string,
        abbreviation: (record['abbreviation'] as string | null) ?? null,
        unit_type: record['unit_type'] as string,
        description: (record['description'] as string | null) ?? null,
        head_name: (record['head_name'] as string | null) ?? null,
        head_title: (record['head_title'] as string | null) ?? null,
        emails: (record['emails'] as string[]) ?? [],
        website: (record['website'] as string | null) ?? null,
        status: (record['status'] as string) ?? 'active',
        sourceId: batch.sourceId,
        snapshotId: batch.snapshotId,
      };
    },
  );

  const currentRows = await ctx.db
    .select({
      slug: academicUnits.slug,
      name: academicUnits.name,
      abbreviation: academicUnits.abbreviation,
      unitType: academicUnits.unitType,
      description: academicUnits.description,
      headName: academicUnits.headName,
      headTitle: academicUnits.headTitle,
      emails: academicUnits.emails,
      website: academicUnits.website,
      status: academicUnits.status,
      missCount: academicUnits.missCount,
    })
    .from(academicUnits)
    .where(
      and(
        eq(academicUnits.campusId, ctx.campusId),
        // THE scoping predicate. Errata E3. The placeholder keeps the parameter a
        // valid uuid when the list is empty; it matches nothing, which is correct —
        // no source was parsed, so no row was examined.
        inArray(
          academicUnits.sourceId,
          parsedSourceIds.length ? parsedSourceIds : [DRY_RUN_SOURCE_ID],
        ),
      ),
    );

  const current: (UnitRow & { missCount: number })[] = currentRows.map((row) => ({
    key: row.slug,
    ref: `${ctx.campusSlug}/${row.slug}`,
    slug: row.slug,
    name: row.name,
    abbreviation: row.abbreviation,
    unit_type: row.unitType,
    description: row.description,
    head_name: row.headName,
    head_title: row.headTitle,
    emails: row.emails ?? [],
    website: row.website,
    status: row.status,
    missCount: row.missCount,
  }));

  const deduped = mergeByKey(incoming, 'academic_unit', ctx.log);

  const verdict = guard(
    'academic_unit',
    deduped,
    current.length,
    ctx.adapter.expectations?.academic_unit,
    { fullRun: mode === 'full' },
  );
  if (!(await applyGuard(ctx, 'academic_unit', verdict, deduped, current.length, summary))) return;

  const result = reconcile({
    incoming: deduped,
    current,
    key: (row) => row.key,
    fields: UNIT_FIELDS,
  });

  summary.created += result.created.length;
  summary.updated += result.updated.length;
  summary.unchanged += result.unchanged.length;
  summary.missing += result.missing.length;

  if (ctx.dryRun) return;

  const confidence = computeConfidence({
    method: 'crawl',
    entityType: 'academic_unit',
    stalenessDays: 0,
  });

  for (const { incoming: row } of result.created) {
    await ctx.db
      .insert(academicUnits)
      .values(unitValues(ctx, row, confidence))
      .onConflictDoUpdate({
        target: [academicUnits.campusId, academicUnits.slug],
        set: unitUpdate(ctx, row, confidence),
      });
    await writeChangeEvent(ctx, 'academic_unit', row.ref, 'created', null, row.snapshotId);
    summary.changeEvents++;
    summary.published++;
  }

  for (const { incoming: row, diff } of result.updated) {
    await ctx.db
      .update(academicUnits)
      .set(unitUpdate(ctx, row, confidence))
      .where(and(eq(academicUnits.campusId, ctx.campusId), eq(academicUnits.slug, row.slug)));
    await writeChangeEvent(ctx, 'academic_unit', row.ref, 'updated', diff, row.snapshotId);
    summary.changeEvents++;
    summary.published++;
  }

  for (const { incoming: row } of result.unchanged) {
    await ctx.db
      .update(academicUnits)
      .set({ lastVerifiedAt: ctx.now, missCount: 0, confidence })
      .where(and(eq(academicUnits.campusId, ctx.campusId), eq(academicUnits.slug, row.slug)));
    summary.published++;
  }

  for (const { current: row } of result.missing) {
    const missCount = row.missCount + 1;
    const status = statusForMissCount(missCount);
    await ctx.db
      .update(academicUnits)
      .set({ missCount, status })
      .where(and(eq(academicUnits.campusId, ctx.campusId), eq(academicUnits.slug, row.slug)));
    if (status !== row.status) {
      await writeChangeEvent(
        ctx,
        'academic_unit',
        row.ref,
        status === 'removed' ? 'removed' : 'updated',
        { status: { from: row.status, to: status } },
        null,
      );
      summary.changeEvents++;
    }
  }
}

function unitValues(
  ctx: Context,
  row: UnitRow & { sourceId: string },
  confidence: 'low' | 'medium' | 'high',
) {
  return {
    campusId: ctx.campusId,
    campusSlug: ctx.campusSlug,
    slug: row.slug,
    name: row.name,
    abbreviation: row.abbreviation,
    unitType: row.unit_type as 'college' | 'department',
    description: row.description,
    headName: row.head_name,
    headTitle: row.head_title,
    emails: row.emails,
    website: row.website,
    status: row.status,
    sourceId: row.sourceId,
    contentHash: recordHash(row),
    lastVerifiedAt: ctx.now,
    missCount: 0,
    confidence,
  };
}

function unitUpdate(
  ctx: Context,
  row: UnitRow & { sourceId: string },
  confidence: 'low' | 'medium' | 'high',
) {
  const { campusId: _campusId, campusSlug: _campusSlug, slug: _slug, ...rest } = unitValues(
    ctx,
    row,
    confidence,
  );
  return rest;
}

async function publishProgramOfferings(
  ctx: Context,
  records: { record: Record<string, unknown>; batch: ParsedBatch }[],
  parsedSourceIds: string[],
  mode: IngestMode,
  summary: IngestSummary,
): Promise<void> {
  const registry = await loadRegistry(ctx);
  const unitRows = await ctx.db
    .select({ id: academicUnits.id, slug: academicUnits.slug })
    .from(academicUnits)
    .where(eq(academicUnits.campusId, ctx.campusId));
  const unitIdBySlug = new Map(unitRows.map((row) => [row.slug, row.id]));

  const programRows = await ctx.db.select({ id: programs.id, slug: programs.slug }).from(programs);
  const programIdBySlug = new Map(programRows.map((row) => [row.slug, row.id]));

  const incoming: (OfferingRow & { sourceId: string; snapshotId: string | null })[] = [];

  for (const { record, batch } of records) {
    const sourceName = record['source_name'] as string;

    // ── 1.4 registry matching: exact → normalized → trigram → unmatched ──────
    let match = matchProgramName(sourceName, registry);
    if (!match.slug) {
      const fuzzy = await trigramMatch(ctx, sourceName);
      if (fuzzy) match = { slug: fuzzy.slug, method: 'trigram', score: fuzzy.score };
    }
    if (!match.slug) {
      summary.unmatched.push({
        campusSlug: ctx.campusSlug,
        sourceName,
        sourceUrl: batch.ref.url,
      });
    }

    // An unmatched offering keeps a derived slug so it stays individually addressable
    // (docs/10 §5.4). It is never given a fabricated canonical program.
    const slug = match.slug ?? (record['slug'] as string) ?? slugifyProgramName(sourceName);

    incoming.push({
      key: slug,
      ref: `${ctx.campusSlug}/${slug}`,
      slug,
      source_name: sourceName,
      local_name: (record['local_name'] as string | null) ?? null,
      unit_slug: (record['unit_slug'] as string | null) ?? null,
      majors: (record['majors'] as string[]) ?? [],
      years: (record['years'] as number | null) ?? null,
      status: (record['status'] as string) ?? 'active',
      accreditation: record['accreditation'] ?? null,
      curriculum_url: (record['curriculum_url'] as string | null) ?? null,
      program_slug: match.slug,
      sourceId: batch.sourceId,
      snapshotId: batch.snapshotId,
    });
  }

  const currentRows = await ctx.db
    .select({
      slug: programOfferings.slug,
      sourceName: programOfferings.sourceName,
      localName: programOfferings.localName,
      unitId: programOfferings.unitId,
      majors: programOfferings.majors,
      years: programOfferings.years,
      status: programOfferings.status,
      accreditation: programOfferings.accreditation,
      curriculumUrl: programOfferings.curriculumUrl,
      programId: programOfferings.programId,
      missCount: programOfferings.missCount,
    })
    .from(programOfferings)
    .where(
      and(
        eq(programOfferings.campusId, ctx.campusId),
        inArray(
          programOfferings.sourceId,
          parsedSourceIds.length ? parsedSourceIds : [DRY_RUN_SOURCE_ID],
        ),
      ),
    );

  const slugByUnitId = new Map([...unitIdBySlug].map(([slug, id]) => [id, slug]));
  const slugByProgramId = new Map([...programIdBySlug].map(([slug, id]) => [id, slug]));

  const current: (OfferingRow & { missCount: number })[] = currentRows.map((row) => ({
    key: row.slug,
    ref: `${ctx.campusSlug}/${row.slug}`,
    slug: row.slug,
    source_name: row.sourceName,
    local_name: row.localName,
    unit_slug: row.unitId ? (slugByUnitId.get(row.unitId) ?? null) : null,
    majors: row.majors ?? [],
    years: row.years === null ? null : Number(row.years),
    status: row.status,
    accreditation: row.accreditation ?? null,
    curriculum_url: row.curriculumUrl,
    program_slug: row.programId ? (slugByProgramId.get(row.programId) ?? null) : null,
    missCount: row.missCount,
  }));

  const deduped = mergeByKey(incoming, 'program_offering', ctx.log);

  const verdict = guard(
    'program_offering',
    deduped,
    current.length,
    ctx.adapter.expectations?.program_offering,
    { fullRun: mode === 'full' },
  );
  // The guard runs BEFORE anything is mutated. ADR-006 says a quarantined run
  // preserves existing data, and a rename is a write — harmless in isolation, but a
  // write during a run we have just decided not to trust.
  if (!(await applyGuard(ctx, 'program_offering', verdict, deduped, current.length, summary))) {
    return;
  }

  // ── slug renames, PRD C5 ──────────────────────────────────────────────────
  // An offering's slug is derived: unmatched rows get one from their source name, and
  // adopt the canonical program slug the day a human resolves them into
  // seeds/programs.yaml. Left alone, that improvement reads as "old row vanished, new
  // row appeared" — the old one takes miss_count and eventually flips to `removed`,
  // and a consumer's stored link 404s. It is the same offering.
  //
  // So: match on `source_name`, the durable identity from the source, rename in place,
  // and write the alias. "Slugs are permanent" means a rename leaves a forwarding
  // address, not that a slug can never improve.
  await applyRenames(ctx, deduped, current, summary);

  const result = reconcile({
    incoming: deduped,
    current,
    key: (row) => row.key,
    fields: OFFERING_FIELDS,
  });

  summary.created += result.created.length;
  summary.updated += result.updated.length;
  summary.unchanged += result.unchanged.length;
  summary.missing += result.missing.length;

  if (ctx.dryRun) return;

  const confidence = computeConfidence({
    method: 'crawl',
    entityType: 'program_offering',
    stalenessDays: 0,
  });

  const values = (row: OfferingRow & { sourceId: string }) => ({
    programId: row.program_slug ? (programIdBySlug.get(row.program_slug) ?? null) : null,
    campusId: ctx.campusId,
    campusSlug: ctx.campusSlug,
    unitId: row.unit_slug ? (unitIdBySlug.get(row.unit_slug) ?? null) : null,
    sourceName: row.source_name,
    slug: row.slug,
    localName: row.local_name,
    majors: row.majors,
    years: row.years === null ? null : String(row.years),
    status: row.status as 'active' | 'suspended' | 'phased_out' | 'unknown' | 'removed',
    accreditation: row.accreditation ?? null,
    curriculumUrl: row.curriculum_url,
    sourceId: row.sourceId,
    contentHash: recordHash(row),
    lastVerifiedAt: ctx.now,
    missCount: 0,
    confidence,
  });

  for (const { incoming: row } of result.created) {
    const { campusId: _c, campusSlug: _cs, slug: _s, ...update } = values(row);
    await ctx.db
      .insert(programOfferings)
      .values(values(row))
      // `ref` is the generated (campus_slug || '/' || slug) unique key. The
      // (program_id, campus_id) constraint cannot serve here: it does not constrain
      // unmatched rows, since Postgres treats NULLs as distinct. docs/10 §5.4.
      .onConflictDoUpdate({ target: programOfferings.ref, set: update });
    await writeChangeEvent(ctx, 'program_offering', row.ref, 'created', null, row.snapshotId);
    summary.changeEvents++;
    summary.published++;
  }

  for (const { incoming: row, diff } of result.updated) {
    const { campusId: _c, campusSlug: _cs, slug: _s, ...update } = values(row);
    await ctx.db
      .update(programOfferings)
      .set(update)
      .where(and(eq(programOfferings.campusId, ctx.campusId), eq(programOfferings.slug, row.slug)));
    await writeChangeEvent(ctx, 'program_offering', row.ref, 'updated', diff, row.snapshotId);
    summary.changeEvents++;
    summary.published++;
  }

  for (const { incoming: row } of result.unchanged) {
    await ctx.db
      .update(programOfferings)
      .set({ lastVerifiedAt: ctx.now, missCount: 0, confidence })
      .where(and(eq(programOfferings.campusId, ctx.campusId), eq(programOfferings.slug, row.slug)));
    summary.published++;
  }

  for (const { current: row } of result.missing) {
    const missCount = row.missCount + 1;
    const status = statusForMissCount(missCount);
    await ctx.db
      .update(programOfferings)
      .set({ missCount, status })
      .where(and(eq(programOfferings.campusId, ctx.campusId), eq(programOfferings.slug, row.slug)));
    if (status !== row.status) {
      await writeChangeEvent(
        ctx,
        'program_offering',
        row.ref,
        status === 'removed' ? 'removed' : 'updated',
        { status: { from: row.status, to: status } },
        null,
      );
      summary.changeEvents++;
    }
  }
}

/**
 * Rewrites `current` in place so reconcile sees the renamed rows as the same records.
 * Returns nothing; the mutation is the point.
 */
async function applyRenames(
  ctx: Context,
  incoming: readonly (OfferingRow & { sourceId: string })[],
  current: (OfferingRow & { missCount: number })[],
  summary: IngestSummary,
): Promise<void> {
  const currentKeys = new Set(current.map((row) => row.key));
  const bySourceName = new Map(current.map((row) => [row.source_name, row]));
  const claimed = new Set<string>();

  for (const row of incoming) {
    if (currentKeys.has(row.key)) {
      claimed.add(row.key);
      continue;
    }
    const prior = bySourceName.get(row.source_name);
    if (!prior || prior.key === row.key) continue;

    if (claimed.has(row.key)) {
      // Two source rows now resolve to one offering — a merge, not a rename. The
      // superseded row is aliased to the survivor and retired rather than left as a
      // second live row for the same degree.
      if (!ctx.dryRun) {
        await writeAlias(ctx, prior.ref, row.ref);
        await ctx.db
          .update(programOfferings)
          .set({ status: 'removed' })
          .where(
            and(eq(programOfferings.campusId, ctx.campusId), eq(programOfferings.slug, prior.slug)),
          );
        await writeChangeEvent(ctx, 'program_offering', prior.ref, 'removed', {
          superseded_by: { from: null, to: row.ref },
        }, null);
        summary.changeEvents++;
      }
      current.splice(current.indexOf(prior), 1);
      continue;
    }

    if (!ctx.dryRun) {
      await ctx.db
        .update(programOfferings)
        .set({ slug: row.slug })
        .where(
          and(eq(programOfferings.campusId, ctx.campusId), eq(programOfferings.slug, prior.slug)),
        );
      await writeAlias(ctx, prior.ref, row.ref);
      await writeChangeEvent(ctx, 'program_offering', row.ref, 'updated', {
        ref: { from: prior.ref, to: row.ref },
      }, null);
      summary.changeEvents++;
    }
    ctx.log('renamed', { from: prior.ref, to: row.ref });

    prior.key = row.key;
    prior.slug = row.slug;
    prior.ref = row.ref;
    claimed.add(row.key);
  }
}

async function writeAlias(ctx: Context, oldRef: string, newRef: string): Promise<void> {
  await ctx.db
    .insert(slugAliases)
    .values({ entityType: 'program_offering', oldRef, newRef })
    .onConflictDoUpdate({
      target: [slugAliases.entityType, slugAliases.oldRef],
      set: { newRef },
    });
}

/** Returns false when the run must publish nothing for this entity type. ADR-006. */
async function applyGuard(
  ctx: Context,
  entityType: EntityType,
  verdict: GuardResult,
  incoming: readonly unknown[],
  currentCount: number,
  summary: IngestSummary,
): Promise<boolean> {
  if (verdict.skipped) ctx.log('guard_skipped_expectations', { entityType, why: verdict.skipped });
  if (verdict.action === 'publish') return true;

  const reason = verdict.reason ?? 'unspecified anomaly';
  summary.quarantined.push({ entityType, reason });
  ctx.log('quarantine', { entityType, reason, incoming: incoming.length, currentCount });

  if (!ctx.dryRun) {
    await ctx.db.insert(quarantine).values({
      runId: ctx.runId,
      adapter: ctx.adapter.campusSlug,
      entityType,
      reason,
      incomingCount: incoming.length,
      currentCount,
      payload: incoming as unknown[],
    });
  }
  return false;
}

async function writeChangeEvent(
  ctx: Context,
  entityType: EntityType,
  entityRef: string,
  operation: 'created' | 'updated' | 'removed' | 'restored',
  diff: Diff | null,
  snapshotId: string | null,
): Promise<void> {
  if (ctx.dryRun) return;
  await ctx.db.insert(changeEvents).values({
    runId: ctx.runId,
    entityType,
    entityRef,
    operation,
    diff,
    snapshotId,
  });
}

async function finishRun(
  ctx: Context,
  summary: IngestSummary,
  parsedSourceIds: string[],
): Promise<void> {
  if (ctx.dryRun || !ctx.runId) return;
  await ctx.db
    .update(ingestRuns)
    .set({
      finishedAt: new Date(),
      status: summary.status,
      sourceIds: parsedSourceIds,
      sourcesFetched: summary.sourcesFetched,
      sourcesUnchanged: summary.sourcesUnchanged,
      sourcesFailed: summary.sourcesFailed,
      recordsPublished: summary.published,
      quarantined: summary.quarantined.length,
      error: summary.error ?? null,
    })
    .where(eq(ingestRuns.id, ctx.runId));
}

export { diffFields, matchesExcluded };
