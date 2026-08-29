/**
 * Canonical program registry matching. ADR-003, docs/03 §4.5.
 *
 * Chain: exact alias → normalized alias → trigram ≥ 0.85 → **unmatched**.
 *
 * The last step is the important one. Never auto-create a canonical program from a
 * fuzzy match: that is how a registry ends up with three near-duplicate "Civil
 * Engineering" degrees that are painful to merge later. An unmatched offering is
 * written with `program_id = NULL` and surfaced by `pnpm ingest:unmatched` for a
 * human to resolve into seeds/programs.yaml.
 *
 * The exact and normalized steps live here as pure functions so they are unit
 * testable. The trigram step is a Postgres `similarity()` query — pg_trgm is the
 * authority on that number, and reimplementing it in TypeScript would drift.
 */
export interface RegistryEntry {
  slug: string;
  name: string;
  aliases: readonly string[];
}

export type MatchMethod = 'exact' | 'normalized' | 'trigram' | 'unmatched';

export interface MatchResult {
  slug: string | null;
  method: MatchMethod;
  /** Only set for a trigram match. */
  score?: number;
  /** The registry string that matched, kept for the ingest log. */
  matchedOn?: string;
}

export const TRIGRAM_THRESHOLD = 0.85;

/** Lowercase, strip punctuation, collapse whitespace. Nothing cleverer — a stemmer
 *  would happily fold BSCE and BSCpE together. */
export function normalizeProgramName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * URL-safe slug for an offering with no canonical match, so it stays addressable.
 * Not truncated: Manila lists degrees that differ only after ~90 characters, and a
 * length cap merges them into one row. docs/10 §5.4.
 */
export function slugifyProgramName(name: string): string {
  return normalizeProgramName(name).replace(/\s+/g, '-');
}

export function candidateStrings(entry: RegistryEntry): string[] {
  return [entry.name, ...entry.aliases, entry.slug];
}

/**
 * Steps 1 and 2 of the chain. Returns `unmatched` when neither hits — the caller runs
 * the trigram query and then, if that also misses, writes `program_id = NULL`.
 */
export function matchProgramName(
  sourceName: string,
  registry: readonly RegistryEntry[],
): MatchResult {
  const trimmed = sourceName.trim();
  for (const entry of registry) {
    for (const candidate of candidateStrings(entry)) {
      if (candidate === trimmed) return { slug: entry.slug, method: 'exact', matchedOn: candidate };
    }
  }

  const normalized = normalizeProgramName(trimmed);
  if (normalized) {
    for (const entry of registry) {
      for (const candidate of candidateStrings(entry)) {
        if (normalizeProgramName(candidate) === normalized) {
          return { slug: entry.slug, method: 'normalized', matchedOn: candidate };
        }
      }
    }
  }

  return { slug: null, method: 'unmatched' };
}
