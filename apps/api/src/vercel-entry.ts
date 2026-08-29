/**
 * The Vercel serverless entry.
 *
 * Vercel's Node runtime hands a function `(IncomingMessage, ServerResponse)` — the same
 * signature `http.createServer` takes — so the adapter is `getRequestListener`, which
 * bridges Node's request objects to the Web `Request`/`Response` Hono works in.
 *
 * NOT `handle` from `hono/vercel`: that is the Edge adapter and expects a Web `Request`
 * already. Given Node objects it fails with `this.raw.headers.get is not a function`.
 * Edge is not an option here anyway — `postgres` needs a TCP socket, which the Edge
 * runtime does not have.
 *
 * `server.ts` remains the long-lived Node entry for `pnpm dev` and for any host that
 * runs a real process, so the deployment target stays a config choice, not a rewrite.
 *
 * This file is bundled by `build.js` rather than compiled in place: the workspace
 * packages export TypeScript source (`@tup/schemas` resolves to `src/index.ts`), which
 * is what `tsx` wants locally and what Node cannot load at runtime.
 */
import { getRequestListener } from '@hono/node-server';
import { app } from './app.js';

export default getRequestListener(app.fetch);
