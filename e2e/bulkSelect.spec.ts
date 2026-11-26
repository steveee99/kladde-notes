import { test, expect, serverNotes, uid } from './helpers';

// Selecting several notes in the note list (#132)

const hexId = () => [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');

test('select notes, tag and move them together, then delete them with undo', async ({ page }) => {
  const folder = `Bulk ${uid()}`;
  const now = Date.now();
  const changes = ['Alpha', 'Beta', 'Gamma'].map((name, i) => ({ id: hexId(), baseVersion: 0, deleted: false, createdAt: now, updatedAt: now - i * 1000, path: `${folder}/${name}.md`, content: `${name} text\n` }));
  changes.push({ id: hexId(), baseVersion: 0, deleted: false, createdAt: now, updatedAt: now, path: `${folder}/Target/Keep.md`, content: 'x\n' });
  expect((await page.request.post('/api/sync', { data: { changes } })).ok()).toBe(true);
  const [alpha, beta, gamma] = changes;

  await page.goto(`/f/${encodeURIComponent(folder)}`);
  await expect(page.locator(`[data-note-item="${alpha.id}"]`)).toBeVisible();
  await page.getByRole('button', { name: 'More folder actions' }).click();
  await page.locator('[data-select-notes]').click();
  const bar = page.getByRole('toolbar', { name: 'Selected notes' });
  await expect(bar).toContainText('0 selected');
  await page.locator(`[data-note-item="${alpha.id}"]`).click();
  await page.locator(`[data-note-item="${gamma.id}"]`).click({ modifiers: ['Shift'] });
  await expect(bar).toContainText('3 selected');
  await page.locator(`[data-note-item="${beta.id}"]`).click();
  await expect(bar).toContainText('2 selected');
  // Still on the folder page: selection clicks do not open notes
  expect(page.url()).toContain('/f/');

  page.once('dialog', (d) => void d.accept('Projekt'));
  await bar.locator('[data-bulk-tag]').click();
  await expect(page.getByRole('status').filter({ hasText: 'Added #Projekt to 2 notes' })).toBeVisible();
  await expect
    .poll(async () => (await serverNotes(page.request)).filter((n) => [alpha.id, gamma.id].includes(n.id) && /tags: Projekt/.test(n.content)).length)
    .toBe(2);

  await bar.locator('[data-bulk-move]').click();
  await page.getByRole('dialog').getByRole('button', { name: new RegExp(`${folder}.*Target`) }).click();
  await expect.poll(async () => (await serverNotes(page.request)).filter((n) => n.path.startsWith(`${folder}/Target/`)).length).toBe(3);
  await expect(page.locator(`[data-note-item="${alpha.id}"]`)).toBeHidden();

  // Ctrl/⌘+click starts selecting on its own; Delete with undo
  await page.locator(`[data-note-item="${beta.id}"]`).click({ modifiers: ['ControlOrMeta'] });
  await expect(bar).toContainText('1 selected');
  page.once('dialog', (d) => void d.accept());
  await bar.locator('[data-bulk-delete]').click();
  const toast = page.getByRole('status').filter({ hasText: '“Beta” deleted' });
  await expect(toast).toBeVisible();
  await expect.poll(async () => (await serverNotes(page.request)).some((n) => n.id === beta.id)).toBe(false);
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await serverNotes(page.request)).some((n) => n.id === beta.id)).toBe(true);

  await page.keyboard.press('Escape');
  await expect(bar).toBeHidden();
});
