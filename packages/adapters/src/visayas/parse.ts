/**
 * Visayas parsers. Laravel, Cloudflare-fronted, and the best-structured of the four
 * sites — BEM class names, one card per record, a durable slug in every href.
 *
 * Pure functions: bytes in, records out (ADR-005).
 */
import * as cheerio from 'cheerio';
import { clean, lastSegment, majorsOf, slugify, yearsOf } from '../text.js';
import type { AcademicUnitRecord, ProgramOfferingRecord } from '../records.js';

export interface ParsedPage {
  byEntity: {
    academic_unit?: AcademicUnitRecord[];
    program_offering?: ProgramOfferingRecord[];
  };
  warnings: string[];
}

/**
 * `/academics` — "Our Colleges", one `.acad-college-card` per college, each with a
 * title anchor whose href carries the slug and a paragraph of real prose.
 *
 * ADR-002: three **colleges** here. Stated per campus, never assumed.
 */
export function parseAcademics(html: string): ParsedPage {
  const $ = cheerio.load(html);
  const warnings: string[] = [];
  const units: AcademicUnitRecord[] = [];
  const seen = new Set<string>();

  $('article.acad-college-card').each((_, el) => {
    const card = $(el);
    const anchor = card.find('.acad-college-card__title a').first();
    const href = anchor.attr('href') ?? '';
    const slug = lastSegment(href);
    const name = clean(anchor.text());

    if (!slug || !name) {
      // Reject, never coerce: a college with no name is a parser bug, and the guard
      // has to see the hole rather than a row called "Unknown". docs/11 §3.1.
      warnings.push(`college card with no slug or name (href '${href}')`);
      return;
    }
    if (seen.has(slug)) return;
    seen.add(slug);

    const description = clean(card.find('.acad-college-card__text').first().text());

    units.push({
      slug,
      name,
      abbreviation: null,
      unit_type: 'college',
      description: description || null,
      head_name: null,
      head_title: null,
      emails: [],
      website: null,
      status: 'active',
    });
  });

  if (units.length === 0) warnings.push('no college cards found on the academics page');

  return { byEntity: { academic_unit: units }, warnings };
}

/**
 * `/academics/undergraduate-programs` — one `.ug-card` per degree, grouped under a
 * `.ug-college-group` per college.
 *
 * The college is read from each card's own "Program details" href
 * (`/academics/{college}/programs/{program}`) rather than from the enclosing group.
 * The href is the record's own claim about where it belongs; the grouping is layout,
 * and layout is what a redesign moves.
 */
export function parseUndergraduatePrograms(html: string): ParsedPage {
  const $ = cheerio.load(html);
  const warnings: string[] = [];
  const offerings: ProgramOfferingRecord[] = [];
  const seen = new Set<string>();

  $('article.ug-card').each((_, el) => {
    const card = $(el);
    const name = clean(card.find('.ug-card__title').first().text());
    if (!name) {
      warnings.push('program card with no title');
      return;
    }

    const href = card.find('a.ug-card__link').first().attr('href') ?? '';
    const match = /\/academics\/([a-z0-9-]+)\/programs\/([a-z0-9-]+)/i.exec(href);
    if (!match) {
      warnings.push(`program "${name}" has no /academics/{college}/programs/{slug} link`);
      return;
    }
    const [, unitSlug, hrefSlug] = match;

    // The href slug is CMS-assigned and survives a title edit, which is exactly what
    // docs/11 §7 means by "derived from a durable field, not a title that can be
    // edited". Manila had no such field and had to slugify the title instead.
    const slug = hrefSlug ?? slugify(name);
    if (seen.has(slug)) {
      warnings.push(`duplicate program on this page: "${name}"`);
      return;
    }
    seen.add(slug);

    offerings.push({
      source_name: name,
      slug,
      local_name: null,
      unit_slug: unitSlug ?? null,
      majors: majorsOf(name),
      // Published here, unlike Manila. Read from the badge, never assumed to be 4.
      years: yearsOf(card.find('.ug-card__years').first().text()),
      status: 'active',
      accreditation: null,
      curriculum_url: null,
    });
  });

  if (offerings.length === 0) {
    warnings.push('no program cards found on the undergraduate-programs page');
  }

  return { byEntity: { program_offering: offerings }, warnings };
}
