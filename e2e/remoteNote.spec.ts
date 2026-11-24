import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, editor, expectOnServer, serverNote, serverNotes, uid } from './helpers';

// Remote notes: a Markdown file from GitLab (e2e/fixtures/fakeGitlab.mjs), always live and read-only

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const hexId = () => [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');

/** Address of the fake GitLab, as the server was configured with it */
async function gitlabUrl(request: APIRequestContext): Promise<string> {
  const hosts = (await (await request.get('/api/remote-notes/hosts')).json()) as { url: string }[];
  return hosts[0].url;
}

async function putFile(request: APIRequestContext, base: string, project: string, path: string, data: string | Buffer, ref = 'main') {
  expect((await request.put(`${base}/__files?${new URLSearchParams({ project, ref, path })}`, { data: Buffer.from(data) })).ok()).toBe(true);
}

async function seed(request: APIRequestContext, notes: { path: string; content: string }[]): Promise<Record<string, string>> {
  const now = Date.now();
  const ids: Record<string, string> = {};
  const changes = notes.map((n) => ({ id: (ids[n.path] = hexId()), baseVersion: 0, deleted: false, createdAt: now, updatedAt: now, ...n }));
  expect((await request.post('/api/sync', { data: { changes } })).ok()).toBe(true);
  return ids;
}

const state = (page: Page) => page.locator('[data-remote-note]');

test('a remote note is made in a dialog, shows the document live and follows its variables', async ({ page }) => {
  const gitlab = await gitlabUrl(page.request);
  const name = uid();
  const project = `team/docs-${name}`;
  const top = `Remote ${name}`;
  const text = [
    '---',
    'title: Not the note',
    '---',
    '# Handbook v1',
    '',
    'See [setup](setup.md), ![pic](img/a.png) and [[Secret note]] {{var:project}}.',
    '',
    '- [ ] remote task',
    '',
    '| A | B |',
    '|---|---|',
    '| [[Cell]] | x |',
    '',
    '![[Secret note]]',
    '',
    '```query',
    'TABLE title',
    '```',
    '',
  ].join('\n');
  await putFile(page.request, gitlab, project, 'docs/handbook.md', text);
  await putFile(page.request, gitlab, project, 'docs/img/a.png', PNG);
  await putFile(page.request, gitlab, `team/other-${name}`, 'docs/handbook.md', '# Other project\n');
  await seed(page.request, [
    { path: `${top}/_variables.md`, content: `---\ntype: variables\nvariables:\n  project: ${project}\n---\n` },
    { path: `${top}/Secret note.md`, content: 'Vault content\n' },
  ]);

  await page.goto(`/f/${encodeURIComponent(top)}`);
  await expect(page.getByText('Secret note').first()).toBeVisible();
  await page.getByRole('main').getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('button', { name: 'GitLab/GitHub note' }).click();
  const dialog = page.locator('[data-remote-dialog]');
  const address = dialog.getByRole('combobox', { name: 'Address of the document' });
  await address.fill('https://evil.example.com/a/b/-/blob/main/x.md');
  await expect(dialog.locator('[data-remote-problem="host_not_configured"]')).toBeVisible();
  await address.fill('');
  await address.pressSequentially(`${gitlab}/{{pro`.replace('pro', 'var:pro'));
  await expect(dialog.getByRole('option')).toContainText(project);
  await address.press('Enter');
  await expect(address).toHaveValue(`${gitlab}/{{var:project}}`);
  await address.pressSequentially('/-/blob/main/docs/handbook.md');
  await expect(dialog.locator('[data-remote-preview]')).toContainText(`${gitlab}/${project}/-/blob/main/docs/handbook.md`);
  await expect(dialog.locator('[data-remote-target]')).toContainText(`GitLab · ${project} · docs/handbook.md`);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await page.waitForURL(/\/n\/[0-9a-f]+/);
  const id = /\/n\/([0-9a-f]+)/.exec(page.url())![1];

  // Live text, with nothing of it reaching into the vault
  await expect(editor(page).locator('.cm-h1')).toHaveText('Handbook v1');
  await expect(editor(page)).not.toContainText('Not the note');
  await expect(editor(page)).toContainText('[[Secret note]] {{var:project}}');
  await expect(editor(page)).not.toContainText('Vault content');
  await expect(page.locator('.wz-embed, .wz-query-block, .cm-wikilink')).toHaveCount(0);
  await expect(editor(page).getByRole('link', { name: 'setup' })).toHaveAttribute('href', `${gitlab}/${project}/-/blob/main/docs/setup.md`);
  const img = editor(page).locator('img.cm-img');
  await expect(img).toHaveAttribute('src', new RegExp(`^/api/remote-notes/${id}/image`));
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
  await expect(state(page).locator('[data-remote-source]')).toHaveAttribute('href', `${gitlab}/${project}/-/blob/main/docs/handbook.md`);
  await expect(state(page)).toContainText('abcdef01');

  // Read-only: no toolbar, no typing, no task, no dropped file
  await expect(page.locator('.note-toolbar')).toHaveCount(0);
  await expect(editor(page)).toHaveAttribute('contenteditable', 'false');
  await expect(editor(page).locator('.cm-checkbox')).toBeDisabled();
  await editor(page).click();
  await page.keyboard.type('typed');
  await page.keyboard.press('ControlOrMeta+b');
  await editor(page).evaluate((el) => {
    const data = new DataTransfer();
    data.items.add(new File(['x'], 'x.png', { type: 'image/png' }));
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(editor(page)).not.toContainText('typed');
  await expect(editor(page)).not.toContainText('x.png');
  const stored = `---\ntype: remote\nsource: "${gitlab}/{{var:project}}/-/blob/main/docs/handbook.md"\n---\n`;
  expect((await serverNote(page.request, id))!.content).toBe(stored);

  // The document changes upstream
  await putFile(page.request, gitlab, project, 'docs/handbook.md', '# Handbook v2\n');
  await page.locator('[data-remote-reload]').click();
  await expect(editor(page).locator('.cm-h1')).toHaveText('Handbook v2');
  await page.goto('/');
  await putFile(page.request, gitlab, project, 'docs/handbook.md', '# Handbook v3\n');
  await page.waitForTimeout(5200); // the server asks again after a few seconds
  await page.goto(`/n/${id}`);
  await expect(editor(page).locator('.cm-h1')).toHaveText('Handbook v3');

  // The variable changes on another device
  const def = (await serverNotes(page.request)).find((n) => n.path === `${top}/_variables.md`)!;
  const now = Date.now();
  await page.request.post('/api/sync', { data: { changes: [{ ...def, baseVersion: def.version, content: def.content.replace('docs-', 'other-'), createdAt: now, updatedAt: now }] } });
  await expect(editor(page).locator('.cm-h1')).toHaveText('Other project', { timeout: 15_000 });

  // The source is changed through the dialog
  await page.locator('[data-remote-edit]').click();
  await address.fill(`${gitlab}/${project}/-/blob/main/gone.md`);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('[data-remote-state="not_found"]')).toBeVisible();
  await expectOnServer(page.request, id, 'gone.md');
  expect((await serverNote(page.request, id))!.content).toBe(`---\ntype: remote\nsource: ${gitlab}/${project}/-/blob/main/gone.md\n---\n`);
});

test('embeds show the document, a public link a placeholder, and readers cannot change the source', async ({ page, openAs, browser }) => {
  const gitlab = await gitlabUrl(page.request);
  const name = uid();
  await putFile(page.request, gitlab, `team/e-${name}`, 'README.md', '# Title\n\nIntro text\n\n## Part\n\nPart text\n', 'HEAD');
  const ids = await seed(page.request, [
    { path: `E ${name}/Remote ${name}.md`, content: `---\ntype: remote\nsource: ${gitlab}/team/e-${name}\n---\n` },
    { path: `E ${name}/Outer.md`, content: `Outer\n\n![[Remote ${name}]]\n\n![[Remote ${name}#Part]]\n\nEnd\n` },
  ]);
  const note = ids[`E ${name}/Remote ${name}.md`];
  await page.goto(`/n/${ids[`E ${name}/Outer.md`]}`);
  const embeds = page.locator('.wz-embed-body');
  await expect(embeds.first()).toContainText('Intro text');
  await expect(embeds.nth(1)).toContainText('Part text');
  await expect(embeds.nth(1)).not.toContainText('Intro text');

  const { publicToken } = (await (await page.request.put(`/api/notes/${note}/public`, { data: { enabled: true } })).json()) as { publicToken: string };
  const guest = await (await browser.newContext({ locale: 'en-US', storageState: { cookies: [], origins: [] } })).newPage();
  await guest.goto(`/s/${publicToken}`);
  await expect(guest.locator('[data-remote-public]')).toBeVisible();
  expect(await (await guest.request.get(`/api/public/${publicToken}`)).text()).not.toContain('127.0.0.1');
  expect((await guest.request.get(`/api/remote-notes/${note}`)).status()).toBe(401);
  await guest.context().close();

  expect((await page.request.put(`/api/notes/${note}/shares`, { data: { username: 'ben', canWrite: false } })).ok()).toBe(true);
  const ben = await openAs('ben');
  await ben.goto(`/n/${note}`);
  await expect(editor(ben)).toContainText('Intro text');
  await expect(ben.locator('[data-remote-edit]')).toHaveCount(0);
  const cara = await openAs('cara');
  expect((await cara.request.get(`/api/remote-notes/${note}`)).status()).toBe(404);
});

test('a remote note is usable on a phone and has no accessibility problems', async ({ page }) => {
  const gitlab = await gitlabUrl(page.request);
  const name = uid();
  await putFile(page.request, gitlab, `team/p-${name}`, 'a.md', '# Phone\n\nText\n');
  const ids = await seed(page.request, [{ path: `P ${name}.md`, content: `---\ntype: remote\nsource: ${gitlab}/team/p-${name}/-/blob/main/a.md\n---\n` }]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/n/${ids[`P ${name}.md`]}`);
  await expect(editor(page)).toContainText('Text');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.locator('[data-remote-edit]').click();
  await expect(page.locator('[data-remote-dialog]')).toBeVisible();
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const results = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' ')}`)).toEqual([]);
});

test('/gitlab makes a note beside this one and embeds it, and exports contain the document', async ({ page }) => {
  const gitlab = await gitlabUrl(page.request);
  const name = uid();
  await putFile(page.request, gitlab, `team/s-${name}`, 'guide.md', '# Guide\n\n[other](x.md) ![p](p.png)\n');
  const ids = await seed(page.request, [{ path: `S ${name}/Host.md`, content: 'Start\n' }]);
  await page.goto(`/n/${ids[`S ${name}/Host.md`]}`);
  await editor(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('/gitlab');
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('GitLab/GitHub note');
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  const dialog = page.locator('[data-remote-dialog]');
  await dialog.getByRole('combobox', { name: 'Address of the document' }).fill(`${gitlab}/team/s-${name}/-/blob/main/guide.md`);
  await dialog.getByPlaceholder(/^Title/).fill(`Guide ${name}`);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).toBeHidden();
  await expectOnServer(page.request, ids[`S ${name}/Host.md`], `![[Guide ${name}]]`);
  await expect(page.locator('.wz-embed-body')).toContainText('Guide', { timeout: 15_000 });
  const made = (await serverNotes(page.request)).find((n) => n.path === `S ${name}/Guide ${name}.md`)!;
  await page.goto(`/n/${made.id}`);
  await expect(editor(page).locator('.cm-h1')).toHaveText('Guide');
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Export' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /markdown \(\.md\)/i }).click();
  const file = await (await download).createReadStream();
  let text = '';
  for await (const c of file) text += c;
  const web = `${gitlab}/team/s-${name}/-`;
  expect(text).toBe(`# Guide\n\n[other](${web}/blob/main/x.md) ![p](${web}/raw/main/p.png)\n`);
});
