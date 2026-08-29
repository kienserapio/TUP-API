/**
 * The Visayas adapter. Route inventory, the Content-Signal position, and quirks are in
 * ./README.md.
 */
import type { CampusAdapter, RawSnapshot, SourceRef } from '@tup/core';
import { CANONICAL_ORIGIN } from '@tup/core';
import { parseAcademics, parseUndergraduatePrograms } from './parse.js';

const ORIGIN = CANONICAL_ORIGIN.visayas;

export const visayasAdapter: CampusAdapter = {
  campusSlug: 'visayas',
  domains: [new URL(ORIGIN).host],

  /**
   * Full-run ranges, docs/08 §5.2.
   *   *
   * These count **published rows**, not parsed records. Canonicalisation merges every
   * "…major in X" variant into one offering per award per campus before the guard sees
   * it (seeds/programs.yaml), so Manila's 89 parsed records become 38 offerings. Set
   * these from what lands in the table, not from what the page lists.
   *
   * Observed 2026-08-29: 3 colleges; 16 records parsed, 8 offerings published.
   */
  expectations: {
    academic_unit: { min: 3, max: 5 },
    program_offering: { min: 4, max: 15 },
  },

  async *discover(): AsyncIterable<SourceRef> {
    yield {
      url: `${ORIGIN}/academics`,
      entityTypes: ['academic_unit'],
      method: 'crawl',
      recrawlInterval: '7 days',
    };
    yield {
      url: `${ORIGIN}/academics/undergraduate-programs`,
      entityTypes: ['program_offering'],
      method: 'crawl',
      recrawlInterval: '7 days',
    };
  },

  parse(snapshot: RawSnapshot) {
    const html = snapshot.body.toString('utf8');
    const { pathname } = new URL(snapshot.sourceRef.url);

    if (pathname === '/academics') return Promise.resolve(parseAcademics(html));
    if (pathname === '/academics/undergraduate-programs') {
      return Promise.resolve(parseUndergraduatePrograms(html));
    }

    return Promise.resolve({ byEntity: {}, warnings: [`no Visayas parser for ${pathname}`] });
  },
};

export { parseAcademics, parseUndergraduatePrograms } from './parse.js';
