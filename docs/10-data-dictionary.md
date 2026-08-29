# 10 — Data Dictionary

**Supersedes:** [`03-TDD.md §2`](./03-TDD.md) where the two disagree
**Resolves:** [`00-errata.md`](./00-errata.md) E1, E6, E7, E15, E16, E21, E25
**Status:** normative — this is the schema migration 001 implements

The v2.0 TDD's schema section was a good sketch with seven defects, four of which are unfixable-after-the-fact. This document is the corrected, complete version: every table, every enum, the `ref` grammar, the missing tables, and the indexes the documented features actually require.

Where this document and [`03-TDD.md §2`](./03-TDD.md) disagree, **this one is correct.** Differences are marked **[E*n*]** with a pointer to the errata entry.

---

## 1. Conventions

- **Primary keys** — UUID v7, time-ordered. Never exposed in URLs. Requires the polyfill in §2.1 **[E4]**.
- **Public identifiers** — `slug` (stable, unique within parent) and `ref` (globally unique, §3).
- **Timestamps** — `timestamptz`, UTC.
- **Soft state** — `status` columns; no hard deletes on canonical entities.
- **Arrays** — `text[]` for small read-whole lists; `jsonb` for structured read-whole objects.
- **Slugs are permanent** (PRD C5). A rename writes `slug_aliases` and serves a 301.

---

## 2. Prerequisites

### 2.1 Extensions and the uuidv7 polyfill  **[E4]**

Supabase runs **Postgres 17**, which has no built-in `uuidv7()` — that arrived in Postgres 18. The TDD's "Postgres 16" is also wrong; 16 is not offered. Migration 000:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_bytes; NOT uuid-ossp

-- RFC 9562 UUIDv7. Delete this and use the built-in when Supabase ships PG 18.
-- Layout: 48-bit big-endian ms timestamp | ver(7) | 12 rand | var(0b10) | 62 rand
CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$
DECLARE
  ts_ms  bigint := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  bytes  bytea  := substring(int8send(ts_ms) FROM 3 FOR 6) || gen_random_bytes(10);
BEGIN
  -- version 7 in the high nibble of byte 7
  bytes := set_byte(bytes, 6, (get_byte(bytes, 6) & 15) | 112);
  -- RFC 4122 variant in the top two bits of byte 9
  bytes := set_byte(bytes, 8, (get_byte(bytes, 8) & 63) | 128);
  RETURN encode(bytes, 'hex')::uuid;
END $$ LANGUAGE plpgsql VOLATILE;
```

Two Supabase-specific notes. `gen_random_bytes` comes from `pgcrypto`, which Supabase installs into the **`extensions`** schema, not `public` — either schema-qualify the call as `extensions.gen_random_bytes(10)` or ensure `extensions` is on the `search_path` for the role running migrations. And check in Phase 0.2 whether `pg_uuidv7` is on Supabase's extension allowlist; prefer it if it is.

Ship this test either way — time-ordering is the only reason v7 was chosen over v4, and a polyfill that produces valid-but-unordered UUIDs would pass every other check:

```sql
DO $$
DECLARE a uuid; b uuid;
BEGIN
  a := uuidv7();
  PERFORM pg_sleep(0.01);
  b := uuidv7();
  ASSERT a < b, format('uuidv7 not time-ordered: %s >= %s', a, b);
  ASSERT substring(a::text, 15, 1) = '7', format('wrong version nibble: %s', a);
  ASSERT substring(b::text, 20, 1) IN ('8','9','a','b'), format('wrong variant: %s', b);
END $$;
```

### 2.2 Enums  **[E1, E13]**

```sql
-- ASCENDING. Order is semantic: min_confidence uses `confidence >= $1`.
-- This order CANNOT be changed after creation. The v2.0 doc had it reversed.
CREATE TYPE confidence_level AS ENUM ('low', 'medium', 'high');

CREATE TYPE ingest_method AS ENUM ('crawl', 'manual', 'partner_feed', 'seed');

-- 'suspended' added: Taguig is a suspended cPanel account serving HTTP 200,
-- which is a different and more recoverable state than 'unavailable'.  [E13]
CREATE TYPE source_status AS ENUM ('active', 'unavailable', 'suspended', 'blocked', 'retired');

CREATE TYPE unit_type AS ENUM ('college','department','institute','center','program_group');

CREATE TYPE degree_level AS ENUM (
  'certificate','diploma','associate','baccalaureate',
  'masters','doctorate','post_baccalaureate'
);

