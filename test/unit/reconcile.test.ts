/**
 * Reconcile and the removal policy. Rank 3 in docs/14 §1 — "reconcile marks live data
 * removed" is medium likelihood and catastrophic, which is the worst combination in
 * the table.
 */
import { describe, expect, test } from 'vitest';
import { diffFields, reconcile, statusForMissCount } from '@tup/core';

interface Row {
  key: string;
  name: string;
  years: number | null;
  majors: string[];
}

const row = (key: string, name: string, years: number | null = 4, majors: string[] = []): Row => ({
  key,
  name,
  years,
  majors,
});

const FIELDS = ['name', 'years', 'majors'] as const;
const opts = { key: (r: Row) => r.key, fields: FIELDS };

describe('reconcile', () => {
  test('classifies created, updated, unchanged and missing', () => {
    const result = reconcile({
      incoming: [row('bsce', 'Civil Engineering'), row('bsee', 'Electrical Engineering', 5)],
      current: [row('bsee', 'Electrical Engineering', 4), row('bsme', 'Mechanical Engineering')],
      ...opts,
    });
    expect(result.created.map((c) => c.key)).toEqual(['bsce']);
    expect(result.updated.map((u) => u.key)).toEqual(['bsee']);
    expect(result.unchanged).toEqual([]);
    expect(result.missing.map((m) => m.key)).toEqual(['bsme']);
  });

  test('an identical record is unchanged, not an update', () => {
    const result = reconcile({ incoming: [row('bsce', 'X')], current: [row('bsce', 'X')], ...opts });
    expect(result.updated).toEqual([]);
    expect(result.unchanged.map((u) => u.key)).toEqual(['bsce']);
  });

  test('the diff is field-level, not whole-record', () => {
    const result = reconcile({
      incoming: [row('bsce', 'Civil Engineering', 5)],
      current: [row('bsce', 'Civil Engineering', 4)],
      ...opts,
    });
    expect(result.updated[0]?.diff).toEqual({ years: { from: 4, to: 5 } });
  });

  test('array order is significant but array identity is not', () => {
    expect(diffFields(row('a', 'n', 4, ['x']), row('a', 'n', 4, ['x']), FIELDS)).toEqual({});
    expect(diffFields(row('a', 'n', 4, ['x']), row('a', 'n', 4, ['y']), FIELDS)).toEqual({
      majors: { from: ['x'], to: ['y'] },
    });
  });

  test('null and undefined are the same absence', () => {
    expect(diffFields({ a: null }, { a: undefined }, ['a'])).toEqual({});
  });

  test('incoming and current may carry different extra fields', () => {
    // Incoming rows know their source; current rows know their miss_count. Only the
    // shared fields are diffable, and the types enforce that.
    const result = reconcile({
      incoming: [{ ...row('bsce', 'X'), sourceId: 'src-1' }],
      current: [{ ...row('bsce', 'Y'), missCount: 2 }],
      key: (r) => r.key,
      fields: FIELDS,
    });
    expect(result.updated[0]?.current.missCount).toBe(2);
    expect(result.updated[0]?.incoming.sourceId).toBe('src-1');
  });
});

describe('removal policy — never a hard delete', () => {
  test('one miss is a hiccup', () => {
    expect(statusForMissCount(1)).toBe('unknown');
    expect(statusForMissCount(2)).toBe('unknown');
  });

  test('three separate misses is a removal', () => {
    expect(statusForMissCount(3)).toBe('removed');
    expect(statusForMissCount(9)).toBe('removed');
  });

  test('a verified record is active', () => {
    expect(statusForMissCount(0)).toBe('active');
  });
});
