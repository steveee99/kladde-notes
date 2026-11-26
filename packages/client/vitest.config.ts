import { defineConfig } from 'vitest/config';

// Own config without the app's Vite plugins (PWA, fonts, bundle report): tests only need TypeScript and JSX.
// Tests run in Node by default; files that need a DOM say so with `// @vitest-environment jsdom`.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary', 'html', 'json-summary'],
    },
  },
});
