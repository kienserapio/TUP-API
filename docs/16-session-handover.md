# 16 — Session Handover

**Written:** 2026-08-30
**Covers:** the session that built M4–M9 and the first deployment
**Audience:** whoever picks this up next, including you in a week
**Status:** current as of commit `837e08c`

This is not a design document — the numbered set above it is. This one answers a
narrower question: *what is true right now, what did the last session decide, and what
should the next one do first?*

---

## 1. Thirty-second version

The API is **live**, serving **three campuses of real crawled data** with provenance on
every record, from a database that nothing currently refreshes.

```
https://tup-api.vercel.app
https://github.com/kienserapio/TUP-API
```

| | |
|---|---|
| Modules done | M0–M7, M9 |
| Module partly done | M8 (deployed; no cron, no monitoring) |
| Tests | 325, green |
| CI | green |
| Schema migrations | 8, none campus-specific |
| Unmatched offerings | 0 |

**The one thing decaying while you read this:** nothing re-ingests. `hours_since_ingest`
climbs forever until the cron in §9 exists.

---

## 2. What is deployed, and where

| Thing | Where | Notes |
|---|---|---|
| API | Vercel, project `tup-api`, scope `kienserapios-projects` | Region `sin1`. **Not** the `kpve` scope. |
| Database | Supabase `hqdfeljeuvuhthooaria`, `ap-southeast-1` | Postgres 17, 8 migrations applied |
| Snapshots | Supabase Storage, private bucket `snapshots` | 14 objects, keyed by content hash |
| Repo | `kienserapio/TUP-API`, public, default branch `main` | Vercel deploys on push to `main` |
| CI | GitHub Actions, `.github/workflows/ci.yml` | Gates, typecheck, lint, migrate, seed, ingest ×3, tests, spec drift |

### 2.1 Environment variables on Vercel

Set for **production and preview**. No Supabase service-role key is deployed — the API
only reads, so the blast radius stays small.

| Name | Why |
|---|---|
| `DATABASE_URL` | Session pooler, port 5432. Fallback only. |
| `DATABASE_URL_POOLED` | **Transaction pooler, port 6543.** What serverless actually uses. |
| `DATABASE_POOL_MODE` | `transaction`. Overrides autodetection. |
| `DOCS_BASE_URL` | Base for RFC 9457 error `type` URIs; points at the repo's `docs/errors/`. |

### 2.2 Data currently published

| Campus | Units | Offerings | Vocabulary |
|---|---|---|---|
| Manila | 6 | 38 | colleges |
| Visayas | 3 | 8 | colleges |
| Taguig | 4 | 8 | **departments** |
| Cavite | 5 (hand-seeded) | 0 | departments — site down, no adapter |

48 canonical programs. Every offering maps to one.

---

## 3. Running it locally

```bash
pnpm install
docker start tup-db          # or the run command in docs/15 §2
pnpm db:reset                # drop, migrate
pnpm db:seed
pnpm ingest --adapter=manila --full
pnpm ingest --adapter=visayas --full
pnpm ingest --adapter=taguig --full
pnpm dev                     # :3000
```

`pnpm verify` is what CI runs: gates, typecheck, lint, all 325 tests.

### 3.1 Two traps that will cost you an hour

**`.env` holds production credentials; `.env.local` overrides them to Docker.** dotenv
never overwrites an already-set variable, so `.env.local` wins for every local command.
This is deliberate (docs/15 §3) and it is also how a local `pnpm ingest` once wrote to
the production Supabase bucket — snapshot storage read `.env` while the database read
`.env.local`. `SNAPSHOT_STORE` now defaults to `filesystem` unless `NODE_ENV=production`
or it is set explicitly. **To target production on purpose, load only `.env`.**

**The local Postgres is on port 55433, not 5432.** `docs/15` says 5432; this machine had
something else there.

---

## 4. Decisions taken last session

Each of these changes what a future session should assume.

### D6 — Visayas AI directives: crawl, comply literally

