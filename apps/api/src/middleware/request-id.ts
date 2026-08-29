import { randomUUID } from 'node:crypto';
import { createMiddleware } from 'hono/factory';

/**
 * Every response carries X-Request-Id, echoed into logs and Sentry. A consumer
 * reporting a problem quotes it and the whole request is reconstructible.
 * docs/13-api-design-standards.md §13.
 */
export const requestId = createMiddleware<{ Variables: { requestId: string } }>(
  async (c, next) => {
    const id = c.req.header('x-request-id') ?? randomUUID();
    c.set('requestId', id);
    c.header('X-Request-Id', id);
    await next();
  },
);
