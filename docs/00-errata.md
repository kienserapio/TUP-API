# 00 — Errata and Correction Register

**Created:** 2026-08-20
**Applies to:** doc set v2.0
**Status:** open — items are closed by amending the referenced document and ticking the box

This register records every defect found in the v2.0 doc set during pre-build review, with the evidence that established it. It exists because several defects are **schema-level and cheap to fix now, expensive to fix after migration 001 ships.**

Severity:

| Level | Meaning |
|---|---|
| **BLOCKER** | Must be fixed before writing migration 001 or the first adapter. Fixing later means a data migration or a rewrite. |
| **HIGH** | Must be fixed before the phase that depends on it. Will cause incorrect behaviour or a false launch claim. |
| **MEDIUM** | Should be fixed before public launch. Causes cost, DX, or accuracy problems, not corruption. |

Verdict up front: **the architecture is sound and the project is feasible. The schema has seven fixable defects, the ingestion design rests on one false premise about the source sites, and the timeline is roughly 2–2.5× optimistic.** Nothing found requires an architectural rethink.

---

## Blockers

### E1 — `confidence_level` enum is declared in an order that inverts every comparison

- [ ] Fix in [`03-TDD.md §2.2`](./03-TDD.md), superseded by [`10-data-dictionary.md`](./10-data-dictionary.md)

**Defect.** The TDD declares:

```sql
CREATE TYPE confidence_level AS ENUM ('high', 'medium', 'low');
```

Postgres orders enum values **by declaration order**. As declared, `'high' < 'medium' < 'low'`. Therefore the documented `min_confidence=medium` filter, implemented naturally as `WHERE confidence >= 'medium'`, returns **medium and low** — the exact opposite of what [`06-consumer-guide.md`](./06-consumer-guide.md) promises.

**Why this is a blocker.** Enum value order cannot be changed after creation. `ALTER TYPE ... ADD VALUE ... BEFORE` exists, but re-ordering existing values does not. Fixing this after migration 001 requires creating a new type, rewriting every column that uses it, and dropping the old one — across nine tables.

**Fix.** Declare ascending:

```sql
CREATE TYPE confidence_level AS ENUM ('low', 'medium', 'high');
```

Then `min_confidence` is the plain `confidence >= $1`, and `MIN(confidence)` in the collection envelope's `meta.freshness.min_confidence` means what it says.

---

### E2 — Conditional GET is unavailable on all three live campuses; the 304 design cannot work

- [ ] Fix in [`03-TDD.md §3.2`](./03-TDD.md), [`05-deployment-and-operations.md §5.2`](./05-deployment-and-operations.md)

**Defect.** [`03-TDD.md §3.2`](./03-TDD.md) builds the fetcher around `If-None-Match` / `If-Modified-Since` and states:

> On a site this static, **most runs should be all-304s.** If they are not, the conditional headers are wrong — treat that as a bug.

[`05-deployment-and-operations.md §5.2`](./05-deployment-and-operations.md) reinforces it:

> `ingest_sources_304_total{adapter}` — should be HIGH — low means conditional GET is broken

**Evidence (2026-08-20).** None of the three live campuses emits a cache validator.

| Campus | `ETag` | `Last-Modified` | `Cache-Control` | Server |
|---|---|---|---|---|
| Manila | absent | absent | absent | `Sucuri/Cloudproxy` |
| Cavite | absent | absent | absent | `nginx` |
| Visayas | absent | absent | `no-cache, private` | `cloudflare` |

A server that sends no validator can never return `304`. The metric would sit at zero forever, and the runbook instructs the operator to treat that as a bug — sending them to debug code that is working correctly.

**Fix.** Invert the mechanism: **content-hash gating, not validator gating.**

1. Send `If-None-Match` / `If-Modified-Since` opportunistically when the last snapshot recorded a validator. Handle `304` correctly if it ever arrives — Cavite or Visayas may add one later.
2. Otherwise fetch the full body, compute `content_hash`, and compare to the newest snapshot for that source.
3. On hash match: treat as **verified-unchanged** — bump `last_verified_at` on entities from that source, reset `miss_count`, do **not** create a new snapshot row, and skip parse/publish/chunk/embed.
4. Rename the metric `ingest_sources_unchanged_total`, counting both `304` and hash-match. That metric *should* be high; the ops interpretation survives, its mechanism does not.

**Consequence.** Bandwidth saving is lost — every run downloads every page (~45–100 KB each, a few hundred pages, so single-digit MB per run). Parse, embed, and write savings are preserved, which is where the actual cost is. The politeness budget in `FETCH_POLICY` is unaffected.

---

### E3 — Reconcile and guard are adapter-scoped while fetching is source-scoped; every healthy incremental run quarantines

- [ ] Fix in [`03-TDD.md §3.4, §3.5`](./03-TDD.md)

**Defect.** Three statements in the TDD are individually reasonable and jointly broken:

