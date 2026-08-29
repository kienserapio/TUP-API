# 11 — Adapter Authoring Guide

**Prerequisites:** [`02-ADRs.md ADR-005`](./02-ADRs.md), [`03-TDD.md §3`](./03-TDD.md), [`08-source-landscape.md`](./08-source-landscape.md)
**Audience:** anyone adding or repairing a campus adapter, including you in six months
**Resolves:** the "TDD Appendix" and `CONTRIBUTING.md` adapter checklist referenced by [`07-governance-and-distribution.md §5.2`](./07-governance-and-distribution.md) but never written

[`07-governance-and-distribution.md §5.2`](./07-governance-and-distribution.md) names the real continuity test:

> Not "is the code documented" but: **can a new contributor add a campus adapter without talking to the original author?**

This document is the answer. If it is unclear, the project fails that test.

---

## 1. What an adapter is, and is not

An adapter has exactly two jobs:

```ts
export interface CampusAdapter {
  readonly campusSlug: string;
  readonly domains: string[];
  discover(): AsyncIterable<SourceRef>;          // which URLs exist
  parse(snapshot: RawSnapshot): Promise<ParseResult>;   // bytes → typed records
  expectations?: Partial<Record<EntityType, { min: number; max: number }>>;
}
```

**An adapter never:**

| Never | Because |
|---|---|
| calls `fetch`, `undici`, or any HTTP client | Politeness, robots, and the domain allowlist are enforced in one place (ADR-005). An adapter that fetches can bypass them. |
| reads `robots.txt` | Same. The fetcher owns it. |
| touches the database | Reconcile, guard, and publish own writes. An adapter that writes cannot be quarantined. |
| calls `Date.now()`, `Math.random()`, or `crypto.randomUUID()` | Kills fixture testing — see §3. |
| sets `confidence` | Derived from `method` and entity type ([`09-freshness-and-confidence.md §2`](./09-freshness-and-confidence.md)). An adapter that self-reports confidence will always report high. |
| sends `Cookie` or `Authorization` | PRD C1. CI rejects it. |
| hard-codes a hostname | [`08-source-landscape.md §1`](./08-source-landscape.md) owns origins. Two campuses serve on the host you would guess wrong. |

This is composition, not inheritance, and deliberately so: a base class would let an adapter override the safety layer.

---

## 2. `discover()`

Yields the URLs this adapter knows about. It is an `AsyncIterable` so an adapter can page through an index, but it **must not fetch** — it yields `SourceRef`s that the fetcher will resolve.

```ts
async *discover(): AsyncIterable<SourceRef> {
  const origin = CANONICAL_ORIGIN.cavite;   // never a literal hostname

  for (const slug of ['engineering', 'dit', 'ded', 'dla', 'dms']) {
    yield { url: `${origin}/dept/${slug}`, entityTypes: ['academic_unit'], method: 'crawl' };
  }

  yield { url: `${origin}/programs`, entityTypes: ['program_offering'], method: 'crawl' };
  yield { url: `${origin}/news`, entityTypes: ['announcement'], method: 'crawl',
          recrawlInterval: '6 hours', hint: { role: 'index' } };
}
```

**Explicit lists over recursive crawling.** Every adapter enumerates known routes. No adapter follows links. This bounds request volume by construction, makes `maxPagesPerRun` a formality rather than a safety net, and means a site redesign produces a 404 you can see rather than an unbounded crawl you cannot.

**Never enumerate numeric IDs by incrementing.** Cavite's `/news/{id}` is numeric; discover IDs from the `/news` index page and yield only those. Incrementing generates 404 traffic against a live site and will eventually look like probing.

Two-pass discovery — where the index must be fetched before item URLs are known — is expressed by yielding the index with `hint: { role: 'index' }`; the pipeline re-invokes `discover()` with the parsed index available. It does **not** justify fetching inside `discover()`.

---

## 3. `parse()` must be pure

```ts
async parse(snapshot: RawSnapshot): Promise<ParseResult>
```

Same bytes in, same records out, forever. No network, no clock, no randomness, no environment reads.

This is not a style preference. It is the precondition for the highest-value test category in the project: a committed HTML fixture with an expected-JSON file, compared by exact equality. A parser that reads the clock cannot be tested that way, and a parser that cannot be tested that way will rot silently the first time a site is redesigned — which [`01-PRD.md §8`](./01-PRD.md) R1 rates as High likelihood.

