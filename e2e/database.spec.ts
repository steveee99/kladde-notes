import { test, expect, enableFeature, expectOnServer, serverNotes, uid } from './helpers';
import type { APIRequestContext, Page } from '@playwright/test';

/** The schema note's name carries a UUID so it cannot clash with a title someone types */
const DB_FILE = `_database-${crypto.randomUUID()}.md`;

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
  await expect(page.locator('[data-database], [data-item-menu="folder"]').first()).toBeVisible({ timeout: 15_000 });
}

test('a database folder shows editable table cells that write the frontmatter', async ({ page }) => {
  const folder = `Books ${uid()}`;
  const ids = await seed(page.request, [
    { path: `${folder}/${DB_FILE}`, content: SCHEMA },
    { path: `${folder}/Alpha.md`, content: '---\nStatus: todo\nPages: 300\n---\nAlpha' },
    { path: `${folder}/Beta.md`, content: '---\nStatus: done\nPages: 120\n---\nBeta' },
  ]);
  await openFolder(page, folder);
  const db = page.locator('[data-database]');
  await expect(db.getByText('Alpha', { exact: true })).toBeVisible();
  await expect(db.getByText('Beta', { exact: true })).toBeVisible();
  // Neither the table nor the folder tree shows the schema note
  await expect(page.getByText('_database')).toHaveCount(0);

  await db.getByRole('combobox', { name: 'Status: Alpha' }).click();
  await page.getByRole('option', { name: 'doing', exact: true }).click();
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
    { path: `${folder}/${DB_FILE}`, content: SCHEMA },
    { path: `${folder}/Alpha.md`, content: '---\nStatus: todo\n---\nA' },
    { path: `${folder}/Beta.md`, content: '---\nStatus: done\n---\nB' },
  ]);
  await openFolder(page, folder);
  const db = page.locator('[data-database]');

  const pickView = async (name: string) => {
    await db.getByRole('combobox', { name: 'Views' }).click();
    await page.getByRole('option', { name }).click();
  };
  await pickView('Open');
  await expect(db.getByText('Alpha', { exact: true })).toBeVisible();
  await expect(db.getByText('Beta', { exact: true })).toHaveCount(0);

  await pickView('Board');
  const lane = (name: string) => db.locator('.wz-lane').filter({ has: page.locator('.wz-lane-head', { hasText: name }) });
  await expect(lane('todo').getByText('Alpha')).toBeVisible();
  await expect(lane('done').getByText('Beta')).toBeVisible();
  await expect(lane('doing').getByText('Alpha')).toHaveCount(0);
});

test('the schema note stays out of the note list and the search', async ({ page }) => {
  const id = uid();
  const folder = `Hidden ${id}`;
  await seed(page.request, [
    { path: `${folder}/${DB_FILE}`, content: `${SCHEMA}Schema marker ${id}\n` },
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
  // "Make database" is a feature (off in new spaces)
  await enableFeature(page, 'database');
  await openFolder(page, folder);
  await page.locator('[data-item-menu="folder"]').click();
  await page.locator('[data-make-database]').click();
  const db = page.locator('[data-database]');
  await expect(db).toBeVisible();
  // The keys found in the notes became properties
  await expect(db.getByLabel('company: Ada')).toHaveValue('Analytical');
  await expect
    .poll(async () => (await serverNotes(page.request)).find((n) => n.path.startsWith(`${folder}/_database-`))?.content ?? '', { timeout: 15_000 })
    .toMatch(/type: database/);

  // Add a select property with a default through the schema editor
  await db.locator('[data-database-edit]').click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name: 'Add property' }).click();
  await sheet.getByLabel('Name', { exact: true }).last().fill('Stage');
  await sheet.getByRole('combobox', { name: 'Type', exact: true }).last().click();
  await page.getByRole('option', { name: 'Select', exact: true }).click();
  await sheet.getByLabel('Options, separated by commas').fill('lead, client');
  await sheet.getByLabel('Default for new notes').last().fill('lead');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toBeHidden();
  await expect
    .poll(async () => (await serverNotes(page.request)).find((n) => n.path.startsWith(`${folder}/_database-`))?.content ?? '')
    .toMatch(/name: Stage/);

  // A new entry starts with the properties prefilled
  await db.locator('[data-database-add]').click();
  await page.waitForURL(/\/n\/[0-9a-f]+/);
  await expect
    .poll(async () => (await serverNotes(page.request)).find((n) => n.path.startsWith(`${folder}/New entry`))?.content ?? '', { timeout: 15_000 })
    .toMatch(/Stage: lead/);
});

test('includes subfolders on request and shows their relative path', async ({ page }) => {
  const folder = `Deep ${uid()}`;
  await seed(page.request, [
    { path: `${folder}/${DB_FILE}`, content: SCHEMA.replace('type: database\n', 'type: database\nsubfolders: true\n') },
    { path: `${folder}/Top.md`, content: '---\nStatus: todo\n---\nT' },
    { path: `${folder}/Inner/Level/Low.md`, content: '---\nStatus: todo\n---\nL' },
  ]);
  await openFolder(page, folder);
  const db = page.locator('[data-database]');
  await expect(db.getByRole('columnheader', { name: 'Path' })).toBeVisible();
  await expect(db.getByText('Low', { exact: true })).toBeVisible();
  await expect(db.getByRole('cell', { name: 'Inner/Level', exact: true })).toBeVisible();

  // Switched off in the schema editor, the subfolder notes and the column go away
  await db.locator('[data-database-edit]').click();
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel('Include notes from subfolders').uncheck();
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toBeHidden();
  await expect(db.getByText('Low', { exact: true })).toHaveCount(0);
  await expect(db.getByRole('columnheader', { name: 'Path' })).toHaveCount(0);
  await expect(db.getByText('Top', { exact: true })).toBeVisible();
});

test('in read-only mode the cells are plain values, not editors', async ({ page }) => {
  const folder = `Locked ${uid()}`;
  await seed(page.request, [
    { path: `${folder}/${DB_FILE}`, content: SCHEMA },
    { path: `${folder}/Alpha.md`, content: '---\nStatus: todo\nPages: 7\n---\nA' },
  ]);
  await page.addInitScript(() => localStorage.setItem('kladde_readonly', '1'));
  await openFolder(page, folder);
  const db = page.locator('[data-database]');
  await expect(db.getByText('Alpha', { exact: true })).toBeVisible();
  await expect(db.getByText('todo', { exact: true })).toBeVisible();
  await expect(db.getByRole('combobox', { name: 'Status: Alpha' })).toHaveCount(0);
  await expect(db.getByLabel('Pages: Alpha')).toHaveCount(0);
  await expect(db.locator('[data-database-edit], [data-database-add]')).toHaveCount(0);
});
