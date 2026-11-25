import { test, expect, editor, expectOnServer, uid } from './helpers';
import type { APIRequestContext } from '@playwright/test';

// Tabs (pin, close others/beside), inline variables (`!{{…}}`), variables in properties and the note width

const hexId = () => [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');

async function seed(request: APIRequestContext, notes: { path: string; content: string }[]): Promise<string[]> {
  const now = Date.now();
  const changes = notes.map((n) => ({ id: hexId(), baseVersion: 0, deleted: false, createdAt: now, updatedAt: now, ...n }));
  expect((await request.post('/api/sync', { data: { changes } })).ok()).toBe(true);
  return changes.map((c) => c.id);
}

test('tabs: a pinned tab stays, others close to the side or all at once', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'the tab row is shown on the desktop');
  const folder = `Tabs ${uid()}`;
  const [a, b, c] = await seed(page.request, ['Alpha', 'Bravo', 'Charlie'].map((t) => ({ path: `${folder}/${t}.md`, content: `${t}\n` })));
  for (const id of [a, b, c]) {
    await page.goto(`/n/${id}`);
    await expect(page.locator(`[data-note-tab="${id}"]`)).toBeVisible({ timeout: 15_000 });
  }
  const tab = (id: string) => page.locator(`[data-note-tab="${id}"]`);

  // Pinning moves the tab to the front and replaces its close button
  await tab(c).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Pin' }).click();
  await expect(tab(c)).toHaveAttribute('data-pinned', 'true');
  await expect(tab(c).getByRole('button', { name: /^Close tab/ })).toHaveCount(0);
  await expect(page.locator('[data-note-tab]').first()).toHaveAttribute('data-note-tab', c);

  // "Close others" keeps the pinned tab
  await tab(a).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Close others' }).click();
  await expect(tab(b)).toHaveCount(0);
  await expect(tab(a)).toBeVisible();
  await expect(tab(c)).toBeVisible();

  // "Close tabs to the right" of the pinned one closes the open note's tab and shows the pinned note
  await page.goto(`/n/${a}`);
  await tab(c).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Close tabs to the right' }).click();
  await expect(tab(a)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/n/${c}$`));

  // A pinned tab does not close by middle click; unpinned it does
  await tab(c).click({ button: 'middle' });
  await expect(tab(c)).toBeVisible();
  await tab(c).getByRole('button', { name: /^Unpin tab/ }).click();
  await expect(tab(c)).not.toHaveAttribute('data-pinned', 'true');
});

test('inline variables put their value in, placeholders in the properties show theirs', async ({ page }) => {
  const folder = `Inline ${uid()}`;
  const [noteId] = await seed(page.request, [
    { path: `${folder}/Note.md`, content: '---\nkunde: Firma {{var:customer}}\n---\nText\n' },
    { path: `${folder}/_variables-${crypto.randomUUID()}.md`, content: '---\ntype: variables\nvariables:\n  customer: ACME\n---\n' },
  ]);
  await page.goto(`/n/${noteId}`);
  // The property shows the value; its input shows the placeholder while it is edited
  const input = page.locator('.wz-prop-input[aria-label="kunde"]');
  await expect(input).toHaveValue('Firma ACME', { timeout: 15_000 });
  await input.focus();
  await expect(input).toHaveValue('Firma {{var:customer}}');
  await input.blur();
  await expect(input).toHaveValue('Firma ACME');

  // `!{{…}}` becomes plain text at once
  const ed = editor(page);
  await ed.getByText('Text').click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' !{{var:customer}}');
  await expect(ed).toContainText('Text ACME');
  await expectOnServer(page.request, noteId, /Text ACME\n/);
});

test('the note width follows the setting', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'wide enough for every width on the desktop only');
  const [noteId] = await seed(page.request, [{ path: `Width ${uid()}/Wide.md`, content: 'Text\n' }]);
  await page.goto(`/n/${noteId}`);
  const container = page.locator('.content-container').first();
  await expect(container).toBeVisible({ timeout: 15_000 });
  expect(await container.evaluate((el) => getComputedStyle(el).maxWidth)).toBe('1200px');

  await page.goto('/settings/editor');
  await page.getByRole('combobox', { name: 'Note width' }).click();
  await page.getByRole('option', { name: /Narrow/ }).click();
  await page.goto(`/n/${noteId}`);
  expect(await page.locator('.content-container').first().evaluate((el) => getComputedStyle(el).maxWidth)).toBe('1000px');
});
