import { describe, expect, test } from 'vitest';
import { toProvenance } from '../../apps/api/src/lib/provenance.js';
import { etagFor } from '../../apps/api/src/lib/etag.js';

const base = {
  sourceUrl: 'https://tup.edu.ph/programs',
  method: 'crawl',
  firstSeenAt: new Date('2026-01-01T00:00:00Z'),
  confidence: 'medium' as const,
};

describe('toProvenance', () => {
  test('derives whole days of staleness server-side', () => {
    const p = toProvenance(
      { ...base, lastVerifiedAt: new Date('2026-08-01T00:00:00Z') },
      new Date('2026-08-11T12:00:00Z'),
    );
    expect(p.staleness_days).toBe(10);
  });

  test('never reports negative staleness when clocks disagree', () => {
    const p = toProvenance(
      { ...base, lastVerifiedAt: new Date('2026-08-20T00:00:00Z') },
      new Date('2026-08-19T00:00:00Z'),
    );
    expect(p.staleness_days).toBe(0);
  });

  test('emits RFC 3339 UTC timestamps', () => {
    const p = toProvenance({ ...base, lastVerifiedAt: new Date('2026-08-20T02:14:00Z') });
    expect(p.last_verified_at).toBe('2026-08-20T02:14:00.000Z');
    expect(p.first_seen_at.endsWith('Z')).toBe(true);
  });

  test('a nineteen-year-old page reports it honestly', () => {
    const p = toProvenance(
      { ...base, lastVerifiedAt: new Date('2026-08-20T00:00:00Z'), confidence: 'low' },
      new Date('2026-08-29T00:00:00Z'),
    );
    expect(p.confidence).toBe('low');
    expect(p.staleness_days).toBe(9);
  });
});

describe('etagFor', () => {
  test('is stable for identical bodies', () => {
    expect(etagFor({ a: 1 })).toBe(etagFor({ a: 1 }));
  });

  test('changes when the body changes', () => {
    expect(etagFor({ a: 1 })).not.toBe(etagFor({ a: 2 }));
  });

  test('is a quoted strong validator', () => {
    expect(etagFor({ a: 1 })).toMatch(/^"[A-Za-z0-9_-]+"$/);
  });
});
