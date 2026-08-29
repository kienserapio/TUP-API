/**
 * Vercel entry point.
 *
 * Vercel's Hono preset looks for a default-exported app at `src/index.ts` and wraps it
 * in a serverless function itself — there is no `serve()` call and no port. `server.ts`
 * stays as the long-lived Node entry for `pnpm dev` and for any host that runs a real
 * process (Fly, a VPS, Coolify), so the deployment target is a config choice rather
 * than a rewrite.
 *
 * The one thing serverless changes that matters: every request may land on a fresh
 * instance, so the database connection must go through Supabase's **transaction**
 * pooler with prepared statements off. See `lib/db.ts` and errata E19.
 */
import { app } from './app.js';

export default app;
