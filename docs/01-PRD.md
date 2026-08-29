# 01 — Product Requirements Document

**Project:** TUP Open Data API (`tup-open-api`)
**Status:** Draft v2
**Owner:** Kien Leriss Ramos Serapio
**Last updated:** 2026-08-19

---

> [!IMPORTANT]
> **Amended 2026-08-20.** Constraint **C2** is built on a premise that no longer holds: Manila and Cavite currently serve no `robots.txt`, so nothing relevant is blocked. C2's *policy* stands — robots is respected mechanically wherever it exists — but the manual-collection workaround is now a fallback, not the primary path for Manila. Q4 (embedding model) also conflicts with a decision already made in the TDD. See [`00-errata.md`](./00-errata.md) E12, E20 and [ADR-016](./02-ADRs.md#adr-016).

## 1. Problem statement

TUP operates four campuses. Each publishes public institutional data on its own website, built on a different stack, with a different information architecture, at a different level of currency.

**Verified state of the world, 2026-08-19:**

- **Manila** (`tup.edu.ph`) runs a legacy PHP CMS with *two generations live simultaneously* — the `/page/*` routes and the `/pages/*` routes render different content with different visitor counters. The newer `/pages/*` tree, which holds programs, scholarships, and the student handbook, is disallowed in `robots.txt`. The Student Scholarship page cites grant figures from 2006. The handbook is the 2013 Revised edition.
- **Cavite** (`tupcavite.edu.ph`) is a modern build with clean, guessable routes (`/dept/{slug}`, `/office/{slug}`, `/news/{id}`). It organizes academics into five **departments**.
- **Visayas** (`tupvisayas.edu.ph`) is a Laravel application, the best-structured of the four, with slug-based routes and dedicated `/officials`, `/announcements`, `/bid-opportunities`, and `/jobs` sections. It organizes academics into three **colleges**.
- **Taguig** (`tupt.edu.ph`) currently returns 404. The campus exists and is linked from every sibling site, but has no live primary source.

### Consequences

1. **No student can answer a system-level question.** "Where in the TUP system can I study BS Civil Engineering, and how do the campuses differ?" requires manually visiting four sites with three different vocabularies.
2. **No developer can build on TUP data** without writing four scrapers and inventing a reconciliation model.
3. **Stale data is indistinguishable from current data.** A 2006 scholarship figure and a 2026 news post are presented with identical visual authority. Nothing on any site tells you when a page was last verified.
4. **Every downstream project re-solves the same problem.** Cavite built a chatbot (A.L.E.X.). Visayas built a chatbot (E-Mai). Both required independently solving ingestion for their own campus. Neither can answer a question about the other campus.

### The gap this fills

Cavite and Visayas each already ship a campus chatbot. **This project is deliberately not a fifth chatbot.** It is the missing layer *underneath* them: a normalized, cited, multi-campus data substrate that any interface — chatbot, student platform, mobile app, thesis project — can consume. The existing chatbots are evidence of demand, not competition.

---

## 2. Goals

### 2.1 Product goals

| ID | Goal | Measure |
|---|---|---|
| G1 | One query answers a system-wide question | `GET /v1/programs/{slug}` returns offerings across all campuses that have it |
| G2 | Every fact is traceable and dated | 100% of responses carry `source_url` + `last_verified_at` + `confidence` |
| G3 | Agents can consume it without an integration | Working MCP server + `llms.txt`, usable in under 5 minutes |
| G4 | Others build on it without asking permission | ≥3 external projects integrate within 6 months of public launch |
| G5 | It survives its author | ≥2 maintainers with deploy access; org-owned repo |

### 2.2 Non-goals

| Not doing | Why |
|---|---|
| A chatbot or assistant UI | Two campuses already have one. This is the layer below. |
| Personalized student data | Hard legal and ethical boundary. See §3. |
| Course-level curricula, syllabi, prerequisites | Per-campus, per-cohort, largely unpublished. Would consume the whole timeline for low coverage. |
| Class schedules, room assignments, section availability | Operational data, changes hourly, not public. |
| Writing data back to TUP systems | Out of scope permanently. |
| Being the "official" TUP API | Unofficial by default. If TUP later adopts it, great — designed to be handed over. |
| Monetization | Free and open. Affects licensing posture (§7 of governance doc). |

---

## 3. Hard constraints

### C1 — The personal data boundary

**No personal, authenticated, or student-identifying data. Ever.**

The API touches only content a logged-out visitor can read. Names and official contact details of officials acting in an official public capacity are in scope; everything about students is out.

*Rationale:* RA 10173 (Data Privacy Act) makes anyone processing personal data a personal information controller with registration, breach-notification, and consent obligations. A solo student project cannot discharge those. Crossing this line converts a low-risk open-data project into a serious legal exposure and forecloses running it openly.

