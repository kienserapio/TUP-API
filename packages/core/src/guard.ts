/**
 * The anomaly guard. ADR-006: when a parse looks wrong, preserve what is already
 * published and stop. Stale data with an honest `last_verified_at` is a degradation;
 * silently emptied tables are data loss.
 *
 * The one change from docs/03 §3.5 is scoping, and it is not cosmetic. `currentCount`
 * must count only rows whose `source_id` was actually parsed in this run, and
 * `expectations` are full-run ranges that may only be applied on a full run.
 * Without both, the *second* incremental run of every healthy adapter quarantines —
 * errata E3, and docs/14 §4.1 calls the scoping test the most important integration
 * test in the repo.
 */
import type { EntityType, Expectation } from './contracts.js';

export interface GuardResult {
  action: 'publish' | 'quarantine';
  reason?: string;
  /** Set when a full-run expectation check was deliberately skipped. Recorded, not silent. */
  skipped?: string;
}

export interface GuardOptions {
  /** True when every source producing this entity type was parsed in this run. */
  fullRun: boolean;
}

export function guard(
  entityType: EntityType,
  incoming: readonly unknown[],
  currentCount: number,
  expectations?: Expectation,
  options: GuardOptions = { fullRun: false },
): GuardResult {
  const n = incoming.length;
  let skipped: string | undefined;

  if (expectations) {
    if (options.fullRun) {
      if (n < expectations.min || n > expectations.max) {
        return {
          action: 'quarantine',
          reason: `count ${n} outside expected [${expectations.min},${expectations.max}] for ${entityType}`,
        };
      }
    } else {
      skipped =
        `expectations [${expectations.min},${expectations.max}] not applied: incremental run, ` +
        `counts are legitimately partial (errata E3)`;
    }
  }

  if (currentCount > 0 && n === 0) {
    return {
      action: 'quarantine',
      reason: `parser returned zero ${entityType} records where ${currentCount} existed`,
      ...(skipped ? { skipped } : {}),
    };
  }
  if (currentCount >= 10 && n < currentCount * 0.7) {
    return {
      action: 'quarantine',
      reason: `${entityType} count dropped ${currentCount}→${n} (>30%)`,
      ...(skipped ? { skipped } : {}),
    };
  }
  if (currentCount >= 10 && n > currentCount * 2) {
    return {
      action: 'quarantine',
      reason: `${entityType} count doubled ${currentCount}→${n}`,
      ...(skipped ? { skipped } : {}),
    };
  }

  return { action: 'publish', ...(skipped ? { skipped } : {}) };
}
