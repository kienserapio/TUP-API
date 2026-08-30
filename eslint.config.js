import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.json',
      'fixtures/**',
      'docs/**',
      // Vercel build output; generated, never authored.
      '.vercel/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'warn',
      'no-console': 'off',
    },
  },
  {
    // Plain .js/.mjs here are Node scripts — the esbuild build and the post-deploy
    // smoke tests. TypeScript files get these globals from @types/node; these do not,
    // so declare them rather than turning the rule off and losing real typos.
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
  {
    // ADR-005: `parse` is a pure function. Adapters must not reach the network or the
    // clock — fixture determinism depends on it, and the golden tests are the single
    // highest-value test category in this repo. docs/14 §3.4
    files: ['packages/adapters/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Adapters must not fetch. Fetching is centralised (ADR-005).' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'Date.now() breaks parse purity. The pipeline assigns timestamps (docs/14 §3.4).',
        },
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message: 'Math.random() breaks fixture determinism (docs/14 §3.4).',
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'new Date() breaks parse purity. Timestamps come from the pipeline.',
        },
      ],
    },
  },
);