Decided by the project owner. `tupvisayas.edu.ph` serves
`Content-Signal: search=yes,ai-train=no,use=reference` and disallows nine named AI
crawlers. `TUPOpenDataBot` is not among them and `User-agent: *` is `Allow: /`.

The position, now normative in [`07-governance-and-distribution.md §1.3.1`](./07-governance-and-distribution.md):
crawl what is permitted, identify honestly, **never train or fine-tune on ingested
content**, store the signal per domain and *fail the run* when it changes, and state the
position openly rather than resting on a robots technicality.

**Still owed:** the same commitment written into `LICENSE-DATA` and `llms.txt`. Neither
file exists. Right now the promise lives only in documentation.

### Deploy target: Vercel, not Fly

[`12-build-prerequisites.md`](./12-build-prerequisites.md) D4 recommended Fly.io at
~₱250/mo. The owner wanted ₱0. Vercel's hobby tier is free and non-commercial, which a
free student open-data project qualifies for.

The trade recorded honestly: serverless means ~2s cold starts against PRD N9's 1s
target, and `tup-api.vercel.app` is not portable. **The host is cheap to change later;
the URL is not.** Coolify on a VPS matches the code better and was deferred, not
rejected — revisit when a VPS is being paid for anyway.

**ADR-018 has not been written.** It should be, since this deviates from a decision the
doc set recorded.

### Canonicalisation rule for program names

The Phase 2.4 ambiguity [`04-implementation-plan.md §2.4`](./04-implementation-plan.md)
predicted turned out to be one family: **Bachelor of Engineering Technology, 36
offerings across all three campuses under three different spellings** of the major
separator.

The rule, written in full at the foot of [`seeds/programs.yaml`](../seeds/programs.yaml):

> A canonical program is the **award** — the degree as CHED would name it. Everything
> after "major in", "with specialization in", or "option in" is a specialisation and
> belongs in `program_offerings.majors`.

Because `program_offerings` is `UNIQUE (program_id, campus_id)`, this merges: `manila/bet`
carries 15 majors, `taguig/bet` 12, `visayas/bet` 9. The cost is that a merged offering
keeps only the first verbatim `source_name`; the rest survive in `majors[]`.

### Two source-landscape facts changed

Both found by `scripts/verify-sources.sh` on 2026-08-29 and recorded in
[`08-source-landscape.md`](./08-source-landscape.md).

- **Taguig came back.** The cPanel suspension lifted. That is ADR-012's trigger firing
  for the first time, which is why it now has a real adapter instead of a stub. It also
  uses **departments**, so it validates the ADR-002 discriminator that Cavite was
  supposed to.
- **Cavite went down.** Timeouts from two independent networks. Seeded
  `website_status: unavailable`, meaning "we could not reach it" — not "it is down for
  everyone". No adapter exists because there are no fixtures to write one against.

---

## 5. Things that bit, and what they teach

Every one of these was a real defect, not a tooling quirk. They are recorded because the
same shape will recur.

| What happened | The lesson |
|---|---|
| A parse returning `[]` never reached the guard, so a broken selector read as a clean run | Derive "what to guard" from what the adapter *emitted*, never from what survived validation |
| Taguig published offerings before its units existed, silently losing every `unit` | Publication order follows referential dependency, never discovery order |
| An 80-character slug cap merged five distinct CIT degrees into one row | Golden fixtures catch silent loss; length caps on derived identifiers are a trap |
| `expectations` set from parsed records quarantined Taguig on its first run | Expectations count **published rows** — canonicalisation merges before the guard sees anything |
| The M1 enum test aggregated two `confidence_level` types and failed only in CI | Catalog queries must name their schema; parallel test files create sibling schemas |
| A deploy was green with no function behind it | Vercel detects zero-config functions from the **repository**, before the build runs. Generated output must go through the Build Output API. |
| A CLI deploy passed while the git deploy 404'd | Test the path that will actually run. A CLI upload of locally-built files proves nothing about the repo. |
| The API compiled without `strict` on Vercel | A tsconfig that depends on `extends` up the tree is one a build tool may lose. `apps/api/tsconfig.json` is self-contained, with a parity test. |

