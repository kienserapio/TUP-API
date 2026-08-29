/**
 * The M9 gate, executable. docs/checkpoints/m09-multi-campus.md quotes doc 04's Phase 2
 * exit criterion and calls out the one that gates everything:
 *
 *   "Zero schema migrations were required to add campuses 2 and 3."
 *
 * A test cannot assert what was not written, so it asserts the observable consequence:
 * three campuses' worth of units and offerings live in the same tables, told apart by
 * `unit_type` and `campus_slug` rather than by shape. If ADR-002 and ADR-003 had been
 * wrong, this file would need per-campus columns to write.
 */
import { describe, expect, test } from 'vitest';
import { app } from '../../apps/api/src/app.js';

async function get<T>(path: string): Promise<T> {
  const res = await app.request(path);
  expect(res.status, `${path} returned ${res.status}`).toBe(200);
  return (await res.json()) as T;
}

interface Offering {
  campus: string;
  ref: string;
  program: string | null;
  source_name: string;
  majors: string[];
  years: number | null;
  unit: { ref: string; slug: string; name: string; type: string } | null;
  provenance: { source_url: string; method: string; confidence: string };
}

describe('ADR-002 — campuses do not share a vocabulary', () => {
  test('the flagship payload shows the difference: college, college, department', async () => {
    const body = await get<{ data: { offerings: Offering[] } }>('/v1/programs/bsee');
    const byCampus = Object.fromEntries(body.data.offerings.map((o) => [o.campus, o]));

    expect(Object.keys(byCampus).sort()).toEqual(['manila', 'taguig', 'visayas']);
    expect(byCampus['manila']!.unit!.type).toBe('college');
    expect(byCampus['visayas']!.unit!.type).toBe('college');
    // The one that matters. An integration that hardcoded "college" is wrong here.
    expect(byCampus['taguig']!.unit!.type).toBe('department');
  });

  test('and the unit refs differ per campus, so nothing collides', async () => {
    const body = await get<{ data: { offerings: Offering[] } }>('/v1/programs/bsee');
    const refs = body.data.offerings.map((o) => o.unit!.ref).sort();
    expect(refs).toEqual(['manila/coe', 'taguig/eaad', 'visayas/coe']);
    expect(new Set(refs).size).toBe(refs.length);
  });

  test('`coe` exists at two campuses, with the same name, and is never confused', async () => {
    // Both really are called "College of Engineering". That is exactly why the slug
    // alone cannot identify a unit and why the path carries the campus (docs/13 §2.2):
    // identical names, distinct records, disambiguated by `ref`.
    type Unit = { ref: string; name: string; campus: string; description: string | null };
    const manila = await get<{ data: Unit }>('/v1/units/manila/coe');
    const visayas = await get<{ data: Unit }>('/v1/units/visayas/coe');

    expect(manila.data.name).toBe(visayas.data.name);
    expect(manila.data.ref).toBe('manila/coe');
    expect(visayas.data.ref).toBe('visayas/coe');
    expect(manila.data.campus).toBe('manila');
    expect(visayas.data.campus).toBe('visayas');
    // Same name, different institutions — the descriptions come from different sites.
    expect(manila.data.description).not.toBe(visayas.data.description);
  });

  test('every campus reports its own vocabulary, and Taguig is not an accident', async () => {
    const expected: Record<string, string> = {
      manila: 'college',
      visayas: 'college',
      taguig: 'department',
      cavite: 'department',
    };
    for (const [campus, type] of Object.entries(expected)) {
      const body = await get<{ data: { unit_type: string }[] }>(
        `/v1/campuses/${campus}/units?limit=100`,
      );
      expect(body.data.length, `${campus} has no units`).toBeGreaterThan(0);
      expect(new Set(body.data.map((u) => u.unit_type)), campus).toEqual(new Set([type]));
    }
  });
});

