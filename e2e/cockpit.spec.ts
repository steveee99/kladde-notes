import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, createNote, editor, enableFeature, serverNotes, uid } from './helpers';

const axe = async (page: Page) => (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);

// Development cockpit (opt-in): dashboards of live GitLab/Jira widgets. The test server has no GitLab or Jira, so the
// widgets explain what is missing; the data paths are covered by packages/server/tests/cockpit.test.ts.

test('switching the cockpit on creates "My day", widgets travel as JSON and work inside notes', async ({ page }) => {
  await enableFeature(page, 'cockpit');

  // The first dashboard is a hidden note at the top of the space
  await expect
    .poll(async () => (await serverNotes(page.request)).filter((n) => /^_dashboard-[0-9a-f-]+\.md$/.test(n.path) && n.content.includes('type: dashboard')).length)
    .toBe(1);

  await page.goto('/cockpit');
  await expect(page.getByRole('heading', { name: 'My day', level: 1 })).toBeVisible();
  const grid = page.locator('[data-cockpit-grid]');
  await expect(grid.locator('[data-cockpit-widget]')).toHaveCount(5);
  // Without connections every widget says so and the page offers to connect
  await expect(page.locator('[data-cockpit-connect-hint]')).toBeVisible();
  await expect(grid.locator('[data-cockpit-problem="not_connected"]').first()).toBeVisible();

  // A widget from a colleague: pasted as JSON, added to the dashboard
  const title = `Sprint ${uid()}`;
  const shared = JSON.stringify({ kladde: 'cockpit-widget', v: 1, title, source: { kind: 'jira.issues', params: { jql: 'sprint in openSprints()' } }, view: 'board', groupBy: 'status' });
  await page.getByRole('button', { name: 'Dashboard actions' }).click();
  await page.getByRole('menuitem', { name: 'Paste from JSON' }).click();
  await page.locator('[data-cockpit-paste]').fill(shared);
  await expect(page.getByText('1 widget(s) will be added to this dashboard.')).toBeVisible();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(grid.locator('[data-cockpit-widget]')).toHaveCount(6);
  await expect(grid.getByRole('region', { name: title })).toBeVisible();
  await expect.poll(async () => (await serverNotes(page.request)).some((n) => n.path.startsWith('_dashboard-') && n.content.includes(title))).toBe(true);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(400);
  expect(await axe(page)).toEqual([]);

  // The editor builds a widget from the source's description and shows its JSON
  await page.locator('[data-cockpit-add]').click();
  const dialog = page.locator('[data-cockpit-editor]');
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(400);
  expect(await axe(page)).toEqual([]);
  // "From JSON" takes over a pasted widget or block
  await dialog.locator('[data-cockpit-from-json-toggle]').click();
  await dialog.locator('[data-cockpit-paste-widget]').fill('```cockpit\nsource: jira.issues\ntitle: From a block\n```');
  await dialog.locator('[data-cockpit-apply-json]').click();
  await expect(dialog.locator('[data-cockpit-title]')).toHaveValue('From a block');
  await expect(dialog.locator('[data-cockpit-source="jira.issues"]')).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.locator('[data-cockpit-from-json]')).toBeHidden();
  await dialog.locator('[data-cockpit-source="gitlab.jobs"]').click();
  await dialog.locator('[data-cockpit-title]').fill('Red deploys');
  await dialog.locator('[data-cockpit-save]').click();
  await expect(dialog).toBeHidden();
  await expect(grid.getByRole('region', { name: 'Red deploys' })).toBeVisible();

  // A release comparison as a status tile: missing commits counted, 0 green, more red
  await page.locator('[data-cockpit-add]').click();
  await dialog.locator('[data-cockpit-source="gitlab.compare"]').click();
  await dialog.getByRole('textbox', { name: 'Repository' }).fill('team/repo-a');
  await dialog.getByRole('textbox', { name: 'Source (branch or tag)' }).fill('10.100');
  await dialog.getByRole('textbox', { name: 'Target (branch or tag)' }).fill('10.101');
  await dialog.locator('[data-cockpit-title]').fill('Repo A 10.100 → 10.101');
  await dialog.getByRole('button', { name: 'Count', exact: true }).click();
  await dialog.locator('[data-cockpit-traffic-light]').click();
  await expect(dialog.locator('[data-cockpit-state-rule]')).toHaveCount(2);
  await page.waitForTimeout(400);
  expect(await axe(page)).toEqual([]);
  await dialog.locator('[data-cockpit-save]').click();
  await expect(grid.getByRole('region', { name: 'Repo A 10.100 → 10.101' })).toBeVisible();
  await expect.poll(async () => (await serverNotes(page.request)).some((n) => n.path.startsWith('_dashboard-') && n.content.includes('"kind": "gitlab.compare"') && n.content.includes('"tone": "green"'))).toBe(true);

  // The grid takes more columns
  await page.getByRole('button', { name: 'Dashboard actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit dashboard' }).click();
  await page.locator('[data-cockpit-columns="4"]').click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(grid).toHaveAttribute('data-cockpit-grid', '4');
  await expect.poll(async () => (await serverNotes(page.request)).some((n) => n.path.startsWith('_dashboard-') && n.content.includes('"columns": 4'))).toBe(true);

  // Dashboards stay out of the note list and the search
  await page.goto('/notes');
  await expect(page.getByText(/_dashboard-/)).toHaveCount(0);

  // A ```cockpit block in an ordinary note becomes the widget
  await createNote(page, `Ticket ${uid()}`);
  await editor(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('\n```cockpit\nsource: gitlab.mrs\ntitle: MRs for the ticket\nsearch: {{this.jira|PAY-1}}\n```\n\nAfter');
  await expect(page.locator('[data-cockpit-block]').getByRole('region', { name: 'MRs for the ticket' })).toBeVisible();
  await expect(page.locator('[data-cockpit-block] [data-cockpit-problem="not_connected"]')).toBeVisible();

  // /cockpit opens the widget editor and puts its widget into the note as a block; the block's settings edit it
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('\n\n');
  await page.keyboard.type('/cockpit');
  await page.locator('.cm-tooltip-autocomplete').getByText('Cockpit widget').click();
  const blockEditor = page.locator('[data-cockpit-editor]');
  await expect(blockEditor).toBeVisible();
  await blockEditor.locator('[data-cockpit-source="jira.issues"]').click();
  await blockEditor.locator('[data-cockpit-title]').fill('Jira in the note');
  await blockEditor.locator('[data-cockpit-save]').click();
  await expect(blockEditor).toBeHidden();
  const jiraBlock = page.locator('[data-cockpit-block]').filter({ has: page.getByRole('region', { name: 'Jira in the note' }) });
  await expect(jiraBlock).toBeVisible();
  await jiraBlock.locator('[data-cockpit-configure]').click();
  await expect(blockEditor.locator('[data-cockpit-title]')).toHaveValue('Jira in the note');
  await blockEditor.locator('[data-cockpit-title]').fill('Jira renamed');
  await blockEditor.locator('[data-cockpit-save]').click();
  await expect(page.locator('[data-cockpit-block]').getByRole('region', { name: 'Jira renamed' })).toBeVisible();
  await expect(page.locator('[data-cockpit-block]').getByRole('region', { name: 'Jira in the note' })).toHaveCount(0);
});
