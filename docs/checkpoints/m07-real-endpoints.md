# M7 — Endpoints over real data

**Phase mapping:** [`04-implementation-plan.md`](../04-implementation-plan.md) Phase 1.6
**Navigate:** ← [m06-pipeline](./m06-pipeline.md) · [index](./README.md) · [m08-deploy](./m08-deploy.md) →

---

**Goal:** the join — API track meets ingestion track.

## Contains

- `/v1/units`, `/v1/programs`, `/v1/programs/{slug}`, `/v1/offerings/{campus}/{program}`
- Filtering, `min_confidence`, cursor pagination, ETag + `Cache-Control`

## Checkpoint

```bash
curl -s "localhost:3000/v1/programs?campus=manila" | jq   # real crawled programs, provenance on each
```

- Paginate everything with `limit=5`: union complete, no duplicates, no skips
- `min_confidence=medium` excludes `low` rows — the E1 assertion, now observable end-to-end
- `If-None-Match` returns `304`
- **Manual spot-check: 10 random programs against the live source page** — the only real correctness check at this stage ([`../04-implementation-plan.md`](../04-implementation-plan.md) Phase 1 exit)
