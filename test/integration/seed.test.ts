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

  test('Taguig is suspended, not unavailable — a different and more recoverable state', async () => {
    const [row] = await sql<{ status: string }[]>`
      SELECT website_status AS status FROM campuses WHERE slug = 'taguig'`;
    expect(row?.status).toBe('suspended');
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

  test('hand curation claims high confidence, not low', async () => {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM campuses WHERE confidence <> 'high'`;
    expect(row?.n).toBe(0);
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

  test('no offering was auto-created from a fuzzy match', async () => {
    // Nothing has been ingested yet; the assertion is that seeding never invents offerings.
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM program_offerings`;
    expect(row?.n).toBe(0);
  });
});