1. §3.2 — a source whose content is unchanged "skips the rest of the pipeline".
2. §3.4 — reconcile matches "incoming against current", and "records present in DB but absent from the parse increment `miss_count`".
3. §3.5 — `guard(entityType, incoming, currentCount, expectations)` compares `incoming.length` against `currentCount`.

**Failure.** Consider a healthy Cavite run where 9 of 10 sources are unchanged and one news page changed:

- `incoming` contains only the records parsed from the one changed source — say 3 announcements.
- `currentCount` is the adapter-wide total — say 40 announcements.
- `guard` evaluates `40 >= 10 && 3 < 40 * 0.7` → **quarantine, "count dropped 40→3 (>30%)"**.

And in reconcile, the 37 announcements from the unchanged sources are "absent from the parse", so each takes `miss_count += 1`. Three such runs and **every one of them flips to `status = 'removed'`.**

This fires on the *second* run — the first run has nothing unchanged. It presents as the anomaly guard working, which makes it slow to diagnose.

**Fix.** Scope reconcile and guard to the sources actually parsed in the run.

```ts
export function guard(
  entityType: EntityType,
  incoming: unknown[],
  currentCount: number,      // count of rows whose source_id ∈ parsedSourceIds
  expectations?: { min: number; max: number },
): GuardResult
```

- `reconcile` computes `miss_count` only over rows where `source_id IN (parsedSourceIds)`.
- Unchanged sources are **verified**, not missing: bump `last_verified_at`, reset `miss_count` to 0.
- `expectations` in the adapter are declared as **full-run** ranges, so they may only be applied on a full run — a run where every source of that entity type was parsed. Skip the expectations check on partial runs and record why.
- Add `--full` to the ingest CLI to force-parse every source regardless of hash, so expectations get exercised on the daily 02:00 run.

See [`10-data-dictionary.md`](./10-data-dictionary.md) for the `ingest_runs` columns that record which sources a run covered.

---

### E4 — `uuidv7()` does not exist on Supabase Postgres

- [ ] Fix in [`03-TDD.md §1.1, §2.2`](./03-TDD.md), [`04-implementation-plan.md §0.2`](./04-implementation-plan.md)

**Defect.** Every table in [`03-TDD.md §2`](./03-TDD.md) declares `id uuid PRIMARY KEY DEFAULT uuidv7()`. The stack table names Postgres 16.

**Evidence.** `uuidv7()` became a built-in in **PostgreSQL 18** (released September 2025). Supabase currently offers **Postgres 15 and 17**, with 17 as the current version; Postgres 14 support ends 1 July 2026. Postgres 17 ships `gen_random_uuid()` (v4) only. The stack table's "Postgres 16" is also wrong — 16 is not offered.

The implementation plan half-catches this ("polyfill function if PG version lacks it") but the DDL is written as though it exists, so migration 001 as specified fails on the first statement.

**Fix.** Ship a SQL polyfill in migration 000, before any table:

```sql
-- UUIDv7 per RFC 9562. Replace with the built-in when Supabase ships Postgres 18.
CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$
  SELECT encode(
    substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
    || substring(gen_random_bytes(10) FROM 1 FOR 10),
    'hex')::uuid
$$ LANGUAGE sql VOLATILE;
```

Then overwrite the version bits (4 → 7) and variant bits, or use the `pg_uuidv7` extension if it is on the Supabase extension allowlist — **check this in Phase 0.2, it is not guaranteed to be.** Whichever route is chosen, add a test asserting that two ids generated a millisecond apart sort in creation order; that time-ordering is the entire reason for choosing v7 over v4.

Correct the stack table to **Postgres 17**.

---

### E5 — The canonical hostnames in the docs are the ones that do not work

- [ ] Fix in [`README.md`](./README.md), [`01-PRD.md §1`](./01-PRD.md), [`03-TDD.md §4`](./03-TDD.md), [`06-consumer-guide.md`](./06-consumer-guide.md)

**Defect.** Manila and Cavite each have a working host and a broken one, and the docs pick the broken one for both.

**Evidence (2026-08-20).**

| URL | Result |
|---|---|
| `https://tup.edu.ph/` | **200**, consistently |
| `https://www.tup.edu.ph/` | **intermittent** — `SSL_ERROR_SYSCALL` on one run, 200 on the next |
| `https://tupcavite.edu.ph/` | **403** — nginx static page, `Last-Modified: 29 Apr 2021` |
| `https://www.tupcavite.edu.ph/` | **200** |

So Manila must be addressed at the **apex** and Cavite at **`www`** — the reverse of what the docs use. Manila's `www` is not reliably dead, which is worse than dead: it works often enough to look fine in manual testing and fails often enough to break scheduled runs. [`03-TDD.md §5.2`](./03-TDD.md) prints a sample payload citing `https://www.tup.edu.ph/pages/admission/undergraduate-programs`, and [`06-consumer-guide.md`](./06-consumer-guide.md) repeats it. That URL does not load over HTTPS. Since `provenance.source_url` is the project's central trust claim, shipping dead citation links defeats the feature.

