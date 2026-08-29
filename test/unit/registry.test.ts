/**
 * The canonical program registry matching chain — docs/14 §6 names it explicitly:
 * "name variant in, slug out, and unmatched names surface rather than silently
 * dropping". The last clause is the one that matters (ADR-003).
 */
import { describe, expect, test } from 'vitest';
import {
  matchProgramName,
  normalizeProgramName,
  slugifyProgramName,
  TRIGRAM_THRESHOLD,
} from '@tup/core';

const REGISTRY = [
  {
    slug: 'bsce',
    name: 'Bachelor of Science in Civil Engineering',
    aliases: ['BSCE', 'BS Civil Engineering', 'Civil Engineering'],
  },
  {
    slug: 'bscpe',
    name: 'Bachelor of Science in Computer Engineering',
    aliases: ['BSCpE', 'BSCOE', 'BS Computer Engineering', 'Computer Engineering'],
  },
  { slug: 'bet', name: 'Bachelor of Engineering Technology', aliases: ['BET'] },
];

describe('step 1 — exact alias', () => {
  test('matches the canonical name', () => {
    const result = matchProgramName('Bachelor of Science in Civil Engineering', REGISTRY);
    expect(result).toMatchObject({ slug: 'bsce', method: 'exact' });
  });

  test('matches a declared alias', () => {
    expect(matchProgramName('BS Civil Engineering', REGISTRY).slug).toBe('bsce');
  });

  test('matches the slug itself', () => {
    expect(matchProgramName('bsce', REGISTRY).slug).toBe('bsce');
  });
});

describe('step 2 — normalized alias', () => {
  test('is case- and punctuation-insensitive', () => {
    const result = matchProgramName('bachelor of science in civil-engineering', REGISTRY);
    expect(result).toMatchObject({ slug: 'bsce', method: 'normalized' });
  });

  test('normalizes whitespace and punctuation but nothing cleverer', () => {
    expect(normalizeProgramName('  B.S.  Civil   Engineering! ')).toBe('b s civil engineering');
  });

  test('does not fold BSCE and BSCpE into each other', () => {
    // A stemmer would. The registry deliberately does not use one.
    expect(matchProgramName('BSCpE', REGISTRY).slug).toBe('bscpe');
    expect(matchProgramName('BSCE', REGISTRY).slug).toBe('bsce');
  });
});

describe('step 4 — unmatched, never auto-created (ADR-003)', () => {
  test('a genuinely new degree surfaces rather than inventing a canonical program', () => {
    const result = matchProgramName(
      'Master of Science in Electrical Engineering major in Power System Engineering',
      REGISTRY,
    );
    expect(result.slug).toBeNull();
    expect(result.method).toBe('unmatched');
  });

  test('a near-miss is left to the trigram step, not fudged here', () => {
    // "Bachelor of Engineering Technology major in Railway Technology" is not BET.
    // Deciding that is a Postgres similarity() call, and if that also misses it is a
    // human's decision in seeds/programs.yaml.
    const result = matchProgramName(
      'Bachelor of Engineering Technology major in Railway Technology',
      REGISTRY,
    );
    expect(result.slug).toBeNull();
  });

  test('the trigram threshold is the documented 0.85', () => {
    expect(TRIGRAM_THRESHOLD).toBe(0.85);
  });
});

describe('slugs for unmatched offerings', () => {
  test('are URL-safe', () => {
    expect(slugifyProgramName('Master of Science in Civil Engineering major in Structural')).toBe(
      'master-of-science-in-civil-engineering-major-in-structural',
    );
  });

  test('are NOT truncated — Manila has degrees that differ only after 90 characters', () => {
    const foundry = slugifyProgramName(
      'Bachelor of Engineering Technology major in Mechanical Engineering Technology option in Foundry Technology',
    );
    const welding = slugifyProgramName(
      'Bachelor of Engineering Technology major in Mechanical Engineering Technology option in Welding Technology',
    );
    expect(foundry).not.toBe(welding);
  });
});
