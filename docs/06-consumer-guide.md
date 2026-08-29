# 06 — Consumer Guide

*This document is the source for the public documentation site. Written for an external developer who has never met the maintainers.*

---

> [!IMPORTANT]
> **Amended 2026-08-20.** Sample `source_url` values cite `www.tup.edu.ph`, which does not resolve reliably over HTTPS — a dead citation link defeats the provenance feature. Confidence semantics are now fully specified in [`09-freshness-and-confidence.md`](./09-freshness-and-confidence.md), and `GET /v1/documents/{slug}` becomes campus-qualified because handbook slugs collide across campuses. See [`00-errata.md`](./00-errata.md) E5, E6, E9.

## Quickstart

No signup required. No API key required for normal use.

```bash
curl https://api.<domain>/v1/campuses
```

```ts
const res = await fetch('https://api.<domain>/v1/programs?campus=manila&level=baccalaureate');
const { data, meta } = await res.json();
```

Or with the SDK:

```bash
npm i @<org>/tup-api
```

```ts
import { TupClient } from '@<org>/tup-api';

const tup = new TupClient();
const programs = await tup.programs.list({ campus: 'manila', level: 'baccalaureate' });
```

---

## The one thing to understand first: this data has ages

TUP's websites do not publish "last updated" dates. Some pages are current; some cite figures from 2006. **This API tells you which is which**, and you should use that.

Every response carries provenance:

```json
{
  "data": { "slug": "bsce", "name": "Bachelor of Science in Civil Engineering" },
  "provenance": {
    "source_url": "https://www.tup.edu.ph/pages/admission/undergraduate-programs",
    "method": "manual",
    "last_verified_at": "2026-08-01T03:14:00Z",
    "staleness_days": 18,
    "confidence": "high"
  }
}
```

### Confidence levels

| Level | Meaning | How to treat it |
|---|---|---|
| `high` | Recently verified from a well-structured source | Display normally |
| `medium` | Verified, but the source is less structured or ageing | Display with the verification date |
| `low` | Source is known-stale or was seeded indirectly | **Always show the date and link the source** |

Fees and scholarships default to `low`. That is not a bug — the underlying pages genuinely have not been updated in years.

### Filtering by confidence

```
GET /v1/scholarships?campus=manila&min_confidence=medium
```

### If you are building anything user-facing

Show `last_verified_at` next to any fee, scholarship, or policy figure, and link `source_url`. It costs you one line of UI and it is the difference between a helpful tool and one that misleads a student about money.

---

## Core concepts

### Campuses

Four: `manila`, `cavite`, `visayas`, `taguig`.

Taguig is included but its website is currently offline, so it returns `website_status: "unavailable"` and minimal, low-confidence data. It is present rather than hidden, because silently dropping a campus is worse than saying "we have no source for this one."

### Academic units — read this before you hardcode "college"

**The campuses do not use the same organizational vocabulary.**

| Campus | Uses | Count |
|---|---|---|
| Manila | colleges | 6 |
| Visayas | colleges | 3 |
| Cavite | **departments** | 5 |

So every unit carries a `unit_type`:

```json
{ "slug": "engineering", "name": "Engineering Department", "unit_type": "department", "campus": "cavite" }
```

Do not build a UI that says "College" unconditionally. Read `unit_type`. Units can also nest via `parent`.

### Programs vs offerings

This distinction is the most useful thing the API gives you.

- **A program** is a canonical degree, campus-agnostic. `bsce` = BS Civil Engineering.
- **An offering** is that degree *as taught at a specific campus*, with its own department, majors, status, and accreditation.

So this single call answers "where in the TUP system can I study civil engineering?":

```
GET /v1/programs/bsce
```

```json
{
  "data": {
    "slug": "bsce",
    "name": "Bachelor of Science in Civil Engineering",
    "level": "baccalaureate",
    "offerings": [
      { "campus": "manila",  "unit": { "slug": "coe", "type": "college" },    "status": "active" },
      { "campus": "cavite",  "unit": { "slug": "engineering", "type": "department" }, "status": "active" },
      { "campus": "visayas", "unit": { "slug": "coe", "type": "college" },    "status": "active" }
    ]
  }
}
```

There is no way to get this from the TUP websites without visiting three of them and reconciling three vocabularies yourself.

---

## Pagination

Cursor-based. Cursors are **opaque** — do not decode or construct them.

```ts
let cursor: string | undefined;
const all = [];

do {
  const url = new URL('https://api.<domain>/v1/programs');
  url.searchParams.set('limit', '100');
  if (cursor) url.searchParams.set('cursor', cursor);

  const { data, meta, links } = await (await fetch(url)).json();
  all.push(...data);
  cursor = meta.has_more ? new URL(links.next).searchParams.get('cursor')! : undefined;
} while (cursor);
```