**Fix.** Record a canonical host per campus in the source landscape doc and derive `sources.url` from it; never hand-write a host. Add a fixture-independent unit test asserting every `sources.url` uses its campus's canonical host. See [`08-source-landscape.md`](./08-source-landscape.md).

---

### E6 — `announcements.slug` and `documents.slug` are globally unique in a multi-campus system

- [ ] Fix in [`03-TDD.md §2.4`](./03-TDD.md), superseded by [`10-data-dictionary.md`](./10-data-dictionary.md)

**Defect.**

```sql
CREATE TABLE announcements ( ... slug text UNIQUE NOT NULL, ... );
CREATE TABLE documents    ( ... slug text UNIQUE NOT NULL, ... );
```

`scholarships` correctly uses `UNIQUE (campus_id, slug)`. These two do not.

**Failure.** Manila's student handbook and Cavite's student handbook both slug to `student-handbook`. The second one to be published violates the constraint and the transaction aborts, taking the whole publish with it. This is not a maybe — [`04-implementation-plan.md §3.1`](./04-implementation-plan.md) ingests both handbooks in the same phase. Announcements are worse: `enrollment-advisory`, `enrollment-schedule`, `holiday-advisory` will collide across campuses within weeks.

The endpoints `GET /v1/documents/{slug}` and `GET /v1/announcements/{slug}` assume the global uniqueness that causes the bug.

**Fix.** `UNIQUE (campus_id, slug)` on both, plus a globally unique `ref` (see E7) which becomes the URL identifier:

```
GET /v1/documents/{campus}/{slug}
GET /v1/announcements/{campus}/{slug}
```

Keep `GET /v1/documents/{slug}` as a 301 to the campus-qualified form when exactly one campus has that slug, and a 404 with `did_you_mean` listing the campus-qualified refs when more than one does. That preserves DX without the constraint.

---

### E7 — `ref` is the documented public identifier but does not exist anywhere

- [ ] Fix in [`03-TDD.md §2.1`](./03-TDD.md), superseded by [`10-data-dictionary.md`](./10-data-dictionary.md)

**Defect.** [`03-TDD.md §2.1`](./03-TDD.md) declares:

> **Public identifiers:** `slug` … and `ref` (fully-qualified path, e.g. `manila/coe/bscpe`).

`ref` then appears in the sample single-resource payload, and `slug_aliases` is keyed on `(entity_type, old_ref)`, and `change_events.entity_ref` stores one. But **no table has a `ref` column**, no grammar defines its shape per entity type, and nothing generates it.

Left unresolved this breaks three things: the `slug_aliases` contract in PRD C5, the `GET /v1/changes` feed (consumers cannot resolve `entity_ref` back to a resource), and the E6 fix above.

**Fix.** Define `ref` as a Postgres **generated column** per entity type, with a documented grammar. Full grammar and DDL in [`10-data-dictionary.md §3`](./10-data-dictionary.md). Summary:

| Entity | `ref` grammar | Example |
|---|---|---|
| campus | `{campus}` | `manila` |
| academic_unit | `{campus}/{slug}` | `cavite/engineering` |
| program | `{slug}` | `bsce` |
| program_offering | `{campus}/{program_slug}` | `manila/bsce` |
| office | `{campus}/{slug}` or `system/{slug}` | `visayas/library` |
| official | `{campus}/{office_slug}/{name_slug}` | `visayas/registrar/j-dela-cruz` |
| announcement | `{campus}/{slug}` | `visayas/enrollment-advisory` |
| document | `{campus}/{slug}` | `manila/student-handbook` |
| scholarship | `{campus}/{slug}` | `manila/tupstat` |

Note the sample payload's `manila/coe/bscpe` includes the unit. **Reject that form** — an offering can move between units, and `ref` must be stable (PRD C5). The unit belongs in the payload body, not the identifier.

---

## High

### E8 — The hybrid search query defeats the HNSW index, under-returns, full-scans, and drops the filters ADR-008 was justified on

- [ ] Fix in [`03-TDD.md §5.4`](./03-TDD.md)

Four separate defects in one query.

**(a) The window function prevents the index scan.** In

```sql
SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $1) AS rank
FROM chunks WHERE (...) ORDER BY embedding <=> $1 LIMIT 50
```

the window function is evaluated over the entire filtered set before `LIMIT` applies, so the planner must sort every qualifying row and cannot use the HNSW index for the ordering. Rank in an outer query over an inner `ORDER BY … LIMIT` subquery instead.

**(b) Post-filtering under-returns.** `WHERE campus_slug = $2` is applied after the index scan. pgvector's own troubleshooting is explicit that HNSW results are bounded by `hnsw.ef_search` (default 40) and that filtering, dead tuples, and unindexed NULL/zero vectors all reduce the count further. A `LIMIT 50` with a campus filter will routinely return far fewer than 50 candidates, silently degrading recall — and the retrieval eval in Phase 3.5 would blame the chunker. Set `hnsw.iterative_scan = strict_order` (pgvector ≥ 0.8) or raise `hnsw.ef_search` per query.

