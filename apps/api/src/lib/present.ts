/**
 * Row → payload projections shared between the endpoints that return offerings.
 *
 * One projection, used by `/v1/programs/{slug}` and `/v1/offerings/*` alike. Two
 * hand-rolled copies is how a field ends up `null` on one endpoint and absent on the
 * other, which docs/14 §5 lists as the drift contract tests exist to catch.
 */
import { schema } from '@tup/db';
import type { ProgramOffering } from '@tup/schemas';
import { toProvenance } from './provenance.js';

const { academicUnits, programOfferings, programs, sources } = schema;

export const offeringSelection = {
  ref: programOfferings.ref,
  campusSlug: programOfferings.campusSlug,
  slug: programOfferings.slug,
  sourceName: programOfferings.sourceName,
  localName: programOfferings.localName,
  majors: programOfferings.majors,
  years: programOfferings.years,
  status: programOfferings.status,
  accreditation: programOfferings.accreditation,
  curriculumUrl: programOfferings.curriculumUrl,
  programSlug: programs.slug,
  unitRef: academicUnits.ref,
  unitSlug: academicUnits.slug,
  unitName: academicUnits.name,
  unitType: academicUnits.unitType,
  firstSeenAt: programOfferings.firstSeenAt,
  lastVerifiedAt: programOfferings.lastVerifiedAt,
  confidence: programOfferings.confidence,
  sourceUrl: sources.url,
  method: sources.method,
};

export type OfferingRow = { [K in keyof typeof offeringSelection]: unknown };

export function presentOffering(row: OfferingRow): ProgramOffering {
  const unitRef = row.unitRef as string | null;
  return {
    ref: row.ref as string,
    campus: row.campusSlug as ProgramOffering['campus'],
    slug: row.slug as string,
    // null means "the source name has not been resolved into the registry yet" —
    // never a fabricated canonical program (ADR-003).
    program: (row.programSlug as string | null) ?? null,
    source_name: row.sourceName as string,
    local_name: (row.localName as string | null) ?? null,
    unit: unitRef
      ? {
          ref: unitRef,
          slug: row.unitSlug as string,
          name: row.unitName as string,
          // ADR-002 visible in the payload: this differs per campus.
          type: row.unitType as NonNullable<ProgramOffering['unit']>['type'],
        }
      : null,
    majors: (row.majors as string[] | null) ?? [],
    years: row.years === null || row.years === undefined ? null : Number(row.years),
    status: row.status as ProgramOffering['status'],
    curriculum_url: (row.curriculumUrl as string | null) ?? null,
    accreditation: (row.accreditation as Record<string, unknown> | null) ?? null,
    provenance: toProvenance({
      sourceUrl: row.sourceUrl as string,
      method: row.method as string,
      firstSeenAt: row.firstSeenAt as Date,
      lastVerifiedAt: row.lastVerifiedAt as Date,
      confidence: row.confidence as 'low' | 'medium' | 'high',
    }),
  };
}

export const programSelection = {
  ref: programs.ref,
  slug: programs.slug,
  code: programs.code,
  name: programs.name,
  aliases: programs.aliases,
  level: programs.level,
  discipline: programs.discipline,
  description: programs.description,
  typicalYears: programs.typicalYears,
  firstSeenAt: programs.firstSeenAt,
  lastVerifiedAt: programs.lastVerifiedAt,
  confidence: programs.confidence,
  sourceUrl: sources.url,
  method: sources.method,
};

export type ProgramRow = { [K in keyof typeof programSelection]: unknown };

export function presentProgram(row: ProgramRow) {
  return {
    ref: row.ref as string,
    slug: row.slug as string,
    code: (row.code as string | null) ?? null,
    name: row.name as string,
    aliases: (row.aliases as string[] | null) ?? [],
    level: row.level as 'baccalaureate',
    discipline: (row.discipline as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    typical_years:
      row.typicalYears === null || row.typicalYears === undefined
        ? null
        : Number(row.typicalYears),
    provenance: toProvenance({
      sourceUrl: row.sourceUrl as string,
      method: row.method as string,
      firstSeenAt: row.firstSeenAt as Date,
      lastVerifiedAt: row.lastVerifiedAt as Date,
      confidence: row.confidence as 'low' | 'medium' | 'high',
    }),
  };
}
