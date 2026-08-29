# 404 — No such resource

`type: https://github.com/kienserapio/TUP-API/blob/main/docs/errors/not-found.md`

No resource exists at that identifier.

For slug-shaped paths the response carries `did_you_mean`: up to three trigram-similar identifiers.
Use them — most 404s here are a near-miss on a slug.

Note that identifiers are campus-qualified where a slug is not globally unique: `manila/coe` and
`visayas/coe` are different colleges that share a slug.

---

Every error this API returns is [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457)
with content type `application/problem+json`:

```json
{
  "type": "…/errors/not-found.md",
  "title": "No such resource",
  "status": 404,
  "detail": "Names the offending value, not just the class of error.",
  "instance": "/v1/…"
}
```

Status codes are an allowlist — `200`, `304`, `400`, `404`, `405`, `422`, `429`, `500`, `503`.
Anything else is a bug. See [`../13-api-design-standards.md`](../13-api-design-standards.md) §8.
