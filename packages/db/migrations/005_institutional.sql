-- 005 — institutional entities
-- docs/10-data-dictionary.md §5.5–5.9  [E6, E15, E22]

CREATE TABLE offices (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  campus_id    uuid REFERENCES campuses(id),        -- NULL = system-wide
  campus_slug  text REFERENCES campuses(slug),
  slug         text NOT NULL,
  ref          text GENERATED ALWAYS AS (coalesce(campus_slug, 'system') || '/' || slug) STORED,
  name         text NOT NULL,
  abbreviation text,
  category     text,                                -- academic|student_services|admin|support
  description  text,
  location     text,
  emails       text[],
  phones       text[],
  hours        jsonb,
  services     text[],
  website      text,

  source_id        uuid NOT NULL REFERENCES sources(id),
  content_hash     text,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  confidence       confidence_level NOT NULL DEFAULT 'medium',   -- capped 'medium', doc 09 §2
  miss_count       integer NOT NULL DEFAULT 0,

  UNIQUE (campus_id, slug),
  CONSTRAINT offices_ref_key UNIQUE (ref)
);
CREATE INDEX offices_campus_category_idx ON offices (campus_id, category);
CREATE INDEX offices_slug_trgm_idx       ON offices USING gin (slug gin_trgm_ops);

-- PRD C1 applies hardest here: the only table holding names of real people.
-- Officials acting in an official public capacity are in scope; personal contact
-- details are not, even where the source publishes them.
CREATE TABLE officials (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  campus_id   uuid REFERENCES campuses(id),
  campus_slug text REFERENCES campuses(slug),
  office_id   uuid REFERENCES offices(id),
  slug        text NOT NULL,
  ref         text GENERATED ALWAYS AS (coalesce(campus_slug, 'system') || '/' || slug) STORED,
  name        text NOT NULL,
  title       text NOT NULL,
  scope       text NOT NULL DEFAULT 'campus',       -- system|campus|unit
  email       text,                                 -- official address only. PRD C1.
  photo_url   text,
  is_current  boolean NOT NULL DEFAULT true,

  source_id        uuid NOT NULL REFERENCES sources(id),
  content_hash     text,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  confidence       confidence_level NOT NULL DEFAULT 'medium',
  miss_count       integer NOT NULL DEFAULT 0,

  UNIQUE (campus_id, slug),
  CONSTRAINT officials_ref_key UNIQUE (ref)
);
CREATE INDEX officials_campus_current_idx ON officials (campus_id, is_current);
CREATE INDEX officials_office_idx         ON officials (office_id);

CREATE TABLE announcements (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  campus_id    uuid REFERENCES campuses(id),
  campus_slug  text NOT NULL REFERENCES campuses(slug),
  slug         text NOT NULL,
  ref          text GENERATED ALWAYS AS (campus_slug || '/' || slug) STORED,
  source_key   text,                    -- Cavite numeric /news/{id}; stable identity  [E6]
  title        text NOT NULL,
  summary      text,
  body_md      text,
  category     text,                    -- news|advisory|vacancy|bid|admission|achievement
  published_at timestamptz,
  url          text NOT NULL,
  image_url    text,

  source_id        uuid NOT NULL REFERENCES sources(id),
  content_hash     text,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  confidence       confidence_level NOT NULL DEFAULT 'medium',
  miss_count       integer NOT NULL DEFAULT 0,

  UNIQUE (campus_id, slug),            -- was globally UNIQUE(slug) — guaranteed collision  [E6]
  UNIQUE (campus_id, source_key),
  CONSTRAINT announcements_ref_key UNIQUE (ref)
);
CREATE INDEX announcements_published_idx      ON announcements (published_at DESC NULLS LAST);
CREATE INDEX announcements_campus_pub_idx     ON announcements (campus_id, published_at DESC);
CREATE INDEX announcements_campus_cat_pub_idx ON announcements (campus_id, category, published_at DESC);
-- 'simple', not 'english': the corpus is Filipino-English and the queries that matter
-- are exact institutional terms (TUPSTAT, BTVTEd, COPC).  [E22]
CREATE INDEX announcements_fts_idx ON announcements
  USING gin (to_tsvector('simple', title || ' ' || coalesce(summary, '')));

