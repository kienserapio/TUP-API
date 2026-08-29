# 04 — Implementation Plan

**Prerequisites:** [`03-TDD.md`](./03-TDD.md)

Each phase ends with a **demonstrable artifact**, not a checklist. If a phase's exit criterion cannot be demonstrated to another person, the phase is not done.

Estimates assume ~10–15 hrs/week alongside coursework and existing commitments.

| Phase | Focus | Est. | Exit artifact |
|---|---|---|---|
| 0 | Foundation | 1 wk | `GET /v1/campuses` live in production |
| 1 | Manila vertical slice | 2 wks | Manila programs with provenance, spot-verified |
| 2 | Multi-campus | 2–3 wks | `GET /v1/programs/bsce` returns 3 campuses |
| 3 | Documents & RAG | 2 wks | Cited handbook answer with edition date |
| 4 | Agent surface & DX | 2 wks | Someone integrates without asking you |
| 5 | Operations & handover | ongoing | Second maintainer shipping |

---

> [!IMPORTANT]
> **Amended 2026-08-20.** Estimates are roughly **2–2.5× optimistic** — 180–245 hours realistic against ~130 planned, i.e. 15–20 weeks rather than 9–10. The phase *sequence* is sound and unchanged. Task **1.2 (manual collection) is no longer on the critical path**, which shortens Phase 1. Phase 0 gains the `uuidv7()` polyfill and the enum-order fix. See [`00-errata.md`](./00-errata.md) E23, E4, E12 and [`12-build-prerequisites.md`](./12-build-prerequisites.md).

## Phase 0 — Foundation (1 week)

**Goal:** a deployed, typed, migrated skeleton. No scraping yet.

### Tasks

**0.1 Repo and tooling**
- pnpm workspace + Turborepo per TDD §7
- TypeScript `strict: true`, `noUncheckedIndexedAccess: true`
- ESLint + Prettier, pre-commit via `lefthook`
- `.env.example` with every variable documented

**0.2 Database**
- Supabase project, region `ap-southeast-1`, **Postgres 17**
- Drizzle migration **000**: `vector`, `pg_trgm`, `pgcrypto` (**not** `uuid-ossp`) + the `uuidv7()` polyfill
- Drizzle migration **001**: all tables from [`10-data-dictionary.md`](./10-data-dictionary.md) — **not** TDD §2, which is superseded
- Assert `confidence_level` is ascending and `uuidv7()` is time-ordered before any data lands
- Local setup: [`15-local-development.md`](./15-local-development.md)

**0.3 Schema package**
- Zod schemas for every entity; Drizzle tables derived from the same definitions
- Shared `provenance` column helper (TDD §2.3) — prevents drift
- Export inferred TS types

**0.4 Seed data — do this by hand**
- `seeds/campuses.yaml`: 4 rows. Manila, Cavite, Visayas (`active`); Taguig (`unavailable`)
- `seeds/programs.yaml`: start with ~20 canonical degrees you know exist
- Seed script, idempotent

**0.5 API skeleton**
- Hono + `@hono/zod-openapi`
- `GET /v1/campuses`, `GET /v1/campuses/{campus}`, `GET /v1/health`
- Envelope helpers, cursor pagination utility, RFC 9457 error handler
- `GET /openapi.json`, `GET /docs` (Scalar)

**0.6 CI/CD**
- GitHub Actions: typecheck → lint → test → build
- Deploy `apps/api` to Fly.io (region `sin`)
- Sentry wired

### Exit criteria
- [ ] `curl https://api.<domain>/v1/campuses` returns 4 campuses with provenance
- [ ] Taguig appears with `website_status: "unavailable"`
- [ ] `/docs` renders and the example request works
- [ ] CI green on main

> **Why hand-seed campuses?** Four rows takes twenty minutes and is more accurate than any scraper. It unblocks the entire API layer while the ingestion work proceeds independently. Do not scrape what you can type.

---

## Phase 1 — Manila vertical slice (2 weeks)

**Goal:** one campus, end to end, through the real pipeline. Everything after this is repetition.

### Tasks

