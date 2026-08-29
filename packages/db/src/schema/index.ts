/**
 * Drizzle table definitions mirroring packages/db/migrations/*.sql.
 *
 * Migrations are the source of truth for DDL; these definitions exist so queries are
 * typed and SQL stays transparent (ADR-007). Tables for entities whose adapters have
 * not landed yet — offices, officials, announcements, documents, scholarships,
 * fee_estimates, procedures, quarantine, api_keys, chunks, slug_aliases — exist in
 * SQL (migrations 005–007) and gain Drizzle definitions with their phase.
 */
export * from './enums.js';
export * from './provenance.js';
export * from './sources.js';
export * from './core.js';
