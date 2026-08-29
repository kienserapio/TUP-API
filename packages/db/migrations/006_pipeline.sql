-- 006 — pipeline tables
-- docs/10-data-dictionary.md §6.3–6.5  [E15, E25]

CREATE TABLE change_events (
  id          bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  run_id      uuid REFERENCES ingest_runs(id),
  entity_type entity_type NOT NULL,
  entity_ref  text NOT NULL,
  operation   text NOT NULL,          -- created|updated|removed|restored
  diff        jsonb,                  -- {field: {from, to}}
  snapshot_id uuid REFERENCES snapshots(id)
);
-- Retention: 12 months. A monthly job deletes older rows; ?since= older than the
-- window returns 410 Gone rather than a silently truncated feed.  [E25]
CREATE INDEX change_events_cursor_idx ON change_events (occurred_at, id);
CREATE INDEX change_events_type_idx   ON change_events (entity_type, occurred_at DESC);
CREATE INDEX change_events_ref_idx    ON change_events (entity_ref, occurred_at DESC);
CREATE INDEX change_events_run_idx    ON change_events (run_id);

-- ADR-006: quarantine preserves existing data. incoming_count and current_count are
-- stored so RB-01 can be diagnosed without re-deriving them.
CREATE TABLE quarantine (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  run_id         uuid REFERENCES ingest_runs(id),
  adapter        text NOT NULL,
  entity_type    entity_type NOT NULL,
  reason         text NOT NULL,
  incoming_count int,
  current_count  int,
  payload        jsonb NOT NULL,
  snapshot_id    uuid REFERENCES snapshots(id),
  issue_url      text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  resolution     text
);
CREATE INDEX quarantine_unresolved_idx ON quarantine (resolved_at) WHERE resolved_at IS NULL;

-- PRD C5: slugs are permanent. A rename writes an alias and serves a 301.
CREATE TABLE slug_aliases (
  entity_type entity_type NOT NULL,
  old_ref     text NOT NULL,
  new_ref     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, old_ref)
);

-- Only the SHA-256 hash is stored. contact_email is the entire point of keys:
-- "so we can contact you if something breaks, not to gate access".
CREATE TABLE api_keys (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  key_hash       text UNIQUE NOT NULL,   -- sha256 of the key. NEVER store the key.
  key_prefix     text NOT NULL,          -- first 8 chars, for support lookup
  label          text NOT NULL,
  contact_email  text NOT NULL,
  project_url    text,
  tier           text NOT NULL DEFAULT 'free',
  status         text NOT NULL DEFAULT 'active',   -- active|revoked
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  revoked_at     timestamptz,
  revoked_reason text
);
CREATE INDEX api_keys_active_idx ON api_keys (key_hash) WHERE status = 'active';
