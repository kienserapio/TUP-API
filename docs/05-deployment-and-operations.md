# 05 — Deployment and Operations

---

> [!IMPORTANT]
> **Amended 2026-08-20.** **§2.2's cost projection is wrong** — Fly.io removed its free tier in October 2024; launch is ≈₱600–900/mo, not ₱60. **§4's Taguig liveness probe fires permanently** because the suspended-account page returns HTTP 200. **§5.3's staleness alarm is scheduled by the same GitHub Actions cron whose silent death it exists to detect** and needs an external heartbeat. See [`00-errata.md`](./00-errata.md) E13, E14, E17, E18, E19 and [ADR-017](./02-ADRs.md#adr-017).

## 1. Environments

| Env | Purpose | Database | Ingestion |
|---|---|---|---|
| `local` | Development | Local Postgres (Docker) or Supabase branch | Fixtures only — **never live sites** |
| `staging` | Pre-release | Supabase branch DB | Fixtures + one live adapter, manual trigger |
| `production` | Public | Supabase primary | Scheduled, all adapters |

**Rule: local and CI never hit live TUP sites.** Development runs entirely on committed fixtures. This keeps the project polite and makes tests deterministic.

---

## 2. Where to deploy

### 2.1 Recommended: Fly.io

| Component | Platform | Config |
|---|---|---|
| `apps/api` | Fly.io, region `sin` (Singapore) | 2× shared-cpu-1x, 512MB, autoscale 1–3 |
| `apps/mcp` | Fly.io, same region | 1× shared-cpu-1x, 256MB |
| `apps/ingest` | GitHub Actions cron | `ubuntu-latest`, ~10 min/run |
| Database | Supabase, `ap-southeast-1` | Free → Pro (₱1,400/mo) when needed |
| Object storage | Supabase Storage | Snapshots |
| Cache | Upstash Redis, Singapore | Free tier initially |
| CDN | Cloudflare | Free tier, proxied |

**Why Fly over Vercel/serverless:** persistent connections to Postgres (no pooler exhaustion), no cold starts on the read path, and `sin` is the closest low-latency region to PH. Vercel's edge functions would add a pooling layer and cold-start variance for no benefit on a read-mostly API.

**Why GitHub Actions for ingestion:** free, versioned alongside the code, auditable logs, and trivially re-runnable. Move to Trigger.dev only if runs exceed the free tier.

### 2.2 Cost projection

| Item | Launch | At scale |
|---|---|---|
| Fly.io API | $0 (free allowance) | ~$10/mo |
| Supabase | $0 | $25/mo |
| Upstash | $0 | ~$5/mo |
| Cloudflare | $0 | $0 |
| Embeddings | ~$0.50 one-time | ~$0.10/mo incremental |
| Sentry | $0 | $0 |
| Domain | ~₱700/yr | — |
| **Total** | **≈₱60/mo** | **≈₱2,400/mo** |

Comfortably inside the N8 budget (<₱1,500/mo) at launch.

### 2.3 DNS

```
api.<domain>        → Fly.io (proxied through Cloudflare)
docs.<domain>       → docs site
status.<domain>     → Better Stack status page
```

Cloudflare page rule: cache `/v1/*` respecting origin `Cache-Control`; bypass cache on `/v1/health`.

---

## 3. CI/CD

### 3.1 Pipeline

```yaml
on: [pull_request, push to main]

jobs:
  verify:
    - pnpm install --frozen-lockfile
    - pnpm typecheck
    - pnpm lint
    - pnpm test                      # includes fixture golden tests
    - pnpm build
    - pnpm openapi:generate
    - git diff --exit-code openapi.json   # spec drift gate
    - pnpm test:contract             # responses validate against spec

  deploy:
    needs: verify
    if: github.ref == 'refs/heads/main'
    - drizzle migrate                # forward-only
    - flyctl deploy apps/api
    - flyctl deploy apps/mcp
    - smoke test /v1/health + /v1/campuses
```

### 3.2 Gates that matter

**Spec drift gate.** If generated `openapi.json` differs from the committed one, CI fails. Forces the contract change to be intentional and reviewable. For a public API this is the single most valuable gate.

**Breaking change gate.** A CI step diffs `openapi.json` against the previous release. Removed endpoints, removed fields, or narrowed types fail unless the PR carries a `breaking-change` label and bumps the version.

**Personal data gate.** Grep-based CI check rejecting any adapter that sends `Cookie` or `Authorization` headers, or that references AIMS/ERS hostnames. Enforces PRD constraint C1 structurally.

### 3.3 Migrations

Forward-only, never destructive in one step. To remove a column: (1) stop writing it, deploy; (2) stop reading it, deploy; (3) drop it in a later migration. Deploys must be safe to run while the old version is still serving.

---

## 4. Scheduling

| Job | Cron (UTC) | PHT | Notes |
|---|---|---|---|
| Ingest — announcements | `0 */6 * * *` | every 6h | Fast, high-churn |
| Ingest — full | `0 18 * * *` | 02:00 daily | Off-peak (C3) |
| Confidence decay | `0 19 * * *` | 03:00 daily | Downgrades stale entities |
| Taguig liveness probe | `0 19 * * 1` | Mon 03:00 | Opens issue on 200 |
| Manual-source reminder | `0 19 1 * *` | monthly | Issue if any manual source >120d |
| Backup verification | `0 20 * * 0` | Sun 04:00 | Restore into scratch DB |

Off-peak scheduling is a compliance requirement (PRD C3), not an optimization.

---

## 5. Observability

### 5.1 Logging

