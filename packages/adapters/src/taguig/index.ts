/**
 * The Taguig adapter. See ./README.md — in particular why this stopped being a stub.
 */
import type { CampusAdapter, RawSnapshot, SourceRef } from '@tup/core';
import { CANONICAL_ORIGIN } from '@tup/core';
import { parseDepartment, parseProgramOfferings, TAGUIG_DEPARTMENT_SLUGS } from './parse.js';

const ORIGIN = CANONICAL_ORIGIN.taguig;

export const taguigAdapter: CampusAdapter = {
  campusSlug: 'taguig',
  domains: [new URL(ORIGIN).host],

  /**
   * Full-run ranges.
   *   *
   * These count **published rows**, not parsed records. Canonicalisation merges every
   * "…major in X" variant into one offering per award per campus before the guard sees
   * it (seeds/programs.yaml), so Manila's 89 parsed records become 38 offerings. Set
   * these from what lands in the table, not from what the page lists.
   *
   * Observed 2026-08-29: 4 departments; 22 records parsed, 8 offerings published. The
   * first run of this adapter quarantined on a range set from the parsed count, which
   * is the mistake this note exists to stop the next person repeating.
   */
  expectations: {
    academic_unit: { min: 3, max: 8 },
    program_offering: { min: 4, max: 15 },
  },

  async *discover(): AsyncIterable<SourceRef> {
    yield {
      url: `${ORIGIN}/progoff`,
      entityTypes: ['program_offering'],
      method: 'crawl',
      recrawlInterval: '7 days',
    };

    // Explicit list. `/academics/department` itself is a 404 — there is no index page
    // to page through, which is one more reason adapters enumerate rather than crawl.
    for (const department of TAGUIG_DEPARTMENT_SLUGS) {
      yield {
        url: `${ORIGIN}/academics/department/${department}`,
        entityTypes: ['academic_unit'],
        method: 'crawl',
        recrawlInterval: '7 days',
        hint: { department },
      };
    }
  },

  parse(snapshot: RawSnapshot) {
    const html = snapshot.body.toString('utf8');
    const { pathname } = new URL(snapshot.sourceRef.url);

    if (pathname === '/progoff') return Promise.resolve(parseProgramOfferings(html));

    const department = /^\/academics\/department\/([a-z]+)$/.exec(pathname);
    if (department?.[1]) return Promise.resolve(parseDepartment(html, department[1]));

    return Promise.resolve({ byEntity: {}, warnings: [`no Taguig parser for ${pathname}`] });
  },
};

export { parseDepartment, parseProgramOfferings, TAGUIG_DEPARTMENT_SLUGS } from './parse.js';
