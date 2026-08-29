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

describe('universal assertions — every endpoint inherits these', () => {
  const endpoints = ['/v1/campuses', '/v1/campuses/manila', '/v1/campuses/taguig'];

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
