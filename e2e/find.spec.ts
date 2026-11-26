import { test, expect, editor, expectOnServer, noteMenu, serverNote, uid } from './helpers';

// Find and replace inside a note (#129)

const hexId = () => [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');

async function seedNote(page: import('@playwright/test').Page, content: string): Promise<string> {
  const now = Date.now();
  const id = hexId();
  const changes = [{ id, baseVersion: 0, deleted: false, createdAt: now, updatedAt: now, path: `Find ${uid()}.md`, content }];
  expect((await page.request.post('/api/sync', { data: { changes } })).ok()).toBe(true);
  return id;
}

test('Ctrl/⌘+F finds matches in the note and replace all rewrites them', async ({ page }) => {
  const id = await seedNote(page, 'Apfel und Birne\n\nNoch ein Apfel, ein apfel und APFELMUS\n');
  await page.goto(`/n/${id}`);
  await editor(page).click();
  await page.keyboard.press('ControlOrMeta+f');
  const bar = page.getByRole('search', { name: 'Find in note' });
  await expect(bar).toBeVisible();
  const field = bar.getByRole('searchbox', { name: 'Search term' });
  await expect(field).toBeFocused();
  await field.fill('apfel');
  await expect(bar).toContainText('/ 4');
  await bar.getByRole('button', { name: 'Match case' }).click();
  await expect(bar).toContainText('/ 1');
  await bar.getByRole('button', { name: 'Match case' }).click();
  await bar.getByRole('button', { name: 'Whole words only' }).click();
  await expect(bar).toContainText('/ 3');
  await expect(page.locator('.cm-searchMatch').first()).toBeVisible();

  await bar.getByRole('button', { name: 'Show replace' }).click();
  await bar.getByRole('textbox', { name: 'Replace with' }).fill('Kiwi');
  await bar.getByRole('button', { name: 'Replace all' }).click();
  await expect(bar).toContainText('No matches');
  await expectOnServer(page.request, id, 'Kiwi und Birne\n\nNoch ein Kiwi, ein Kiwi und APFELMUS');

  await page.keyboard.press('Escape');
  await expect(bar).toBeHidden();
});

test('the note menu opens find and the arrows move between matches', async ({ page }) => {
  const id = await seedNote(page, 'eins zwei eins\n');
  await page.goto(`/n/${id}`);
  await expect(editor(page)).toContainText('eins zwei');
  await noteMenu(page, 'Find and replace');
  const bar = page.getByRole('search', { name: 'Find in note' });
  await bar.getByRole('searchbox', { name: 'Search term' }).fill('eins');
  await expect(bar).toContainText('/ 2');
  await bar.getByRole('button', { name: /Next match/ }).click();
  await expect(bar).toContainText(/[12] \/ 2/);
  await bar.getByRole('button', { name: /Close/ }).click();
  await expect(bar).toBeHidden();
  expect((await serverNote(page.request, id))?.content).toBe('eins zwei eins\n');
});
