/**
 * Bundles the API into a single Vercel serverless function.
 *
 * Inlined: the workspace packages (`@tup/db`, `@tup/schemas`), because they export
 * TypeScript source that Node cannot load.
 *
 * External: everything published to npm. They exist in `node_modules` at runtime, and
 * bundling them would only make the function bigger and the stack traces worse —
 * `postgres` and `pino` in particular do things at runtime that bundlers get wrong.
 */
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));

const external = Object.keys(pkg.dependencies ?? {}).filter((name) => !name.startsWith('@tup/'));

await build({
  entryPoints: ['src/vercel-entry.ts'],
  outfile: 'api/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  // Keep the workspace packages in, keep npm packages out.
  external,
  logLevel: 'info',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
