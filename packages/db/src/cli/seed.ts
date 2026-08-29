/**
 * Idempotent seed. Safe to re-run — a second run changes nothing (M2 checkpoint).
 *
 * Everything here is hand-curated: four campuses, fourteen units, twenty canonical
 * programs. Do not scrape what you can type. Hand curation is a STRONGER provenance
 * claim than a scrape, so these rows carry method='seed' and confidence='high'.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { parse } from 'yaml';
import { createDb } from '../client.js';
import { academicUnits, campuses, programs, sources } from '../schema/index.js';

const seedsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../seeds');

/** docs/08-source-landscape.md §1 is the only place hostnames are stated. */
const CANONICAL_ORIGIN = {
  manila: 'https://tup.edu.ph',
  cavite: 'https://www.tupcavite.edu.ph',
  visayas: 'https://tupvisayas.edu.ph',
  taguig: 'https://tupt.edu.ph',
} as const;

interface CampusSeed {
  slug: keyof typeof CANONICAL_ORIGIN;
  name: string;
  short_name?: string;
  kind: string;
  website?: string;
  website_status?: 'active' | 'unavailable' | 'suspended' | 'blocked' | 'retired';
  address?: Record<string, string>;
  established?: number;
  description?: string;
}

interface UnitSeed {
  slug: string;
  name: string;
  abbreviation?: string;
}
type UnitsFile = Record<string, { unit_type: string; units: UnitSeed[] }>;

interface ProgramSeed {
  slug: string;
  name: string;
  level: string;
  discipline?: string;
  typical_years?: number;
  aliases?: string[];
}

async function readYaml<T>(file: string): Promise<T> {
  return parse(await readFile(resolve(seedsDir, file), 'utf8')) as T;
}

async function main(): Promise<void> {
  const { sql: client, db } = createDb();

  try {
    const [seedSource] = await db
      .select({ id: sources.id })
      .from(sources)
      .where(sql`${sources.url} = 'seed://tup-open-api/seeds'`);

    if (!seedSource) {
      throw new Error(
        'Synthetic seed source missing. Run `pnpm db:migrate` first — migration 003 creates it.',
      );
    }
    const sourceId = seedSource.id;

    // ── campuses ────────────────────────────────────────────────────────────
    const campusSeeds = await readYaml<CampusSeed[]>('campuses.yaml');
    for (const c of campusSeeds) {
      const origin = CANONICAL_ORIGIN[c.slug];
      if (c.website && c.website !== origin) {
        throw new Error(
          `seeds/campuses.yaml: ${c.slug} website '${c.website}' does not match the canonical ` +
            `origin '${origin}' from docs/08 §1. Guards errata E5.`,
        );
      }
      await db
        .insert(campuses)
        .values({
          slug: c.slug,
          name: c.name,
          shortName: c.short_name ?? null,
          kind: c.kind,
          website: origin,
          websiteStatus: c.website_status ?? 'active',
          address: c.address ?? null,
          established: c.established ?? null,
          description: c.description ?? null,
          sourceId,
          confidence: 'high',
        })
        .onConflictDoUpdate({
          target: campuses.slug,
          set: {
            name: c.name,
            shortName: c.short_name ?? null,
            kind: c.kind,
            website: origin,
            websiteStatus: c.website_status ?? 'active',
            address: c.address ?? null,
            established: c.established ?? null,
            description: c.description ?? null,
            lastVerifiedAt: sql`now()`,
          },
        });
    }

    // ── academic units ──────────────────────────────────────────────────────
    const unitsFile = await readYaml<UnitsFile>('units.yaml');
    const campusRows = await db.select({ id: campuses.id, slug: campuses.slug }).from(campuses);
    const campusIdBySlug = new Map(campusRows.map((r) => [r.slug, r.id]));

    let unitCount = 0;
    for (const [campusSlug, group] of Object.entries(unitsFile)) {
      const campusId = campusIdBySlug.get(campusSlug);
      if (!campusId) throw new Error(`seeds/units.yaml references unknown campus '${campusSlug}'`);

      for (const u of group.units) {
        await db
          .insert(academicUnits)
          .values({
            campusId,
            campusSlug,
            slug: u.slug,
            name: u.name,
            abbreviation: u.abbreviation ?? null,
            // ADR-002: the discriminator is per-campus vocabulary, never assumed.
            unitType: group.unit_type as 'college' | 'department',
            sourceId,
            confidence: 'high',
          })
          .onConflictDoUpdate({
            target: [academicUnits.campusId, academicUnits.slug],
            set: {
              name: u.name,
              abbreviation: u.abbreviation ?? null,
              unitType: group.unit_type as 'college' | 'department',
              lastVerifiedAt: sql`now()`,
            },
          });
        unitCount++;
      }
    }

    // ── canonical programs ──────────────────────────────────────────────────
    const programSeeds = await readYaml<ProgramSeed[]>('programs.yaml');
    for (const p of programSeeds) {
      await db
        .insert(programs)
        .values({
          slug: p.slug,
          name: p.name,
          level: p.level as 'baccalaureate' | 'masters',
          discipline: p.discipline ?? null,
          typicalYears: p.typical_years != null ? String(p.typical_years) : null,
          aliases: p.aliases ?? [],
          sourceId,
          confidence: 'high',
        })
        .onConflictDoUpdate({
          target: programs.slug,
          set: {
            name: p.name,
            level: p.level as 'baccalaureate' | 'masters',
            discipline: p.discipline ?? null,
            typicalYears: p.typical_years != null ? String(p.typical_years) : null,
            aliases: p.aliases ?? [],
            lastVerifiedAt: sql`now()`,
          },
        });
    }

    console.log(
      `Seeded ${campusSeeds.length} campuses, ${unitCount} academic units, ${programSeeds.length} programs.`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
