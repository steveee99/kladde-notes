import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, uid, noteTitle } from './helpers';

// Folder tree menus, the resizable side panel, query clicks, formulas (#85), two notes side by side (#88)
// and the account export (#93): the desktop project only (playwright.config limits tablet and phone to other specs)

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

/** Shows the expanded sidebar with the folder tree (the rail is the default) */
async function expandSidebar(page: Page) {
  if (await page.locator('aside[aria-label]').filter({ has: page.locator('[data-tree-note-id], [role="button"]') }).first().isVisible()) return;
  await page.getByRole('button', { name: 'Toggle sidebar' }).first().click();
}

test('folder actions sit in a three-dot menu and the context menu', async ({ page }) => {
  const folder = `Mappe ${uid()}`;
  const id = await seed(page.request, `${folder}/Drin.md`, 'x');
  await open(page, id, 'Drin');
  await expandSidebar(page);
  const row = page.locator('[role="button"]', { hasText: folder }).first();
  await expect(row).toBeVisible();

  // right click
  await row.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: `Actions for ${folder}` });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toContainText(['New note here', 'Create subfolder', 'Rename']);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // the ⋮ button, then rename through the menu
  await row.hover();
  await page.getByRole('button', { name: `Actions for ${folder}` }).click();
  await menu.getByRole('menuitem', { name: 'Rename' }).click();
  const input = page.locator('input[placeholder="New name"]');
  await input.fill(`${folder} neu`);
  await input.press('Enter');
  await expect(page.locator('[role="button"]', { hasText: `${folder} neu` }).first()).toBeVisible();
});

test('the side panel can be resized', async ({ page }) => {
  const title = `Breit ${uid()}`;
  const id = await seed(page.request, `${title}.md`, '# Eins\n\n## Zwei\n');
  await open(page, id, title);
  const toggle = page.getByRole('button', { name: /^Side pane/ }).first();
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  const handle = page.getByRole('separator', { name: 'Resize side panel' });
  await expect(handle).toBeVisible();
  const before = Number(await handle.getAttribute('aria-valuenow'));
  await handle.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(handle).toHaveAttribute('aria-valuenow', String(before + 16));
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 60, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => Number(await handle.getAttribute('aria-valuenow'))).toBeGreaterThan(before + 40);
});

test('a click on a query result opens the note, editing goes through the button', async ({ page }) => {
  const folder = `Q ${uid()}`;
  const target = await seed(page.request, `${folder}/Ziel.md`, 'Ziel-Inhalt');
  const title = `Abfrage ${uid()}`;
  const id = await seed(page.request, `${title}.md`, `Intro\n\n\`\`\`query\nLIST FROM "${folder}"\n\`\`\`\n`);
  await open(page, id, title);
  const block = page.locator('.wz-query-block');
  await expect(block).toBeVisible();
  // editing: the button shows the source
  await block.getByRole('button', { name: 'Edit query' }).click();
  await expect(page.locator('.cm-line', { hasText: 'LIST FROM' })).toBeVisible();
  await page.locator('.cm-line', { hasText: 'Intro' }).click();
  await expect(block).toBeVisible();
  // a click on the result opens it
  await block.getByText('Ziel').click();
  await expect(page).toHaveURL(new RegExp(`/n/${target}`));
});

test('formulas render with KaTeX and show their source on the cursor line', async ({ page }) => {
  const title = `Formel ${uid()}`;
  const id = await seed(page.request, `${title}.md`, 'Energie $E = mc^2$ ist bekannt.\n\n$$\n\\frac{a}{b}\n$$\n\nKostet $5 und $10.\n');
  await open(page, id, title);
  await expect(page.locator('.cm-math-inline .katex')).toHaveCount(1);
  await expect(page.locator('.cm-math-block .katex-display')).toHaveCount(1);
  await expect(page.locator('.cm-line', { hasText: 'Kostet $5 und $10.' })).toBeVisible();
  // the cursor on the line shows the TeX
  await page.locator('.cm-line', { hasText: 'Energie' }).click({ position: { x: 4, y: 8 } });
  await expect(page.locator('.cm-math-src')).toHaveText('$E = mc^2$');
  const axe = await new AxeBuilder({ page }).include('.cm-content').withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
});

