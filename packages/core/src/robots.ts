/**
 * robots.txt evaluation, RFC 9309, plus Cloudflare `Content-Signal` parsing.
 *
 * Two facts drive the shape of this file:
 *
 * 1. **Absent is not the same as allowed.** Manila and Cavite serve no robots.txt
 *    today (docs/08 §3.2, §4.2), which RFC 9309 reads as allow-all — but a site with
 *    no robots.txt today can have one tomorrow. `present` is recorded separately from
 *    `allowed` so RB-03 still works when one appears. Errata E12.
 * 2. **A changed Content-Signal stops the run.** Visayas serves an express
 *    reservation of rights (docs/08 §5.1). A silently-appearing `ai-input=no` must
 *    halt the Visayas pipeline rather than be discovered months later. Errata E11.
 */

export interface RobotsRule {
  type: 'allow' | 'disallow';
  path: string;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelaySeconds?: number;
  contentSignal?: ContentSignal;
}

export type ContentSignal = Record<string, string>;

export interface Robots {
  /** False when the origin serves no robots.txt. Allow-all, but a *cached fact*. */
  present: boolean;
  groups: RobotsGroup[];
  sitemaps: string[];
  /** The signal that applies to `*`, which is the group this project crawls under. */
  contentSignal: ContentSignal | null;
  /** Verbatim body, kept so a diff against the stored copy is possible. */
  raw: string;
}

export interface RobotsDecision {
  allowed: boolean;
  /** The rule that decided it, for the log line and the `blocked` source note. */
  rule: RobotsRule | null;
  crawlDelaySeconds?: number;
  matchedAgent: string | null;
}

export class RobotsDisallowedError extends Error {
  constructor(
    readonly url: string,
    readonly rule: string,
  ) {
    super(`robots.txt disallows ${url} (matched ${rule}). Source marked blocked; crawl disabled.`);
    this.name = 'RobotsDisallowedError';
  }
}

export class ContentSignalChangedError extends Error {
  constructor(
    readonly domain: string,
    readonly previous: ContentSignal,
    readonly current: ContentSignal,
  ) {
    super(
      `Content-Signal changed for ${domain}: ${JSON.stringify(previous)} -> ${JSON.stringify(current)}. ` +
        `Stopping the run. docs/08 §5.1 requires a human to read the new signal before crawling again.`,
    );
    this.name = 'ContentSignalChangedError';
  }
}

/** An origin that serves no robots.txt. Allow-all per RFC 9309 §2.3.1.3. */
export function robotsAbsent(): Robots {
  return { present: false, groups: [], sitemaps: [], contentSignal: null, raw: '' };
}

/**
 * A 200 whose body is HTML is a 404 page in disguise — both Cavite's apex (a Synology
 * DSM page) and Manila (a redirect to `404error.php`) do this. Treat it as absent.
 */
export function looksLikeHtml(body: string): boolean {
  return /^\s*(<!doctype|<html)/i.test(body);
}

export function parseRobots(body: string): Robots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  /** RFC 9309 §2.2.1: consecutive user-agent lines share one group of rules. */
  let acceptingAgents = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    switch (field) {
      case 'user-agent': {
        if (!current || !acceptingAgents) {
          current = { agents: [], rules: [] };
          groups.push(current);
          acceptingAgents = true;
        }
        current.agents.push(value.toLowerCase());
        break;
      }
      case 'allow':
      case 'disallow': {
        if (!current) break;
        acceptingAgents = false;
        // "Disallow:" with an empty value imposes no restriction (RFC 9309 §2.2.2).
        if (field === 'disallow' && value === '') break;
        current.rules.push({ type: field, path: value });
        break;
      }
      case 'crawl-delay': {
        if (!current) break;
        acceptingAgents = false;
        const seconds = Number(value);
        if (Number.isFinite(seconds)) current.crawlDelaySeconds = seconds;
        break;
      }
      case 'content-signal': {
        if (!current) break;
        acceptingAgents = false;
        current.contentSignal = parseContentSignal(value);
        break;
      }
      case 'sitemap': {
        sitemaps.push(value);
        break;
      }
      default:
        break;
    }
  }

  const wildcardSignal =
    groups.find((g) => g.agents.includes('*') && g.contentSignal)?.contentSignal ?? null;

  return { present: true, groups, sitemaps, contentSignal: wildcardSignal, raw: body };
}

