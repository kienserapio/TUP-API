# M0 — Skeleton

**Phase mapping:** [`04-implementation-plan.md`](../04-implementation-plan.md) Phase 0.1
**Navigate:** [index](./README.md) · [m01-schema](./m01-schema.md) →

---

**Goal:** repo, workspace, tooling, CI shell. No logic.

## Contains

- pnpm workspace + Turborepo: `apps/{api,mcp,ingest}`, `packages/{db,schemas,core,adapters}`
- TypeScript `strict: true`, `noUncheckedIndexedAccess: true`
- ESLint + Prettier, pre-commit via `lefthook`
- `.env.example` with every variable documented ([`../15-local-development.md §3`](../15-local-development.md))
- `.gitignore` **containing `.env` before `git init` runs** — the service role key must never enter history
- CI: typecheck + lint + (empty) test job

## Checkpoint

```bash
pnpm typecheck && pnpm lint && pnpm test   # green on a fresh clone
```

And CI green on the first push. Boring on purpose — proves the toolchain before any logic exists.