test('two notes side by side with their own history, swap and close', async ({ page }) => {
  const a = `Links ${uid()}`;
  const b = `Rechts ${uid()}`;
  const c = `Dritte ${uid()}`;
  const idC = await seed(page.request, `${c}.md`, 'Drittes');
  const idB = await seed(page.request, `${b}.md`, `Siehe [[${c}]]`);
  const idA = await seed(page.request, `${a}.md`, `Siehe [[${b}]]`);
  await open(page, idA, a);

  // Ctrl/⌘+click on a link opens it to the side
  await page.locator('.cm-wikilink', { hasText: b }).click({ modifiers: ['ControlOrMeta'] });
  const side = page.locator('section[data-pane="side"]');
  await expect(side).toBeVisible();
  await expect(side.locator('textarea.note-title')).toHaveValue(b);
  await expect(page).toHaveURL(new RegExp(`/n/${idA}`));

  // a link inside the side pane opens there; back and forward
  await side.locator('.cm-wikilink', { hasText: c }).click();
  await expect(side.locator('textarea.note-title')).toHaveValue(c);
  await side.getByRole('button', { name: 'Back' }).click();
  await expect(side.locator('textarea.note-title')).toHaveValue(b);
  await side.getByRole('button', { name: 'Forward' }).click();
  await expect(side.locator('textarea.note-title')).toHaveValue(c);

  // swap
  await side.getByRole('button', { name: 'Swap sides' }).click();
  await expect(page).toHaveURL(new RegExp(`/n/${idC}`));
  await expect(side.locator('textarea.note-title')).toHaveValue(a);

  // the pane can be resized
  const handle = page.getByRole('separator', { name: 'Resize the second note' });
  const before = Number(await handle.getAttribute('aria-valuenow'));
  await handle.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(handle).toHaveAttribute('aria-valuenow', String(before + 16));

  const axe = await new AxeBuilder({ page }).include('section[data-pane="side"]').withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);

  await side.getByRole('button', { name: 'Close second note' }).click();
  await expect(side).toBeHidden();
  void idB;
});

test('the sidebar opens a note to the side from its menu', async ({ page }) => {
  const folder = `Seite ${uid()}`;
  const first = await seed(page.request, `${folder}/Erste.md`, 'eins');
  await seed(page.request, `${folder}/Zweite.md`, 'zwei');
  await open(page, first, 'Erste');
  await expandSidebar(page);
  const row = page.locator('[data-tree-note-id]', { hasText: 'Zweite' });
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open to the side' }).click();
  const side = page.locator('section[data-pane="side"]');
  await expect(side.locator('textarea.note-title')).toHaveValue('Zweite');
  await side.getByRole('button', { name: 'Close second note' }).click();
});

test('the account export is built and downloaded once', async ({ page }) => {
  await page.goto('/settings/export');
  await expect(page.getByRole('heading', { name: 'Export account' })).toBeVisible();
  const discard = page.getByRole('button', { name: 'Discard' });
  if (await discard.isVisible()) await discard.click();
  await page.getByRole('button', { name: 'Create export' }).click();
  await expect(page.getByText('Export ready')).toBeVisible({ timeout: 20_000 });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^kladde-\d{4}-\d{2}-\d{2}\.zip$/);
  await expect(page.getByRole('button', { name: 'Create export' })).toBeVisible();
});

test('the command palette runs commands and opens notes, tasks and notes to the side', async ({ page }) => {
  const title = `Palette ${uid()}`;
  const id = await seed(page.request, `${title}.md`, `Text\n\n- [ ] Palettenaufgabe ${title}\n`);
  await open(page, id, title);
  const palette = page.locator('[data-command-palette]');

  // `>` lists only commands; Enter runs the selected one
  await page.keyboard.press('ControlOrMeta+K');
  await page.locator('[data-search-dialog-input]').fill('> tasks');
  await expect(palette.locator('[data-command="go-tasks"]')).toBeVisible();
  await expect(palette.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(palette).toBeHidden();

  // Without `>`: notes, matching open tasks and matching commands in one list
  await page.keyboard.press('ControlOrMeta+K');
  await page.locator('[data-search-dialog-input]').fill(title);
  await expect(palette.getByRole('group', { name: 'Notes' }).getByRole('option')).toHaveCount(1);
  await expect(palette.getByRole('group', { name: 'Tasks' }).getByText(`Palettenaufgabe ${title}`)).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(noteTitle(page).first()).toHaveValue(title);

  // Ctrl/⌘+Enter opens a note next to the open one
  const other = `Daneben ${uid()}`;
  await seed(page.request, `${other}.md`, 'x');
  await page.keyboard.press('ControlOrMeta+K');
  await page.locator('[data-search-dialog-input]').fill(other);
  await expect(palette.getByRole('group', { name: 'Notes' }).getByRole('option')).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('section[data-pane="side"] textarea.note-title')).toHaveValue(other);
  await expect(noteTitle(page).first()).toHaveValue(title);
});

test('opened notes get tabs that switch, close and remember their order', async ({ page }) => {
  const a = `Tab A ${uid()}`;
  const b = `Tab B ${uid()}`;
  const idA = await seed(page.request, `${a}.md`, 'a');
  const idB = await seed(page.request, `${b}.md`, 'b');
  await open(page, idA, a);
  await open(page, idB, b);
  const tabs = page.getByRole('navigation', { name: 'Open notes' });
  await expect(tabs.getByRole('link', { name: a })).toBeVisible();
  await expect(tabs.getByRole('link', { name: b })).toHaveAttribute('aria-current', 'page');

  // A click switches, the tabs survive a reload
  await tabs.getByRole('link', { name: a }).click();
  await expect(noteTitle(page).first()).toHaveValue(a);
  await page.reload();
  await expect(tabs.getByRole('link', { name: b })).toBeVisible();

  // Closing the active tab opens its neighbour
  await tabs.getByRole('button', { name: `Close tab: ${a}` }).click();
  await expect(noteTitle(page).first()).toHaveValue(b);
  await expect(tabs.getByRole('link', { name: a })).toHaveCount(0);
});