CREATE TYPE offering_status AS ENUM ('active','suspended','phased_out','unknown','removed');

-- The canonical entity list. Referenced by SourceRef.entityTypes, ParseResult.byEntity,
-- chunks.entity_type, change_events.entity_type, and guard(). Was never enumerated.  [E15]
CREATE TYPE entity_type AS ENUM (
  'campus','academic_unit','program','program_offering',
  'office','official','announcement','document',
  'scholarship','fee_estimate','procedure'
);
```

The matching TypeScript lives in `packages/schema` and is generated from these, not hand-written. One source of truth or they drift.

---

## 3. The `ref` grammar  **[E7]**

`ref` is the public, globally unique, **permanent** identifier. The v2.0 docs used it in payloads, in `slug_aliases`, and in `change_events.entity_ref` without ever defining or storing it.

| Entity | Grammar | Example |
|---|---|---|
| `campus` | `{campus_slug}` | `manila` |
| `academic_unit` | `{campus}/{slug}` | `cavite/engineering` |
| `program` | `{slug}` | `bsce` |
| `program_offering` | `{campus}/{program_slug}` | `manila/bsce` |
| `office` | `{campus}/{slug}`, or `system/{slug}` when `campus_id IS NULL` | `visayas/library` |
| `official` | `{campus}/{slug}` | `visayas/j-dela-cruz` |
| `announcement` | `{campus}/{slug}` | `visayas/enrollment-advisory` |
| `document` | `{campus}/{slug}` | `manila/student-handbook` |
| `scholarship` | `{campus}/{slug}` | `manila/tupstat` |
| `fee_estimate` | `{campus}/{program_slug}/{academic_year}` | `manila/bsce/2026-2027` |
| `procedure` | `{campus}/{slug}` | `cavite/admission` |

**`ref` never contains the academic unit.** The v2.0 sample payload showed `manila/coe/bscpe`; reject that form. An offering can move between units during a reorganisation, and a `ref` that changes is not an identifier — it breaks PRD C5 and every consumer's stored links. The unit belongs in the payload body.

Implemented as a stored generated column wherever the components are local to the row, and as a trigger where a join is needed (`campus_id → campuses.slug`). A denormalised `campus_slug text` column on each campus-scoped table makes the generated-column form possible and is worth the redundancy — it is also what the `chunks` filter needs.

```sql
-- pattern used on every campus-scoped table
campus_slug text NOT NULL REFERENCES campuses(slug),
ref text GENERATED ALWAYS AS (campus_slug || '/' || slug) STORED,
...
UNIQUE (ref)
```

---

## 4. Provenance

### 4.1 The shared column set

Every canonical table carries these. Implemented once as a Drizzle helper so it cannot drift:

```ts
export const provenance = {
  sourceId:       uuid('source_id').notNull().references(() => sources.id),
  contentHash:    text('content_hash'),
  firstSeenAt:    timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }).notNull().defaultNow(),
  confidence:     confidenceLevel('confidence').notNull().default('medium'),
  missCount:      integer('miss_count').notNull().default(0),
};
```

`source_id` is `NOT NULL` here where the TDD left it nullable. Every row must be attributable — that is the product. Hand-seeded rows point at a synthetic source (§5.1).

### 4.2 `sources`  **[E11]**

```sql
CREATE TABLE sources (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  url               text UNIQUE NOT NULL,
  origin            text NOT NULL,          -- canonical origin, doc 08 §1  [E5]
  domain            text NOT NULL,
  campus_slug       text REFERENCES campuses(slug),
  entity_types      entity_type[] NOT NULL,
  method            ingest_method NOT NULL,
  status            source_status NOT NULL DEFAULT 'active',

  robots_allowed    boolean,
  robots_present    boolean,                -- distinguishes "allowed" from "no robots.txt"  [E12]
  robots_checked_at timestamptz,
  content_signal    jsonb,                  -- parsed Content-Signal, doc 08 §5.1  [E11]

  crawl_enabled     boolean NOT NULL DEFAULT true,
  recrawl_interval  interval NOT NULL DEFAULT '7 days',
  http_version      text,                   -- 'auto' | '1.1'; Manila needs 1.1  [E10]

  last_fetch_at     timestamptz,
  last_change_at    timestamptz,
  last_status_code  int,
  probe_note        text,                   -- e.g. 'cPanel suspended page'  [E13]

  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON sources (domain, status);
CREATE INDEX ON sources (campus_slug);
CREATE INDEX ON sources (status, last_fetch_at);
```

`robots_present` matters: "allowed because robots.txt says so" and "allowed because there is no robots.txt" are different facts with different durability. Manila and Cavite are currently the second kind, and that can change overnight — [`08-source-landscape.md`](./08-source-landscape.md).

`content_signal` is compared on every robots fetch. **A changed signal fails the run** rather than being logged and ignored.

### 4.3 `snapshots`  **[E15, E18]**

```sql
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
  storage_key   text NOT NULL,        -- keyed by content_hash, shared across rows  [E18]
  compression   text NOT NULL DEFAULT 'gzip',
  parse_status  text NOT NULL DEFAULT 'pending',
  parse_error   text
);
CREATE INDEX ON snapshots (source_id, fetched_at DESC);
CREATE INDEX ON snapshots (content_hash);
CREATE INDEX ON snapshots (run_id);
```

**Snapshots are immutable and never deleted.** They are the only way to debug a parser regression months later and the only way to roll back bad published data.

Two corrections to the v2.0 handling. Store objects under `snapshots/{content_hash}.gz` so identical content across sources and runs is stored **once**; the row references the shared key. And a verified-unchanged fetch (§6.2) writes **no snapshot row** — it only bumps `sources.last_fetch_at`. Otherwise a daily crawl of a static site accrues a row per source per day forever, for no information gain.

### 4.4 `excluded_sources`

```sql
CREATE TABLE excluded_sources (
  url_pattern  text PRIMARY KEY,
  reason       text NOT NULL,
  requested_by text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
```

Checked before every fetch **and** before every publish, so a takedown survives re-crawls (RB-06).

---

## 5. Canonical entities

Provenance columns are abbreviated as `+ provenance` — expand to the §4.1 set.

### 5.1 `campuses`  **[E13]**

```sql
CREATE TABLE campuses (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  slug           text UNIQUE NOT NULL,      -- manila | cavite | visayas | taguig
  ref            text GENERATED ALWAYS AS (slug) STORED UNIQUE,
  name           text NOT NULL,
  short_name     text,
  kind           text NOT NULL,             -- main | satellite | extension
  parent_slug    text REFERENCES campuses(slug),
  address        jsonb,                     -- {street,city,province,region,postal}
  geo            jsonb,                     -- {lat,lng}
  website        text,                      -- canonical origin, doc 08 §1
  website_status source_status NOT NULL DEFAULT 'active',
  emails         text[],
  phones         text[],
  established    int,
  description    text,
  facebook_url   text,
  + provenance   -- confidence defaults 'high'
);
```

Taguig is `website_status = 'suspended'`.

**The synthetic seed source.** Hand-seeded rows still need a `source_id`. Migration 001 inserts one before any data:

```sql
INSERT INTO sources (url, origin, domain, entity_types, method, status, crawl_enabled, notes)
VALUES ('seed://tup-open-api/seeds', 'seed://tup-open-api', 'seed',
        ARRAY['campus','program']::entity_type[], 'seed', 'active', false,
        'Hand-curated seed data from seeds/*.yaml. Not fetched.');
```

### 5.2 `academic_units`

```sql
CREATE TABLE academic_units (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  campus_id    uuid NOT NULL REFERENCES campuses(id),
  campus_slug  text NOT NULL REFERENCES campuses(slug),
  parent_id    uuid REFERENCES academic_units(id),
  slug         text NOT NULL,
  ref          text GENERATED ALWAYS AS (campus_slug || '/' || slug) STORED,
  name         text NOT NULL,
  abbreviation text,
  unit_type    unit_type NOT NULL,          -- ADR-002: never assume 'college'
  description  text,
  head_name    text,
  head_title   text,
  emails       text[],
  website      text,
  status       text NOT NULL DEFAULT 'active',
  + provenance,
  UNIQUE (campus_id, slug),
  UNIQUE (ref)
);
CREATE INDEX ON academic_units (campus_id, unit_type);
CREATE INDEX ON academic_units (parent_id);
CREATE INDEX ON academic_units USING gin (slug gin_trgm_ops);   -- did_you_mean  [E21]
```

### 5.3 `programs`  **[E16, E21]**

```sql
CREATE TABLE programs (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  slug          text UNIQUE NOT NULL,       -- bsce, bscpe, btvted
  ref           text GENERATED ALWAYS AS (slug) STORED UNIQUE,
  code          text,
  name          text NOT NULL,
  aliases       text[],                     -- source name variants seen in the wild
  level         degree_level NOT NULL,
  discipline    text,
  description   text,
  typical_years numeric(3,1),
  + provenance  -- method 'seed', confidence 'high'
);
CREATE INDEX ON programs USING gin (name gin_trgm_ops);
CREATE INDEX ON programs USING gin (slug gin_trgm_ops);
CREATE INDEX ON programs USING gin (aliases);
CREATE INDEX ON programs (level, discipline);
```

The v2.0 table had no `source_id` and no `confidence`, contradicting PRD F25/F26 — and `GET /v1/programs/{slug}` is the flagship endpoint, so it is precisely the one that must carry a `provenance` block. Hand-curation is a **stronger** provenance claim than a scrape, not a weaker one: `method = 'seed'`, `confidence = 'high'`.

`aliases` gets a GIN index because the matching chain in [`03-TDD.md §4.5`](./03-TDD.md) searches it on every offering.

### 5.4 `program_offerings`

```sql
CREATE TABLE program_offerings (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  program_id     uuid REFERENCES programs(id),     -- NULL = unmatched, flagged for review
  campus_id      uuid NOT NULL REFERENCES campuses(id),
  campus_slug    text NOT NULL REFERENCES campuses(slug),
  unit_id        uuid REFERENCES academic_units(id),
  source_name    text NOT NULL,                    -- verbatim, before canonicalisation
  slug           text NOT NULL,                    -- program slug, or a derived one if unmatched
  ref            text GENERATED ALWAYS AS (campus_slug || '/' || slug) STORED,
  local_name     text,
  majors         text[],
  years          numeric(3,1),
  status         offering_status NOT NULL DEFAULT 'active',
  accreditation  jsonb,
  curriculum_url text,
  + provenance,
  UNIQUE (program_id, campus_id),
  UNIQUE (ref)
);
CREATE INDEX ON program_offerings (campus_id, status);
CREATE INDEX ON program_offerings (unit_id);
CREATE INDEX ON program_offerings (program_id);
CREATE INDEX ON program_offerings (program_id) WHERE program_id IS NULL;  -- unmatched report
```

`source_name` is new and it matters. `pnpm ingest:unmatched` needs the verbatim source string to be useful, and when a fuzzy match is later found to be wrong, the original is the only way to tell. **Never auto-create a canonical program from a fuzzy match** ([`02-ADRs.md ADR-003`](./02-ADRs.md)) — write `program_id = NULL` and report it.

`UNIQUE (program_id, campus_id)` does not constrain unmatched rows, since Postgres treats NULLs as distinct. That is the desired behaviour; `UNIQUE (ref)` keeps them individually addressable.

### 5.5 `offices`, `officials`

```sql
CREATE TABLE offices (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  campus_id    uuid REFERENCES campuses(id),          -- NULL = system-wide
  campus_slug  text REFERENCES campuses(slug),
  slug         text NOT NULL,
  ref          text GENERATED ALWAYS AS (coalesce(campus_slug,'system') || '/' || slug) STORED,
  name         text NOT NULL,
  abbreviation text,
  category     text,                 -- academic|student_services|admin|support
  description  text,
  location     text,
  emails       text[],
  phones       text[],
  hours        jsonb,
  services     text[],
  website      text,
  + provenance,  -- capped at 'medium', doc 09 §2
  UNIQUE (campus_id, slug),
  UNIQUE (ref)
);
CREATE INDEX ON offices (campus_id, category);
CREATE INDEX ON offices USING gin (slug gin_trgm_ops);

CREATE TABLE officials (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  campus_id   uuid REFERENCES campuses(id),
  campus_slug text REFERENCES campuses(slug),
  office_id   uuid REFERENCES offices(id),
  slug        text NOT NULL,          -- from name; stable once published
  ref         text GENERATED ALWAYS AS (coalesce(campus_slug,'system') || '/' || slug) STORED,
  name        text NOT NULL,
  title       text NOT NULL,
  scope       text NOT NULL DEFAULT 'campus',   -- system|campus|unit
  email       text,                  -- official address only. PRD C1.
  photo_url   text,
  is_current  boolean NOT NULL DEFAULT true,
  + provenance,  -- capped at 'medium'
  UNIQUE (campus_id, slug),
  UNIQUE (ref)
);
CREATE INDEX ON officials (campus_id, is_current);
CREATE INDEX ON officials (office_id);
```

**PRD C1 applies hardest here.** `officials` is the only table holding names of real people. Officials acting in an official public capacity are in scope; their personal contact details are not, *even where the source publishes them*. The CI personal-data gate should assert that `officials.email` never matches a consumer-mail domain (`gmail.com`, `yahoo.com`, and similar).

### 5.6 `announcements`  **[E6]**

```sql
CREATE TABLE announcements (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  campus_id    uuid REFERENCES campuses(id),
  campus_slug  text NOT NULL REFERENCES campuses(slug),
  slug         text NOT NULL,
  ref          text GENERATED ALWAYS AS (campus_slug || '/' || slug) STORED,
  source_key   text,                 -- Cavite numeric /news/{id}; stable identity  [E6]
  title        text NOT NULL,
  summary      text,
  body_md      text,
  category     text,                 -- news|advisory|vacancy|bid|admission|achievement
  published_at timestamptz,
  url          text NOT NULL,
  image_url    text,
  + provenance,
  UNIQUE (campus_id, slug),          -- was globally UNIQUE(slug) — guaranteed collision  [E6]
  UNIQUE (ref),
  UNIQUE (campus_id, source_key)
);
CREATE INDEX ON announcements (published_at DESC NULLS LAST);
CREATE INDEX ON announcements (campus_id, published_at DESC);
CREATE INDEX ON announcements (campus_id, category, published_at DESC);
CREATE INDEX ON announcements USING gin (to_tsvector('simple', title || ' ' || coalesce(summary,'')));
```

`source_key` carries Cavite's numeric `/news/{id}`, which is the only stable identity that site offers — the title, and therefore the slug, can be edited after publication. Reconcile matches on `(campus_id, source_key)` where present and falls back to `(campus_id, slug)`.

Text-search configuration is `simple`, not `english` **[E22]**: the corpus is Filipino–English and the queries that matter are exact institutional terms. Revisit with the Phase 3.5 eval set.

### 5.7 `documents`  **[E6]**

```sql
CREATE TABLE documents (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  campus_id      uuid REFERENCES campuses(id),
  campus_slug    text NOT NULL REFERENCES campuses(slug),
  slug           text NOT NULL,
  ref            text GENERATED ALWAYS AS (campus_slug || '/' || slug) STORED,
  title          text NOT NULL,
  doc_type       text NOT NULL,      -- handbook|charter|policy|memo|report|calendar
  edition        text,               -- "2013 Revised"
  effective_date date,               -- drives the doc 09 §2.1 override
  format         text,               -- pdf|html
  url            text,
  storage_key    text,
  page_count     int,
  body_md        text,
  is_superseded  boolean NOT NULL DEFAULT false,
  + provenance,  -- capped 'medium'; forced 'low' if effective_date > 3y or superseded
  UNIQUE (campus_id, slug),          -- was globally UNIQUE(slug); both handbooks collide  [E6]
  UNIQUE (ref)
);
CREATE INDEX ON documents (campus_id, doc_type);
CREATE INDEX ON documents USING gin (slug gin_trgm_ops);
```

`effective_date` is non-negotiable ([`04-implementation-plan.md §3.1`](./04-implementation-plan.md)) and is what stops a 2013 rule being served as current. See [`09-freshness-and-confidence.md §2.1`](./09-freshness-and-confidence.md).

### 5.8 `scholarships`, `fee_estimates`

```sql
CREATE TABLE scholarships (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  campus_id           uuid REFERENCES campuses(id),
  campus_slug         text NOT NULL REFERENCES campuses(slug),
  slug                text NOT NULL,
  ref                 text GENERATED ALWAYS AS (campus_slug || '/' || slug) STORED,
  name                text NOT NULL,
  category            text,          -- institutional|government|external|cna|private
  grantor             text,
  benefits            text,
  eligibility         text,
  requirements        text[],
  application_process text,
  contact_office_id   uuid REFERENCES offices(id),
  source_dated        text,          -- verbatim date found on the page, e.g. "2006"
  + provenance,  -- capped 'low' by design, doc 09 §2
  UNIQUE (campus_id, slug),
  UNIQUE (ref)
);
CREATE INDEX ON scholarships (campus_id, category);

CREATE TABLE fee_estimates (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  campus_id      uuid NOT NULL REFERENCES campuses(id),
  campus_slug    text NOT NULL REFERENCES campuses(slug),
  program_id     uuid REFERENCES programs(id),
  program_slug   text,
  academic_year  text,               -- "2026-2027"
  student_type   text,
  ref            text GENERATED ALWAYS AS (
                   campus_slug || '/' || coalesce(program_slug,'all') || '/' ||
                   coalesce(academic_year,'unspecified')) STORED,
  currency       char(3) NOT NULL DEFAULT 'PHP',
  line_items     jsonb NOT NULL,
  total_estimate numeric(12,2),
  notes          text,
  + provenance,  -- capped 'low'
  UNIQUE (ref)
);
```

`scholarships.source_dated` is the verbatim date string found on the page — "2006" on Manila's scholarship page. Publishing it lets a consumer show *"the source page itself is dated 2006"*, which is far more persuasive to a student than an abstract confidence label. It is the concrete form of the argument in [`02-ADRs.md ADR-004`](./02-ADRs.md).

### 5.9 `procedures` — new  **[E15]**

Required by PRD F10, and named as an output of the Cavite `/admission` and Visayas `/admissions/enrollment-procedure` routes in [`03-TDD.md §4`](./03-TDD.md), with no table to receive it.

```sql
CREATE TABLE procedures (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  campus_id    uuid REFERENCES campuses(id),
  campus_slug  text NOT NULL REFERENCES campuses(slug),
  slug         text NOT NULL,        -- admission | enrollment | shifting | graduation
  ref          text GENERATED ALWAYS AS (campus_slug || '/' || slug) STORED,
  title        text NOT NULL,
  category     text NOT NULL,        -- admission|enrollment|records|graduation|other
  audience     text,                 -- freshman|transferee|returning|graduate
  steps        jsonb NOT NULL,       -- [{n, title, detail, office_ref?, forms?[], fee?}]
  requirements text[],
  office_id    uuid REFERENCES offices(id),
  effective_ay text,
  + provenance,  -- capped 'medium'
  UNIQUE (campus_id, slug),
  UNIQUE (ref)
);
CREATE INDEX ON procedures (campus_id, category);
```

`steps` is `jsonb` rather than a child table because steps are always read whole, are never queried individually, and their shape varies by campus. If a consumer ever needs "which procedures require Form 5", revisit.

---

## 6. Pipeline tables

### 6.1 `ingest_runs`  **[E3]**

```sql
CREATE TABLE ingest_runs (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  adapter           text NOT NULL,
  mode              text NOT NULL DEFAULT 'incremental',  -- incremental | full | replay
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  status            text NOT NULL DEFAULT 'running',      -- running|ok|quarantined|failed
  source_ids        uuid[] NOT NULL DEFAULT '{}',   -- sources ACTUALLY PARSED  [E3]
  sources_fetched   int DEFAULT 0,
  sources_unchanged int DEFAULT 0,                  -- 304 + content-hash match  [E2]
  sources_failed    int DEFAULT 0,
  records_published int DEFAULT 0,
  quarantined       int DEFAULT 0,
  error             text
);
CREATE INDEX ON ingest_runs (adapter, started_at DESC);
CREATE INDEX ON ingest_runs (status) WHERE status = 'running';
```

`source_ids` is the fix for the guard-scoping defect. Reconcile and guard operate **only** over rows whose `source_id` is in this array; everything else was not looked at during this run and must not be counted as missing. Without it, every healthy incremental run quarantines and then marks live data removed — [`00-errata.md`](./00-errata.md) E3.

`mode = 'full'` forces every source to be parsed regardless of content hash, which is what makes the adapter's `expectations` ranges meaningful. Run `full` nightly, `incremental` on the 6-hourly announcement pass.

### 6.2 Freshness semantics  **[E2]**

No live campus emits `ETag` or `Last-Modified` ([`08-source-landscape.md §2`](./08-source-landscape.md)), so `304` never arrives and the design must gate on content hash:

| Outcome | Snapshot row | Entities from that source | Counts as |
|---|---|---|---|
| `304 Not Modified` | none | `last_verified_at = now()`, `miss_count = 0` | unchanged |
| `200`, hash matches newest snapshot | none | `last_verified_at = now()`, `miss_count = 0` | unchanged |
| `200`, hash differs | inserted | full pipeline | changed |
| `4xx`/`5xx` after retries | none | untouched — **not** missing | failed |

The last row is important: a failed fetch must never increment `miss_count`. Three failed fetches would otherwise mark healthy data as removed.

### 6.3 `change_events`  **[E15, E25]**

```sql
CREATE TABLE change_events (
  id          bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  run_id      uuid REFERENCES ingest_runs(id),
  entity_type entity_type NOT NULL,
  entity_ref  text NOT NULL,
  operation   text NOT NULL,        -- created|updated|removed|restored
  diff        jsonb,                -- {field: {from, to}}
  snapshot_id uuid REFERENCES snapshots(id)
);
CREATE INDEX ON change_events (occurred_at, id);
CREATE INDEX ON change_events (entity_type, occurred_at DESC);
CREATE INDEX ON change_events (entity_ref, occurred_at DESC);
CREATE INDEX ON change_events (run_id);
```

**Retention: 12 months.** A monthly job deletes older rows. Publish the window in the consumer guide so a sync client knows how far back it may resume, and return `410 Gone` for a `?since=` older than the window rather than silently returning a partial feed. Unbounded growth on a 500 MB free-tier database is a real limit **[E25]**.

Confidence downgrades from the decay job write here as `updated` — those transitions are exactly what a cautious consumer wants to react to.

### 6.4 `quarantine`, `slug_aliases`

```sql
CREATE TABLE quarantine (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  run_id      uuid REFERENCES ingest_runs(id),
  adapter     text NOT NULL,
  entity_type entity_type NOT NULL,
  reason      text NOT NULL,
  incoming_count int,
  current_count  int,
  payload     jsonb NOT NULL,
  snapshot_id uuid REFERENCES snapshots(id),
  issue_url   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution  text
);
CREATE INDEX ON quarantine (resolved_at) WHERE resolved_at IS NULL;

CREATE TABLE slug_aliases (
  entity_type entity_type NOT NULL,
  old_ref     text NOT NULL,
  new_ref     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, old_ref)
);
```

`incoming_count` and `current_count` are stored so RB-01 can be diagnosed without re-deriving them.

### 6.5 `api_keys` — new  **[E15]**

Required by [`03-TDD.md §5.7`](./03-TDD.md) and [`04-implementation-plan.md §4.5`](./04-implementation-plan.md).

```sql
CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  key_hash     text UNIQUE NOT NULL,     -- sha256 of the key. NEVER store the key.
  key_prefix   text NOT NULL,            -- first 8 chars, for support lookup
  label        text NOT NULL,
  contact_email text NOT NULL,
  project_url  text,
  tier         text NOT NULL DEFAULT 'free',
  status       text NOT NULL DEFAULT 'active',   -- active|revoked
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz,
  revoked_reason text
);
CREATE INDEX ON api_keys (key_hash) WHERE status = 'active';
```

Only the SHA-256 hash is stored. `contact_email` is the entire point of keys ([`06-consumer-guide.md`](./06-consumer-guide.md): "so we can contact you if something breaks, not to gate access"), and it is the **one** place the project holds a personal email. It is a developer's business contact, freely given, not scraped student data — PRD C1 is unaffected. Say so in the privacy note, and do not join it to anything.

---

## 7. `chunks` and retrieval  **[E8]**

```sql
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
CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX ON chunks USING gin (to_tsvector('simple', content));
CREATE INDEX ON chunks (entity_type, entity_id);
CREATE INDEX ON chunks (campus_slug, confidence, last_verified_at DESC);
```

Build the HNSW index **after** the first bulk embed, not in migration 001 — building on an empty table then inserting is far slower than the reverse.

The composite `(campus_slug, confidence, last_verified_at)` index is what makes the filters in [`02-ADRs.md ADR-008`](./02-ADRs.md)'s justification actually cheap.

### 7.1 Corrected hybrid search

The v2.0 query had four defects — see [`00-errata.md`](./00-errata.md) E8. Corrected:

```sql
-- Session settings. Without iterative_scan a filtered HNSW scan silently
-- returns fewer rows than LIMIT, which reads as poor recall.
SET LOCAL hnsw.iterative_scan = strict_order;
SET LOCAL hnsw.max_scan_tuples = 20000;

