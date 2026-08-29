/**
 * Post-deploy smoke tests — docs/14-testing-strategy.md §8.
 *
 *   node scripts/smoke.mjs https://tup-api.vercel.app
 *
 * Five checks against a live deployment, run after every deploy. These are not unit
 * tests: they exercise the real read path against the real database, which is the only
 * place the pooler configuration, the environment variables and the build output are
 * all true at once.
 *
 * The `hours_since_ingest` assertion is doing double duty — it is also defence #2
 * against silent staleness, the project's named anti-metric, and it works even when the
 * scheduled ingestion that would have raised the alarm is itself dead (errata E14).
 */
const base = (process.argv[2] ?? process.env.SMOKE_BASE_URL ?? '').replace(/\/$/, '');
if (!base) {
  console.error('Usage: node scripts/smoke.mjs <base-url>');
  process.exit(2);
}

let failures = 0;

function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function get(path) {
  const res = await fetch(base + path, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { _raw: text.slice(0, 200) };
  }
  return { status: res.status, body, headers: res.headers };
}

console.log(`smoke: ${base}\n`);

const health = await get('/v1/health');
check(
  'GET /v1/health — 200, ok, ingested within 36h',
  health.status === 200 && health.body.status === 'ok' && health.body.hours_since_ingest < 36,
  `status=${health.body.status} hours_since_ingest=${health.body.hours_since_ingest}`,
);

const campuses = await get('/v1/campuses');
check(
  'GET /v1/campuses — 200, exactly 4 campuses',
  campuses.status === 200 && campuses.body.meta?.count === 4,
  (campuses.body.data ?? []).map((c) => c.slug).join(','),
);

const program = await get('/v1/programs/bsee');
const offerings = program.body.data?.offerings ?? [];
check(
  'GET /v1/programs/bsee — 200, offerings with provenance',
  program.status === 200 &&
    offerings.length > 0 &&
    offerings.every((o) => o.provenance?.source_url && o.provenance?.last_verified_at),
  offerings.map((o) => `${o.campus}:${o.unit?.type}`).join(' '),
);

const bad = await get('/v1/programs?campus=xxxxx');
check(
  'GET /v1/programs?campus=xxxxx — 400, RFC 9457',
  bad.status === 400 &&
    (bad.headers.get('content-type') ?? '').includes('application/problem+json') &&
    typeof bad.body.type === 'string' &&
    bad.body.type.startsWith('http'),
  bad.body.type ?? '',
);

const spec = await get('/openapi.json');
const specPaths = Object.keys(spec.body.paths ?? {});
check(
  'GET /openapi.json — 200, parses, describes every endpoint',
  spec.status === 200 && spec.body.openapi === '3.1.0' && specPaths.length > 0,
  `openapi=${spec.body.openapi} paths=${specPaths.length}`,
);

// Not in §8, but cheap and it is the claim the whole project rests on: no canonical
// row may be served without provenance (ADR-004).
const units = await get('/v1/units?limit=5');
check(
  'every returned record carries provenance (ADR-004)',
  units.status === 200 &&
    (units.body.data ?? []).length > 0 &&
    units.body.data.every((u) => u.provenance?.confidence && u.provenance?.source_url),
  `${units.body.data?.length ?? 0} records checked`,
);

console.log(`\n${failures === 0 ? 'all smoke checks passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
