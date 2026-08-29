/**
 * The politeness layer. ADR-005 makes it structurally unbypassable: adapters cannot
 * fetch, so every request in the project passes through this file and inherits the
 * allowlist, the robots check, the per-domain queue, and the delay.
 *
 * The freshness mechanism is **content-hash gating, not conditional GET**. No live
 * campus emits `ETag` or `Last-Modified` (docs/08 §2.1), so a `304` can never arrive
 * and the TDD §3.2 design cannot work as written — errata E2. Validators are still
 * sent when a previous snapshot recorded one, because Cavite or Visayas may add them.
 */
import type { RawSnapshot, SourceRef } from './contracts.js';
import { assertAllowedUrl, campusOf, hostOf } from './origins.js';
import { contentHash } from './hash.js';
import { FixtureIndex } from './fixtures.js';
import { refusingClient, undiciClient, type HttpClient } from './http.js';
import {
  assertContentSignalUnchanged,
  evaluateRobots,
  looksLikeHtml,
  parseRobots,
  robotsAbsent,
  type ContentSignal,
  type Robots,
} from './robots.js';

export const FETCH_POLICY = {
  // The contact URL is load-bearing, not decoration: it is how a TUP administrator who
  // sees this in their logs finds out who is crawling them and how to ask us to stop.
  // It must resolve to a real, public page. docs/08 §3.1, errata E24.
  userAgent:
    'TUPOpenDataBot/1.0 (+https://github.com/kienserapio/TUP-API; student open-data project)',
  /** The product token robots.txt groups are matched against. */
  productToken: 'tupopendatabot',
  perDomainConcurrency: 1,
  minDelayMs: 3000,
  timeoutMs: 20_000,
  retries: { attempts: 3, backoff: 'exponential' as const, baseMs: 2000 },
  respectRobots: true,
  respectCrawlDelay: true,
  maxPagesPerRun: 500,
  /** Off-peak window in Philippine time. Advisory for the scheduler, not enforced here. */
  windowPHT: { start: 2, end: 4 },
  robotsCacheTtlMs: 24 * 60 * 60 * 1000,
} as const;

export type FetchMode = 'fixtures' | 'live';

export interface FetchContext {
  /** Newest snapshot's hash for this source. The whole freshness mechanism. */
  previousContentHash?: string | null;
  previousEtag?: string | null;
  previousLastModified?: string | null;
  /** Stored `sources.content_signal`. A change stops the run — errata E11. */
  previousContentSignal?: ContentSignal | null;
}

export interface RobotsFacts {
  present: boolean;
  allowed: boolean;
  contentSignal: ContentSignal | null;
  checkedAt: Date;
}

export type FetchOutcome =
  | { status: 'excluded'; url: string; pattern: string }
  | { status: 'blocked'; url: string; reason: string; robots: RobotsFacts }
  | { status: 'unchanged'; url: string; httpStatus: number; contentHash: string; robots: RobotsFacts | null }
  | { status: 'fetched'; url: string; snapshot: RawSnapshot; robots: RobotsFacts | null }
  | { status: 'failed'; url: string; error: string; attempts: number };

export interface FetcherOptions {
  mode?: FetchMode;
  client?: HttpClient;
  fixtures?: FixtureIndex;
  /** `excluded_sources.url_pattern` rows. Checked before every fetch AND publish. */
  excludedPatterns?: string[];
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  policy?: typeof FETCH_POLICY;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `url_pattern` supports a trailing/embedded `*`. A takedown request names a page or a
 * tree; both must survive a re-crawl automatically (RB-06), which is why this is
 * checked before the fetch and again before the publish.
 */
export function matchesExcluded(url: string, patterns: readonly string[]): string | null {
  for (const pattern of patterns) {
    const regex = new RegExp(
      `^${pattern
        .split('*')
        .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`,
    );
    if (regex.test(url)) return pattern;
  }
  return null;
}

/** One request at a time per host, with a floor on the gap between them. */
class DomainQueue {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly lastStartedAt = new Map<string, number>();

