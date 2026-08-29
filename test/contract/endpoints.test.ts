/**
 * The M7 checkpoint, executable. docs/checkpoints/m07-real-endpoints.md asks for four
 * things beyond "the endpoint returns 200":
 *
 *   - paginate everything with limit=5: union complete, no duplicates, no skips
 *   - min_confidence=medium excludes low rows — the E1 assertion, end to end
 *   - If-None-Match returns 304
 *   - real crawled programs, provenance on each
 *
 * The first is docs/14 §1 rank 5 — "cursor pagination skips or duplicates rows",
 * medium likelihood — and it is a property, so it is tested as one.
 */
import { describe, expect, test } from 'vitest';
import { app } from '../../apps/api/src/app.js';

interface Collection {
  data: { ref?: string; slug?: string; provenance: { confidence: string } }[];
  meta: { count: number; has_more: boolean; freshness: { min_confidence: string | null } };
  links: { self: string; next: string | null };
}

async function get<T>(path: string): Promise<T> {
  const res = await app.request(path);
  expect(res.status, `${path} returned ${res.status}`).toBe(200);
  return (await res.json()) as T;
}

/** Walks every page and returns the refs in order, plus the page count. */
async function drain(path: string): Promise<{ refs: string[]; pages: number }> {
  const refs: string[] = [];
  let next: string | null = path;
  let pages = 0;

  while (next) {
    const page: Collection = await get<Collection>(next);
    pages++;
    refs.push(...page.data.map((row) => row.ref ?? row.slug ?? ''));
    // has_more is authoritative for "keep going", not links.next presence (docs/13 §7).
    next = page.meta.has_more ? page.links.next : null;
    expect(pages, 'pagination did not terminate').toBeLessThan(200);
  }
  return { refs, pages };
}

const COLLECTIONS = [
  '/v1/campuses',
  '/v1/campuses/manila/units',
  '/v1/units',
  '/v1/programs',
  '/v1/offerings',
];

