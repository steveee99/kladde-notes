import { test, expect, uid } from './helpers';

// The notifications panel behind the bell in the top bar: group invitations, marking read, loading older ones

test('being added to a group shows up behind the bell, can be marked read and opens the group', async ({ page, openAs }) => {
  const name = `Bell ${uid()}`;
  const group = (await (await page.request.post('/api/groups', { data: { name } })).json()) as { id: string };

  const ben = await openAs('ben');
  await ben.goto('/');
  const bell = ben.locator('[data-notifications-button]:visible');
  await expect(bell).toBeVisible();
  const before = await ben.evaluate(async () => ((await (await fetch('/api/notifications')).json()) as { unread: number }).unread);

  expect((await page.request.put(`/api/groups/${group.id}/members`, { data: { username: 'ben', role: 'editor' } })).ok()).toBe(true);
  // The live event updates the badge
  await expect(bell).toHaveAccessibleName(new RegExp(`${before + 1} unread`), { timeout: 15_000 });

  await bell.click();
  const panel = ben.getByRole('dialog', { name: 'Notifications' });
  await expect(panel).toBeVisible();
  const row = panel.locator('li').filter({ hasText: name });
  const item = row.locator('[data-notification="group_added"]');
  await expect(item).toContainText('anna added you to a group');
  await expect(item).toContainText('as Editor');
  await expect(item).toHaveAttribute('data-read', 'false');

  // Marked read without opening it
  await row.locator('[data-mark-read]').click();
  await expect(item).toHaveAttribute('data-read', 'true');
  await expect(bell).toHaveAccessibleName(before ? new RegExp(`${before} unread`) : /^Notifications$/);

  // A click opens the group and closes the panel
  await item.click();
  await expect(ben).toHaveURL(new RegExp(`/groups/${group.id}$`));
  await expect(panel).toHaveCount(0);
});

test('the panel loads older notifications on request', async ({ page, openAs }) => {
  // Twelve groups: twelve notifications for cara, more than one page of ten
  for (let i = 0; i < 12; i++) {
    const group = (await (await page.request.post('/api/groups', { data: { name: `Page ${uid()}` } })).json()) as { id: string };
    expect((await page.request.put(`/api/groups/${group.id}/members`, { data: { username: 'cara', role: 'reader' } })).ok()).toBe(true);
  }
  const cara = await openAs('cara');
  await cara.goto('/notifications');
  const list = cara.locator('[data-notification-list] > li');
  await expect(list).toHaveCount(10);
  await cara.locator('[data-notifications-more]').click();
  await expect.poll(() => list.count()).toBeGreaterThan(10);
  // Everything read at once
  await cara.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(cara.locator('[data-notification][data-read="false"]')).toHaveCount(0);
});
