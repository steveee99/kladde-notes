import { test, expect, uid } from './helpers';

// Semantic search in the search overlay and related notes in the side panel (#84)

const hexId = () => [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');

test('the overlay lists similar matches and a note shows related notes', async ({ page }) => {
  const tag = uid();
  const now = Date.now();
  const umzug = { id: hexId(), path: `Sem ${tag}/Umzug.md`, content: `# Umzug\nNeue Wohnung suchen, Miete vergleichen, Kartons packen.\n` };
  const vertrag = { id: hexId(), path: `Sem ${tag}/Mietvertrag.md`, content: '# Mietvertrag\nDie Wohnung ab März, Miete und Kaution zahlen.\n' };
  const kuchen = { id: hexId(), path: `Sem ${tag}/Kuchen.md`, content: '# Kuchen\nMehl, Zucker und Eier verrühren.\n' };
  const changes = [umzug, vertrag, kuchen].map((n) => ({ ...n, baseVersion: 0, deleted: false, createdAt: now, updatedAt: now }));
  expect((await page.request.post('/api/sync', { data: { changes } })).ok()).toBe(true);

  await page.goto(`/n/${umzug.id}`);
  await page.keyboard.press('ControlOrMeta+k');
  const dialog = page.locator('[data-command-palette]');
  // The lease does not say "Umzug", but it is about the same thing
  await dialog.locator('[data-search-dialog-input]').fill('umzug');
  const similar = dialog.getByRole('group', { name: 'Similar matches' });
  await expect(similar).toContainText('Mietvertrag');
  await expect(similar).not.toContainText('Kuchen');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: /Side pane/ }).first().click();
  await page.getByRole('tab', { name: /Links/ }).click();
  const related = page.locator('[data-related-notes]:visible');
  // Most similar first
  await expect(related.getByRole('listitem').first()).toContainText('Mietvertrag');
  await expect(related).not.toContainText('Kuchen');
});
