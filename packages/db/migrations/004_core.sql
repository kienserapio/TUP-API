-- 004 — core canonical entities
-- docs/10-data-dictionary.md §5.1–5.4  [E13, E16, E21]

CREATE TABLE campuses (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  slug           text UNIQUE NOT NULL,          -- manila | cavite | visayas | taguig
  ref            text GENERATED ALWAYS AS (slug) STORED,
  name           text NOT NULL,
  short_name     text,
  kind           text NOT NULL,                 -- main | satellite | extension
  parent_slug    text REFERENCES campuses(slug),
  address        jsonb,                         -- {street,city,province,region,postal}
  geo            jsonb,                         -- {lat,lng}
  website        text,                          -- canonical origin, doc 08 §1
  website_status source_status NOT NULL DEFAULT 'active',
  emails         text[],
  phones         text[],
  established    int,
  description    text,
  facebook_url   text,

  source_id        uuid NOT NULL REFERENCES sources(id),
  content_hash     text,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  confidence       confidence_level NOT NULL DEFAULT 'high',
  miss_count       integer NOT NULL DEFAULT 0,

  CONSTRAINT campuses_ref_key UNIQUE (ref)
);

-- Deferred from 002: sources.campus_slug could not reference campuses before it existed.
ALTER TABLE sources
  ADD CONSTRAINT sources_campus_slug_fkey FOREIGN KEY (campus_slug) REFERENCES campuses(slug);

-- ADR-002: one table with a type discriminator, not per-campus tables.
CREATE TABLE academic_units (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  campus_id    uuid NOT NULL REFERENCES campuses(id),
  campus_slug  text NOT NULL REFERENCES campuses(slug),
  parent_id    uuid REFERENCES academic_units(id),
  slug         text NOT NULL,
  ref          text GENERATED ALWAYS AS (campus_slug || '/' || slug) STORED,
  name         text NOT NULL,
  abbreviation text,
  unit_type    unit_type NOT NULL,              -- ADR-002: never assume 'college'
  description  text,
  head_name    text,
  head_title   text,
  emails       text[],
  website      text,
  status       text NOT NULL DEFAULT 'active',

  source_id        uuid NOT NULL REFERENCES sources(id),
  content_hash     text,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  confidence       confidence_level NOT NULL DEFAULT 'medium',
  miss_count       integer NOT NULL DEFAULT 0,

  UNIQUE (campus_id, slug),
  CONSTRAINT academic_units_ref_key UNIQUE (ref)
);
CREATE INDEX academic_units_campus_type_idx ON academic_units (campus_id, unit_type);
CREATE INDEX academic_units_parent_idx      ON academic_units (parent_id);
CREATE INDEX academic_units_slug_trgm_idx   ON academic_units USING gin (slug gin_trgm_ops);  -- did_you_mean  [E21]

-- ADR-003: the canonical, campus-agnostic degree.
CREATE TABLE programs (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  slug          text UNIQUE NOT NULL,           -- bsce, bscpe, btvted
  ref           text GENERATED ALWAYS AS (slug) STORED,
  code          text,
  name          text NOT NULL,
  aliases       text[],                         -- source name variants seen in the wild
  level         degree_level NOT NULL,
  discipline    text,
  description   text,
  typical_years numeric(3,1),

  source_id        uuid NOT NULL REFERENCES sources(id),
  content_hash     text,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  confidence       confidence_level NOT NULL DEFAULT 'high',
  miss_count       integer NOT NULL DEFAULT 0,

  CONSTRAINT programs_ref_key UNIQUE (ref)
);
CREATE INDEX programs_name_trgm_idx  ON programs USING gin (name gin_trgm_ops);
CREATE INDEX programs_slug_trgm_idx  ON programs USING gin (slug gin_trgm_ops);
CREATE INDEX programs_aliases_idx    ON programs USING gin (aliases);
CREATE INDEX programs_level_disc_idx ON programs (level, discipline);

-- ADR-003: the degree as taught at one campus.
CREATE TABLE program_offerings (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  program_id     uuid REFERENCES programs(id),  -- NULL = unmatched, flagged for review
  campus_id      uuid NOT NULL REFERENCES campuses(id),
  campus_slug    text NOT NULL REFERENCES campuses(slug),
  unit_id        uuid REFERENCES academic_units(id),
  source_name    text NOT NULL,                 -- verbatim, before canonicalisation
  slug           text NOT NULL,
  ref            text GENERATED ALWAYS AS (campus_slug || '/' || slug) STORED,
  local_name     text,
  majors         text[],
  years          numeric(3,1),
  status         offering_status NOT NULL DEFAULT 'active',
  accreditation  jsonb,
  curriculum_url text,

  source_id        uuid NOT NULL REFERENCES sources(id),
  content_hash     text,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  confidence       confidence_level NOT NULL DEFAULT 'medium',
  miss_count       integer NOT NULL DEFAULT 0,

  UNIQUE (program_id, campus_id),
  CONSTRAINT program_offerings_ref_key UNIQUE (ref)
);
CREATE INDEX program_offerings_campus_status_idx ON program_offerings (campus_id, status);
CREATE INDEX program_offerings_unit_idx          ON program_offerings (unit_id);
CREATE INDEX program_offerings_program_idx       ON program_offerings (program_id);
-- unmatched report: pnpm ingest:unmatched
CREATE INDEX program_offerings_unmatched_idx     ON program_offerings (campus_id) WHERE program_id IS NULL;
