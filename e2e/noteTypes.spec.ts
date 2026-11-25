import AxeBuilder from '@axe-core/playwright';
import { test, expect, createNote, editor, expectOnServer, expectSynced, noteIdOf, serverNote, uid } from './helpers';
import type { Page } from '@playwright/test';

// Custom note types: modelled in the settings, used by `type: custom:<name>` in notes and templates

const form = (page: Page) => page.locator('[data-type-editor]');
const panel = (page: Page, where: string) => page.locator(`[data-note-type-panel="${where}"]`);

async function pick(page: Page, scope: ReturnType<Page['locator']>, label: string, option: string) {
  await expect(async () => {
    await scope.getByRole('combobox', { name: label }).click();
    await page.getByRole('option', { name: option, exact: true }).click({ timeout: 2000 });
  }).toPass();
}

async function createType(page: Page, name: string) {
  await page.goto('/settings/types');
  await page.locator('[data-type-space="own"]').getByRole('button', { name: /^New note type/ }).click();
  await form(page).getByRole('textbox', { name: /^Name/ }).first().fill(name);
  await pick(page, form(page), 'Show properties', 'On the right');
  await form(page).getByRole('button', { name: 'Add property' }).click();
  const status = form(page).locator('[data-type-property="0"]');
  await status.getByRole('textbox', { name: 'Name' }).fill('Status');
  await pick(page, status, 'Type', 'Select');
  await status.getByRole('textbox', { name: 'Options, separated by commas' }).fill('planned, done');
  await status.getByRole('textbox', { name: /^Default/ }).fill('planned');
  await form(page).getByRole('button', { name: 'Add property' }).click();
  const place = form(page).locator('[data-type-property="1"]');
  await place.getByRole('textbox', { name: 'Name' }).fill('Place');
  await pick(page, place, 'Position of the property', 'At the top');
}

test('a type modelled in the settings is used by a template, shows its properties and hides the frontmatter', async ({ page }) => {
  const name = `Meeting ${uid()}`;
  await createType(page, name);
  // The name of the type key itself is refused
  const place = form(page).locator('[data-type-property="1"]').getByRole('textbox', { name: 'Name' });
  await place.fill('type');
  await expect(form(page).getByRole('alert')).toBeVisible();
  await place.fill('Place');
  expect((await new AxeBuilder({ page }).include('[data-type-editor]').withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  await form(page).getByRole('button', { name: 'Save' }).click();
  await expect(page.locator(`[data-note-type="${name}"]`)).toContainText(`type: custom:${name}`);
  await expect(page.getByText('_type-')).toHaveCount(0);

  // Template
  const label = `T${uid()}`;
  await page.goto('/settings/templates');
  await page.getByRole('button', { name: 'New template' }).click();
  await page.getByPlaceholder('Name, e.g. Project').fill(label);
  const template = page.locator('[data-template-editor] .cm-content');
  await template.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Agenda\n');
  await pick(page, page.locator('form'), 'Note type', name);
  await expect(template).toContainText(`type: custom:${name}`);
  await expect(template).toContainText('Agenda');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(label, { exact: true })).toBeVisible();
  await page.goto('/notes');
  await expectSynced(page);
  await page.getByRole('button', { name: 'New note', exact: true }).first().click();
  await page.getByRole('button', { name: label }).click();
  const title = page.locator('input[placeholder="Title"]');
  await title.fill(`Made ${label}`);
  await title.press('Enter');
  await page.waitForURL(/\/n\//);
  const id = noteIdOf(page);

  // Status on the right with its default, Place at the top, no frontmatter row
  await expect(panel(page, 'right').getByRole('combobox', { name: 'Status' })).toContainText('planned');
  await expect(panel(page, 'top').getByRole('textbox', { name: 'Place' })).toBeVisible();
  await expect(panel(page, 'bottom')).toHaveCount(0);
  await expect(page.locator('.wz-props')).toHaveCount(0);
  const text = (await editor(page).boundingBox())!;
  const side = (await panel(page, 'right').boundingBox())!;
  expect(side.x).toBeGreaterThanOrEqual(text.x + text.width - 1);
  expect((await new AxeBuilder({ page }).include('[data-note-type-panel]').withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);

  // Values are plain frontmatter
  await panel(page, 'top').getByRole('textbox', { name: 'Place' }).fill('Room 1');
  await page.keyboard.press('Enter');
  await pick(page, panel(page, 'right'), 'Status', 'done');
  await expectOnServer(page.request, id, 'Place: Room 1');
  await expectOnServer(page.request, id, 'Status: done');
  await expectOnServer(page.request, id, 'Agenda');

  // Renaming the type and a property, moving the properties, showing the frontmatter: the note follows
  await page.goto('/settings/types');
  await page.getByRole('button', { name: `Edit: ${name}` }).click();
  await form(page).getByRole('textbox', { name: /^Name/ }).first().fill(`${name} x`);
  await form(page).locator('[data-type-property="1"]').getByRole('textbox', { name: 'Name' }).fill('Room');
  await pick(page, form(page), 'Show properties', 'At the bottom');
  await form(page).getByRole('checkbox', { name: 'Also show the frontmatter' }).check();
  await form(page).getByRole('button', { name: 'Save' }).click();
  await expectOnServer(page.request, id, 'Room: Room 1');
  await page.goto(`/n/${id}`);
  await expect(panel(page, 'bottom').getByRole('combobox', { name: 'Status' })).toContainText('done');
  await expect(panel(page, 'top').getByRole('textbox', { name: 'Room' })).toHaveValue('Room 1');
  await expect(page.locator('.wz-props')).toBeVisible();

  // Deleting the type keeps the note and its values
  await page.goto('/settings/types');
  page.on('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: `Delete: ${name} x` }).click();
  await expect(page.locator(`[data-note-type="${name} x"]`)).toHaveCount(0);
  await page.goto(`/n/${id}`);
  await expect(page.locator('[data-note-type-unknown]')).toContainText(name);
  await expect(page.locator('.wz-props')).toBeVisible();
  expect((await serverNote(page.request, id))!.content).toContain('Status: done');
});

test('the type of a note is chosen in its menu and shows on a public link', async ({ page, browser }) => {
  const name = `Book ${uid()}`;
  await createType(page, name);
  await form(page).getByRole('button', { name: 'Save' }).click();
  await expect(page.locator(`[data-note-type="${name}"]`)).toBeVisible();
  const id = await createNote(page, `Novel ${uid()}`, 'Some text');
  await expectOnServer(page.request, id, 'Some text');
  await page.getByRole('button', { name: 'More actions' }).first().click();
  await page.getByRole('menuitem', { name: 'Note type …' }).click();
  await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
  await expect(panel(page, 'right').getByRole('combobox', { name: 'Status' })).toContainText('planned');
  await expectOnServer(page.request, id, `type: custom:${name}`);

  const res = await page.request.put(`/api/notes/${id}/public`, { data: { enabled: true } });
  expect(res.ok()).toBe(true);
  const { publicToken: token } = (await res.json()) as { publicToken: string };
  const guest = await (await browser.newContext({ storageState: { cookies: [], origins: [] }, locale: 'en-US' })).newPage();
  await guest.goto(`/s/${token}`);
  await expect(panel(guest, 'right')).toContainText('planned');
  await expect(panel(guest, 'right').getByRole('combobox')).toHaveCount(0);
  await expect(guest.locator('.wz-props')).toHaveCount(0);
  await guest.context().close();
});
