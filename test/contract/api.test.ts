/**
 * Contract tests: what the API ACTUALLY returns, validated against the PUBLISHED
 * openapi.json — not against the Zod schemas directly.
 *
 * This looks circular because the spec is generated from the same schemas the
 * handlers validate with. It is not: it catches the gap between schema and
 * serialization — dates in the wrong format, `null` where the schema says the field
 * is omitted, an envelope assembled by hand in one handler and by a helper elsewhere.
 * docs/14-testing-strategy.md §5
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { beforeAll, describe, expect, test } from 'vitest';
import { app } from '../../apps/api/src/app.js';

interface OpenApiDoc {
  paths: Record<string, Record<string, { responses: Record<string, ResponseSpec> }>>;
  components: { schemas: Record<string, unknown> };
}
interface ResponseSpec {
  content?: Record<string, { schema: unknown }>;
}

let doc: OpenApiDoc;
let ajv: Ajv;

/** docs/13 §8.1 — anything outside this list is a bug. */
const STATUS_ALLOWLIST = [200, 304, 400, 404, 405, 422, 429, 500, 503];

beforeAll(async () => {
  doc = JSON.parse(
    await readFile(resolve(process.cwd(), 'apps/api/openapi.json'), 'utf8'),
  ) as OpenApiDoc;

  ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const [name, schema] of Object.entries(doc.components.schemas)) {
    ajv.addSchema(schema as object, `#/components/schemas/${name}`);
  }
});

function validatorFor(path: string, status: number, contentType: string): ValidateFunction {
  const spec = doc.paths[path]?.['get']?.responses[String(status)];
  const schema = spec?.content?.[contentType]?.schema;
  if (!schema) throw new Error(`No ${status} ${contentType} schema declared for GET ${path}`);
  return ajv.compile(schema as object);
}

function assertValid(v: ValidateFunction, body: unknown, label: string): void {
  const ok = v(body);
  expect(ok, `${label} does not match the published contract: ${ajv.errorsText(v.errors)}`).toBe(
    true,
  );
}

describe('GET /v1/campuses', () => {
  test('200 body validates against the published spec', async () => {
    const res = await app.request('/v1/campuses');
    expect(res.status).toBe(200);
    assertValid(validatorFor('/v1/campuses', 200, 'application/json'), await res.json(), 'campus list');
  });

  test('rejects an unknown query parameter with RFC 9457', async () => {
    const res = await app.request('/v1/campuses?bogus=1');
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    assertValid(
      validatorFor('/v1/campuses', 400, 'application/problem+json'),
      await res.json(),
      '400 body',
    );
  });

  test('honours If-None-Match with a bodyless 304', async () => {
    const first = await app.request('/v1/campuses');
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();

    const second = await app.request('/v1/campuses', { headers: { 'If-None-Match': etag! } });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
  });

  test('sets a cache policy', async () => {
    const res = await app.request('/v1/campuses');
    expect(res.headers.get('cache-control')).toContain('max-age');
  });
});

describe('GET /v1/campuses/{slug}', () => {
  test('200 body validates against the published spec', async () => {
    const res = await app.request('/v1/campuses/manila');
    expect(res.status).toBe(200);
    assertValid(
      validatorFor('/v1/campuses/{slug}', 200, 'application/json'),
      await res.json(),
      'campus',
    );
  });

  test('404 carries did_you_mean for a near-miss slug', async () => {
    const res = await app.request('/v1/campuses/manil');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { did_you_mean?: string[]; detail: string };
    assertValid(validatorFor('/v1/campuses/{slug}', 404, 'application/problem+json'), body, '404');
    expect(body.did_you_mean).toContain('manila');
    // detail must name the offending value, not just the class of error
    expect(body.detail).toContain('manil');
  });
});

/** docs/14 §5.1 — table-driven, so a new endpoint inherits every rule automatically. */
const COLLECTIONS = [
  '/v1/campuses',
  '/v1/campuses/manila/units',
  '/v1/units',
  '/v1/programs',
  '/v1/offerings',
];
const MEMBERS = [
  '/v1/campuses/manila',
  '/v1/campuses/taguig',
  '/v1/units/manila/coe',
  '/v1/programs/bsce',
  '/v1/offerings/manila/bsce',
];

