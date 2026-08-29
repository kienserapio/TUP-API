# 09 — Freshness and Confidence

**Prerequisites:** [`02-ADRs.md ADR-004`](./02-ADRs.md)
**Resolves:** [`00-errata.md`](./00-errata.md) E9
**Status:** normative — this document defines behaviour, not guidance

[`02-ADRs.md ADR-004`](./02-ADRs.md) states the case plainly:

> staleness thresholds differ per entity type; **encoding that judgment server-side is the value-add**

That judgment was never encoded. PRD F28 requires a decay job, the ops schedule runs one daily at 03:00 PHT, the consumer guide publishes a confidence table and an agent prompt keyed to "180 days", and no document said what any of it means. This one does.

Everything here is load-bearing. `confidence` is the field that lets an agent decline to answer, and declining correctly is the single behaviour that separates this project from a scraper with a REST wrapper.

---

## 1. The two quantities

They are different and consumers conflate them, so the API exposes both.

**`staleness_days`** — objective, computed, never stored:

```sql
staleness_days := floor(extract(epoch FROM (now() - last_verified_at)) / 86400)::int
```

`last_verified_at` means **"we confirmed the source still said this"**, not "the source changed". A verified-unchanged fetch (E2 content-hash match) refreshes it. That is the point: a page that has not changed in a year but was checked this morning is *fresh*, and a page nobody has looked at since March is *stale* whatever it says.

**`confidence`** — a judgment, stored, three values:

| Value | Means |
|---|---|
| `high` | Recently verified from a source whose structure we parse reliably |
| `medium` | Verified, but the source is loosely structured, indirectly attributed, or ageing |
| `low` | Known-stale, seeded indirectly, or drawn from a source we do not trust to be current |

Confidence is a **function of** `sources.method`, entity type, and `staleness_days`. It is not an independent opinion, and no adapter may set it freely — see §3.

### 1.1 Enum ordering

```sql
CREATE TYPE confidence_level AS ENUM ('low', 'medium', 'high');
```

Ascending, so `confidence >= 'medium'` means what a reader expects. The v2.0 declaration was descending, which silently inverted every filter — [`00-errata.md`](./00-errata.md) E1. **This order cannot be changed after migration 001.**

---

## 2. Initial confidence

Set at publish time, by `sources.method` and entity type. This is a lookup table in `packages/ingest-core/confidence.ts`, not an adapter decision.

| `method` | Meaning | Base confidence |
|---|---|---|
| `crawl` | Fetched from the live site by the pipeline | `high` |
| `manual` | Collected by a human from the live public page | `high` |
| `partner_feed` | Pushed by a source owner (e.g. a USG Page token) | `high` |
| `seed` | Hand-entered or inferred from a sibling site | `medium` |

Then apply entity-type modifiers, which encode what we know about how the *underlying pages* behave regardless of when we fetched them:

| Entity type | Modifier | Why |
|---|---|---|
| `campus` | — | Four rows, hand-verified, essentially static |
| `academic_unit` | — | Changes on reorganisation, i.e. years apart |
| `program` | — | Canonical registry, hand-curated |
| `program_offering` | — | Published on structured pages |
| `announcement` | — | Dated at source; the one entity type with a real publication date |
| `office` | **cap at `medium`** | Contact details and hours go stale without the page changing |
| `official` | **cap at `medium`** | Personnel changes routinely outrun the website |
| `document` | **cap at `medium`** | An edition is only as current as its `effective_date` |
| `scholarship` | **cap at `low`** | Manila's page cites 2006 figures. This is the motivating case for the whole design. |
| `fee_estimate` | **cap at `low`** | Amounts, and consequential to a student if wrong |
| `procedure` | **cap at `medium`** | Steps drift; requirements lists especially |

A cap is a ceiling, not an assignment: a freshly-crawled scholarship is `low`, and it stays `low`. **This is correct and deliberate.** The scholarship page being fetched this morning tells you the page has not changed; it tells you nothing about whether ₱-figures from 2006 are still the grant amounts. Confidence answers *"should you rely on this?"*, and the honest answer there is no.

### 2.1 Document editions override everything

