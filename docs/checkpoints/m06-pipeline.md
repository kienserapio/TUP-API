# M6 — Pipeline

**Phase mapping:** [`04-implementation-plan.md`](../04-implementation-plan.md) Phase 1.1 (second half), 1.4
**Navigate:** ← [m05-manila-parse](./m05-manila-parse.md) · [index](./README.md) · [m07-real-endpoints](./m07-real-endpoints.md) →

---

**Goal:** the 10 stages, wired. Reconcile, guard, registry.

## Contains

- `pipeline.ts`; `reconcile.ts` — field-level diff, `change_events`, `miss_count`
- `guard.ts` — quarantine semantics per [ADR-006](../02-ADRs.md#adr-006), **scoped to `ingest_runs.source_ids`** ([E3](../00-errata.md))
- Registry matching chain: exact → normalized → trigram ≥ 0.85 → unmatched; `pnpm ingest:unmatched` report

## Checkpoint

```bash
pnpm ingest --adapter=manila --dry-run   # counts match expectations
pnpm ingest --adapter=manila             # publishes to local DB
pnpm ingest --adapter=manila             # second run: zero change_events (hash gating)
pnpm test:integration                    # full guard table, 14-testing-strategy §4.1
```

Then **break a selector on purpose** and run again: quarantine fires, existing rows untouched. Include the guard-scoping case — a run touching sources A and B never quarantines source C.

## Gate

Do not proceed to M7 until sabotage-then-quarantine is demonstrated. This is the failure mode that destroys data in production; prove it in a sandbox first.
