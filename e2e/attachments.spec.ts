import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, uid, noteTitle, noteMenu, expectOnServer, serverNotes, typeInEditor, editor } from './helpers';

// New notes start in the open folder, duplicating notes, uploading attachments on the attachments page and
// linking an existing attachment into a note: the desktop project only

const hexId = () => [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');

async function seed(request: APIRequestContext, path: string, content: string): Promise<string> {
  const id = hexId();
  const now = Date.now();
  const res = await request.post('/api/sync', { data: { changes: [{ id, baseVersion: 0, path, content, deleted: false, createdAt: now, updatedAt: now }] } });
  expect(res.ok()).toBe(true);
  return id;
}

async function open(page: Page, id: string, title: string) {
  await page.goto(`/n/${id}`);
  await expect(noteTitle(page).first()).toHaveValue(title, { timeout: 15_000 });
}

/** A tiny valid PNG */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test('the new note button starts in the folder of the open note', async ({ page }) => {
  const folder = `Ordner ${uid()}`;
  const id = await seed(page.request, `${folder}/Drin.md`, 'x');
  await open(page, id, 'Drin');
  await page.getByRole('button', { name: 'New note', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New note' });
  await expect(dialog.getByRole('combobox', { name: 'Folder' })).toContainText(folder);
});

test('duplicates a note next to itself as "(Copy)", without its frontmatter id', async ({ page }) => {
  const folder = `Dup ${uid()}`;
  const id = await seed(page.request, `${folder}/Vorlage.md`, '---\nid: abc-123\nstatus: open\n---\nDer Inhalt.\n');
  await open(page, id, 'Vorlage');
  await noteMenu(page, 'Duplicate');
  await expect(noteTitle(page)).toHaveValue('Vorlage (Copy)');
  await expect
    .poll(async () => (await serverNotes(page.request)).find((n) => n.path === `${folder}/Vorlage (Copy).md`)?.content ?? '', { timeout: 15_000 })
    .toBe('---\nstatus: open\n---\nDer Inhalt.\n');
});

test('uploads attachments on the attachments page and links one into a note', async ({ page }) => {
  const name = `bild-${uid()}.png`;
  await page.goto('/files');
  await page.locator('[data-files-upload]').waitFor();
  await page.locator('input[type="file"][multiple]').setInputFiles({ name, mimeType: 'image/png', buffer: PNG });
  await expect(page.getByText('Uploaded 1 attachment.')).toBeVisible();
  await expect(page.locator('article', { hasText: name })).toBeVisible();

  const id = await seed(page.request, `Inbox/Mit Anhang ${uid()}.md`, 'Text\n');
  await page.goto(`/n/${id}`);
  await typeInEditor(page, '\n/existing');
  await page.getByRole('option', { name: /Existing attachment/ }).click();
  const picker = page.getByRole('dialog', { name: 'Insert attachment' });
  await picker.getByRole('searchbox').fill(name);
  await picker.getByRole('button', { name: new RegExp(name.replace('.', '\\.')) }).click();
  await expect(picker).toBeHidden();
  await expectOnServer(page.request, id, new RegExp(`!\\[${name.replace('.', '\\.')}\\]\\(/api/files/[\\w-]+\\)`));
  await expect(editor(page).locator('img[src^="/api/files/"]').first()).toBeVisible();
});