**(c) The outer query scans the whole table.** `FROM chunks c LEFT JOIN vec … LEFT JOIN lex … WHERE v.id IS NOT NULL OR l.id IS NOT NULL` reads all of `chunks` to discard everything not in the two 50-row CTEs. Drive from `SELECT id FROM vec UNION SELECT id FROM lex` and join `chunks` to that.

**(d) It omits the filters that justified the architecture.** [`02-ADRs.md ADR-008`](./02-ADRs.md) rejects a dedicated vector database specifically because:

> hybrid retrieval requires joining vector scores against lexical scores **and filtering by `campus_slug` and `confidence`.** With pgvector that is one SQL query.

`confidence` and staleness appear nowhere in the query. `POST /v1/rag/query` accepts `min_confidence` per [`03-TDD.md §5.5`](./03-TDD.md) and it is not implemented in the retrieval SQL. Add both predicates to **each** CTE, not the outer query, or they will not narrow the index scan.

Corrected query in [`10-data-dictionary.md §7`](./10-data-dictionary.md).

---

### E9 — Confidence decay is the product's core claim and is specified nowhere

- [ ] Fix — resolved by new doc [`09-freshness-and-confidence.md`](./09-freshness-and-confidence.md)

**Defect.** Confidence decay is asserted in five places and defined in none:

- [`01-PRD.md`](./01-PRD.md) F28 — "Confidence auto-downgrades on staleness, via scheduled job"
- [`02-ADRs.md ADR-004`](./02-ADRs.md) — "staleness thresholds differ per entity type; **encoding that judgment server-side is the value-add**"
- [`05-deployment-and-operations.md §4`](./05-deployment-and-operations.md) — a daily 03:00 "Confidence decay" cron
- [`06-consumer-guide.md`](./06-consumer-guide.md) — a confidence table and an agent prompt keyed to "staleness exceeds 180 days"
- [`03-TDD.md`](./03-TDD.md) — a `confidence` column with per-table defaults, and no rules

ADR-004 names this the value-add. The number 180 appears once, in a recommended prompt, unexplained and unconnected to any threshold in the system. There is no table of per-entity thresholds, no definition of `staleness_days`, no statement of whether decay is reversible, and no rule for what the initial confidence should be as a function of `sources.method`.

Without it, Phase 0 cannot set defaults correctly, adapters cannot "set `confidence` deliberately" as ADR-004 requires, and the launch criterion "≥70% of entities at `confidence = 'high'`" is unmeasurable.

**Fix.** [`09-freshness-and-confidence.md`](./09-freshness-and-confidence.md) specifies the initial-confidence matrix, per-entity decay thresholds, the `staleness_days` definition, reversibility, the `min_confidence` filter semantics, and the `/v1/meta/freshness` response shape.

---

### E10 — Manila sits behind a Sucuri WAF, with intermittent HTTP/2 failures

- [ ] Fix in [`03-TDD.md §3.2, §4.1`](./03-TDD.md), [`08-source-landscape.md`](./08-source-landscape.md)

**Evidence (2026-08-20).** `Server: Sucuri/Cloudproxy`, `X-Sucuri-ID: 18012`, `X-Sucuri-Cache: HIT`/`EXPIRED`. Across two verification runs, one request out of roughly eight failed with `curl: (16) Error in the HTTP2 framing layer`, and a dedicated 3-attempt stability check passed cleanly. The same edge also produced an intermittent TLS handshake failure on `www` (E5). Forced HTTP/1.1 has not failed.

**Consequences.**

1. **Bot-block risk.** Sucuri is a WAF that fingerprints and rate-limits automated clients. The honest `TUPOpenDataBot/1.0` UA currently returns 200 — verified — but that is a policy Sucuri's operator can change without notice, and it is far more likely to be challenged than a browser UA. This is a live risk to the Manila adapter that the docs do not mention.
2. **Intermittent transport faults.** The retry policy in `FETCH_POLICY` absorbs these, but retries multiply request volume against a WAF that counts requests, and an intermittent fault is the kind that gets misattributed to the parser. Pin `tup.edu.ph` to HTTP/1.1 in the fetcher (`undici` `allowH2: false` for that origin) and keep the retries.

**Fix.** Per-origin transport overrides in the fetcher config; treat a Manila 403 as a first-class runbook case (RB-08) distinct from RB-02 "site down", because the remedy is different — a 403 means convert Manila to `method = 'manual'`, not wait for recovery.

---

### E11 — Visayas now serves Cloudflare AI-crawler directives, including an explicit `ai-train=no`

- [ ] Fix in [`07-governance-and-distribution.md §1.3`](./07-governance-and-distribution.md), [`08-source-landscape.md`](./08-source-landscape.md)

**Evidence (2026-08-20).** `tupvisayas.edu.ph/robots.txt` is Cloudflare-managed and contains:

