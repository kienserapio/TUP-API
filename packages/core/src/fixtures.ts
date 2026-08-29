/**
 * Fixture manifests — the offline substitute for the network.
 *
 * `FETCH_MODE=fixtures` (the local and CI default) resolves every URL through here,
 * which is what makes "local development never touches live TUP sites" enforceable
 * rather than aspirational. docs/15 §1, docs/14 preamble.
 *
 * Manual sources (docs/03 §3.3) use the identical mechanism: `method: 'manual'` reads
 * from disk in every mode, live included, because the page is one a human saved.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash } from './hash.js';

export interface ManifestEntry {
  file: string;
  url: string;
  collected_at: string;
  collected_by: string;
  sha256: string;
  content_type?: string;
  http_status?: number;
  note?: string;
}

export interface ManifestFile {
  files: ManifestEntry[];
}

export interface ResolvedFixture {
  entry: ManifestEntry;
  path: string;
  body: Buffer;
}

export const FIXTURES_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures',
);

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Every MANIFEST.json under fixtures/, recursively. */
export async function manifestPaths(root: string = FIXTURES_ROOT): Promise<string[]> {
  if (!(await exists(root))) return [];
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === 'MANIFEST.json') found.push(full);
    }
  };
  await walk(root);
  return found.sort();
}

export class FixtureIndex {
  private readonly byUrl = new Map<string, { entry: ManifestEntry; dir: string }>();

  private constructor(entries: { entry: ManifestEntry; dir: string }[]) {
    for (const item of entries) this.byUrl.set(normalizeUrl(item.entry.url), item);
  }

  static async load(root: string = FIXTURES_ROOT): Promise<FixtureIndex> {
    const entries: { entry: ManifestEntry; dir: string }[] = [];
    for (const path of await manifestPaths(root)) {
      const manifest = JSON.parse(await readFile(path, 'utf8')) as ManifestFile;
      for (const entry of manifest.files ?? []) entries.push({ entry, dir: dirname(path) });
    }
    return new FixtureIndex(entries);
  }

  has(url: string): boolean {
    return this.byUrl.has(normalizeUrl(url));
  }

  urls(): string[] {
    return [...this.byUrl.keys()];
  }

  /**
   * Verifies the recorded sha256 on every read. A fixture edited to make a test pass
   * is the failure mode docs/14 §3.3 bans; this makes it loud instead of silent.
   */
  async read(url: string): Promise<ResolvedFixture> {
    const item = this.byUrl.get(normalizeUrl(url));
    if (!item) {
      throw new Error(
        `No fixture for ${url}. Capture one with \`pnpm capture --url=${url}\` and commit it ` +
          `with its MANIFEST.json entry — docs/15 §6.`,
      );
    }
    const path = join(item.dir, item.entry.file);
    const body = await readFile(path);
    const actual = contentHash(body);
    if (item.entry.sha256 && item.entry.sha256 !== actual) {
      throw new Error(
        `Fixture ${path} does not match its MANIFEST sha256 ` +
          `(recorded ${item.entry.sha256.slice(0, 12)}…, found ${actual.slice(0, 12)}…). ` +
          `Fixtures are never edited to make a test pass — docs/14 §3.3.`,
      );
    }
    return { entry: item.entry, path, body };
  }
}

/** Trailing slashes and default ports are not identity. Query strings are. */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`;
  } catch {
    return url;
  }
}