*Enforcement:* no auth code in the ingestion layer; no credential fields in the schema; CI check rejecting any adapter that sends `Cookie` or `Authorization` headers.

### C2 — robots.txt is respected mechanically

Blocked paths are never crawled. They may be **manually collected** — a human reading a public page in a browser and saving it — and imported via a `method = 'manual'` source. This distinction is real: robots.txt directs automated agents; it is not an access control and does not bind a human reader.

*Enforcement:* the shared fetcher throws `RobotsDisallowedError`. No adapter can bypass it, because adapters do not own fetching.

### C3 — Politeness

Single concurrent request per domain, ≥3s delay, conditional requests (`If-None-Match`), off-peak scheduling (02:00–04:00 PHT), descriptive `User-Agent` with a contact URL.

### C4 — Read-only public surface

`GET` everywhere, plus one `POST /v1/rag/query` that performs no writes. No public write path in v1. Corrections go through a reviewed queue (deferred to Phase 5).

### C5 — Slug stability

A published slug never changes. Renames create a `slug_aliases` entry and a 301. This is a contract with consumers.

---

## 4. Users and jobs to be done

### U1 — The student platform (primary, you)

> *"I'm building a TUP student platform and I need a program browser with filters, a college directory, and an assistant that answers handbook questions with citations."*

Needs: fast filtered reads, stable pagination, a TS SDK, and RAG retrieval that returns evidence rather than prose.

### U2 — The AI agent

> *"A student asked whether they qualify for a scholarship. I need to look this up and know whether I can trust the answer."*

Needs: MCP tools, hybrid retrieval, and — critically — an explicit freshness signal so it can decline. An agent that cannot tell stale data from fresh data will state 2006 figures as current fact.

### U3 — The external student developer

> *"I'm doing a thesis / hackathon project and need TUP program data. I don't want to write a scraper."*

Needs: no-signup reads, a browsable docs site, copy-pasteable examples, and an OpenAPI spec their tooling can generate a client from.

### U4 — The prospective student (indirect)

> *"Which TUP campus offers Mechanical Engineering, and what does it cost?"*

Never touches the API directly. Reached through U1/U2/U3. Their needs shape which entities matter most: programs, offerings, admission procedure, fees.

### U5 — UITC / campus staff (indirect, later)

> *"Which of our published pages have gone stale?"*

The freshness dashboard is a genuine gift to them and the strongest asset in any future partnership conversation. Build it because it is useful; it also happens to be good diplomacy.

---

## 5. Functional requirements

Priority: **P0** = required for public launch · **P1** = required for "complete" · **P2** = nice to have.

### 5.1 Data coverage

| ID | Requirement | Priority |
|---|---|---|
| F1 | All 4 campuses represented as entities, including Taguig despite no live source | P0 |
| F2 | Academic units per campus, correctly typed (`college` / `department` / `institute`) and nestable | P0 |
| F3 | Canonical programs deduplicated across campuses, with per-campus offerings | P0 |
| F4 | Offices and services per campus | P1 |
| F5 | Current officials per campus | P1 |
| F6 | Announcements and news, per campus, with published dates | P1 |
| F7 | Documents (handbook, charter, transparency) with edition and effective date | P1 |
| F8 | Scholarships, flagged with low confidence where sources are stale | P1 |
| F9 | Fee estimates, flagged low confidence | P2 |
| F10 | Admission and enrollment procedures as structured steps | P2 |
| F11 | Bid opportunities and job postings (Visayas publishes these cleanly) | P2 |

### 5.2 API surface

| ID | Requirement | Priority |
|---|---|---|
| F12 | Versioned REST under `/v1`, JSON only, `snake_case` | P0 |
| F13 | Cursor pagination on every collection | P0 |
| F14 | Filtering by campus, level, unit, category, date range | P0 |
| F15 | RFC 9457 Problem Details errors, with `did_you_mean` on 404 | P0 |
| F16 | OpenAPI 3.1 generated from code, committed, CI-diffed | P0 |
| F17 | `ETag` / `If-None-Match` conditional responses | P1 |
| F18 | Hybrid search (BM25 + vector, RRF-fused) | P1 |
| F19 | `POST /v1/rag/query` returning cited chunks, never a synthesized answer | P1 |
| F20 | `GET /v1/changes?since=` incremental sync feed | P1 |
| F21 | `GET /v1/meta/freshness` public staleness report | P1 |
| F22 | MCP server exposing 6 tools incl. `check_freshness` | P1 |
| F23 | `llms.txt` capability summary | P2 |
| F24 | Published TypeScript SDK | P2 |

### 5.3 Trust and provenance

