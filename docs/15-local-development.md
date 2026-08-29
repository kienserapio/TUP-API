# 15 — Local Development

**Prerequisites:** [`12-build-prerequisites.md`](./12-build-prerequisites.md)
**Audience:** you, and the second maintainer on their first day
**Added:** 2026-08-29

---

> [!IMPORTANT]
> **Local development never touches live TUP sites.** Everything runs against committed fixtures ([`05-deployment-and-operations.md §1`](./05-deployment-and-operations.md)). This keeps the project polite, keeps tests deterministic, and means you can work on a plane.

> [!NOTE]
> You do **not** need a Supabase project to start. A local Postgres container runs the entire stack — schema, migrations, seeds, API, ingestion against fixtures, tests. The Supabase URL matters only at deploy time, and by then it is one environment variable.

---

## 1. Prerequisites

| Tool | Version | Check |
|---|---|---|
| Node.js | 22 LTS | `node --version` |
| pnpm | 9.x | `pnpm --version` |
| Docker | any recent | `docker --version` |
| Git | any recent | `git --version` |

Use a version manager for Node (`fnm`, `nvm`, `volta`) and commit a `.nvmrc`. A second maintainer on the wrong major version will hit errors that look like code bugs.

---

## 2. Zero to running

```bash
git clone git@github.com:<org>/tup-open-api.git
cd tup-open-api
pnpm install

# Postgres 17 + pgvector, matching production's major version
docker run -d --name tup-db \
  -e POSTGRES_PASSWORD=dev \
  -e POSTGRES_DB=tup \
  -p 5432:5432 \
  pgvector/pgvector:pg17

cp .env.example .env          # defaults already point at the container
pnpm db:migrate               # migrations 000 and 001
pnpm db:seed                  # 4 campuses, units, canonical program registry
pnpm dev                      # API on :3000
```

Verify:

```bash
curl -s http://localhost:3000/v1/campuses | jq
```

Four campuses. That is a working API.

**Match the container's major version to Supabase's.** Supabase runs **Postgres 17** — 16 was never offered, and the stack table in [`03-TDD.md`](./03-TDD.md) was wrong about this. Version drift between local and production surfaces as behaviour differences in enum ordering, index planning, and extension availability.

---

## 3. Environment variables

`.env.example` is committed. `.env` is gitignored and never leaves your machine.

```bash
# ── Local development ────────────────────────────────────────────
DATABASE_URL=postgresql://postgres:dev@localhost:5432/tup
DATABASE_URL_POOLED=postgresql://postgres:dev@localhost:5432/tup
NODE_ENV=development
LOG_LEVEL=debug
FETCH_MODE=fixtures            # 'fixtures' | 'live'. Never 'live' locally.

# ── Production only — set as Fly / GitHub secrets, never here ────
# DATABASE_URL=postgresql://...@...pooler.supabase.com:5432/postgres
# DATABASE_URL_POOLED=postgresql://...@...pooler.supabase.com:6543/postgres
# SUPABASE_URL=
# SUPABASE_SERVICE_ROLE_KEY=
# UPSTASH_REDIS_REST_URL=
# SENTRY_DSN=
# EMBEDDING_API_KEY=
```

### 3.1 Why two database URLs

Locally they are identical — there is no pooler. In production they differ and **must not be swapped**:

| Variable | Used by | Port | Note |
|---|---|---|---|
| `DATABASE_URL` | `apps/api` on Fly | 5432 | Long-lived process. Session pooler or direct. Prepared statements fine. |
| `DATABASE_URL_POOLED` | `apps/ingest` on GitHub Actions | 6543 | Ephemeral runners. Transaction pooler. **Requires `prepare: false`** in the `postgres.js` client. |

Supavisor in transaction mode does not support prepared statements, and Drizzle over `postgres.js` prepares by default — [`00-errata.md`](./00-errata.md) E19. Wrong pairing fails in both directions: the API breaks intermittently on the transaction port, and ingestion exhausts the connection budget on the direct port.

Set both correctly on day one. Twenty minutes now, a confusing intermittent failure later.

### 3.2 Secrets discipline

Real credentials go in the shared vault ([A9](./12-build-prerequisites.md)), never in `.env.example`, never in a commit, never pasted into a chat or an issue. The Supabase **service role key** bypasses every row-level protection — it is server-side only and belongs in Fly secrets and GitHub encrypted secrets, nowhere else.

If a secret is ever exposed, rotate it rather than assessing whether it was probably fine.

---

## 4. The one Supabase-specific migration trap

`pgcrypto` provides `gen_random_bytes`, which the `uuidv7()` polyfill needs ([E4](./00-errata.md), [`10-data-dictionary.md §2.1`](./10-data-dictionary.md)).

**Supabase installs `pgcrypto` into the `extensions` schema, not `public`.** A local container installs it into `public`. A migration that works locally will therefore fail on Supabase.

Write it to work in both:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- NOT uuid-ossp
-- schema-qualify the call inside the polyfill:
--   extensions.gen_random_bytes(10)
-- or ensure 'extensions' is on the search_path for the migrating role
```

Then assert the property that actually matters:

```sql
DO $$
DECLARE a uuid; b uuid;
BEGIN
  a := uuidv7();
  PERFORM pg_sleep(0.002);
  b := uuidv7();
  ASSERT a < b, format('uuidv7 not time-ordered: %s >= %s', a, b);
