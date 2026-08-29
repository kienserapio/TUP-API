/**
 * Confidence is a pure function of (method, entity type, staleness, edition, source
 * status). docs/09-freshness-and-confidence.md is normative; this file is that
 * document compiled.
 *
 * ADR-004 calls encoding this judgment server-side "the value-add", and errata E9
 * recorded that it had been asserted in five documents and defined in none. No
 * adapter may set `confidence` — an adapter that self-reports will always report high.
 */
import type { Confidence, EntityType, IngestMethod } from './contracts.js';

export const CONFIDENCE_ORDER: readonly Confidence[] = ['low', 'medium', 'high'];

export function rank(level: Confidence): number {
  return CONFIDENCE_ORDER.indexOf(level);
}

export function lowerOf(a: Confidence, b: Confidence): Confidence {
  return rank(a) <= rank(b) ? a : b;
}

/** docs/09 §2. Hand curation is a weaker *currency* claim than a crawl, not a weaker
 *  provenance one — a seed row states what a human knew, which ages. */
const BASE_BY_METHOD: Record<IngestMethod, Confidence> = {
  crawl: 'high',
  manual: 'high',
  partner_feed: 'high',
  seed: 'medium',
};

/**
 * A cap is a ceiling, not an assignment. A freshly-crawled scholarship is `low` and
 * stays `low`: fetching the page today tells you the page has not changed, and
 * nothing at all about whether ₱-figures from 2006 are still the grant amounts.
 */
const CAP_BY_ENTITY: Partial<Record<EntityType, Confidence>> = {
  office: 'medium',
  official: 'medium',
  document: 'medium',
  scholarship: 'low',
  fee_estimate: 'low',
  procedure: 'medium',
};

interface DecayThreshold {
  /** `staleness_days` at which `high` becomes `medium`. */
  toMedium: number | null;
  /** `staleness_days` at which `medium` becomes `low`. */
  toLow: number | null;
}

/** docs/09 §3, read as `staleness_days` thresholds. */
export const DECAY_THRESHOLDS: Record<EntityType, DecayThreshold> = {
  announcement: { toMedium: 7, toLow: 30 },
  official: { toMedium: 30, toLow: 120 },
  office: { toMedium: 60, toLow: 180 },
  procedure: { toMedium: 60, toLow: 180 },
  program_offering: { toMedium: 90, toLow: 270 },
  academic_unit: { toMedium: 120, toLow: 365 },
  program: { toMedium: 180, toLow: 365 },
  document: { toMedium: 180, toLow: 365 },
  scholarship: { toMedium: null, toLow: null },
  fee_estimate: { toMedium: null, toLow: null },
  // A campus existing is not a fact that decays.
  campus: { toMedium: 365, toLow: null },
};

/** docs/09 §3: recrawl cadence per entity type, as a Postgres interval literal. */
export const RECRAWL_INTERVAL: Record<EntityType, string> = {
  announcement: '6 hours',
  official: '7 days',
  office: '7 days',
  procedure: '7 days',
  program_offering: '7 days',
  academic_unit: '7 days',
  program: '365 days',
  document: '30 days',
  scholarship: '30 days',
  fee_estimate: '30 days',
  campus: '30 days',
};

export interface ConfidenceInput {
  method: IngestMethod;
  entityType: EntityType;
  stalenessDays: number;
  /** `documents.effective_date`. docs/09 §2.1 overrides everything when it is old. */
  effectiveDate?: Date | null;
  isSuperseded?: boolean;
  /** docs/09 §3.1 — a source we cannot reach is a source we cannot verify. */
  sourceStatus?: 'active' | 'unavailable' | 'suspended' | 'blocked' | 'retired';
  daysSinceSourceUnreachable?: number;
  now?: Date;
}

const THREE_YEARS_MS = 3 * 365 * 24 * 60 * 60 * 1000;

/**
 * Idempotent and reversible by construction: it is a recompute, never a decrement.
 * A job that only ever downgrades drifts out of agreement with reality after any
 * backfill — docs/09 §3.
 */
export function computeConfidence(input: ConfidenceInput): Confidence {
  const { method, entityType, stalenessDays } = input;
  let level: Confidence = BASE_BY_METHOD[method];

  const cap = CAP_BY_ENTITY[entityType];
  if (cap) level = lowerOf(level, cap);

  const thresholds = DECAY_THRESHOLDS[entityType];
  if (thresholds.toLow !== null && stalenessDays >= thresholds.toLow) {
    level = 'low';
  } else if (thresholds.toMedium !== null && stalenessDays >= thresholds.toMedium) {
    level = lowerOf(level, 'medium');
  }

  // docs/09 §2.1: freshness of retrieval must never imply currency of content.
  if (entityType === 'document') {
    const now = input.now ?? new Date();
    if (input.isSuperseded) return 'low';
    if (input.effectiveDate && now.getTime() - input.effectiveDate.getTime() > THREE_YEARS_MS) {
      return 'low';
    }
  }

  if (input.sourceStatus === 'unavailable' || input.sourceStatus === 'blocked') {
    level = lowerOf(level, 'medium');
    if ((input.daysSinceSourceUnreachable ?? 0) >= 30) level = 'low';
  }

  return level;
}

export function stalenessDays(lastVerifiedAt: Date, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - lastVerifiedAt.getTime()) / 86_400_000));
}
