/**
 * Golden fixture tests — the highest-value category in this repo (docs/14 §3).
 *
 * Deep equality against the whole ParseResult. Not `toMatchObject`, not a length
 * assertion. A partial assertion passes while a redesign silently drops half the rows,
 * which is the exact failure this suite exists to catch. During development an
 * 80-character slug cap merged five real CIT degrees into one row; that is what this
 * test is for.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { ADAPTERS } from '@tup/adapters';
import { contentHash, type ManifestFile, type RawSnapshot } from '@tup/core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturesRoot = join(root, 'fixtures');

interface Case {
  campus: string;
  file: string;
  url: string;
  dir: string;
  expectedPath: string;
}

async function casesFor(campus: string): Promise<Case[]> {
  const dir = join(fixturesRoot, campus);
  const manifestPath = join(dir, 'MANIFEST.json');
  if (!existsSync(manifestPath)) return [];
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ManifestFile;
  return manifest.files.map((entry) => ({
    campus,
    file: entry.file,
    url: entry.url,
    dir,
    expectedPath: join(dir, entry.file.replace(/\.html$/, '.expected.json')),
  }));
}

async function snapshotFor(item: Case): Promise<RawSnapshot> {
  const body = await readFile(join(item.dir, item.file));
  return {
    sourceRef: { url: item.url, entityTypes: [], method: 'crawl' },
    // Fixed, from the manifest — never `now`. A clock in a fixture test makes the
    // test non-deterministic and hides exactly what fixtures are for.
    fetchedAt: new Date('2026-08-29T00:00:00Z'),
    httpStatus: 200,
    contentType: 'text/html',
    body,
    contentHash: contentHash(body),
  };
}

const campuses = Object.keys(ADAPTERS);

for (const campus of campuses) {
  const adapter = ADAPTERS[campus]!;
  const cases = await casesFor(campus);

  describe(`${campus} golden fixtures`, () => {
    test('the campus has fixtures at all', () => {
      expect(cases.length, `no fixtures under fixtures/${campus}/`).toBeGreaterThan(0);
    });

    test.each(cases.map((c) => [c.file, c] as const))('parses %s exactly', async (_name, item) => {
      expect(
        existsSync(item.expectedPath),
        `${item.file} has no .expected.json. Write the expected output by hand first — docs/15 §6.`,
      ).toBe(true);

      const result = await adapter.parse(await snapshotFor(item));
      const expected = JSON.parse(await readFile(item.expectedPath, 'utf8')) as unknown;
      expect(result).toEqual(expected);
    });

    test.each(cases.map((c) => [c.file, c] as const))(
      '%s parses identically twice — parse is pure (ADR-005)',
      async (_name, item) => {
        const snapshot = await snapshotFor(item);
        const first = await adapter.parse(snapshot);
        const second = await adapter.parse(await snapshotFor(item));
        expect(first).toEqual(second);
      },
    );

    /**
     * docs/14 §10: an adapter shipping without fixtures is the failure mode a coverage
     * percentage would not have caught. Enforced by enumeration, not by discipline.
     */
    test('every entity type the adapter declares expectations for has a fixture', async () => {
      const produced = new Set<string>();
      for (const item of cases) {
        if (!existsSync(item.expectedPath)) continue;
        const expected = JSON.parse(await readFile(item.expectedPath, 'utf8')) as {
          byEntity: Record<string, unknown[]>;
        };
        for (const [entityType, records] of Object.entries(expected.byEntity)) {
          if (records.length > 0) produced.add(entityType);
        }
      }
      for (const entityType of Object.keys(adapter.expectations ?? {})) {
        expect(
          produced.has(entityType),
          `${campus} declares expectations for '${entityType}' but no fixture produces one`,
        ).toBe(true);
      }
    });

    test('every discovered URL begins with the campus canonical origin [E5]', async () => {
      const { CANONICAL_ORIGIN } = await import('@tup/core');
      const origin = CANONICAL_ORIGIN[campus as keyof typeof CANONICAL_ORIGIN];
      for await (const ref of adapter.discover()) {
        expect(ref.url.startsWith(origin), `${ref.url} is not under ${origin}`).toBe(true);
      }
    });
  });
}

