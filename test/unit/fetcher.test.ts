/**
 * The M4 checkpoint, in fixtures only — no live traffic (docs/checkpoints/m04-fetcher.md).
 *
 * ADR-005 makes the politeness layer structurally unbypassable. That claim is only
 * worth anything if it is tested: a non-TUP URL must throw, an excluded URL must never
 * reach the network, and identical content must not produce a second snapshot.
 */
import { describe, expect, test } from 'vitest';
import {
  DomainNotAllowedError,
  Fetcher,
  FETCH_POLICY,
  MemorySnapshotStore,
  contentHash,
  isAllowedUrl,
  matchesExcluded,
  type HttpClient,
  type SourceRef,
} from '@tup/core';

const BODY = '<html><body><h1>College of Engineering</h1></body></html>';

function fakeClient(pages: Record<string, string>) {
  const calls: string[] = [];
  const client: HttpClient = {
    get(url) {
      calls.push(url);
      const body = pages[url];
      if (body === undefined) return Promise.resolve({ status: 404, headers: {}, body: Buffer.from('') });
      return Promise.resolve({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: Buffer.from(body),
      });
    },
  };
  return { client, calls };
}

function liveFetcher(pages: Record<string, string>, excluded: string[] = []) {
  const { client, calls } = fakeClient(pages);
  const fetcher = new Fetcher({
    mode: 'live',
    client,
    excludedPatterns: excluded,
    // Injected so the 3-second politeness floor does not make the suite take minutes.
    // The delay itself is asserted separately, against the clock, below.
    sleep: () => Promise.resolve(),
  });
  return { fetcher, calls };
}

const ref = (url: string, method: SourceRef['method'] = 'crawl'): SourceRef => ({
  url,
  entityTypes: ['program_offering'],
  method,
});

describe('domain allowlist — four TUP hosts only', () => {
  test('accepts each canonical origin', () => {
    for (const url of [
      'https://tup.edu.ph/page/academics',
      'https://www.tupcavite.edu.ph/programs',
      'https://tupvisayas.edu.ph/officials',
      'https://tupt.edu.ph/',
    ]) {
      expect(isAllowedUrl(url), url).toBe(true);
    }
  });

  test('rejects hosts that merely look right', () => {
    for (const url of [
      'https://www.tup.edu.ph/',
      'https://tupcavite.edu.ph/programs',
      'https://tup.edu.ph.evil.example/',
      'https://example.com/',
      'file:///etc/passwd',
    ]) {
      expect(isAllowedUrl(url), url).toBe(false);
    }
  });

  test('a non-TUP URL throws rather than returning an outcome', async () => {
    const { fetcher, calls } = liveFetcher({});
    await expect(fetcher.fetch(ref('https://example.com/programs'))).rejects.toBeInstanceOf(
      DomainNotAllowedError,
    );
    expect(calls).toEqual([]);
  });
});

describe('excluded_sources — checked before every fetch (RB-06)', () => {
  test('an excluded URL is never fetched', async () => {
    const url = 'https://tup.edu.ph/pages/students/private';
    const { fetcher, calls } = liveFetcher({ [url]: BODY }, [url]);
    const outcome = await fetcher.fetch(ref(url));
    expect(outcome.status).toBe('excluded');
    expect(calls).toEqual([]);
  });

  test('a wildcard pattern excludes a whole tree', async () => {
    const url = 'https://tup.edu.ph/registrar/services/transcripts';
    const { fetcher, calls } = liveFetcher({ [url]: BODY }, ['https://tup.edu.ph/registrar/*']);
    expect((await fetcher.fetch(ref(url))).status).toBe('excluded');
    expect(calls).toEqual([]);
  });

  test('matching is anchored, so a pattern cannot be dodged by a suffix', () => {
    expect(matchesExcluded('https://tup.edu.ph/a', ['https://tup.edu.ph/a'])).toBe(
      'https://tup.edu.ph/a',
    );
    expect(matchesExcluded('https://tup.edu.ph/ab', ['https://tup.edu.ph/a'])).toBeNull();
  });
});