describe('ADR-003 — one canonical degree, many campus offerings', () => {
  test('a degree taught in three places is one program row with three offerings', async () => {
    const body = await get<{ data: { slug: string; offerings: Offering[] } }>('/v1/programs/bsee');
    expect(body.data.slug).toBe('bsee');
    expect(body.data.offerings).toHaveLength(3);
    for (const offering of body.data.offerings) {
      expect(offering.program).toBe('bsee');
      expect(offering.provenance.method).toBe('crawl');
    }
  });

  test('the cross-campus BET resolution holds — one award, three campuses, own majors', async () => {
    // The case docs/04 §2.4 predicted: 36 offerings across three campuses spelling the
    // separator three different ways. Resolved 2026-08-29; the rule is at the foot of
    // seeds/programs.yaml.
    const body = await get<{ data: { offerings: Offering[] } }>('/v1/programs/bet');
    const byCampus = Object.fromEntries(body.data.offerings.map((o) => [o.campus, o]));
    expect(Object.keys(byCampus).sort()).toEqual(['manila', 'taguig', 'visayas']);

    for (const [campus, offering] of Object.entries(byCampus)) {
      expect(offering.majors.length, `${campus} lost its majors in the merge`).toBeGreaterThan(1);
    }
    // Each campus's specialisations are its own — they must not have been pooled.
    expect(byCampus['manila']!.majors).not.toEqual(byCampus['taguig']!.majors);
    expect(byCampus['visayas']!.majors.join('|')).toContain('Engineering Technology');
  });

  test('a filter by campus narrows the offerings without changing the degree', async () => {
    const all = await get<{ data: { offerings: Offering[] } }>('/v1/programs/bsee');
    const one = await get<{ data: { slug: string; offerings: Offering[] } }>(
      '/v1/programs/bsee?campus=taguig',
    );
    expect(one.data.slug).toBe('bsee');
    expect(one.data.offerings).toHaveLength(1);
    expect(one.data.offerings[0]!.campus).toBe('taguig');
    expect(all.data.offerings.length).toBeGreaterThan(one.data.offerings.length);
  });

  test('offerings that publish duration carry it, and those that do not say null', async () => {
    const body = await get<{ data: { offerings: Offering[] } }>('/v1/programs/bsee');
    const byCampus = Object.fromEntries(body.data.offerings.map((o) => [o.campus, o]));
    // Visayas publishes "4 years" on the card; Manila publishes nothing. `null` is the
    // honest answer, never a plausible default (docs/11 §3).
    expect(byCampus['visayas']!.years).toBe(4);
    expect(byCampus['manila']!.years).toBeNull();
  });
});

describe('GET /v1/meta/coverage — per campus, never aggregate (ADR-012)', () => {
  test('reports every campus, including the one with nothing', async () => {
    const body = await get<{
      data: {
        generated_at: string;
        by_campus: {
          campus: string;
          has_adapter: boolean;
          website_status: string;
          counts: Record<string, number>;
          sources: { total: number };
        }[];
      };
    }>('/v1/meta/coverage');

    const campuses = body.data.by_campus.map((c) => c.campus).sort();
    expect(campuses).toEqual(['cavite', 'manila', 'taguig', 'visayas']);

    const cavite = body.data.by_campus.find((c) => c.campus === 'cavite')!;
    expect(cavite.has_adapter, 'Cavite has no adapter and must say so').toBe(false);
    expect(cavite.counts['program_offering']).toBe(0);
    expect(cavite.website_status).toBe('unavailable');
  });

  test('there is no system-wide total anywhere in the response', async () => {
    // An aggregate reads as coverage while hiding that a campus contributes none of it.
    const res = await app.request('/v1/meta/coverage');
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(Object.keys(body.data).sort()).toEqual(['by_campus', 'generated_at']);
  });

  test('zero is reported for every entity type, never omitted', async () => {
    const body = await get<{ data: { by_campus: { counts: Record<string, number> }[] } }>(
      '/v1/meta/coverage',
    );
    for (const campus of body.data.by_campus) {
      for (const entityType of ['academic_unit', 'program_offering', 'office', 'announcement']) {
        expect(campus.counts, `${entityType} missing`).toHaveProperty(entityType);
      }
    }
  });
});

describe('provenance survives the multi-campus join', () => {
  test('each offering cites the campus page it was actually parsed from', async () => {
    const body = await get<{ data: { offerings: Offering[] } }>('/v1/programs/bsee');
    const hosts: Record<string, string> = {
      manila: 'https://tup.edu.ph/',
      visayas: 'https://tupvisayas.edu.ph/',
      taguig: 'https://tupt.edu.ph/',
    };
    for (const offering of body.data.offerings) {
      expect(offering.provenance.source_url.startsWith(hosts[offering.campus]!)).toBe(true);
    }
  });
});
