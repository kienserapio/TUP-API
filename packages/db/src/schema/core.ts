import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { degreeLevel, offeringStatus, sourceStatus, unitType } from './enums.js';
import { provenance } from './provenance.js';
import { sources } from './sources.js';

export const campuses = pgTable('campuses', {
  id: uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`),
  slug: text('slug').notNull().unique(),
  /** Generated column: docs/10 §3. `ref` never contains the academic unit. */
  ref: text('ref').generatedAlwaysAs(sql`slug`),
  name: text('name').notNull(),
  shortName: text('short_name'),
  kind: text('kind').notNull(),
  parentSlug: text('parent_slug'),
  address: jsonb('address').$type<{
    street?: string;
    city?: string;
    province?: string;
    region?: string;
    postal?: string;
  }>(),
  geo: jsonb('geo').$type<{ lat: number; lng: number }>(),
  website: text('website'),
  /**
   * ADR-017: 'suspended' is distinct from 'unavailable' — a cPanel suspension notice
   * served as HTTP 200 is publishable, recoverable information, and Taguig sat in that
   * state until 2026-08-29. Whatever the value, it is a verified observation about the
   * host, never a default. docs/08 §6.
   */
  websiteStatus: sourceStatus('website_status').notNull().default('active'),
  emails: text('emails').array(),
  phones: text('phones').array(),
  established: integer('established'),
  description: text('description'),
  facebookUrl: text('facebook_url'),
  ...provenance,
});

/** ADR-002: one table, one discriminator. A new campus vocabulary is an enum value, not a migration. */
export const academicUnits = pgTable(
  'academic_units',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    campusId: uuid('campus_id')
      .notNull()
      .references(() => campuses.id),
    campusSlug: text('campus_slug').notNull(),
    parentId: uuid('parent_id'),
    slug: text('slug').notNull(),
    ref: text('ref').generatedAlwaysAs(sql`campus_slug || '/' || slug`),
    name: text('name').notNull(),
    abbreviation: text('abbreviation'),
    unitType: unitType('unit_type').notNull(),
    description: text('description'),
    headName: text('head_name'),
    headTitle: text('head_title'),
    emails: text('emails').array(),
    website: text('website'),
    status: text('status').notNull().default('active'),
    ...provenance,
  },
  (t) => [
    unique('academic_units_campus_id_slug_key').on(t.campusId, t.slug),
    index('academic_units_campus_type_idx').on(t.campusId, t.unitType),
  ],
);

/** ADR-003: the canonical, campus-agnostic degree. Keyed by a global slug. */
export const programs = pgTable(
  'programs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    slug: text('slug').notNull().unique(),
    ref: text('ref').generatedAlwaysAs(sql`slug`),
    code: text('code'),
    name: text('name').notNull(),
    /** Source name variants seen in the wild. GIN-indexed; the matching chain hits it per offering. */
    aliases: text('aliases').array(),
    level: degreeLevel('level').notNull(),
    discipline: text('discipline'),
    description: text('description'),
    typicalYears: numeric('typical_years', { precision: 3, scale: 1 }),
    ...provenance,
  },
  (t) => [index('programs_level_disc_idx').on(t.level, t.discipline)],
);

/** ADR-003: the degree as taught at one campus. `program_id` NULL means unmatched, never auto-created. */
export const programOfferings = pgTable(
  'program_offerings',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    programId: uuid('program_id').references(() => programs.id),
    campusId: uuid('campus_id')
      .notNull()
      .references(() => campuses.id),
    campusSlug: text('campus_slug').notNull(),
    unitId: uuid('unit_id').references(() => academicUnits.id),
    /** Verbatim, before canonicalisation. What makes `ingest:unmatched` useful. */
    sourceName: text('source_name').notNull(),
    slug: text('slug').notNull(),
    ref: text('ref').generatedAlwaysAs(sql`campus_slug || '/' || slug`),
    localName: text('local_name'),
    majors: text('majors').array(),
    years: numeric('years', { precision: 3, scale: 1 }),
    status: offeringStatus('status').notNull().default('active'),
    accreditation: jsonb('accreditation'),
    curriculumUrl: text('curriculum_url'),
    ...provenance,
  },
  (t) => [
    unique('program_offerings_program_id_campus_id_key').on(t.programId, t.campusId),
    index('program_offerings_campus_status_idx').on(t.campusId, t.status),
  ],
);

export const seedSourceUrl = 'seed://tup-open-api/seeds';
export { sources };
