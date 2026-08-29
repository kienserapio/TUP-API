/**
 * The Manila adapter. Route inventory, quirks, and the answer to open question Q2 are
 * in ./README.md — the adapter-guide §7 checklist requires it and it is the first
 * thing the next maintainer will read.
 */
import type { CampusAdapter, RawSnapshot, SourceRef } from '@tup/core';
import { CANONICAL_ORIGIN } from '@tup/core';
import { parseAcademics, parseAdmissionProgramsPage, parseCourses } from './parse.js';

const ORIGIN = CANONICAL_ORIGIN.manila;

/**
 * Explicit list, no recursion, no ID incrementing (docs/11 §2). These six slugs are
 * the university's colleges; a seventh appearing is a 404 you can see rather than an
 * unbounded crawl you cannot.
 */
export const MANILA_COLLEGE_SLUGS = ['coe', 'cit', 'cie', 'cafa', 'cos', 'cla'] as const;

export const manilaAdapter: CampusAdapter = {
  campusSlug: 'manila',
  domains: [new URL(ORIGIN).host],

  /**
   * Full-run ranges, per docs/08 §3.3. The guard applies them only on `--full`, where
   * every source was parsed; on an incremental run the counts are legitimately partial
   * (errata E3).
   *   *
   * These count **published rows**, not parsed records. Canonicalisation merges every
   * "…major in X" variant into one offering per award per campus before the guard sees
   * it (seeds/programs.yaml), so Manila's 89 parsed records become 38 offerings. Set
   * these from what lands in the table, not from what the page lists.
   *
   * Observed 2026-08-29: 6 colleges; 89 records parsed, 38 offerings published.
   */
  expectations: {
    academic_unit: { min: 5, max: 9 },
    program_offering: { min: 20, max: 60 },
  },

  async *discover(): AsyncIterable<SourceRef> {
    yield {
      url: `${ORIGIN}/page/academics`,
      entityTypes: ['academic_unit'],
      method: 'crawl',
      recrawlInterval: '7 days',
    };

    for (const college of MANILA_COLLEGE_SLUGS) {
      yield {
        url: `${ORIGIN}/courses/academics/${college}`,
        entityTypes: ['program_offering'],
        method: 'crawl',
        recrawlInterval: '7 days',
        hint: { college },
      };
    }
  },

  parse(snapshot: RawSnapshot) {
    const html = snapshot.body.toString('utf8');
    const { pathname } = new URL(snapshot.sourceRef.url);

    if (pathname === '/page/academics') return Promise.resolve(parseAcademics(html));

    const courses = /^\/courses\/academics\/([a-z]+)$/.exec(pathname);
    if (courses?.[1]) return Promise.resolve(parseCourses(html, courses[1]));

    if (pathname === '/pages/admission/undergraduate-programs') {
      return Promise.resolve(parseAdmissionProgramsPage(html));
    }

    return Promise.resolve({
      byEntity: {},
      warnings: [`no Manila parser for ${pathname}`],
    });
  },
};

export { parseAcademics, parseAdmissionProgramsPage, parseCourses } from './parse.js';
export type { AcademicUnitRecord, ProgramOfferingRecord } from '../records.js';
