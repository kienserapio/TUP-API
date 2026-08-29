/**
 * Text helpers shared by every adapter.
 *
 * Pure by construction — no clock, no randomness, no environment. Living here rather
 * than being copied per campus means a fix to slug derivation reaches all of them,
 * which matters: an 80-character cap in one copy silently merged five real Manila
 * degrees into one row during the M5 build.
 */

/** Non-breaking spaces (every one of these CMSes emits `&nbsp;` freely) and newlines. */
export function clean(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Deliberately NOT truncated. TUP publishes degrees whose names diverge only after
 * ~90 characters — "…major in Mechanical Engineering Technology option in Foundry
 * Technology" against "…option in Welding Technology". A length cap collapses them
 * into one slug and real degrees disappear without a single test failing.
 */
export function slugify(name: string): string {
  return clean(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Last non-empty path segment of a href, absolute or relative. */
export function lastSegment(href: string): string {
  const path = href.split(/[?#]/)[0] ?? '';
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/**
 * "…major in X", "…: Major in X", "…major in X option in Y" → the whole tail, verbatim.
 * Read from the document; absent means an empty array, never a guess.
 */
export function majorsOf(name: string): string[] {
  const match = /\bmajors?\s+in\s+(.+)$/i.exec(name) ?? /\bwith\s+specializations?\s+in\s+(.+)$/i.exec(name);
  return match?.[1] ? [clean(match[1])] : [];
}

/** "4 years" → 4. "4.5 years" → 4.5. Anything unparseable → null, never a default. */
export function yearsOf(text: string): number | null {
  const match = /(\d+(?:\.\d+)?)\s*year/i.exec(text);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 && value <= 12 ? value : null;
}
