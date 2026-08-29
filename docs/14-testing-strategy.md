# 14 — Testing Strategy

**Prerequisites:** [`02-ADRs.md`](./02-ADRs.md), [`11-adapter-guide.md`](./11-adapter-guide.md)
**Audience:** anyone writing code in this repo
**Added:** 2026-08-29

---

> [!IMPORTANT]
> **Tests never touch live TUP sites.** Not locally, not in CI, not "just this once to check." Every test runs against committed fixtures. This is a politeness requirement ([PRD C2/C3](./01-PRD.md)) before it is an engineering one, and the domain allowlist plus the fixture-only rule are what make it enforceable rather than aspirational.

## 1. What actually breaks in this project

Test effort should follow failure probability, not code volume. Ranked by how likely it is to hurt you:

| Rank | Failure | Likelihood | Detected by |
|---|---|---|---|
| 1 | A campus redesigns; a selector silently returns `[]` | **Certain, repeatedly** | Golden fixture tests + the guard |
| 2 | A response shape drifts from the published contract | High | Spec drift gate + contract tests |
| 3 | Reconcile marks live data `removed` | Medium, catastrophic | Pipeline integration tests |
| 4 | `min_confidence` filter inverts | Low, silent, severe | Enum ordering test |
| 5 | Cursor pagination skips or duplicates rows | Medium | Pagination property test |
| 6 | Hybrid search under-returns due to HNSW post-filtering | High | Retrieval eval set |
| 7 | Hono handler throws on an edge case | Low | Unit tests |

Note where rank 7 sits. **Handler unit tests are the least valuable tests in this repo** and most projects write them first. Do not.

---

## 2. The shape of the suite

Not a pyramid. This project's distribution is unusual and should stay that way.

```
      ┌────────────────────────────┐
      │  Golden fixture tests      │  ~50% of effort — parse purity pays off here
      ├────────────────────────────┤
      │  Pipeline integration      │  ~20% — reconcile, guard, publish against real Postgres
      ├────────────────────────────┤
      │  Contract tests            │  ~15% — responses vs openapi.json
      ├────────────────────────────┤
      │  Unit tests                │  ~10% — pure helpers only
      ├────────────────────────────┤
      │  Smoke tests               │  ~5%  — post-deploy, against production
      └────────────────────────────┘
```

Runner is **Vitest** throughout. One tool, one config, one watch mode.

---

## 3. Golden fixture tests — the highest-value category