```
User-agent: *
Content-Signal: search=yes,ai-train=no,use=reference
Allow: /

User-agent: Amazonbot        Disallow: /
User-agent: Applebot-Extended Disallow: /
User-agent: Bytespider        Disallow: /
User-agent: CCBot             Disallow: /
User-agent: ClaudeBot         Disallow: /
User-agent: CloudflareBrowserRenderingCrawler  Disallow: /
User-agent: Google-Extended   Disallow: /
User-agent: GPTBot            Disallow: /
User-agent: meta-externalagent Disallow: /
```

The file also declares these signals to be express reservations of rights under Article 4 of EU Directive 2019/790.

**Why it matters.** This did not exist in the 2026-08-19 survey and it lands directly on the project's positioning. Read literally, `TUPOpenDataBot` is not named, `User-agent: *` is `Allow: /`, and the crawl is permitted. Read for intent, TUPV has switched on AI-crawler blocking, and a project whose headline feature is an MCP server for AI agents is in visible tension with that.

The signals themselves are actually favourable on inspection: `search=yes` permits indexing, `use=reference` permits AI systems to consume the content as reference, and `ai-train=no` prohibits training — which this project does not do. `ai-input` (RAG, grounding, retrieval) is **unspecified**, meaning neither granted nor restricted.

**This is a decision for the project owner, not a defect to be silently patched.** The register's recommendation:

1. Comply with every signal literally and record compliance in `sources`: add `content_signal` to the sources table, parsed and stored per domain.
2. Never use ingested content to train or fine-tune a model, and say so in `LICENSE-DATA` and `llms.txt`.
3. State the position openly in the governance doc rather than relying on `User-agent: *` as a technicality.
4. Treat Visayas as the campus most likely to become manual-only. If Cloudflare's AI-bot WAF rule is enabled — a checkbox, not a code change — the adapter starts receiving 403s regardless of robots compliance.

Add a fetcher check: parse `Content-Signal` for every domain on every robots fetch, store it, and **fail the run loudly if a signal changes** rather than continuing. A silently-appearing `ai-input=no` should stop the Visayas pipeline, not be discovered later.

---

### E12 — Manila's robots.txt does not exist; the premise under C2, ADR-013 and Phase 1.2 is not currently true

- [ ] Fix in [`01-PRD.md §3 C2`](./01-PRD.md), [`03-TDD.md §3.3, §4.1`](./03-TDD.md), [`04-implementation-plan.md §1.2`](./04-implementation-plan.md); new ADR-016

**Defect.** The doc set states repeatedly that Manila's `/pages/*` tree — which holds programs, scholarships, and the handbook — is disallowed in `robots.txt`, and builds the manual-collection subsystem ([`03-TDD.md §3.3`](./03-TDD.md)), the `method = 'manual'` source type, ADR-013's rationale, and the critical-path task 1.2 on top of it.

**Evidence (2026-08-20).**

```
https://tup.edu.ph/robots.txt      → 302 → http://www.tup.edu.ph/404error.php
https://www.tup.edu.ph/robots.txt  → 302 → http://www.tup.edu.ph/404error.php
```

There is no `robots.txt` on either host. Per RFC 9309, an unavailable robots.txt means a crawler may access any resource. And the supposedly-blocked pages are directly fetchable:

```
https://tup.edu.ph/pages/students/student-scholarship        → 200, 44,452 bytes
https://tup.edu.ph/pages/admission/undergraduate-programs    → 200, 42,842 bytes
```

Cavite serves no robots.txt either — 404 on `www`, a Synology NAS 404 page on the apex.

**What this does and does not change.**

- It does **not** change ADR-013's decision. "No institutional permission sought" stands on its own reasoning.
- It does **not** mean the manual subsystem should be deleted. `method = 'manual'` is the fallback for E10 (Sucuri 403) and E11 (Cloudflare AI-blocking), both of which are live risks. Build it; it is cheap and it is the disaster recovery path.
- It **does** change the critical path. [`04-implementation-plan.md`](./04-implementation-plan.md) says "1.2 manual collection blocks the most … Do it in week 1." If Manila is crawlable, task 1.2 is no longer a blocker, and Phase 1 gets meaningfully shorter.
- It **does** mean the fetcher must handle *appearance* of a robots.txt gracefully. A site that has none today can have one tomorrow. RB-03 already covers this; make sure the robots cache treats "absent" as a cached fact with a 24h TTL, not as a permanent grant.

**Required action before Phase 1: re-verify, and record the result with a date.** Two readings are possible — the source sites changed since 2026-08-19, or the original survey was mistaken. Both are worth knowing, because one of them says the docs' other verified claims need re-checking too. See [`08-source-landscape.md`](./08-source-landscape.md) and the `verify-sources.sh` script beside it.

---

### E13 — Taguig returns HTTP 200, so the liveness probe fires immediately and permanently

- [ ] Fix in [`02-ADRs.md ADR-012`](./02-ADRs.md) via ADR-017, [`05-deployment-and-operations.md §4`](./05-deployment-and-operations.md)