If `documents.effective_date` is more than **3 years** old, or `documents.is_superseded` is true, force `confidence = 'low'` regardless of fetch recency. The Manila handbook is the 2013 Revised edition; it was fetched today and it is thirteen years old. Freshness of *retrieval* must never be allowed to imply currency of *content*.

Chunks inherit the confidence of their parent document at chunk time, so a retrieval hit on a 2013 handbook rule arrives already marked `low`.

---

## 3. Decay

A scheduled job, daily at 03:00 PHT, downgrades entities that have gone unverified. Thresholds are per entity type and reflect how fast the underlying fact actually changes.

| Entity type | `high` → `medium` after | `medium` → `low` after | Recrawl interval |
|---|---|---|---|
| `announcement` | 7 d | 30 d | 6 h |
| `official` | 30 d | 120 d | 7 d |
| `office` | 60 d | 180 d | 7 d |
| `procedure` | 60 d | 180 d | 7 d |
| `program_offering` | 90 d | 270 d | 7 d |
| `academic_unit` | 120 d | 365 d | 7 d |
| `program` | 180 d | 365 d | seed |
| `document` | 180 d | 365 d | 30 d |
| `scholarship` | — (capped `low`) | — | 30 d |
| `fee_estimate` | — (capped `low`) | — | 30 d |
| `campus` | 365 d | never | 30 d |

Read the first two columns as `staleness_days` thresholds. `campus` never reaches `low` because a campus existing is not a fact that decays.

Three properties the job must have:

**Decay is reversible.** A successful verification recomputes confidence from §2 and restores it. Decay is a view of staleness, not a permanent mark. Implement it as a recompute, not a decrement — a job that only ever downgrades will drift out of agreement with reality after any backfill.

**Decay is idempotent.** Running it twice in a day changes nothing. It is a pure function of `(method, entity_type, staleness_days, effective_date, is_superseded)`.

**Decay writes `change_events`.** A confidence downgrade is a real change that a sync consumer should see, with `operation = 'updated'` and the field-level diff. Without this, `GET /v1/changes` misses the exact transitions a cautious consumer most wants to react to.

### 3.1 Source-level override

When `sources.status` becomes `unavailable` or `blocked` — RB-02, RB-03, or a Manila WAF block per [`08-source-landscape.md §3.1`](./08-source-landscape.md) — every entity from that source is immediately capped at `medium`, and at `low` after 30 days. A source we can no longer reach is a source we can no longer verify, and the decay clock alone would take months to say so.

---

## 4. `min_confidence`

A global query parameter on every collection endpoint, and a body field on `POST /v1/rag/query`.

```
GET /v1/scholarships?campus=manila&min_confidence=medium
```

Semantics: `WHERE confidence >= $1`, correct given the §1.1 enum order. Default is **no filter** — the API returns everything and labels it, rather than hiding low-confidence rows. Hiding them would leave a consumer unable to distinguish "no scholarships" from "no scholarships we vouch for", which is precisely the ambiguity this project exists to remove.

`meta.freshness` on every collection response reports what the caller actually received:

```json
"freshness": {
  "oldest_verified_at": "2026-07-30T02:00:00Z",
  "max_staleness_days": 21,
  "min_confidence": "low",
  "counts_by_confidence": { "high": 18, "medium": 5, "low": 2 }
}
```

`min_confidence` here is the **minimum found in this page of results**, not the filter that was applied. It answers "how much should I trust the worst row I just got?" — which is the question that matters when rendering a list.

---

## 5. Provenance in responses

Per ADR-004 this is in the default payload, never behind a flag.

Single resource:

```json
{
  "data": { "...": "..." },
  "provenance": {
    "source_url": "https://tup.edu.ph/pages/admission/undergraduate-programs",
    "method": "crawl",
    "first_seen_at": "2026-03-02T18:04:00Z",
    "last_verified_at": "2026-08-19T18:03:00Z",
    "staleness_days": 1,
    "confidence": "high",
    "source_status": "active"
  }
}
```

