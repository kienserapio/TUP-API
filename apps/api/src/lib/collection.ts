/**
 * Collection envelope assembly. One helper, so the envelope cannot be built by hand in
 * one handler and by a helper in the rest — which is the exact drift docs/14 §5 says
 * contract tests exist to catch.
 */
import type { ConfidenceLevel, Freshness } from '@tup/schemas';
import { links } from './pagination.js';

export interface ProvenanceCarrier {
  provenance: { last_verified_at: string; staleness_days: number; confidence: ConfidenceLevel };
}

const RANK: Record<ConfidenceLevel, number> = { low: 0, medium: 1, high: 2 };

/**
 * docs/09 §4. Reports what the caller ACTUALLY received, not what was filtered for:
 * `min_confidence` here is the worst row in this page.
 */
export function freshnessOf(items: readonly ProvenanceCarrier[]): Freshness {
  const counts = { high: 0, medium: 0, low: 0 };
  let oldest: string | null = null;
  let maxStaleness = 0;
  let min: ConfidenceLevel | null = null;

  for (const item of items) {
    const { last_verified_at, staleness_days, confidence } = item.provenance;
    counts[confidence]++;
    if (staleness_days > maxStaleness) maxStaleness = staleness_days;
    if (oldest === null || last_verified_at < oldest) oldest = last_verified_at;
    if (min === null || RANK[confidence] < RANK[min]) min = confidence;
  }

  return {
    oldest_verified_at: oldest,
    max_staleness_days: maxStaleness,
    min_confidence: min,
    counts_by_confidence: counts,
  };
}

export function collection<T extends ProvenanceCarrier>(options: {
  items: T[];
  hasMore: boolean;
  nextKey: string | null;
  requestUrl: string;
  filters: Record<string, unknown>;
  now?: Date;
}) {
  const { items, hasMore, nextKey, requestUrl, filters } = options;
  return {
    data: items,
    meta: {
      count: items.length,
      has_more: hasMore,
      generated_at: (options.now ?? new Date()).toISOString(),
      freshness: freshnessOf(items),
    },
    links: links(requestUrl, filters, nextKey),
  };
}

/**
 * The ETag covers the resource state, not the moment of assembly (docs/13 §10):
 * `generated_at` moves on every request and would make every response a cache miss,
 * defeating the primary defence for a project on free-tier infrastructure.
 */
export function cacheablePart(body: {
  data: unknown;
  meta?: { count: number; has_more: boolean; freshness: unknown };
  links?: { self: string; next: string | null };
}): unknown {
  if (!body.meta) return { data: body.data };
  return {
    data: body.data,
    meta: { count: body.meta.count, has_more: body.meta.has_more, freshness: body.meta.freshness },
    links: body.links,
  };
}