**Defect.** [`02-ADRs.md ADR-012`](./02-ADRs.md) and the ops schedule specify a weekly probe that opens a GitHub issue "on first 200".

**Evidence (2026-08-20).**

```
https://tupt.edu.ph/  →  200, after redirect to /cgi-sys/suspendedpage.cgi
```

Taguig is **not 404 and not offline**. It is a cPanel-suspended account, and the suspension notice is served with a `200 OK`. The probe as specified opens an issue on its first run and every run thereafter.

**Also worth noting:** "suspended" is a materially different diagnosis from "404". A suspension is a billing or hosting-policy matter that is typically resolved in days or weeks, not an abandoned domain. R3 in the PRD rates "Taguig stays offline indefinitely" as High likelihood / Low impact; a suspension makes recovery more likely than that implies, and the adapter more likely to be needed.

**Fix.** The probe must assert liveness on content, not status:

```
live  ⟺  HTTP 200
      ∧  final URL does not match /cgi-sys/suspendedpage\.cgi|suspended|account.suspended/i
      ∧  response body > 5 KB
      ∧  body does not match /suspended|coming soon|under construction|parked/i
```

Record the probe result in `sources` as `status` plus a `probe_note`, so the transition from `suspended` → `active` is a visible data change rather than a log line. Update the `campuses.website_status` value for Taguig from `unavailable` to a new `suspended` value — the distinction is real and worth publishing, since it tells a student "this campus's site is temporarily down" rather than "this campus has no web presence."

---

### E14 — The staleness alarm is scheduled by the mechanism whose silent failure it exists to detect

- [ ] Fix in [`05-deployment-and-operations.md §4, §5.3`](./05-deployment-and-operations.md)

**Defect.** [`01-PRD.md §7`](./01-PRD.md) names the project's primary anti-metric:

> **Silent staleness:** median `last_verified_at` drifting past 30 days = the ingestion is dead and nobody noticed.

The defence is ops alert #3, "any source stale >2× its recrawl interval". Both the ingestion and that alert run on GitHub Actions cron. If GitHub Actions stops running the schedule, ingestion stops **and so does the alarm**, producing exactly the failure the anti-metric names.

This is not hypothetical. GitHub disables scheduled workflows after **60 days of repository inactivity**, and scheduled runs are delayed or dropped under load — they carry no delivery guarantee. A project in maintenance mode after the author graduates hits the 60-day rule as a matter of course. R5 ("project dies at graduation") and this defect are the same failure.

**Fix.** The heartbeat must be external to the thing it watches.

1. Every successful ingestion run pings an external heartbeat monitor (Better Stack Heartbeats, Healthchecks.io — both have adequate free tiers). The monitor alerts on *absence* of a ping, so it fires when GitHub Actions stops.
2. Add `GET /v1/health` fields `last_successful_ingest_at` and `hours_since_ingest`, and have the existing external uptime check assert `hours_since_ingest < 36`. This costs nothing — the uptime check already exists for alert #2 — and it means the API itself reports its own staleness.
3. Add a `keepalive` workflow, or accept the 60-day rule and note in the runbook that any 60-day quiet period requires manually re-enabling schedules.

Item 2 is the important one: it makes staleness visible to **consumers**, not just operators, which is consistent with the rest of the trust model.

---

### E15 — Tables and types referenced by requirements but absent from the schema

- [ ] Fix — resolved by [`10-data-dictionary.md`](./10-data-dictionary.md)

| Missing | Referenced by | Consequence |
|---|---|---|
| `procedures` table | PRD F10; Cavite `/admission` and Visayas `/admissions/enrollment-procedure` rows in [`03-TDD.md §4`](./03-TDD.md) route tables | Two adapters have a declared output entity with no destination |
| `api_keys` table | [`03-TDD.md §5.7`](./03-TDD.md) tiers; [`04-implementation-plan.md §4.5`](./04-implementation-plan.md) self-serve form | Phase 4 cannot be built |
| `EntityType` enumeration | `SourceRef.entityTypes`, `ParseResult.byEntity`, `chunks.entity_type`, `change_events.entity_type`, `guard()` | Core typed contract has no member list; nothing is type-safe |
| `run_id` on `snapshots`, `change_events`, `quarantine` | [`05-deployment-and-operations.md §5.1`](./05-deployment-and-operations.md) "run_id propagated through all stages"; RB-04 | The bad-data runbook cannot answer "what else did that run change?" |
| Response schemas for `/v1/meta/freshness`, `/v1/meta/sources`, `/v1/meta/coverage`, `/v1/changes` | [`03-TDD.md §5.3`](./03-TDD.md) endpoint list; PRD F20, F21 | Four public endpoints with no contract; OpenAPI cannot be generated |

---

### E16 — `programs` carries no provenance, contradicting F25 and F26

- [ ] Fix — resolved by [`10-data-dictionary.md`](./10-data-dictionary.md)

