# 400 — Invalid or unknown request parameter

`type: https://github.com/kienserapio/TUP-API/blob/main/docs/errors/invalid-parameter.md`

The request carried a parameter this endpoint does not accept, or a value outside its allowed range.

**This API rejects unknown query parameters rather than ignoring them.** Silently dropping a typo'd
filter returns unfiltered data that looks filtered, which is the worst possible failure for an API
whose value is precision.

Common causes:

- A misspelled parameter name. Check `detail` — it names the offending parameter.
- `limit` above 100. The maximum is 100; the default is 20.
- A `cursor` issued for a different set of filters. Cursors are bound to the query that produced
  them; change a filter and start the collection again without a cursor.
- A `campus` outside `manila`, `cavite`, `visayas`, `taguig`.

---

Every error this API returns is [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457)
with content type `application/problem+json`:

```json
{
  "type": "…/errors/invalid-parameter.md",
  "title": "Invalid or unknown request parameter",
  "status": 400,
  "detail": "Names the offending value, not just the class of error.",
  "instance": "/v1/…"
}
```

Status codes are an allowlist — `200`, `304`, `400`, `404`, `405`, `422`, `429`, `500`, `503`.
Anything else is a bug. See [`../13-api-design-standards.md`](../13-api-design-standards.md) §8.
