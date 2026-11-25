import type { APIRequestContext } from '@playwright/test';
import { test, expect, editor, enableFeature, serverNote, uid } from './helpers';

// GitLab preview cards (e2e/fixtures/fakeGitlab.mjs), magic links, release diffs and ticket checklist templates

const hexId = () => [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');

async function seed(request: APIRequestContext, notes: { path: string; content: string }[]): Promise<string[]> {
  const now = Date.now();
  const changes = notes.map((n) => ({ id: hexId(), baseVersion: 0, deleted: false, createdAt: now, updatedAt: now, ...n }));
  expect((await request.post('/api/sync', { data: { changes } })).ok()).toBe(true);
  return changes.map((c) => c.id);
}

test('a GitLab link alone on its line shows as a preview card', async ({ page }) => {
  const hosts = (await (await page.request.get('/api/remote-notes/hosts')).json()) as { url: string }[];
  const gitlab = hosts[0].url;
  const [id] = await seed(page.request, [
    { path: `Cards ${uid()}/MR.md`, content: `Start\n\n${gitlab}/team/cards/-/merge_requests/12\n\n<${gitlab}/team/cards>\n\nInline ${gitlab}/team/cards stays a link\n` },
  ]);
  await page.goto(`/n/${id}`);
  const mr = page.locator('[data-gitlab-card="merge_request"]');
  await expect(mr).toBeVisible();
  await expect(mr).toContainText('Faster sync');
  await expect(mr).toContainText('team/cards!12');
  await expect(mr).toContainText('feat/sync → main');
  await expect(mr).toContainText('Pipeline: Passed');
  await expect(mr).toContainText('perf');
  await expect(mr).toHaveAttribute('href', `${gitlab}/team/cards/-/merge_requests/12`);
  const project = page.locator('[data-gitlab-card="project"]');
  await expect(project).toContainText('Cards');
  await expect(project).toContainText('Preview cards');
  await expect(project).toContainText('TypeScript 90.2 %');
  // A link inside a sentence stays a link
  await expect(page.locator('[data-gitlab-card]')).toHaveCount(2);
  // The note keeps the plain link
  expect((await serverNote(page.request, id))?.content).toContain(`${gitlab}/team/cards/-/merge_requests/12`);
});

test('a magic link shows its wand and becomes a regular link on click', async ({ page }) => {
  const name = `Zebra${uid()}`;
  const [, id] = await seed(page.request, [
    { path: `Magic/${name}.md`, content: 'Target\n' },
    { path: `Magic/Mentions ${name}.md`, content: `Read ${name} first.\n` },
  ]);
  await page.goto(`/n/${id}`);
  const wand = editor(page).locator('.cm-autolink-widget .cm-autolink-btn');
  await expect(wand).toBeVisible();
  await expect(wand).toHaveAttribute('aria-label', new RegExp(`Magic link to “${name}”`));
  await wand.click();
  await expect.poll(async () => (await serverNote(page.request, id))?.content).toBe(`Read [[${name}]] first.\n`);
});

test('the release history shows what changed in each version', async ({ page }) => {
  const [id] = await seed(page.request, [{ path: `Versioned ${uid()}.md`, content: 'Line one\nLine two\n' }]);
  const versioning = async (body: object) => expect((await page.request.put(`/api/notes/${id}/versioning`, { data: body })).ok()).toBe(true);
  const release = async () => {
    const note = await serverNote(page.request, id);
    expect((await page.request.post(`/api/notes/${id}/releases`, { data: { bump: 'minor', baseVersion: note!.version } })).ok()).toBe(true);
  };
  await versioning({ enabled: true });
  await release();
  const note = await serverNote(page.request, id);
  const now = Date.now();
  expect((await page.request.post('/api/sync', { data: { changes: [{ id, baseVersion: note!.version, path: note!.path, content: 'Line one\nLine 2\nLine three\n', deleted: false, createdAt: now, updatedAt: now }] } })).ok()).toBe(true);
  await release();

  await page.goto(`/n/${id}`);
  await page.getByRole('button', { name: /^v0\.2\.0/ }).click();
  await page.getByRole('button', { name: /v0\.2\.0/ }).last().click();
  const changes = page.locator('[data-release-changes]');
  await expect(changes).toContainText('Changes compared to v0.1.0');
  await expect(changes.locator('[data-diff-line="del"]')).toHaveText(/Line two/);
  await expect(changes.locator('[data-diff-line="add"]')).toHaveCount(2);
  await expect(changes.locator('[data-diff-stats]')).toHaveText('+2 −1');
  await changes.getByRole('button', { name: 'Rendered' }).click();
  await expect(changes).toContainText('Line three');
});

test('new tickets start with the checklist template of their type', async ({ page }) => {
  await enableFeature(page, 'tickets');
  const folder = `Checklists ${uid()}`;
  const key = `C${String.fromCharCode(...[...Array(3)].map(() => 65 + Math.floor(Math.random() * 26)))}`;
  await seed(page.request, [{ path: `${folder}/Readme.md`, content: 'About' }]);
  await page.goto(`/f/${encodeURIComponent(folder)}`);
  await page.locator('[data-make-project]').click();
  await page.locator('[data-project-key]').fill(key);
  await page.getByRole('button', { name: 'Create project' }).click();
  const project = page.locator(`[data-project="${key}"]`);
  await expect(project).toBeVisible();

  await project.getByRole('button', { name: 'Project settings' }).click();
  const dialog = page.locator('[data-project-settings]');
  await dialog.locator('[data-section="types"]').click();
  const bug = dialog.locator('[data-ticket-kind="bug"]');
  await expect(bug).toContainText('No checklist');
  await bug.getByRole('textbox', { name: 'Add an item to the Bug checklist' }).fill('Acceptance');
  await bug.getByRole('textbox', { name: 'Add an item to the Bug checklist' }).press('Enter');
  await bug.getByRole('textbox', { name: 'Add an item to the Bug checklist' }).fill('Regression test');
  await bug.getByRole('button', { name: 'Item' }).click();
  await expect(bug.locator('[data-checklist-item]')).toHaveCount(2);
  await dialog.locator('[data-save-project]').click();
  await expect(dialog).toBeHidden();

  await project.locator('[data-new-ticket]').click();
  await page.locator('[data-new-ticket-title]').fill('Crash on save');
  await page.getByRole('combobox', { name: 'Type' }).click();
  await page.getByRole('option', { name: 'Bug', exact: true }).click();
  await expect(page.locator('[data-new-ticket-checklist]')).toContainText('Acceptance, Regression test');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForURL(/\/n\/[0-9a-f]+/);
  const ticketId = /\/n\/([0-9a-f]+)/.exec(page.url())![1];
  await expect.poll(async () => (await serverNote(page.request, ticketId))?.content ?? '').toMatch(/- \[ \] Acceptance\n- \[ \] Regression test\n$/);
});
