import { test, expect, createNote, editor, expectOnServer, noteMenu, serverNote, typeInEditor, uid } from './helpers';

test('shares a note with another account that can then edit it', async ({ page, openAs }) => {
  const title = `Shared ${uid()}`;
  const id = await createNote(page, title, 'Shopping list');
  await expectOnServer(page.request, id, 'Shopping list');

  await noteMenu(page, 'Share');
  await page.getByRole('textbox', { name: 'Username' }).fill('ben');
  await page.getByRole('combobox', { name: 'Edit' }).click();
  await page.getByRole('option', { name: /^edit/i }).click();
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.getByText('ben', { exact: true })).toBeVisible();

  const ben = await openAs('ben');
  await expect.poll(async () => (await serverNote(ben.request, id))?.content ?? '').toContain('Shopping list');
  await ben.goto(`/n/${id}`);
  await expect(editor(ben)).toContainText('Shopping list');
  await typeInEditor(ben, '\n- Milk from Ben');
  await expectOnServer(page.request, id, 'Milk from Ben');
  await expect(editor(page)).toContainText('Milk from Ben');
});
