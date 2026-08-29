/**
 * robots.txt evaluation, including the Visayas Content-Signal case that docs/14 §6
 * names explicitly. The Visayas file is the most consequential thing in the source
 * landscape (docs/08 §5.1): it is Cloudflare-managed, it names nine AI crawlers, and
 * it declares an express reservation of rights — and it still permits this project.
 */
import { describe, expect, test } from 'vitest';
import {
  assertContentSignalUnchanged,
  ContentSignalChangedError,
  evaluateRobots,
  looksLikeHtml,
  parseContentSignal,
  parseRobots,
  robotsAbsent,
  signalPermitsThisProject,
} from '@tup/core';

const UA = 'tupopendatabot';

/** Verbatim from docs/08 §5.1, verified 2026-08-20. */
const VISAYAS_ROBOTS = `User-agent: *
Content-Signal: search=yes,ai-train=no,use=reference
Allow: /

User-agent: Amazonbot
Disallow: /

User-agent: Applebot-Extended
Disallow: /

User-agent: Bytespider
Disallow: /

User-agent: CCBot
Disallow: /

User-agent: ClaudeBot
Disallow: /

User-agent: CloudflareBrowserRenderingCrawler
Disallow: /

User-agent: Google-Extended
Disallow: /

User-agent: GPTBot
Disallow: /

User-agent: meta-externalagent
Disallow: /

User-agent: *
Disallow:
`;

describe('Visayas robots.txt [E11]', () => {
  const robots = parseRobots(VISAYAS_ROBOTS);

  test('permits this project — TUPOpenDataBot is not named and * is Allow: /', () => {
    const decision = evaluateRobots(robots, UA, 'https://tupvisayas.edu.ph/officials');
    expect(decision.allowed).toBe(true);
  });

  test('still blocks the crawlers it names', () => {
    for (const bot of ['gptbot', 'ccbot', 'claudebot', 'meta-externalagent']) {
      const decision = evaluateRobots(robots, bot, 'https://tupvisayas.edu.ph/officials');
      expect(decision.allowed, `${bot} should be disallowed`).toBe(false);
    }
  });

  test('parses the Content-Signal into its four fields', () => {
    expect(robots.contentSignal).toEqual({
      search: 'yes',
      'ai-train': 'no',
      use: 'reference',
    });
  });

  test('the signal permits what this project does — index and reference, never train', () => {
    expect(signalPermitsThisProject(robots.contentSignal)).toBe(true);
  });

  test('a silently-appearing ai-input=no would not permit it', () => {
    expect(signalPermitsThisProject({ ...robots.contentSignal, 'ai-input': 'no' })).toBe(false);
  });

  test('merges both `User-agent: *` groups rather than letting the second win', () => {
    // The file declares `*` twice: `Allow: /` at the top and an empty `Disallow:` at
    // the bottom. Both are in force; neither restricts anything.
    const decision = evaluateRobots(robots, UA, 'https://tupvisayas.edu.ph/academics');
    expect(decision.allowed).toBe(true);
    expect(decision.matchedAgent).toBe('*');
  });
});

describe('a changed Content-Signal stops the run [E11]', () => {
  test('an unchanged signal passes', () => {
    const signal = { search: 'yes', 'ai-train': 'no', use: 'reference' };
    expect(() =>
      assertContentSignalUnchanged('tupvisayas.edu.ph', signal, { ...signal }),
    ).not.toThrow();
  });

  test('a new restriction throws rather than being logged', () => {
    expect(() =>
      assertContentSignalUnchanged(
        'tupvisayas.edu.ph',
        { search: 'yes', 'ai-train': 'no', use: 'reference' },
        { search: 'yes', 'ai-train': 'no', use: 'reference', 'ai-input': 'no' },
      ),
    ).toThrow(ContentSignalChangedError);
  });

  test('no stored signal is not a change — the first observation is a baseline', () => {
    expect(() => assertContentSignalUnchanged('tup.edu.ph', null, { search: 'yes' })).not.toThrow();
  });
});

describe('absent robots.txt [E12]', () => {
  test('allows everything, per RFC 9309', () => {
    const decision = evaluateRobots(robotsAbsent(), UA, 'https://tup.edu.ph/pages/anything');
    expect(decision.allowed).toBe(true);
  });

  test('records absence as a distinct fact from permission', () => {
    // "allowed by robots.txt" and "allowed because there is no robots.txt" differ.
    // The 24h cache TTL exists because the second can become the first overnight.
    expect(robotsAbsent().present).toBe(false);
    expect(parseRobots('User-agent: *\nAllow: /').present).toBe(true);
  });

  test('a 200 whose body is HTML is a 404 page in disguise', () => {
    expect(looksLikeHtml('<!DOCTYPE html><html>...')).toBe(true);
    expect(looksLikeHtml('\n  <html lang="en">')).toBe(true);
    expect(looksLikeHtml('User-agent: *\nDisallow: /admin')).toBe(false);
  });
});

describe('rule matching, RFC 9309 §2.2.2', () => {
  const robots = parseRobots(`User-agent: *
Disallow: /pages/
Allow: /pages/admission/
Disallow: /registrar/services/
Disallow: /*.pdf$
Crawl-delay: 5
`);

  test('longest match wins', () => {
    expect(evaluateRobots(robots, UA, 'https://tup.edu.ph/pages/students/x').allowed).toBe(false);
    expect(evaluateRobots(robots, UA, 'https://tup.edu.ph/pages/admission/y').allowed).toBe(true);
  });

  test('honours the `$` end anchor', () => {
    expect(evaluateRobots(robots, UA, 'https://tup.edu.ph/files/handbook.pdf').allowed).toBe(false);
    expect(evaluateRobots(robots, UA, 'https://tup.edu.ph/files/handbook.pdf.html').allowed).toBe(
      true,
    );
  });

  test('reports crawl-delay so the fetcher can widen its own floor', () => {
    expect(evaluateRobots(robots, UA, 'https://tup.edu.ph/').crawlDelaySeconds).toBe(5);
  });

  test('an unlisted path is allowed', () => {
    expect(evaluateRobots(robots, UA, 'https://tup.edu.ph/page/academics').allowed).toBe(true);
  });

  test('an empty Disallow imposes no restriction', () => {
    const permissive = parseRobots('User-agent: *\nDisallow:\n');
    expect(evaluateRobots(permissive, UA, 'https://tup.edu.ph/anything').allowed).toBe(true);
  });

  test('comments and blank lines are ignored', () => {
    const withComments = parseRobots('# hello\nUser-agent: *   # everyone\nDisallow: /secret\n');
    expect(evaluateRobots(withComments, UA, 'https://tup.edu.ph/secret/x').allowed).toBe(false);
  });
});

describe('parseContentSignal', () => {
  test('lowercases keys and values and tolerates spacing', () => {
    expect(parseContentSignal(' Search=Yes , AI-Train=No ')).toEqual({
      search: 'yes',
      'ai-train': 'no',
    });
  });
});
