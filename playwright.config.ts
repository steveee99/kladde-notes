import { defineConfig } from '@playwright/test';

// End-to-end tests (#62): `npm run build`, then `npm run test:e2e`. The test server (e2e/server.mjs) starts with a fresh
// database and the accounts anna, ben and cara; every run works on its own data directory.
/** Tests compute dates in Node and compare them with the browser: both, and the test servers, use one time zone */
const TIME_ZONE = 'Europe/Berlin';
process.env.TZ = TIME_ZONE;

const PORT = Number(process.env.E2E_PORT ?? 3102);
const baseURL = `http://127.0.0.1:${PORT}`;
/** A second test server in online mode (`KLADDE_MODE=online`) for `e2e/online.spec.ts` and `BENCH_ONLINE=1` */
const ONLINE_PORT = PORT + 1;
const onlineURL = `http://127.0.0.1:${ONLINE_PORT}`;
const BENCH_ONLINE = process.env.BENCH_ONLINE === '1';
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
    // The large-vault benchmark in online mode signs in and measures on the online server
    baseURL: BENCH_ONLINE ? onlineURL : baseURL,
    locale: 'en-US',
    timezoneId: TIME_ZONE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'node e2e/server.mjs',
      url: `${baseURL}/health`,
      env: { E2E_PORT: String(PORT), KLADDE_MODE: 'offline' },
      reuseExistingServer: !CI,
      timeout: 60_000,
      stdout: 'ignore',
    },
    {
      command: 'node e2e/server.mjs',
      url: `${onlineURL}/health`,
      env: { E2E_PORT: String(ONLINE_PORT), KLADDE_MODE: 'online' },
      reuseExistingServer: !CI,
      timeout: 60_000,
      stdout: 'ignore',
    },
  ],
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'desktop',
      dependencies: ['setup'],
      testIgnore: /online\.spec\.ts/,
      use: { viewport: { width: 1280, height: 800 } },
    },
    {
      // Online mode: its own server, the test signs in there itself; new contexts still read the stored session of `setup`
      name: 'online',
      dependencies: ['setup'],
      testMatch: /online\.spec\.ts/,
      use: { viewport: { width: 1280, height: 800 }, baseURL: onlineURL },
    },
    {
      // Tablet in portrait: phone-style layout with the bottom bar and its extra destinations
      name: 'tablet',
      dependencies: ['setup'],
      testMatch: /(layout|notes|a11y|drawing)\.spec\.ts/,
      use: { viewport: { width: 820, height: 1180 }, ...touch },
    },
    {
      name: 'phone',
      dependencies: ['setup'],
      testMatch: /(layout|notes|a11y|drawing)\.spec\.ts/,
      use: { viewport: { width: 390, height: 844 }, ...touch },
    },
    ...(PERF
      ? [
          {
            name: 'perf',
            dependencies: ['setup'],
            testMatch: /\.perf\.ts$/,
            // No trace: its DOM snapshots after every action would be part of the measured times
            use: { viewport: { width: 1280, height: 800 }, trace: 'off' as const, screenshot: 'off' as const },
          },
        ]
      : []),
  ],
});
