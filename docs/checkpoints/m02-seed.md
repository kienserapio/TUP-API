# M2 — Seed

**Phase mapping:** [`04-implementation-plan.md`](../04-implementation-plan.md) Phase 0.4
**Navigate:** ← [m01-schema](./m01-schema.md) · [index](./README.md) · [m03-read-api](./m03-read-api.md) →

---

**Goal:** the hand-typed truth. Do not scrape what you can type.

## Contains

- 4 campuses; Taguig with `website_status: 'unavailable'` ([ADR-012](../02-ADRs.md#adr-012))
- Manila's 6 + Visayas's 3 colleges, Cavite's 5 departments — correct `unit_type` each
- ~20 canonical programs in `seeds/programs.yaml`

## Checkpoint

```bash
pnpm db:seed && pnpm db:seed   # twice — second run changes nothing (idempotence)
```

Then in Drizzle Studio: 4 campuses, 14 units, Cavite rows say `department`.
