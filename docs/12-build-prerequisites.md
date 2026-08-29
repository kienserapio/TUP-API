# 12 — Build Prerequisites

**Resolves:** [`00-errata.md`](./00-errata.md) E24
**Read this immediately before Phase 0.**

Everything here blocks work that cannot start without it. Items are grouped by whether they need a **decision** (only you can make it), an **account**, or a **fix to the docs** (already drafted, needs your sign-off).

The honest summary: **nothing here is hard, four of the decisions are irreversible-ish, and the whole list is about a day of work.** The reason it is a document rather than a paragraph is that skipping any one of the four blockers costs a schema migration later.

---

## 1. Decisions only you can make

### D1 — Organisation and repository home  🔴 blocks Phase 0.1

PRD Q5, currently marked "before public launch". It is actually needed **before the first commit**, because the repo has to live somewhere and the org name propagates into the npm scope, the `User-Agent` contact URL, the OpenAPI `servers` block, and the `NOTICE` file.

| Option | For | Against |
|---|---|---|
| `tup-open-data` (neutral org) | Survives chapter leadership changes; implies no affiliation; reads institution-neutral so a future `pup-open-api` fits | You create and own it; no existing community |
| GDGoC TUP Manila | Existing community, existing members, plausible second maintainers | Implies Google affiliation the project does not have; chapter leadership turns over annually; ties an institution-wide project to one campus's chapter |

[`07-governance-and-distribution.md §5.1`](./07-governance-and-distribution.md) already leans neutral and gives the reasoning. **Recommendation: neutral org, then invite GDGoC members as maintainers.** That gets the community without the coupling — and continuity (PRD R5) is the risk this decision actually governs.

### D2 — Domain  🔴 blocks Phase 0.5

`<domain>` appears in every document. It is needed for the OpenAPI `servers` block, the `User-Agent` contact URL that the entire politeness posture depends on, the MCP server URL, and the takedown contact.

Register it to the **org**, not to you personally ([`07-governance-and-distribution.md §5.1`](./07-governance-and-distribution.md)). Roughly ₱700/yr. Subdomains needed: `api.`, `docs.`, `status.`, and `mcp.` if the MCP server is deployed separately — see D4.

### D3 — `confidence_level` enum order  🔴 blocks migration 001, irreversible

```sql
CREATE TYPE confidence_level AS ENUM ('low', 'medium', 'high');
```

Ascending. Postgres orders enums by declaration order, and this order cannot be changed later without rewriting nine tables. The v2.0 docs had it descending, which silently inverts every `min_confidence` filter — [`00-errata.md`](./00-errata.md) E1.

There is nothing to weigh here. It is on the list because it is the single cheapest-now, most expensive-later item in the project.

### D4 — Deployment shape and budget  🟡 blocks Phase 0.6

Fly.io removed its free tier in October 2024, so [`05-deployment-and-operations.md §2.2`](./05-deployment-and-operations.md)'s "$0" and "≈₱60/mo" are wrong — [`00-errata.md`](./00-errata.md) E17.

| Shape | Monthly | Notes |
|---|---|---|
| As documented — 2× API 512 MB + 1× MCP 256 MB | ~$8–10 (≈₱500–600) | Highest availability, most moving parts |
| **1× API 512 MB with autostop, MCP as a route on the same app** | **~$3–4 (≈₱200–250)** | Recommended. Cloudflare absorbs cached reads; N9's 1s cold start is met by Fly wake time |
| Not Fly | varies | Railway, Render, or a Hetzner VPS. Reconsider only if Fly's `sin` latency disappoints |

**Recommendation: the middle row.** The MCP server is a thin adapter over the same endpoints; a separate machine doubles the deploy surface and buys nothing at launch scale. Split it out when there is traffic to justify it. Either way the project stays inside PRD N8's ₱1,500/mo.

### D5 — Embedding model  🟡 blocks Phase 3, not Phase 0

PRD Q4 has this open while [`03-TDD.md §2.5`](./03-TDD.md) hardcodes `vector(1536)` and [`04-implementation-plan.md §3.3`](./04-implementation-plan.md) commits to `text-embedding-3-small` — [`00-errata.md`](./00-errata.md) E20. Close the question or make the column dimension-agnostic; `vector(1536)` prevents switching to a different-dimension model without a table rewrite.

