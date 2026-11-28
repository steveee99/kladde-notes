import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, uid, noteTitle } from './helpers';

// Folder websites: an own folder published read-only under /site/<slug> with the folder tree, links between its notes,
// footnotes, backlinks, the graph, "Copy Markdown" and the PDF download; readable without an account

const hexId = () => [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');

async function seed(request: APIRequestContext, path: string, content: string): Promise<string> {
  const id = hexId();
  const now = Date.now();
  const res = await request.post('/api/sync', { data: { changes: [{ id, baseVersion: 0, path, content, deleted: false, createdAt: now, updatedAt: now }] } });
  expect(res.ok()).toBe(true);
  return id;
}

async function expandSidebar(page: Page) {
  if (await page.locator('aside[aria-label]').filter({ has: page.locator('[data-tree-note-id], [role="button"]') }).first().isVisible()) return;
  await page.getByRole('button', { name: 'Toggle sidebar' }).first().click();
}

test('a folder is published as a website with tree, links, footnotes, backlinks and graph', async ({ page, browser }) => {
  const folder = `Handbuch ${uid()}`;
  const slug = `handbuch-${uid()}`;
  const startId = await seed(page.request, `${folder}/Start.md`, '# Start\n\nWeiter mit [[Installation]].[^1]\n\n## Abschnitt\n\nText\n\n## Noch einer\n\n[^1]: Eine Fußnote.\n');
  await seed(page.request, `${folder}/Anleitungen/Installation.md`, '# Installation\n\nZurück zu [[Start]].\n');
  await seed(page.request, `Privat ${uid()}.md`, '# Geheim\n');

  // The owner publishes the folder from its share dialog and picks an own address
  await page.goto(`/n/${startId}`);
  await expect(noteTitle(page).first()).toHaveValue('Start', { timeout: 15_000 });
  await expandSidebar(page);
  await page.locator('[role="button"]', { hasText: folder }).first().click({ button: 'right' });
  await page.getByRole('menu', { name: `Actions for ${folder}` }).getByRole('menuitem', { name: 'Share folder' }).click();
  const dialog = page.getByRole('dialog');
  const box = dialog.locator('[data-folder-site]');
  await box.getByRole('switch', { name: 'Publish as a website (read-only)' }).click();
  const address = box.getByRole('textbox', { name: 'Address' });
  await expect(address).toHaveValue(/^[a-z0-9]{20}$/);
  await address.fill(slug);
  await box.getByRole('button', { name: 'Apply' }).click();
  await expect(box.getByText(`/site/${slug}`)).toBeVisible();

  const guest = await browser.newContext();
  const site = await guest.newPage();
  await site.goto(`/site/${slug}`);
  // Start page: the note called Start, with the tree beside it and only the folder's notes in it
  await expect(site.getByRole('heading', { level: 1, name: 'Start' })).toBeVisible();
  const tree = site.getByRole('navigation', { name: 'Folders' });
  await expect(tree.getByRole('button', { name: 'Anleitungen' })).toBeVisible();
  await expect(tree.getByText('Geheim')).toHaveCount(0);
  await expect(site.locator('.cm-footnote-def, .cm-footnote-ref').first()).toBeVisible();
  await expect(site.getByRole('complementary', { name: 'On this page' })).toContainText('Abschnitt');

  // A [[link]] opens the other note of the site under its own address; it links back
  await site.locator('.cm-wikilink', { hasText: 'Installation' }).click();
  await expect(site).toHaveURL(new RegExp(`/site/${slug}/Anleitungen/Installation$`));
  await expect(site.getByRole('heading', { level: 1, name: 'Installation' })).toBeVisible();
  await expect(tree.getByRole('button', { name: 'Installation' })).toHaveAttribute('aria-current', 'page');
  await site.goto(`/site/${slug}/Start`);
  await expect(site.getByRole('heading', { name: 'Backlinks · 1' })).toBeVisible();

  // Copy Markdown and the PDF download
  await guest.grantPermissions(['clipboard-read', 'clipboard-write']);
  await site.getByRole('button', { name: 'Copy Markdown' }).click();
  await expect.poll(() => site.evaluate(() => navigator.clipboard.readText())).toContain('Weiter mit [[Installation]]');
  const download = site.waitForEvent('download');
  await site.getByRole('button', { name: 'Download as PDF' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.pdf$/);

  // The graph of the whole site
  await site.getByRole('button', { name: 'Graph' }).click();
  await expect(site.getByRole('heading', { level: 1, name: 'Graph' })).toBeVisible();
  await expect(site.locator('canvas')).toBeVisible();

  const a11y = await new AxeBuilder({ page: site }).include('header').include('aside').analyze();
  expect(a11y.violations).toEqual([]);

  // Taken down: the address is gone
  await box.getByRole('switch', { name: 'Publish as a website (read-only)' }).click();
  await site.goto(`/site/${slug}`);
  await expect(site.getByText('This website does not exist (any more).')).toBeVisible();
  await guest.close();
});