/**
 * Parsed counts, per campus. These are NOT the adapter's `expectations`: those count
 * published rows, and canonicalisation merges every "…major in X" variant into one
 * offering per award before anything is published (seeds/programs.yaml). Manila parses
 * 89 records and publishes 38. Conflating the two quarantined the Taguig adapter on
 * its first run.
 */
const PARSED_COUNTS: Record<string, { units: number; offerings: number }> = {
  manila: { units: 6, offerings: 89 },
  visayas: { units: 3, offerings: 16 },
  taguig: { units: 4, offerings: 22 },
};

describe('the counts each adapter actually produces', () => {
  test.each(Object.keys(PARSED_COUNTS))('%s parses the expected record counts', async (campus) => {
    const adapter = ADAPTERS[campus]!;
    let units = 0;
    let offerings = 0;
    for (const item of await casesFor(campus)) {
      const result = await adapter.parse(await snapshotFor(item));
      units += result.byEntity.academic_unit?.length ?? 0;
      offerings += result.byEntity.program_offering?.length ?? 0;
    }
    expect({ units, offerings }).toEqual(PARSED_COUNTS[campus]);
  });

  test('academic units are never merged, so their counts must sit inside expectations', async () => {
    for (const campus of Object.keys(PARSED_COUNTS)) {
      const range = ADAPTERS[campus]!.expectations?.academic_unit;
      const observed = PARSED_COUNTS[campus]!.units;
      expect(observed, `${campus} unit count below its declared minimum`).toBeGreaterThanOrEqual(
        range!.min,
      );
      expect(observed, `${campus} unit count above its declared maximum`).toBeLessThanOrEqual(
        range!.max,
      );
    }
  });

  test('every campus states its own unit vocabulary — ADR-002, never assumed', async () => {
    const vocabulary: Record<string, string> = {
      manila: 'college',
      visayas: 'college',
      taguig: 'department',
    };
    for (const [campus, expected] of Object.entries(vocabulary)) {
      const adapter = ADAPTERS[campus]!;
      const types = new Set<string>();
      for (const item of await casesFor(campus)) {
        const result = await adapter.parse(await snapshotFor(item));
        for (const unit of result.byEntity.academic_unit ?? []) {
          types.add((unit as { unit_type: string }).unit_type);
        }
      }
      expect([...types], `${campus} emitted the wrong vocabulary`).toEqual([expected]);
    }
  });

describe('manila fixture specifics', () => {
  test('the six near-identical CIT degrees survive slugification', async () => {
    const adapter = ADAPTERS['manila']!;
    const cit = (await casesFor('manila')).find((c) => c.file.startsWith('courses-cit'))!;
    const result = await adapter.parse(await snapshotFor(cit));
    const slugs = (result.byEntity.program_offering ?? []).map((r) => (r as { slug: string }).slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs.filter((s) => s.includes('mechanical-engineering-technology-option')).length).toBe(6);
  });

  /**
   * The check docs/11 §7 calls "the one people skip and the only one that catches a
   * parser that is confidently wrong — reading the right element for the wrong field".
   * Done by hand for ten records (see the adapter README) and then generalised here to
   * all of them, because a machine can check verbatim presence forever and a human
   * cannot.
   */
  test('every emitted name appears verbatim in the page it was parsed from', async () => {
    const adapter = ADAPTERS['manila']!;
    let checked = 0;

    for (const item of await casesFor('manila')) {
      const snapshot = await snapshotFor(item);
      const result = await adapter.parse(snapshot);
      const text = snapshot.body
        .toString('utf8')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ');

      for (const record of result.byEntity.program_offering ?? []) {
        const name = (record as { source_name: string }).source_name;
        expect(text, `${item.file}: "${name}" is not on the page`).toContain(name);
        checked++;
      }
      for (const record of result.byEntity.academic_unit ?? []) {
        const name = (record as { name: string }).name;
        expect(text, `${item.file}: "${name}" is not on the page`).toContain(name);
        checked++;
      }
    }

    expect(checked).toBe(95);
  });

  test('the undergraduate-programs page is still a PDF embed, and says so', async () => {
    const adapter = ADAPTERS['manila']!;
    const page = (await casesFor('manila')).find((c) => c.file.startsWith('programs-undergraduate'))!;
    const result = await adapter.parse(await snapshotFor(page));
    expect(result.byEntity).toEqual({});
    expect(result.warnings[0]).toContain('Google Drive PDF embed');
  });
});
});