**Defect.** PRD F25 requires *every canonical row* to store `source_id`, `content_hash`, `first_seen_at`, `last_verified_at`, `confidence`. F26 requires every response to echo provenance by default. The `programs` table has only the two timestamps — no `source_id`, no `confidence`.

`GET /v1/programs/bsce` is the flagship endpoint. As specified it cannot populate the `provenance` block that [`03-TDD.md §5.2`](./03-TDD.md) shows on every single-resource response.

**Fix.** Add the full provenance set to `programs`, with `method = 'seed'` and `confidence = 'high'` — the canonical registry is hand-curated, which is a *stronger* provenance claim than a scrape, not a weaker one. Seed sources get a synthetic `sources` row (`method='seed'`, `url='seed://programs.yaml'`) so the FK is satisfied and the response is honest about where the fact came from.

---

## Medium

### E17 — Fly.io has no free tier; the cost projection is wrong

- [ ] Fix in [`05-deployment-and-operations.md §2.2`](./05-deployment-and-operations.md)

The cost table lists "Fly.io API — $0 (free allowance)" and a launch total of ≈₱60/mo. Fly.io **removed the free tier for new accounts in October 2024**; new accounts get trial credit, then pay-as-you-go. A `shared-cpu-1x` 256 MB machine is roughly $1.94/mo always-on; the specified 2× 512 MB API plus 1× 256 MB MCP is closer to **$8–10/mo**.

Revised launch estimate ≈ **₱600–900/mo**, still inside the PRD N8 budget of ₱1,500. Two cheap reductions worth taking:

- Run the MCP server as a route on the API app rather than a second deployment. It is a thin adapter over the same endpoints; a separate machine buys nothing at this scale and doubles the deploy surface.
- Use one API machine with `auto_stop_machines`, with Cloudflare absorbing cached reads. N9 (cold start <1s) is met by Fly's wake time for a small Node image, and [`05-deployment-and-operations.md §2.1`](./05-deployment-and-operations.md)'s "no cold starts on the read path" argument was made against Vercel edge, not against Fly autostop.

### E18 — "Snapshots retained indefinitely" versus a 1 GB free storage tier

- [ ] Fix in [`05-deployment-and-operations.md §8`](./05-deployment-and-operations.md), [`03-TDD.md §2.2`](./03-TDD.md)

Supabase's free tier includes 1 GB of storage. Observed page sizes are 42–98 KB; a few hundred pages is roughly 20–40 MB per full crawl. With E2's content-hash gating most runs store nothing new, so the growth is modest — but "immutable and never deleted" plus no stated compression or dedupe will still cross 1 GB, and snapshots are named the single irreplaceable asset.

Fix: gzip before upload (5–10× on HTML), key storage objects by `content_hash` so identical content is stored **once** across all sources and runs, and let `snapshots` rows reference the shared key. Add a monthly job reporting total snapshot bytes to the freshness dashboard.

### E19 — Supabase's transaction-mode pooler breaks prepared statements

- [ ] Fix in [`03-TDD.md §1.1`](./03-TDD.md), [`04-implementation-plan.md §0.2`](./04-implementation-plan.md)

Supavisor in transaction mode does not support prepared statements. Drizzle over `postgres.js` prepares by default and will fail intermittently against the pooled port. Document both connection strings explicitly in `.env.example`:

- **API on Fly** — session-mode pooler or direct connection, prepared statements fine.
- **Ingest on GitHub Actions** — transaction-mode pooler with `prepare: false`, because runners are ephemeral and would otherwise exhaust the connection budget.

This is a twenty-minute problem to fix at the start and a confusing intermittent failure to diagnose later.

### E20 — Embedding model is simultaneously an open question and a committed decision

- [ ] Fix in [`01-PRD.md §9 Q4`](./01-PRD.md), [`03-TDD.md §2.5`](./03-TDD.md)

PRD Q4 lists "Which embedding model?" as open, needed by Phase 3. [`03-TDD.md §2.5`](./03-TDD.md) hardcodes `vector(1536)` and defaults `embedding_model` to `text-embedding-3-small`; [`04-implementation-plan.md §3.3`](./04-implementation-plan.md) commits to it. Close Q4 or make the column dimension-agnostic.

Two related notes. `vector(1536)` prevents ever switching to a different-dimension model without a table rewrite — if the decision is genuinely open, either store the dimension in the column type per model via separate columns, or accept 1536 and close Q4. And [`02-ADRs.md ADR-010`](./02-ADRs.md)'s "no LLM API key or inference cost in the API's operating budget" is true of the **API** and false of **ingestion**, which needs an embedding provider key. Say so, and add it to the secrets inventory.

### E21 — `did_you_mean` has no index to support it

- [ ] Fix in [`10-data-dictionary.md`](./10-data-dictionary.md)

