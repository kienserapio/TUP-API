/**
 * Reconcile — match incoming records against what is already published, by natural
 * key, and emit a field-level diff.
 *
 * `current` MUST already be scoped to the sources this run actually parsed. A record
 * from a source that was not looked at is not missing; it is unexamined, and counting
 * it as missing is the defect that marks live data `removed` after three healthy runs
 * — errata E3.
 */
export interface FieldDiff {
  from: unknown;
  to: unknown;
}

export type Diff = Record<string, FieldDiff>;

/**
 * Incoming and current rows are deliberately different types: an incoming row carries
 * the `source_id` and snapshot it came from, a current row carries its `miss_count`.
 * Only the fields present in BOTH can be diffed, which the `fields` type enforces.
 */
export interface ReconcileInput<TIncoming extends object, TCurrent extends object> {
  incoming: readonly TIncoming[];
  current: readonly TCurrent[];
  key: (row: TIncoming | TCurrent) => string;
  /** Compared field by field. Anything not listed cannot produce a change event. */
  fields: readonly (keyof TIncoming & keyof TCurrent & string)[];
}

export interface ReconcileResult<TIncoming extends object, TCurrent extends object> {
  created: { key: string; incoming: TIncoming }[];
  updated: { key: string; incoming: TIncoming; current: TCurrent; diff: Diff }[];
  unchanged: { key: string; current: TCurrent; incoming: TIncoming }[];
  /** Present in the (scoped) DB, absent from this parse. Takes miss_count += 1. */
  missing: { key: string; current: TCurrent }[];
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  // NULL and undefined are the same absence as far as a published payload is concerned.
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  return false;
}

export function diffFields<TIncoming extends object, TCurrent extends object>(
  current: TCurrent,
  incoming: TIncoming,
  fields: readonly (keyof TIncoming & keyof TCurrent & string)[],
): Diff {
  const diff: Diff = {};
  for (const field of fields) {
    const before = (current as Record<string, unknown>)[field];
    const after = (incoming as Record<string, unknown>)[field];
    if (!sameValue(before, after)) diff[field] = { from: before ?? null, to: after ?? null };
  }
  return diff;
}

export function reconcile<TIncoming extends object, TCurrent extends object>(
  input: ReconcileInput<TIncoming, TCurrent>,
): ReconcileResult<TIncoming, TCurrent> {
  const currentByKey = new Map(input.current.map((row) => [input.key(row), row]));
  const result: ReconcileResult<TIncoming, TCurrent> = {
    created: [],
    updated: [],
    unchanged: [],
    missing: [],
  };
  const seen = new Set<string>();

  for (const incoming of input.incoming) {
    const key = input.key(incoming);
    seen.add(key);
    const current = currentByKey.get(key);
    if (!current) {
      result.created.push({ key, incoming });
      continue;
    }
    const diff = diffFields(current, incoming, input.fields);
    if (Object.keys(diff).length === 0) result.unchanged.push({ key, current, incoming });
    else result.updated.push({ key, incoming, current, diff });
  }

  for (const [key, current] of currentByKey) {
    if (!seen.has(key)) result.missing.push({ key, current });
  }

  return result;
}

export type RemovalStatus = 'active' | 'unknown' | 'removed';

/**
 * docs/03 §3.5: one miss is a hiccup, three separate misses is a removal. Never a
 * hard delete — a page that 404s for a week is not the same as a degree that closed.
 */
export function statusForMissCount(missCount: number): RemovalStatus {
  if (missCount >= 3) return 'removed';
  if (missCount >= 1) return 'unknown';
  return 'active';
}
