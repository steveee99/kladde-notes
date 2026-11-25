import fs from 'fs';
import { test, expect, editor, expectOnServer, expectSynced, serverNote, serverNotes, uid } from './helpers';
import type { APIRequestContext, Page } from '@playwright/test';

// Variables: definitions in folders and groups, inherited and overridden below, filled in wherever the note shows

const hexId = () => [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');

async function seed(request: APIRequestContext, notes: { path: string; content: string; group?: string }[]): Promise<Record<string, string>> {
  const now = Date.now();
  const ids: Record<string, string> = {};
  const changes = notes.map((n) => {
    ids[n.path] = hexId();
    return { id: ids[n.path], baseVersion: 0, deleted: false, createdAt: now, updatedAt: now, ...n };
  });
  expect((await request.post('/api/sync', { data: { changes } })).ok()).toBe(true);
  return ids;
}

const dialogOf = (page: Page) => page.locator('[data-variables-dialog]');

async function openVariables(page: Page, folder: string) {
  await page.goto(`/f/${encodeURIComponent(folder)}`);
  await page.locator('[data-open-variables]').click();
  await expect(dialogOf(page)).toBeVisible();
}

async function addVariable(page: Page, name: string, value: string) {
  const dialog = dialogOf(page);
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await dialog.getByRole('textbox', { name: 'Value', exact: true }).fill(value);
  await dialog.getByRole('button', { name: 'Add' }).click();
  await expect(dialog.locator(`[data-variable="${name}"]`)).toBeVisible();
}

test('variables are defined in a folder, inherited, overridden and follow every change', async ({ page }) => {
  const top = `Vars ${uid()}`;
  const sub = `${top}/Sub`;
  const text = [
    '# Offer for {{var:customer}}',
    '',
    'Contact {{var:customer}}, {{var:contact|nobody}}, {{var:missing}}, `{{var:customer}}`.',
    '',
    '[Repo of {{var:customer}}](https://git.example.com/{{var:customer}}/x) and [bad]({{var:evil}})',
    '',
    '| Who | Link |',
    '|---|---|',
    '| **{{var:customer}}** | [r](https://git.example.com/{{var:customer}}) |',
    '',
    'End',
    '',
  ].join('\n');
  const ids = await seed(page.request, [
    { path: `${top}/Upper.md`, content: text },
    { path: `${sub}/Lower.md`, content: text },
  ]);

  await openVariables(page, top);
  await addVariable(page, 'customer', 'ACME');
  await addVariable(page, 'evil', 'javascript:alert(1)');
  await addVariable(page, 'greeting', 'Hello {{var:customer}}');
  await expect(dialogOf(page).locator('[data-variable="greeting"]')).toContainText('= Hello ACME');
  // Names are checked
  await dialogOf(page).getByRole('textbox', { name: 'Name', exact: true }).fill('a b');
  await expect(dialogOf(page).getByRole('alert')).toBeVisible();
  await dialogOf(page).getByRole('textbox', { name: 'Name', exact: true }).fill('');
  await page.keyboard.press('Escape');
  await expect(page.getByText('_variables')).toHaveCount(0);

  const upper = ids[`${top}/Upper.md`];
  const lower = ids[`${sub}/Lower.md`];
  await page.goto(`/n/${lower}`);
  await expect(editor(page).locator('.cm-h1')).toHaveText('Offer for ACME');
  await expect(editor(page)).toContainText('Contact ACME, nobody, {{var:missing}}, {{var:customer}}.');
  await expect(editor(page).locator('.cm-variable-unknown')).toHaveText('{{var:missing}}');
  await expect(editor(page).locator('.cm-variable').first()).toHaveAttribute('title', new RegExp(`customer – from ${top}`));
  await expect(editor(page).getByRole('link', { name: 'Repo of ACME' })).toHaveAttribute('href', 'https://git.example.com/ACME/x');
  await expect(editor(page).locator('.cm-link-blocked')).toHaveText('bad');
  await expect(editor(page).locator('td strong')).toHaveText('ACME');
  await expect(editor(page).locator('td a')).toHaveAttribute('href', 'https://git.example.com/ACME');

  // The raw placeholder shows while the cursor is in it
  await editor(page).locator('.cm-line', { hasText: 'Contact' }).locator('.cm-variable').first().click();
  await expect(editor(page).locator('.cm-variable-src').first()).toHaveText('{{var:customer}}');
  await page.keyboard.press('ControlOrMeta+End');
  await expect(editor(page).locator('.cm-variable-src')).toHaveCount(0);

  // Overridden in the subfolder: only notes there change
  await openVariables(page, sub);
  const inherited = dialogOf(page).locator('[data-variable-inherited="customer"]');
  await expect(inherited).toContainText(`from ${top}`);
  await inherited.getByRole('button', { name: 'Override' }).click();
  const value = dialogOf(page).getByRole('textbox', { name: 'Value of customer' });
  await expect(value).toBeFocused();
  await value.fill('Beta <b>GmbH</b>');
  await value.press('Enter');
  await expect(dialogOf(page).locator('[data-variable="customer"]')).toContainText('overrides “ACME”');
  await page.keyboard.press('Escape');
  await page.goto(`/n/${lower}`);
  await expect(editor(page)).toContainText('Contact Beta <b>GmbH</b>, nobody');
  await page.goto(`/n/${upper}`);
  await expect(editor(page)).toContainText('Contact ACME, nobody');

  // A change from elsewhere shows in the open note, the text keeps the placeholder
  const def = (await serverNotes(page.request)).find((n) => n.path.startsWith(`${top}/_variables-`))!;
  const now = Date.now();
  await page.request.post('/api/sync', {
    data: { changes: [{ id: def.id, baseVersion: def.version, path: def.path, content: def.content.replace('customer: ACME', 'customer: Gamma'), deleted: false, createdAt: now, updatedAt: now }] },
  });
  await expect(editor(page)).toContainText('Contact Gamma, nobody', { timeout: 15_000 });
  expect((await serverNote(page.request, upper))!.content).toBe(text);

  // Markdown export contains the value
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Export' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /markdown \(\.md\)/i }).click();
  const exported = fs.readFileSync(await (await download).path(), 'utf8');
  expect(exported).toContain('# Offer for Gamma');
  expect(exported).toContain('(https://git.example.com/Gamma/x)');
  expect(exported).toContain('`{{var:customer}}`');

  // Public links get the values they use, and nothing else of the folder
  const { publicToken: token } = (await (await page.request.put(`/api/notes/${upper}/public`, { data: { enabled: true } })).json()) as { publicToken: string };
  const shared = (await (await page.request.get(`/api/public/${token}`)).json()) as { variables: Record<string, string> };
  expect(Object.keys(shared.variables).sort()).toEqual(['customer', 'evil']);
  await page.goto(`/s/${token}`);
  await expect(editor(page)).toContainText('Contact Gamma, nobody, {{var:missing}}');

  // Removing the override goes back to the inherited value
  await openVariables(page, sub);
  await dialogOf(page).getByRole('button', { name: 'Remove override: customer' }).click();
  await expect(dialogOf(page).locator('[data-variable-inherited="customer"]')).toContainText('Gamma');
  await expect.poll(async () => (await serverNotes(page.request)).filter((n) => n.path.startsWith(`${sub}/_variables-`)).length).toBe(0);
});

test('typing {{ offers the variables, templates keep the placeholder and embeds use their own folder', async ({ openAs }) => {
  // Templates live in the synced settings, which other tests change as anna at the same time
  const page = await openAs('cara');
  const top = `Tpl ${uid()}`;
  const ids = await seed(page.request, [
    { path: `${top}/_variables.md`, content: '---\ntype: variables\nvariables:\n  colour: green\n---\n' },
    { path: `${top}/Note.md`, content: 'Start\n' },
    { path: `${top}/Other/_variables.md`, content: '---\ntype: variables\nvariables:\n  colour: blue\n---\n' },
    { path: `${top}/Other/Embedded ${top}.md`, content: 'Inner {{var:colour}}\n' },
    { path: `${top}/Outer.md`, content: `Outer {{var:colour}}\n\n![[Embedded ${top}]]\n\nEnd\n` },
  ]);
  await page.goto(`/n/${ids[`${top}/Outer.md`]}`);
  await expect(editor(page)).toContainText('Outer green');
  await expect(page.locator('.wz-embed-body')).toContainText('Inner blue');

  await page.goto(`/n/${ids[`${top}/Note.md`]}`);
  await expect(editor(page)).toContainText('Start');
  await editor(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('Now {{');
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('var:colour');
  await page.keyboard.type('var:co');
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('green');
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.keyboard.type(' end');
  await expect(editor(page)).toContainText('Now green end');
  await expectOnServer(page.request, ids[`${top}/Note.md`], 'Now {{var:colour}} end');

  // Template: its folder's variables are offered, the new note keeps the placeholder
  const label = `T${uid()}`;
  await page.goto('/settings/templates');
  await page.getByRole('button', { name: 'New template' }).click();
  await page.getByPlaceholder('Name, e.g. Project').fill(label);
  const template = page.locator('[data-template-editor] .cm-content');
  await template.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  // The template editor offers the template's placeholders and the variables of its folder
  await page.keyboard.type('Colour: {{var:colour}} of {{ti');
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('Title of the new note');
  await page.waitForTimeout(300);
  await page.locator('.cm-tooltip-autocomplete li', { hasText: 'Title of the new note' }).click();
  await expect(template.locator('.cm-src-ph')).toHaveText('title');
  await page.keyboard.press('Enter');
  // A sync from the other tests may close the list in between
  await expect(async () => {
    await page.locator('form').getByRole('combobox').click();
    await page.getByRole('option', { name: top, exact: true }).click({ timeout: 2000 });
  }).toPass();
  await expect(page.locator('[data-template-variables]')).toContainText('{{var:colour}} green');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(label, { exact: true })).toBeVisible();
  await page.goto(`/f/${encodeURIComponent(top)}`);
  await expectSynced(page);
  await page.getByRole('main').getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('button', { name: label }).click();
  await page.locator('input[placeholder="Title"]').fill(`Made ${label}`);
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/n\/[0-9a-f]+/);
  await expect(editor(page)).toContainText(`Colour: green of Made ${label}`);
  await expect.poll(async () => (await serverNotes(page.request)).find((n) => n.path.endsWith(`Made ${label}.md`))?.content).toBe(`Colour: {{var:colour}} of Made ${label}\n`);
});

