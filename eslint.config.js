import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/dist-demo/**', '**/build/**', '**/node_modules/**', '**/coverage/**', '.claude/**', 'vendor/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['packages/client/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'off' },
  },
  {
    // Code that runs in the browser must also work on plain HTTP, where `crypto.randomUUID` does not exist
    files: ['packages/client/src/**/*.{ts,tsx}', 'packages/shared/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "MemberExpression[property.name='randomUUID']", message: 'randomUUID is missing on plain HTTP: use newUuid (client/lib/uuid.ts).' },
      ],
    },
  },
  {
    // Plugins (docs/PLUGINS.md) talk to Kladde only through @kladde/plugin-api: Kladde's own packages may change in any release
    files: ['examples/**/*.{ts,tsx}'],
    ignores: ['examples/**/tests/**'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@kladde/shared', '@kladde/shared/*', '@kladde/server', '@kladde/server/*', '@kladde/client', '@kladde/client/*'], message: 'Plugins use only @kladde/plugin-api.' },
            { group: ['**/packages/**'], message: 'Plugins use only @kladde/plugin-api.' },
          ],
        },
      ],
    },
  },
  {
    files: ['**/tests/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    rules: {
      // Intentional: stripping control characters from file names, German typography
      'no-control-regex': 'off',
      'no-useless-escape': 'off',
      'prefer-const': 'off',
      'no-irregular-whitespace': ['error', { skipRegExps: true, skipStrings: true, skipTemplates: true, skipComments: true }],
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
