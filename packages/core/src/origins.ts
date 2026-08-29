/**
 * The domain allowlist and per-origin transport overrides.
 *
 * docs/08-source-landscape.md §1 is the ONLY place a hostname is stated; this file is
 * its executable form. Two of the four campuses do not serve on the host you would
 * guess, and a dead `source_url` in a published citation defeats the entire provenance
 * feature — errata E5.
 */

export const CANONICAL_ORIGIN = {
  manila: 'https://tup.edu.ph',
  cavite: 'https://www.tupcavite.edu.ph',
  visayas: 'https://tupvisayas.edu.ph',
  taguig: 'https://tupt.edu.ph',
} as const;

export type CampusSlug = keyof typeof CANONICAL_ORIGIN;

/**
 * Four hosts. Nothing else is fetchable, ever — ADR-005 makes the politeness layer
 * structurally unbypassable, and an allowlist is the only form of that which survives
 * an adapter author having a good idea at 2am.
 */
export const ALLOWED_HOSTS: readonly string[] = Object.values(CANONICAL_ORIGIN).map(
  (origin) => new URL(origin).host,
);

/**
 * docs/08 §2.2: Manila's HTTP/2 fails intermittently behind the Sucuri edge. An
 * intermittent transport fault is worse than a consistent one — it gets misattributed
 * to the parser. Pin the origin and remove the variable; keep the retries anyway.
 */
export const ORIGIN_TRANSPORT: Record<string, { allowH2: boolean }> = {
  'tup.edu.ph': { allowH2: false },
};

export class DomainNotAllowedError extends Error {
  constructor(readonly url: string) {
    super(
      `Refusing to fetch ${url}: host is not one of the four TUP origins in docs/08 §1. ` +
        `The allowlist is the politeness layer (ADR-005); widen it in origins.ts deliberately or not at all.`,
    );
    this.name = 'DomainNotAllowedError';
  }
}

export function hostOf(url: string): string {
  return new URL(url).host;
}

export function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    return ALLOWED_HOSTS.includes(parsed.host);
  } catch {
    return false;
  }
}

export function assertAllowedUrl(url: string): void {
  if (!isAllowedUrl(url)) throw new DomainNotAllowedError(url);
}

export function campusOf(url: string): CampusSlug | null {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return null;
    }
  })();
  if (!host) return null;
  for (const [slug, origin] of Object.entries(CANONICAL_ORIGIN)) {
    if (new URL(origin).host === host) return slug as CampusSlug;
  }
  return null;
}

export function transportFor(url: string): { allowH2: boolean } {
  return ORIGIN_TRANSPORT[hostOf(url)] ?? { allowH2: true };
}