describe('universal assertions — every endpoint inherits these', () => {
  const endpoints = [...COLLECTIONS, ...MEMBERS];

  test.each(endpoints)('%s ships provenance in the DEFAULT payload (ADR-004)', async (path) => {
    const res = await app.request(path);
    const body = (await res.json()) as { data: unknown };
    const items = Array.isArray(body.data) ? body.data : [body.data];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const p = (item as { provenance?: Record<string, unknown> }).provenance;
      expect(p, `${path}: provenance missing`).toBeDefined();
      expect(p!['last_verified_at']).toBeTypeOf('string');
      expect(p!['confidence']).toBeTypeOf('string');
      expect(p!['staleness_days']).toBeTypeOf('number');
      expect(p!['source_url']).toBeTypeOf('string');
    }
  });

  test.each(endpoints)('%s never exposes a raw UUID as an identifier', async (path) => {
    const res = await app.request(path);
    const text = await res.text();
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  });

  test.each(endpoints)('%s returns an allowlisted status code', async (path) => {
    const res = await app.request(path);
    expect(STATUS_ALLOWLIST).toContain(res.status);
  });

  test.each(endpoints)('%s emits an X-Request-Id for support traceability', async (path) => {
    const res = await app.request(path);
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  test('write methods are refused — there is no write path by design', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await app.request('/v1/campuses', { method });
      expect([404, 405]).toContain(res.status);
    }
  });

  test('an unknown route returns RFC 9457, not an HTML error page', async () => {
    const res = await app.request('/v1/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
  });

  test.each(endpoints)('%s rejects an unknown query parameter', async (path) => {
    const res = await app.request(`${path}${path.includes('?') ? '&' : '?'}bogus=1`);
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
  });

  test.each(endpoints)('%s emits an ETag and honours If-None-Match', async (path) => {
    const first = await app.request(path);
    const etag = first.headers.get('etag');
    expect(etag, `${path} sent no ETag`).toBeTruthy();
    const second = await app.request(path, { headers: { 'If-None-Match': etag! } });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
  });

  test.each(endpoints)('%s never emits null where an array is declared', async (path) => {
    const res = await app.request(path);
    const body = (await res.json()) as { data: unknown };
    const items = Array.isArray(body.data) ? body.data : [body.data];
    for (const item of items) {
      for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
        if (['aliases', 'emails', 'majors', 'offerings'].includes(key)) {
          expect(Array.isArray(value), `${path}: ${key} is not an array`).toBe(true);
        }
      }
    }
  });

  test.each(endpoints)('%s carries unit_type wherever an academic unit appears', async (path) => {
    const res = await app.request(path);
    const text = await res.text();
    // ADR-002, docs/13 §5.2. If a payload names a unit, it must say what kind it is.
    for (const match of text.matchAll(/"unit"\s*:\s*(\{[^}]*\})/g)) {
      expect(match[1], `${path}: a unit without a type`).toContain('"type"');
    }
  });

  test.each(COLLECTIONS)('%s caps limit at 100 and 400s above it', async (path) => {
    expect((await app.request(`${path}?limit=100`)).status).toBe(200);
    const tooBig = await app.request(`${path}?limit=101`);
    expect(tooBig.status).toBe(400);
    expect(tooBig.headers.get('content-type')).toContain('application/problem+json');
  });

  test.each(COLLECTIONS)('%s reports freshness for what it actually returned', async (path) => {
    const res = await app.request(path);
    const body = (await res.json()) as {
      data: unknown[];
      meta: { freshness: Record<string, unknown>; generated_at: string };
      links: { self: string; next: string | null };
    };
    expect(body.meta.generated_at).toMatch(/Z$/);
    expect(body.meta.freshness).toHaveProperty('counts_by_confidence');
    expect(body.links.self).toContain(path);

    const counts = body.meta.freshness['counts_by_confidence'] as Record<string, number>;
    expect(counts['high'] + counts['medium'] + counts['low']).toBe(body.data.length);
  });

  test.each(COLLECTIONS)('%s ETag ignores generated_at, so caching actually works', async (path) => {
    // The ETag covers resource state, not the moment of assembly (docs/13 §10). If
    // generated_at were inside it, every response would be a cache miss.
    const first = await app.request(path);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await app.request(path);
    expect(second.headers.get('etag')).toBe(first.headers.get('etag'));
    const a = (await first.json()) as { meta: { generated_at: string } };
    const b = (await second.json()) as { meta: { generated_at: string } };
    expect(b.meta.generated_at >= a.meta.generated_at).toBe(true);
  });
});

describe('GET /v1/health', () => {
  test('validates and reports its own ingestion staleness', async () => {
    const res = await app.request('/v1/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    assertValid(validatorFor('/v1/health', 200, 'application/json'), body, 'health');
    expect(body).toHaveProperty('hours_since_ingest');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
