# M11 — Agent surface and DX

**Phase mapping:** [`04-implementation-plan.md`](../04-implementation-plan.md) Phase 4
**Navigate:** ← [m10-rag](./m10-rag.md) · [index](./README.md) · [m12-operations](./m12-operations.md) →

---

**Goal:** Phase 4 of [`../04-implementation-plan.md`](../04-implementation-plan.md), unchanged.

## Contains

- MCP server: 6 tools, install instructions, recommended system prompt with `check_freshness`
- TypeScript SDK from `openapi.json`, published to npm
- Docs site (Scalar or Mintlify), `llms.txt`, API keys, freshness dashboard

## Checkpoint

- Claude Desktop connects to the MCP server and answers a TUP question **with citations**, declining on a stale-data prompt (`check_freshness` honoured)
- `npm i` of the SDK in a scratch project → typed call works
- **The 5-minute stranger test** — a real person, docs to successful call, unassisted
