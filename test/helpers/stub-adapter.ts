/**
 * A controllable adapter and fetcher for pipeline integration tests.
 *
 * Deliberately not the Manila adapter: the behaviours under test are the pipeline's
 * (guard scoping, removal policy, hash gating), and driving them through a real
 * parser would mean editing fixtures to provoke each case — which docs/14 §3.3 bans
 * for good reason. The URLs are still real TUP hosts, because the domain allowlist is
 * not something a test gets to opt out of.
 */
import { CANONICAL_ORIGIN, type CampusAdapter, type Expectation, type HttpClient } from '@tup/core';

export interface StubPage {
  /** JSON body: `{ academic_unit?: [...], program_offering?: [...] }`. */
  records: Record<string, unknown[]>;
}

export class StubSite {
  readonly pages = new Map<string, StubPage>();
  readonly requested: string[] = [];

  url(path: string): string {
    return `${CANONICAL_ORIGIN.manila}${path}`;
  }

  set(path: string, records: Record<string, unknown[]>): string {
    const url = this.url(path);
    this.pages.set(url, { records });
    return url;
  }

  client(): HttpClient {
    return {
      get: (url) => {
        this.requested.push(url);
        if (url.endsWith('/robots.txt')) {
          return Promise.resolve({
            status: 200,
            headers: { 'content-type': 'text/plain' },
            body: Buffer.from('User-agent: *\nAllow: /\n'),
          });
        }
        const page = this.pages.get(url);
        if (!page) {
          return Promise.resolve({ status: 404, headers: {}, body: Buffer.from('') });
        }
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify(page.records)),
        });
      },
    };
  }

  adapter(paths: string[], expectations?: Partial<Record<string, Expectation>>): CampusAdapter {
    const urls = paths.map((path) => this.url(path));
    return {
      campusSlug: 'manila',
      domains: [new URL(CANONICAL_ORIGIN.manila).host],
      expectations: expectations as CampusAdapter['expectations'],
      async *discover() {
        for (const url of urls) {
          yield {
            url,
            entityTypes: ['academic_unit' as const, 'program_offering' as const],
            method: 'crawl' as const,
          };
        }
      },
      parse(snapshot) {
        const byEntity = JSON.parse(snapshot.body.toString('utf8')) as Record<string, unknown[]>;
        return Promise.resolve({ byEntity, warnings: [] });
      },
    };
  }
}

export const unit = (slug: string, name = slug.toUpperCase()) => ({
  slug,
  name,
  unit_type: 'college',
});

export const offering = (slug: string, sourceName: string, extra: Record<string, unknown> = {}) => ({
  source_name: sourceName,
  slug,
  ...extra,
});
