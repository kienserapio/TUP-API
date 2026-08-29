# M9 — More campuses

**Phase mapping:** [`04-implementation-plan.md`](../04-implementation-plan.md) Phase 2
**Navigate:** ← [m08-deploy](./m08-deploy.md) · [index](./README.md) · [m10-rag](./m10-rag.md) →

---

**Goal:** prove the schema. Phase 2 of [`../04-implementation-plan.md`](../04-implementation-plan.md), unchanged.

## Contains

- Cavite adapter — `unit_type = 'department'`, **the ADR-002 validator**
- Visayas adapter; Taguig stub + weekly liveness probe
- Cross-campus registry work in `seeds/programs.yaml` — expect genuine ambiguity, resolve deliberately, document in seed comments
- `GET /v1/meta/coverage`, per-campus never aggregate

## Checkpoint

Doc 04's Phase 2 exit criteria, verbatim. The one that gates everything:

> Zero schema migrations were required to add campuses 2 and 3.

`GET /v1/programs/bsce` returns three offerings with three correctly differing `unit.type` values. If a migration was needed, **stop and fix the schema now** — every later estimate assumes it holds.
