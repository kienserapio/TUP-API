import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Walk up to the workspace root and load env files. `.env.local` wins over `.env`
// because dotenv never overwrites an already-set variable — so a developer can keep
// deployment credentials in `.env` while every local command targets Docker.
// docs/15-local-development.md §3
let dir = process.cwd();
for (let i = 0; i < 5; i++) {
  if (existsSync(resolve(dir, '.env')) || existsSync(resolve(dir, '.env.local'))) {
    for (const file of ['.env.local', '.env']) {
      const candidate = resolve(dir, file);
      if (existsSync(candidate)) config({ path: candidate, quiet: true });
    }
    break;
  }
  dir = resolve(dir, '..');
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env — see docs/15-local-development.md §3`,
    );
  }
  return value;
}

/**
 * Two connection strings, never swapped — docs/15 §3.1, errata E19.
 *
 * DATABASE_URL         session pooler / direct. Long-lived API process. Prepared statements fine.
 * DATABASE_URL_POOLED  transaction pooler. Ephemeral CI runners. REQUIRES prepare: false,
 *                      because Supavisor in transaction mode does not support prepared statements.
 */
export const env = {
  get databaseUrl(): string {
    return required('DATABASE_URL');
  },
  get pooledDatabaseUrl(): string {
    return process.env['DATABASE_URL_POOLED'] ?? required('DATABASE_URL');
  },
  get nodeEnv(): string {
    return process.env['NODE_ENV'] ?? 'development';
  },
  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  },
};
