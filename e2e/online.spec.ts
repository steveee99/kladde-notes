import { test, expect, editor, expectOnServer, expectSynced, noteTitle, uid } from './helpers';
import { E2E_PASSWORD } from './accounts.mjs';

// Online mode (KLADDE_MODE=online, its own test server): the device keeps a catalog of the notes and loads a note's
// text when it opens; search and backlinks come from the server, renames rewrite links there
test('loads notes when they open and keeps links working across renames', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 800 } });
  const api = context.request;
  expect((await api.post('/api/auth/password/login', { data: { username: 'cara', password: E2E_PASSWORD } })).ok()).toBe(true);
  const me = (await (await api.get('/api/auth/me')).json()) as { id: string; online?: boolean };
  expect(me.online).toBe(true);

  const tag = uid();
  const now = Date.now();
  const id = (n: number) => `online${tag.replace(/[^A-Za-z0-9]/g, '')}${n}`.slice(0, 40);
  const source = { id: id(1), path: `Archiv ${tag}/Alt ${tag}.md`, content: `Langer Text nur auf dem Server.\nSiehe [[Ziel ${tag}]].\n` };
  const target = { id: id(2), path: `Projekt ${tag}/Ziel ${tag}.md`, content: 'Das Ziel.\n' };
  const res = await api.post('/api/sync', { data: { changes: [source, target].map((n) => ({ ...n, baseVersion: 0, deleted: false, createdAt: now, updatedAt: now })) } });
  expect(res.ok()).toBe(true);

  const page = await context.newPage();
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('kladde_lang', 'en'));
  await page.reload();
  await expectSynced(page);

  // The folder tree knows the note, the device does not hold its text
  await expect(page.getByRole('complementary', { name: 'Folders' }).getByText(`Archiv ${tag}`, { exact: true })).toBeVisible();
  const stored = () =>
    page.evaluate(
      async ({ dbName, noteId }) =>
        new Promise<string | null>((resolve) => {
          const open = indexedDB.open(dbName);
          open.onsuccess = () => {
            const req = open.result.transaction('notes').objectStore('notes').get(noteId);
            req.onsuccess = () => resolve((req.result as { content?: string } | undefined)?.content ?? null);
            req.onerror = () => resolve(null);
          };
        }),
      { dbName: `kladde-online-${me.id}`, noteId: source.id }
    );
  expect(await stored()).toBeNull();

  // The server searches the texts the device does not hold
  await page.keyboard.press('ControlOrMeta+k');
  const box = page.getByRole('combobox', { name: 'Search' });
  await box.fill(`nur auf dem Server`);
  await expect(page.getByRole('option', { name: new RegExp(`Alt ${tag}`) })).toBeVisible();
  await expect(page.getByRole('option', { name: new RegExp(`Alt ${tag}`) })).toContainText('nur auf dem Server');
  await page.keyboard.press('Escape');
  expect(await stored()).toBeNull();

  // The target's backlink comes from the server: the linking note's text is still not on the device
  await page.goto(`/n/${target.id}`);
  await expect(page.getByRole('heading', { name: 'Backlinks · 1' })).toBeVisible();
  expect(await stored()).toBeNull();

  // Opening loads the text; an edit reaches the server with the rest of the text
  await page.goto(`/n/${source.id}`);
  await expect(editor(page)).toContainText('Langer Text nur auf dem Server.');
  expect(await stored()).toContain('Langer Text');
  await editor(page).getByText('Langer Text nur auf dem Server.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Ergänzt.');
  await expectOnServer(api, source.id, /Langer Text nur auf dem Server\. Ergänzt\.\nSiehe \[\[Ziel/);

  // Renaming the target (its text was never loaded here) rewrites the link on the server
  await page.goto(`/n/${target.id}`);
  await expect(editor(page)).toContainText('Das Ziel.');
  await noteTitle(page).fill(`Neues Ziel ${tag}`);
  await noteTitle(page).press('Enter');
  await expectOnServer(api, source.id, `[[Neues Ziel ${tag}]]`);
  await expectOnServer(api, target.id, 'Das Ziel.');
  await context.close();
});

