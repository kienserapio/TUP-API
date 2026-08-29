/**
 * The only place in the repo that opens a socket to a TUP host.
 *
 * `packages/adapters` must never import this file — ADR-005, enforced by the parse
 * purity gate in scripts/ci-gates.sh and the ESLint block in eslint.config.js.
 */
import { Agent, request } from 'undici';
import { assertAllowedUrl, transportFor } from './origins.js';

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface HttpRequestInit {
  headers: Record<string, string>;
  timeoutMs: number;
}

export interface HttpClient {
  get(url: string, init: HttpRequestInit): Promise<HttpResponse>;
}

const agents = new Map<string, Agent>();

function agentFor(url: string, timeoutMs: number): Agent {
  const { allowH2 } = transportFor(url);
  const key = `${allowH2}:${timeoutMs}`;
  let agent = agents.get(key);
  if (!agent) {
    // docs/08 §2.2: Manila is pinned to HTTP/1.1. Everything else may negotiate.
    agent = new Agent({ allowH2, headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
    agents.set(key, agent);
  }
  return agent;
}

/** Redirects are followed explicitly, not by the dispatcher: Manila answers on the
 *  apex and hops to `/404error.php` for anything missing, and a hop that leaves the
 *  allowlist must fail rather than be followed. */
const MAX_REDIRECTS = 3;

export const undiciClient: HttpClient = {
  async get(url, init) {
    let target = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await request(target, {
        method: 'GET',
        headers: init.headers,
        dispatcher: agentFor(target, init.timeoutMs),
      });
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(response.headers)) {
        if (value === undefined) continue;
        headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
      }

      const location = headers['location'];
      if (response.statusCode >= 300 && response.statusCode < 400 && location) {
        await response.body.dump();
        target = new URL(location, target).toString();
        assertAllowedUrl(target);
        continue;
      }

      const body = Buffer.from(await response.body.arrayBuffer());
      return { status: response.statusCode, headers, body };
    }
    throw new Error(`Too many redirects fetching ${url} (limit ${MAX_REDIRECTS}).`);
  },
};

/** Used by every test and by FETCH_MODE=fixtures. Never reaches the network. */
export const refusingClient: HttpClient = {
  get(url) {
    return Promise.reject(
      new Error(
        `Refusing live request to ${url}: FETCH_MODE is 'fixtures'. ` +
          `Tests and local runs read committed fixtures — docs/15 §1.`,
      ),
    );
  },
};

export async function closeHttpClients(): Promise<void> {
  await Promise.all([...agents.values()].map((agent) => agent.close()));
  agents.clear();
}
