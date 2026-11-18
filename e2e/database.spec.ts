import { test, expect, expectOnServer, serverNotes, uid } from './helpers';
import type { APIRequestContext, Page } from '@playwright/test';

const hexId = () => [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');

const SCHEMA = `---
type: database
properties:
  - name: Status
    type: select
    options: [todo, doing, done]
    default: todo
  - name: Pages
    type: number
views:
  - name: Table
    type: table
  - name: Board
    type: board
    group: Status
  - name: Open
    type: table
    filter:
      - property: Status
        op: ne
        value: done
---
`;

/** Puts notes on the server for the signed-in account; the app picks them up when it opens */
async function seed(request: APIRequestContext, notes: { path: string; content: string }[]): Promise<Record<string, string>> {
  const now = Date.now();
  const ids: Record<string, string> = {};
  const changes = notes.map((n) => {
    const id = hexId();
    ids[n.path] = id;
    return { id, baseVersion: 0, path: n.path, content: n.content, deleted: false, createdAt: now, updatedAt: now };
  });
  const res = await request.post('/api/sync', { data: { changes } });
  expect(res.ok()).toBe(true);
  return ids;
}

async function openFolder(page: Page, folder: string) {
  await page.goto(`/f/${encodeURIComponent(folder)}`);
  await expect(page.locator('[data-database], [data-make-database]').first()).toBeVisible({ timeout: 15_000 });
}

test('a database folder shows editable table cells that write the frontmatter', async ({ page }) => {
  const folder = `Books ${uid()}`;
  const ids = await seed(page.request, [
    { path: `${folder}/_database.md`, content: SCHEMA },
    { path: `${folder}/Alpha.md`, content: '---\nStatus: todo\nPages: 300\n---\nAlpha' },
    { path: `${folder}/Beta.md`, content: '---\nStatus: done\nPages: 120\n---\nBeta' },
  ]);
  await openFolder(page, folder);
  const db = page.locator('[data-database]');
  await expect(db.getByText('Alpha', { exact: true })).toBeVisible();
  await expect(db.getByText('Beta', { exact: true })).toBeVisible();
  await expect(db.getByText('_database', { exact: true })).toHaveCount(0);

  await db.getByLabel('Status: Alpha').selectOption('doing');
  await expectOnServer(page.request, ids[`${folder}/Alpha.md`], /Status: doing/);
  await db.getByLabel('Pages: Alpha').fill('42');
  await db.getByLabel('Pages: Alpha').press('Enter');
  await expectOnServer(page.request, ids[`${folder}/Alpha.md`], /Pages: 42/);
  // The other note is untouched
  const beta = (await serverNotes(page.request)).find((n) => n.id === ids[`${folder}/Beta.md`]);
  expect(beta?.content).toContain('Status: done');
});

test('views filter, and the board groups by the select property', async ({ page }) => {
  const folder = `Tasks ${uid()}`;
  await seed(page.request, [
    { path: `${folder}/_database.md`, content: SCHEMA },
    { path: `${folder}/Alpha.md`, content: '---\nStatus: todo\n---\nA' },
    { path: `${folder}/Beta.md`, content: '---\nStatus: done\n---\nB' },
  ]);
  await openFolder(page, folder);
  const db = page.locator('[data-database]');

  await db.getByRole('tab', { name: 'Open' }).click();
  await expect(db.getByText('Alpha', { exact: true })).toBeVisible();
  await expect(db.getByText('Beta', { exact: true })).toHaveCount(0);

  await db.getByRole('tab', { name: 'Board' }).click();
  const lane = (name: string) => db.locator('.wz-lane').filter({ has: page.locator('.wz-lane-head', { hasText: name }) });
  await expect(lane('todo').getByText('Alpha')).toBeVisible();
  await expect(lane('done').getByText('Beta')).toBeVisible();
  await expect(lane('doing').getByText('Alpha')).toHaveCount(0);
});

test('the schema note stays out of the note list and the search', async ({ page }) => {
  const id = uid();
  const folder = `Hidden ${id}`;
  await seed(page.request, [
    { path: `${folder}/_database.md`, content: `${SCHEMA}Schema marker ${id}\n` },
    { path: `${folder}/Alpha ${id}.md`, content: `---\nStatus: todo\n---\nmarker ${id}` },
  ]);
  await page.goto('/notes');
  await expect(page.getByText(`Alpha ${id}`).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('_database')).toHaveCount(0);

  await page.goto('/search');
  const input = page.locator('[data-search-input]').first();
  await expect(input).toBeVisible();
  await input.fill(id);
  await expect(page.getByText(`Alpha ${id}`).first()).toBeVisible();
  await expect(page.getByText('_database')).toHaveCount(0);

  // The quick search overlay (Ctrl/⌘+K) skips it too
  await page.goto('/notes');
  await page.keyboard.press('ControlOrMeta+k');
  const overlay = page.getByRole('dialog').locator('[data-search-input]');
  if (await overlay.isVisible()) {
    await overlay.fill(id);
    await expect(page.getByText(`Alpha ${id}`).first()).toBeVisible();
    await expect(page.getByText('_database')).toHaveCount(0);
  }
});

test('turns a folder into a database, adds a view property and prefilled entries', async ({ page }) => {
  const folder = `Contacts ${uid()}`;
  await seed(page.request, [{ path: `${folder}/Ada.md`, content: '---\ncompany: Analytical\n---\nAda' }]);
  await openFolder(page, folder);
  await page.locator('[data-make-database]').click();
  const db = page.locator('[data-database]');
  await expect(db).toBeVisible();
  // The keys found in the notes became properties
  await expect(db.getByLabel('company: Ada')).toHaveValue('Analytical');
  await expect
    .poll(async () => (await serverNotes(page.request)).find((n) => n.path === `${folder}/_database.md`)?.content ?? '', { timeout: 15_000 })
    .toMatch(/type: database/);

  // Add a select property with a default through the schema editor
  await db.locator('[data-database-edit]').click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name: 'Add property' }).click();
  await sheet.getByLabel('Name', { exact: true }).last().fill('Stage');
  await sheet.getByLabel('Type', { exact: true }).last().selectOption('select');
  await sheet.getByLabel('Options, separated by commas').fill('lead, client');
  await sheet.getByLabel('Default for new notes').last().fill('lead');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toBeHidden();
  await expect
    .poll(async () => (await serverNotes(page.request)).find((n) => n.path === `${folder}/_database.md`)?.content ?? '')
    .toMatch(/name: Stage/);

  // A new entry starts with the properties prefilled
  await db.locator('[data-database-add]').click();
  await page.waitForURL(/\/n\/[0-9a-f]+/);
  await expect
    .poll(async () => (await serverNotes(page.request)).find((n) => n.path.startsWith(`${folder}/New entry`))?.content ?? '', { timeout: 15_000 })
    .toMatch(/Stage: lead/);
});
