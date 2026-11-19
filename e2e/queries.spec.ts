import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext } from '@playwright/test';
import { test, expect, uid } from './helpers';

// Aggregations in query blocks (#77): GROUP BY with headers and counts, COUNT/SUM/AVG footers

const hexId = () => [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');

async function seed(request: APIRequestContext, path: string, content: string): Promise<string> {
  const id = hexId();
  const now = Date.now();
  const res = await request.post('/api/sync', { data: { changes: [{ id, baseVersion: 0, path, content, deleted: false, createdAt: now, updatedAt: now }] } });
  expect(res.ok()).toBe(true);
  return id;
}

test('query blocks group rows and sum them up', async ({ page }) => {
  const folder = `Stunden ${uid()}`;
  await seed(page.request, `${folder}/A.md`, '---\nstatus: offen\nh: 2\n---\nA');
  await seed(page.request, `${folder}/B.md`, '---\nstatus: offen\nh: 3.5\n---\nB');
  await seed(page.request, `${folder}/C.md`, '---\nstatus: fertig\nh: 1\n---\nC');
  const title = `Summen ${uid()}`;
  const id = await seed(
    page.request,
    `${title}.md`,
    `Intro\n\n\`\`\`query\nTABLE status, COUNT, SUM(h) FROM "${folder}" GROUP BY status\n\`\`\`\n\n\`\`\`query\nTABLE title, AVG(h) FROM "${folder}" GROUP BY status\n\`\`\`\n\n\`\`\`query\nLIST FROM "${folder}" GROUP BY status\n\`\`\`\n`
  );
  await page.goto(`/n/${id}`);
  await expect(page.locator('textarea.note-title')).toHaveValue(title, { timeout: 15_000 });

  const tables = page.locator('.wz-table');
  await expect(tables).toHaveCount(2);
  // Summary: one row per group and a total
  const summary = tables.nth(0);
  await expect(summary.locator('thead th')).toHaveText(['status', 'Count', 'SUM(h)']);
  await expect(summary.locator('tbody tr').nth(0).locator('td')).toHaveText(['fertig', '1', '1']);
  await expect(summary.locator('tbody tr').nth(1).locator('td')).toHaveText(['offen', '2', '5.5']);
  await expect(summary.locator('tfoot td')).toHaveText(['Total', '3', '6.5']);
  // Grouped rows with a header, the group's average and the overall one
  const grouped = tables.nth(1);
  await expect(grouped.locator('.wz-group-head')).toHaveText(['fertig1', 'offen2']);
  await expect(grouped.locator('.wz-group-foot').nth(1).locator('td')).toHaveText(['', '2.75']);
  await expect(grouped.locator('tfoot td')).toHaveText(['Total', '2.17']);
  // LIST groups
  const list = page.locator('.wz-query-groups');
  await expect(list.locator('.wz-group-head')).toHaveText(['fertig1', 'offen2']);
  await expect(list.locator('li')).toHaveText(['C', 'B', 'A']);

  const axe = await new AxeBuilder({ page }).include('.cm-content').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
});