WITH vec AS (
  SELECT id, ROW_NUMBER() OVER () AS rank
  FROM (
    SELECT id
    FROM chunks
    WHERE ($2::text IS NULL OR campus_slug = $2)
      AND ($5::confidence_level IS NULL OR confidence >= $5)
    ORDER BY embedding <=> $1        -- index scan: no window fn in this scope
    LIMIT 50
  ) v
),
lex AS (
  SELECT id, ROW_NUMBER() OVER () AS rank
  FROM (
    SELECT id
    FROM chunks
    WHERE to_tsvector('simple', content) @@ plainto_tsquery('simple', $3)
      AND ($2::text IS NULL OR campus_slug = $2)
      AND ($5::confidence_level IS NULL OR confidence >= $5)
    ORDER BY ts_rank(to_tsvector('simple', content), plainto_tsquery('simple', $3)) DESC
    LIMIT 50
  ) l
),
cand AS (SELECT id FROM vec UNION SELECT id FROM lex)
SELECT c.id, c.content, c.heading_path, c.context_header, c.entity_ref,
       c.campus_slug, c.source_url, c.last_verified_at, c.confidence,
       v.rank AS vec_rank, l.rank AS lex_rank,
       COALESCE(1.0/(60+v.rank),0) + COALESCE(1.0/(60+l.rank),0) AS rrf_score
