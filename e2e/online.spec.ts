import { test, expect, editor, expectOnServer, expectSynced, noteTitle, uid } from './helpers';
import { E2E_PASSWORD } from './accounts.mjs';

// Online mode (KLADDE_MODE=online, its own test server): the device keeps a catalog of the notes and loads a note's
// text when it opens; renames rewrite links on the server
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
