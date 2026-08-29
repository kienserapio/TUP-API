# M3 — Read API over seeds

**Phase mapping:** [`04-implementation-plan.md`](../04-implementation-plan.md) Phase 0.5
**Navigate:** ← [m02-seed](./m02-seed.md) · [index](./README.md) · [m07-real-endpoints](./m07-real-endpoints.md) →

---

**Goal:** the API works before ingestion exists. **First demo-able artifact.**

## Contains

- Hono + zod-openapi app; `/v1/health`, `/v1/campuses`, `/v1/campuses/{slug}`
- RFC 9457 error handler, request-id middleware
- `openapi.json` generation + spec-drift CI gate
- Contract test harness ([`../14-testing-strategy.md §5`](../14-testing-strategy.md))

## Checkpoint

```bash
pnpm dev
curl -s localhost:3000/v1/campuses | jq          # 4 campuses, provenance present
curl -s localhost:3000/v1/campuses/tup | jq      # 404 + did_you_mean
curl -s "localhost:3000/v1/campuses?bogus=1"     # 400, unknown param rejected
pnpm test:contract                               # responses validate against generated spec
```

A real API, honest data, correct errors — no scraping involved. Everything from here adds data and endpoints to a proven shell.

**Parallel track:** [`m04-fetcher`](./m04-fetcher.md) can start before this finishes — different packages, no shared files.
