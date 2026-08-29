/**
 * Vercel entry point.
 *
 * Vercel's Hono preset wraps a default-exported app in a serverless function itself —
 * there is no `serve()` call and no port here. `server.ts` stays as the long-lived Node
 * entry for `pnpm dev` and for any host that runs a real process (a VPS, Coolify, Fly),
 * so the deployment target is a config choice rather than a rewrite.
 *
 * The one thing serverless changes that matters: every request may land on a fresh
 * instance, so the database connection goes through Supabase's **transaction** pooler
 * with prepared statements off. See `lib/db.ts` and errata E19.
 */
import { Hono } from 'hono';
import { app } from './app.js';

// `OpenAPIHono` extends `Hono`. Asserting it does two jobs: it is the direct `hono`
// import Vercel's framework detector scans for, and it fails the build loudly if `app`
// ever stops being a Hono instance — which would otherwise deploy as a silent 404.
if (!(app instanceof Hono)) {
  throw new Error('apps/api/src/app.ts must export a Hono application.');
}

export default app;
