import type { Page } from '@playwright/test';
import { test, expect, noteTitle } from './helpers';

// Weekly and monthly notes (#73), in ben's space (opt-in features, turned off again at the end)

async function setFeature(page: Page, id: 'weekly' | 'monthly', on: boolean) {
  await page.goto('/settings');
  await page.locator('[data-open-features]').click();
  const dialog = page.locator('[data-features-dialog]');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('tab', { name: on ? /Available features/ : /Active features/ }).click();
  if (on) await dialog.locator(`[data-activate="${id}"]`).click();
  else {
    await dialog.locator(`[data-feature="${id}"] button`).first().click();
    await dialog.locator(`[data-deactivate="${id}"]`).click();
  }
  const detail = dialog.locator(`[data-feature-detail="${id}"]`);
  // A feature with settings opens on them once it is on
  if (on) await expect(detail.getByText('Naming pattern (subfolders & filename)')).toBeVisible();
  else await expect(detail.getByText('Off', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
}

test('weekly and monthly notes with navigation, templates and links from the daily note', async ({ openAs }) => {
  const page = await openAs('ben');
  await setFeature(page, 'weekly', true);
  await setFeature(page, 'monthly', true);
  try {
    // Ctrl/⌘+Alt+W creates this week's note from the default template
    await page.goto('/');
    await page.keyboard.press('ControlOrMeta+Alt+KeyW');
    await expect(noteTitle(page)).toHaveValue(/^\d{4}-W\d{2}$/, { timeout: 15_000 });
    const week = await noteTitle(page).inputValue();
    const bar = page.locator('[data-periodic-bar="week"]');
    await expect(bar).toBeVisible();
    await expect(page.locator('.cm-content')).toContainText('Days');
    // {{days}}: seven links to the daily notes
    await expect(page.locator('.cm-content .cm-wikilink')).toHaveCount(7);

    // The next week has no note yet: its page offers to create it
    await bar.getByRole('button', { name: /^Next week/ }).click();
    await expect(page).toHaveURL(/\/week\/\d{4}-\d{2}-\d{2}$/);
    await page.getByRole('button', { name: 'Create weekly note' }).click();
    await expect(noteTitle(page)).not.toHaveValue(week);
    await page.locator('[data-periodic-bar="week"]').getByRole('button', { name: /^Previous week/ }).click();
    await expect(noteTitle(page)).toHaveValue(week);

    // From the week to its month
    await bar.locator('[data-period-link="month"]').click();
    await expect(page).toHaveURL(/\/month\/\d{4}-\d{2}-01$/);
    await page.getByRole('button', { name: 'Create monthly note' }).click();
    await expect(noteTitle(page)).toHaveValue(/^\d{4}-\d{2}$/);
    await expect(page.locator('[data-periodic-bar="month"]')).toBeVisible();
    await expect(page.locator('.cm-content')).toContainText('Weeks');

    // The daily note links to its week
    await page.keyboard.press('ControlOrMeta+Shift+KeyD');
    await expect(page.locator('[data-period-link="week"]')).toBeVisible({ timeout: 15_000 });
    await page.locator('[data-period-link="week"]').click();
    await expect(noteTitle(page)).toHaveValue(week);

    // The weekly template can be edited under Settings → Templates
    await page.goto('/settings/templates');
    await expect(page.locator('[data-template-period="week"]')).toBeVisible();
    await expect(page.locator('[data-template-period="month"]')).toBeVisible();
  } finally {
    await setFeature(page, 'weekly', false);
    await setFeature(page, 'monthly', false);
  }
});