Note `source_url` uses the canonical origin from [`08-source-landscape.md §1`](./08-source-landscape.md). The v2.0 sample cited `www.tup.edu.ph`, which does not resolve over HTTPS — a dead citation link defeats the entire feature ([`00-errata.md`](./00-errata.md) E5).

Collection items each carry their own `provenance` object. Yes, this is repetitive; ADR-004 accepted the ~15% payload cost and gzip absorbs most of it. The alternative — one provenance block per response — would misrepresent a mixed-freshness collection as uniformly fresh, which is the failure mode the design exists to prevent.

---

## 6. `GET /v1/meta/freshness`

Public, cached 5 minutes. This is the endpoint [`01-PRD.md §4 U5`](./01-PRD.md) describes as "a genuine gift" to UITC, and it is worth building well.

```json
{
  "data": {
    "generated_at": "2026-08-20T13:00:00Z",
    "last_successful_ingest_at": "2026-08-20T18:02:00Z",
    "hours_since_ingest": 5.1,
    "overall": {
      "median_staleness_days": 3,
      "p95_staleness_days": 41,
      "counts_by_confidence": { "high": 412, "medium": 88, "low": 37 },
      "pct_high": 0.766
    },
    "by_campus": [
      {
        "campus": "manila",
        "source_status": "active",
        "median_staleness_days": 2,
        "counts_by_confidence": { "high": 180, "medium": 30, "low": 22 },
        "stalest": {
          "entity_type": "scholarship",
          "ref": "manila/tupstat",
          "staleness_days": 19,
          "source_url": "https://tup.edu.ph/pages/students/student-scholarship",
          "note": "source page cites figures dated 2006"
        }
      }
    ],
    "by_entity_type": [
      { "entity_type": "announcement", "count": 210, "median_staleness_days": 1, "pct_high": 0.94 },
      { "entity_type": "scholarship",  "count": 37,  "median_staleness_days": 12, "pct_high": 0.0 }
    ],
    "sources": {
      "total": 64,
      "active": 61,
      "unavailable": 2,
      "blocked": 1,
      "overdue": [
        { "url": "https://tupt.edu.ph/", "status": "suspended", "days_overdue": 366 }
      ]
    }
  }
}
```

`last_successful_ingest_at` and `hours_since_ingest` also appear on `GET /v1/health`. That is deliberate: it lets the external uptime monitor assert `hours_since_ingest < 36` and catch a dead ingestion pipeline **without depending on the same GitHub Actions cron that would have died** — [`00-errata.md`](./00-errata.md) E14. It also makes staleness visible to consumers rather than only to operators, which is the same principle as putting provenance in the default payload.

---

## 7. What consumers should do

Normative for the SDK and the recommended agent prompt; advisory for everyone else.

| Situation | Expected behaviour |
|---|---|
| Rendering any fee, scholarship, or deadline | Show `last_verified_at` and link `source_url`. Always. |
| `confidence = 'low'` | Show the date and the source link, and say the figure may be out of date |
| `staleness_days > 180` | Same, regardless of confidence |
| Agent about to assert a fee, scholarship, or deadline | Call `check_freshness` first; if `low` or `>180 d`, decline and name the office to contact |
| Agent answering a campus-specific policy question | Confirm the retrieved chunk's `campus_slug` matches the campus asked about |
| Building a sync client | Use `GET /v1/changes?since=`; confidence downgrades appear there as `updated` |

The `check_freshness` MCP tool returns `staleness_days`, `confidence`, `source_url`, `source_status`, and `last_verified_at` for a `ref`. It exists so an agent can self-police, and it is the reason the provenance layer is protection rather than metadata.

---

## 8. Launch criterion

[`01-PRD.md §7`](./01-PRD.md) sets "≥70% of entities at `confidence = 'high'`" as a 90-day target. Under this specification that is measurable, and worth restating so it is not mistaken for a failure when it is met:

`scholarship` and `fee_estimate` are **capped at `low` by design** and can never contribute to the 70%. Exclude them from the denominator, or the metric penalises the project for being honest about the one dataset it is most honest about. State the exclusion in the metric definition:

```
pct_high := count(confidence = 'high') / count(entity_type NOT IN ('scholarship','fee_estimate'))
```