describe('cursor pagination is complete, in order, and free of duplicates', () => {
  test.each(COLLECTIONS)('%s yields the same set at limit=5 and limit=100', async (path) => {
    // Both sides are drained. Comparing a paginated walk against a single limit=100
    // page only works while the collection fits in one page, and /v1/offerings stopped
    // fitting the moment a third campus landed — the assertion has to be about page
    // size not changing the set, not about the set being small.
    const small = await drain(`${path}?limit=5`);
    const large = await drain(`${path}?limit=100`);

    expect(new Set(small.refs).size, `${path} paginated with duplicates`).toBe(small.refs.length);
    expect(new Set(large.refs).size, `${path} paginated with duplicates at limit=100`).toBe(
      large.refs.length,
    );
    expect([...small.refs].sort(), `${path} paginated with skips`).toEqual([...large.refs].sort());
    expect(small.pages).toBeGreaterThanOrEqual(large.pages);
  });

  test('/v1/offerings pages in a stable order across the whole collection', async () => {
    // Stability, not lexicographic order: the server orders by `ref` under Postgres
    // collation, which is not JavaScript's default string sort. What a cursor consumer
    // actually depends on is that two walks return the same sequence.
    const first = await drain('/v1/offerings?campus=manila&limit=5');
    const second = await drain('/v1/offerings?campus=manila&limit=5');
    expect(first.pages).toBeGreaterThan(1);
    expect(first.refs).toEqual(second.refs);
    expect(new Set(first.refs).size).toBe(first.refs.length);
  });

  test('the last page reports has_more false and links.next null', async () => {
    const page = await get<Collection>('/v1/campuses?limit=100');
    expect(page.meta.has_more).toBe(false);
    expect(page.links.next).toBeNull();
  });

  test('a cursor issued under different filters is a 400, not a wrong page', async () => {
    const first = await get<Collection>('/v1/offerings?campus=manila&limit=5');
    const cursor = new URL(first.links.next!, 'http://x').searchParams.get('cursor')!;
    const res = await app.request(`/v1/offerings?campus=visayas&limit=5&cursor=${cursor}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toContain('different set of filters');
  });

  test('a cursor this API never issued is a 400', async () => {
    const res = await app.request('/v1/programs?cursor=not-a-cursor');
    expect(res.status).toBe(400);
  });
});

describe('min_confidence — the E1 assertion, observable end to end', () => {
  test('the API serves a low-confidence row by default, and labels it', async () => {
    // Taguig: everything known about it comes from sibling sites (docs/08 §6).
    const all = await get<Collection>('/v1/campuses');
    const slugs = all.data.map((row) => row.slug);
    expect(slugs).toContain('taguig');
    expect(all.data.find((row) => row.slug === 'taguig')?.provenance.confidence).toBe('low');
    expect(all.meta.freshness.min_confidence).toBe('low');
  });

  test('min_confidence=medium excludes it — ascending enum, correct direction', async () => {
    const filtered = await get<Collection>('/v1/campuses?min_confidence=medium');
    expect(filtered.data.map((row) => row.slug)).not.toContain('taguig');
    for (const row of filtered.data) expect(row.provenance.confidence).not.toBe('low');
  });

  test('min_confidence=low is a no-op, not an inversion', async () => {
    const low = await get<Collection>('/v1/campuses?min_confidence=low');
    const all = await get<Collection>('/v1/campuses');
    expect(low.meta.count).toBe(all.meta.count);
  });

  test('min_confidence=high narrows further still', async () => {
    const high = await get<Collection>('/v1/campuses?min_confidence=high');
    expect(high.meta.count).toBeLessThan(4);
    for (const row of high.data) expect(row.provenance.confidence).toBe('high');
  });
});

describe('real crawled data, with provenance on each row', () => {
  test('/v1/offerings?campus=manila returns crawled offerings citing the live page', async () => {
    const page = await get<Collection & { data: { provenance: { source_url: string; method: string } }[] }>(
      '/v1/offerings?campus=manila&limit=100',
    );
    expect(page.meta.count).toBeLessThanOrEqual(100);
    expect(page.data.length).toBeGreaterThan(30);
    for (const row of page.data) {
      expect(row.provenance.method).toBe('crawl');
      expect(row.provenance.source_url).toMatch(/^https:\/\/tup\.edu\.ph\//);
    }
  });

  test('the unmatched filter is honoured, and every row it returns says program: null', async () => {
    // As of the 2026-08-29 cross-campus resolution there are none — every offering maps
    // to a canonical award. The filter still has to work: the day a campus publishes a
    // degree nobody has classified, it appears here rather than being hidden or, worse,
    // attached to a canonical program that a fuzzy match invented (ADR-003).
    const page = await get<{ data: { program: string | null; source_name: string }[] }>(
      '/v1/offerings?program=unmatched&limit=100',
    );
    for (const row of page.data) {
      expect(row.program).toBeNull();
      expect(row.source_name.length).toBeGreaterThan(0);
    }
  });

  test('every offering carries a verbatim source_name whether matched or not', async () => {
    const page = await get<{ data: { source_name: string; program: string | null }[] }>(
      '/v1/offerings?limit=100',
    );
    expect(page.data.length).toBeGreaterThan(0);
    for (const row of page.data) expect(row.source_name.trim().length).toBeGreaterThan(0);
  });

  test('/v1/programs/{slug} carries offerings with the campus unit vocabulary (ADR-002)', async () => {
    const body = await get<{
      data: { slug: string; offerings: { campus: string; unit: { type: string } | null }[] };
    }>('/v1/programs/bsce');
    expect(body.data.slug).toBe('bsce');
    expect(body.data.offerings.length).toBeGreaterThan(0);
    for (const offering of body.data.offerings) {
      expect(offering.unit?.type, 'an offering unit with no type').toBeTruthy();
    }
    expect(body.data.offerings.find((o) => o.campus === 'manila')?.unit?.type).toBe('college');
  });

  test('/v1/units reports the vocabulary per campus rather than assuming one', async () => {
    const manila = await get<{ data: { unit_type: string }[] }>('/v1/units?campus=manila&limit=100');
    const cavite = await get<{ data: { unit_type: string }[] }>('/v1/units?campus=cavite&limit=100');
    expect(new Set(manila.data.map((u) => u.unit_type))).toEqual(new Set(['college']));
    expect(new Set(cavite.data.map((u) => u.unit_type))).toEqual(new Set(['department']));
  });

  test('a 404 on a slug-shaped path suggests near misses', async () => {
    const res = await app.request('/v1/programs/bsc');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { did_you_mean?: string[]; detail: string };
    expect(body.detail).toContain('bsc');
    expect(body.did_you_mean?.length).toBeGreaterThan(0);
  });

  test('filters narrow rather than being ignored', async () => {
    const all = await get<Collection>('/v1/programs?limit=100');
    const engineering = await get<Collection>('/v1/programs?discipline=engineering&limit=100');
    const masters = await get<Collection>('/v1/programs?level=masters&limit=100');
    expect(engineering.meta.count).toBeGreaterThan(0);
    expect(engineering.meta.count).toBeLessThan(all.meta.count);
    expect(masters.meta.count).toBeGreaterThan(0);
    expect(masters.meta.count).toBeLessThan(all.meta.count);

    const byUnit = await get<Collection>('/v1/offerings?unit=manila/coe&limit=100');
    expect(byUnit.meta.count).toBeGreaterThan(0);
    expect(byUnit.meta.count).toBeLessThan(
      (await get<Collection>('/v1/offerings?campus=manila&limit=100')).meta.count,
    );
  });

  test('no endpoint exposes a raw UUID', async () => {
    for (const path of [...COLLECTIONS, '/v1/programs/bsce', '/v1/offerings/manila/bsce']) {
      const res = await app.request(`${path}${path.includes('?') ? '&' : '?'}`.replace(/\?$/, ''));
      const text = await res.text();
      expect(text, path).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
      );
    }
  });
});