  constructor(
    private readonly minDelayMs: number,
    private readonly now: () => Date,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  run<T>(host: string, task: () => Promise<T>, extraDelayMs = 0): Promise<T> {
    const previous = this.tails.get(host) ?? Promise.resolve();
    const chained = previous.then(async () => {
      const last = this.lastStartedAt.get(host);
      const delay = Math.max(this.minDelayMs, extraDelayMs);
      if (last !== undefined) {
        const waited = this.now().getTime() - last;
        if (waited < delay) await this.sleep(delay - waited);
      }
      this.lastStartedAt.set(host, this.now().getTime());
      return task();
    });
    this.tails.set(
      host,
      chained.catch(() => undefined),
    );
    return chained;
  }
}

export class Fetcher {
  readonly mode: FetchMode;
  private readonly client: HttpClient;
  private readonly policy: typeof FETCH_POLICY;
  private readonly excluded: string[];
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly queue: DomainQueue;
  private readonly robotsCache = new Map<string, { robots: Robots; fetchedAt: number }>();
  private fixtures: FixtureIndex | null;
  private pagesFetched = 0;

  constructor(options: FetcherOptions = {}) {
    this.mode = options.mode ?? ((process.env['FETCH_MODE'] as FetchMode) ?? 'fixtures');
    this.policy = options.policy ?? FETCH_POLICY;
    this.client = options.client ?? (this.mode === 'live' ? undiciClient : refusingClient);
    this.excluded = [...(options.excludedPatterns ?? [])];
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? realSleep;
    this.fixtures = options.fixtures ?? null;
    this.queue = new DomainQueue(this.policy.minDelayMs, this.now, this.sleep);
  }

  setExcludedPatterns(patterns: string[]): void {
    this.excluded.splice(0, this.excluded.length, ...patterns);
  }

  async fixtureIndex(): Promise<FixtureIndex> {
    this.fixtures ??= await FixtureIndex.load();
    return this.fixtures;
  }

  get pageCount(): number {
    return this.pagesFetched;
  }

  async fetch(ref: SourceRef, context: FetchContext = {}): Promise<FetchOutcome> {
    // 1. excluded_sources, before anything else touches the URL.
    const excludedBy = matchesExcluded(ref.url, this.excluded);
    if (excludedBy) return { status: 'excluded', url: ref.url, pattern: excludedBy };

    // 2. the allowlist. A non-TUP URL throws rather than returning an outcome — it is
    //    a programming error in an adapter, not a runtime condition to be handled.
    assertAllowedUrl(ref.url);

    if (this.pagesFetched >= this.policy.maxPagesPerRun) {
      return {
        status: 'failed',
        url: ref.url,
        error: `maxPagesPerRun (${this.policy.maxPagesPerRun}) reached`,
        attempts: 0,
      };
    }

    // 3. manual sources always read from disk, in every mode — docs/03 §3.3. So does
    //    every source when FETCH_MODE=fixtures, which is what keeps local runs offline.
    if (ref.method === 'manual' || this.mode === 'fixtures') {
      return this.fromFixture(ref, context);
    }

    // 4. robots.txt, cached 24h. "Absent" is a cached fact, not a permanent grant [E12].
    const robots = await this.robotsFor(ref.url);
    const decision = evaluateRobots(robots, this.policy.productToken, ref.url);
    const facts: RobotsFacts = {
      present: robots.present,
      allowed: decision.allowed,
      contentSignal: robots.contentSignal,
      checkedAt: this.now(),
    };
    assertContentSignalUnchanged(
      hostOf(ref.url),
      context.previousContentSignal ?? null,
      robots.contentSignal,
    );
    if (this.policy.respectRobots && !decision.allowed) {
      return {
        status: 'blocked',
        url: ref.url,
        reason: `robots.txt ${decision.rule?.type ?? 'disallow'} ${decision.rule?.path ?? '/'}`,
        robots: facts,
      };
    }

    const crawlDelayMs =
      this.policy.respectCrawlDelay && decision.crawlDelaySeconds
        ? decision.crawlDelaySeconds * 1000
        : 0;

    return this.queue.run(
      hostOf(ref.url),
      () => this.fetchWithRetries(ref, context, facts),
      crawlDelayMs,
    );
  }

  private async fromFixture(ref: SourceRef, context: FetchContext): Promise<FetchOutcome> {
    const fixtures = await this.fixtureIndex();
    const resolved = await fixtures.read(ref.url);
    const hash = contentHash(resolved.body);
    this.pagesFetched++;
    if (context.previousContentHash && context.previousContentHash === hash) {
      return {
        status: 'unchanged',
        url: ref.url,
        httpStatus: resolved.entry.http_status ?? 200,
        contentHash: hash,
        robots: null,
      };
    }
    return {
      status: 'fetched',
      url: ref.url,
      robots: null,
      snapshot: {
        sourceRef: ref,
        // The collection time is a recorded fact about the fixture, never `now`.
        fetchedAt: new Date(resolved.entry.collected_at),
        httpStatus: resolved.entry.http_status ?? 200,
        contentType: resolved.entry.content_type ?? 'text/html',
        body: resolved.body,
        contentHash: hash,
      },
    };
  }

