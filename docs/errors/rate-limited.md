# 429 — Rate limited

`type: https://github.com/kienserapio/TUP-API/blob/main/docs/errors/rate-limited.md`

Too many requests. The response carries `Retry-After` in seconds, plus `RateLimit-Limit`,
`RateLimit-Remaining` and `RateLimit-Reset`.

Responses are cacheable (`Cache-Control: public, max-age=300`). Honouring the cache headers is the
simplest way never to see this.

---

Every error this API returns is [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457)
with content type `application/problem+json`:

```json
{
  "type": "…/errors/rate-limited.md",
  "title": "Rate limited",
  "status": 429,
  "detail": "Names the offending value, not just the class of error.",
  "instance": "/v1/…"
}
```

Status codes are an allowlist — `200`, `304`, `400`, `404`, `405`, `422`, `429`, `500`, `503`.
Anything else is a bug. See [`../13-api-design-standards.md`](../13-api-design-standards.md) §8.
