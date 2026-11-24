import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, expectOnServer, noteTitle, uid } from './helpers';

// The full screen of a drawing note covers the whole app, on desktop, tablet and phone

const hexId = () => [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');

async function seed(request: APIRequestContext, path: string, content: string): Promise<string> {
  const id = hexId();
  const now = Date.now();
  const res = await request.post('/api/sync', { data: { changes: [{ id, baseVersion: 0, path, content, deleted: false, createdAt: now, updatedAt: now }] } });
  expect(res.ok()).toBe(true);
  return id;
}

const SCENE = '{"type":"excalidraw","version":2,"source":"e2e","elements":[],"appState":{},"files":{}}';
const DRAWING = `---\ntype: excalidraw\n---\n\`\`\`excalidraw\n${SCENE}\n\`\`\`\n`;

const menuButton = (page: Page) => page.locator('.excalidraw [data-testid="main-menu-trigger"]:visible').first();
const canvasOf = (page: Page) => page.locator('.excalidraw canvas.interactive');

/** Toggles the full screen with the button on the canvas, or through Excalidraw's menu where the canvas is narrow */
async function toggle(page: Page, label: 'Edit in full screen' | 'Exit full screen') {
  const button = page.locator(`.excalidraw button.btn-icon[aria-label="${label}"]`);
  if (await button.isVisible()) return button.click();
  await menuButton(page).click();
  await page.locator('.dropdown-menu-item', { hasText: label }).click();
}

/** Points of a grid over the window (and its edges) whose topmost element is not part of the full-screen drawing */
const uncovered = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    for (let i = 0; i <= 24; i++) {
      for (let j = 0; j <= 40; j++) {
        const x = Math.min(innerWidth - 2, 1 + (i * innerWidth) / 24);
        const y = Math.min(innerHeight - 2, 1 + (j * innerHeight) / 40);
        const el = document.elementFromPoint(x, y);
        if (!el?.closest('.excalidraw-fullscreen')) out.push(`${Math.round(x)},${Math.round(y)} ${el?.tagName}.${el?.getAttribute('class') ?? ''}`);
      }
    }
    return out;
  });

async function drawRectangle(page: Page) {
  const { width, height } = page.viewportSize()!;
  await page.locator('.excalidraw label:has([data-testid="toolbar-rectangle"])').click();
  await page.mouse.move(width * 0.4, height * 0.45);
  await page.mouse.down();
  await page.mouse.move(width * 0.6, height * 0.6, { steps: 5 });
  await page.mouse.up();
}

test('full screen covers the whole app and keeps the drawing', async ({ page }) => {
  const title = `Skizze ${uid()}`;
  const id = await seed(page.request, `${title}.md`, DRAWING);
  await page.goto(`/n/${id}`);
  await expect(noteTitle(page)).toHaveValue(title, { timeout: 15_000 });
  await expect(canvasOf(page)).toBeVisible({ timeout: 20_000 });
  await canvasOf(page).evaluate((el) => el.setAttribute('data-kept', '1'));

  await toggle(page, 'Edit in full screen');
  await expect.poll(() => uncovered(page)).toEqual([]);
  // The frame changes, the canvas stays the same element
  await expect(page.locator('canvas.interactive[data-kept]')).toHaveCount(1);

  // Drawn in full screen, left right away, before the change is saved
  await drawRectangle(page);
  await toggle(page, 'Exit full screen');
  await expect(page.locator('.excalidraw-fullscreen')).toHaveCount(0);
  await expect(page.locator('canvas.interactive[data-kept]')).toHaveCount(1);
  await expect(page.getByRole('navigation', { name: 'Navigation' })).toBeVisible();
  await expectOnServer(page.request, id, /"type":\s*"rectangle"/);

  // Undo still knows the rectangle drawn in full screen
  const undo = page.locator('.excalidraw [aria-label="Undo"]:visible').first();
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect.poll(async () => JSON.stringify((await serverElements(page, id)).filter((e) => !e.isDeleted))).toBe('[]');
});

/** The elements of the drawing on the server */
async function serverElements(page: Page, id: string): Promise<{ type: string; isDeleted?: boolean }[]> {
  const res = await page.request.get('/api/sync?since=0');
  const { notes } = (await res.json()) as { notes: { id: string; content: string }[] };
  const content = notes.find((n) => n.id === id)!.content;
  return (JSON.parse(content.split('```excalidraw\n')[1].split('\n```')[0]) as { elements: { type: string }[] }).elements;
}

test('dialogs open above the full screen and Escape closes only them', async ({ page }) => {
  const title = `Skizze ${uid()}`;
  const id = await seed(page.request, `${title}.md`, DRAWING);
  await page.goto(`/n/${id}`);
  await expect(canvasOf(page)).toBeVisible({ timeout: 20_000 });
  await toggle(page, 'Edit in full screen');
  await expect.poll(() => uncovered(page)).toEqual([]);

  // The app's search
  await page.keyboard.press('ControlOrMeta+k');
  const search = page.getByRole('dialog').getByRole('combobox').first();
  await expect(search).toBeVisible();
  await search.click(); // fails when something covers it
  await page.keyboard.press('Escape');
  await expect(search).toBeHidden();
  await expect(page.locator('.excalidraw-fullscreen')).toBeVisible();

  // Excalidraw's own dialog and context menu
  await menuButton(page).click();
  await page.locator('[data-testid="help-menu-item"]').click();
  const help = page.locator('.excalidraw .Modal');
  await expect(help).toBeVisible();
  await help.getByRole('heading').first().click();
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
  const { width, height } = page.viewportSize()!;
  await page.mouse.click(width / 2, height / 2, { button: 'right' });
  const menu = page.locator('.excalidraw .context-menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('button').first().click({ trial: true });
  await page.keyboard.press('Escape');
  await expect(page.locator('.excalidraw-fullscreen')).toBeVisible();
});

test('full screen from both panes of the split view covers the whole app', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'two panes need a wide screen');
  const title = `Skizze ${uid()}`;
  const drawing = await seed(page.request, `${title}.md`, DRAWING);
  const text = await seed(page.request, `Text ${title}.md`, '# Text\n');
  await page.setViewportSize({ width: 1500, height: 900 });
  for (const [main, side] of [
    [drawing, text],
    [text, drawing],
  ]) {
    await page.goto('/');
    await page.evaluate((s) => localStorage.setItem('kladde_side_pane', JSON.stringify({ stack: [s], index: 0 })), side);
    await page.goto(`/n/${main}`);
    await expect(page.locator('section[data-pane="side"]')).toBeVisible({ timeout: 15_000 });
    await expect(canvasOf(page)).toBeVisible({ timeout: 20_000 });
    await toggle(page, 'Edit in full screen');
    await expect.poll(() => uncovered(page)).toEqual([]);
    await toggle(page, 'Exit full screen');
    await expect(page.locator('.excalidraw-fullscreen')).toHaveCount(0);
  }
});
