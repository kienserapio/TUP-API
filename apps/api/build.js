/**
 * Builds the API into Vercel's Build Output API v3 directory.
 *
 * Why not Vercel's zero-config `api/` convention: it detects functions from the files
 * in the repository, before the build runs. The bundle is generated, so it is
 * gitignored, so a Git-triggered deploy found no functions and served 404 for every
 * route — while a CLI deploy worked, because the CLI happened to upload the file this
 * machine had already built. Build Output API is the supported way to say "my build
 * step produces the functions".
 *
 * Everything is bundled, including npm dependencies. A `.func` directory gets no
 * `node_modules` at runtime, so anything left external would be missing.
 *
 * docs: https://vercel.com/docs/build-output-api/v3
 */
import { build } from 'esbuild';
import { mkdir, writeFile, rm } from 'node:fs/promises';

const OUT = '../../.vercel/output';
const FUNC = `${OUT}/functions/index.func`;

await rm(OUT, { recursive: true, force: true });
await mkdir(FUNC, { recursive: true });

await build({
  entryPoints: ['src/vercel-entry.ts'],
  outfile: `${FUNC}/index.js`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  // pino resolves transport workers by path at runtime. None are configured in
  // production (pino-pretty is a dev dependency), but keep the resolution honest.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});

// The bundle is ESM; without this Node reads the .func directory as CommonJS.
await writeFile(`${FUNC}/package.json`, JSON.stringify({ type: 'module' }, null, 2));

await writeFile(
  `${FUNC}/.vc-config.json`,
  JSON.stringify(
    {
      runtime: 'nodejs22.x',
      handler: 'index.js',
      launcherType: 'Nodejs',
      shouldAddHelpers: true,
    },
    null,
    2,
  ),
);

await writeFile(
  `${OUT}/config.json`,
  JSON.stringify(
    {
      version: 3,
      // One function, every path. The app does its own routing and returns RFC 9457
      // for anything it does not recognise — which is a better 404 than Vercel's.
      routes: [
        {
          src: '/(.*)',
          headers: {
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
          },
          continue: true,
        },
        { handle: 'filesystem' },
        { src: '/(.*)', dest: '/index' },
      ],
    },
    null,
    2,
  ),
);

console.log(`built ${FUNC}`);