FROM cand
JOIN chunks c USING (id)                 -- drive from candidates, not from chunks  [E8c]
LEFT JOIN vec v USING (id)
LEFT JOIN lex l USING (id)
ORDER BY rrf_score DESC
LIMIT $4;
```

Four changes from v2.0: ranking moved outside the ordered subquery so the HNSW index is usable; `iterative_scan` set so filtering does not under-return; the outer query drives from the candidate set instead of scanning `chunks`; and `min_confidence` (`$5`) is applied **inside each CTE**, where it narrows the index scan, rather than outside where it would only discard results after the fact.

`ROW_NUMBER() OVER ()` without `ORDER BY` is intentional — the subquery is already ordered, and re-specifying it would reintroduce the sort this rewrite removes.

---

## 8. Meta endpoint schemas  **[E15]**

Four public endpoints had no response contract, so OpenAPI could not be generated for them.

**`GET /v1/meta/freshness`** — [`09-freshness-and-confidence.md §6`](./09-freshness-and-confidence.md).

**`GET /v1/meta/coverage`** — per campus, never aggregated ([`02-ADRs.md ADR-012`](./02-ADRs.md)):

```json
{ "data": { "generated_at": "...", "by_campus": [
  { "campus": "manila", "source_status": "active",
    "counts": { "academic_unit": 6, "program_offering": 84, "office": 12,
                "official": 9, "announcement": 140, "document": 4,
                "scholarship": 11, "fee_estimate": 0, "procedure": 2 },
    "unmatched_offerings": 3, "last_ingest_at": "..." } ] } }
