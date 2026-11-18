import { defineConfig } from '@playwright/test';

// End-to-end tests (#62): `npm run build`, then `npm run test:e2e`. The test server (e2e/server.mjs) starts with a fresh
// database and the accounts anna, ben and cara; every run works on its own data directory.
const PORT = Number(process.env.E2E_PORT ?? 3102);
const baseURL = `http://127.0.0.1:${PORT}`;
const CI = !!process.env.CI;

/** Touch devices: no hover, coarse pointer, so the `nav:` layout switch sees them like real phones and tablets */
const touch = { hasTouch: true, isMobile: true };

/** The large-vault benchmark (#64) runs only when asked for: `npm run bench:e2e`. Workers see it through the environment */
const PERF = process.argv.includes('--project=perf') || process.env.KLADDE_PERF === '1';
if (PERF) process.env.KLADDE_PERF = '1';

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  reporter: CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    locale: 'en-US',
    timezoneId: 'Europe/Berlin',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node e2e/server.mjs',
    url: `${baseURL}/health`,
    env: { E2E_PORT: String(PORT) },
    reuseExistingServer: !CI,
    timeout: 60_000,
    stdout: 'ignore',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'desktop',
      dependencies: ['setup'],
      use: { viewport: { width: 1280, height: 800 } },
    },
    {
      // Tablet in portrait: phone-style layout with the bottom bar and its extra destinations
      name: 'tablet',
      dependencies: ['setup'],
      testMatch: /(layout|notes|a11y)\.spec\.ts/,
      use: { viewport: { width: 820, height: 1180 }, ...touch },
    },
    {
      name: 'phone',
      dependencies: ['setup'],
      testMatch: /(layout|notes|a11y)\.spec\.ts/,
      use: { viewport: { width: 390, height: 844 }, ...touch },
    },
    ...(PERF
      ? [
          {
            name: 'perf',
            dependencies: ['setup'],
            testMatch: /\.perf\.ts$/,
            use: { viewport: { width: 1280, height: 800 } },
          },
        ]
      : []),
  ],
});
