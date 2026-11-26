import { test, expect, uid } from './helpers';

// Saved searches in the navigation (#78)

const hexId = () => [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');

test('a search saved in the overlay sits in the sidebar, opens again and can be removed', async ({ page }) => {
  const word = `Zwiebel${uid()}`;
  const now = Date.now();
  const changes = [1, 2].map((i) => ({ id: hexId(), baseVersion: 0, deleted: false, createdAt: now, updatedAt: now, path: `Saved ${word}/N${i}.md`, content: `Text mit ${word} ${i}\n` }));
  expect((await page.request.post('/api/sync', { data: { changes } })).ok()).toBe(true);

  await page.goto('/');
  await page.keyboard.press('ControlOrMeta+k');
  const dialog = page.locator('[data-command-palette]');
  await dialog.locator('[data-search-dialog-input]').fill(word);
  page.once('dialog', (d) => void d.accept(`Rezepte ${word}`));
  await dialog.locator('[data-save-search]').click();
  await expect(dialog.locator('[data-save-search]')).toHaveText(/Saved/);
  await page.keyboard.press('Escape');

  const row = page.locator('[data-saved-searches] [data-saved-search]').filter({ hasText: `Rezepte ${word}` });
  await expect(row).toBeVisible();
  await expect(row).toContainText('2');
  await row.getByRole('button', { name: `Rezepte ${word}` }).click();
  await expect(dialog.locator('[data-search-dialog-input]')).toHaveValue(word);
  await expect(dialog.getByRole('option')).toHaveCount(2);
  await page.keyboard.press('Escape');

  // It is a synced setting: another page load still has it
  await page.reload();
  await expect(row).toBeVisible();
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  await expect(row).toBeHidden();
});

test('the task page saves its filters as a view', async ({ page }) => {
  await page.goto('/tasks');
  await page.getByRole('button', { name: 'Kanban' }).click();
  const name = `Board ${uid()}`;
  page.once('dialog', (d) => void d.accept(name));
  await page.locator('[data-save-task-view]').click();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  const row = page.locator('[data-saved-search]').filter({ hasText: name });
  await row.getByRole('button', { name }).click();
  await expect(page.getByRole('button', { name: 'Kanban' })).toHaveAttribute('aria-pressed', 'true');
});
