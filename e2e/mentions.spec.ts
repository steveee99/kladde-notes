import type { APIRequestContext } from '@playwright/test';
import { test, expect, uid, editor, noteTitle } from './helpers';

// @mentions with notifications (#69)

const hexId = () => [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');

async function seed(request: APIRequestContext, path: string, content: string): Promise<string> {
  const id = hexId();
  const now = Date.now();
  expect((await request.post('/api/sync', { data: { changes: [{ id, baseVersion: 0, path, content, deleted: false, createdAt: now, updatedAt: now }] } })).ok()).toBe(true);
  return id;
}

test('a mention suggests people who see the note, shows a chip and notifies them', async ({ page, openAs }) => {
  const title = `Mention ${uid()}`;
  const task = `Folien prüfen ${uid()}`;
  const id = await seed(page.request, `${title}.md`, 'Start\n');
  expect((await page.request.put(`/api/notes/${id}/shares`, { data: { username: 'ben', canWrite: true } })).ok()).toBe(true);
  await page.goto(`/n/${id}`);
  await expect(noteTitle(page)).toHaveValue(title, { timeout: 15_000 });

  // `@` suggests only the people who can see the note
  await editor(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(`- [ ] ${task} @b`);
  await expect(page.getByRole('option', { name: 'ben' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'cara' })).toHaveCount(0);
  await page.getByRole('option', { name: 'ben' }).click();
  await page.keyboard.press('ControlOrMeta+Home');
  await expect(page.locator('.cm-mention-chip[data-mention="ben"]')).toBeVisible();
  await expect
    .poll(async () => {
      const body = (await (await page.request.get('/api/sync?since=0')).json()) as { notes: { id: string; content: string }[] };
      return body.notes.find((n) => n.id === id)?.content ?? '';
    }, { timeout: 15_000 })
    .toContain('@ben');

  // Ben gets a notification that leads to the line, and the task is assigned to him
  const ben = await openAs('ben');
  await ben.goto('/notifications');
  const item = ben.locator('[data-notification="mention"]').filter({ hasText: title });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await expect(item).toContainText('anna mentioned you');
  await item.click();
  await expect(noteTitle(ben)).toHaveValue(title);
  await ben.goto('/tasks');
  await ben.locator('[data-assigned-to-me]').click();
  await expect(ben.getByText(task)).toBeVisible();
  await ben.locator('[data-assigned-to-me]').click();
});
