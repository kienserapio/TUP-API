/**
 * Taguig parsers.
 *
 * This adapter exists because the site came back. ADR-012 modelled Taguig as a stub
 * that yields nothing while the host served a cPanel suspension notice; the
 * 2026-08-29 re-verification found it live, which is the trigger that ADR-012 said
 * would turn the stub into real work. docs/08 §6.
 *
 * Pure functions: bytes in, records out (ADR-005).
 */
import * as cheerio from 'cheerio';
import { clean, lastSegment, majorsOf, slugify } from '../text.js';
import type { AcademicUnitRecord, ProgramOfferingRecord } from '../records.js';

export interface ParsedPage {
  byEntity: {
    academic_unit?: AcademicUnitRecord[];
    program_offering?: ProgramOfferingRecord[];
  };
  warnings: string[];
}

/**
 * ADR-002, the second time. Taguig organises into **departments**, like Cavite and
 * unlike Manila and Visayas. An integration that assumed "college" is now wrong about
 * two of the four campuses.
 */
export const TAGUIG_DEPARTMENT_SLUGS = ['basd', 'caad', 'eaad', 'maad'] as const;

/**
 * `/academics/department/{slug}` — one department.
 *
 * The name comes from the site nav, not from the page's own `h2.about-title`. The
 * heading wraps "Department" in a `<span>` and for `eaad` there is no whitespace
 * before it, so the heading reads "Electrical and AlliedDepartment" — a rendering
 * artifact, not the department's name. The nav states all four properly and appears on
 * every page. The heading stays as a fallback so a nav redesign degrades rather than
 * empties.
 *
 * The head comes from the profile block, and only when its caption actually says
 * "Head" — a name with no stated role is a person we have no business publishing
 * (PRD C1).
 */
export function parseDepartment(html: string, slug: string): ParsedPage {
  const $ = cheerio.load(html);
  const warnings: string[] = [];

  const fromNav = clean($(`a[href$="/academics/department/${slug}"]`).first().text());
  const fromHeading = clean($('h2.about-title').first().text());
  const name = fromNav || fromHeading;
  if (!name) {
    warnings.push(`department page '${slug}' names itself nowhere`);
    return { byEntity: { academic_unit: [] }, warnings };
  }
  if (fromNav && fromHeading && fromNav !== fromHeading) {
    warnings.push(`'${slug}' nav says "${fromNav}", heading says "${fromHeading}"; using the nav`);
  }

  const description = clean($('h2.about-title').first().closest('.about-content').find('p').first().text());

  const profile = $('.testimonials-area .testimonials-title').first();
  const headName = clean(profile.find('h2.title').first().text());
  const headTitle = clean(profile.find('p').first().text());
  const isHead = /head/i.test(headTitle);
  if (headName && !isHead) {
    warnings.push(`'${slug}' names ${headName} as "${headTitle}", not a head; not published`);
  }

  return {
    byEntity: {
      academic_unit: [
        {
          slug,
          name,
          abbreviation: slug.toUpperCase(),
          unit_type: 'department',
          description: description || null,
          head_name: isHead && headName ? headName : null,
          head_title: isHead && headTitle ? headTitle : null,
          emails: [],
          website: null,
          status: 'active',
        },
      ],
    },
    warnings,
  };
}

/**
 * `/progoff` — every degree the campus offers, on one page.
 *
 * The owning department is a class on the column wrapper (`courses-col eaad`), which
 * is the only place the page states it. That is a positional-ish selector and it is
 * flagged as such: if a redesign drops those classes, every offering loses its unit
 * rather than silently landing in the wrong one, because the code below skips a card
 * whose department it cannot name.
 */
export function parseProgramOfferings(html: string): ParsedPage {
  const $ = cheerio.load(html);
  const warnings: string[] = [];
  const offerings: ProgramOfferingRecord[] = [];
  const seen = new Set<string>();
  const departments = new Set<string>(TAGUIG_DEPARTMENT_SLUGS);

  $('div.courses-col').each((_, el) => {
    const column = $(el);
    const classes = (column.attr('class') ?? '').split(/\s+/);
    const unitSlug = classes.find((cls) => departments.has(cls)) ?? null;

    const name = clean(column.find('h4.courses-title a').first().text());
    if (!name) {
      warnings.push('course card with no title');
      return;
    }
    if (!unitSlug) {
      warnings.push(`"${name}" has no department class; published without a unit`);
    }

    const slug = slugify(name);
    if (!slug) {
      warnings.push(`"${name}" produced an empty slug`);
      return;
    }
    if (seen.has(slug)) {
      warnings.push(`duplicate program on this page: "${name}"`);
      return;
    }
    seen.add(slug);

    offerings.push({
      source_name: name,
      slug,
      local_name: null,
      unit_slug: unitSlug,
      majors: majorsOf(name),
      // Not published on this page. `null` is the honest answer.
      years: null,
      status: 'active',
      accreditation: null,
      curriculum_url: null,
    });
  });

  if (offerings.length === 0) warnings.push('no course cards found on /progoff');

  return { byEntity: { program_offering: offerings }, warnings };
}

export { lastSegment };