---

## 6. Where the truth lives

Do not re-derive these; they are already written down.

| Question | File |
|---|---|
| What does each host actually serve? | [`08-source-landscape.md`](./08-source-landscape.md) — the only place hostnames are stated |
| Why is a record `low` confidence? | [`09-freshness-and-confidence.md`](./09-freshness-and-confidence.md) |
| What rules must a new endpoint follow? | [`13-api-design-standards.md`](./13-api-design-standards.md) |
| How do I write an adapter? | [`11-adapter-guide.md`](./11-adapter-guide.md), plus the three adapter READMEs |
| Why is the schema shaped like this? | [`10-data-dictionary.md`](./10-data-dictionary.md) and [`00-errata.md`](./00-errata.md) |
| What did the Manila crawl reveal? | [`../packages/adapters/src/manila/README.md`](../packages/adapters/src/manila/README.md) — including the Q2 answer |

The three adapter READMEs are worth reading before touching any parser. They record
route inventories, quirks, and findings that are not obvious from the code.

---

## 7. Commands worth knowing

| Command | Does |
|---|---|
| `pnpm verify` | Everything CI runs |
| `pnpm ingest --adapter=X --full` | Force-parse every source, so `expectations` are checked |
| `pnpm ingest --adapter=X --dry-run` | Counts and diffs, no writes |
| `pnpm ingest:unmatched` | Offerings with no canonical program |
| `pnpm ingest:replay --url=…` | Re-parse a stored snapshot — first step of RB-01 |
| `pnpm ingest:decay` | Recompute confidence from staleness |
| `pnpm smoke <url>` | The five post-deploy checks from docs/14 §8 |
| `pnpm capture --url=…` | **The only command that touches a live site.** Manual, one page. |
| `./scripts/verify-sources.sh` | Re-verify every host fact. Commit output to `docs/verification/`. |

---

## 8. Blocked on the project owner

Nothing below can be done by an agent.

| # | Needed | Blocks |
|---|---|---|
| 1 | Load `tup-api.vercel.app/v1/campuses` **on a phone with wifi off** | The M8 checkpoint says so in as many words |
| 2 | Sentry account → DSN | Error reporting |
| 3 | Heartbeat monitor (healthchecks.io, free) | [`12-build-prerequisites.md §4`](./12-build-prerequisites.md) calls it "not optional" |
| 4 | An email address for takedown requests | `SECURITY.md`, `NOTICE`, launch |
| 5 | A domain (D2) | Before the URL is given to anybody |
| 6 | Cavite's site returning | The Cavite adapter |

---

## 9. What to do next, in order

**1. Ingest cron.** The live data has no refresh path. GitHub Actions, `FETCH_MODE=fixtures`
against Supabase, using the repo secrets. Nothing else on this list matters if the data
is stale.

**2. Post-deploy smoke tests in CI.** `scripts/smoke.mjs` exists and passes; wire it to
run after each deploy so a broken deploy is loud. The last session shipped a 404 for
every route and only found out because a human opened the URL.

**3. Sentry wiring.** Write it so it is inert without a DSN and activates when one
appears.

**4. ADR-018** — Vercel over Fly, with the cold-start and portability trade stated.

**5. The launch files** — `LICENSE`, `LICENSE-DATA`, `NOTICE`, `CONTRIBUTING.md`,
`SECURITY.md`, `llms.txt`. `LICENSE-DATA` and `llms.txt` carry the D6 no-training
commitment, which currently exists only as prose in `docs/`.

**6. M10 chunker** — PDF ingestion, heading-aware chunking, `context_header`. Its
checkpoint explicitly says *"chunker fixture tests green before any embedding spend"*, so
this costs nothing and needs no API key. Everything after it does.

**Not next:** the Cavite adapter (site down), embeddings (needs D5 and a key), the SDK
and docs site (need the domain and an npm scope).
