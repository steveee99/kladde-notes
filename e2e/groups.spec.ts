import { test, expect, editor, expectOnServer, serverNote, uid } from './helpers';

test('group roles: an editor writes, a reader only reads', async ({ page, openAs }) => {
  const name = `Team ${uid()}`;
  await page.goto('/groups');
  await page.getByRole('textbox', { name: 'Name of the new group' }).fill(name);
  await page.getByRole('button', { name: 'Create group' }).click();
  await expect(page.getByText(name).first()).toBeVisible();

  // Members are added on the group's page
  const res = await page.request.get('/api/groups');
  const group = ((await res.json()) as { id: string; name: string }[]).find((g) => g.name === name)!;
  expect(group).toBeTruthy();
  await page.goto(`/groups/${group.id}`);
  for (const [user, role] of [['ben', 'Editor'], ['cara', 'Reader']] as const) {
    await page.getByRole('textbox', { name: /username/i }).fill(user);
    await page.getByRole('combobox', { name: 'Role of the new member' }).click();
    await page.getByRole('option', { name: role }).click();
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('cell', { name: user }).or(page.getByText(user, { exact: true })).first()).toBeVisible();
  }

  // A note created on the group's page belongs to the group
  await page.goto(`/g/${group.id}`);
  await page.getByRole('main').getByRole('button', { name: 'New note' }).click();
  await page.locator('input[placeholder="Title"]').fill('Group plan');
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/n\/[0-9a-f]+/);
  const id = /\/n\/([0-9a-f]+)/.exec(page.url())![1];
  await editor(page).click();
  await page.keyboard.type('Agenda for the team');
  await expectOnServer(page.request, id, 'Agenda for the team');

  const ben = await openAs('ben');
  await expect.poll(async () => (await serverNote(ben.request, id))?.content ?? '').toContain('Agenda');
  await ben.goto(`/n/${id}`);
  await editor(ben).click();
  await ben.keyboard.press('ControlOrMeta+End');
  await ben.keyboard.type(' – Ben was here');
  await expectOnServer(page.request, id, 'Ben was here');

  const cara = await openAs('cara');
  await cara.goto(`/n/${id}`);
  await expect(editor(cara)).toContainText('Ben was here');
  await expect(editor(cara)).toHaveAttribute('contenteditable', 'false');
});
