import { test, expect, createNote, expectOnServer, noteMenu, serverNotes, uid } from './helpers';

test('deletes a note into the trash and restores it', async ({ page }) => {
  const title = `Trashed ${uid()}`;
  const id = await createNote(page, title, 'Do not lose me');
  await expectOnServer(page.request, id, 'Do not lose me');

  page.once('dialog', (d) => void d.accept());
  await noteMenu(page, 'Delete');
  await expect.poll(async () => (await serverNotes(page.request)).some((n) => n.id === id)).toBe(false);

  await page.goto('/trash');
  const row = page.getByRole('listitem').filter({ hasText: title });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText(`“${title}” is restored.`)).toBeVisible();
  await expectOnServer(page.request, id, 'Do not lose me');
});
