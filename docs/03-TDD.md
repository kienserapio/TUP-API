# 03 — Technical Design Document

**Prerequisites:** [`01-PRD.md`](./01-PRD.md), [`02-ADRs.md`](./02-ADRs.md)

---

> [!IMPORTANT]
> **Amended 2026-08-20.** **§2 (data model) and §5.4 (hybrid search) are superseded by [`10-data-dictionary.md`](./10-data-dictionary.md)**, which corrects seven schema defects — four of them unfixable after migration 001. **§3.2's conditional-GET design does not work**: no live campus emits `ETag` or `Last-Modified`. **§3.4/§3.5's guard scoping quarantines every healthy incremental run.** Host names in §4 and §5.2 point at origins that do not serve — see [`08-source-landscape.md`](./08-source-landscape.md). See [`00-errata.md`](./00-errata.md) E1–E8, E15, E16, E21, E22, E25.

## 1. Architecture

```
SOURCES
  tup.edu.ph (Manila)  ·  tupcavite.edu.ph  ·  tupvisayas.edu.ph
  tupt.edu.ph (offline)  ·  PDFs  ·  manual imports
        │
        ▼
INGESTION  (apps/ingest — scheduled batch)
  discover → fetch → snapshot → parse → validate → reconcile → guard → publish → chunk → embed
        │
        ▼
STORE  (Supabase Postgres 17 + pgvector)
  sources · snapshots │ canonical entities │ chunks │ change_events
        │
        ├─────────────────────────┐
        ▼                         ▼
REST API (apps/api)          MCP SERVER (apps/mcp)
  /v1/* — Hono                 6 tools over the same API
        │                         │
        └─────────┬───────────────┘
                  ▼
            CONSUMERS
  student platform · mobile · agents · other students' projects
```

### 1.1 Stack

| Layer | Choice | Version |
|---|---|---|
| Runtime | Node.js | 22 LTS |
| Language | TypeScript, `strict: true` | 5.x |
| Package manager | pnpm workspaces | 9.x |
| Build orchestration | Turborepo | latest |
| API framework | Hono + `@hono/zod-openapi` | latest |
| Validation | Zod | 3.x |
| ORM / migrations | Drizzle | latest |
| Database | Postgres + pgvector (Supabase) | 17 |
| Cache | Upstash Redis | — |
| HTTP client | `undici` | native |
| HTML parsing | `cheerio` | 1.x |
| Prose extraction | `@mozilla/readability` + `jsdom` | — |
| Markdown conversion | `turndown` | — |
| PDF extraction | `unpdf` | — |
| Object storage | Supabase Storage (S3-compatible) | — |
| Scheduling | GitHub Actions cron | — |
| Errors | Sentry | — |
| Logging | `pino` | — |
| Testing | Vitest | — |

---

## 2. Data model

### 2.1 Conventions

- **Primary keys:** UUID v7 (time-ordered — indexes well, unlike v4). Never exposed in URLs.
- **Public identifiers:** `slug` (stable, URL-safe, unique within parent) and `ref` (fully-qualified path, e.g. `manila/coe/bscpe`).
- **Timestamps:** `timestamptz`, always UTC.
- **Soft state:** `status` fields, never hard deletes on canonical entities.
- **Arrays:** `text[]` for small read-whole lists. `jsonb` for structured read-whole objects.

### 2.2 Provenance tables

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE ingest_method AS ENUM ('crawl', 'manual', 'partner_feed', 'seed');
CREATE TYPE confidence_level AS ENUM ('high', 'medium', 'low');
CREATE TYPE source_status AS ENUM ('active', 'unavailable', 'blocked', 'retired');

