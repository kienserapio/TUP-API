/**
 * The single source of truth for every shape this API accepts or returns.
 *
 * One Zod definition serves request validation, response typing, the generated
 * OpenAPI document, and the published SDK (ADR-007). Change a shape here and the
 * spec-drift CI gate makes the contract change visible in review.
 */
export * from './common.js';
export * from './campus.js';
export * from './health.js';
export * from './meta.js';
export * from './unit.js';
export * from './program.js';
export * from './ingest.js';
