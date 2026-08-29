# TUP Open Data API

An open, versioned, multi-campus API that normalises public institutional data across
the Technological University of the Philippines system, and serves both conventional
clients and AI agents.

**Every record carries provenance in the default payload.** That is the product: it is
what lets a student platform or an agent say *"this scholarship page hasn't been verified
since 2006, confirm with OSA"* instead of confidently reciting stale policy.

Unofficial. Aggregated from public TUP websites.

---

## Quick start

```bash
pnpm install

docker run -d --name tup-db \
  -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=tup \
  -p 55433:5432 pgvector/pgvector:pg17

cp .env.example .env.local     # already points at the container
pnpm db:migrate
pnpm db:seed
pnpm ingest --adapter=manila --full    # reads committed fixtures, not the network
pnpm ingest --adapter=visayas --full
pnpm ingest --adapter=taguig --full
pnpm dev
```

```bash
curl -s localhost:3000/v1/campuses | jq
curl -s "localhost:3000/v1/programs/bsce" | jq        # one degree, every campus
curl -s "localhost:3000/v1/offerings?campus=manila" | jq
```

No cloud account needed. Local development never touches live TUP sites — everything
runs against seeds and committed fixtures.

Full setup, troubleshooting, and the two-connection-string rule: [`docs/15-local-development.md`](./docs/15-local-development.md).

## Commands

| Command | Does |
|---|---|
| `pnpm dev` | API with hot reload on `:3000` |
| `pnpm db:migrate` | Apply pending SQL migrations, forward-only |
| `pnpm db:seed` | Idempotent seed — 4 campuses, 14 units, 36 canonical programs |
| `pnpm db:reset` | Drop, migrate, seed. Local only; refuses a remote host. |
| `pnpm ingest --adapter=manila` | Full pipeline against committed fixtures |
| `pnpm ingest --adapter=manila --full` | Force-parse every source, so `expectations` are checked |
| `pnpm ingest --adapter=manila --dry-run` | Counts and diffs, no writes |
| `pnpm ingest:unmatched` | Offerings with no canonical program, for a human to resolve |
| `pnpm ingest:decay` | Recompute confidence from staleness (docs/09 §3) |
| `pnpm ingest:replay --url=…` | Re-parse a stored snapshot — first step of RB-01 |
| `pnpm capture --url=…` | **The only command that touches a live site.** Manual, one page. |
| `pnpm test` | All suites |
| `pnpm test:unit` / `:fixtures` / `:integration` / `:contract` | One suite |
| `pnpm openapi:generate` | Regenerate `apps/api/openapi.json` |
| `pnpm verify` | Gates + typecheck + lint + tests — what CI runs |

## Layout

```
apps/
  api/          Hono + zod-openapi. The REST surface.
  mcp/          MCP server (Phase 4)
  ingest/       Pipeline entrypoint, GitHub Actions cron (Phase 1)
packages/
  db/           SQL migrations, Drizzle schema, seeds
  schemas/      Zod — the single source of truth for every shape
  core/         fetcher, robots, pipeline, guard, reconcile, registry, confidence
  adapters/     per-campus parsers, pure functions only
seeds/          hand-curated YAML: campuses, units, canonical programs
fixtures/       committed page captures + the exact ParseResult each must produce
docs/           the full documentation set — start at docs/README.md
```

`packages/schemas` is the keystone. One Zod definition drives request validation,
response typing, the generated OpenAPI document, and the published SDK. That is what
makes "the spec cannot drift from the code" true rather than aspirational.

## Where things are decided

| Question | Document |
|---|---|
| What are we building and why | [`docs/01-PRD.md`](./docs/01-PRD.md) |
| Why these technical choices | [`docs/02-ADRs.md`](./docs/02-ADRs.md) |
| The corrected schema | [`docs/10-data-dictionary.md`](./docs/10-data-dictionary.md) |
| Rules every endpoint follows | [`docs/13-api-design-standards.md`](./docs/13-api-design-standards.md) |
| What to test, what to skip | [`docs/14-testing-strategy.md`](./docs/14-testing-strategy.md) |
| Build order, module by module | [`docs/checkpoints/`](./docs/checkpoints/README.md) |