Offset pagination is not supported: it duplicates and skips rows when the underlying data changes mid-pagination, which happens on every ingestion run.

---

## Errors

RFC 9457 Problem Details, `application/problem+json`:

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

| Status | Meaning |
|---|---|
| 400 | Invalid parameter — check `detail` |
| 404 | Not found — check `did_you_mean` |
| 429 | Rate limited — honor `Retry-After` |
| 503 | Maintenance or ingestion lock |

---

## Rate limits

| Tier | Per minute | Per day |
|---|---|---|
| Anonymous | 60 | 1,000 |
| Free API key | 600 | 100,000 |

Headers: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`.

Get a key at `https://<domain>/keys` — email plus a one-line project description. Keys exist so we can contact you if something breaks, not to gate access.

**Please cache.** Responses carry `ETag`; send `If-None-Match` and you will get cheap `304`s. Reference data changes at most daily.

---

## Search and RAG

### Hybrid search

```
GET /v1/search?q=maximum%20residency&campus=manila&type=document
```

Combines vector similarity with full-text matching. Handles both paraphrases ("how long can I stay enrolled") and exact terms ("TUPSTAT", "BTVTEd", "COPC").

### RAG retrieval

```
POST /v1/rag/query
{ "query": "what is the maximum residency rule", "campus": "manila", "top_k": 6 }
```

Returns ranked passages with `heading_path`, `context_header`, `source_url`, `last_verified_at`, and `confidence`.

**It does not return a generated answer, on purpose.** You get evidence; your model does the reasoning. This keeps the API deterministic and cacheable, keeps inference cost out of it, and — most importantly — keeps responsibility for the assertion with you, since you have the user context needed to calibrate it.

---

## Using this with an AI agent

### MCP server

```json
{
  "mcpServers": {
    "tup": { "url": "https://mcp.<domain>/sse" }
  }
}
```

Tools: `list_campuses`, `find_programs`, `get_program`, `search_handbook`, `get_announcements`, `check_freshness`.

### Recommended system prompt

Do not skip this part. An agent that ignores freshness will confidently state 2006 scholarship figures as current.

```
You have access to TUP institutional data via the tup MCP server.

Rules:
- For counts, lists, and filters, use find_programs or list_campuses. Do not
  use search_handbook for questions that have exact answers.
- For policy and handbook questions, use search_handbook and cite the section
  and source URL.
- Before stating anything about fees, scholarships, or deadlines, call
  check_freshness. If confidence is 'low' or staleness exceeds 180 days, say so
  explicitly and direct the student to the relevant office instead of asserting
  the figure.
- Campuses use different vocabularies: Manila and Visayas have colleges, Cavite
  has departments. Use the unit_type field; never assume.
- This is unofficial data aggregated from public TUP websites. Say so when a
  student is making a decision that depends on it.
```

The `check_freshness` instruction is the important one. It is what turns the provenance layer from metadata into actual protection for the student.

---

## What this API does not have

Being honest about gaps is more useful than pretending completeness.

| Not available | Why |
|---|---|
| Grades, schedules, enrollment status | Requires AIMS authentication. Permanently out of scope — see the governance doc. |
| Course-level curricula, syllabi, prerequisites | Largely unpublished; per-campus and per-cohort. |
| Class availability, room assignments | Operational data, not public. |
| Real-time scholarship slots | Not published anywhere. |
| Facebook posts from USG or campus pages | Meta's API requires business verification and Page admin access. See below. |
| Taguig campus detail | Site is offline. |

### About Facebook

Campus and USG Facebook pages are where the most timely announcements actually appear, and this API does not include them. Reading another Page's public posts now requires Meta's Page Public Content Access, which requires App Review, which requires business verification — not available to a student project. Meta Content Library, the research alternative, requires institutional verification.

**The one clean path:** if you administer a TUP campus or USG Facebook page and want your posts in this API, get in touch. A Page access token from an admin makes it straightforward and entirely within Meta's terms.

---

## Attribution and terms

- Data is aggregated from public TUP websites. **This is not an official TUP service.**
- Attribute as: *"Data from TUP Open Data API, sourced from official TUP campus websites."*
- Data licensed CC-BY-4.0. Code MIT.
- Do not resell the data or present it as official.
- Cache and be reasonable; the upstream sites are small and we crawl them politely.

---

## Getting help

| Need | Where |
|---|---|
| Bug or wrong data | GitHub issue with the endpoint and expected value |
| New campus/entity request | GitHub discussion |
| Data correction | Issue with the source URL proving the correct value |
| Takedown | `<takedown-email>` — actioned within 48h |
| Contributing an adapter | `CONTRIBUTING.md` |

Wrong-data reports are especially welcome. The freshness system tells you *when* something was verified; it cannot tell you the source itself was wrong.