**1.1 Ingestion core**
- `fetcher.ts` — full FETCH_POLICY (TDD §3.2): robots cache, conditional GET, per-domain queue, exponential backoff
- `pipeline.ts` — the 10 stages
- `reconcile.ts` — natural-key diff, `change_events`, `miss_count`
- `guard.ts` — TDD §3.5 verbatim
- Snapshot writer → Supabase Storage

**1.2 Manual collection (do this first, it unblocks parsing)**
- Open each robots-blocked Manila page in a browser, save complete HTML into `fixtures/manual/manila/`
- Pages: undergraduate programs, graduate programs, student handbook, scholarships, admission procedure, colleges
- Write `MANIFEST.json` per file: `url`, `collected_at`, `collected_by`, `sha256`
- Register as `sources` rows with `method = 'manual'`

**1.3 Manila adapter**
- `discover()` — explicit list: open `/page/*` routes + manual sources. **No recursive crawling.**
- `parse()` — cheerio selectors for `academic_units`, `program_offerings`, campus metadata
- `expectations` populated (TDD §4.1)
- Answer open question Q2: is `/page/*` authoritative or abandoned? Document the finding in the adapter README.

**1.4 Program registry matching**
- Alias matching chain: exact → normalized → trigram ≥ 0.85 → unmatched
- Unmatched offerings written with `program_id = NULL`, listed by a `pnpm ingest:unmatched` report
- Manually resolve into `seeds/programs.yaml` — expect a real hour of work here

**1.5 Fixtures and tests**
- Golden fixture per entity type
- Guard unit tests
- Zod round-trip tests

**1.6 API endpoints**
- `/v1/units`, `/v1/programs`, `/v1/offerings/{campus}/{program}`, `/v1/campuses/{campus}/programs`
- Filtering, cursor pagination, `min_confidence`
- ETag + `Cache-Control`

### Exit criteria
- [ ] `GET /v1/campuses/manila/programs` returns real programs with correct `provenance`
- [ ] **Manual spot-check: 10 random programs verified against the source page.** Do this personally; it is the only real correctness check at this stage.
- [ ] Guard demonstrably quarantines when you break a selector on purpose
- [ ] Zero unmatched offerings, or all documented
- [ ] `pnpm ingest --adapter=manila` runs clean twice in a row, second run mostly 304s

---

## Phase 2 — Multi-campus (2–3 weeks)

**Goal:** prove the schema. If ADR-002/003 were right, each campus is a `parse()` function and zero migrations.

### Tasks

**2.1 Cavite adapter**
- Routes per TDD §4.2
- `unit_type = 'department'` — **the case that validates ADR-002**
- Investigate Q3 (shared CMS with Manila?). If confirmed, extract shared selectors into `packages/adapters/shared-cms`
- `/news/{id}` — discover IDs from the index, never increment blindly

**2.2 Visayas adapter**
- Routes per TDD §4.3
- `unit_type = 'college'`, 3 units
- Rich extras: `officials` with photos, `bid-opportunities`, `jobs` → `announcements` categories

**2.3 Taguig stub**
- Adapter with `discover()` yielding nothing
- Weekly liveness probe workflow; opens an issue on first 200

**2.4 Cross-campus reconciliation**
- Expand `seeds/programs.yaml` to cover all three campuses' degrees
- **Expect genuine ambiguity** — Cavite's "BET major in Automotive Engineering Technology" vs Manila's BET variants. Resolve deliberately; document decisions in the seed file as comments.
- `GET /v1/programs/{slug}` with `offerings[]`

**2.5 Coverage reporting**
- `GET /v1/meta/coverage` — entity counts per campus, per type
- Per-campus, never aggregate (ADR-012)

### Exit criteria
- [ ] `GET /v1/programs/bsce` returns offerings from Manila, Cavite, Visayas with correctly differing `unit.type`
- [ ] Zero schema migrations were required to add campuses 2 and 3 — **if this failed, the schema was wrong; fix it now, not later**
- [ ] Full run across all adapters < 30 min
- [ ] Taguig present with honest `unavailable` status

---

## Phase 3 — Documents and RAG (2 weeks)

### Tasks

