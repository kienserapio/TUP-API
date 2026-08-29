# 503 — Temporarily unavailable

`type: https://github.com/kienserapio/TUP-API/blob/main/docs/errors/unavailable.md`

The service is in maintenance or holding an ingestion lock. Retry after a short delay.

`GET /v1/health` reports whether the database is reachable and how long since ingestion last
succeeded, and is never rate limited.

---

Every error this API returns is [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457)
with content type `application/problem+json`:

```json
{
  "type": "…/errors/unavailable.md",
  "title": "Temporarily unavailable",
  "status": 503,
  "detail": "Names the offending value, not just the class of error.",
  "instance": "/v1/…"
}
```

Status codes are an allowlist — `200`, `304`, `400`, `404`, `405`, `422`, `429`, `500`, `503`.
Anything else is a bug. See [`../13-api-design-standards.md`](../13-api-design-standards.md) §8.
