import { readFile } from 'node:fs/promises';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, uid } from './helpers';

// Images and diagrams on paper: PDF export and browser print keep sizes and proportions (shared/printSize.ts)

const hexId = () => [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
const DIAGRAM = '```mermaid\nflowchart LR\n  A[Start] --> B[End]\n```';
const TALL = `\`\`\`mermaid\nflowchart TD\n${[...Array(14)].map((_, i) => `  N${i}[Step ${i}] --> N${i + 1}[Step ${i + 1}]`).join('\n')}\n\`\`\``;

async function seedNote(request: APIRequestContext, path: string, content: string): Promise<string> {
  const id = hexId();
  const now = Date.now();
  const res = await request.post('/api/sync', { data: { changes: [{ id, baseVersion: 0, path, content, deleted: false, createdAt: now, updatedAt: now }] } });
  expect(res.ok()).toBe(true);
  return id;
}

/** Uploads a plain image of this size */
async function uploadImage(page: Page, width: number, height: number): Promise<string> {
  const base64 = await page.evaluate(
    ([w, h]) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#4682b4';
      ctx.fillRect(0, 0, w, h);
      return c.toDataURL('image/png').split(',')[1];
    },
    [width, height]
  );
  const res = await page.request.post('/api/files', { headers: { 'x-filename': `${width}x${height}.png`, 'content-type': 'image/png' }, data: Buffer.from(base64, 'base64') });
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { url: string }).url;
}

async function openExport(page: Page) {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /^Export/ }).click();
}

async function openNote(page: Page, content: string) {
  const title = `Print ${uid()}`;
  const id = await seedNote(page.request, `${title}.md`, content);
  await page.goto(`/n/${id}`);
  await expect(page.locator('textarea.note-title')).toHaveValue(title, { timeout: 15_000 });
}

test('the PDF export keeps images in proportion and diagrams readable', async ({ page }) => {
  await page.goto('/');
  const [portrait, landscape, small] = [await uploadImage(page, 1200, 2400), await uploadImage(page, 2400, 1200), await uploadImage(page, 120, 80)];
  await openNote(page, `![](${portrait})\n\n![](${landscape})\n\n![](${small})\n\n${DIAGRAM}\n\n${TALL}\n`);
  await openExport(page);
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /^PDF/ }).click();
  const pdf = (await readFile((await (await download).path())!)).toString('latin1');
  const sizes = [...pdf.matchAll(/([\d.]+) 0 0 ([\d.]+) [\d.]+ [\d.]+ cm/g)].map((m) => ({ w: Number(m[1]), h: Number(m[2]) }));
  expect(sizes).toHaveLength(5);
  const [p, l, s, d, t] = sizes;
  // Portrait: part of the page height; landscape: the text width; small: its own size (96 dpi)
  expect(p.h).toBeLessThan(450);
  expect(p.w / p.h).toBeCloseTo(0.5, 2);
  expect(l.w).toBeCloseTo(495.3, 0);
  expect(l.w / l.h).toBeCloseTo(2, 2);
  expect(s.w).toBeCloseTo(90, 0);
  expect(s.h).toBeCloseTo(60, 0);
  // The two-node chart is neither tiny nor page wide, the tall one fits the page (it was 300 × 150 pixels at most)
  expect(d.w).toBeGreaterThan(200);
  expect(d.w).toBeLessThan(400);
  expect(t.h).toBeGreaterThan(400);
  expect(t.h).toBeLessThan(600);
});

test('browser print has the whole note with loaded images and light diagrams', async ({ page }) => {
  await page.goto('/');
  const [portrait, small] = [await uploadImage(page, 1200, 2400), await uploadImage(page, 120, 80)];
  await openNote(page, `Start\n\n![](${portrait})\n\n${'Text\n\n'.repeat(60)}![](${small})\n\n${DIAGRAM}\n\n${TALL}\n\nLast line\n`);
  await page.evaluate(() => {
    const w = window as unknown as { printed?: object };
    window.print = () => {
      w.printed = {};
    };
  });
  await openExport(page);
  await page.getByRole('menuitem', { name: /^Print/ }).click();
  await page.waitForFunction(() => (window as unknown as { printed?: object }).printed);

  await page.setViewportSize({ width: 673, height: 1000 });
  await page.emulateMedia({ media: 'print' });
  const state = await page.evaluate(() => {
    window.dispatchEvent(new Event('beforeprint'));
    const box = (e: Element) => ({ w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height });
    return {
      text: document.querySelector('.cm-content')!.textContent,
      images: [...document.querySelectorAll<HTMLImageElement>('.cm-img')].map((i) => ({ ...box(i), loaded: i.complete && i.naturalWidth > 0 })),
      diagrams: [...document.querySelectorAll('.wz-diagram svg')].map((e) => ({ ...box(e), html: e.outerHTML })),
      scroller: getComputedStyle(document.querySelector('.cm-scroller')!).display,
    };
  });
  expect(state.text).toContain('Last line');
  expect(state.scroller).toBe('block');
  expect(state.images.map((i) => i.loaded)).toEqual([true, true]);
  expect(state.images[0].h).toBeLessThanOrEqual(551);
  expect(state.images[0].w / state.images[0].h).toBeCloseTo(0.5, 2);
  expect(state.images[1]).toMatchObject({ w: 120, h: 80 });
  expect(state.diagrams).toHaveLength(2);
  expect(state.diagrams[0].w).toBeGreaterThan(250);
  expect(state.diagrams[0].w).toBeLessThan(500);
  expect(state.diagrams[1].h).toBeLessThanOrEqual(751);
  // Paper colors although the app is dark
  for (const d of state.diagrams) expect(d.html).toContain('#f1eee7');
});