describe('robots.txt is consulted before the page', () => {
  test('a disallowed URL is blocked and the page is never requested', async () => {
    const { client, calls } = fakeClient({
      'https://tup.edu.ph/robots.txt': 'User-agent: *\nDisallow: /pages/\n',
      'https://tup.edu.ph/pages/students/handbook': BODY,
    });
    const fetcher = new Fetcher({ mode: 'live', client, sleep: () => Promise.resolve() });
    const outcome = await fetcher.fetch(ref('https://tup.edu.ph/pages/students/handbook'));
    expect(outcome.status).toBe('blocked');
    expect(calls).toEqual(['https://tup.edu.ph/robots.txt']);
  });

  test('the robots result is cached, not re-fetched per page', async () => {
    const { client, calls } = fakeClient({
      'https://tup.edu.ph/robots.txt': 'User-agent: *\nAllow: /\n',
      'https://tup.edu.ph/a': BODY,
      'https://tup.edu.ph/b': BODY,
    });
    const fetcher = new Fetcher({ mode: 'live', client, sleep: () => Promise.resolve() });
    await fetcher.fetch(ref('https://tup.edu.ph/a'));
    await fetcher.fetch(ref('https://tup.edu.ph/b'));
    expect(calls.filter((u) => u.endsWith('robots.txt'))).toHaveLength(1);
  });
});

describe('content-hash gating replaces conditional GET [E2]', () => {
  test('same body twice → the second call is unchanged, not a new snapshot', async () => {
    const url = 'https://tup.edu.ph/courses/academics/coe';
    const { fetcher } = liveFetcher({
      'https://tup.edu.ph/robots.txt': 'User-agent: *\nAllow: /\n',
      [url]: BODY,
    });

    const first = await fetcher.fetch(ref(url));
    expect(first.status).toBe('fetched');
    const hash = first.status === 'fetched' ? first.snapshot.contentHash : '';
    expect(hash).toBe(contentHash(Buffer.from(BODY)));

    const second = await fetcher.fetch(ref(url), { previousContentHash: hash });
    expect(second.status).toBe('unchanged');
  });

  test('a changed body produces a new snapshot', async () => {
    const url = 'https://tup.edu.ph/courses/academics/coe';
    const { fetcher } = liveFetcher({
      'https://tup.edu.ph/robots.txt': 'User-agent: *\nAllow: /\n',
      [url]: BODY,
    });
    const outcome = await fetcher.fetch(ref(url), { previousContentHash: 'stale-hash' });
    expect(outcome.status).toBe('fetched');
  });

  test('the snapshot store writes identical content once [E18]', async () => {
    const store = new MemorySnapshotStore();
    const body = Buffer.from(BODY);
    const hash = contentHash(body);
    const first = await store.put('manila', hash, body);
    const second = await store.put('manila', hash, body);
    expect(first.wrote).toBe(true);
    expect(second.wrote).toBe(false);
    expect(second.storageKey).toBe(first.storageKey);
    expect(store.objects.size).toBe(1);
  });

  test('a 304 is still handled correctly if a campus ever starts sending validators', async () => {
    const client: HttpClient = {
      get: () => Promise.resolve({ status: 304, headers: {}, body: Buffer.from('') }),
    };
    const fetcher = new Fetcher({ mode: 'live', client, sleep: () => Promise.resolve() });
    const outcome = await fetcher.fetch(ref('https://tupvisayas.edu.ph/officials'), {
      previousContentHash: 'abc',
      previousEtag: '"v1"',
    });
    expect(outcome.status).toBe('unchanged');
    if (outcome.status === 'unchanged') expect(outcome.httpStatus).toBe(304);
  });
});

