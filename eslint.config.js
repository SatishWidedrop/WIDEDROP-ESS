import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      'design/prototype/**',
      'apps/api/src/generated/**',
      'apps/api/prisma/migrations/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2023 },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // Security-relevant bans.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-globals': ['error', { name: 'eval', message: 'eval is forbidden.' }],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.es2023 },
    },
    rules: {
      // XSS: server-supplied rich text is sanitised then rendered through the
      // dedicated RichText component, which is the only permitted exception.
      'no-restricted-properties': [
        'error',
        {
          object: 'window',
          property: 'localStorage',
          message: 'Never persist auth state in localStorage — see docs/SECURITY.md.',
        },
      ],
    },
  },
  {
    // Tests, seeds and CLI scripts: console output is the point of the last two,
    // and the globs are anchored with ** because flat-config patterns resolve
    // against the config file rather than each workspace.
    files: [
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/test/**',
      '**/prisma/**',
      '**/scripts/**',
      '**/*.config.ts',
    ],
    rules: { 'no-console': 'off' },
  },
  prettier,
);
