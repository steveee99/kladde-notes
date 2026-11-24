import { test as base, expect, type APIRequestContext, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Stored session of a test account (written by auth.setup.ts) */
export const authFile = (user: string) => path.join(here, '.auth', `${user}.json`);

/** A suffix that keeps names unique across tests and projects running against the same server */
export const uid = () => Math.random().toString(36).slice(2, 8);

interface Fixtures {
  /** Opens a second, independent browser (own IndexedDB) signed in as `user`, with the project's device settings */
  openAs: (user: string) => Promise<Page>;
}

export const test = base.extend<Fixtures>({
  storageState: authFile('anna'),
  openAs: async ({ browser }, use, testInfo) => {
    const contexts: BrowserContext[] = [];
    await use(async (user) => {
      const context = await newContextAs(browser, testInfo, user);
      contexts.push(context);
      return context.newPage();
    });
    for (const c of contexts) await c.close();
  },
});

export { expect };

export async function newContextAs(browser: Browser, testInfo: TestInfo, user: string): Promise<BrowserContext> {
  const { viewport, hasTouch, isMobile, locale, timezoneId, baseURL } = testInfo.project.use;
  return browser.newContext({ viewport, hasTouch, isMobile, locale, timezoneId, baseURL, storageState: authFile(user) });
}

export async function expectSynced(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Synced' }).first()).toBeVisible({ timeout: 15_000 });
}

/** The title field of the open note */
export const noteTitle = (page: Page) => page.locator('textarea.note-title');

/** The CodeMirror editor of the open note */
export const editor = (page: Page) => page.locator('.cm-content').first();

/** Creates a note through the UI (rail button on desktop, the capture sheet on phones) and opens it; returns its id */
export async function createNote(page: Page, title: string, body?: string): Promise<string> {
  const newNote = page.getByRole('button', { name: 'New note', exact: true }).first();
  const capture = page.getByRole('button', { name: 'Capture' });
  // Phones and tablets have no rail: the capture button on the home page offers a full note
  if (page.url() === 'about:blank' || !((await newNote.isVisible()) || (await capture.isVisible()))) await page.goto('/');
  if (await newNote.isVisible()) {
    await newNote.click();
  } else {
    await capture.click();
    await page.getByRole('button', { name: /full note/i }).click();
  }
  const before = page.url();
  const dialogTitle = page.locator('input[placeholder="Title"]');
  await dialogTitle.fill(title);
  await dialogTitle.press('Enter');
  await expect(dialogTitle).toBeHidden();
  await page.waitForURL((url) => /\/n\/[0-9a-f]+/.test(url.pathname) && url.href !== before);
  await expect(noteTitle(page)).toHaveValue(title);
  if (body !== undefined) await typeInEditor(page, body);
  return noteIdOf(page);
}

export const noteIdOf = (page: Page) => /\/n\/([0-9a-f]+)/.exec(page.url())?.[1] ?? '';

/** Types at the end of the note */
export async function typeInEditor(page: Page, text: string): Promise<void> {
  const ed = editor(page);
  await ed.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(text);
}

export interface ServerNote {
  id: string;
  path: string;
  content: string;
  deleted: boolean;
  version: number;
}

/** What the server has for the signed-in account of this request context */
export async function serverNotes(request: APIRequestContext): Promise<ServerNote[]> {
  const res = await request.get('/api/sync?since=0');
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { notes: ServerNote[] }).notes.filter((n) => !n.deleted);
}

export async function serverNote(request: APIRequestContext, id: string): Promise<ServerNote | undefined> {
  return (await serverNotes(request)).find((n) => n.id === id);
}

/** Waits until the server has the note with content matching `pattern` */
export async function expectOnServer(request: APIRequestContext, id: string, pattern: RegExp | string): Promise<void> {
  await expect
    .poll(async () => (await serverNote(request, id))?.content ?? '', { timeout: 15_000 })
    .toMatch(typeof pattern === 'string' ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : pattern);
}

/** Opens a note's ⋮ menu and picks an entry */
export async function noteMenu(page: Page, item: string | RegExp): Promise<void> {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

/** Opens Settings → Features and turns the feature on (when it is off); `id` is its `data-feature` name */
export async function enableFeature(page: Page, id: string): Promise<void> {
  await page.goto('/settings');
  await page.locator('[data-open-features]').click();
  const dialog = page.locator('[data-features-dialog]');
  await expect(dialog).toBeVisible();
  const activate = dialog.locator(`[data-feature="${id}"] [data-activate="${id}"]`);
  if (await activate.isVisible()) {
    await activate.click();
    await expect(dialog.locator(`[data-feature-detail="${id}"]`)).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}

export interface DatabaseGroup {
  id: string;
  key: string;
  ticket: string;
}

/** A group with tickets on, a project in `Plan` and database notes (also copies of one) at the top and in the folder (#58, #76) */
export async function groupWithDatabases(request: APIRequestContext): Promise<DatabaseGroup> {
  const key = `H${[...Array(4)].map(() => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('')}`;
  const { id } = (await (await request.post('/api/groups', { data: { name: `Hidden ${key}` } })).json()) as { id: string };
  expect((await request.put(`/api/groups/${id}/features`, { data: { tickets: true } })).ok()).toBe(true);
  const ticket = `Ticket ${key}`;
  const db = `_database-${crypto.randomUUID()}`;
  const project = `---\ntype: database\nproject:\n  key: ${key}\n  workflow: [Open, Done]\n  active: []\n  done: [Done]\n---\n`;
  const plain = '---\ntype: database\nviews:\n  - name: Table\n    type: table\n---\n';
  const now = Date.now();
  const notes = [
    { path: `Plan/${db}.md`, content: project },
    { path: `Plan/${db} 2.md`, content: project },
    { path: `Plan/${db} (Conflict 1-2-26, 3-04 PM).md`, content: project },
    { path: `Plan/${ticket}.md`, content: `---\ntype: ticket\nid: ${key}-?\nstatus: Open\n---\n` },
    { path: `_database-${crypto.randomUUID()}.md`, content: plain },
    { path: `Top ${key}.md`, content: '# Top' },
  ];
  const changes = notes.map((n) => ({ ...n, id: crypto.randomUUID().replace(/-/g, ''), baseVersion: 0, deleted: false, createdAt: now, updatedAt: now, group: id }));
  expect((await request.post('/api/sync', { data: { changes } })).ok()).toBe(true);
  return { id, key, ticket };
}

/** The database notes of `groupWithDatabases` show nowhere, its project still works */
export async function expectDatabasesHidden(page: Page, group: DatabaseGroup): Promise<void> {
  const tree = page.locator(`[data-tree-group="${group.id}"]`);
  const none = () => expect(page.getByText('_database')).toHaveCount(0);
  await page.goto(`/g/${group.id}/Plan`);
  await expect(page.locator(`[data-project="${group.key}"]`).getByText(group.ticket, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(tree.getByText(group.ticket, { exact: true })).toBeVisible();
  await none();
  await page.goto(`/g/${group.id}`);
  await expect(tree.getByText(`Top ${group.key}`, { exact: true })).toBeVisible();
  await none();
  await page.goto(`/activity?group=${group.id}`);
  await expect(page.locator('[data-activity-kind="created"]').first()).toBeVisible();
  await none();
  for (const path of ['/groups', '/projects', '/notes', '/']) {
    await page.goto(path);
    await expect(tree).toBeVisible();
    await expect(page.getByRole('main').getByRole('heading').first()).toBeVisible();
    await none();
  }
}