CREATE TABLE documents (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  campus_id      uuid REFERENCES campuses(id),
  campus_slug    text NOT NULL REFERENCES campuses(slug),
  slug           text NOT NULL,
  ref            text GENERATED ALWAYS AS (campus_slug || '/' || slug) STORED,
  title          text NOT NULL,
  doc_type       text NOT NULL,        -- handbook|charter|policy|memo|report|calendar
  edition        text,                 -- "2013 Revised"
  effective_date date,                 -- drives the doc 09 §2.1 override
  format         text,                 -- pdf|html
  url            text,
  storage_key    text,
  page_count     int,
  body_md        text,
  is_superseded  boolean NOT NULL DEFAULT false,

  source_id        uuid NOT NULL REFERENCES sources(id),
  content_hash     text,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  confidence       confidence_level NOT NULL DEFAULT 'medium',
  miss_count       integer NOT NULL DEFAULT 0,

  UNIQUE (campus_id, slug),            -- both campuses' handbooks collide globally  [E6]
  CONSTRAINT documents_ref_key UNIQUE (ref)
);
CREATE INDEX documents_campus_type_idx ON documents (campus_id, doc_type);
CREATE INDEX documents_slug_trgm_idx   ON documents USING gin (slug gin_trgm_ops);

CREATE TABLE scholarships (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  campus_id           uuid REFERENCES campuses(id),
  campus_slug         text NOT NULL REFERENCES campuses(slug),
  slug                text NOT NULL,
  ref                 text GENERATED ALWAYS AS (campus_slug || '/' || slug) STORED,
  name                text NOT NULL,
  category            text,            -- institutional|government|external|cna|private
  grantor             text,
  benefits            text,
  eligibility         text,
  requirements        text[],
  application_process text,
  contact_office_id   uuid REFERENCES offices(id),
  source_dated        text,            -- verbatim date found on the page, e.g. "2006"

  source_id        uuid NOT NULL REFERENCES sources(id),
  content_hash     text,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  confidence       confidence_level NOT NULL DEFAULT 'low',   -- capped 'low' by design, doc 09 §2
  miss_count       integer NOT NULL DEFAULT 0,

  UNIQUE (campus_id, slug),
  CONSTRAINT scholarships_ref_key UNIQUE (ref)
);
CREATE INDEX scholarships_campus_category_idx ON scholarships (campus_id, category);

CREATE TABLE fee_estimates (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  campus_id      uuid NOT NULL REFERENCES campuses(id),
  campus_slug    text NOT NULL REFERENCES campuses(slug),
  program_id     uuid REFERENCES programs(id),
  program_slug   text,
  academic_year  text,                 -- "2026-2027"
  student_type   text,
  ref            text GENERATED ALWAYS AS (
                   campus_slug || '/' || coalesce(program_slug, 'all') || '/' ||
                   coalesce(academic_year, 'unspecified')) STORED,
  currency       char(3) NOT NULL DEFAULT 'PHP',
  line_items     jsonb NOT NULL,
  total_estimate numeric(12,2),
  notes          text,

  source_id        uuid NOT NULL REFERENCES sources(id),
  content_hash     text,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  confidence       confidence_level NOT NULL DEFAULT 'low',   -- capped 'low'
  miss_count       integer NOT NULL DEFAULT 0,

  CONSTRAINT fee_estimates_ref_key UNIQUE (ref)
);

-- New table  [E15]: required by PRD F10 and named as an output of the Cavite
-- /admission and Visayas /admissions/enrollment-procedure routes.
CREATE TABLE procedures (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  campus_id    uuid REFERENCES campuses(id),
  campus_slug  text NOT NULL REFERENCES campuses(slug),
  slug         text NOT NULL,          -- admission | enrollment | shifting | graduation
  ref          text GENERATED ALWAYS AS (campus_slug || '/' || slug) STORED,
  title        text NOT NULL,
  category     text NOT NULL,          -- admission|enrollment|records|graduation|other
  audience     text,                   -- freshman|transferee|returning|graduate
  steps        jsonb NOT NULL,         -- [{n, title, detail, office_ref?, forms?[], fee?}]
  requirements text[],
  office_id    uuid REFERENCES offices(id),
  effective_ay text,

  source_id        uuid NOT NULL REFERENCES sources(id),
  content_hash     text,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  confidence       confidence_level NOT NULL DEFAULT 'medium',
  miss_count       integer NOT NULL DEFAULT 0,

  UNIQUE (campus_id, slug),
  CONSTRAINT procedures_ref_key UNIQUE (ref)
);
CREATE INDEX procedures_campus_category_idx ON procedures (campus_id, category);
