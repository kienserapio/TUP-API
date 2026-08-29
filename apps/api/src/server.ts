import { serve } from '@hono/node-server';
import { app } from './app.js';
import { logger } from './lib/logger.js';

const port = Number(process.env['PORT'] ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port }, 'TUP Open Data API listening');
  console.log(`  http://localhost:${info.port}/v1/campuses`);
  console.log(`  http://localhost:${info.port}/openapi.json`);
});
