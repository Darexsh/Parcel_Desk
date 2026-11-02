import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import browserImports from './scripts/eslint-browser-imports.mjs';

const unsafe = ['assignment', 'member-access', 'call', 'return', 'argument'].map(name => `@typescript-eslint/no-unsafe-${name}`);

export default defineConfig(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'generated/**', '.private/**'] },
  { files: ['**/*.ts', '**/*.mjs'], extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      'no-restricted-imports': ['error', { paths: ['server-only', 'next', 'react'], patterns: ['@/*', '@carriers/*', '**/delivery-tracker/**'] }],
      // A comment between two labels that share one outcome is not a fallthrough.
      'no-fallthrough': ['error', { allowEmptyCase: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // An abort reason is the caller's own value, passed on as it is.
      '@typescript-eslint/prefer-promise-reject-errors': ['error', { allowThrowingAny: true, allowThrowingUnknown: true }],
    } },
  // Luxon reads a wall time the clocks repeat by the season the code runs in.
  { files: ['**/*.ts'], ignores: ['**/*.test.ts', 'core/time/**'], rules: {
    'no-restricted-syntax': ['error', {
      selector: "CallExpression[callee.object.name='DateTime'][callee.property.name=/^from(ISO|Format|Object|SQL|RFC2822|HTTP)$/]"
        + ":has(ObjectExpression > Property[key.name='zone']:not([value.value=/^(UTC|utc)$/]))"
        + ":not(CallExpression[callee.name='firstOccurrence'] > CallExpression)"
        // Reading the possible offsets is how a parser declines the repeated hour.
        + ":not(MemberExpression[property.name='getPossibleOffsets'] > CallExpression)",
      message: 'Pass a wall clock read in a zone through firstOccurrence() from core/time.',
    }],
  } },
  // The transport index brings Playwright and sharp; the modules a browser entry point loads take its text helpers from text.js.
  { files: ['**/*.ts'], ignores: ['**/*.test.ts'], plugins: { local: { rules: { 'browser-imports': browserImports } } }, rules: {
    'local/browser-imports': ['error', { root: import.meta.dirname, entries: ['index.ts', 'app.ts'], module: 'core/transport/index.ts', instead: 'core/transport/text.js' }],
  } },
  // Scripts are outside the TypeScript project: syntax rules only.
  { files: ['**/*.mjs'], extends: [tseslint.configs.disableTypeChecked], languageOptions: { globals: globals.node } },
  { files: ['trawl/**/*.mjs'], languageOptions: { globals: globals.browser } },
  // Tests read fixtures, captured requests and mocks as loose JSON.
  { files: ['**/*.test.ts'], rules: {
    ...Object.fromEntries(unsafe.map(rule => [rule, 'off'])),
    '@typescript-eslint/no-base-to-string': 'off',
    '@typescript-eslint/require-await': 'off',
    '@typescript-eslint/unbound-method': 'off',
  } },
);
