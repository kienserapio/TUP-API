# Error reference

Every `type` URI in an error body resolves to a page in this directory. A dead error link is worse
than no link ([`../13-api-design-standards.md`](../13-api-design-standards.md) §8.2), so these exist
before the API is public rather than after someone complains.

| Status | Type | Page |
|---|---|---|
| 400 | `invalid-parameter` | [invalid-parameter.md](./invalid-parameter.md) |
| 404 | `not-found` | [not-found.md](./not-found.md) |
| 405 | `method-not-allowed` | [method-not-allowed.md](./method-not-allowed.md) |
| 422 | `unprocessable` | [unprocessable.md](./unprocessable.md) |
| 429 | `rate-limited` | [rate-limited.md](./rate-limited.md) |
| 500 | `internal` | [internal.md](./internal.md) |
| 503 | `unavailable` | [unavailable.md](./unavailable.md) |

`401` and `403` do not appear. There is no authentication surface.