// Stage 3: tasks of notes the device never opened come from the server; database folders load in full
test('shows tasks from the server and database folders with their rows', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 800 } });
  const api = context.request;
  expect((await api.post('/api/auth/password/login', { data: { username: 'cara', password: E2E_PASSWORD } })).ok()).toBe(true);

  const me = (await (await api.get('/api/auth/me')).json()) as { id: string };
  const tag = uid();
  const now = Date.now();
  const id = (n: number) => `onl3${tag.replace(/[^A-Za-z0-9]/g, '')}${n}`.slice(0, 40);
  const folder = `Bücher ${tag}`;
  const notes = [
    { id: id(1), path: `Inbox/Liste ${tag}.md`, content: `# Liste\n\n- [ ] Aufgabe vom Server ${tag}\n` },
    { id: id(2), path: `${folder}/_database-${crypto.randomUUID()}.md`, content: '---\ntype: database\nproperties:\n  - name: Pages\n    type: number\nviews:\n  - name: Table\n    type: table\n---\n' },
    { id: id(3), path: `${folder}/Alpha ${tag}.md`, content: '---\nPages: 300\n---\nAlpha' },
  ];
  const res = await api.post('/api/sync', { data: { changes: notes.map((n) => ({ ...n, baseVersion: 0, deleted: false, createdAt: now, updatedAt: now })) } });
  expect(res.ok()).toBe(true);

  const page = await context.newPage();
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('kladde_lang', 'en'));
  await page.goto('/tasks');
  await expectSynced(page);

  // The task's note was never opened: the row comes from the server's index, ticking it loads the note and writes it
  const row = page.getByText(`Aufgabe vom Server ${tag}`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  const held = await page.evaluate(
    async ({ dbName, noteId }) =>
      new Promise<boolean>((resolve) => {
        const open = indexedDB.open(dbName);
        open.onsuccess = () => {
          const req = open.result.transaction('notes').objectStore('notes').get(noteId);
          req.onsuccess = () => resolve(!!req.result);
          req.onerror = () => resolve(false);
        };
      }),
    { dbName: `kladde-online-${me.id}`, noteId: notes[0].id }
  );
  expect(held).toBe(false);
  await page.getByRole('checkbox', { name: `Aufgabe vom Server ${tag}` }).first().click();
  await expectOnServer(api, notes[0].id, `- [x] Aufgabe vom Server ${tag}`);

  // The database folder's notes are on the device: the table shows the row's value
  await page.goto(`/f/${encodeURIComponent(folder)}`);
  const db = page.locator('[data-database]');
  await expect(db.getByText(`Alpha ${tag}`, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(db.getByLabel(`Pages: Alpha ${tag}`)).toHaveValue('300');
  await context.close();
});

test('builds the graph and runs query blocks on the server, loads rows of subfolders', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 800 } });
  const api = context.request;
  expect((await api.post('/api/auth/password/login', { data: { username: 'cara', password: E2E_PASSWORD } })).ok()).toBe(true);

  const me = (await (await api.get('/api/auth/me')).json()) as { id: string };
  const tag = uid();
  const now = Date.now();
  const id = (n: number) => `onl4${tag.replace(/[^A-Za-z0-9]/g, '')}${n}`.slice(0, 40);
  const project = `Projekt ${tag}`;
  const shelf = `Regal ${tag}`;
  const notes = [
    { id: id(1), path: `Inbox/Start ${tag}.md`, content: `Weiter zu [[Ziel ${tag}]]\n` },
    { id: id(2), path: `Inbox/Ziel ${tag}.md`, content: 'Ende\n' },
    { id: id(3), path: `${project}/Eins ${tag}.md`, content: '---\nstatus: aktiv\n---\n' },
    { id: id(4), path: `${project}/Zwei ${tag}.md`, content: '---\nstatus: fertig\n---\n' },
    { id: id(5), path: `Inbox/Abfrage ${tag}.md`, content: `# Abfrage\n\n\`\`\`query\nTABLE status FROM "${project}"\n\`\`\`\n` },
    { id: id(6), path: `${shelf}/_database-${crypto.randomUUID()}.md`, content: '---\ntype: database\nsubfolders: true\nproperties:\n  - name: Pages\n    type: number\nviews:\n  - name: Table\n    type: table\n---\n' },
    { id: id(7), path: `${shelf}/Unten/Tief ${tag}.md`, content: '---\nPages: 42\n---\nTief' },
  ];
  const res = await api.post('/api/sync', { data: { changes: notes.map((n) => ({ ...n, baseVersion: 0, deleted: false, createdAt: now, updatedAt: now })) } });
  expect(res.ok()).toBe(true);
  const held = (page: import('@playwright/test').Page, noteId: string) =>
    page.evaluate(
      async ({ dbName, noteId }) =>
        new Promise<boolean>((resolve) => {
          const open = indexedDB.open(dbName);
          open.onsuccess = () => {
            const req = open.result.transaction('notes').objectStore('notes').get(noteId);
            req.onsuccess = () => resolve(!!(req.result as { content?: string } | undefined)?.content);
            req.onerror = () => resolve(false);
          };
        }),
      { dbName: `kladde-online-${me.id}`, noteId }
    );

  const page = await context.newPage();
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('kladde_lang', 'en'));
  await page.goto(`/graph?focus=${notes[0].id}`);
  await expectSynced(page);

  // The link between two notes the device never opened comes with the server's graph
  await expect(page.getByText('2 notes · 1 links')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('canvas')).toBeVisible();
  expect(await held(page, notes[0].id)).toBe(false);

  // The query block runs on the server over notes whose texts are not on the device
  await page.goto(`/n/${notes[4].id}`);
  const block = page.locator('.wz-query-block');
  await expect(block.getByText('aktiv', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(block.getByText('fertig', { exact: true })).toBeVisible();
  expect(await held(page, notes[2].id)).toBe(false);

  // A table that takes in its subfolders gets the rows below it in full
  await page.goto(`/f/${encodeURIComponent(shelf)}`);
  const db = page.locator('[data-database]');
  await expect(db.getByLabel(`Pages: Tief ${tag}`)).toHaveValue('42', { timeout: 15_000 });
  await context.close();
});
