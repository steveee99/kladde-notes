import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext } from '@playwright/test';
import { test, expect, uid, noteTitle } from './helpers';

// Comments on text passages (#68)

const hexId = () => [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');

async function seed(request: APIRequestContext, path: string, content: string): Promise<string> {
  const id = hexId();
  const now = Date.now();
  expect((await request.post('/api/sync', { data: { changes: [{ id, baseVersion: 0, path, content, deleted: false, createdAt: now, updatedAt: now }] } })).ok()).toBe(true);
  return id;
}

test('a comment on a passage is highlighted, reaches the people concerned and can be answered and resolved', async ({ page, openAs }) => {
  const title = `Kommentar ${uid()}`;
  const id = await seed(page.request, `${title}.md`, 'Einleitung\n\nDer Liefertermin ist knapp bemessen.\n');
  expect((await page.request.put(`/api/notes/${id}/shares`, { data: { username: 'ben', canWrite: false } })).ok()).toBe(true);

  // Ben (who may only read) comments on a word
  const ben = await openAs('ben');
  await ben.goto(`/n/${id}`);
  await expect(noteTitle(ben)).toHaveValue(title, { timeout: 15_000 });
  // Select the word (a double click hits the middle of the line, not the word)
  await ben.locator('.cm-content').evaluate((root, word) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = (n as Text).data.indexOf(word);
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, i + word.length);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      return;
    }
  }, 'Liefertermin');
  await ben.locator('[data-add-comment]').click();
  const panel = ben.locator('[data-comments-panel]').filter({ visible: true });
  await panel.getByRole('textbox', { name: /Write a comment/ }).fill('Ist das realistisch?');
  await panel.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(panel.locator('[data-thread]')).toContainText('Ist das realistisch?');
  await expect(ben.locator('.cm-comment')).toHaveText('Liefertermin');

  // Anna gets a notification that opens the thread
  await page.goto('/notifications');
  const item = page.locator('[data-notification="comment"]').filter({ hasText: title });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(noteTitle(page)).toHaveValue(title);
  const annaPanel = page.locator('[data-comments-panel]').filter({ visible: true });
  const thread = annaPanel.locator('[data-thread]');
  await expect(thread).toContainText('Ist das realistisch?');
  await expect(page.locator('.cm-comment-active')).toHaveText('Liefertermin');
  const axe = await new AxeBuilder({ page }).include('[data-comments-panel]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);

  // She answers; Ben sees the answer live
  await thread.getByRole('textbox', { name: 'Reply …' }).fill('Ja, mit Puffer.');
  await thread.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(panel.locator('[data-thread]')).toContainText('Ja, mit Puffer.', { timeout: 15_000 });

  // Resolving hides the highlight and folds the thread away
  await thread.getByRole('button', { name: 'Resolve' }).click();
  await expect(page.locator('.cm-comment')).toHaveCount(0);
  await expect(annaPanel.getByRole('button', { name: 'Resolved (1)' })).toBeVisible();

  // Comments are no part of the note
  const body = (await (await page.request.get('/api/sync?since=0')).json()) as { notes: { id: string; content: string }[] };
  expect(body.notes.find((n) => n.id === id)?.content).not.toContain('realistisch');
});
