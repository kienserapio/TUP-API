/**
 * The guard's decision table. Every branch in docs/14 §4.1 has a case here, and the
 * expectations-scoping cases guard errata E3 — the defect that would quarantine every
 * healthy incremental run and then mark live data removed.
 */
import { describe, expect, test } from 'vitest';
import { guard } from '@tup/core';

const rows = (n: number): unknown[] => Array.from({ length: n }, (_, i) => ({ i }));
const INCREMENTAL = { fullRun: false };
const FULL = { fullRun: true };

describe('publishes when nothing is anomalous', () => {
  test('a steady count', () => {
    expect(guard('program_offering', rows(89), 89, undefined, FULL).action).toBe('publish');
  });

  test('a first run against an empty table', () => {
    expect(guard('program_offering', rows(89), 0, undefined, FULL).action).toBe('publish');
  });

  test('an empty parse against an empty table is not an anomaly', () => {
    expect(guard('academic_unit', [], 0, undefined, FULL).action).toBe('publish');
  });

  test('small collections may swing freely — 3 → 1 is noise, not a signal', () => {
    expect(guard('academic_unit', rows(1), 3, undefined, FULL).action).toBe('publish');
  });
});

describe('quarantines the four anomalies', () => {
  test('zero records where data existed', () => {
    const result = guard('program_offering', [], 89, undefined, FULL);
    expect(result.action).toBe('quarantine');
    expect(result.reason).toContain('zero');
  });

  test('a drop of more than 30%', () => {
    const result = guard('program_offering', rows(50), 89, undefined, FULL);
    expect(result.action).toBe('quarantine');
    expect(result.reason).toContain('89→50');
  });

  test('a doubling', () => {
    const result = guard('program_offering', rows(200), 89, undefined, FULL);
    expect(result.action).toBe('quarantine');
    expect(result.reason).toContain('doubled');
  });

  test('a count outside the declared expectations, on a full run', () => {
    const result = guard('program_offering', rows(9), 0, { min: 30, max: 120 }, FULL);
    expect(result.action).toBe('quarantine');
    expect(result.reason).toContain('[30,120]');
  });
});

describe('expectations are full-run ranges [E3]', () => {
  test('an incremental run does not apply them', () => {
    // The scenario from errata E3: one changed source out of ten yields 3 records
    // against a full-run expectation of 30–120. Applying the range here would
    // quarantine every healthy incremental run from the second one onward.
    const result = guard('program_offering', rows(3), 3, { min: 30, max: 120 }, INCREMENTAL);
    expect(result.action).toBe('publish');
  });

  test('and records WHY it skipped, rather than skipping silently', () => {
    const result = guard('program_offering', rows(3), 3, { min: 30, max: 120 }, INCREMENTAL);
    expect(result.skipped).toContain('incremental run');
  });

  test('the count checks still apply on an incremental run', () => {
    // Scoping fixes the false positive; it must not disable the true positive.
    const result = guard('program_offering', [], 25, { min: 30, max: 120 }, INCREMENTAL);
    expect(result.action).toBe('quarantine');
  });
});

describe('boundaries', () => {
  test('exactly 30% down is not a drop', () => {
    expect(guard('program_offering', rows(70), 100, undefined, FULL).action).toBe('publish');
    expect(guard('program_offering', rows(69), 100, undefined, FULL).action).toBe('quarantine');
  });

  test('exactly double is not a doubling', () => {
    expect(guard('program_offering', rows(200), 100, undefined, FULL).action).toBe('publish');
    expect(guard('program_offering', rows(201), 100, undefined, FULL).action).toBe('quarantine');
  });

  test('the expectation range is inclusive at both ends', () => {
    expect(guard('academic_unit', rows(5), 5, { min: 5, max: 9 }, FULL).action).toBe('publish');
    expect(guard('academic_unit', rows(9), 9, { min: 5, max: 9 }, FULL).action).toBe('publish');
    expect(guard('academic_unit', rows(4), 4, { min: 5, max: 9 }, FULL).action).toBe('quarantine');
  });
});
