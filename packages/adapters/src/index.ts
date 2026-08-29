/**
 * `packages/adapters` — per-campus parsers. Pure functions only.
 *
 * Nothing here may fetch, read robots.txt, touch the database, call the clock, or set
 * `confidence` (docs/11 §1). The politeness layer lives in `packages/core` and is
 * structurally unbypassable because an adapter has no way to reach it (ADR-005).
 */
import type { CampusAdapter } from '@tup/core';
import { manilaAdapter } from './manila/index.js';
import { taguigAdapter } from './taguig/index.js';
import { visayasAdapter } from './visayas/index.js';

/**
 * Cavite is absent on purpose. Its host has been unreachable from every verification
 * run since 2026-08-29 (docs/08 §4.1), so there are no fixtures to write a parser
 * against — and writing one against guessed markup is how you ship a parser that has
 * never seen the page it claims to read.
 */
export const ADAPTERS: Record<string, CampusAdapter> = {
  manila: manilaAdapter,
  visayas: visayasAdapter,
  taguig: taguigAdapter,
};

export function adapterFor(campusSlug: string): CampusAdapter {
  const adapter = ADAPTERS[campusSlug];
  if (!adapter) {
    throw new Error(
      `No adapter for campus '${campusSlug}'. Known: ${Object.keys(ADAPTERS).join(', ')}. ` +
        `Adding one is docs/11 §8.`,
    );
  }
  return adapter;
}

// Namespaced: every adapter has a `parseAcademics`-shaped function and flattening them
// into one module surface would make `parseAcademics` mean whichever campus was
// imported last.
export * as manila from './manila/index.js';
export * as visayas from './visayas/index.js';
export * as taguig from './taguig/index.js';
export { manilaAdapter } from './manila/index.js';
export { visayasAdapter } from './visayas/index.js';
export { taguigAdapter } from './taguig/index.js';
export * from './text.js';
export type * from './records.js';