Where a timestamp is genuinely needed — a published date on an announcement — parse it **from the document**. If it is absent, emit `null` and let the pipeline decide. `parse()` never substitutes "now" for a missing date; that fabricates provenance, which is the one thing this project cannot do.

### 3.1 Reject, never coerce

```ts
// wrong — invents data and hides a parser break
name: el.find('h2').text() || 'Unknown Program',

// right — a missing name is a parser bug, and the guard must see it
const name = el.find('h2').text().trim();
if (!name) { warnings.push(`missing name at ${el.attr('id')}`); continue; }
```

A program with a null name is a parser bug, not a data point ([`03-TDD.md §3.4`](./03-TDD.md)). Coercion converts a loud, catchable failure into published garbage. Push a `warning` and skip the record; if enough records are skipped the guard quarantines the run, which is the intended outcome.

### 3.2 Selector discipline

Prefer, in order:

1. Semantic structure — `main article h2`, table headers, `<dl>` pairs
2. Stable text anchors — the cell to the right of a `<th>` whose text is `Duration`
3. Explicit ids and data attributes
4. Positional selectors — `div:nth-child(3) > span` — **last resort, always commented with why**

Positional selectors are the first thing a redesign breaks. When one is unavoidable, say so in a comment so the next person knows it is fragile by necessity rather than by carelessness.

---

## 4. `expectations`

```ts
expectations = {
  academic_unit:     { min: 4,  max: 8   },
  program_offering:  { min: 10, max: 50  },
  office:            { min: 8,  max: 20  },
};
```

These are **full-run** ranges: the count expected when every source for that entity type was parsed. The guard skips them on incremental runs, where most sources are unchanged and the count is legitimately partial ([`00-errata.md`](./00-errata.md) E3).

Set them from observed reality plus honest headroom, not from ambition. Too narrow and every legitimate change quarantines and you learn to ignore quarantines — which [`01-PRD.md §7`](./01-PRD.md) names as an anti-metric. Too wide and they catch nothing. A good rule: observed count, ±40%, rounded outward.

---

## 5. Fixtures

**Every adapter PR needs fixtures. No exceptions** ([`07-governance-and-distribution.md §7.2`](./07-governance-and-distribution.md)).

```
fixtures/
  cavite/
    2026-08-20/
      programs.html               # verbatim bytes as fetched
      programs.expected.json      # exact ParseResult
      dept-engineering.html
      dept-engineering.expected.json
    MANIFEST.json                 # url, fetched_at, sha256, collected_by, note
```

The test is exact equality:

```ts
it('parses Cavite programs', async () => {
  const snap = loadFixture('cavite/2026-08-20/programs.html');
  expect(await adapter.parse(snap)).toEqual(loadExpected('cavite/2026-08-20/programs.expected.json'));
});
```

Not `toMatchObject`, not a length assertion. Exact. A partial assertion passes while a field silently goes null, which is the failure mode fixtures exist to catch.

**Rule: every quarantine incident adds a fixture** ([`03-TDD.md §6`](./03-TDD.md)). Over time the suite becomes a record of every redesign survived, and RB-01 step 5 makes this mandatory rather than aspirational.

Fixtures are captured once, by hand or by `pnpm ingest:snapshot --url=...`, and committed. **Local and CI never hit live TUP sites** ([`05-deployment-and-operations.md §1`](./05-deployment-and-operations.md)) — that is what keeps the project polite and the tests deterministic.

---

## 6. Manual sources

For a source the fetcher cannot reach — a WAF block ([`08-source-landscape.md §3.1`](./08-source-landscape.md)), a newly-appearing robots disallow (RB-03), or a Cloudflare AI-bot rule ([`08-source-landscape.md §5.1`](./08-source-landscape.md)) — a human opens the public page in a browser and saves it.

```
fixtures/manual/manila/
  pages-students-tup-student-handbook.html
  MANIFEST.json    # url, collected_at, collected_by, sha256
```

`method: 'manual'` sources read from disk instead of the network. **Everything downstream is identical** — parse, validate, guard, publish, provenance. `sources.url` still records the real URL so citations point at the live page.