`text-embedding-3-small` at 1536d is a reasonable default and the corpus is small enough that cost is a rounding error (~$0.50 one-time). **Recommendation: close Q4 as `text-embedding-3-small`, and record in the ADR that switching means a re-embed and a migration** — which, at a few thousand chunks, is an afternoon rather than a crisis.

Note that this requires an **embedding provider API key in ingestion**. [`02-ADRs.md ADR-010`](./02-ADRs.md)'s "no LLM API key or inference cost in the API's operating budget" is true of the API and false of the pipeline.

### D6 — Position on Visayas's AI directives  🟡 blocks the Visayas adapter, Phase 2

`tupvisayas.edu.ph` now serves Cloudflare-managed robots directives that Disallow ClaudeBot, GPTBot, CCBot, Google-Extended and others, and declare `Content-Signal: search=yes, ai-train=no, use=reference` as an express reservation of rights — [`08-source-landscape.md §5.1`](./08-source-landscape.md), [`00-errata.md`](./00-errata.md) E11.

`TUPOpenDataBot` is not named and `User-agent: *` is `Allow: /`, so the crawl is permitted. But TUPV has deliberately switched on AI-crawler blocking, and this project's headline feature is an MCP server for AI agents.

**This is a judgment call and it is yours.** The recommended position, which the drafted docs assume:

1. Crawl, since it is permitted, and identify honestly as `TUPOpenDataBot`.
2. Comply with every signal literally: never train or fine-tune on ingested content, and say so in `LICENSE-DATA`, `llms.txt`, and the consumer guide.
3. Store `Content-Signal` per domain and **fail the run** if it changes, rather than logging and continuing.
4. State the position openly in the governance doc rather than resting on a `User-agent: *` technicality.

Tell me if you want a different posture — for instance excluding Visayas from the RAG corpus while keeping it in the structured API, which would honour the spirit more conservatively at the cost of the cross-campus handbook comparison.

---

## 2. Accounts and secrets

Set up before Phase 0.6. Put every secret in a **shared vault** from day one, not on your laptop — [`07-governance-and-distribution.md §5.1`](./07-governance-and-distribution.md) lists this as a Phase 0 deadline and it is the cheapest continuity measure available.

| # | Thing | Needed by | Notes |
|---|---|---|---|
| A1 | GitHub org + repo | 0.1 | Per D1. Enable Actions, Dependabot, branch protection on `main` |
| A2 | Supabase project, region `ap-southeast-1` | 0.2 | **Postgres 17** — the docs said 16, which is not offered |
| A3 | Fly.io account, region `sin` | 0.6 | Card required; no free tier (D4) |
| A4 | Cloudflare — domain on free plan | 0.6 | Per D2 |
| A5 | Sentry | 0.6 | Free tier |
| A6 | Upstash Redis, Singapore | 1.6 | Free tier. Rate limits and response cache |
| A7 | Embedding provider key | 3.3 | Per D5. Ingestion only |
| A8 | External heartbeat monitor | 5.2 | Better Stack or Healthchecks.io. **Not optional** — see §4 |
| A9 | Shared password vault | 0.1 | Bitwarden free tier is sufficient |
| A10 | Takedown email address | before launch | Published; 48h SLA ([`07-governance-and-distribution.md §4`](./07-governance-and-distribution.md)) |

### 2.1 Two database connection strings, not one

Supabase's Supavisor pooler in transaction mode does not support prepared statements, and Drizzle over `postgres.js` prepares by default — [`00-errata.md`](./00-errata.md) E19. Document both in `.env.example`:

```bash
# API on Fly — long-lived process, session pooler or direct
DATABASE_URL=postgresql://...@...pooler.supabase.com:5432/postgres

# Ingest on GitHub Actions — ephemeral runners, transaction pooler
# REQUIRES prepare:false in the postgres.js client
DATABASE_URL_POOLED=postgresql://...@...pooler.supabase.com:6543/postgres
```

Twenty minutes now; a confusing intermittent failure later.

---

## 3. Doc fixes to sign off

Drafted and awaiting your review. Details and evidence in [`00-errata.md`](./00-errata.md).

