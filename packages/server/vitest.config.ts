import { defineConfig } from 'vitest/config';

// The tests are fast (milliseconds) but run on shared CI machines: a busy host
// once stalled a synchronous test past the 5 s default.
// The timeout only guards against hangs, so give it room instead of failing the build.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // `npm run test:coverage`: v8 coverage of the sources, reports in ./coverage (git-ignored)
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary', 'html', 'json-summary'],
    },
  },
});
