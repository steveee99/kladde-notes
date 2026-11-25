import { test, expect } from './helpers';

// Administration: sections in the side panel and the dashboard (anna is the first account and so the admin)

test('the administration lists its sections in the side panel and opens with the dashboard', async ({ page }) => {
  await page.goto('/settings/admin');
  const nav = page.locator('[data-admin-nav]');
  await expect(nav).toBeVisible();
  // The dashboard is the first section: tiles with counts, the machine and the recent jobs
  await expect(nav.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
  const overview = page.locator('[data-admin-overview]');
  await expect(overview).toBeVisible();
  for (const tile of ['notes', 'databases', 'users', 'groups', 'cpu', 'memory', 'disk', 'online', 'jobs']) await expect(overview.locator(`[data-admin-tile="${tile}"]`)).toBeVisible();
  // This browser is connected, so anna is online
  await expect(overview.locator('[data-admin-tile="online"]')).toContainText('anna');

  // Sections have their own address
  await nav.getByRole('link', { name: 'Invites' }).click();
  await expect(page).toHaveURL(/\/settings\/admin\/invites$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Invites' })).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-admin-section="invites"]')).toBeVisible();

  // And a way back to the settings
  await page.locator('[data-admin-back]').click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.locator('[data-admin-nav]')).toHaveCount(0);
});