**Known-defect index:** [`docs/00-errata.md`](./docs/00-errata.md). Read it before
changing the schema — four defects it corrects are unfixable after migration 001 ships.

## Status

| Module | State |
|---|---|
| M0 skeleton | done |
| M1 schema | done — 21 tables, enum ordering and uuidv7 assertions passing |
| M2 seed | done — idempotent |
| M3 read API | done — `/v1/health`, `/v1/campuses`, `/v1/campuses/{slug}` |
| M4 fetcher | done — allowlist, robots + Content-Signal, content-hash gating, snapshots |
| M5 Manila parse | done — 8 fixtures, 6 colleges and 89 offerings, exact golden tests |
| M6 pipeline | done — reconcile, guard, registry; sabotage-then-quarantine demonstrated |
| M7 endpoints | done — `/v1/units`, `/v1/programs`, `/v1/programs/{slug}`, `/v1/offerings` |
| M9 multi-campus | **gate passed** — three campuses, zero migrations. Cavite blocked, see below. |
| M8 deploy, M10–M12 | see [`docs/checkpoints/`](./docs/checkpoints/README.md) |

### What the crawl currently holds

Three campuses, end to end through the real pipeline, in the same tables:

| Campus | Units | Offerings | Vocabulary |
|---|---|---|---|
| Manila | 6 | 38 | colleges |
| Visayas | 3 | 8 | colleges |
| Taguig | 4 | 8 | **departments** |
| Cavite | 5 (seeded) | 0 | departments — host unreachable, no adapter |

**Zero schema migrations were required to add campuses 2 and 3** — the Phase 2 exit
criterion, and the test of whether ADR-002 and ADR-003 were right. Eight migrations
exist; none is named after a campus.

`GET /v1/programs/bsee` is the payload the project exists for: one degree, three
campuses, and `unit.type` reading `college`, `college`, `department`. An integration
that hardcoded "college" is wrong about half the system.

**Every offering resolves to a canonical program** — `pnpm ingest:unmatched` is empty.
Getting there meant resolving the cross-campus ambiguity
[`docs/04 §2.4`](./docs/04-implementation-plan.md) predicted: Bachelor of Engineering
Technology appears 36 times across all three campuses under three different spellings of
the major separator. The rule that resolved it, and what the resolution costs, is written
out at the foot of [`seeds/programs.yaml`](./seeds/programs.yaml).

**Cavite is blocked, and it is the one thing M9 could not finish.** Three verification
runs an hour apart timed out against both `tupcavite.edu.ph` and `www.tupcavite.edu.ph`,
so there are no fixtures to write a parser against — and writing one against guessed
markup is how you ship a parser that has never seen its own page. The campus is seeded
with `website_status: unavailable`, which means "we could not reach it", not "it is down
for everyone". **Re-run `scripts/verify-sources.sh` from a different network before
starting that adapter**; if it is genuinely down, the manual-collection path
(`method: 'manual'`) exists and is tested. See
[`docs/08 §4.1`](./docs/08-source-landscape.md).

Cavite was meant to be the case that validates ADR-002's `unit_type` discriminator.
Taguig turned out to use departments too, so the discriminator got validated anyway —
but by accident, and the Cavite adapter is still owed.

**Taguig's suspension lifted on 2026-08-29**, which is ADR-012's trigger firing for the
first time and why it has a real adapter rather than a stub. PRD R3 rated "Taguig stays
offline indefinitely" as High likelihood; it did not happen.

Two findings from the first crawl are worth knowing before reading the adapter:
`/pages/admission/undergraduate-programs` turned out to be a Google Drive PDF embed with
no HTML, and the real program data lives at `/courses/academics/{college}` — a route
family the doc set did not record. Both are written up in
[`packages/adapters/src/manila/README.md`](./packages/adapters/src/manila/README.md),
along with the answer to open question Q2.
