-- 002 — provenance tables
-- docs/10-data-dictionary.md §4  [E11, E15, E18, E3]
-- NOTE: sources.campus_slug references campuses(slug), which does not exist until 004.
-- The FK is added there. Everything else is self-contained.

CREATE TABLE sources (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  url               text UNIQUE NOT NULL,
  origin            text NOT NULL,            -- canonical origin, doc 08 §1  [E5]
  domain            text NOT NULL,
  campus_slug       text,                     -- FK added in 004
  entity_types      entity_type[] NOT NULL,
  method            ingest_method NOT NULL,
  status            source_status NOT NULL DEFAULT 'active',

  robots_allowed    boolean,
  robots_present    boolean,                  -- "allowed" vs "no robots.txt"  [E12]
  robots_checked_at timestamptz,
  content_signal    jsonb,                    -- parsed Content-Signal, doc 08 §5.1  [E11]

  crawl_enabled     boolean NOT NULL DEFAULT true,
  recrawl_interval  interval NOT NULL DEFAULT '7 days',
  http_version      text,                     -- 'auto' | '1.1'; Manila needs 1.1  [E10]

  last_fetch_at     timestamptz,
  last_change_at    timestamptz,
  last_status_code  int,
  probe_note        text,                     -- e.g. 'cPanel suspended page'  [E13]

  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sources_domain_status_idx ON sources (domain, status);
CREATE INDEX sources_campus_slug_idx   ON sources (campus_slug);
CREATE INDEX sources_status_fetch_idx  ON sources (status, last_fetch_at);

CREATE TABLE ingest_runs (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  adapter           text NOT NULL,
  mode              text NOT NULL DEFAULT 'incremental',   -- incremental | full | replay
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  status            text NOT NULL DEFAULT 'running',       -- running|ok|quarantined|failed
  -- sources ACTUALLY PARSED. Reconcile and guard operate only over these.  [E3]
  source_ids        uuid[] NOT NULL DEFAULT '{}',
  sources_fetched   int DEFAULT 0,
  sources_unchanged int DEFAULT 0,                         -- 304 + content-hash match  [E2]
  sources_failed    int DEFAULT 0,
  records_published int DEFAULT 0,
  quarantined       int DEFAULT 0,
  error             text
);
CREATE INDEX ingest_runs_adapter_idx ON ingest_runs (adapter, started_at DESC);
CREATE INDEX ingest_runs_running_idx ON ingest_runs (status) WHERE status = 'running';

-- Immutable. Never deleted. The only way to debug a parser regression months later.
CREATE TABLE snapshots (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  source_id     uuid NOT NULL REFERENCES sources(id),
  run_id        uuid REFERENCES ingest_runs(id),      -- RB-04 needs this  [E15]
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  http_status   int,
  etag          text,
  last_modified text,
  content_hash  text NOT NULL,
  content_type  text,
  byte_size     int,
  -- keyed by content_hash so identical content is stored once  [E18]
  storage_key   text NOT NULL,
  compression   text NOT NULL DEFAULT 'gzip',
  parse_status  text NOT NULL DEFAULT 'pending',
  parse_error   text
);
CREATE INDEX snapshots_source_fetched_idx ON snapshots (source_id, fetched_at DESC);
CREATE INDEX snapshots_content_hash_idx   ON snapshots (content_hash);
CREATE INDEX snapshots_run_idx            ON snapshots (run_id);

-- Checked before every fetch AND before every publish, so a takedown survives
-- re-crawls automatically (RB-06).
CREATE TABLE excluded_sources (
  url_pattern  text PRIMARY KEY,
  reason       text NOT NULL,
  requested_by text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
