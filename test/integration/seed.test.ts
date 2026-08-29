/**
 * The M2 gate: hand-typed truth, idempotent, with the vocabulary difference intact.
 * docs/checkpoints/m02-seed.md
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import postgres from 'postgres';
import { env } from '@tup/db';

let sql: postgres.Sql;
beforeAll(() => {
  sql = postgres(env.databaseUrl, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  await sql.end();
});

/** docs/08-source-landscape.md §1 — the only place hostnames are stated. */
const CANONICAL_ORIGIN: Record<string, string> = {
  manila: 'https://tup.edu.ph',
  cavite: 'https://www.tupcavite.edu.ph',
  visayas: 'https://tupvisayas.edu.ph',
  taguig: 'https://tupt.edu.ph',
};

describe('campuses', () => {
  test('all four exist, including the one with no live source', async () => {
    const rows = await sql<{ slug: string }[]>`SELECT slug FROM campuses ORDER BY slug`;
    expect(rows.map((r) => r.slug)).toEqual(['cavite', 'manila', 'taguig', 'visayas']);
  });

  test('Taguig carries a real website_status, not a guess', async () => {
    // It was 'suspended' on 2026-08-20 — a cPanel suspension notice served as HTTP
    // 200, which is a different and more recoverable state than 'unavailable'
    // (ADR-017). It came back online by 2026-08-29, so the seed now says 'active'.
    // The value is whatever the last verification found; what this test protects is
    // that it is one of the states the enum actually distinguishes, never a default.
    const [row] = await sql<{ status: string }[]>`
      SELECT website_status AS status FROM campuses WHERE slug = 'taguig'`;
    expect(['active', 'suspended', 'unavailable']).toContain(row?.status);
    expect(row?.status).toBe('active');
  });

  test('every campus website_status is a value the enum distinguishes', async () => {
    const rows = await sql<{ slug: string; status: string }[]>`
      SELECT slug, website_status AS status FROM campuses`;
    for (const row of rows) {
      expect(
        ['active', 'unavailable', 'suspended', 'blocked', 'retired'],
        `${row.slug} has an unmodelled status`,
      ).toContain(row.status);
    }
  });

  test('every website matches its canonical origin [E5]', async () => {
    const rows = await sql<{ slug: string; website: string }[]>`
      SELECT slug, website FROM campuses`;
    for (const r of rows) expect(r.website).toBe(CANONICAL_ORIGIN[r.slug]);
  });
});

describe('academic units — ADR-002', () => {
  test('Cavite uses departments while Manila and Visayas use colleges', async () => {
    const rows = await sql<{ campus_slug: string; unit_type: string; n: number }[]>`
      SELECT campus_slug, unit_type::text AS unit_type, count(*)::int AS n
      FROM academic_units GROUP BY 1, 2 ORDER BY 1`;
    const byCampus = Object.fromEntries(rows.map((r) => [r.campus_slug, r]));
    expect(byCampus['cavite']?.unit_type).toBe('department');
    expect(byCampus['manila']?.unit_type).toBe('college');
    expect(byCampus['visayas']?.unit_type).toBe('college');
  });

  test('unit counts match the verified source landscape', async () => {
    const rows = await sql<{ campus_slug: string; n: number }[]>`
      SELECT campus_slug, count(*)::int AS n FROM academic_units GROUP BY 1`;
    const n = Object.fromEntries(rows.map((r) => [r.campus_slug, r.n]));
    expect(n['manila']).toBe(6);
    expect(n['visayas']).toBe(3);
    expect(n['cavite']).toBe(5);
  });
});

describe('provenance', () => {
  test('every seeded row is attributable — source_id is never null', async () => {
    for (const table of ['campuses', 'academic_units', 'programs']) {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM ${sql(table)} WHERE source_id IS NULL`;
      expect(row?.n, `${table} has unattributable rows`).toBe(0);
    }
  });

  test('hand curation claims high confidence for the campuses we can actually check', async () => {
    // Hand curation is a STRONGER provenance claim than a scrape, not a weaker one:
    // someone typed these four rows after reading the sites.
    const rows = await sql<{ slug: string; confidence: string }[]>`
      SELECT slug, confidence::text AS confidence FROM campuses WHERE slug <> 'taguig'`;
    for (const row of rows) expect(row.confidence, row.slug).toBe('high');
  });

  test('Taguig claims low confidence, because nothing about it came from Taguig', async () => {
    // docs/08 §6, ADR-012: every fact here is drawn from a sibling site. Saying 'high'
    // would be the API vouching for something it never verified — the exact failure
    // the provenance layer exists to prevent.
    const [row] = await sql<{ confidence: string }[]>`
      SELECT confidence::text AS confidence FROM campuses WHERE slug = 'taguig'`;
    expect(row?.confidence).toBe('low');
  });
});

describe('canonical program registry — ADR-003', () => {
  test('programs are seeded and carry aliases for the matching chain', async () => {
    const [row] = await sql<{ n: number; with_aliases: number }[]>`
      SELECT count(*)::int AS n,
             count(*) FILTER (WHERE array_length(aliases, 1) > 0)::int AS with_aliases
      FROM programs`;
    expect(row?.n).toBeGreaterThanOrEqual(20);
    expect(row?.with_aliases).toBe(row?.n);
  });

  test('no canonical program was ever created by anything but a human', async () => {
    // ADR-003's actual invariant, and the one that has to survive ingestion: an
    // offering may be matched, fuzzily matched, or left unmatched, but the registry
    // only ever grows by someone editing seeds/programs.yaml. Every `programs` row
    // must therefore still be attributed to the synthetic seed source.
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM programs p JOIN sources s ON s.id = p.source_id
      WHERE s.url <> 'seed://tup-open-api/seeds'`;
    expect(row?.n, 'a canonical program was created by the pipeline').toBe(0);
  });

  test('every offering is either matched to a seeded program or honestly unmatched', async () => {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM program_offerings o
      WHERE o.program_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM programs p WHERE p.id = o.program_id)`;
    expect(row?.n).toBe(0);
  });
});
