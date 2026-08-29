-- 007 — chunks and retrieval
-- docs/10-data-dictionary.md §7  [E8]

CREATE TABLE chunks (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  entity_type      entity_type NOT NULL,
  entity_id        uuid NOT NULL,
  entity_ref       text NOT NULL,
  campus_slug      text,
  heading_path     text[],
  content          text NOT NULL,
  context_header   text NOT NULL,
  token_count      int,
  embedding        vector(1536),
  embedding_model  text NOT NULL DEFAULT 'text-embedding-3-small',
  content_hash     text NOT NULL,
  source_url       text NOT NULL,
  last_verified_at timestamptz NOT NULL,
  confidence       confidence_level NOT NULL DEFAULT 'medium',
  UNIQUE (entity_type, entity_id, content_hash)
);

-- The HNSW index is deliberately NOT created here. Building it on an empty table and
-- then inserting is far slower than the reverse; it is created after the first bulk
-- embed in Phase 3.  docs/10 §7
CREATE INDEX chunks_fts_idx      ON chunks USING gin (to_tsvector('simple', content));
CREATE INDEX chunks_entity_idx   ON chunks (entity_type, entity_id);
-- makes ADR-008's filter justification actually cheap
CREATE INDEX chunks_filter_idx   ON chunks (campus_slug, confidence, last_verified_at DESC);
