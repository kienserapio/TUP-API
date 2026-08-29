# 500 — Unexpected server error

`type: https://github.com/kienserapio/TUP-API/blob/main/docs/errors/internal.md`

Something failed that should not have. The body is deliberately generic — this API never leaks SQL,
stack traces, hostnames or driver messages.

**Quote the `X-Request-Id` header when reporting it.** Every response carries one, and it makes the
entire request reconstructible from the logs.

---

Every error this API returns is [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457)
with content type `application/problem+json`:

```json
{
  "type": "…/errors/internal.md",
  "title": "Unexpected server error",
  "status": 500,
  "detail": "Names the offending value, not just the class of error.",
  "instance": "/v1/…"
}
```

Status codes are an allowlist — `200`, `304`, `400`, `404`, `405`, `422`, `429`, `500`, `503`.
Anything else is a bug. See [`../13-api-design-standards.md`](../13-api-design-standards.md) §8.