[ADR-005](./02-ADRs.md#adr-005) makes `parse` a **pure function**: snapshot in, `ParseResult` out. No network, no `Date.now()`, no randomness. That purity exists for exactly one reason — it makes this category possible.

### 3.1 Layout

```
fixtures/
  manila/
    programs-coe-2026-08-20.html          # the captured snapshot
    programs-coe-2026-08-20.expected.json # the exact ParseResult
  cavite/
    dept-engineering-2026-08-20.html
    dept-engineering-2026-08-20.expected.json
  manual/
    ...
```

### 3.2 The test

```ts
test.each(fixturesFor('manila'))('parses %s', async (fixture) => {
  const snapshot = await loadFixture(fixture.html);
  const result = manilaAdapter.parse(snapshot);
  expect(result).toEqual(await loadExpected(fixture.expected));
});
```

Deep equality against the whole result. Not "contains", not "length > 0". A partial assertion passes when a redesign silently drops half the rows — which is the exact failure this suite exists to catch.

### 3.3 Fixture rules

- **Every quarantine incident becomes a fixture.** Mandatory, [`05-deployment-and-operations.md` RB-01 step 5](./05-deployment-and-operations.md). This is how the suite accumulates a record of every site redesign the project has survived.
- Fixtures are **never edited to make a test pass**. If output changed legitimately, update the `.expected.json` in the same commit as the adapter change, and say why in the message.
- Filenames carry the capture date. A three-year-old fixture is still a valid regression test.
- Fixtures are committed HTML. Large, and worth it — they are the only reason a parser rewrite is safe.
- Strip nothing from captured HTML. The junk is the point.

### 3.4 Determinism

`parse` must produce byte-identical output for identical input, forever.

Banned inside `parse`: `Date.now()`, `new Date()` with no argument, `Math.random()`, `crypto.randomUUID()`, network calls, filesystem reads, locale-dependent formatting, iteration over an unordered `Set`/object where order reaches the output.

Timestamps and ids are assigned by the **pipeline**, after `parse` returns. A CI lint rule should reject those calls inside `packages/adapters`.

---

## 4. Pipeline integration tests

Run against a **real local Postgres** (Docker, pgvector image, matching production's major version). Not a mock, not an in-memory shim. The behaviours worth testing are Postgres behaviours: enum ordering, unique constraint violations, transaction rollback, index usage.

### 4.1 The tests that matter most

| Test | Asserts |
|---|---|
| Enum ordering | `'low' < 'medium' < 'high'` in a real `ORDER BY`. Guards [E1](./00-errata.md). |
| uuidv7 time-ordering | Two ids generated a millisecond apart sort in creation order. The entire reason for v7 over v4 — [`10-data-dictionary.md §2.1`](./10-data-dictionary.md). |
| Guard: zero rows | Parser returns `[]` where rows existed → quarantine, **existing data untouched** |
| Guard: >30% drop | Quarantine, data preserved |
| Guard: >2× increase | Quarantine, data preserved |
| Guard scoping | A run touching only `source_ids` A and B does **not** quarantine or remove entities from source C. Guards [E3](./00-errata.md) — the defect that would break every healthy incremental run. |
| Removal requires 3 misses | One miss → `status = 'unknown'`. Three consecutive → `'removed'`. |
| Content-hash gating | Unchanged content → no new snapshot, no `change_events` row. Guards [E2](./00-errata.md). |
| Reconcile field-level diff | Only changed fields appear in `change_events` |
| Idempotent seed | `pnpm seed` twice → identical DB state |
| Excluded sources | A URL in `excluded_sources` is never fetched and never published, even after a re-crawl |

The guard-scoping test is the single most important integration test in the repo. Without it, the first incremental run in production quarantines everything and then marks live data removed.

### 4.2 Isolation

Each test file gets a fresh schema, migrated and seeded, dropped after. Slower than sharing, and worth it — cross-test contamination in a suite this stateful produces failures nobody can reproduce.

---

## 5. Contract tests

Assert that what the API **actually returns** validates against the **published** `openapi.json`.

```ts
test('GET /v1/programs matches the published contract', async () => {
  const res = await app.request('/v1/programs?campus=manila');
  expect(res.status).toBe(200);
  expect(validateAgainstSpec('/v1/programs', 'get', 200, await res.json())).toBe(true);
});
```

Because the spec is generated from the same Zod schemas the handlers use, this looks circular. It is not — it catches the gap between *schema* and *serialization*: fields added after validation, `null` where the schema says the field is omitted, dates serialized in the wrong format, envelope assembled by hand in one handler and by a helper in the rest.

### 5.1 Universal contract assertions

Run against **every** endpoint, table-driven, so a new endpoint inherits them automatically:

- Canonical-data responses include `provenance` in the default payload ([`13-api-design-standards.md §4.3`](./13-api-design-standards.md))
- Any academic unit in a payload carries `unit_type`
- No response contains a raw UUID in a URL field
- No response field is `null` where the schema declares it omitted
- Arrays are `[]`, never `null`
- Every collection endpoint honours `limit`, caps at 100, and `400`s above it
- Every endpoint `400`s on an unknown query parameter
- Every error body is valid RFC 9457 with a `type` that resolves
- Status code appears on the §8.1 allowlist

That list turns [`13-api-design-standards.md`](./13-api-design-standards.md) from prose into an executable gate. Without it the standards doc is a suggestion.

---

## 6. Unit tests — narrow on purpose

Only for pure logic with real branching:

- `ref` grammar construction and parsing
- Cursor encode/decode round-trip, including "different filters → invalid cursor"
- Confidence decay: given `last_verified_at` and an entity type, the expected level ([`09-freshness-and-confidence.md`](./09-freshness-and-confidence.md))
- Canonical program registry matching — name variant in, slug out, and unmatched names surface rather than silently dropping
- Heading-path construction for chunking ([ADR-015](./02-ADRs.md#adr-015))
- robots.txt evaluation, including the Visayas `Content-Signal` case ([`08-source-landscape.md §5.1`](./08-source-landscape.md))

Do **not** unit-test Hono handlers by mocking the database. That tests the mock. Integration and contract tests already cover handlers with a real DB.

---

## 7. Retrieval evaluation — Phase 3.5

Not a pass/fail test. A **tracked metric** that must not regress.

A fixed set of ~40 real student questions with hand-labelled correct source passages. Reported as recall@5 and MRR.

| Guards against | Symptom without it |
|---|---|
| Chunker changes | Silent recall loss after a "harmless" refactor |
| Embedding model swap ([D5](./12-build-prerequisites.md)) | No way to justify or reject the change |
| HNSW post-filtering under-return ([E8](./00-errata.md)) | Blamed on the chunker for weeks |
| `english` vs `simple` FTS config ([E22](./00-errata.md)) | `TUPSTAT`, `BTVTEd`, `COPC` stem into uselessness |

Budget 6–8 hours to build the eval set. It is the only way to make Phase 3 decisions with evidence instead of assertion, and both E8 and E22 are explicitly deferred to it.

---

## 8. Smoke tests — post-deploy, against production

Five checks, run automatically after every deploy. Fail → alert.

```
GET /v1/health                → 200, status ok, hours_since_ingest < 36
GET /v1/campuses              → 200, exactly 4 campuses
GET /v1/programs/bsce         → 200, offerings present, provenance present
GET /v1/programs?campus=xxxxx → 400, RFC 9457 body
GET /openapi.json             → 200, parses, version matches the deployed build
```

The `hours_since_ingest` assertion is doing double duty: it is also defence #2 against silent staleness, the project's named anti-metric ([`12-build-prerequisites.md §4`](./12-build-prerequisites.md)).

---

## 9. CI gates

From [`05-deployment-and-operations.md §3`](./05-deployment-and-operations.md), plus what this document adds:

| Gate | Fails when | Why it exists |
|---|---|---|
| `typecheck` | Any TS error | `strict: true`, no exceptions |
| `lint` | ESLint + Prettier violations | — |
| `test` | Any test fails | Includes golden fixtures |
| **Spec drift** | Generated `openapi.json` ≠ committed | Contract changes must be intentional and reviewable |
| **Breaking change** | Spec diff removes/narrows anything | Unless labelled `breaking-change` + version bumped |
| **Personal data** | Adapter sends `Cookie`/`Authorization`, or references AIMS/ERS | Makes [PRD C1](./01-PRD.md) structural |
| **No live network in tests** | Test code references a TUP hostname outside `fixtures/` | Makes the politeness rule enforceable |
| **Parse purity** | `Date.now`/`Math.random`/`fetch` inside `packages/adapters` | Protects fixture determinism |

The last two are added by this document. Both are grep-based, both take twenty minutes, and both prevent a class of failure that is otherwise invisible until production.

---

## 10. Coverage

**No global percentage target.** A number invites tests written to satisfy the number.

Enforced instead:

- Every adapter has **at least one golden fixture per entity type it produces**. Checked by a test that enumerates adapters and asserts fixture presence — an adapter with no fixtures fails CI.
- Every endpoint appears in the contract test table.
- Every guard branch in §4.1 has a test.

An adapter shipping without fixtures is the failure mode this replaces, and a coverage percentage would not have caught it.

---

## 11. Local commands

```bash
pnpm test                      # everything
pnpm test:unit                 # fast, no DB
pnpm test:integration          # requires local Postgres
pnpm test:contract             # requires a running API
pnpm test:fixtures             # golden tests only
pnpm test --watch              # development loop
pnpm test:eval                 # retrieval eval, Phase 3+
```

Setup in [`15-local-development.md`](./15-local-development.md).

---

## 12. What is deliberately not tested

Recorded so it does not get treated as an oversight:

- **Live site availability.** That is monitoring, not testing. Alert #3 and the Taguig liveness probe cover it.
- **Third-party libraries.** Not your job.
- **Framework routing.** Hono's tests cover Hono.
- **Load and performance.** Traffic is a few thousand requests a day behind a CDN. Revisit if that changes by two orders of magnitude.
- **The MCP server's tool implementations, separately.** They are thin wrappers over tested endpoints. Test that each tool calls the right endpoint with the right parameters, and stop there.
