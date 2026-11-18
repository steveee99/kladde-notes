import { test, expect, createNote, editor, expectOnServer, expectSynced, serverNote, typeInEditor, uid } from './helpers';

test('keeps edits made offline and syncs them after reconnecting', async ({ page, context }) => {
  const id = await createNote(page, `Offline ${uid()}`, 'Written online.');
  await expectOnServer(page.request, id, 'Written online.');
  await expectSynced(page);

  await context.setOffline(true);
  await typeInEditor(page, '\nWritten on the train.');
  await expect(page.getByRole('button', { name: /pending|Offline/i }).first()).toBeVisible();
  expect((await serverNote(page.request, id).catch(() => undefined))?.content ?? '').not.toContain('train');

  await context.setOffline(false);
  await expectOnServer(page.request, id, 'Written on the train.');
  await expectSynced(page);
});

test('merges concurrent edits from two browsers without losing text', async ({ page, openAs }) => {
  const lines = ['Alpha line', 'Middle line', 'Omega line'];
  const id = await createNote(page, `Merge ${uid()}`, lines.join('\n'));
  await expectOnServer(page.request, id, 'Omega line');

  const other = await openAs('anna');
  await other.goto(`/n/${id}`);
  await expect(editor(other)).toContainText('Omega line');

  // The first browser edits the first line while offline, the second one the last line online
  await page.context().setOffline(true);
  await editor(page).getByText('Alpha line').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' (offline edit)');

  await editor(other).getByText('Omega line').click();
  await other.keyboard.press('End');
  await other.keyboard.type(' (online edit)');
  await expectOnServer(other.request, id, '(online edit)');

  await page.context().setOffline(false);
  await expectOnServer(page.request, id, /Alpha line \(offline edit\)[\s\S]*Omega line \(online edit\)/);
  await expect(editor(page)).toContainText('(online edit)');
  await expect(editor(other)).toContainText('(offline edit)');
});
