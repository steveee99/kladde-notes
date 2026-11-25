import AxeBuilder from '@axe-core/playwright';
import { test, expect, uid } from './helpers';

// Activity feed of groups and shared folders, with "new" marks on notes others changed (#70)

const hexId = () => [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');

test('a group shows who changed what, and marks notes changed by others until they are opened', async ({ page, openAs }) => {
  const name = `Aktiv ${uid()}`;
  const group = (await (await page.request.post('/api/groups', { data: { name } })).json()) as { id: string };
  expect((await page.request.put(`/api/groups/${group.id}/members`, { data: { username: 'ben', role: 'editor' } })).ok()).toBe(true);

  // Ben writes a note in the group
  const ben = await openAs('ben');
  const id = hexId();
  const title = `Packliste ${uid()}`;
  const now = Date.now();
  const res = await ben.request.post('/api/sync', {
    data: { changes: [{ id, baseVersion: 0, path: `${title}.md`, content: 'Zelt', deleted: false, createdAt: now, updatedAt: now, group: group.id }] },
  });
  expect(res.ok()).toBe(true);

  // Anna sees the note marked as new in the group
  await page.goto(`/g/${group.id}`);
  const card = page.getByRole('button', { name: new RegExp(title) }).first();
  await expect(card.locator('[data-new-mark]')).toBeVisible({ timeout: 15_000 });
  await expect(card.locator('[data-new-mark]')).toHaveAttribute('aria-label', 'New: changed by ben');

  // The activity page lists the membership change and Ben's note
  await page.locator('[data-item-menu="folder"]').click();
  await page.locator('[data-open-activity]').click();
  const view = page.locator('[data-activity-view]');
  await expect(view.locator('[data-activity-kind="created"]')).toContainText(`ben created ${title}`);
  await expect(view.locator('[data-activity-kind="member_added"]')).toContainText('added ben as Editor');
  const axe = await new AxeBuilder({ page }).include('[data-activity-view]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);

  // Opening the note clears the mark
  await view.getByRole('button', { name: title }).click();
  await expect(page.locator('textarea.note-title')).toHaveValue(title);
  await page.goto(`/g/${group.id}`);
  await expect(page.getByRole('button', { name: new RegExp(title) }).first()).toBeVisible();
  await expect(page.locator('[data-new-mark]')).toHaveCount(0);
});