| # | Change | Where |
|---|---|---|
| F1 | `confidence_level` enum ascending | [`10-data-dictionary.md §2.2`](./10-data-dictionary.md) |
| F2 | Content-hash gating replaces the 304 design | [`10-data-dictionary.md §6.2`](./10-data-dictionary.md) |
| F3 | Reconcile and guard scoped to `ingest_runs.source_ids` | [`10-data-dictionary.md §6.1`](./10-data-dictionary.md) |
| F4 | `uuidv7()` polyfill; stack corrected to Postgres 17 | [`10-data-dictionary.md §2.1`](./10-data-dictionary.md) |
| F5 | Canonical origins — Manila apex, Cavite `www` | [`08-source-landscape.md §1`](./08-source-landscape.md) |
| F6 | `UNIQUE (campus_id, slug)` on announcements and documents | [`10-data-dictionary.md §5.6`, `§5.7`](./10-data-dictionary.md) |
| F7 | `ref` grammar and generated columns | [`10-data-dictionary.md §3`](./10-data-dictionary.md) |
| F8 | Corrected hybrid search SQL | [`10-data-dictionary.md §7.1`](./10-data-dictionary.md) |
| F9 | Confidence and decay fully specified | [`09-freshness-and-confidence.md`](./09-freshness-and-confidence.md) |
| F10 | `procedures` and `api_keys` tables; `entity_type` enum; `run_id` columns | [`10-data-dictionary.md`](./10-data-dictionary.md) |
| F11 | Taguig `suspended`; corrected liveness predicate | [`08-source-landscape.md §6`](./08-source-landscape.md), ADR-017 |
| F12 | External heartbeat for the staleness alarm | §4 below |
| F13 | Manila crawlable; ADR-013's decision unchanged | ADR-016, [`08-source-landscape.md §3.2`](./08-source-landscape.md) |

---

## 4. One thing worth doing before anything else

[`01-PRD.md §7`](./01-PRD.md) names the project's primary anti-metric:

> **Silent staleness:** median `last_verified_at` drifting past 30 days = the ingestion is dead and nobody noticed.

The defence is ops alert #3. **Both the ingestion and that alert run on GitHub Actions cron**, so if Actions stops, ingestion stops and the alarm stops with it — producing exactly the failure the anti-metric names. GitHub disables scheduled workflows after **60 days of repository inactivity**, which a maintenance-mode project reaches as a matter of course. This is the same failure as PRD R5, "project dies at graduation".

Three cheap fixes, all worth doing in Phase 0:

1. Every successful ingestion run pings an **external heartbeat monitor** (A8). It alerts on the *absence* of a ping, so it fires precisely when the cron dies.
2. `GET /v1/health` reports `last_successful_ingest_at` and `hours_since_ingest`; the external uptime check — which already exists for alert #2 — asserts `hours_since_ingest < 36`. Zero marginal cost, and it makes staleness visible to **consumers**, not just operators.
3. Note in the runbook that any 60-day quiet period requires manually re-enabling schedules.

Item 2 is the one to prioritise. It is consistent with everything else in the trust model: the API reports its own staleness rather than expecting anyone to take it on faith.

---

## 5. Ready-to-build checklist

```
Decisions
  [ ] D1  org name chosen, repo created
  [ ] D2  domain registered to the org
  [ ] D3  confidence_level ascending — confirmed before migration 001
  [ ] D4  deployment shape and budget agreed
  [ ] D5  embedding model closed (or deferred to Phase 3 knowingly)
  [ ] D6  position on Visayas AI directives decided and written down

Accounts
  [ ] A1–A5, A9  GitHub, Supabase (PG 17), Fly, Cloudflare, Sentry, vault
  [ ] A8  external heartbeat monitor
  [ ] A6, A7, A10 may wait for their phase

Docs
  [ ] F1–F13 reviewed and signed off
  [ ] scripts/verify-sources.sh run; output committed to docs/verification/
  [ ] Any diff against 08-source-landscape.md investigated

Then start Phase 0.
```

---

## 6. What is not blocking

Recorded so it does not get treated as blocking:

- **Institutional permission.** [`02-ADRs.md ADR-013`](./02-ADRs.md) settled this and the finding that Manila serves no robots.txt does not reopen it.
- **The Taguig adapter.** A stub that yields nothing, per [`02-ADRs.md ADR-012`](./02-ADRs.md). The corrected liveness probe will tell you when to build it.
- **The canonical program registry being complete.** Seed ~20 degrees you know exist and grow it from `pnpm ingest:unmatched` output. Trying to enumerate every TUP degree before writing an adapter is the "breadth before depth" anti-pattern [`04-implementation-plan.md`](./04-implementation-plan.md) warns against.
- **A second maintainer.** Phase 5. Do not let it block Phase 0 — but do create the org now (D1) so the seat exists when someone is ready to fill it.
