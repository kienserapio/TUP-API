# 422 — Syntactically valid, semantically impossible

`type: https://github.com/kienserapio/TUP-API/blob/main/docs/errors/unprocessable.md`

The request parsed but asks for something that cannot exist — for example a date range that ends
before it starts.

Check `detail`: it names the specific conflict.

---

Every error this API returns is [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457)
with content type `application/problem+json`:

```json
{
  "type": "…/errors/unprocessable.md",
  "title": "Syntactically valid, semantically impossible",
  "status": 422,
  "detail": "Names the offending value, not just the class of error.",
  "instance": "/v1/…"
}
```

Status codes are an allowlist — `200`, `304`, `400`, `404`, `405`, `422`, `429`, `500`, `503`.
Anything else is a bug. See [`../13-api-design-standards.md`](../13-api-design-standards.md) §8.