The 404 helper is specified as "one trigram query" and is called out as disproportionately good DX. Only `programs.name` has a `gin_trgm_ops` index. The helper is needed on slugs — `programs.slug`, `academic_units.slug`, `announcements.slug`, `documents.slug`, `offices.slug`, `scholarships.slug` — none of which are indexed for trigram. Without them each 404 is a sequential scan.

### E22 — English text-search configuration over a Filipino–English corpus

- [ ] Fix in [`03-TDD.md §5.4`](./03-TDD.md)

`to_tsvector('english', …)` and `plainto_tsquery('english', …)` are used for the lexical half of hybrid search and for the announcements index. The corpus mixes English and Filipino, and [`03-TDD.md §5.4`](./03-TDD.md) correctly identifies the queries that matter as exact institutional terms — `TUPSTAT`, `BTVTEd`, `Form 5`, `COPC`. English stemming does nothing useful for those and actively mangles some. Use the `simple` configuration for the lexical CTE, or add a trigram-similarity third leg to the RRF fusion. Decide with the Phase 3.5 eval set rather than by assertion.

### E23 — The timeline is roughly 2–2.5× optimistic

- [ ] Fix in [`04-implementation-plan.md`](./04-implementation-plan.md)

Phases 0–4 are budgeted at 9–10 weeks at 10–15 h/wk, i.e. **100–150 hours**. Reconciled against the task lists:

| Phase | Planned | Realistic | Driver |
|---|---|---|---|
| 0 | 12 h | 25–35 h | 17 tables, dual Zod/Drizzle definitions, seeds, CI/CD, first Fly deploy, plus the uuidv7 polyfill (E4) |
| 1 | 25 h | 50–70 h | Fetcher with robots cache + per-origin transport + hash gating, 10-stage pipeline, reconcile with field-level diff, storage writer, first adapter, registry matching, fixtures, 4 endpoints |
| 2 | 30 h | 30–40 h | On target if Phase 1's core is genuinely reusable |
| 3 | 25 h | 35–45 h | PDF heading extraction is the wildcard; the eval set alone is 6–8 h |
| 4 | 25 h | 40–55 h | Docs site and SDK are each larger than they look |
| **Total** | **~130 h** | **180–245 h** | |

At 12 h/wk that is **15–20 weeks**, not 9–10. The plan is not wrong about *sequence* — the phase ordering and the exit-artifact discipline are the strongest part of the document — only about duration. Two things make the estimate hold better than a flat multiplier would suggest: E12 may remove the manual-collection blocker from the critical path, and the per-campus adapter work in Phase 2 genuinely is repetition if Phase 1 is done properly.

Recommendation: keep the phases, restate the estimates, and treat **Phase 2's exit criterion — zero schema migrations needed to add campuses 2 and 3 — as the real go/no-go gate.** If that criterion fails, the schema is wrong and every subsequent estimate is void.

### E24 — Every deployable identifier is still a placeholder

- [ ] Fix — resolved by [`12-build-prerequisites.md`](./12-build-prerequisites.md)

`<domain>`, `<org>`, `<contact-email>`, `<takedown-email>` appear throughout. These are not cosmetic: they block the OpenAPI `servers` block, the `User-Agent` string that the politeness posture depends on (`FETCH_POLICY.userAgent` embeds a contact URL), the `NOTICE` and attribution text, the MCP server URL, and the npm scope. PRD Q5 (org name) is the upstream decision and is marked "before public launch" — it is actually needed **before Phase 0**, because the repo has to live somewhere.

### E25 — `change_events` grows without bound and has no retention policy

- [ ] Fix in [`10-data-dictionary.md`](./10-data-dictionary.md)

`bigserial` with one row per field-level change per entity per run, feeding a public `GET /v1/changes?since=` feed. Fine for a year; unbounded thereafter, and it is on the free tier's 500 MB database. Specify a retention window (12 months) plus a monthly partition or a scheduled delete, and document the window in the consumer guide so sync clients know how far back they can resume.

---

## Not defects — verified correct

Recorded so they are not re-litigated:

- **ADR-002** (`unit_type` discriminator) and **ADR-003** (canonical/offering split) are the right calls, and Cavite's department vocabulary was confirmed live at `www.tupcavite.edu.ph/dept/engineering`.
- **ADR-006**'s quarantine-over-publish stance is correct and the guard thresholds are sensible — the defect in E3 is scoping, not policy.
- **ADR-009** cursor pagination, **ADR-010** evidence-not-answers, **ADR-015** heading-aware chunking: all sound, no changes.
- **PRD C1** (personal-data boundary) is correctly specified as architectural rather than policy, and the CI enforcement described is the right shape.
- The `to_tsvector('english', title || ' ' || coalesce(summary,''))` expression index on `announcements` is valid — the two-argument form with a literal config is `IMMUTABLE` and indexable. Only the choice of `english` is questioned, in E22.
- `campuses.parent_slug REFERENCES campuses(slug)` is valid; `slug` carries a `UNIQUE` constraint, which is what a foreign key requires.
- Visayas was confirmed live, Laravel-shaped, and the best-structured of the three, exactly as documented.
