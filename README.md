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
pnpm dev
```

```bash
curl -s localhost:3000/v1/campuses | jq
```

No cloud account needed. Local development never touches live TUP sites — everything
runs against seeds and committed fixtures.

Full setup, troubleshooting, and the two-connection-string rule: [`docs/15-local-development.md`](./docs/15-local-development.md).

## Commands

| Command | Does |
|---|---|
| `pnpm dev` | API with hot reload on `:3000` |
| `pnpm db:migrate` | Apply pending SQL migrations, forward-only |
| `pnpm db:seed` | Idempotent seed — 4 campuses, 14 units, 20 programs |
| `pnpm db:reset` | Drop, migrate, seed. Local only; refuses a remote host. |
| `pnpm test` | All suites |
| `pnpm test:unit` / `:integration` / `:contract` | One suite |
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
  core/         fetcher, pipeline, guard (Phase 1)
  adapters/     per-campus parsers, pure functions only (Phase 1)
seeds/          hand-curated YAML: campuses, units, canonical programs
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
| M4–M12 | see [`docs/checkpoints/`](./docs/checkpoints/README.md) |
