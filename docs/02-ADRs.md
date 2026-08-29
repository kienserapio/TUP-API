# 02 — Architecture Decision Records

Each ADR records a decision that was genuinely contested, the alternatives considered, and the consequences accepted. ADRs are immutable once `Accepted`; to change one, write a new ADR that supersedes it.

**Format:** Context → Decision → Alternatives → Consequences.

| # | Decision | Status |
|---|---|---|
| [001](#adr-001) | Normalized store as the primary artifact; API and RAG are both views | Accepted |
| [002](#adr-002) | `academic_units` with a type discriminator, not per-campus tables | Accepted |
| [003](#adr-003) | Split canonical `programs` from `program_offerings` | Accepted |
| [004](#adr-004) | Provenance on every row, echoed in every response | Accepted |
| [005](#adr-005) | Adapters own parsing only; fetching is centralized | Accepted |
| [006](#adr-006) | Anomaly guard with quarantine, not best-effort publish | Accepted |
| [007](#adr-007) | Hono + Zod + Drizzle over NestJS or Next.js route handlers | Accepted |
| [008](#adr-008) | Postgres + pgvector, not a dedicated vector database | Accepted |
| [009](#adr-009) | Cursor pagination, not offset | Accepted |
| [010](#adr-010) | RAG returns evidence, never a synthesized answer | Accepted |
| [011](#adr-011) | Facebook/social sources excluded from v1 | Accepted |
| [012](#adr-012) | Taguig modeled as a first-class campus with no live source | Accepted |
| [013](#adr-013) | No institutional permission sought before launch | Accepted |
| [014](#adr-014) | Monorepo with separately deployable apps | Accepted |
| [015](#adr-015) | Heading-aware chunking, not fixed-window | Accepted |
| [016](#adr-016) | Crawl Manila's full tree; keep manual collection as the fallback path | Accepted |
| [017](#adr-017) | Model source availability as four states, not a boolean | Accepted |

---

<a id="adr-001"></a>
## ADR-001 — The normalized store is the product; API and RAG are both views over it

**Status:** Accepted

### Context
The initial framing was "build an API, or do RAG if an API isn't possible." That is a false dichotomy. Both require the same expensive prerequisite: extracting messy multi-site HTML into clean, typed, deduplicated records. Once that exists, exposing REST is trivial and exposing a retriever is trivial.

### Decision
Build the normalized Postgres store first. Treat the REST API, the hybrid search endpoint, the RAG endpoint, and the MCP server as four thin views over one substrate.

### Alternatives
- **RAG-only, embed raw HTML.** Cheapest to start. Rejected: cannot answer "how many programs does COE offer" (counting is not retrieval), cannot power a filtered UI dropdown, and cannot deduplicate a degree across campuses.
- **API-only, no RAG.** Rejected: the handbook is 200+ pages of prose. Modeling every rule as a row is absurd; retrieval is the right tool for prose.

### Consequences
- (+) One extraction effort serves all consumers.
- (+) Facts come from SQL (exact); prose comes from retrieval (approximate). Each tool used where it is strong.
- (−) Higher upfront cost than a naive RAG prototype. Phase 1 exists to keep that cost bounded.

---

<a id="adr-002"></a>
## ADR-002 — One `academic_units` table with a `unit_type` discriminator

**Status:** Accepted

### Context
The four campuses use three different organizational vocabularies:

| Campus | Vocabulary | Examples |
|---|---|---|
| Manila | **Colleges** (6) | COE, CIT, CAFA, COS, CLA, CIE |
| Visayas | **Colleges** (3) | COAC, COE, COET |
| Cavite | **Departments** (5) | Engineering, Industrial Technology, Industrial Education, Liberal Arts, Math & Science |
| Taguig | Unknown | — |

A `colleges` table forces a lie about Cavite. Per-campus tables (`manila_colleges`, `cavite_departments`) make cross-campus queries impossible.

### Decision
Single `academic_units` table with:
- `unit_type` enum: `college | department | institute | center | program_group`
- `parent_id` self-reference, so a department nested inside a college is representable
- `UNIQUE (campus_id, slug)`

### Alternatives
- **Table-per-type.** Rejected: no cross-campus query, and a new campus vocabulary means a migration.
- **Force everything to "college".** Rejected: publishes false information about Cavite's actual structure.
- **Fully generic EAV.** Rejected: destroys type safety for no gain at this cardinality.

### Consequences
- (+) A new campus with a novel vocabulary is a new enum value, not a migration.
- (+) `GET /v1/units?type=college` works system-wide.
- (−) Consumers must handle `unit_type` rather than assuming "college". Documented prominently.

---

<a id="adr-003"></a>
## ADR-003 — Split canonical `programs` from `program_offerings`

**Status:** Accepted

### Context
"BS Civil Engineering" is offered at Manila, Cavite, and Visayas. It is *one degree* with three campus-specific instances differing in majors, department, accreditation, and status. A flat `programs` table forces either three duplicate rows (breaking "where can I study X?") or one row that loses per-campus detail.

### Decision
Two tables:
- `programs` — the canonical, campus-agnostic degree. Keyed by a global slug (`bsce`).
- `program_offerings` — the instance at a campus. `UNIQUE (program_id, campus_id)`. Holds `unit_id`, `majors[]`, `status`, `accreditation`, `local_name`.

### Alternatives
- **Flat table with a campus column.** Rejected: cross-campus comparison requires fuzzy name matching at query time.
- **Programs owned by units.** Rejected: makes the canonical degree a derived concept, so name variants across campuses can never be reconciled.

### Consequences
- (+) `GET /v1/programs/bsce` → the flagship query, returning all offerings. This is the single clearest demonstration of the project's value.
- (+) Name variants (`local_name`) are captured without fragmenting the degree.
- (−) Requires a **canonical program registry** — a hand-maintained mapping of source name variants to canonical slugs. This is real ongoing work and is why v1 seeds it manually rather than inferring it.

---

<a id="adr-004"></a>
## ADR-004 — Provenance on every row, echoed in every response by default

**Status:** Accepted

### Context
The Manila scholarship page cites 2006 figures. The handbook is the 2013 edition. Some Visayas news is from last week. All four render with identical visual authority, and none of the sites expose a "last updated" date.

A consumer — especially an AI agent — cannot distinguish current fact from nineteen-year-old fact. A wrong answer about scholarship eligibility or a disciplinary sanction causes real harm to a student.

### Decision
Every canonical row carries `source_id`, `content_hash`, `first_seen_at`, `last_verified_at`, `confidence`. Every API response includes a `provenance` object **in the default payload** — not behind `?include=provenance`, not in a debug mode.

A scheduled job downgrades `confidence` as entities pass staleness thresholds.

### Alternatives
- **Provenance behind an opt-in flag.** Rejected: defaults are what actually get used. An opt-in trust signal is a trust signal nobody sees.
- **A single global "last updated" timestamp.** Rejected: hides that programs are fresh while fees are nineteen years old.
- **Omit confidence, expose only timestamps.** Rejected: staleness thresholds differ per entity type; encoding that judgment server-side is the value-add.

### Consequences
- (+) Agents can be instructed to decline: *"refuse to assert when `staleness_days > 180` or `confidence != 'high'`; cite the source and refer the student to the office."* Impossible without this.
- (+) Enables `/v1/meta/freshness` — a public dashboard of TUP's own content decay. Genuinely useful to UITC.
- (+) Enables `change_events` and incremental sync for free.
- (−) ~15% payload overhead. Acceptable; gzip absorbs most of it.
- (−) Every adapter must set `confidence` deliberately. Enforced in the adapter checklist.

---

<a id="adr-005"></a>
## ADR-005 — Adapters own `discover` and `parse`; fetching is centralized

**Status:** Accepted

### Context
Politeness, robots compliance, conditional requests, retries, and backoff are cross-cutting correctness *and* legal concerns. If each campus adapter implements its own fetching, one careless adapter gets the whole project IP-blocked or crawling a disallowed path.

### Decision
`CampusAdapter` exposes only `discover(): AsyncIterable<SourceRef>` and `parse(snapshot): ParseResult`. The shared `core/fetcher.ts` owns all network I/O and enforces C2/C3 from the PRD. `parse` is a **pure function** — no network, no `Date.now()`, no randomness.

### Alternatives
- **Adapters fetch their own pages.** Rejected: makes compliance unenforceable and parsers untestable.
- **A base class adapters extend.** Rejected: inheritance permits overriding the safety layer. Composition does not.

### Consequences
- (+) robots and rate limits are structurally unbypassable, not merely documented.
- (+) `parse` purity makes fixture-based golden testing possible — the single highest-value test category here.
- (+) Swapping `crawl` → `manual` source method changes nothing in any adapter.
- (−) Adapters needing multi-step fetches (form POST, pagination discovery) must express that in `discover()`. Acceptable; none currently need it.

---

<a id="adr-006"></a>
## ADR-006 — Anomaly guard with quarantine, never best-effort publish

**Status:** Accepted

### Context
The canonical scraper failure is silent: a site redesign changes a selector, the parser returns `[]`, the pipeline cheerfully publishes an empty result over good data, and nobody notices until a user reports missing programs weeks later.

### Decision
Between reconcile and publish, a `guard()` stage compares incoming record counts against current state and per-adapter `expectations`. It quarantines on: zero rows where rows previously existed; a >30% drop; a >2× increase; or counts outside the declared expected range. Quarantine **preserves existing data**, writes the parsed result to a quarantine table, opens a GitHub issue, and alerts Sentry.

Removals require **3 consecutive misses** before `status = 'removed'`. One miss sets `status = 'unknown'`.

### Alternatives
- **Publish whatever parses; monitor after.** Rejected: by the time monitoring catches it, the good data is gone and only snapshots can restore it.
- **Manual approval on every run.** Rejected: unsustainable, and the whole point is automation.
- **Alert but publish anyway.** Rejected: the failure mode is data loss; alerting after the loss is not mitigation.

### Consequences
- (+) A site redesign degrades to "data goes stale" rather than "data disappears." Stale-with-a-timestamp is dramatically better than absent.
- (+) Quarantine incidents become fixtures, so the test suite accumulates a record of every redesign survived.
- (−) Legitimate large changes (a campus genuinely adding 20 programs) require manual approval. Correct trade-off — that is exactly when a human should look.

---

<a id="adr-007"></a>
## ADR-007 — Hono + Zod + Drizzle, not NestJS or Next.js route handlers

**Status:** Accepted

### Context
The API is read-mostly, ~20 endpoints, and must publish a machine-readable contract that external developers depend on.

### Decision
- **Hono** with `@hono/zod-openapi`
- **Zod** as the single source of truth for validation, TS types, and the OpenAPI document
- **Drizzle** for SQL-transparent queries and migration-first schema management

### Alternatives
- **NestJS.** Known to the team, but DI and decorators buy little for 20 read endpoints, and OpenAPI generation is a separate annotation pass that drifts from reality.
- **Next.js route handlers.** Rejected: couples API availability to UI deploys, and an API traffic spike would take down the student platform. Independent deployability matters here.
- **Prisma.** Good DX, but generates opaque SQL and handles pgvector poorly. Drizzle's SQL transparency matters when tuning HNSW queries.
- **FastAPI (Python).** Excellent OpenAPI story, but splits the stack and forfeits shared types with the TS SDK and student platform.

### Consequences
- (+) The OpenAPI document is *generated from the code that runs*, so it cannot drift. For a public API this is worth more than DI ergonomics.
- (+) One Zod schema serves DB validation, request validation, response typing, and the published SDK.
- (−) Smaller ecosystem than NestJS. Acceptable at this size.

---

<a id="adr-008"></a>
## ADR-008 — Postgres + pgvector, not a dedicated vector database

**Status:** Accepted

### Context
The RAG layer needs vector similarity search. Options include Pinecone, Weaviate, Qdrant, or pgvector inside the existing Postgres.

### Decision
pgvector with an HNSW index, in the same Postgres instance as the canonical data.

### Alternatives
- **Pinecone / managed vector DB.** Rejected: a second datastore to keep consistent, extra cost, and — decisively — **hybrid retrieval requires joining vector scores against lexical scores and filtering by `campus_slug` and `confidence`.** With pgvector that is one SQL query. Across two systems it is application-level join logic with no transactional consistency.
- **Qdrant self-hosted.** Rejected: same split-brain problem plus ops burden.

### Consequences
- (+) Retrieval can filter by campus, confidence, and staleness in the same query as the similarity search. This is exactly what the trust model requires.
- (+) One backup, one migration path, one connection pool.
- (−) pgvector at very large scale is slower than specialists. Irrelevant here — the corpus is thousands of chunks, not millions.

---

<a id="adr-009"></a>
## ADR-009 — Cursor pagination

**Status:** Accepted

### Context
Collections need pagination. Offset (`?page=2&limit=25`) is the obvious choice.

### Decision
Cursor pagination. Opaque base64url cursor encoding `{last_sort_value, last_id}`. Responses carry `links.next` and `meta.has_more`.

### Alternatives
- **Offset.** Rejected on two grounds: `OFFSET n` is `O(n)` in Postgres and degrades at depth; and it silently duplicates or skips rows when the underlying set changes between page fetches — which happens on every ingestion run.

### Consequences
- (+) Stable results even mid-ingestion. `O(log n)` at any depth.
- (−) No "jump to page 7". Acceptable — no consumer use case needs it.
- (−) Cursors must be treated as opaque. Documented explicitly, since developers will try to decode them.

---

<a id="adr-010"></a>
## ADR-010 — `POST /v1/rag/query` returns cited evidence, never a synthesized answer

**Status:** Accepted

### Context
It is tempting to have the RAG endpoint call an LLM and return prose. Consumers would find that convenient.

### Decision
The endpoint returns ranked chunks with `content`, `heading_path`, `source_url`, `last_verified_at`, `confidence`, and both retrieval scores. The caller's model does the reasoning.

### Alternatives
- **Return a generated answer.** Rejected for three reasons: (1) it makes this project responsible for being wrong about a student's scholarship eligibility; (2) it imposes a model choice and inference cost on every consumer; (3) it converts a cacheable deterministic read into a non-deterministic expensive one.

### Consequences
- (+) Responsibility for the assertion stays with the consumer, who has the user context to calibrate it.
- (+) Deterministic and cacheable.
- (+) No LLM API key or inference cost in the API's operating budget.
- (−) Consumers must do one more step. The MCP server and SDK make it a one-liner.

---

<a id="adr-011"></a>
## ADR-011 — Facebook and social sources excluded from v1

**Status:** Accepted

### Context
Campus USG and administration Facebook pages are, in practice, where the most timely student-facing announcements appear — often before (or instead of) the official websites. Including them would materially improve the product.

Verified state of Meta's platform as of 2026:
- Reading another Page's public posts requires the **Page Public Content Access** feature, gated behind App Review.
- App Review requires a Business-type app and **business verification** with legal documents — which a student project does not have.
- The `metadata=1` introspection parameter was removed across all Graph API versions on 2026-05-19; v18.0 expired 2026-01-26 and v19.0 on 2026-05-21. The platform is actively closing off public read access.
- **Meta Content Library**, the CrowdTangle successor, permits this kind of research access but requires *institutional* verification — an accredited research affiliation, not an individual.
- The one clean path is a **Page access token**, which requires being an admin of the Page in question.

### Decision
Excluded from v1. Model the capability in the schema (`sources.method` already supports `partner_feed`) but implement nothing.

The only endorsed future path: **a campus USG voluntarily grants Page admin access or runs a lightweight publisher that pushes their posts to the API.** That is an opt-in partnership, not an integration.

### Alternatives
- **Third-party scraping services (Apify et al.).** Rejected: violates Meta's ToS, breaks whenever Facebook changes markup, carries ongoing cost, and puts the project in an adversarial posture that undermines the open, above-board positioning everything else is built on.
- **Headless-browser scraping in-house.** Rejected for the same reasons, plus maintenance burden.
- **Apply for App Review anyway.** Rejected: requires business verification the project cannot satisfy.

### Consequences
- (−) The most current announcements remain outside the API. Acknowledged gap; documented publicly so consumers are not misled.
- (+) The project stays entirely within terms of service, which protects the open-data positioning.
- (+) A concrete, dignified ask exists for USGs who want in: give the project a Page token, or push to it.

---

<a id="adr-012"></a>
## ADR-012 — Taguig is a first-class campus with no live source

**Status:** Accepted

### Context
`tupt.edu.ph` returns 404. The campus exists, enrolls students, and is linked from all three sibling sites.

### Decision
Model Taguig as a full `campuses` row with `source_status = 'unavailable'`. Populate what is knowable from sibling references (name, location, existence) with `confidence = 'low'` and `method = 'seed'`. Any Taguig-related content on `tup.edu.ph` is attributed to the Taguig campus with Manila as the source.

Add a scheduled liveness probe on `tupt.edu.ph`; when it returns 200, open an issue to build the adapter.

### Alternatives
- **Omit Taguig.** Rejected: an API claiming system-wide coverage that silently drops a campus is worse than one that says "this campus has no source."
- **Merge Taguig into Manila.** Rejected: factually wrong, and would corrupt offering data.

### Consequences
- (+) The API can honestly report *"Taguig exists; we have no current source"* — more useful than silence.
- (+) Validates the schema's handling of partial coverage, which will recur.
- (−) Coverage metrics must be reported per campus, not as one aggregate.

---

<a id="adr-013"></a>
## ADR-013 — No institutional permission sought before launch

**Status:** Accepted

### Context
An earlier draft made writing to UITC a pre-launch step. The project owner has chosen to build independently.

### Decision
No permission is sought. The project operates entirely within what is available without it:
- Open routes are crawled politely.
- robots-blocked routes are **manually collected** by a human and imported as `method = 'manual'`. Automated crawling of those paths stays off.
- A takedown contact is published and honored within 48h.

Permission becomes relevant only if automated crawling of blocked routes is later wanted. The `sources.method` enum makes that a one-line config change, so nothing needs redesigning.

### Alternatives
- **Seek permission first.** Rejected by the owner. It is also not legally required for public government content, and a working artifact is a stronger opener than a proposal if that conversation ever happens.
- **Crawl blocked routes anyway.** Rejected: gratuitous, risks an IP block, and abandons the good-faith posture for marginal convenience.

### Consequences
- (+) No external dependency, no waiting.
- (−) Blocked-route data requires periodic manual refresh. Mitigated by keeping the manual set small (handbook, programs, scholarships) and low-churn.
- (−) Some IP-block risk remains. Politeness limits make it unlikely and snapshots make it recoverable.

---

<a id="adr-014"></a>
## ADR-014 — Monorepo, separately deployable apps

**Status:** Accepted

### Decision
One pnpm workspace containing `apps/api`, `apps/ingest`, `apps/mcp`, and shared `packages/*`. Each app deploys independently.

### Alternatives
- **Separate repos.** Rejected: the Zod schema is shared by all three; separate repos means versioned internal packages and constant lockstep releases.
- **One deployable.** Rejected: ingestion is a scheduled batch job with different scaling and failure characteristics than a latency-sensitive read API. A long crawl must never affect API latency.

### Consequences
- (+) Schema changes propagate atomically with type errors at compile time.
- (+) Ingestion cannot degrade API availability.
- (−) Requires workspace tooling discipline (Turborepo for build caching).

---

<a id="adr-015"></a>
## ADR-015 — Heading-aware chunking, not fixed-window

**Status:** Accepted

### Context
The student handbook and policy documents are long prose with meaningful section structure. Fixed-token chunking splits mid-rule.

### Decision
Chunk on `h2`/`h3` boundaries. Record `heading_path` as an array. Split oversized sections on paragraph boundaries, repeating the path. Merge undersized sections with the next sibling. Prepend a context header to the embedded text:

```
TUP Manila · Student Handbook (2013 Revised) · Academic Policies › Maximum Residency Rule
```

### Alternatives
- **Fixed 512-token windows with overlap.** Rejected: returns half a disciplinary rule, which for this content is actively dangerous.
- **Whole-document embedding.** Rejected: retrieval granularity far too coarse.

### Consequences
- (+) Retrieved chunks are semantically complete rules, not fragments.
- (+) The context header preserves *which campus and which edition* — essential in a multi-campus corpus where the same rule differs by campus, and the top failure mode is confidently returning a Manila 2013 rule for a Cavite question.
- (+) `heading_path` gives consumers a breadcrumb to display.
- (−) Requires reliable heading extraction from PDFs. Handled per-document with fixtures.

---

<a id="adr-016"></a>
## ADR-016 — Crawl Manila's full tree; keep manual collection as the fallback path

**Status:** Accepted
**Amends the factual premise of:** [ADR-013](#adr-013). ADR-013's *decision* is unchanged.

### Context

ADR-013, PRD C2, [`03-TDD.md §3.3`](./03-TDD.md), and critical-path task [`04-implementation-plan.md §1.2`](./04-implementation-plan.md) all rest on one factual claim: that Manila's `/pages/*` tree — holding programs, scholarships, and the handbook — is disallowed in `robots.txt`, and must therefore be collected by hand.

Re-verification on 2026-08-20 found that claim is not currently true.

```
https://tup.edu.ph/robots.txt      → 302 → http://www.tup.edu.ph/404error.php
https://www.tup.edu.ph/robots.txt  → 302 → http://www.tup.edu.ph/404error.php
```

There is no `robots.txt` on either host; per RFC 9309 an unavailable robots.txt permits access to any resource. The supposedly-blocked pages return 200 and full content. Cavite serves no `robots.txt` either. Full evidence in [`08-source-landscape.md`](./08-source-landscape.md) and [`00-errata.md`](./00-errata.md) E12.

Two readings are possible — the site changed, or the original survey was mistaken — and we cannot distinguish them after the fact. Both matter, because one of them implies the other verified claims in the v2.0 docs need re-checking too.

### Decision

1. **Crawl `/pages/*` and `/page/*` as ordinary `method = 'crawl'` sources.** They are publicly served, not disallowed, and no directive says otherwise.
2. **Build the manual-collection subsystem anyway, in Phase 1, exactly as [`03-TDD.md §3.3`](./03-TDD.md) specifies.** It is no longer the path for Manila, but it is the disaster-recovery path for two live risks: a Sucuri WAF block on Manila, and Cloudflare AI-bot blocking on Visayas ([`08-source-landscape.md §3.1`, `§5.1`](./08-source-landscape.md)).
3. **Demote task 1.2 from the critical path.** It no longer blocks Manila parsing.
4. **Treat robots absence as a cached fact with a 24-hour TTL, never a standing grant.** `sources.robots_present` records the distinction. If a `robots.txt` appears, RB-03 runs and the affected sources convert to manual or are dropped.
5. **Re-verify the landscape on a schedule.** `scripts/verify-sources.sh`, before each phase and monthly, with output committed to `docs/verification/`.

### Alternatives

- **Keep manual collection for Manila regardless.** Rejected: it imposes recurring human work and a 120-day staleness floor to honour a directive that does not exist. Manual collection is a workaround, not a virtue.
- **Delete the manual subsystem now that nothing needs it.** Rejected, and this is the more tempting error. Two campuses sit behind infrastructure that can block automated clients with a configuration change. Deleting the fallback would mean rebuilding it under pressure, in an incident, which is when it will be needed.
- **Treat the discrepancy as a doc typo and move on.** Rejected: if the sites changed within a day of being surveyed, that is a fact about how fast this landscape moves, and it argues for the scheduled re-verification in point 5.

### Consequences

- (+) Manila's highest-value pages are automatically refreshed rather than manually refreshed each semester. Freshness on programs, scholarships, and the handbook improves from ~120 days to ~1 day.
- (+) Phase 1 gets shorter; the pure-human task that blocked the most is no longer blocking.
- (+) The re-verification script turns "we checked once" into a repeatable, committed, diffable record.
- (−) Manila's two live generations are now both crawled, so the conflict-resolution rule in [`03-TDD.md §4.1`](./03-TDD.md) — "prefer the manual copy" — no longer refers to anything. Replaced by: **where `/page/*` and `/pages/*` disagree, `/pages/*` wins, and the losing value is recorded in the `change_events` diff** so the divergence stays visible. Open question Q2 remains and is now more urgent.
- (−) A `robots.txt` may appear at any time and silently narrow what is permitted. Mitigated by point 4 and by RB-03.
- (=) **ADR-013 stands unchanged.** No permission is sought; the good-faith posture, the honest user-agent, the politeness limits, and the 48-hour takedown SLA are all unaffected. Only the mechanics of one campus's ingestion changed.

---

<a id="adr-017"></a>
## ADR-017 — Model source availability as four states, not a boolean

**Status:** Accepted
**Refines:** [ADR-012](#adr-012)

### Context

ADR-012 models Taguig as a first-class campus with `source_status = 'unavailable'`, and specifies a weekly liveness probe that opens an issue "on first 200".

Verification on 2026-08-20 shows Taguig is not what the doc assumed:

```
https://tupt.edu.ph/  → 302 → https://tupt.edu.ph/cgi-sys/suspendedpage.cgi → 200, 8,257 bytes
```

The site is a **cPanel-suspended account, and the suspension notice is served with HTTP 200.** So the probe as written fires on its first run and every run after — a permanently-crying alarm, which is worse than no alarm.

The suspension also changes the diagnosis. PRD R3 rates "Taguig stays offline indefinitely" as High likelihood / Low impact. A suspension is a billing or hosting-policy matter, typically resolved in days or weeks — recovery is meaningfully more likely than "indefinitely offline" implies, and the Taguig adapter more likely to be needed.

### Decision

1. Add `suspended` to `source_status`, distinct from `unavailable`. Taguig is `suspended`.
2. Liveness is asserted on **content, not status code**:

```
live  ⟺  HTTP 200
      ∧  ¬ final_url ~* '/cgi-sys/suspendedpage\.cgi|suspended'
      ∧  byte_size > 5120
      ∧  ¬ body ~* 'suspended|coming soon|under construction|parked'
```

3. Probe results are recorded in `sources.status` and `sources.probe_note`, so a state transition is a visible data change rather than a log line.
4. `campuses.website_status` publishes the distinction through the API.

### Alternatives

- **Probe on HTTP 200 alone.** Rejected: demonstrably wrong here, and wrong for every parked-domain and holding-page case it will meet later.
- **Probe for a known-good string in the real site.** Rejected: there is no real site to sample yet, so there is nothing to assert against.
- **Keep one `unavailable` state and put the detail in `notes`.** Rejected: the distinction is publishable and useful. *"This campus's site is temporarily down"* and *"this campus has no web presence"* are different facts, and a student reading the API deserves the accurate one.

### Consequences

- (+) The probe stays quiet until something genuinely changes, which is the only condition under which anyone will still trust it in a year.
- (+) The same predicate generalises: any campus can enter `suspended` after a hosting lapse, and RB-02 gains a state that fits what actually happens to small institutional sites.
- (+) The API reports a more accurate fact about Taguig than "unavailable" did.
- (−) One more enum value and a slightly more complex probe. Both trivial.