`pino` structured JSON. Every ingestion run gets a `run_id` propagated through all stages. Log at stage boundaries with counts, never per-record.

### 5.2 Metrics

```
ingest_run_duration_seconds{adapter}
ingest_records_published{adapter,entity_type}
ingest_sources_304_total{adapter}          # should be HIGH — low means conditional GET is broken
ingest_quarantine_total{adapter,reason}
source_staleness_days{source_id}
api_request_duration_seconds{route,status}
api_cache_hit_ratio
rag_query_duration_seconds
```

### 5.3 Alerts — exactly three

More than three and you start ignoring them.

| # | Condition | Channel | Why |
|---|---|---|---|
| 1 | Any quarantine event | GitHub issue + Sentry | A parser broke; data is frozen until fixed |
| 2 | `/v1/health` down >5 min | Better Stack → email | Consumers are seeing errors |
| 3 | Any source stale >2× its recrawl interval | Daily digest issue | Ingestion silently stopped |

**Deliberately not alerted:** latency spikes (Cloudflare absorbs), individual 4xx (consumer error), single failed fetch (retries handle it).

---

## 6. Runbooks

### RB-01 — Parser broke after a site redesign

*Symptom:* quarantine issue opened; `ingest_quarantine_total` incremented.

1. Read the quarantine row: `SELECT adapter, entity_type, reason, payload FROM quarantine WHERE resolved_at IS NULL;`
2. Pull the triggering snapshot from storage via `snapshot_id`.
3. Diff against the last-known-good snapshot for the same source.
4. Update selectors in the adapter.
5. **Add the new snapshot to `fixtures/` with expected JSON.** Mandatory — this is how the suite accumulates redesign coverage.
6. Run `pnpm ingest --adapter=X --dry-run` and compare counts.
7. Merge; mark quarantine resolved.

*Data is safe throughout.* The guard preserved it. There is no time pressure.

### RB-02 — Campus site down or TLS changed

1. Confirm externally (`curl -I`, or an uptime checker).
2. If transient: no action; retries and 304 logic handle it. Data goes stale with an honest timestamp.
3. If sustained >7d: set `sources.status = 'unavailable'`, downgrade affected entities to `confidence = 'low'`.
4. If permanent: follow the Taguig pattern (ADR-012).

### RB-03 — robots.txt newly disallows an allowed path

1. Fetcher throws `RobotsDisallowedError` and auto-sets `crawl_enabled = false`. **Do not override.**
2. Decide: drop the source, or convert to `method = 'manual'`.
3. If manual: collect by hand, add to `fixtures/manual/`, update the source row.
4. Existing data stays; `last_verified_at` freezes and confidence decays naturally.

### RB-04 — Bad data published

1. Identify the change: `SELECT * FROM change_events WHERE occurred_at > $1 ORDER BY id;`
2. Find the prior-good snapshot for that source.
3. Re-run parse against the good snapshot: `pnpm ingest:replay --snapshot=<id>`.
4. Verify, then publish.
5. Add a fixture reproducing the bad case.

This is why snapshots are immutable and never deleted.

### RB-05 — Rate-limit abuse

1. Identify via Redis counters or Cloudflare analytics.
2. Anonymous IP: Cloudflare rate-limit rule.
3. API key: revoke, email the registered contact.
4. If sustained and distributed: tighten anonymous limits temporarily.

### RB-06 — Takedown request

1. Acknowledge within 24h.
2. Add the URL pattern to `excluded_sources` with reason and requester.
3. Delete affected canonical rows and chunks; **retain snapshots unless deletion is explicitly requested.**
4. Redeploy; verify the content is gone from all endpoints.
5. Confirm to requester within 48h.

The `excluded_sources` check runs before every fetch and every publish, so removals survive re-crawls automatically.

### RB-07 — Database restore

1. Supabase PITR to the target timestamp (Pro plan) or restore the latest daily dump.
2. Re-run `pnpm seed` (idempotent).
3. Replay ingestion from snapshots: `pnpm ingest:replay --since=<date>`.
4. Verify `/v1/meta/coverage` counts match pre-incident.

Tested weekly by the backup verification job. An untested backup is not a backup.

---

## 7. Security

| Control | Implementation |
|---|---|
| Secrets | Fly secrets / GitHub encrypted secrets. Never committed. |
| DB access | Service role key server-side only. Never in a client. |
| SQL injection | Drizzle parameterized queries throughout. No string concatenation. |
| Input validation | Zod on every request; reject unknown params. |
| Rate limiting | Redis sliding window (TDD §5.7). |
| CORS | `*` for `GET /v1/*` — it is public data. Restricted on any future write path. |
| Headers | `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, HSTS. |
| Dependency scanning | Dependabot + `pnpm audit` in CI. |
| SSRF in ingestion | Domain allowlist — the fetcher only accepts the four known TUP domains. |
| No auth surface | No login, no sessions, no user table. The best way to not leak credentials is to not have any. |

---

## 8. Backups

| What | Method | Retention | Verified |
|---|---|---|---|
| Postgres | Supabase daily automated + PITR (Pro) | 7d free / 30d Pro | Weekly restore test |
| Snapshots | Supabase Storage, versioned | Indefinite | Checksum audit monthly |
| Fixtures + seeds | Git | Forever | Inherent |
| Secrets | Password manager, offline copy | — | On rotation |

The genuinely irreplaceable asset is **snapshots plus fixtures**. Canonical data can always be rebuilt from snapshots by replaying parsers. Snapshots cannot be recovered if lost, because the source pages will have changed.
