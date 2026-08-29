import type { Provenance } from '@tup/schemas';

interface ProvenanceRow {
  sourceUrl: string;
  method: string;
  firstSeenAt: Date;
  lastVerifiedAt: Date;
  confidence: 'low' | 'medium' | 'high';
}

const MS_PER_DAY = 86_400_000;

/**
 * ADR-004. Built for every canonical row, in the default payload.
 * `staleness_days` is derived server-side so consumers cannot get the arithmetic
 * wrong, and so an agent can be told a single threshold to refuse on.
 */
export function toProvenance(row: ProvenanceRow, now: Date = new Date()): Provenance {
  const stalenessDays = Math.floor((now.getTime() - row.lastVerifiedAt.getTime()) / MS_PER_DAY);
  return {
    source_url: row.sourceUrl,
    first_seen_at: row.firstSeenAt.toISOString(),
    last_verified_at: row.lastVerifiedAt.toISOString(),
    staleness_days: Math.max(0, stalenessDays),
    confidence: row.confidence,
    method: row.method,
  };
}
