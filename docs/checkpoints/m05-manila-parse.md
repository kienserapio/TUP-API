# M5 — Manila parse

**Phase mapping:** [`04-implementation-plan.md`](../04-implementation-plan.md) Phase 1.2–1.3
**Navigate:** ← [m04-fetcher](./m04-fetcher.md) · [index](./README.md) · [m06-pipeline](./m06-pipeline.md) →

---

**Goal:** pure functions against saved HTML.

## Contains

- **Manual collection first** — `fixtures/manual/manila/` with `MANIFEST.json` (`url`, `collected_at`, `collected_by`, `sha256`). Pure human work, blocks the most; doc 04 says do it in week 1 in parallel with Phase 0.
- `manilaAdapter.discover()` + `parse()`, `expectations` declared
- Golden fixtures per entity type ([`../14-testing-strategy.md §3`](../14-testing-strategy.md))
- Answer open question Q2 (`/page/*` authoritative or abandoned?) in the adapter README

## Checkpoint

```bash
pnpm test:fixtures     # deep-equality golden tests, all green
```

- Parse-purity gate active: no `Date.now`/`Math.random`/network inside `packages/adapters`
- Every entity type Manila produces has ≥1 fixture — enforced by the fixture-presence test, not discipline
