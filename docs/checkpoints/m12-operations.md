# M12 — Operations

**Phase mapping:** [`04-implementation-plan.md`](../04-implementation-plan.md) Phase 5 (ongoing)
**Navigate:** ← [m11-agent-dx](./m11-agent-dx.md) · [index](./README.md)

---

**Goal:** Phase 5 of [`../04-implementation-plan.md`](../04-implementation-plan.md), unchanged.

## Contains

- `GET /v1/changes?since=`; three alerts only; **external heartbeat** ([`../12-build-prerequisites.md §4`](../12-build-prerequisites.md))
- Runbooks written before needed; handover per [`../07-governance-and-distribution.md`](../07-governance-and-distribution.md)

## Checkpoint

- Kill the ingest cron for a day → heartbeat alert fires
- Restore a backup into a scratch DB, replay from snapshots → coverage counts match
- Second maintainer ships an adapter fix unassisted
