import { test, expect, createNote, noteIdOf, noteMenu, serverNotes, uid } from './helpers';

// Undo right after deleting a note (#131)

test('deleting a note offers undo, which brings it back', async ({ page }) => {
  const title = `Undo me ${uid()}`;
  await createNote(page, title, 'Keep this text');
  const id = noteIdOf(page);
  await expect.poll(async () => (await serverNotes(page.request)).some((n) => n.id === id)).toBe(true);
  page.once('dialog', (d) => void d.accept());
  await noteMenu(page, 'Delete');
  const toast = page.getByRole('status').filter({ hasText: `“${title}” deleted` });
  await expect(toast).toBeVisible();
  await expect.poll(async () => (await serverNotes(page.request)).some((n) => n.id === id)).toBe(false);
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Note restored' })).toBeVisible();
  await expect.poll(async () => (await serverNotes(page.request)).find((n) => n.id === id)?.content ?? '').toContain('Keep this text');
  await page.goto(`/n/${id}`);
  await expect(page.locator('.cm-content').first()).toContainText('Keep this text');
});
