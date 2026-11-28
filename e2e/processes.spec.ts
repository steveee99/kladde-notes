import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, enableFeature, serverNotes, uid } from './helpers';

const axe = async (page: Page) => (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
const shots = process.env.PROCESS_SHOTS;

// Guided processes (part of the cockpit): the examples arrive with the feature, a run starts with its repositories and
// target branch, gets a suggested branch and walks through decisions and conditional stages. The test server has no
// GitLab or Jira, so checks say what is missing; the data paths are covered by the unit tests.

test('the examples arrive with the cockpit, a bug fix runs through a decision and a conditional stage', async ({ page }) => {
  await enableFeature(page, 'cockpit');
  await expect
    .poll(async () => (await serverNotes(page.request)).filter((n) => /^_process-[0-9a-f-]+\.md$/.test(n.path) && n.content.includes('type: process')).length)
    .toBe(2);

  await page.goto('/processes');
  await expect(page.getByRole('heading', { name: 'Processes', level: 1 })).toBeVisible();
  await expect(page.locator('[data-model-card="wasserfall"]')).toContainText('Waterfall development');
  await expect(page.locator('[data-model-card="fehlerbehebung"]')).toContainText('Bug fix');
  if (shots) await page.screenshot({ path: `${shots}/overview.png`, fullPage: true });

  // Start: target branch and repositories first, the branch is suggested from the ticket and the title
  await page.locator('[data-model-card="fehlerbehebung"]').getByRole('button', { name: 'Start a run' }).click();
  const start = page.locator('[data-process-start]');
  const title = `Wrong total ${uid()}`;
  await start.locator('[data-process-title]').fill(title);
  await start.locator('[data-process-ticket]').fill('shop-9');
  await start.locator('[data-process-repo-input]').fill('team/api');
  await start.locator('[data-process-repo-input]').press('Enter');
  await start.locator('[data-process-repo-input]').fill('team/web');
  await start.locator('[data-process-repo-input]').press('Enter');
  await expect(start.locator('[data-picked-repo]')).toHaveCount(2);
  await expect(start.locator('[data-process-start-submit]')).toBeDisabled();
  await start.locator('[data-process-target]').fill('release/2.31');
  const slug = title.toLowerCase().replace(/ /g, '-');
  await expect(start.locator('[data-process-branch]')).toHaveValue(`bugfix/SHOP-9-${slug}`);
  await page.waitForTimeout(300);
  expect(await axe(page)).toEqual([]);
  if (shots) await page.screenshot({ path: `${shots}/start.png` });
  await start.locator('[data-process-start-submit]').click();

  await expect(page).toHaveURL(/\/processes\/run\//);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(title);
  await expect(page.locator('[data-process-stage="bug"]')).toBeVisible();
  await expect(page.locator('[data-process-repo="team/api"]')).toBeVisible();
  await expect(page.locator('[data-process-branches]')).toContainText(`bugfix/SHOP-9-${slug}`);

  // A reference and a checkbox, then on
  await page.locator('[data-process-link="b1"]').fill('https://jira.example.com/browse/SHOP-9');
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(page.locator('[data-process-step="b1"]')).toHaveAttribute('data-state', 'ok');
  await expect(page.locator('[data-process-next]')).toBeDisabled();
  await page.locator('[data-process-task="b2"]').check();
  await page.locator('[data-process-next]').click();

  // The decision: critical makes the hotfix approval apply later
  await expect(page.locator('[data-process-stage="schwere"]')).toBeVisible();
  await page.locator('[data-process-option="kritisch"]').click();
  await page.locator('[data-process-next]').click();
  await expect(page.locator('[data-process-stage="umsetzung"]')).toBeVisible();
  await expect(page.locator('[data-track="future"]').filter({ hasText: 'Hotfix approval' })).toBeVisible();
  // Branch and merge request need GitLab: the run says so and can still go on, which the history keeps
  await expect(page.locator('[data-process-step="f1"]')).toHaveAttribute('data-state', 'problem');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(400);
  expect(await axe(page)).toEqual([]);
  if (shots) await page.screenshot({ path: `${shots}/run.png`, fullPage: true });
  await page.locator('[data-process-force]').click();
  await expect(page.locator('[data-process-stage="hotfix"]')).toBeVisible();

  await expect
    .poll(async () => {
      const n = (await serverNotes(page.request)).find((x) => x.path.startsWith('_process-run-') && x.content.includes(title));
      return n ? /"stage": "hotfix"/.test(n.content) && n.content.includes('"forced": true') && n.content.includes('"schwere": "kritisch"') : false;
    })
    .toBe(true);

  // The model as a graph with the way of this run
  await page.locator('[data-process-tab="model"]').click();
  await expect(page.locator('[data-graph-stage="hotfix"]')).toBeVisible();
  await page.locator('[data-graph-stage="merge"]').click();
  await expect(page.locator('[data-stage-details="merge"]')).toContainText('when nested empty');
  expect(await axe(page)).toEqual([]);
  if (shots) await page.screenshot({ path: `${shots}/model.png`, fullPage: true });
  await page.locator('[data-process-tab="summary"]').click();
  await expect(page.locator('[data-summary-link="bug"]')).toContainText('https://jira.example.com/browse/SHOP-9');
  if (shots) await page.screenshot({ path: `${shots}/summary.png`, fullPage: true });
});
