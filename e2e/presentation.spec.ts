import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, enableFeature, expectOnServer, noteMenu, uid } from './helpers';

// Presentation mode (#87): a feature that turns `---` into slide breaks, starts a full-screen presentation in the
// slide format chosen on the note and exports the slides as a PDF

const hexId = () => [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');

const DECK = `---
presentation: 4:3
---
# Quarterly review

Anna, 2026

---

## Numbers
- Revenue up
- Costs down

Note: Mention the new team

---

## Table
| Quarter | Result |
|---|---|
| Q1 | 12 |
| Q2 | 15 |
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

test('a note is presented as slides in its format, with keys and speaker notes', async ({ page }) => {
  await enableFeature(page, 'presentation');
  const title = `Deck ${uid()}`;
  const id = await seedNote(page.request, `${title}.md`, DECK);
  await openNote(page, id, title);

  // With the feature on, the rules are numbered slide breaks
  await expect(page.locator('[data-slide-break]')).toHaveCount(2);
  await expect(page.locator('[data-slide-break]').first()).toHaveText('Slide 2');

  await noteMenu(page, 'Start presentation');
  const deck = page.getByRole('dialog', { name: `Presentation: ${title}` });
  await expect(deck).toBeVisible();
  await expect(deck).toHaveAttribute('data-format', '4:3');
  const slide = deck.locator('[data-slide]');
  await expect(slide).toHaveAttribute('data-slide', '1');
  await expect(slide.getByText('Quarterly review')).toBeVisible();
  // Controls are named and the colors have enough contrast
  const axe = await new AxeBuilder({ page }).include('[data-presentation]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);

  // The canvas keeps the note's format (4:3) on every screen
  const box = (await slide.boundingBox())!;
  expect(box.width / box.height).toBeCloseTo(4 / 3, 1);

  await page.keyboard.press('ArrowRight');
  await expect(slide).toHaveAttribute('data-slide', '2');
  await expect(slide.getByText('Revenue up')).toBeVisible();
  // Speaker notes stay off the slide and show in their own panel
  await expect(slide.getByText('Mention the new team')).toHaveCount(0);
  await page.keyboard.press('n');
  await expect(deck.locator('[data-speaker-notes]')).toContainText('Mention the new team');

  await page.keyboard.press('End');
  await expect(slide).toHaveAttribute('data-slide', '3');
  await expect(slide.locator('.wz-table')).toBeVisible();
  // Nothing is cut off: the text shrinks until the slide fits
  const fits = await slide.locator('.slide-body').evaluate((el) => el.scrollHeight <= el.clientHeight + 1);
  expect(fits).toBe(true);

  await page.keyboard.press('ArrowLeft');
  await expect(slide).toHaveAttribute('data-slide', '2');

  // The format is chosen on the note: picking another one in the presentation saves it in the frontmatter
  await deck.getByRole('combobox', { name: 'Slide format' }).click();
  await page.getByRole('option', { name: '16:9' }).click();
  await expect(deck).toHaveAttribute('data-format', '16:9');
  await expectOnServer(page.request, id, /presentation: ["']?16:9/);

  await page.keyboard.press('Escape');
  await expect(deck).toBeHidden();
});

test('the slides are exported as a PDF with one page per slide in the note format', async ({ page }) => {
  await enableFeature(page, 'presentation');
  const title = `Slides ${uid()}`;
  const id = await seedNote(page.request, `${title}.md`, DECK);
  await openNote(page, id, title);

  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /^Export/ }).click();
  const download = page.waitForEvent('download');
  await page.locator('[data-export-slides]').click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`${title}.pdf`);
  const pdf = (await readFile((await file.path())!)).toString('latin1');
  expect(pdf.match(/\/Type \/Page\b/g)).toHaveLength(3);
  // 4:3 slides: 720 × 540 pt
  expect(pdf).toMatch(/\/MediaBox \[0 0 720\.?\d* 540\.?\d*\]/);
});

test('without the feature the note menu offers no presentation and --- stays a rule', async ({ openAs }) => {
  const page = await openAs('cara');
  const title = `Plain ${uid()}`;
  const id = await seedNote(page.request, `${title}.md`, DECK);
  await openNote(page, id, title);
  await expect(page.locator('.cm-hr').first()).toBeVisible();
  await expect(page.locator('[data-slide-break]')).toHaveCount(0);
  await page.getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Start presentation' })).toHaveCount(0);
});
