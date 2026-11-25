import { test, expect } from './helpers';

// Settings → Features: a dialog like a plugin manager with "available" and "active" features (cara's space, so the
// database test that turns the feature on for anna is not affected)

test('the features dialog lists available and active features and switches them', async ({ openAs }) => {
  const page = await openAs('cara');
  await page.goto('/settings');
  await page.locator('[data-open-features]').click();
  const dialog = page.getByRole('dialog', { name: 'Features' });
  await expect(dialog).toBeVisible();

  // PARA and Zettelkasten are the standard features of a new space
  await dialog.getByRole('tab', { name: /Active features/ }).click();
  await expect(dialog.locator('[data-feature="para"]')).toBeVisible();
  await expect(dialog.locator('[data-feature="zettel"]')).toBeVisible();

  // Folder databases are off: the folder offers no "Make database"
  await dialog.getByRole('tab', { name: /Available features/ }).click();
  const database = dialog.locator('[data-feature="database"]');
  await expect(database).toBeVisible();
  const folder = `Features ${Math.random().toString(36).slice(2, 8)}`;
  await page.keyboard.press('Escape');
  await page.request.post('/api/sync', {
    data: { changes: [{ id: [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join(''), baseVersion: 0, path: `${folder}/Note.md`, content: 'Note', deleted: false, createdAt: Date.now(), updatedAt: Date.now() }] },
  });
  await page.goto(`/f/${encodeURIComponent(folder)}`);
  await expect(page.getByRole('heading', { name: folder })).toBeVisible({ timeout: 15_000 });
  await page.locator('[data-item-menu="folder"]').click();
  await expect(page.locator('[data-make-database]')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Activating moves it to the active ones and opens it; the button appears
  await page.goto('/settings');
  await page.locator('[data-open-features]').click();
  const available = await dialog.getByRole('tab', { name: /Available features/ }).textContent();
  await dialog.locator('[data-activate="database"]').click();
  const detail = dialog.locator('[data-feature-detail="database"]');
  await expect(detail).toBeVisible();
  await expect(detail.getByText('On', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'All features' }).click();
  await expect(dialog.getByRole('tab', { name: /Available features/ })).not.toHaveText(available!);
  await page.keyboard.press('Escape');
  await page.goto(`/f/${encodeURIComponent(folder)}`);
  await page.locator('[data-item-menu="folder"]').click();
  await expect(page.locator('[data-make-database]')).toBeVisible();
  await page.keyboard.press('Escape');

  // Deactivating hides it again
  await page.goto('/settings');
  await page.locator('[data-open-features]').click();
  await dialog.getByRole('tab', { name: /Active features/ }).click();
  await dialog.locator('[data-feature="database"] button').first().click();
  await dialog.locator('[data-deactivate="database"]').click();
  await expect(detail.getByText('Off', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto(`/f/${encodeURIComponent(folder)}`);
  await expect(page.getByRole('heading', { name: folder })).toBeVisible();
  await page.locator('[data-item-menu="folder"]').click();
  await expect(page.locator('[data-make-database]')).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('a feature with settings shows them on a second tab while it is active', async ({ openAs }) => {
  const page = await openAs('cara');
  await page.goto('/settings');
  await page.locator('[data-open-features]').click();
  const dialog = page.getByRole('dialog', { name: 'Features' });
  await dialog.getByRole('tab', { name: /Active features/ }).click();
  await dialog.locator('[data-feature="zettel"] button').first().click();
  await expect(dialog.getByRole('tab', { name: 'Overview' })).toBeVisible();
  await dialog.getByRole('tab', { name: 'Settings' }).click();
  await expect(dialog.getByLabel('Target folder')).toBeVisible();
});

test('Confluence is only offered once a connection is saved', async ({ page }) => {
  await page.goto('/settings');
  await page.locator('[data-open-features]').click();
  const dialog = page.getByRole('dialog', { name: 'Features' });
  const card = dialog.locator('[data-feature="confluence"]');
  // Without a connection it is an available feature whose "Activate" opens the connection form
  await expect(card).toBeVisible();
  await card.locator('[data-activate="confluence"]').click();
  await expect(dialog.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  // …and the folder tree offers no Confluence sync
  await page.goto('/notes');
  await expect(page.locator('button[title="Sync to Confluence …"]')).toHaveCount(0);
});