test('a group has its own variables: owners edit them, readers only see them', async ({ page, openAs }) => {
  const group = (await (await page.request.post('/api/groups', { data: { name: `VarTeam ${uid()}` } })).json()) as { id: string; name: string };
  expect((await page.request.put(`/api/groups/${group.id}/members`, { data: { username: 'cara', role: 'reader' } })).ok()).toBe(true);
  const ids = await seed(page.request, [{ path: 'Docs/Guide.md', content: 'Host: {{var:host}}\n', group: group.id }]);

  await page.goto(`/g/${group.id}`);
  await page.locator('[data-open-variables]').click();
  await addVariable(page, 'host', 'team.example.com');
  await page.keyboard.press('Escape');
  await expect(page.getByText('_variables')).toHaveCount(0);
  await page.goto(`/n/${ids['Docs/Guide.md']}`);
  await expect(editor(page)).toContainText('Host: team.example.com');
  await expectSynced(page);

  const cara = await openAs('cara');
  await cara.goto(`/n/${ids['Docs/Guide.md']}`);
  await expect(editor(cara)).toContainText('Host: team.example.com');
  await cara.goto(`/g/${group.id}/Docs`);
  await cara.locator('[data-open-variables]').click();
  await expect(dialogOf(cara).locator('[data-variable-inherited="host"]')).toContainText(`from ${group.name}`);
  await expect(dialogOf(cara).getByRole('textbox')).toHaveCount(0);
  await expect(dialogOf(cara).getByRole('button', { name: /Override/ })).toHaveCount(0);

  // A note shared on its own does not bring its folder's variables: the recipient sees that the value is unknown
  const own = await seed(page.request, [
    { path: `Sh ${group.id}/_variables.md`, content: '---\ntype: variables\nvariables:\n  secret: hidden\n---\n' },
    { path: `Sh ${group.id}/Shared.md`, content: 'Value {{var:secret}} {{var:secret|open}}\n' },
  ]);
  const note = own[`Sh ${group.id}/Shared.md`];
  expect((await page.request.put(`/api/notes/${note}/shares`, { data: { username: 'cara', canWrite: true } })).ok()).toBe(true);
  await expect.poll(async () => !!(await serverNote(cara.request, note))).toBe(true);
  await cara.goto(`/n/${note}`);
  await expect(editor(cara)).toContainText('Value {{var:secret}} open');
});
