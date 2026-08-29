/**
 * `packages/core` — the fetcher, the pipeline stages, the guard, and the confidence
 * rules. Everything that decides *what happens to* a page, and nothing that knows how
 * to read one.
 *
 * Dependency direction is one-way: adapters → core → schemas → db (docs/15 §7).
 * `packages/adapters` may import from here; it must never import `./http.js`.
 */
export * from './contracts.js';
export * from './origins.js';
export * from './hash.js';
export * from './robots.js';
export * from './fixtures.js';
export * from './http.js';
export * from './storage.js';
export * from './fetcher.js';
export * from './confidence.js';
export * from './guard.js';
export * from './reconcile.js';
export * from './registry.js';
export * from './pipeline.js';
