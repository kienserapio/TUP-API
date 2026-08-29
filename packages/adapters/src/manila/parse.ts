/**
 * Manila parsers. Pure functions: bytes in, records out.
 *
 * No network, no clock, no randomness — ADR-005. That purity is what makes the golden
 * fixture tests in test/fixtures possible, and docs/14 §2 puts half of all test effort
 * there because a silently-emptied selector is the failure this project will hit
 * repeatedly.
 */
import * as cheerio from 'cheerio';
import { clean, majorsOf, slugify } from '../text.js';
import type { AcademicUnitRecord, ProgramOfferingRecord } from '../records.js';

export interface ParsedPage {
  byEntity: {
    academic_unit?: AcademicUnitRecord[];
    program_offering?: ProgramOfferingRecord[];
  };
  warnings: string[];
}

/**
 * The six colleges.
 *
 * Names come from the `title` attribute on the footer's college list, which is
 * correctly cased; the legacy `/page/academics` table renders them in all-caps inside
 * a `<span style="color:#000000">`, and title-casing that would be inventing data.
 * Descriptions and abbreviations come from the table, matched by slug.
 */
export function parseAcademics(html: string): ParsedPage {
  const $ = cheerio.load(html);
  const warnings: string[] = [];
  const units = new Map<string, AcademicUnitRecord>();

  // The college list appears twice: once in the main nav as bare links, once in the
  // footer's "University Colleges" block where each anchor carries a `title`. Group by
  // slug and take the first title found — the nav copy has no name to offer, and
  // warning about it every run would train the reader to ignore warnings.
  $('a[href^="pagecollege/academics/"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const slug = href.split('/').pop() ?? '';
    if (!slug) {
      warnings.push(`college link with no slug: ${href}`);
      return;
    }
    const name = clean($(el).attr('title') ?? '');
    const existing = units.get(slug);
    if (existing) {
      if (!existing.name && name) existing.name = name;
      return;
    }
    units.set(slug, {
      slug,
      name,
      abbreviation: null,
      // ADR-002: Manila's vocabulary is colleges. Never assumed — stated per campus.
      unit_type: 'college',
      description: null,
      head_name: null,
      head_title: null,
      emails: [],
      website: null,
      status: 'active',
    });
  });

  // Reject, never coerce: a college with no name anywhere on the page is a parser bug,
  // and the guard must see the hole rather than a row called "Unknown". docs/11 §3.1.
  for (const [slug, unit] of [...units]) {
    if (!unit.name) {
      warnings.push(`college '${slug}' has no name on this page`);
      units.delete(slug);
    }
  }

  // Legacy `/page/*` generation. Its table carries a paragraph of prose per college
  // that the current generation does not — see the adapter README, open question Q2.
  $('a[href^="pages/academics/"]').each((_, el) => {
    const slug = ($(el).attr('href') ?? '').split('/').pop() ?? '';
    const unit = units.get(slug);
    if (!unit) return;

    const cell = $(el).closest('td');
    const description = clean(
      cell
        .find('p')
        .slice(1)
        .map((__, p) => $(p).text())
        .get()
        .join(' '),
    );
    if (description) unit.description = description;

    const abbreviation = /\(([A-Z]{2,6})\)/.exec(description)?.[1];
    if (abbreviation) unit.abbreviation = abbreviation;
  });

  if (units.size === 0) warnings.push('no colleges found on the academics page');

  return { byEntity: { academic_unit: [...units.values()] }, warnings };
}

/**
 * A college's "Courses Offered" page: a two-level Bootstrap accordion.
 *
 *   #accordion    → one card per level group ("UNDERGRADUATE PROGRAMS", "GRADUATE …")
 *     #accordion-N → one card per program, id `heading-{group}-{sourceId}`
 *
 * The ids are CMS-assigned and durable, which is why the group is derived from the id
 * prefix rather than from DOM nesting — nesting here is four divs deep and is exactly
 * the kind of structure a redesign rearranges without changing the ids.
 */
export function parseCourses(html: string, collegeSlug: string): ParsedPage {
  const $ = cheerio.load(html);
  const warnings: string[] = [];
  const offerings: ProgramOfferingRecord[] = [];
  const seen = new Set<string>();

  // One pass over every accordion header. `heading-{group}` is a level group,
  // `heading-{group}-{sourceId}` is a program; the trailing number is CMS-assigned.
  const headers = new Map<string, string>();
  $('div.card-header[id^="heading-"]').each((_, el) => {
    const id = $(el).attr('id');
    if (id) headers.set(id, clean($(el).find('h5 a').first().text()));
  });

  for (const [id, name] of headers) {
    const parts = id.split('-');
    if (parts.length !== 3) continue;

    if (!name) {
      // Reject, never coerce. A nameless card is a parser bug and the guard must see
      // the hole it leaves, not a row called "Unknown Program". docs/11 §3.1.
      warnings.push(`accordion card ${id} has no program name`);
      continue;
    }

    const groupId = `${parts[0]}-${parts[1]}`;
    if (!headers.has(groupId)) {
      warnings.push(`program ${id} has no level group header (${groupId} missing)`);
    }

    const slug = slugify(name);
    if (!slug) {
      warnings.push(`program ${id} ("${name}") produced an empty slug`);
      continue;
    }
    if (seen.has(slug)) {
      warnings.push(`duplicate program on this page: "${name}"`);
      continue;
    }
    seen.add(slug);


    offerings.push({
      source_name: name,
      slug,
      local_name: null,
      unit_slug: collegeSlug,
      majors: majorsOf(name),
      // Not published on this page. `null` is the honest answer; docs/11 §3 forbids
      // substituting a plausible default here.
      years: null,
      status: 'active',
      accreditation: null,
      curriculum_url: null,
    });
  }

  if (offerings.length === 0) {
    warnings.push(`no programs found on the ${collegeSlug} courses page`);
  }

  return { byEntity: { program_offering: offerings }, warnings };
}

/**
 * `/pages/admission/undergraduate-programs` renders a Google Drive PDF viewer and no
 * HTML program list — verified 2026-08-29, see the adapter README. Parsed explicitly
 * so the finding is asserted by a test rather than remembered, and so a future switch
 * back to real markup shows up as a failing fixture instead of silence.
 */
export function parseAdmissionProgramsPage(html: string): ParsedPage {
  const $ = cheerio.load(html);
  const embeds = $('.posts__excerpt embed[src*="drive.google.com"]');
  const warnings =
    embeds.length > 0
      ? [
          'undergraduate-programs page is a Google Drive PDF embed, not HTML; ' +
            'program offerings are read from courses/academics/{college} instead',
        ]
      : ['undergraduate-programs page no longer embeds a PDF — re-check whether it now carries HTML programs'];
  return { byEntity: {}, warnings };
}

