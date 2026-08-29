/**
 * docs/09-freshness-and-confidence.md, compiled into assertions.
 *
 * ADR-004 calls encoding this judgment server-side "the value-add"; errata E9 recorded
 * that it had been asserted in five documents and defined in none. These tests are
 * what stop that happening again.
 */
import { describe, expect, test } from 'vitest';
import { computeConfidence, DECAY_THRESHOLDS, stalenessDays } from '@tup/core';

describe('initial confidence by method (docs/09 §2)', () => {
  test('a crawl, a manual collection and a partner feed all start high', () => {
    for (const method of ['crawl', 'manual', 'partner_feed'] as const) {
      expect(computeConfidence({ method, entityType: 'program_offering', stalenessDays: 0 })).toBe(
        'high',
      );
    }
  });

  test('a seeded row starts medium — it states what a human knew, which ages', () => {
    expect(
      computeConfidence({ method: 'seed', entityType: 'academic_unit', stalenessDays: 0 }),
    ).toBe('medium');
  });
});

describe('entity-type caps are ceilings, not assignments', () => {
  test('a freshly-crawled scholarship is low, and that is deliberate', () => {
    // Manila's scholarship page cites 2006 figures. Fetching it this morning tells you
    // the page has not changed; it says nothing about whether the amounts still hold.
    expect(computeConfidence({ method: 'crawl', entityType: 'scholarship', stalenessDays: 0 })).toBe(
      'low',
    );
  });

  test('fee estimates are capped low for the same reason', () => {
    expect(
      computeConfidence({ method: 'crawl', entityType: 'fee_estimate', stalenessDays: 0 }),
    ).toBe('low');
  });

  test('offices, officials, documents and procedures cap at medium', () => {
    for (const entityType of ['office', 'official', 'document', 'procedure'] as const) {
      expect(computeConfidence({ method: 'crawl', entityType, stalenessDays: 0 })).toBe('medium');
    }
  });

  test('programs and offerings are not capped', () => {
    expect(computeConfidence({ method: 'crawl', entityType: 'program', stalenessDays: 0 })).toBe(
      'high',
    );
  });
});

describe('decay (docs/09 §3)', () => {
  test('an announcement goes medium at 7 days and low at 30', () => {
    const at = (d: number) =>
      computeConfidence({ method: 'crawl', entityType: 'announcement', stalenessDays: d });
    expect(at(6)).toBe('high');
    expect(at(7)).toBe('medium');
    expect(at(29)).toBe('medium');
    expect(at(30)).toBe('low');
  });

  test('a program offering holds high for 90 days', () => {
    const at = (d: number) =>
      computeConfidence({ method: 'crawl', entityType: 'program_offering', stalenessDays: d });
    expect(at(89)).toBe('high');
    expect(at(90)).toBe('medium');
    expect(at(270)).toBe('low');
  });

  test('a campus never reaches low — existing is not a fact that decays', () => {
    expect(computeConfidence({ method: 'seed', entityType: 'campus', stalenessDays: 100_000 })).toBe(
      'medium',
    );
    expect(DECAY_THRESHOLDS.campus.toLow).toBeNull();
  });

  test('is idempotent — a pure function of its inputs', () => {
    const input = { method: 'crawl' as const, entityType: 'office' as const, stalenessDays: 70 };
    expect(computeConfidence(input)).toBe(computeConfidence(input));
  });

  test('is reversible — verification restores, because it recomputes', () => {
    const stale = computeConfidence({
      method: 'crawl',
      entityType: 'program_offering',
      stalenessDays: 300,
    });
    const verified = computeConfidence({
      method: 'crawl',
      entityType: 'program_offering',
      stalenessDays: 0,
    });
    expect(stale).toBe('low');
    expect(verified).toBe('high');
  });
});

describe('document editions override everything (docs/09 §2.1)', () => {
  const now = new Date('2026-08-29T00:00:00Z');

  test('the 2013 handbook is low however recently it was fetched', () => {
    expect(
      computeConfidence({
        method: 'crawl',
        entityType: 'document',
        stalenessDays: 0,
        effectiveDate: new Date('2013-06-01T00:00:00Z'),
        now,
      }),
    ).toBe('low');
  });

  test('a superseded document is low regardless of its date', () => {
    expect(
      computeConfidence({
        method: 'crawl',
        entityType: 'document',
        stalenessDays: 0,
        effectiveDate: new Date('2026-01-01T00:00:00Z'),
        isSuperseded: true,
        now,
      }),
    ).toBe('low');
  });

  test('a current edition keeps the entity cap', () => {
    expect(
      computeConfidence({
        method: 'crawl',
        entityType: 'document',
        stalenessDays: 0,
        effectiveDate: new Date('2025-06-01T00:00:00Z'),
        now,
      }),
    ).toBe('medium');
  });
});

describe('source-level override (docs/09 §3.1)', () => {
  test('an unreachable source caps its entities at medium immediately', () => {
    expect(
      computeConfidence({
        method: 'crawl',
        entityType: 'program_offering',
        stalenessDays: 0,
        sourceStatus: 'blocked',
      }),
    ).toBe('medium');
  });

  test('and drops them to low after thirty days', () => {
    expect(
      computeConfidence({
        method: 'crawl',
        entityType: 'program_offering',
        stalenessDays: 10,
        sourceStatus: 'unavailable',
        daysSinceSourceUnreachable: 30,
      }),
    ).toBe('low');
  });
});

describe('stalenessDays', () => {
  test('is whole days, floored', () => {
    expect(
      stalenessDays(new Date('2026-08-01T00:00:00Z'), new Date('2026-08-11T12:00:00Z')),
    ).toBe(10);
  });

  test('never goes negative when clocks disagree', () => {
    expect(
      stalenessDays(new Date('2026-08-20T00:00:00Z'), new Date('2026-08-19T00:00:00Z')),
    ).toBe(0);
  });
});
