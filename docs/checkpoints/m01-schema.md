# M1 — Schema

**Phase mapping:** [`04-implementation-plan.md`](../04-implementation-plan.md) Phase 0.2–0.3
**Navigate:** ← [m00-skeleton](./m00-skeleton.md) · [index](./README.md) · [m02-seed](./m02-seed.md) →

---

**Goal:** migrations 000 + 001, dual Zod/Drizzle definitions.

## Contains

- Migration 000: `vector`, `pg_trgm`, `pgcrypto`, the `uuidv7()` polyfill ([`../10-data-dictionary.md §2.1`](../10-data-dictionary.md))
- Migration 001: all 17 tables from [`../10-data-dictionary.md`](../10-data-dictionary.md) — **not** TDD §2, which is superseded
- `packages/schemas`: Zod per entity, shared provenance helper, Drizzle tables derived from the same definitions

## Checkpoint

```bash
pnpm db:reset          # drop, migrate — clean on local Docker
pnpm test:integration  # runs the two non-negotiable assertions
```

1. `confidence_level` orders `'low' < 'medium' < 'high'` in a real `ORDER BY` ([E1](../00-errata.md))
2. Two `uuidv7()` calls 2 ms apart sort in creation order ([E4](../00-errata.md))

## Gate

These assertions pass **before migration 001 is applied to Supabase**. Four defects in 001 are unfixable after it ships; this checkpoint catches them while the fix is still `db:reset`.

Also here: apply migrations to the Supabase project and confirm identical behaviour — the `extensions.gen_random_bytes` schema divergence ([`../15-local-development.md §4`](../15-local-development.md)) surfaces now if mishandled.