CREATE TABLE sources (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  url            text UNIQUE NOT NULL,
  domain         text NOT NULL,
  campus_slug    text,
  entity_types   text[] NOT NULL,
  method         ingest_method NOT NULL,
  status         source_status NOT NULL DEFAULT 'active',
  robots_allowed boolean,
  robots_checked_at timestamptz,
  crawl_enabled  boolean NOT NULL DEFAULT true,
  recrawl_interval interval NOT NULL DEFAULT '7 days',
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON sources (domain, status);
CREATE INDEX ON sources (campus_slug);

CREATE TABLE snapshots (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  source_id     uuid NOT NULL REFERENCES sources(id),
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  http_status   int,
  etag          text,
  last_modified text,
  content_hash  text NOT NULL,
  content_type  text,
  byte_size     int,
  storage_key   text NOT NULL,
  parse_status  text NOT NULL DEFAULT 'pending',
  parse_error   text
);
CREATE INDEX ON snapshots (source_id, fetched_at DESC);
CREATE INDEX ON snapshots (content_hash);

-- URLs removed on request. Checked before every fetch and every publish.
CREATE TABLE excluded_sources (
  url_pattern text PRIMARY KEY,
  reason      text NOT NULL,
  requested_by text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

**Snapshots are immutable and never deleted.** They are the only way to debug a parser regression six months later, and the only way to roll back bad published data.

### 2.3 Shared provenance columns

Every canonical table carries these. Implemented as a Drizzle helper to prevent drift:

```ts
export const provenance = {
  sourceId:       uuid('source_id').references(() => sources.id),
  contentHash:    text('content_hash'),
  firstSeenAt:    timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }).notNull().defaultNow(),
  confidence:     confidenceLevel('confidence').notNull().default('medium'),
  missCount:      integer('miss_count').notNull().default(0),
};
```

### 2.4 Core entities

```sql
CREATE TABLE campuses (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  slug          text UNIQUE NOT NULL,        -- manila | cavite | visayas | taguig
  name          text NOT NULL,
  short_name    text,
  kind          text NOT NULL,               -- main | satellite | extension
  parent_slug   text REFERENCES campuses(slug),
  address       jsonb,                       -- {street,city,province,region,postal}
  geo           jsonb,                       -- {lat,lng}
  website       text,
  website_status source_status NOT NULL DEFAULT 'active',
  emails        text[],
  phones        text[],
  established   int,
  description   text,
  facebook_url  text,
  -- + provenance columns
  source_id uuid REFERENCES sources(id),
  content_hash text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  confidence confidence_level NOT NULL DEFAULT 'high',
  miss_count int NOT NULL DEFAULT 0
);

CREATE TYPE unit_type AS ENUM ('college','department','institute','center','program_group');

CREATE TABLE academic_units (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  campus_id     uuid NOT NULL REFERENCES campuses(id),
  parent_id     uuid REFERENCES academic_units(id),
  slug          text NOT NULL,
  name          text NOT NULL,
  abbreviation  text,
  unit_type     unit_type NOT NULL,
  description   text,
  head_name     text,
  head_title    text,
  emails        text[],
  website       text,
  status        text NOT NULL DEFAULT 'active',
  -- + provenance
  source_id uuid REFERENCES sources(id),
  content_hash text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  confidence confidence_level NOT NULL DEFAULT 'high',
  miss_count int NOT NULL DEFAULT 0,
  UNIQUE (campus_id, slug)
);
CREATE INDEX ON academic_units (campus_id, unit_type);

CREATE TYPE degree_level AS ENUM (
  'certificate','diploma','associate','baccalaureate',
  'masters','doctorate','post_baccalaureate'
);

-- Canonical, campus-agnostic degree.
CREATE TABLE programs (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  slug          text UNIQUE NOT NULL,        -- bsce, bscpe, btvted
  code          text,                        -- BSCE
  name          text NOT NULL,
  aliases       text[],                      -- source name variants seen in the wild
  level         degree_level NOT NULL,
  discipline    text,
  description   text,
  typical_years numeric(3,1),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON programs USING gin (name gin_trgm_ops);
CREATE INDEX ON programs (level, discipline);

-- The degree as actually offered at a campus.
CREATE TABLE program_offerings (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  program_id     uuid NOT NULL REFERENCES programs(id),
  campus_id      uuid NOT NULL REFERENCES campuses(id),
  unit_id        uuid REFERENCES academic_units(id),
  local_name     text,
  majors         text[],
  years          numeric(3,1),
  status         text NOT NULL DEFAULT 'active',  -- active|suspended|phased_out|unknown|removed
  accreditation  jsonb,
  curriculum_url text,
  -- + provenance
  source_id uuid REFERENCES sources(id),
  content_hash text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  confidence confidence_level NOT NULL DEFAULT 'high',
  miss_count int NOT NULL DEFAULT 0,
  UNIQUE (program_id, campus_id)
);
CREATE INDEX ON program_offerings (campus_id, status);
CREATE INDEX ON program_offerings (unit_id);

CREATE TABLE offices (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  campus_id   uuid REFERENCES campuses(id),   -- NULL = system-wide
  slug        text NOT NULL,
  name        text NOT NULL,
  abbreviation text,
  category    text,                            -- academic|student_services|admin|support
  description text,
  location    text,
  emails      text[],
  phones      text[],
  hours       jsonb,
  services    text[],
  website     text,
  source_id uuid REFERENCES sources(id),
  content_hash text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  confidence confidence_level NOT NULL DEFAULT 'medium',
  miss_count int NOT NULL DEFAULT 0,
  UNIQUE (campus_id, slug)
);

CREATE TABLE officials (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  campus_id  uuid REFERENCES campuses(id),
  office_id  uuid REFERENCES offices(id),
  name       text NOT NULL,
  title      text NOT NULL,
  scope      text NOT NULL DEFAULT 'campus',   -- system|campus|unit
  email      text,
  photo_url  text,
  is_current boolean NOT NULL DEFAULT true,
  source_id uuid REFERENCES sources(id),
  content_hash text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  confidence confidence_level NOT NULL DEFAULT 'medium',
  miss_count int NOT NULL DEFAULT 0
);
CREATE INDEX ON officials (campus_id, is_current);

CREATE TABLE announcements (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  campus_id    uuid REFERENCES campuses(id),
  slug         text UNIQUE NOT NULL,
  title        text NOT NULL,
  summary      text,
  body_md      text,
  category     text,                    -- news|advisory|vacancy|bid|admission|achievement
  published_at timestamptz,
  url          text NOT NULL,
  image_url    text,
  source_id uuid REFERENCES sources(id),
  content_hash text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  confidence confidence_level NOT NULL DEFAULT 'high',
  miss_count int NOT NULL DEFAULT 0
);
CREATE INDEX ON announcements (published_at DESC NULLS LAST);
CREATE INDEX ON announcements (campus_id, published_at DESC);
CREATE INDEX ON announcements USING gin (to_tsvector('english', title || ' ' || coalesce(summary,'')));

CREATE TABLE documents (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  campus_id      uuid REFERENCES campuses(id),
  slug           text UNIQUE NOT NULL,
  title          text NOT NULL,
  doc_type       text NOT NULL,          -- handbook|charter|policy|memo|report|calendar
  edition        text,                   -- "2013 Revised"
  effective_date date,
  format         text,
  url            text,
  storage_key    text,
  page_count     int,
  body_md        text,
  is_superseded  boolean NOT NULL DEFAULT false,
  source_id uuid REFERENCES sources(id),
  content_hash text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  confidence confidence_level NOT NULL DEFAULT 'medium',
  miss_count int NOT NULL DEFAULT 0
);

CREATE TABLE scholarships (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  campus_id     uuid REFERENCES campuses(id),
  slug          text NOT NULL,
  name          text NOT NULL,
  category      text,                    -- institutional|government|external|cna|private
  grantor       text,
  benefits      text,
  eligibility   text,
  requirements  text[],
  application_process text,
  contact_office_id uuid REFERENCES offices(id),
  source_id uuid REFERENCES sources(id),
  content_hash text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  confidence confidence_level NOT NULL DEFAULT 'low',
  miss_count int NOT NULL DEFAULT 0,
  UNIQUE (campus_id, slug)
);

CREATE TABLE fee_estimates (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  campus_id      uuid NOT NULL REFERENCES campuses(id),
  program_id     uuid REFERENCES programs(id),
  academic_year  text,
  student_type   text,
  currency       char(3) NOT NULL DEFAULT 'PHP',
  line_items     jsonb NOT NULL,
  total_estimate numeric(12,2),
  notes          text,
  source_id uuid REFERENCES sources(id),
  content_hash text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  confidence confidence_level NOT NULL DEFAULT 'low',
  miss_count int NOT NULL DEFAULT 0
);
```

### 2.5 RAG and change tracking

```sql
CREATE TABLE chunks (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  entity_type     text NOT NULL,
  entity_id       uuid NOT NULL,
  campus_slug     text,
  heading_path    text[],
  content         text NOT NULL,
  context_header  text NOT NULL,
  token_count     int,
  embedding       vector(1536),
  embedding_model text NOT NULL DEFAULT 'text-embedding-3-small',
  content_hash    text NOT NULL,
  source_url      text NOT NULL,
  last_verified_at timestamptz NOT NULL,
  confidence      confidence_level NOT NULL DEFAULT 'medium'
);
CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON chunks (entity_type, entity_id);
CREATE INDEX ON chunks (campus_slug);
CREATE INDEX chunks_fts ON chunks USING gin (to_tsvector('english', content));
CREATE UNIQUE INDEX ON chunks (entity_type, entity_id, content_hash);

CREATE TABLE change_events (
  id          bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  entity_type text NOT NULL,
  entity_ref  text NOT NULL,
  operation   text NOT NULL,          -- created|updated|removed|restored
  diff        jsonb,
  snapshot_id uuid REFERENCES snapshots(id)
);
CREATE INDEX ON change_events (occurred_at, id);
CREATE INDEX ON change_events (entity_type, occurred_at DESC);

CREATE TABLE slug_aliases (
  entity_type text NOT NULL,
  old_ref     text NOT NULL,
  new_ref     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, old_ref)
);

CREATE TABLE quarantine (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  adapter     text NOT NULL,
  entity_type text NOT NULL,
  reason      text NOT NULL,
  payload     jsonb NOT NULL,
  snapshot_id uuid REFERENCES snapshots(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution  text
);

CREATE TABLE ingest_runs (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  adapter      text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text NOT NULL DEFAULT 'running',
  sources_fetched int DEFAULT 0,
  sources_304     int DEFAULT 0,
  records_published int DEFAULT 0,
  quarantined  int DEFAULT 0,
  error        text
);
```

---

## 3. Ingestion

### 3.1 Contracts

```ts
export interface SourceRef {
  url: string;
  entityTypes: EntityType[];
  method: IngestMethod;
  recrawlInterval?: string;
  hint?: Record<string, unknown>;
}

export interface RawSnapshot {
  sourceRef: SourceRef;
  fetchedAt: Date;
  httpStatus: number;
  etag?: string;
  lastModified?: string;
  contentType: string;
  body: Buffer;
  contentHash: string;
}

export interface ParseResult {
  byEntity: Partial<Record<EntityType, unknown[]>>;
  warnings: string[];
}

export interface CampusAdapter {
  readonly campusSlug: string;
  readonly domains: string[];
  discover(): AsyncIterable<SourceRef>;
  parse(snapshot: RawSnapshot): Promise<ParseResult>;
  expectations?: Partial<Record<EntityType, { min: number; max: number }>>;
}
```

`parse` must be pure — no network, no `Date.now()`, no randomness. This is what makes golden fixture testing possible (ADR-005).

### 3.2 Fetcher policy

```ts
export const FETCH_POLICY = {
  userAgent:
    'TUPOpenDataBot/1.0 (+https://github.com/<org>/tup-open-api; student open-data project; <contact-email>)',
  perDomainConcurrency: 1,
  minDelayMs: 3000,
  timeoutMs: 20_000,
  retries: { attempts: 3, backoff: 'exponential' as const, baseMs: 2000 },
  respectRobots: true,
  respectCrawlDelay: true,
  maxPagesPerRun: 500,
  windowPHT: { start: 2, end: 4 },
} as const;
```

Behavior:
1. Check `excluded_sources` → skip if matched.
2. Load robots.txt (cached 24h). Disallowed → mark source `blocked`, `crawl_enabled = false`, throw `RobotsDisallowedError`.
3. Send `If-None-Match` / `If-Modified-Since` from the last snapshot.
4. `304` → bump `last_verified_at` on all entities from that source, increment `sources_304`, skip the rest of the pipeline.
5. `200` → hash body, write to object storage, insert `snapshots`.
6. `4xx`/`5xx` → retry with backoff, then record and continue.

On a site this static, **most runs should be all-304s.** If they are not, the conditional headers are wrong — treat that as a bug.

### 3.3 Manual imports

For robots-blocked Manila routes (ADR-013):

```
fixtures/manual/manila/
  pages-admission-undergraduate-programs.html
  pages-students-tup-student-handbook.html
  pages-students-student-scholarship.html
  MANIFEST.json    # url, collected_at, collected_by, sha256
```

`method: 'manual'` sources read from disk instead of the network. Everything downstream — parse, validate, guard, publish, provenance — is identical. `sources.url` still records the real URL so citations point to the live page.

Refresh cadence: manual set is re-collected each semester start (15 minutes of work). A scheduled job opens a reminder issue when a manual source exceeds 120 days.

### 3.4 Pipeline

```
discover → fetch → snapshot → parse → validate → reconcile → guard → publish → chunk → embed
```

**validate** — Zod parse against canonical schemas. Reject, never coerce. A program with a null name is a parser bug, not a data point.

**reconcile** — match incoming against current by natural key. Compute `content_hash` per record. Emit `change_events` with a field-level diff. Records present in DB but absent from the parse increment `miss_count`.

**guard** — see §3.5.

**publish** — single transaction. Upsert changed, bump `last_verified_at` on unchanged, apply removal policy.

### 3.5 Anomaly guard

```ts
export function guard(
  entityType: EntityType,
  incoming: unknown[],
  currentCount: number,
  expectations?: { min: number; max: number },
): { action: 'publish' | 'quarantine'; reason?: string } {
  const n = incoming.length;

  if (expectations && (n < expectations.min || n > expectations.max)) {
    return { action: 'quarantine', reason: `count ${n} outside expected [${expectations.min},${expectations.max}]` };
  }
  if (currentCount > 0 && n === 0) {
    return { action: 'quarantine', reason: 'parser returned zero records where data existed' };
  }
  if (currentCount >= 10 && n < currentCount * 0.7) {
    return { action: 'quarantine', reason: `count dropped ${currentCount}→${n} (>30%)` };
  }
  if (currentCount >= 10 && n > currentCount * 2) {
    return { action: 'quarantine', reason: `count doubled ${currentCount}→${n}` };
  }
  return { action: 'publish' };
}
```

On quarantine: preserve existing data, insert into `quarantine`, open a GitHub issue via API, capture to Sentry. **Never publish.**

**Removal policy:** `miss_count = 1` → `status = 'unknown'`. `miss_count >= 3` (across three separate runs) → `status = 'removed'`. Never hard-delete.

### 3.6 Chunking and embedding

```
1. Normalize source (HTML or PDF) to markdown, preserving heading hierarchy.
2. Split at h2/h3. Record heading_path as an array.
3. Section > ~800 tokens → split on paragraph, repeat heading_path.
4. Section < ~100 tokens → merge with next sibling.
5. Build context_header:
     "TUP Manila · Student Handbook (2013 Revised) · Academic Policies › Maximum Residency Rule"
6. Embed (context_header + "\n\n" + content).
7. Skip if (entity_type, entity_id, content_hash) already exists — hash-gated re-embedding.
```

Step 5 is load-bearing. In a multi-campus corpus the dominant failure mode is returning a Manila 2013 rule in answer to a Cavite question; embedding the campus and edition into the vector text materially reduces it.

---

## 4. Campus adapters

### 4.1 Manila — `tup.edu.ph`

**Stack:** legacy PHP, custom CMS, no `/wp-json/`. **Two generations live simultaneously** — `/page/*` and `/pages/*` render different content with different visitor counters.

| Route family | Access | Notes |
|---|---|---|
| `/` | Open | Homepage, sitemap-ish nav |
| `/page/{slug}` | **Open** | Legacy generation (`/page/academics`, `/page/campuses`) |
| `/pages/{section}/{slug}` | **robots-blocked** | Current generation — programs, scholarships, handbook |
| `/newspage/{n}` | robots-blocked | Numeric pagination |
| `/registrar/services/{slug}` | blocked | — |

**Strategy:** crawl `/page/*` + homepage; manually import the `/pages/*` set. Resolve conflicts in favor of the manual (current-generation) copy, since the legacy tree is stale.

**Units:** 6 colleges → `unit_type = 'college'`.
**Expectations:** `academic_units {min:5,max:9}`, `program_offerings {min:30,max:120}`.
**Open question Q2:** determine whether `/page/*` is authoritative or abandoned before trusting it for anything but campus metadata.

### 4.2 Cavite — `tupcavite.edu.ph`

**Stack:** modern SSR, clean routes. Note: homepage visitor counter matches `tup.edu.ph` exactly — investigate shared CMS (Q3); if confirmed, the Manila and Cavite parsers may share selectors.

| Route | Entities |
|---|---|
| `/programs` | `program_offerings` |
| `/dept/{engineering,dit,ded,dla,dms}` | `academic_units` |
| `/office/{adaa,osa,library,registrar,uitc,ogs,clinic,ohr,ocd,oaf,rne,oirjpo}` | `offices` |
| `/campus-official`, `/bor` | `officials` |
| `/news`, `/news/{id}` | `announcements` |
| `/handbook`, `/academic_calendar` | `documents` |
| `/admission` | procedures |
| `/transparency-seal`, `/tup-code`, `/tupc-arta`, `/tupc-csmr` | `documents` |
| `/copc_eng`, `/copc_dit`, `/copc_ded` | accreditation → `program_offerings.accreditation` |
| `/service/procurement`, `/service/qms` | `offices` / `documents` |

**Units:** 5 departments → `unit_type = 'department'`. **This is the case that justifies ADR-002.**
**Expectations:** `academic_units {min:4,max:8}`, `offices {min:8,max:20}`, `program_offerings {min:10,max:50}`.
**Note:** `/news/{id}` is numeric — discover IDs from the `/news` index, never by incrementing blindly.

### 4.3 Visayas — `tupvisayas.edu.ph`

**Stack:** Laravel (CSRF meta tag, `/storage/` asset paths, slug routes). Best-structured of the four. Built in-house by UITC TUPV.

| Route | Entities |
|---|---|
| `/academics`, `/academics/undergraduate-programs` | `program_offerings` |
| `/academics/{coac,coe,coet}` | `academic_units` |
| `/officials` | `officials` (with photos) |
| `/news-events`, `/news/{slug}` | `announcements` |
| `/announcements` | `announcements` (category `advisory`) |
| `/bid-opportunities` | `announcements` (category `bid`) |
| `/jobs/{slug}` | `announcements` (category `vacancy`) |
| `/about/{history,mission,mandate,hymn,values}` | campus prose → `chunks` |
| `/student-services`, `/library`, `/technology`, `/human-resources`, `/sit` | `offices` |
| `/admissions/enrollment-procedure` | procedures |
| `/transparency-seal`, `/privacy-notice` | `documents` |

**Units:** 3 colleges → `unit_type = 'college'`.
**Expectations:** `academic_units {min:3,max:5}`, `officials {min:4,max:40}`, `announcements {min:1,max:200}`.
**Bonus:** slug-based news URLs make stable `announcements.slug` trivial — no ID mapping needed.

### 4.4 Taguig — `tupt.edu.ph`

**Status:** 404 as of 2026-08-19. Modeled per ADR-012.

- `campuses` row seeded by hand: `website_status = 'unavailable'`, `confidence = 'low'`, `method = 'seed'`.
- Sibling sites reference it (name, location "Taguig City", classification "satellite"). Attribute those facts with the sibling as `source_id`.
- Scheduled weekly liveness probe on `tupt.edu.ph`. On first 200, open an issue: *"Taguig site is live — build adapter."*
- Adapter stub exists with `discover()` yielding nothing, so the campus is wired into the pipeline and needs only a `parse()` when the site returns.

### 4.5 Canonical program registry

Cross-campus deduplication (ADR-003) needs a hand-maintained mapping. Store as a committed YAML seed, not inferred:

```yaml
- slug: bsce
  code: BSCE
  name: Bachelor of Science in Civil Engineering
  level: baccalaureate
  discipline: engineering
  typical_years: 4
  aliases:
    - "BS Civil Engineering"
    - "Bachelor of Science in Civil Engineering"
    - "BSCE"
```

Matching order: exact alias → normalized alias (lowercase, strip punctuation) → trigram similarity ≥ 0.85 → **unmatched**. Unmatched offerings are written with `program_id = NULL` and flagged for review. **Never auto-create a canonical program from a fuzzy match** — that is how you end up with three near-duplicate "Civil Engineering" degrees.

---

## 5. API design

### 5.1 Conventions

| Concern | Decision |
|---|---|
| Base | `https://api.<domain>/v1` |
| Format | JSON only, UTF-8 |
| Casing | `snake_case` (SDK converts to camelCase) |
| Dates | RFC 3339, UTC, `Z` suffix |
| Pagination | Cursor (ADR-009) |
| Errors | RFC 9457 Problem Details |
| Spec | OpenAPI 3.1, generated, committed, CI-diffed |

### 5.2 Envelopes

Collection:
```json
{
  "data": [],
  "meta": {
    "count": 25,
    "has_more": true,
    "generated_at": "2026-08-19T09:12:00Z",
    "freshness": {
      "oldest_verified_at": "2026-07-30T02:00:00Z",
      "min_confidence": "medium"
    }
  },
  "links": {
    "self": "/v1/programs?campus=manila&limit=25",
    "next": "/v1/programs?campus=manila&limit=25&cursor=eyJ2IjoiYnNjZSJ9"
  }
}
```

Single:
```json
{
  "data": {
    "ref": "manila/coe/bscpe",
    "slug": "bscpe",
    "name": "Bachelor of Science in Computer Engineering",
    "level": "baccalaureate",
    "years": 4
  },
  "provenance": {
    "source_url": "https://www.tup.edu.ph/pages/admission/undergraduate-programs",
    "method": "manual",
    "last_verified_at": "2026-08-01T03:14:00Z",
    "staleness_days": 18,
    "confidence": "high"
  }
}
```

Error:
```json
{
  "type": "https://api.<domain>/errors/not-found",
  "title": "Program not found",
  "status": 404,
  "detail": "No program with slug 'bsit-x'.",
  "instance": "/v1/programs/bsit-x",
  "did_you_mean": ["bsit", "bsitm"]
}
```
`Content-Type: application/problem+json`. `did_you_mean` is one trigram query and disproportionately improves DX.

### 5.3 Endpoints

```
# Campuses
GET  /v1/campuses
GET  /v1/campuses/{campus}
GET  /v1/campuses/{campus}/units
GET  /v1/campuses/{campus}/programs
GET  /v1/campuses/{campus}/offices
GET  /v1/campuses/{campus}/officials
GET  /v1/campuses/{campus}/scholarships

# Academic units
GET  /v1/units                      ?campus= &type= &parent=
GET  /v1/units/{campus}/{unit}

# Programs — the flagship
GET  /v1/programs                   ?campus= &level= &unit= &discipline= &q= &status=
GET  /v1/programs/{program}         → canonical degree + offerings[] across all campuses
GET  /v1/offerings/{campus}/{program}

# Institutional
GET  /v1/offices                    ?campus= &category=
GET  /v1/officials                  ?campus= &current=
GET  /v1/announcements              ?campus= &category= &since= &until=
GET  /v1/announcements/{slug}
GET  /v1/documents                  ?campus= &type=
GET  /v1/documents/{slug}
GET  /v1/documents/{slug}/sections
GET  /v1/scholarships               ?campus= &category=
GET  /v1/fees                       ?campus= &program= &year=

# Search & retrieval
GET  /v1/search                     ?q= &type= &campus= &limit=
POST /v1/rag/query

# Meta
GET  /v1/changes                    ?since= &type=
GET  /v1/meta/freshness
GET  /v1/meta/sources
GET  /v1/meta/coverage
GET  /v1/health
GET  /openapi.json
GET  /docs
GET  /llms.txt
```

**Global query params:** `limit` (1–100, default 25), `cursor`, `min_confidence`, `fields` (sparse fieldsets).

**`GET /v1/programs/{program}`** is the endpoint that justifies the project:

```json
{
  "data": {
    "slug": "bsce",
    "name": "Bachelor of Science in Civil Engineering",
    "level": "baccalaureate",
    "offerings": [
      { "campus": "manila",  "unit": { "slug": "coe", "type": "college" },    "status": "active", "years": 4 },
      { "campus": "cavite",  "unit": { "slug": "engineering", "type": "department" }, "status": "active", "years": 4 },
      { "campus": "visayas", "unit": { "slug": "coe", "type": "college" },    "status": "active", "years": 4 }
    ]
  }
}
```

Note how `unit.type` differs per campus. That is ADR-002 paying off, visible in the payload.

### 5.4 Hybrid search

Reciprocal Rank Fusion over pgvector cosine similarity and Postgres full-text `ts_rank`:

```sql
WITH vec AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $1) AS rank
  FROM chunks
  WHERE ($2::text IS NULL OR campus_slug = $2)
  ORDER BY embedding <=> $1 LIMIT 50
),
lex AS (
  SELECT id, ROW_NUMBER() OVER (
    ORDER BY ts_rank(to_tsvector('english', content), plainto_tsquery('english', $3)) DESC
  ) AS rank
  FROM chunks
  WHERE to_tsvector('english', content) @@ plainto_tsquery('english', $3)
    AND ($2::text IS NULL OR campus_slug = $2)
  LIMIT 50
)
SELECT c.*,
       COALESCE(1.0/(60+v.rank),0) + COALESCE(1.0/(60+l.rank),0) AS rrf_score
FROM chunks c
LEFT JOIN vec v ON v.id = c.id
LEFT JOIN lex l ON l.id = c.id
WHERE v.id IS NOT NULL OR l.id IS NOT NULL
ORDER BY rrf_score DESC
LIMIT $4;
```

Pure vector search performs badly on the exact-term queries students actually type — `TUPSTAT`, `BTVTEd`, `Form 5`, `COPC`. Lexical rescues those; vector rescues paraphrases. RRF needs no score normalization, which is why it beats weighted-sum here.

### 5.5 `POST /v1/rag/query`

Request:
```json
{ "query": "what is the maximum residency rule", "campus": "manila", "top_k": 6, "min_confidence": "medium" }
```

Response: array of chunks with `content`, `heading_path`, `context_header`, `source_url`, `last_verified_at`, `confidence`, `scores`. **No synthesized answer** (ADR-010).

### 5.6 Caching

```
Cache-Control: public, max-age=300, stale-while-revalidate=3600
ETag: "sha256-<body hash>"
Vary: Accept-Encoding
```
Reference data (`campuses`, `units`, `programs`) → `max-age=3600`. Announcements → `max-age=300`. Handle `If-None-Match` → `304`. Redis keyed on the normalized query string, invalidated by prefix on publish. Cloudflare in front.

### 5.7 Rate limits

| Tier | Per minute | Per day |
|---|---|---|
| Anonymous | 60 | 1,000 |
| Free API key | 600 | 100,000 |

Headers: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, plus `Retry-After` on 429. Sliding window in Redis. Keys exist for contact and abuse response, not gatekeeping.

### 5.8 MCP tools

| Tool | Purpose |
|---|---|
| `list_campuses` | Enumerate campuses and status |
| `find_programs` | Filter by campus, level, discipline, keyword |
| `get_program` | Canonical degree + cross-campus offerings |
| `search_handbook` | RAG over documents, returns cited passages |
| `get_announcements` | Recent news, filterable |
| `check_freshness` | Staleness and confidence for an entity |

`check_freshness` as an explicit tool is what lets an agent self-police. The recommended system prompt for consumers instructs the agent to call it before asserting anything about fees or scholarships.

---

## 6. Testing

| Layer | Tool | What |
|---|---|---|
| Parser (highest value) | Vitest + committed fixtures | Golden HTML → expected JSON, exact match |
| Schema | Vitest | Zod round-trip, enum exhaustiveness |
| Guard | Vitest | Trips on synthetic 0-row, 30% drop, 2× |
| Contract | Vitest + `openapi-fetch` | Live responses validate against `openapi.json` |
| Spec drift | CI gate | Fail if `openapi.json` changes without version bump or `breaking-change` label |
| Load | `autocannon` | p95 < 100ms warm on `/v1/programs` |

```
fixtures/
  manila/2026-08-19/page-academics.html + .expected.json
  cavite/2026-08-19/programs.html + .expected.json
  visayas/2026-08-19/academics-undergraduate-programs.html + .expected.json
```

**Rule: every quarantine incident adds a fixture.** Over time the suite becomes a record of every site redesign survived.

No live-site E2E tests in CI — flaky, slow, impolite. One nightly smoke crawl outside CI instead.

---

## 7. Repository layout

```
tup-open-api/
├─ apps/
│  ├─ api/          # Hono service
│  ├─ ingest/       # CLI + scheduled worker
│  └─ mcp/          # MCP server
├─ packages/
│  ├─ schema/       # Zod + Drizzle — single source of truth
│  ├─ ingest-core/  # fetcher, pipeline, reconcile, guard, chunker
│  ├─ adapters/
│  │  ├─ manila/ cavite/ visayas/ taguig/ documents/
│  └─ sdk/          # generated TS client → npm
├─ fixtures/
│  ├─ manila/ cavite/ visayas/
│  └─ manual/       # human-collected blocked pages + MANIFEST.json
├─ seeds/
│  ├─ campuses.yaml
│  └─ programs.yaml # canonical program registry
├─ migrations/
├─ docs/            # this doc set
└─ openapi.json     # generated, committed
```
