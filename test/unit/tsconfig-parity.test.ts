/**
 * `apps/api/tsconfig.json` is self-contained rather than extending the workspace base,
 * because Vercel's build does not resolve the `extends` and silently compiled the API
 * without `strict` — which failed the deploy on type errors that cannot happen locally.
 *
 * A duplicated config is a config that drifts. This test is the thing that stops it:
 * loosen a setting in the base and the copy has to move with it, deliberately.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** tsconfig files are JSONC — strip comments before parsing. */
async function readTsconfig(path: string): Promise<{ compilerOptions: Record<string, unknown> }> {
  const raw = await readFile(resolve(root, path), 'utf8');
  const stripped = raw
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
  return JSON.parse(stripped) as { compilerOptions: Record<string, unknown> };
}

describe('tsconfig parity', () => {
  test('the API compiles under exactly the workspace compiler options', async () => {
    const base = await readTsconfig('tsconfig.base.json');
    const api = await readTsconfig('apps/api/tsconfig.json');
    expect(api.compilerOptions).toEqual(base.compilerOptions);
  });

  test('and strict mode is on in both, which is the setting that actually bit', async () => {
    for (const path of ['tsconfig.base.json', 'apps/api/tsconfig.json']) {
      const config = await readTsconfig(path);
      expect(config.compilerOptions['strict'], path).toBe(true);
      expect(config.compilerOptions['noUncheckedIndexedAccess'], path).toBe(true);
    }
  });
});
