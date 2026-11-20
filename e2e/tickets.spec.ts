import { test, expect, enableFeature, serverNote, serverNotes, uid } from './helpers';
import type { APIRequestContext, Page } from '@playwright/test';

const hexId = () => [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
const letters = () => [...Array(3)].map(() => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

async function seed(request: APIRequestContext, notes: { path: string; content: string; group?: string }[]): Promise<string[]> {
  const now = Date.now();
  const changes = notes.map((n) => ({ id: hexId(), baseVersion: 0, path: n.path, content: n.content, deleted: false, createdAt: now, updatedAt: now, ...(n.group ? { group: n.group } : {}) }));
  const res = await request.post('/api/sync', { data: { changes } });
  expect(res.ok()).toBe(true);
  return changes.map((c) => c.id);
}

/** Picks an option of one of the app's dropdowns (a combobox button with a listbox) */
async function choose(page: Page, scope: ReturnType<Page['locator']>, name: string | RegExp, option: string) {
  await scope.getByRole('combobox', { name }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

test('own project: number, board, ticket header and status chips in the documentation', async ({ page }) => {
  await enableFeature(page, 'tickets');
  const folder = `Project ${uid()}`;
  const key = `T${letters()}`;
  await seed(page.request, [{ path: `${folder}/Readme.md`, content: 'About the project' }]);
  await page.goto(`/f/${encodeURIComponent(folder)}`);
  await page.locator('[data-make-project]').click();
  await page.locator('[data-project-key]').fill(key);
  await page.getByRole('button', { name: 'Create project' }).click();
  const project = page.locator(`[data-project="${key}"]`);
  await expect(project).toBeVisible();

  // A new ticket gets its number from the server
  await project.locator('[data-new-ticket]').click();
  await page.locator('[data-new-ticket-title]').fill('Offline numbers');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForURL(/\/n\/[0-9a-f]+/);
  const ticketId = /\/n\/([0-9a-f]+)/.exec(page.url())![1];
  await expect(page.locator('[data-ticket-id]')).toHaveText(`${key}-1`, { timeout: 15_000 });
  await expect.poll(async () => (await serverNote(page.request, ticketId))?.content ?? '').toContain(`id: ${key}-1\n`);

  // The board shows it in the first column
  await page.goto(`/f/${encodeURIComponent(folder)}`);
  await expect(project.locator('[data-lane="Open"]').getByText('Offline numbers')).toBeVisible();

  // A ticket id in another note becomes a chip with the ticket's status
  const [docId] = await seed(page.request, [{ path: `${folder}/Sync protocol.md`, content: `Numbers are assigned on push, see ${key}-1.\n` }]);
  await page.goto(`/n/${docId}`);
  const chip = page.locator(`.cm-ticket-chip[data-ticket="${key}-1"]`);
  await expect(chip).toBeVisible({ timeout: 15_000 });
  await expect(chip).toHaveClass(/cm-ticket-open/);

  // Linking the documentation and finishing the ticket in its header
  await page.goto(`/n/${ticketId}`);
  const panel = page.locator('[data-ticket-panel]');
  await panel.getByRole('combobox', { name: 'Link documentation' }).fill('Sync protocol');
  await panel.getByRole('button', { name: 'Link documentation' }).click();
  await expect(panel.getByText('in the “docs” field')).toBeVisible();
  await choose(page, panel, 'Status', 'Done');
  await expect.poll(async () => (await serverNote(page.request, ticketId))?.content ?? '').toMatch(/status: Done[\s\S]*docs: \["\[\[Sync protocol\]\]"\]|docs: \["\[\[Sync protocol\]\]"\][\s\S]*status: Done/);

  // The documentation page lists the ticket and strikes the chip through
  await page.goto(`/n/${docId}`);
  await expect(page.locator(`.cm-ticket-chip[data-ticket="${key}-1"]`)).toHaveClass(/cm-ticket-done/);
  await expect(page.locator('[data-ticket-backlinks]').first()).toContainText('Offline numbers');
});

test('group projects follow the group switch for every member', async ({ page, openAs }) => {
  const name = `Tickets ${uid()}`;
  const created = await page.request.post('/api/groups', { data: { name } });
  const group = (await created.json()) as { id: string };
  expect((await page.request.put(`/api/groups/${group.id}/members`, { data: { username: 'ben', role: 'editor' } })).ok()).toBe(true);
  const key = `G${letters()}`;
  await seed(page.request, [
    {
      path: `Plan/_database-${crypto.randomUUID()}.md`,
      group: group.id,
      content: `---\ntype: database\nproject:\n  key: ${key}\n  workflow: [Open, Doing, Done]\n  active: [Doing]\n  done: [Done]\nproperties:\n  - name: status\n    type: select\n    options: [Open, Doing, Done]\nviews:\n  - name: Board\n    type: board\n    group: status\n---\n`,
    },
  ]);

  // Off for the group: Ben (whose own feature is off) sees no project
  const ben = await openAs('ben');
  await ben.goto(`/g/${group.id}/Plan`);
  await expect(ben.getByRole('heading', { name: 'Plan' })).toBeVisible();
  await expect(ben.locator(`[data-project="${key}"]`)).toHaveCount(0);

  // The owner switches tickets on for the group
  await page.goto(`/groups/${group.id}`);
  await page.locator('[data-group-features]').getByRole('switch', { name: 'Tickets & milestones' }).click();
  await expect(page.locator('[data-group-features]').getByRole('switch', { name: 'Tickets & milestones' })).toBeChecked();

  // Now Ben works with the project and the group counts the numbers
  await ben.goto(`/g/${group.id}/Plan`);
  const project = ben.locator(`[data-project="${key}"]`);
  await expect(project).toBeVisible({ timeout: 15_000 });
  await project.locator('[data-new-ticket]').click();
  await ben.locator('[data-new-ticket-title]').fill('Shared work');
  await ben.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(ben.locator('[data-ticket-id]')).toHaveText(`${key}-1`, { timeout: 15_000 });
  await expect.poll(async () => (await serverNotes(page.request)).some((n) => n.content.includes(`id: ${key}-1\n`))).toBe(true);

  // "Projects" shows the group's project
  await ben.goto('/projects');
  await expect(ben.locator(`[data-project-link="${key}"]`)).toBeVisible();
});