  private async fetchWithRetries(
    ref: SourceRef,
    context: FetchContext,
    robots: RobotsFacts,
  ): Promise<FetchOutcome> {
    const headers: Record<string, string> = {
      'user-agent': this.policy.userAgent,
      accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8',
      'accept-language': 'en',
      // No Cookie. No Authorization. PRD C1 is architectural and CI greps for it.
    };
    // Opportunistic only — see the file header. Handled correctly if a 304 ever arrives.
    if (context.previousEtag) headers['if-none-match'] = context.previousEtag;
    if (context.previousLastModified) headers['if-modified-since'] = context.previousLastModified;

    let lastError = 'unknown error';
    for (let attempt = 1; attempt <= this.policy.retries.attempts; attempt++) {
      try {
        const response = await this.client.get(ref.url, {
          headers,
          timeoutMs: this.policy.timeoutMs,
        });
        this.pagesFetched++;

        if (response.status === 304) {
          return {
            status: 'unchanged',
            url: ref.url,
            httpStatus: 304,
            contentHash: context.previousContentHash ?? '',
            robots,
          };
        }
        if (response.status >= 400) {
          lastError = `HTTP ${response.status}`;
          if (response.status < 500 && response.status !== 429) {
            // A 404 is a page that is gone, not a transient fault. Retrying it three
            // times just adds request volume against a WAF that counts requests.
            return { status: 'failed', url: ref.url, error: lastError, attempts: attempt };
          }
          if (attempt < this.policy.retries.attempts) await this.backoff(attempt);
          continue;
        }

        const hash = contentHash(response.body);
        if (context.previousContentHash && context.previousContentHash === hash) {
          // Verified-unchanged: no snapshot row, no parse, no publish. Errata E2.
          return {
            status: 'unchanged',
            url: ref.url,
            httpStatus: response.status,
            contentHash: hash,
            robots,
          };
        }

        const snapshot: RawSnapshot = {
          sourceRef: ref,
          fetchedAt: this.now(),
          httpStatus: response.status,
          contentType: response.headers['content-type'] ?? 'application/octet-stream',
          body: response.body,
          contentHash: hash,
        };
        const etag = response.headers['etag'];
        if (etag) snapshot.etag = etag;
        const lastModified = response.headers['last-modified'];
        if (lastModified) snapshot.lastModified = lastModified;

        return { status: 'fetched', url: ref.url, snapshot, robots };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < this.policy.retries.attempts) await this.backoff(attempt);
      }
    }
    return {
      status: 'failed',
      url: ref.url,
      error: lastError,
      attempts: this.policy.retries.attempts,
    };
  }

  private backoff(attempt: number): Promise<void> {
    return this.sleep(this.policy.retries.baseMs * 2 ** (attempt - 1));
  }

  /** 24h TTL. A site with no robots.txt today can have one tomorrow — errata E12. */
  async robotsFor(url: string): Promise<Robots> {
    const host = hostOf(url);
    const cached = this.robotsCache.get(host);
    if (cached && this.now().getTime() - cached.fetchedAt < this.policy.robotsCacheTtlMs) {
      return cached.robots;
    }

    let robots = robotsAbsent();
    try {
      const response = await this.client.get(`https://${host}/robots.txt`, {
        headers: { 'user-agent': this.policy.userAgent },
        timeoutMs: this.policy.timeoutMs,
      });
      const body = response.body.toString('utf8');
      // A 200 whose body is HTML is a 404 page in disguise. Both non-Visayas campuses
      // do exactly this today — docs/08 §3.2, §4.2.
      if (response.status === 200 && !looksLikeHtml(body)) robots = parseRobots(body);
    } catch {
      robots = robotsAbsent();
    }

    this.robotsCache.set(host, { robots, fetchedAt: this.now().getTime() });
    return robots;
  }

  /** Convenience for the campus a URL belongs to; used for the storage key prefix. */
  static campusFor(url: string): string {
    return campusOf(url) ?? 'unknown';
  }
}
