# M8 — First deploy

**Phase mapping:** [`04-implementation-plan.md`](../04-implementation-plan.md) Phase 0.6 (deliberately moved after M7)
**Navigate:** ← [m07-real-endpoints](./m07-real-endpoints.md) · [index](./README.md) · [m09-multi-campus](./m09-multi-campus.md) →

---

**Goal:** live, with real Manila data behind it.

Deploying after M7 means smoke tests exercise the true read path, and Supabase pooler behaviour ([E19](../00-errata.md)) is validated under the exact process model production will run. The only reordering vs doc 04 — if you prefer the original order (deploy the skeleton at the end of Phase 0), nothing else breaks; this checkpoint simply runs against seed data instead.

## Contains

- Fly.io app, region `sin`, single-app shape ([D4](../12-build-prerequisites.md))
- GitHub Actions ingest cron against production
- Sentry wired; post-deploy smoke tests in CI

## Checkpoint

- The five smoke checks from [`../14-testing-strategy.md §8`](../14-testing-strategy.md) pass against the public URL, **from a phone, not your wifi**
- One scheduled ingest run completes; `/v1/health` reports `hours_since_ingest < 36`
- API on session pooler; ingest on transaction pooler with `prepare: false` — confirmed by reading deployed config, not by assumption

**Milestone: the API is live.** Everything after this is additive.
