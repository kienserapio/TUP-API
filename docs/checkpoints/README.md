# Build Checkpoints

**Prerequisites:** [`../04-implementation-plan.md`](../04-implementation-plan.md), [`../14-testing-strategy.md`](../14-testing-strategy.md), [`../15-local-development.md`](../15-local-development.md)
**Added:** 2026-08-29

One file per module. The phases and estimates in [`04-implementation-plan.md`](../04-implementation-plan.md) are unchanged — these answer a different question: *what can I run, today, to prove the last chunk of work is correct before starting the next one?*

**Rule: a module is done when its checkpoint passes, not when its code exists.** Every checkpoint is a command plus an observable result. If you cannot demonstrate it, the module is not done.

## Module map

```
M0 skeleton ─→ M1 schema ─→ M2 seed ─→ M3 read API ─┐
                                                     ├─→ M7 endpoints over real data ─→ M8 deploy
M4 fetcher ─→ M5 parse (Manila) ─→ M6 pipeline ─────┘
                                        │
M9 adapters ×2 + stub  ←────────────────┘
M10 documents/RAG   (needs M6)
M11 agent surface   (needs M7)
M12 operations      (needs M8)
```

Two independent tracks after M2: the **API track** (M3) and the **ingestion track** (M4–M6). They share no files and meet at M7. Work them in parallel or alternate.

## Modules

| Module | Focus | Phase |
|---|---|---|
| [M0](m00-skeleton.md) | Skeleton | 0.1 |
| [M1](m01-schema.md) | Schema | 0.2–0.3 |
| [M2](m02-seed.md) | Seed | 0.4 |
| [M3](m03-read-api.md) | Read API over seeds | 0.5 |
| [M4](m04-fetcher.md) | Fetcher | 1.1 (first half) |
| [M5](m05-manila-parse.md) | Manila parse | 1.2–1.3 |
| [M6](m06-pipeline.md) | Pipeline | 1.1 (second half), 1.4 |
| [M7](m07-real-endpoints.md) | Endpoints over real data | 1.6 |
| [M8](m08-deploy.md) | First deploy | 0.6 (deliberately moved after M7) |
| [M9](m09-multi-campus.md) | More campuses | 2 |
| [M10](m10-rag.md) | Documents and RAG | 3 |
| [M11](m11-agent-dx.md) | Agent surface and DX | 4 |
| [M12](m12-operations.md) | Operations | 5 (ongoing) |

## Hard gates

Three checkpoints block all forward progress until demonstrated:

1. **M1** — enum-order and uuidv7 assertions pass *before* migration 001 reaches Supabase. Four defects in 001 are unfixable after it ships.
2. **M6** — a deliberately broken selector quarantines and preserves data. Proven in a sandbox before it matters in production.
3. **M9** — zero schema migrations to add campuses 2 and 3. If this fails the schema is wrong; fix now, every later estimate assumes it holds.

## Sequencing notes

- **Manual collection (M5) is week-1 work** regardless of where the code stands — doc 04's critical-path note. Needs a browser and patience, nothing else.
- **The only reordering vs doc 04** is deploy (M8) after real data (M7). Reasoning in [m08-deploy.md](./m08-deploy.md); doc 04's original order also works.
- Checkpoints are cumulative — every earlier checkpoint keeps passing; CI enforces that for free.