describe('politeness', () => {
  test('the declared policy is the one docs/03 §3.2 specifies', () => {
    expect(FETCH_POLICY.perDomainConcurrency).toBe(1);
    expect(FETCH_POLICY.minDelayMs).toBe(3000);
    expect(FETCH_POLICY.timeoutMs).toBe(20_000);
    expect(FETCH_POLICY.retries.attempts).toBe(3);
    expect(FETCH_POLICY.maxPagesPerRun).toBe(500);
    expect(FETCH_POLICY.userAgent).toMatch(/^TUPOpenDataBot\/1\.0 \(\+https:\/\/.+\)$/);
  });

  test('waits at least minDelayMs between requests to the same host', async () => {
    let clock = 0;
    const slept: number[] = [];
    const { client } = fakeClient({
      'https://tupvisayas.edu.ph/robots.txt': 'User-agent: *\nAllow: /\n',
      'https://tupvisayas.edu.ph/a': BODY,
      'https://tupvisayas.edu.ph/b': BODY,
    });
    const fetcher = new Fetcher({
      mode: 'live',
      client,
      now: () => new Date(clock),
      sleep: (ms) => {
        slept.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    });
    await fetcher.fetch(ref('https://tupvisayas.edu.ph/a'));
    await fetcher.fetch(ref('https://tupvisayas.edu.ph/b'));
    expect(slept).toContain(FETCH_POLICY.minDelayMs);
  });

  test('never sends Cookie or Authorization — PRD C1 is architectural', async () => {
    const seen: Record<string, string>[] = [];
    const client: HttpClient = {
      get: (_url, init) => {
        seen.push(init.headers);
        return Promise.resolve({ status: 200, headers: {}, body: Buffer.from(BODY) });
      },
    };
    const fetcher = new Fetcher({ mode: 'live', client, sleep: () => Promise.resolve() });
    await fetcher.fetch(ref('https://tup.edu.ph/page/academics'));
    for (const headers of seen) {
      const keys = Object.keys(headers).map((k) => k.toLowerCase());
      expect(keys).not.toContain('cookie');
      expect(keys).not.toContain('authorization');
      expect(headers['user-agent']).toBe(FETCH_POLICY.userAgent);
    }
  });

  test('retries a 5xx with exponential backoff, then gives up without inventing data', async () => {
    const slept: number[] = [];
    const client: HttpClient = {
      get: (url) =>
        Promise.resolve(
          url.endsWith('robots.txt')
            ? { status: 404, headers: {}, body: Buffer.from('') }
            : { status: 503, headers: {}, body: Buffer.from('') },
        ),
    };
    const fetcher = new Fetcher({
      mode: 'live',
      client,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    const outcome = await fetcher.fetch(ref('https://tup.edu.ph/page/academics'));
    expect(outcome.status).toBe('failed');
    expect(slept).toEqual([2000, 4000]);
  });

  test('a 404 fails immediately rather than retrying a page that is simply gone', async () => {
    const { fetcher, calls } = liveFetcher({
      'https://tup.edu.ph/robots.txt': 'User-agent: *\nAllow: /\n',
    });
    const outcome = await fetcher.fetch(ref('https://tup.edu.ph/page/gone'));
    expect(outcome.status).toBe('failed');
    expect(calls.filter((u) => u.endsWith('/page/gone'))).toHaveLength(1);
  });
});

describe('fixtures mode — the reason local runs are offline', () => {
  test('resolves from committed fixtures and never reaches the client', async () => {
    const { client, calls } = fakeClient({});
    const fetcher = new Fetcher({ mode: 'fixtures', client });
    const outcome = await fetcher.fetch(ref('https://tup.edu.ph/page/academics'));
    expect(outcome.status).toBe('fetched');
    expect(calls).toEqual([]);
  });

  test('a manual source reads from disk even in live mode — docs/03 §3.3', async () => {
    const { client, calls } = fakeClient({});
    const fetcher = new Fetcher({ mode: 'live', client, sleep: () => Promise.resolve() });
    const outcome = await fetcher.fetch(ref('https://tup.edu.ph/page/academics', 'manual'));
    expect(outcome.status).toBe('fetched');
    expect(calls).toEqual([]);
  });

  test('a URL with no fixture fails loudly instead of silently returning nothing', async () => {
    const fetcher = new Fetcher({ mode: 'fixtures' });
    await expect(fetcher.fetch(ref('https://tup.edu.ph/page/nonexistent'))).rejects.toThrow(
      /No fixture for/,
    );
  });
});
