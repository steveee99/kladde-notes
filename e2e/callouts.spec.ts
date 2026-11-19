import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, editor, uid } from './helpers';

// Callouts (#86): `> [!type] Title` quotes as Material 3 boxes with icon and color role, `-`/`+` collapsible,
// inserted with /callout, the same on public links and in the PDF export

const hexId = () => [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');

const NOTE = `Intro

> [!warning] Strom abschalten
> Vor der Arbeit die Sicherung ausschalten.

> [!tip]- Mehr Details
> Versteckter Text im Block.

> [!faq]
> Ohne eigenen Titel.

> Nur ein Zitat
`;

async function seedNote(request: APIRequestContext, path: string, content: string): Promise<string> {
  const id = hexId();
  const now = Date.now();
  const res = await request.post('/api/sync', { data: { changes: [{ id, baseVersion: 0, path, content, deleted: false, createdAt: now, updatedAt: now }] } });
  expect(res.ok()).toBe(true);
  return id;
}

async function openNote(page: Page, id: string, title: string) {
  await page.goto(`/n/${id}`);
  await expect(page.locator('textarea.note-title')).toHaveValue(title, { timeout: 15_000 });
}

test('callouts show as colored boxes with icon, title and a fold button', async ({ page }) => {
  const title = `Callouts ${uid()}`;
  const id = await seedNote(page.request, `${title}.md`, NOTE);
  await openNote(page, id, title);

  const heads = page.locator('.cm-callout-head');
  await expect(heads).toHaveCount(3);
  await expect(heads.nth(0)).toHaveAttribute('data-callout', 'warning');
  await expect(heads.nth(0)).toHaveText('Strom abschalten');
  await expect(page.locator('.cm-callout-warn').filter({ hasText: 'Sicherung ausschalten' })).toBeVisible();
  // Aliases take their kind's color and, without a title, its name
  await expect(heads.nth(2)).toHaveAttribute('data-callout', 'question');
  await expect(heads.nth(2)).toHaveText('Question');
  // A plain quote stays a quote
  await expect(page.locator('.cm-quote').filter({ hasText: 'Nur ein Zitat' })).toBeVisible();

  // `-`: collapsed until the button opens it; the note text does not change
  const fold = page.getByRole('button', { name: 'Expand Mehr Details' });
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('Versteckter Text im Block.')).toHaveCount(0);
  await fold.click();
  await expect(page.getByText('Versteckter Text im Block.')).toBeVisible();
  const close = page.getByRole('button', { name: 'Collapse Mehr Details' });
  await expect(close).toHaveAttribute('aria-expanded', 'true');
  await close.click();
  await expect(page.getByText('Versteckter Text im Block.')).toHaveCount(0);

  const axe = await new AxeBuilder({ page }).include('.cm-content').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
});

test('/callout inserts a callout and the PDF export draws it', async ({ page }) => {
  const title = `Slash callout ${uid()}`;
  const id = await seedNote(page.request, `${title}.md`, 'Start\n');
  await openNote(page, id, title);
  await editor(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\n/callout');
  await page.getByRole('option', { name: /^Callout: warning/ }).click();
  // The title is selected: typing replaces it
  await page.keyboard.type('Achtung');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.type('Text');
  await page.keyboard.press('ControlOrMeta+Home');
  await expect(page.locator('.cm-callout-head[data-callout="warning"]')).toHaveText('Achtung');

  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /^Export/ }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /^PDF/ }).click();
  const pdf = (await readFile((await (await download).path())!)).toString('latin1');
  // The callout's icon is an image in the PDF
  expect(pdf).toMatch(/\/Subtype \/Image/);
});

test('callouts look the same on a public link and fold there too', async ({ page, browser }) => {
  const title = `Public callouts ${uid()}`;
  const id = await seedNote(page.request, `${title}.md`, NOTE);
  const res = await page.request.put(`/api/notes/${id}/public`, { data: { enabled: true } });
  const { publicToken } = (await res.json()) as { publicToken: string };
  const anon = await browser.newContext();
  const pub = await anon.newPage();
  await pub.goto(`/s/${publicToken}`);
  await expect(pub.locator('.cm-callout-head')).toHaveCount(3);
  await expect(pub.getByText('Versteckter Text im Block.')).toHaveCount(0);
  await pub.locator('.cm-callout-head', { hasText: 'Mehr Details' }).click();
  await expect(pub.getByText('Versteckter Text im Block.')).toBeVisible();
  await anon.close();
});

test('with the feature off callouts stay plain quotes and /callout is not offered', async ({ openAs }) => {
  const page = await openAs('cara');
  const dialog = page.locator('[data-features-dialog]');
  const setCallouts = async (on: boolean) => {
    await page.goto('/settings');
    await page.locator('[data-open-features]').click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('tab', { name: on ? /Available features/ : /Active features/ }).click();
    await dialog.locator('[data-feature="callouts"] button').first().click();
    await dialog.locator(`[data-${on ? 'activate' : 'deactivate'}="callouts"]`).click();
    await expect(dialog.locator('[data-feature-detail="callouts"]').getByText(on ? 'On' : 'Off', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
  };
  await setCallouts(false);
  try {
    const title = `Plain quotes ${uid()}`;
    const id = await seedNote(page.request, `${title}.md`, NOTE);
    await openNote(page, id, title);
    await expect(page.locator('.cm-quote').filter({ hasText: 'Versteckter Text im Block.' })).toBeVisible();
    await expect(page.locator('.cm-callout-head')).toHaveCount(0);
    await editor(page).click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('\n/callo');
    await expect(page.getByRole('option', { name: /^Callout/ })).toHaveCount(0);
  } finally {
    await setCallouts(true);
  }
});
