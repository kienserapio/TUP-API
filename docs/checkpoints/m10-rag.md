# M10 — Documents and RAG

**Phase mapping:** [`04-implementation-plan.md`](../04-implementation-plan.md) Phase 3
**Navigate:** ← [m09-multi-campus](./m09-multi-campus.md) · [index](./README.md) · [m11-agent-dx](./m11-agent-dx.md) →

---

**Goal:** Phase 3 of [`../04-implementation-plan.md`](../04-implementation-plan.md), unchanged.

## Contains

- PDF ingestion (`unpdf`), `documents.edition` + `effective_date` populated — non-negotiable
- Heading-aware chunker ([ADR-015](../02-ADRs.md#adr-015)), `context_header` construction
- Hash-gated embeddings (`text-embedding-3-small`, 1536d)
- `GET /v1/search` (RRF hybrid), `POST /v1/rag/query` (evidence only)

## Checkpoints, in order

1. Chunker fixture tests green **before any embedding spend**
2. Re-run embeddings with no content change → zero API calls
3. Eval set (25 questions): recall@5 ≥ 0.8; cross-campus contamination test passes (Cavite question → no Manila chunk first)
4. [E8](../00-errata.md) verified with `EXPLAIN ANALYZE`: hybrid query uses the HNSW index, full candidate counts under a campus filter
