# 13 — API Design Standards

**Prerequisites:** [`02-ADRs.md`](./02-ADRs.md), [`03-TDD.md`](./03-TDD.md)
**Audience:** anyone adding or changing an endpoint
**Added:** 2026-08-29

---

> [!IMPORTANT]
> This document is **normative**. [`06-consumer-guide.md`](./06-consumer-guide.md) describes the API to outsiders; this describes the rules that produce it. Where the two disagree, this document is the defect and must be fixed here first.

Every rule below exists because breaking it costs a version bump on a public contract. The API is versioned, unauthenticated, and intended to be depended on by people who will never talk to you. That asymmetry — cheap to get right now, expensive to fix later — is the only justification this document needs.

---

## 1. Design-first, not code-first

The industry lifecycle is **design → specify → build → test → document → deploy → monitor → evolve**. This project collapses two of those steps deliberately.

The OpenAPI document is **generated from the Zod schemas that run in production** ([ADR-007](./02-ADRs.md#adr-007)). There is no hand-written spec to drift, and no annotation pass that lies.

That inverts the usual failure mode but introduces a new one: it becomes possible to change the contract by accident, because changing code changes the spec. The **spec drift gate** ([`05-deployment-and-operations.md §3.2`](./05-deployment-and-operations.md)) is what closes it — CI fails if generated `openapi.json` differs from the committed one, so every contract change arrives as a reviewable diff.

**Rule:** design the response shape in `packages/schemas` before writing the handler. If the shape is not expressible in Zod, it is not a shape this API returns.

---

## 2. Resource-oriented design

Model **nouns**, not operations (AIP-121). The URL identifies a thing; the HTTP method says what to do with it.

### 2.1 Collections and members

| Pattern | Example | Meaning |
|---|---|---|
| `/v1/{collection}` | `/v1/programs` | The collection |
| `/v1/{collection}/{id}` | `/v1/programs/bsce` | One member |
| `/v1/{collection}/{id}/{sub}` | `/v1/campuses/manila/units` | A sub-collection scoped to a member |

Collections are **plural, lowercase, hyphen-free**. `programs`, `campuses`, `units`, `announcements`, `scholarships`, `documents`, `offices`, `officials`, `procedures`.

Never `/v1/getProgram`, never `/v1/program-list`, never a verb anywhere in a path segment.

### 2.2 Identifiers in URLs

**`slug` is the public identifier. UUIDs are never exposed in URLs** ([`03-TDD.md §2.1`](./03-TDD.md)).

Slugs are stable, human-readable, and URL-safe. A UUID in a URL is unreadable, unguessable, and leaks nothing useful to a consumer who wants to hand-write a request.

Where a slug is only unique within a parent, the URL must carry the parent:

```
GET /v1/documents/manila/student-handbook     ✅ campus-qualified
GET /v1/documents/student-handbook            ❌ collides across campuses (E9)
```

The `ref` grammar (`manila/coe/bscpe`) is the fully-qualified form and appears **in payloads**, not as a path segment. See [`10-data-dictionary.md §3`](./10-data-dictionary.md).

### 2.3 Sub-resources vs filters

Use a sub-collection when the child cannot exist without the parent. Use a filter when it can.

```
GET /v1/campuses/manila/units        ✅ a unit belongs to exactly one campus
GET /v1/programs?campus=manila       ✅ a program is campus-agnostic; offerings are filtered
GET /v1/campuses/manila/programs     ❌ implies programs belong to campuses. They do not (ADR-003)
```

That last line is not pedantry. [ADR-003](./02-ADRs.md#adr-003) splits canonical `programs` from `program_offerings` precisely so "where can I study X" is answerable. A URL that re-nests programs under campuses undoes the model.

---

## 3. Methods

v1 is **read-only**. Every endpoint is `GET`, with one exception.

| Method | Used for | Semantics |
|---|---|---|
| `GET` | Everything | Safe, idempotent, cacheable |
| `POST` | `/v1/rag/query` only | Non-idempotent-looking, but only because the query body exceeds sane URL length |

`POST /v1/rag/query` is a **custom method** (AIP-136) — an operation that is genuinely not a resource fetch. It is the only one. Adding a second requires an ADR.

`HEAD` and `OPTIONS` are handled by the framework. `PUT`, `PATCH`, `DELETE` return `405` and must stay that way — [PRD C1](./01-PRD.md) makes the absence of a write path architectural, not an oversight.

---

## 4. Response envelope

Every successful response is one of two shapes. No third shape.

### 4.1 Single resource

```json
{
  "data": { "...": "the resource" },
  "provenance": {
    "source_url": "https://tup.edu.ph/...",
    "last_verified_at": "2026-08-20T02:14:00Z",
    "first_seen_at": "2026-06-02T02:11:00Z",
    "confidence": "high",
    "staleness_days": 9
  }
}
```

### 4.2 Collection

```json
{
  "data": [ { "...": "resource" } ],
  "meta": { "count": 20, "has_more": true },
  "links": { "self": "...", "next": "..." }
}
```

In collections, `provenance` appears **per item inside `data`**, not at the top level. Items in one response can have different ages, and a single top-level timestamp would hide exactly the thing this API exists to reveal ([ADR-004](./02-ADRs.md#adr-004)).

### 4.3 The provenance rule

**`provenance` ships in the default payload.** Not behind `?include=`, not in a debug mode, not opt-in.

This is the single most important rule in this document. An opt-in trust signal is a trust signal nobody sees. Any endpoint returning canonical data without provenance is a bug, and the contract test suite must fail on it.

Endpoints exempt: `/v1/health`, `/v1/meta/*`, `/v1/search` (which returns provenance per hit, inside each result object).

---

## 5. Field conventions

| Rule | Value | Note |
|---|---|---|
| Case | `snake_case` | Consistent with the DB; no translation layer to get wrong |
| Timestamps | RFC 3339, UTC, `Z` suffix | `2026-08-20T02:14:00Z` |
| Timestamp names | end in `_at` | `last_verified_at`, `first_seen_at` |
| Durations / counts | end in `_days`, `_count` | `staleness_days` |
| Booleans | `has_`, `is_` prefix | `has_more`, `is_active` |
| Enums | lowercase, underscore | `baccalaureate`, `program_group` |
| Absent vs null | **omit optional fields; never emit `null`** | except where null is a meaningful "known to be absent" |
| Arrays | never `null` — emit `[]` | a consumer should never branch on this |
| Money | string, with `currency` sibling | never a float |

### 5.1 The one enum that must not change

```sql
CREATE TYPE confidence_level AS ENUM ('low', 'medium', 'high');
```

Ascending. Postgres orders enums by declaration order and this cannot be altered later without rewriting nine tables. Every `min_confidence` filter inverts silently if this is wrong — [`00-errata.md`](./00-errata.md) E1, [`12-build-prerequisites.md`](./12-build-prerequisites.md) D3.

### 5.2 `unit_type` must always be present

Manila and Visayas have **colleges**. Cavite has **departments** ([ADR-002](./02-ADRs.md#adr-002)). Any response containing an academic unit carries `unit_type`. Never flatten it to "college" for convenience, and never omit it because a particular endpoint happens to return only colleges today.

---

## 6. Query parameters

| Parameter | Type | Rule |
|---|---|---|
| `limit` | int | default 20, max 100, `400` above max |
| `cursor` | opaque string | never constructed by consumers |
| `campus` | enum slug | validated against the four known campuses |
| `min_confidence` | enum | `low` \| `medium` \| `high`, inclusive lower bound |
| `updated_since` | RFC 3339 | for incremental sync |
| `q` | string | search only; 1–200 chars |

**Reject unknown parameters with `400`.** Silently ignoring a typo'd filter returns unfiltered data that looks filtered — the worst possible failure for an API whose value is precision. Zod `.strict()` on every query schema.

Filters combine with **AND**. There is no `OR` syntax and no query DSL. If one is ever needed it goes in `/v1/search`, not in resource filters.

---

## 7. Pagination

Cursor-based, always ([ADR-009](./02-ADRs.md#adr-009)).

- Cursors are **opaque**. Base64 of an internal keyset. Documented as unparseable, and the format may change without a version bump.
- `meta.has_more` is authoritative for "keep going", not `links.next` presence.
- A cursor from a request with different filters is invalid → `400`.
- Cursors do not expire, but rows they point past may have been reconciled away. That is acceptable and documented.

`OFFSET` is banned. It is `O(n)` at depth, and it duplicates and skips rows whenever the underlying set changes between fetches — which happens on **every ingestion run**.

---

## 8. Errors

RFC 9457 Problem Details, content type `application/problem+json` (AIP-193 in spirit — one consistent error shape, machine-readable).

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

### 8.1 The status code allowlist

Only these. Anything else is a bug.

| Status | When | `type` slug |
|---|---|---|
| `200` | Success | — |
| `304` | `If-None-Match` matched | — |
| `400` | Invalid or unknown parameter | `invalid-parameter` |
| `404` | No such resource | `not-found` |
| `405` | Write method attempted | `method-not-allowed` |
| `422` | Syntactically valid, semantically impossible | `unprocessable` |
| `429` | Rate limited | `rate-limited` |
| `500` | Unhandled | `internal` |
| `503` | Maintenance or ingestion lock | `unavailable` |

`401` and `403` do not appear. There is no auth surface ([`05-deployment-and-operations.md §7`](./05-deployment-and-operations.md)).

### 8.2 Error rules

- Every `type` URI must resolve to a real documentation page. A dead error link is worse than no link.
- `detail` names the offending value. `"No program with slug 'bsit-x'"`, not `"Not found"`.
- `404` on a slug-shaped path **must** attempt `did_you_mean` via `pg_trgm` similarity. Cheap, and it is the difference between a usable API and a frustrating one.
- Never leak SQL, stack traces, hostnames, or driver messages. `500` returns the generic body; the detail goes to Sentry with the `run_id`.
- `429` must send `Retry-After`.

---

## 9. Versioning and compatibility

Version lives in the path: `/v1/`. Blunt, visible, cacheable, and impossible to forget to send.

### 9.1 What is additive (ship freely)

- New endpoint
- New optional query parameter
- **New field in a response object**
- New enum value in a field documented as open-ended
- Relaxing a validation rule

Consumers must tolerate unknown fields. This is stated in the consumer guide and is a condition of the contract.

### 9.2 What is breaking (needs `/v2` or a deprecation cycle)

- Removing or renaming any field
- Changing a field's type or format
- **Adding a new enum value to a field consumers switch on** — `unit_type` is the live risk here
- Making an optional parameter required
- Narrowing a validation rule
- Changing default `limit`, default sort, or pagination semantics
- Changing what an existing field *means* while keeping its type

That second-to-last one catches people. Tightening validation "to be more correct" breaks every client that was sending the loose form.

### 9.3 Deprecation policy

1. Announce in the changelog and mark `deprecated: true` in OpenAPI.
2. Serve `Deprecation: true` and `Sunset: <RFC 1123 date>` headers on affected routes.
3. Minimum **180 days** between `Sunset` announcement and removal.
4. `Link: <...>; rel="successor-version"` pointing at the replacement.

The breaking-change CI gate diffs `openapi.json` against the last release and fails on any §9.2 change unless the PR carries a `breaking-change` label.

---

## 10. HTTP caching

The API is read-only over data that changes at most daily. Caching is not an optimization here — it is the primary defence for a project on free-tier infrastructure.

| Header | Value | Where |
|---|---|---|
| `ETag` | Strong, derived from `content_hash` + `last_verified_at` | Every `200` |
| `Cache-Control` | `public, max-age=300, stale-while-revalidate=3600` | Reference data |
| `Cache-Control` | `public, max-age=60` | `/v1/announcements` |
| `Cache-Control` | `no-store` | `/v1/health` |
| `Vary` | `Accept-Encoding` | Everywhere |

`If-None-Match` must be honoured and return `304` with no body.

**Freshness tension, resolved:** the product is honesty about data age, so long cache TTLs are suspect. They are not, because `last_verified_at` is *inside the cached body*. A five-minute-old cache of a nineteen-year-old fact still tells the truth about that fact. Cache TTL and data age are independent, and only the second one is the product.

---

## 11. Security and transport

| Control | Rule |
|---|---|
| TLS | Required. HSTS on. No plaintext listener. |
| CORS | `Access-Control-Allow-Origin: *` for `GET /v1/*`. It is public data. |
| Headers | `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` |
| Input | Zod on every request, `.strict()`, reject unknown |
| SQL | Drizzle parameterized only. No string concatenation, ever. |
| Rate limit headers | `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` |
| Secrets | Never in a response, never in an error, never in a log line |
| Personal data | Structurally impossible — no auth, no user table, CI grep gate |

Payload size cap: `limit=100` with full provenance stays under ~500 KB gzipped. Any endpoint that can exceed 1 MB in one response needs pagination it currently lacks.

---

## 12. Documentation obligations

An endpoint is not done when it returns correct JSON. It is done when a stranger can use it without asking you.

Each endpoint must ship with:

- Zod `.describe()` on every field — this becomes the OpenAPI description
- At least one realistic example response, with **real slugs**, not `foo`/`bar`
- Documented error cases beyond the generic ones
- An entry in [`06-consumer-guide.md`](./06-consumer-guide.md) if it introduces a new concept

`openapi.json` is rendered as browsable docs at `docs.<domain>`. Generated, so it cannot drift.

---

## 13. Observability contract

Every response carries `X-Request-Id`, echoed into logs and Sentry. A consumer reporting a problem quotes it, and the entire request is reconstructible.

Every ingestion-derived row is traceable to an `ingest_runs.run_id`, so "why does this field say that" is always answerable from `change_events` ([`10-data-dictionary.md`](./10-data-dictionary.md)).

Metrics per [`05-deployment-and-operations.md §5.2`](./05-deployment-and-operations.md). Log at stage boundaries with counts — never per record.

---

## 14. Checklist — adding an endpoint

```
[ ] Zod request + response schemas in packages/schemas, .strict(), .describe() on every field
[ ] Path is a plural noun; identifier is a slug, not a UUID
[ ] Campus-qualified if the slug is not globally unique
[ ] provenance present in the default payload (or on the exemption list §4.3)
[ ] unit_type present wherever an academic unit appears
[ ] Collection endpoint paginates by cursor; limit capped at 100
[ ] Unknown query parameters rejected with 400
[ ] 404 path attempts did_you_mean
[ ] ETag + Cache-Control set; If-None-Match returns 304
[ ] Status codes drawn only from the §8.1 allowlist
[ ] Example response uses real slugs
[ ] pnpm openapi:generate run; diff reviewed and committed
[ ] Contract test asserts the response validates against the published spec
[ ] Consumer guide updated if a new concept was introduced
```

If any line is unchecked, the endpoint is not shippable.

---

## 15. Standards this follows

| Standard | Applied to |
|---|---|
| OpenAPI 3.1 | The published contract, generated from Zod |
| RFC 9457 | Problem Details error format |
| RFC 3339 | All timestamps |
| RFC 9110 | HTTP semantics, conditional requests, `Retry-After` |
| RFC 8594 | `Sunset` header for deprecation |
| Google AIP-121/122 | Resource-oriented design, resource naming |
| Google AIP-180/185 | Backward compatibility, versioning |
| Google AIP-136 | Custom methods — the `/v1/rag/query` exception |
| Semantic Versioning | The published SDK, not the API path version |

Where a standard and a rule in this document conflict, this document wins and the conflict gets recorded as an ADR.