END $$;
```

Time-ordering is the entire reason for v7 over v4. Test it, or the polyfill can be silently wrong.

Delete the polyfill and use the built-in when Supabase ships Postgres 18.

---

## 5. Commands

| Command | Does |
|---|---|
| `pnpm dev` | API with hot reload on `:3000` |
| `pnpm dev:mcp` | MCP server locally |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm db:generate` | Generate a migration from Drizzle schema changes |
| `pnpm db:seed` | Idempotent seed — safe to re-run |
| `pnpm db:reset` | Drop, migrate, seed. Local only. |
| `pnpm db:studio` | Drizzle Studio, browse the DB |
| `pnpm ingest --adapter=manila --dry-run` | Full pipeline against fixtures, no writes |
| `pnpm ingest:replay --snapshot=<id>` | Re-parse a stored snapshot |
| `pnpm ingest:unmatched` | Program names with no canonical registry entry |
| `pnpm test` | Everything ([`14-testing-strategy.md`](./14-testing-strategy.md)) |
| `pnpm openapi:generate` | Regenerate `openapi.json` |
| `pnpm typecheck` | `tsc --noEmit` across the workspace |
| `pnpm lint` | ESLint + Prettier |

---

## 6. Working on an adapter

The loop, in order:

1. **Capture a snapshot.** One-off, deliberate, rate-limited, off-peak:
   ```bash
   pnpm capture --url=https://tup.edu.ph/... --out=fixtures/manila/
   ```
   This is the **only** command that touches a live site, and it is manual. Never wire it into a test or a watch loop.

2. **Write the expected output by hand.** Yes, by hand. Writing `.expected.json` from what the page actually says is how you discover that the page says something you did not model.

3. **Write `parse`** until the golden test passes.

4. **Run the pipeline dry:**
   ```bash
   pnpm ingest --adapter=manila --dry-run
   ```
   Compare counts against the adapter's declared `expectations`.

5. **Run for real, locally**, then inspect `change_events` to see exactly what would have been published.

Full checklist in [`11-adapter-guide.md`](./11-adapter-guide.md).

### 6.1 Fixture etiquette

- Filenames carry the capture date: `programs-coe-2026-08-20.html`
- Never edit a fixture to make a test pass
- Never strip or prettify captured HTML — the junk is the point
- Every quarantine incident becomes a fixture ([RB-01](./05-deployment-and-operations.md))

---

## 7. Repo layout

```
apps/
  api/          Hono + zod-openapi. Deploys to Fly.
  mcp/          MCP server. Same Fly app at launch (D4).
  ingest/       Pipeline entrypoint. Runs on GitHub Actions cron.
packages/
  db/           Drizzle schema, migrations, seeds
  schemas/      Zod — the single source of truth
  core/         fetcher, pipeline stages, guard, reconcile
  adapters/     per-campus parsers. Pure functions only.
fixtures/       committed snapshots + expected output
docs/           this documentation set
scripts/        verify-sources.sh and friends
```

`packages/schemas` is the keystone. Everything imports from it. That is what makes "the OpenAPI document cannot drift" true rather than aspirational.

**Dependency direction is one-way:** `adapters` → `core` → `schemas` → `db`. An adapter importing from `apps/` is a design error, and `packages/adapters` must never import a network client at all ([ADR-005](./02-ADRs.md#adr-005)).

---

## 8. Repo files to create in Phase 0.1

Not in `docs/`, but required before launch. Contents are specified in [`07-governance-and-distribution.md`](./07-governance-and-distribution.md):

```
README.md          what this is, quickstart, link to docs/
LICENSE            code licence
LICENSE-DATA       data licence + the no-training commitment (D6)
NOTICE             attribution, unofficial-project disclaimer
CONTRIBUTING.md    points at 11-adapter-guide.md
SECURITY.md        how to report, takedown contact (A10)
CODE_OF_CONDUCT.md
llms.txt           machine-readable statement of terms for AI consumers
.env.example       every variable, no real values
.nvmrc             Node major
```

`LICENSE-DATA` and `llms.txt` are not boilerplate here. They carry the express commitment not to train on ingested content, which is the project's stated position on the Visayas AI directives ([D6](./12-build-prerequisites.md), [`08-source-landscape.md §5.1`](./08-source-landscape.md)).

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `connection refused` on 5432 | Container not running | `docker start tup-db` |
| `type "vector" does not exist` | Extensions not created | Migration 000 did not run, or the image is plain `postgres` not `pgvector/pgvector` |
| `function gen_random_bytes does not exist` | `pgcrypto` missing or wrong schema | §4 |
| `function uuidv7() does not exist` | Migration 000 skipped | `pnpm db:migrate` |
| `min_confidence` returns the wrong rows | Enum declared descending | Stop. Fix the enum order before any more data lands — [E1](./00-errata.md), and it is not alterable later |
| Intermittent `prepared statement already exists` | Transaction pooler with `prepare: true` | §3.1 |
| Ingest dry-run finds 0 records | Fixture path wrong, or selectors stale | Check the fixture loads before blaming the parser |
| Every incremental run quarantines | Guard scoped adapter-wide instead of to `ingest_runs.source_ids` | [E3](./00-errata.md) |
| `openapi.json` diff in CI you did not intend | A schema change altered the contract | Review the diff. It is telling you something true. |
| Test hits the network | `FETCH_MODE` not `fixtures` | Never set `live` locally |

---

## 10. Before you open a PR

```
[ ] pnpm typecheck
[ ] pnpm lint
[ ] pnpm test
[ ] pnpm openapi:generate — diff reviewed, committed if intended
[ ] New endpoint? §14 checklist in 13-api-design-standards.md
[ ] New adapter behaviour? fixture added, expected output committed
[ ] No secrets, no .env, no live-site calls in test code
[ ] Migration is forward-only and safe to run while the old version still serves
```

Migrations are never destructive in one step. To remove a column: stop writing it and deploy; stop reading it and deploy; drop it in a later migration ([`05-deployment-and-operations.md §3.3`](./05-deployment-and-operations.md)).
