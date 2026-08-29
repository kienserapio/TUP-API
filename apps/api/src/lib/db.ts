import { createDb } from '@tup/db';

/**
 * One connection pool per process.
 *
 * The API runs as a long-lived process on a session-mode pooler, so prepared
 * statements are fine here. Ingestion runs on ephemeral CI runners against the
 * transaction pooler and must set `pooled: true`. Errata E19, docs/15 §3.1.
 */
const { sql, db } = createDb({ pooled: false });

export { sql, db };
