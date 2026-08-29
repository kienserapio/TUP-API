import { pino } from 'pino';

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  base: undefined,
  // Log at stage boundaries with counts, never per record.
  // docs/05-deployment-and-operations.md §5.1
});