| ID | Requirement | Priority |
|---|---|---|
| F25 | Every canonical row stores `source_id`, `content_hash`, `first_seen_at`, `last_verified_at`, `confidence` | P0 |
| F26 | Every response echoes provenance **by default**, not behind a flag | P0 |
| F27 | Immutable raw snapshots retained for every fetch | P0 |
| F28 | Confidence auto-downgrades on staleness, via scheduled job | P1 |
| F29 | `change_events` diff log with queryable feed | P1 |
| F30 | Consumers can filter by `min_confidence` | P1 |

### 5.4 Ingestion safety

| ID | Requirement | Priority |
|---|---|---|
| F31 | Anomaly guard quarantines runs that drop >30%, double, or return zero | P0 |
| F32 | Quarantine never overwrites good data; opens an issue and alerts | P0 |
| F33 | Removals require 3 consecutive misses before `status = 'removed'` | P0 |
| F34 | Every adapter has committed HTML fixtures with expected JSON | P0 |
| F35 | Every quarantine incident adds a regression fixture | P1 |

---

## 6. Non-functional requirements

| ID | Requirement | Target |
|---|---|---|
| N1 | Read latency, warm cache | p95 < 100ms |
| N2 | Read latency, cold | p95 < 400ms |
| N3 | Availability | 99.5% monthly (≈3.6h downtime) |
| N4 | Crawl politeness | ≤1 concurrent req/domain, ≥3s delay |
| N5 | Full ingestion run | < 30 min across all campuses |
| N6 | Data freshness — announcements | ≤ 24h |
| N7 | Data freshness — reference data | ≤ 7d |
| N8 | Infra cost | < ₱1,500/month at launch scale |
| N9 | Cold start to first byte (if serverless) | < 1s |
| N10 | Time for a new dev to first successful call | < 5 min from docs |

---

## 7. Success metrics

### Launch criteria (all P0s shipped + these)

- [ ] All 4 campuses queryable
- [ ] ≥90% of Manila and Cavite programs present and manually spot-checked against source
- [ ] `GET /v1/programs/{slug}` returns multi-campus offerings for ≥3 shared degrees
- [ ] OpenAPI spec published and validating
- [ ] Docs site live with runnable examples
- [ ] Zero personal data in the database (audited)
- [ ] Freshness endpoint live

### 90-day post-launch

| Metric | Target |
|---|---|
| External integrations | ≥3 |
| Uptime | ≥99.5% |
| Unresolved quarantine incidents | 0 |
| Entities with `confidence = 'high'` | ≥70% |
| Median staleness, reference data | ≤7 days |
| Second maintainer onboarded | Yes |

### Anti-metrics (watch for failure)

- **Silent staleness:** median `last_verified_at` drifting past 30 days = the ingestion is dead and nobody noticed.
- **Quarantine fatigue:** >2 open quarantine incidents = parsers are rotting.
- **Zero external use after 6 months:** the docs or the value proposition is wrong; reassess rather than keep building.

---

## 8. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Site redesign breaks a parser silently | High | High | Anomaly guard (F31) + fixtures. This *will* happen; the design assumes it. |
| R2 | IP block from a campus host | Medium | Medium | Politeness limits, off-peak, honest UA. Recoverable — snapshots preserve data. |
| R3 | Taguig site stays offline indefinitely | High | Low | Model as `source_status = 'unavailable'`; populate from sibling references. |
| R4 | Stale data presented as current, harms a student decision | Medium | **High** | Provenance in every response; confidence downgrades; agent instructed to decline. This is the risk the whole trust model exists to address. |
| R5 | Project dies at graduation (2027) | High | High | Org-owned repo, 2+ maintainers, runbooks, documented adapter-authoring guide. |
| R6 | Takedown request | Low | Medium | Comply within 48h. `excluded_sources` table so removals survive re-crawls. |
| R7 | Scope creep into student data | Medium | **High** | C1 as an architectural constraint, not a policy note. CI-enforced. |
| R8 | Embedding costs grow unbounded | Low | Low | Hash-gated re-embedding; only changed chunks are re-embedded. |

---

## 9. Open questions

| # | Question | Owner | Needed by |
|---|---|---|---|
| Q1 | Does Taguig have an archived site or a Facebook-only presence? | Kien | Phase 2 |
| Q2 | Is the Manila `/page/*` legacy tree authoritative or abandoned? | Kien | Phase 1 |
| Q3 | Do Cavite and Manila share a CMS? (identical visitor counters suggest yes) | Kien | Phase 2 — could halve adapter work |
| Q4 | Which embedding model? | Kien | Phase 3 |
| Q5 | Org name for the repo — GDGoC TUP Manila, or a neutral `tup-open-data`? | Kien | Before public launch |

---

## 10. Out-of-band note: social media as a source

The USG and campus Facebook pages are, in practice, where the most current student-facing announcements appear. They are **not** included in v1. See [`02-ADRs.md` ADR-011](./02-ADRs.md) for the analysis and the decision.