```

**`GET /v1/meta/sources`** — one row per source: `url`, `campus`, `method`, `status`, `entity_types`, `robots_present`, `content_signal`, `last_fetch_at`, `last_change_at`, `recrawl_interval`, `days_overdue`. Publishing this is what makes the "we crawl politely and we tell you exactly what we touch" claim checkable rather than asserted.

**`GET /v1/changes?since=&type=&limit=&cursor=`** — cursor over `(occurred_at, id)`:

```json
{ "data": [ { "id": 90412, "occurred_at": "...", "entity_type": "program_offering",
              "entity_ref": "manila/bsce", "operation": "updated",
              "diff": { "status": { "from": "unknown", "to": "active" } } } ],
  "meta": { "count": 1, "has_more": false, "retention_months": 12 },
  "links": { "self": "...", "next": null } }
```

A `since` older than the retention window returns **410 Gone** with a Problem Details body telling the client to do a full resync — never a silently truncated feed.

---

## 9. Migration order

```
000_extensions_and_uuidv7   extensions, uuidv7() polyfill + ordering test
001_enums                   all enums — confidence_level ASCENDING  [E1]
002_provenance              sources, snapshots, excluded_sources, ingest_runs
003_seed_source             the synthetic seed:// source row
004_core                    campuses, academic_units, programs, program_offerings
005_institutional           offices, officials, announcements, documents,
                            scholarships, fee_estimates, procedures
006_pipeline                change_events, quarantine, slug_aliases, api_keys
007_rag                     chunks (HNSW index deferred to first embed)
```

Forward-only, per [`05-deployment-and-operations.md §3.3`](./05-deployment-and-operations.md). Every migration must be safe to run while the previous version is still serving.

**Before writing 001, confirm the `confidence_level` order.** It is the one thing in this document that cannot be corrected later without rewriting nine tables.