Two things this is not. It is not a way around a block that has been *stated* — if a site names `TUPOpenDataBot` in robots or returns a deliberate 403, that is a decision to respect, and the right response is [`07-governance-and-distribution.md §4`](./07-governance-and-distribution.md), not manual collection. And it is not a permanent mode: a scheduled job opens a reminder issue when a manual source exceeds 120 days.

Manual collection is the **disaster-recovery path** for sources that are publicly readable but mechanically awkward. Keep it working even while every campus is crawlable, because [`08-source-landscape.md`](./08-source-landscape.md) shows how fast that can change.

---

## 7. Definition of done

An adapter is finished when every box is ticked. This is the checklist `CONTRIBUTING.md` links to.

**Contract**
- [ ] `discover()` yields an explicit list; no recursion, no ID incrementing
- [ ] Every URL built from `CANONICAL_ORIGIN`, never a literal hostname
- [ ] `parse()` is pure — no network, no clock, no randomness, no env
- [ ] `parse()` rejects rather than coerces; skipped records push a `warning`
- [ ] No `Cookie`, no `Authorization`, no auth of any kind
- [ ] No `confidence` set by the adapter
- [ ] `expectations` populated for every entity type produced

**Data**
- [ ] Slugs are stable and derived from a durable field, not a title that can be edited
- [ ] `source_key` populated where the site has a numeric or opaque id
- [ ] `unit_type` correct for this campus — do not assume `college` ([`02-ADRs.md ADR-002`](./02-ADRs.md))
- [ ] Program names emitted verbatim in `source_name`; canonicalisation is the registry's job
- [ ] No personal data beyond officials' names, titles, and official addresses (PRD C1)

**Tests**
- [ ] A fixture and an `.expected.json` per entity type, asserted with `toEqual`
- [ ] `MANIFEST.json` complete — url, fetched_at, sha256, collected_by
- [ ] A deliberate selector break demonstrably quarantines rather than publishing
- [ ] Zod round-trip passes on every emitted record

**Operations**
- [ ] `pnpm ingest --adapter=X` runs clean twice; the second run reports mostly *unchanged*
- [ ] Adapter README records: canonical origin, route inventory, known quirks, and any open question resolved while writing it
- [ ] [`08-source-landscape.md`](./08-source-landscape.md) updated if anything about the host changed
- [ ] Ten records spot-checked by a human against the live source

That last box is the one people skip and the only one that catches a parser that is confidently wrong — reading the right element for the wrong field. [`04-implementation-plan.md §1`](./04-implementation-plan.md) is right to call it "the only real correctness check at this stage."

---

## 8. Adding a new campus

The claim in [`04-implementation-plan.md §2`](./04-implementation-plan.md) is that adding a campus is a `parse()` function and zero migrations. Holding to it:

1. Add the slug to `CampusSlug` and `CANONICAL_ORIGIN`.
2. Add the campus row to `seeds/campuses.yaml` by hand. **Do not scrape what you can type.**
3. Verify the host with `scripts/verify-sources.sh` and add a section to [`08-source-landscape.md`](./08-source-landscape.md).
4. Write `discover()` and `parse()`.
5. Capture fixtures; write the expected JSON by hand first, then make the parser satisfy it.
6. Extend `seeds/programs.yaml` with any new degree name variants as `aliases`. **Never auto-create a canonical program from a fuzzy match** ([`02-ADRs.md ADR-003`](./02-ADRs.md)).
7. Run `pnpm ingest:unmatched` and resolve every unmatched offering, or document why it stays unmatched.
8. Work the §7 checklist.

**If step 4 requires a schema migration, stop.** [`04-implementation-plan.md §2`](./04-implementation-plan.md) makes "zero migrations to add campuses 2 and 3" the exit criterion for a reason: it is the test of whether ADR-002 and ADR-003 were right. A migration at that point means the schema is wrong, and it is far cheaper to fix then than after launch.

---

## 9. When a parser breaks

Follow RB-01 in [`05-deployment-and-operations.md §6`](./05-deployment-and-operations.md). The short version, and the part worth internalising:

**There is no time pressure.** The guard preserved the existing data. The site is stale with an honest timestamp, which is the degradation ADR-006 was designed to produce. Read the quarantine row, pull the triggering snapshot, diff it against the last good one, fix the selector, **add the new snapshot as a fixture**, and merge.

Resist the urge to bypass the guard to "get data flowing again". The guard is the only thing standing between a redesign and silent data loss, and a bypass that ships once becomes a bypass that lives in the codebase.
