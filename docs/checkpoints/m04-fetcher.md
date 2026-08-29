# M4 — Fetcher

**Phase mapping:** [`04-implementation-plan.md`](../04-implementation-plan.md) Phase 1.1 (first half)
**Navigate:** ← [m02-seed](./m02-seed.md) · [index](./README.md) · [m05-manila-parse](./m05-manila-parse.md) →

---

**Goal:** the politeness layer, alone. Structurally unbypassable ([ADR-005](../02-ADRs.md#adr-005)).

## Contains

- `core/fetcher.ts`: robots cache, **domain allowlist (four TUP hosts only)**, per-domain queue, exponential backoff
- Content-hash gating ([E2](../00-errata.md) — **not** conditional GET; no campus supports it)
- Snapshot writer → Supabase Storage
- `excluded_sources` check before every fetch

## Checkpoint (fixtures only — no live traffic)

- Robots evaluation tests, including the Visayas `Content-Signal` case ([`../08-source-landscape.md §5.1`](../08-source-landscape.md))
- A non-TUP URL throws; an `excluded_sources` URL is never fetched
- Same body twice → one snapshot, no second write
- CI grep gate live: adapters sending `Cookie`/`Authorization` fail the build

One **manual, deliberate** live smoke: `pnpm capture` against a single Manila page, off-peak, snapshot lands in Storage. Once. The only live call in the whole build until production.
