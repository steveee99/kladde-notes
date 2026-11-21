import { test, expect } from '@playwright/test';
import { E2E_PASSWORD } from './accounts.mjs';

test.describe('sign-in', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('signs in with username and password', async ({ page }) => {
    await page.goto('/');
    // A fresh browser starts in German; the language switch sits on the sign-in page
    await page.getByRole('group', { name: 'Sprache' }).getByRole('button', { name: 'en' }).click();
    await page.getByRole('button', { name: /username and password/i }).click();
    await page.getByPlaceholder('Username').fill('cara');
    await page.getByPlaceholder('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in with password' }).click();
    await expect(page.getByText(/stimmt nicht/)).toBeVisible();

    await page.getByPlaceholder('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign in with password' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/); // Home is titled with today's date
    const me = await page.request.get('/api/auth/me');
    expect((await me.json()).username).toBe('cara');
  });

  test('keeps signed-out visitors out of the API', async ({ request }) => {
    expect((await request.get('/api/sync')).status()).toBe(401);
  });
});