/** `search=yes,ai-train=no,use=reference` → `{ search: 'yes', 'ai-train': 'no', … }`. */
export function parseContentSignal(value: string): ContentSignal {
  const signal: ContentSignal = {};
  for (const part of value.split(',')) {
    const [key, ...rest] = part.split('=');
    if (!key) continue;
    const name = key.trim().toLowerCase();
    if (!name) continue;
    signal[name] = rest.join('=').trim().toLowerCase();
  }
  return signal;
}

/**
 * Escape everything except the two robots wildcards, then anchor at the start.
 * `$` is only an end anchor when it is the final character (RFC 9309 §2.2.3).
 */
function ruleMatches(rulePath: string, urlPath: string): boolean {
  if (rulePath === '') return false;
  const anchored = rulePath.endsWith('$');
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  const pattern = body
    .split('*')
    .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${pattern}${anchored ? '$' : ''}`).test(urlPath);
}

/** RFC 9309 §2.2.1 group selection: exact product-token match, else `*`. */
function selectGroup(robots: Robots, userAgentToken: string): RobotsGroup | null {
  const token = userAgentToken.toLowerCase();
  const merge = (groups: RobotsGroup[]): RobotsGroup | null => {
    if (groups.length === 0) return null;
    // Groups repeating the same user-agent are merged, not overridden — the Visayas
    // file declares `User-agent: *` twice and both halves are in force.
    return groups.reduce<RobotsGroup>(
      (acc, g) => ({
        agents: [...new Set([...acc.agents, ...g.agents])],
        rules: [...acc.rules, ...g.rules],
        crawlDelaySeconds: g.crawlDelaySeconds ?? acc.crawlDelaySeconds,
        contentSignal: g.contentSignal ?? acc.contentSignal,
      }),
      { agents: [], rules: [] },
    );
  };

  const named = robots.groups.filter((g) => g.agents.some((a) => a !== '*' && token.startsWith(a)));
  if (named.length > 0) return merge(named);
  return merge(robots.groups.filter((g) => g.agents.includes('*')));
}

/**
 * Longest match wins; a tie resolves to `allow` (RFC 9309 §2.2.2). This is why the
 * Visayas file permits this project: `TUPOpenDataBot` is not named, and the `*` group
 * is `Allow: /`.
 */
export function evaluateRobots(robots: Robots, userAgentToken: string, url: string): RobotsDecision {
  if (!robots.present) return { allowed: true, rule: null, matchedAgent: null };

  const group = selectGroup(robots, userAgentToken);
  if (!group) return { allowed: true, rule: null, matchedAgent: null };

  const path = new URL(url).pathname + new URL(url).search;
  let best: RobotsRule | null = null;
  for (const rule of group.rules) {
    if (!ruleMatches(rule.path, path)) continue;
    if (
      !best ||
      rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && rule.type === 'allow')
    ) {
      best = rule;
    }
  }

  const decision: RobotsDecision = {
    allowed: best ? best.type === 'allow' : true,
    rule: best,
    matchedAgent: group.agents[0] ?? null,
  };
  if (group.crawlDelaySeconds !== undefined) decision.crawlDelaySeconds = group.crawlDelaySeconds;
  return decision;
}

/** Errata E11: a changed signal fails the run rather than being logged. */
export function assertContentSignalUnchanged(
  domain: string,
  previous: ContentSignal | null,
  current: ContentSignal | null,
): void {
  if (!previous) return;
  const now = current ?? {};
  const keys = [...new Set([...Object.keys(previous), ...Object.keys(now)])].sort();
  for (const key of keys) {
    if (previous[key] !== now[key]) throw new ContentSignalChangedError(domain, previous, now);
  }
}

/**
 * The project's own position, asserted in code so it cannot drift from `LICENSE-DATA`:
 * we index and we serve as reference, we never train. docs/08 §5.1.
 */
export function signalPermitsThisProject(signal: ContentSignal | null): boolean {
  if (!signal) return true;
  const use = signal['use'];
  const search = signal['search'];
  if (search === 'no' && use === 'no') return false;
  if (signal['ai-input'] === 'no') return false;
  return true;
}
