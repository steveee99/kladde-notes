import { test, expect, createNote, editor, expectOnServer, noteIdOf, noteTitle, serverNote, typeInEditor, uid } from './helpers';

test('creates and edits a note, and renaming it rewrites the links to it', async ({ page }) => {
  const id = uid();
  const target = `Target ${id}`;
  const renamed = `Renamed ${id}`;

  const targetId = await createNote(page, target, 'The note others link to.');
  await expectOnServer(page.request, targetId, 'The note others link to.');

  const sourceId = await createNote(page, `Source ${id}`);
  await typeInEditor(page, `See [[${target}]] for details.`);
  await expectOnServer(page.request, sourceId, `[[${target}]]`);

  await page.goto(`/n/${targetId}`);
  const title = noteTitle(page);
  await title.fill(renamed);
  await title.press('Enter');
  await expect.poll(async () => (await serverNote(page.request, targetId))?.path ?? '').toMatch(new RegExp(`${renamed}\\.md$`));
  await expectOnServer(page.request, sourceId, `[[${renamed}]]`);

  // The link still leads to the note
  await page.goto(`/n/${sourceId}`);
  await editor(page).getByText(renamed).click({ modifiers: ['ControlOrMeta'] });
  await expect.poll(() => noteIdOf(page)).toBe(targetId);
});