**3.1 PDF ingestion**
- `unpdf` extraction with heading detection
- Manila handbook (2013 Revised), Cavite handbook, citizen's charters
- `documents.edition` and `effective_date` populated — **non-negotiable**, this is what prevents 2013 rules being served as current

**3.2 Chunker**
- TDD §3.6, heading-aware
- `context_header` construction
- Fixture tests on chunk boundaries

**3.3 Embeddings**
- `text-embedding-3-small` (1536d)
- Hash-gated: only re-embed changed chunks
- Batch, with retry

**3.4 Search**
- `GET /v1/search` — RRF hybrid (TDD §5.4)
- `POST /v1/rag/query` — evidence only, never synthesis
- `GET /v1/documents/{slug}/sections`

**3.5 Retrieval evaluation**
- Write 25 real student questions with expected source sections
- Measure recall@5. Target ≥0.8.
- **Explicitly test the cross-campus confusion case:** ask a Cavite question, assert no Manila handbook chunk ranks first

### Exit criteria
- [ ] "What is the maximum residency rule at TUP Manila?" returns the correct section with `heading_path`, `source_url`, and edition
- [ ] recall@5 ≥ 0.8 on the eval set
- [ ] Cross-campus contamination test passes
- [ ] Re-running embeddings with no content change costs zero API calls

---

## Phase 4 — Agent surface and DX (2 weeks)

### Tasks

**4.1 MCP server** — 6 tools (TDD §5.8), published install instructions, recommended system prompt showing `check_freshness` usage

**4.2 TypeScript SDK** — generated from `openapi.json`, camelCase conversion, typed errors, published to npm

**4.3 Documentation site** — Scalar or Mintlify; quickstart, entity guide, every endpoint with runnable examples, "understanding provenance" page, adapter-authoring guide

**4.4 `llms.txt`** — plain-text capability summary at the root

**4.5 API keys** — self-serve form (email + project description), Redis-backed rate limits

**4.6 Freshness dashboard** — `GET /v1/meta/freshness` + a simple public HTML page

### Exit criteria
- [ ] **A student who has never spoken to you makes a successful call within 5 minutes of landing on the docs.** Test this with an actual person.
- [ ] Claude Desktop connects to the MCP server and answers a TUP question with citations
- [ ] `npm i @<org>/tup-api` works

---

## Phase 5 — Operations and handover (ongoing)

### Tasks

**5.1 Change feed** — `GET /v1/changes?since=`, cursor over `(occurred_at, id)`

**5.2 Monitoring** — Sentry, uptime check on `/v1/health`, three alerts only (see ops doc §4)

**5.3 Runbooks** — write before you need them (ops doc §5)

**5.4 Handover** — org-owned repo, second maintainer with deploy access, `CONTRIBUTING.md` with the adapter guide and the slug-stability rule, recorded walkthrough

**5.5 Corrections queue (deferred)** — `POST /v1/corrections` with human review. Never direct writes.

### Exit criteria
- [ ] Second maintainer has independently shipped an adapter fix
- [ ] All runbooks written
- [ ] Backup restore tested from snapshots

---

## Critical path

```
0.2 DB → 0.3 schema → 0.5 API skeleton ─────────────┐
                                                     ├→ 1.6 endpoints → 2.4 cross-campus → 3.4 search
1.1 ingest core → 1.2 manual → 1.3 Manila adapter ──┘
```

`1.2 manual collection` blocks the most and is pure human work with no dependencies. **Do it in week 1, in parallel with Phase 0.**

---

## Anti-patterns to avoid

| Anti-pattern | Why it kills the project |
|---|---|
| Building all four adapters before any API endpoint | You will not discover schema flaws until all four are written, and then all four need rework |
| Scraping the campus list | Four rows. Type them. |
| Skipping the guard "until it's needed" | It is needed the first time a site changes, and by then data is gone |
| Fixed-window chunking "for now" | Retrieval quality problems are invisible until they harm a user |
| Deferring provenance to v2 | It is a column on every table. Retrofitting means rewriting every adapter. |
| Auto-creating canonical programs from fuzzy matches | Produces near-duplicate degrees that are painful to merge later |
| Adding one more entity type before Phase 1 exits | Depth over breadth until the pipeline is proven |
