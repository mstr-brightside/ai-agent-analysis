// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['**/dist/**', '**/node_modules/**', 'data/**', 'fixtures/**', 'eslint.config.js'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: true },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { ignoreRestSiblings: true, argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-nested-ternary': 'error',
      'no-restricted-syntax': [
        'error',
        { selector: 'TSEnumDeclaration', message: 'Use a string-literal union instead of an enum.' },
      ],
    },
  },
  {
    // core is pure: no Node APIs and no knowledge of sources, storage or transport.
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'core is pure: no Node APIs.' },
            { group: ['@agentspend/*'], message: 'core depends on nothing else in the repo.' },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/contract/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['node:*', '@agentspend/*'], message: 'contract holds schemas only.' }] },
      ],
    },
  },
  {
    files: ['packages/web-plain/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'web-plain runs in the browser.' },
            {
              group: ['@agentspend/*', '!@agentspend/contract'],
              message: 'web-plain talks to the server over HTTP, through contract only.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      // node:test's describe/it return promises that the runner awaits.
      '@typescript-eslint/no-floating-promises': 'off',
      // assert.* narrows types, so later optional chains look redundant to the linter.
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },
);
