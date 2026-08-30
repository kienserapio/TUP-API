/**
 * The M1 gate. These assertions must pass BEFORE migration 001 reaches production —
 * four of the defects they guard are unfixable once it ships.
 * docs/checkpoints/m01-schema.md
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

describe('confidence_level enum ordering [E1]', () => {
  test('is declared ascending', async () => {
    // Scoped to `public` on purpose. The pipeline integration tests build a throwaway
    // schema with the full migration set in it, so a catalog-wide query matches
    // `confidence_level` twice while those tests are running and returns six labels.
    // Vitest runs test files in parallel, which made that a coin flip: green locally,
    // red in CI. The assertion is about the shipped schema, so name it.
    const [row] = await sql<{ order: string }[]>`
      SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS order
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typname = 'confidence_level' AND n.nspname = 'public'`;
    expect(row?.order).toBe('low,medium,high');
  });

  test('is declared exactly once in the public schema', async () => {
    // The guard against the above regressing into a query that silently aggregates
    // several types and happens to produce the right string.
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typname = 'confidence_level' AND n.nspname = 'public'`;
    expect(row?.n).toBe(1);
  });

  test('orders correctly in a real comparison, so min_confidence filters the right way', async () => {
    const [row] = await sql<{ ascending: boolean }[]>`
      SELECT ('low'::confidence_level < 'medium'::confidence_level
          AND 'medium'::confidence_level < 'high'::confidence_level) AS ascending`;
    expect(row?.ascending).toBe(true);
  });

  test("min_confidence='medium' excludes low but includes high", async () => {
    const rows = await sql<{ level: string }[]>`
      SELECT level FROM (VALUES ('low'::confidence_level), ('medium'), ('high')) AS v(level)
      WHERE level >= 'medium'::confidence_level ORDER BY level`;
    expect(rows.map((r) => r.level)).toEqual(['medium', 'high']);
  });
});

describe('uuidv7 polyfill [E4]', () => {
  test('is time-ordered — the entire reason v7 was chosen over v4', async () => {
    const [row] = await sql<{ ordered: boolean }[]>`
      SELECT (a < b) AS ordered FROM (
        SELECT uuidv7() AS a, pg_sleep(0.01), uuidv7() AS b
      ) t`;
    expect(row?.ordered).toBe(true);
  });

  test('sets the version 7 nibble and the RFC 4122 variant bits', async () => {
    const [row] = await sql<{ version: string; variant: string }[]>`
      SELECT substring(u::text, 15, 1) AS version, substring(u::text, 20, 1) AS variant
      FROM (SELECT uuidv7() AS u) t`;
    expect(row?.version).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(row?.variant);
  });

  test('timestamp prefixes are non-decreasing across a batch', async () => {
    // RFC 9562 orders v7 by its 48-bit millisecond prefix. Within a single
    // millisecond the remaining bits are random, so whole-UUID ordering is NOT
    // guaranteed for ids minted in the same tick — the prefix is the real contract.
    const rows = await sql<{ id: string }[]>`
      SELECT uuidv7() AS id FROM generate_series(1, 200)`;
    const prefixes = rows.map((r) => r.id.slice(0, 13).replace('-', ''));
    expect([...prefixes].sort()).toEqual(prefixes);
  });

  test('ids minted in different milliseconds sort by creation time', async () => {
    const rows = await sql<{ id: string }[]>`
      SELECT (SELECT uuidv7() FROM pg_sleep(0.002)) AS id FROM generate_series(1, 10)`;
    const ids = rows.map((r) => r.id);
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('generated ref columns [E7]', () => {
  test('campus ref equals its slug', async () => {
    const rows = await sql<{ slug: string; ref: string }[]>`SELECT slug, ref FROM campuses`;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.ref).toBe(r.slug);
  });

  test('academic unit ref is campus-qualified and never contains the unit twice', async () => {
    const rows = await sql<{ ref: string; campus_slug: string; slug: string }[]>`
      SELECT ref, campus_slug, slug FROM academic_units`;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.ref).toBe(`${r.campus_slug}/${r.slug}`);
  });
});

describe('required extensions', () => {
  test('vector, pg_trgm and pgcrypto are installed', async () => {
    const rows = await sql<{ extname: string }[]>`
      SELECT extname FROM pg_extension WHERE extname IN ('vector','pg_trgm','pgcrypto')`;
    expect(rows.map((r) => r.extname).sort()).toEqual(['pg_trgm', 'pgcrypto', 'vector']);
  });
});
