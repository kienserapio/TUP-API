# TUP Open Data API — Documentation Set

**Project:** `tup-open-api`
**Owner:** Kien Leriss Ramos Serapio
**Version:** 2.2 — build standards added (API design, testing, local development)
**Last updated:** 2026-08-29

An open, versioned, multi-campus API that normalizes public institutional data across the Technological University of the Philippines system, and serves both conventional clients and AI agents.

---

## Read in this order

| # | Document | What it answers | Read if you are |
|---|---|---|---|
| 1 | [`01-PRD.md`](./01-PRD.md) | What are we building, for whom, and why? What counts as success? | Anyone. Start here. |
| 2 | [`02-ADRs.md`](./02-ADRs.md) | Why these technical choices and not the obvious alternatives? | Engineers, reviewers |
| 3 | [`03-TDD.md`](./03-TDD.md) | Exactly how is it built? Schema, adapters, endpoints, algorithms. | Implementers |
| 4 | [`04-implementation-plan.md`](./04-implementation-plan.md) | What do I do, in what order, and when am I done? | You, day to day |
| 5 | [`05-deployment-and-operations.md`](./05-deployment-and-operations.md) | Where does it run, how do I ship it, what do I do at 2am? | Operators |
| 6 | [`06-consumer-guide.md`](./06-consumer-guide.md) | How does someone else use this API? | External developers |
| 7 | [`07-governance-and-distribution.md`](./07-governance-and-distribution.md) | Licensing, legal posture, community, continuity after graduation. | Maintainers |
| 8 | [`08-source-landscape.md`](./08-source-landscape.md) | What does each source host *actually* do, verified and dated? | Adapter authors |
| 9 | [`09-freshness-and-confidence.md`](./09-freshness-and-confidence.md) | How is `confidence` set, how does it decay, what does staleness mean? | Implementers, consumers |
| 10 | [`10-data-dictionary.md`](./10-data-dictionary.md) | The corrected schema migration 001 implements. Every table, enum, index. | Implementers |
| 11 | [`11-adapter-guide.md`](./11-adapter-guide.md) | How do I write an adapter, and when is it done? | Contributors |
| 12 | [`12-build-prerequisites.md`](./12-build-prerequisites.md) | What must be decided or created before Phase 0? | You, right now |
| 13 | [`13-api-design-standards.md`](./13-api-design-standards.md) | What rules must every endpoint follow? Naming, envelope, errors, versioning. | Implementers, reviewers |
| 14 | [`14-testing-strategy.md`](./14-testing-strategy.md) | What do I test, what do I skip, and which CI gates enforce it? | Implementers |
| 15 | [`15-local-development.md`](./15-local-development.md) | How do I get this running on my machine, today, with no cloud account? | You, day one |
| 16 | [`16-session-handover.md`](./16-session-handover.md) | What is true right now, what was just decided, what happens next? | Whoever picks this up |
| 16 | [`checkpoints/`](./checkpoints/README.md) | What can I run to prove each module works before building the next? One file per module, M0–M12. | You, during the build |

### Read before any of them

| # | Document | What it answers |
|---|---|---|
| 0 | [`00-errata.md`](./00-errata.md) | What is wrong with v2.0, how severe, and how it is fixed. **Seven schema defects are unfixable after migration 001 ships.** |

---

## The one-paragraph version

TUP's four campuses publish public data — programs, colleges, offices, officials, scholarships, handbooks, news — across four unrelated websites built on three different stacks, with no shared schema, no API, and content that ranges from current to nineteen years stale. `tup-open-api` ingests all of it through per-campus adapters into one normalized Postgres store where **every row carries provenance and a freshness timestamp**, then exposes it as a versioned REST API, a hybrid search endpoint, and an MCP server. The provenance layer is the product: it is what lets a student platform or an AI agent say *"this scholarship page hasn't been verified since 2006, confirm with OSA"* instead of confidently reciting stale policy.

---

## Source landscape (verified 2026-08-20)

| Campus | Canonical origin | Stack | Structure | Status |
|---|---|---|---|---|
| Manila | `tup.edu.ph` (**apex** — `www` is unreliable) | Legacy PHP behind a Sucuri WAF, two live generations | 6 **colleges** | Fully crawlable. **No `robots.txt` exists.** |
| Cavite | `www.tupcavite.edu.ph` (**`www`** — apex returns 403) | nginx, server-rendered, clean routes | 5 **departments** | Fully crawlable. No `robots.txt`. |
| Visayas | `tupvisayas.edu.ph` | Laravel behind Cloudflare | 3 **colleges** (COAC, COE, COET) | Crawlable, but now serves AI-crawler directives — [`08`](./08-source-landscape.md#51-robotstxt--present-cloudflare-managed-ai-restrictive) |
| Taguig | `tupt.edu.ph` | — | Unknown | **cPanel-suspended, serving HTTP 200.** Not 404. |

This table changed materially within a day of the v2.0 survey. **Two campuses serve on the host the v2.0 docs did not use**, no campus supports conditional GET, and Visayas gained AI-crawler directives. Facts about hosts live in [`08-source-landscape.md`](./08-source-landscape.md) and nowhere else; re-verify with `scripts/verify-sources.sh` before each phase.

Three different organizational vocabularies across four campuses is the central modeling problem. It is solved with a single `academic_units` table plus a `unit_type` discriminator — [`10-data-dictionary.md §5.2`](./10-data-dictionary.md).

---

## Scope boundary (non-negotiable)

**In:** public institutional data — campuses, units, programs, offerings, offices, officials, announcements, documents, scholarships, fee estimates, procedures.

**Out:** anything personal or authenticated. No grades, no schedules, no enrollment status, no student records, no AIMS/ERS integration, no credential handling.

This is a design constraint, not a roadmap item. See [`01-PRD.md §3`](./01-PRD.md) and [`07-governance-and-distribution.md §2`](./07-governance-and-distribution.md).

---

## Review status

Reviewed against the live sources on 2026-08-20. **The architecture is sound and the project is feasible.** Three things need attention before the first commit:

1. **Seven schema defects**, four of which cannot be fixed after migration 001 ships — enum ordering, slug uniqueness, the missing `ref` column, and `uuidv7()` not existing on Supabase Postgres 17. All corrected in [`10-data-dictionary.md`](./10-data-dictionary.md).
2. **Two ingestion-design premises are false.** No campus supports conditional GET, so the 304 design cannot work; and the guard is scoped adapter-wide while fetching is per-source, so every healthy incremental run would quarantine and then mark live data removed. Corrected in [`00-errata.md`](./00-errata.md) E2 and E3.
3. **The timeline is 2–2.5× optimistic** — 15–20 weeks rather than 9–10. The phase sequence itself is the strongest part of the plan and is unchanged.

Start at [`12-build-prerequisites.md`](./12-build-prerequisites.md).

---

## Status legend used throughout

`PLANNED` · `IN PROGRESS` · `SHIPPED` · `BLOCKED` · `DEFERRED` · `WONTFIX`
