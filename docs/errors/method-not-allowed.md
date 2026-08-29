# 405 — Write method attempted

`type: https://github.com/kienserapio/TUP-API/blob/main/docs/errors/method-not-allowed.md`

This API is read-only. `GET` is the only method on every endpoint except `POST /v1/rag/query`.

The absence of a write path is architectural, not an oversight: there is no authentication surface,
no user table, and no way for a request to change published data. Corrections go through a human
review queue, never a direct write.

---

Every error this API returns is [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457)
with content type `application/problem+json`:

```json
{
  "type": "…/errors/method-not-allowed.md",
  "title": "Write method attempted",
  "status": 405,
  "detail": "Names the offending value, not just the class of error.",
  "instance": "/v1/…"
}
```

Status codes are an allowlist — `200`, `304`, `400`, `404`, `405`, `422`, `429`, `500`, `503`.
Anything else is a bug. See [`../13-api-design-standards.md`](../13-api-design-standards.md) §8.
