import { test as setup, expect } from '@playwright/test';
import { E2E_PASSWORD, E2E_USERS } from './accounts.mjs';
import { authFile } from './helpers';

// Signs every test account in once and stores its session (and the English UI) for the other projects;
// signing in per test would run into the password rate limit
for (const user of E2E_USERS) {
  setup(`sign in ${user}`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL });
    const res = await context.request.post('/api/auth/password/login', { data: { username: user, password: E2E_PASSWORD } });
    expect(res.ok()).toBe(true);
    const page = await context.newPage();
    await page.goto('/');
    await page.evaluate(() => localStorage.setItem('kladde_lang', 'en'));
    await context.storageState({ path: authFile(user) });
    await context.close();
  });
}
