import { defineConfig } from 'vitest/config';

/**
 * Four projects, matching docs/14-testing-strategy.md §2.
 *
 * unit         fast, no database
 * fixtures     golden parse tests — half of all test effort (docs/14 §2)
 * integration  real local Postgres — enum ordering and index behaviour are Postgres
 *              behaviours; a mock would assert nothing
 * contract     responses validated against the published openapi.json
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'fixtures',
          include: ['test/fixtures/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          hookTimeout: 30_000,
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'contract',
          include: ['test/contract/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
        },
      },
    ],
  },
});
