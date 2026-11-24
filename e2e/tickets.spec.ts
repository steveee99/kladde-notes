import { test, expect, enableFeature, expectDatabasesHidden, groupWithDatabases, serverNote, serverNotes, uid } from './helpers';
import type { APIRequestContext, Page } from '@playwright/test';

const hexId = () => [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
const letters = () => [...Array(3)].map(() => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

async function seed(request: APIRequestContext, notes: { path: string; content: string; group?: string }[]): Promise<string[]> {
  const now = Date.now();
  const changes = notes.map((n) => ({ id: hexId(), baseVersion: 0, path: n.path, content: n.content, deleted: false, createdAt: now, updatedAt: now, ...(n.group ? { group: n.group } : {}) }));
  const res = await request.post('/api/sync', { data: { changes } });
  expect(res.ok()).toBe(true);
  return changes.map((c) => c.id);
}

/** Picks an option of one of the app's dropdowns (a combobox button with a listbox) */
async function choose(page: Page, scope: ReturnType<Page['locator']>, name: string | RegExp, option: string) {
  await scope.getByRole('combobox', { name }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

test('own project: number, board, ticket header and status chips in the documentation', async ({ page }) => {
  await enableFeature(page, 'tickets');
  const folder = `Project ${uid()}`;
  const key = `T${letters()}`;
  await seed(page.request, [{ path: `${folder}/Readme.md`, content: 'About the project' }]);
  await page.goto(`/f/${encodeURIComponent(folder)}`);
  await page.locator('[data-make-project]').click();
  await page.locator('[data-project-key]').fill(key);
  await page.getByRole('button', { name: 'Create project' }).click();
  const project = page.locator(`[data-project="${key}"]`);
  await expect(project).toBeVisible();

  // A new ticket gets its number from the server
  await project.locator('[data-new-ticket]').click();
  await page.locator('[data-new-ticket-title]').fill('Offline numbers');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForURL(/\/n\/[0-9a-f]+/);
  const ticketId = /\/n\/([0-9a-f]+)/.exec(page.url())![1];
  await expect(page.locator('[data-ticket-id]')).toHaveText(`${key}-1`, { timeout: 15_000 });
  await expect.poll(async () => (await serverNote(page.request, ticketId))?.content ?? '').toContain(`id: ${key}-1\n`);

  // The board shows it in the first column
  await page.goto(`/f/${encodeURIComponent(folder)}`);
  await expect(project.locator('[data-lane="Open"]').getByText('Offline numbers')).toBeVisible();

  // A ticket id in another note becomes a chip with the ticket's status
  const [docId] = await seed(page.request, [{ path: `${folder}/Sync protocol.md`, content: `Numbers are assigned on push, see ${key}-1.\n` }]);
  await page.goto(`/n/${docId}`);
  const chip = page.locator(`.cm-ticket-chip[data-ticket="${key}-1"]`);
  await expect(chip).toBeVisible({ timeout: 15_000 });
  await expect(chip).toHaveClass(/cm-ticket-open/);

  // Linking the documentation and finishing the ticket in its header
  await page.goto(`/n/${ticketId}`);
  const panel = page.locator('[data-ticket-panel]');
  await panel.getByRole('combobox', { name: 'Link documentation' }).fill('Sync protocol');
  await panel.getByRole('button', { name: 'Link documentation' }).click();
  await expect(panel.getByText('in the “docs” field')).toBeVisible();
  await choose(page, panel, 'Status', 'Done');
  await expect.poll(async () => (await serverNote(page.request, ticketId))?.content ?? '').toMatch(/status: Done[\s\S]*docs: \["\[\[Sync protocol\]\]"\]|docs: \["\[\[Sync protocol\]\]"\][\s\S]*status: Done/);

  // The documentation page lists the ticket and strikes the chip through
  await page.goto(`/n/${docId}`);
  await expect(page.locator(`.cm-ticket-chip[data-ticket="${key}-1"]`)).toHaveClass(/cm-ticket-done/);
  await expect(page.locator('[data-ticket-backlinks]').first()).toContainText('Offline numbers');
});

test('plain HTTP: projects, tickets and databases without the APIs of secure contexts', async ({ page }) => {
  // 127.0.0.1 counts as secure, so take away what a browser hides on http://
  await page.addInitScript(() => {
    for (const key of ['randomUUID', 'subtle']) delete (Crypto.prototype as unknown as Record<string, unknown>)[key];
    for (const key of ['clipboard', 'locks', 'storage', 'mediaDevices', 'serviceWorker']) delete (Navigator.prototype as unknown as Record<string, unknown>)[key];
    delete (window as unknown as Record<string, unknown>).caches;
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await enableFeature(page, 'tickets');
  await enableFeature(page, 'database');
  const folder = `Insecure ${uid()}`;
  const tableFolder = `Table ${uid()}`;
  const key = `H${letters()}`;
  await seed(page.request, [
    { path: `${folder}/Readme.md`, content: 'About the project' },
    { path: `${tableFolder}/Ada.md`, content: '---\ncompany: Analytical\n---\nAda' },
  ]);
  await page.goto(`/f/${encodeURIComponent(folder)}`);
  expect(await page.evaluate(() => 'randomUUID' in crypto || 'clipboard' in navigator || 'caches' in window)).toBe(false);
  await page.locator('[data-make-project]').click();
  await page.locator('[data-project-key]').fill(key);
  await page.getByRole('button', { name: 'Create project' }).click();
  const project = page.locator(`[data-project="${key}"]`);
  await expect(project).toBeVisible();
  await project.locator('[data-new-ticket]').click();
  await page.locator('[data-new-ticket-title]').fill('Over HTTP');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('[data-ticket-id]')).toHaveText(`${key}-1`, { timeout: 15_000 });

  await page.goto(`/f/${encodeURIComponent(tableFolder)}`);
  await page.locator('[data-make-database]').click();
  await expect(page.locator('[data-database]')).toBeVisible();
  for (const f of [folder, tableFolder]) {
    await expect
      .poll(async () => (await serverNotes(page.request)).find((n) => n.path.startsWith(`${f}/_database-`))?.path ?? '', { timeout: 15_000 })
      .toMatch(/_database-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.md$/);
  }
  expect(errors).toEqual([]);
});

test('group projects follow the group switch for every member', async ({ page, openAs }) => {
  const name = `Tickets ${uid()}`;
  const created = await page.request.post('/api/groups', { data: { name } });
  const group = (await created.json()) as { id: string };
  expect((await page.request.put(`/api/groups/${group.id}/members`, { data: { username: 'ben', role: 'editor' } })).ok()).toBe(true);
  const key = `G${letters()}`;
  await seed(page.request, [
    {
      path: `Plan/_database-${crypto.randomUUID()}.md`,
      group: group.id,
      content: `---\ntype: database\nproject:\n  key: ${key}\n  workflow: [Open, Doing, Done]\n  active: [Doing]\n  done: [Done]\nproperties:\n  - name: status\n    type: select\n    options: [Open, Doing, Done]\nviews:\n  - name: Board\n    type: board\n    group: status\n---\n`,
    },
  ]);

  // Off for the group: Ben (whose own feature is off) sees no project
  const ben = await openAs('ben');
  await ben.goto(`/g/${group.id}/Plan`);
  await expect(ben.getByRole('heading', { name: 'Plan' })).toBeVisible();
  await expect(ben.locator(`[data-project="${key}"]`)).toHaveCount(0);

  // The owner switches tickets on for the group
  await page.goto(`/groups/${group.id}`);
  await page.locator('[data-group-features]').getByRole('switch', { name: 'Tickets & milestones' }).click();
  await expect(page.locator('[data-group-features]').getByRole('switch', { name: 'Tickets & milestones' })).toBeChecked();

  // Now Ben works with the project and the group counts the numbers
  await ben.goto(`/g/${group.id}/Plan`);
  const project = ben.locator(`[data-project="${key}"]`);
  await expect(project).toBeVisible({ timeout: 15_000 });
  await project.locator('[data-new-ticket]').click();
  await ben.locator('[data-new-ticket-title]').fill('Shared work');
  await ben.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(ben.locator('[data-ticket-id]')).toHaveText(`${key}-1`, { timeout: 15_000 });
  await expect.poll(async () => (await serverNotes(page.request)).some((n) => n.content.includes(`id: ${key}-1\n`))).toBe(true);

  // "Projects" shows the group's project
  await ben.goto('/projects');
  await expect(ben.locator(`[data-project-link="${key}"]`)).toBeVisible();
});

test('database notes of a group are in no list, its project still works', async ({ page }) => {
  const group = await groupWithDatabases(page.request);
  await expectDatabasesHidden(page, group);
});

test('workflow: enforced order, a rule from a template and a GitLab webhook that moves the ticket', async ({ page }) => {
  await enableFeature(page, 'tickets');
  const folder = `Flow ${uid()}`;
  const key = `W${letters()}`;
  await seed(page.request, [{ path: `${folder}/Readme.md`, content: 'About the project' }]);
  await page.goto(`/f/${encodeURIComponent(folder)}`);
  await page.locator('[data-make-project]').click();
  await page.locator('[data-project-key]').fill(key);
  await page.getByRole('button', { name: 'Create project' }).click();
  const project = page.locator(`[data-project="${key}"]`);
  await expect(project).toBeVisible();
  const [ticketId] = await seed(page.request, [{ path: `${folder}/Login.md`, content: `---\ntype: ticket\nid: ${key}-?\nstatus: Open\npriority: medium\n---\n` }]);

  // Settings use the whole window: order forward only, plus the "merge sets the status" rule
  await project.getByRole('button', { name: 'Project settings' }).click();
  const dialog = page.locator('[data-project-settings]');
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box!.width).toBeGreaterThan(viewport.width * 0.85);
  await dialog.locator('[data-section="transitions"]').click();
  await dialog.getByRole('switch', { name: 'Enforce the order' }).click();
  await dialog.locator('[data-preset="forward"]').click();
  await expect(dialog.getByRole('checkbox', { name: 'Allow Open → Done' })).toHaveAttribute('aria-checked', 'false');
  await expect(dialog.getByRole('checkbox', { name: 'Allow Open → In progress' })).toHaveAttribute('aria-checked', 'true');
  await dialog.locator('[data-section="automations"]').click();
  await dialog.locator('[data-template="merge"]').click();
  await expect(dialog.locator('[data-rule-editor]')).toContainText('a merge request is merged');
  await dialog.locator('[data-save-project]').click();
  await expect(dialog).toBeHidden();

  // The ticket menu offers only the next status
  await page.goto(`/n/${ticketId}`);
  const panel = page.locator('[data-ticket-panel]');
  await panel.getByRole('combobox', { name: 'Status' }).click();
  await expect(page.getByRole('option', { name: 'In progress', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Done', exact: true })).toHaveCount(0);
  await page.getByRole('option', { name: 'In progress', exact: true }).click();
  await expect.poll(async () => (await serverNote(page.request, ticketId))?.content ?? '').toContain('status: In progress');

  // A webhook for GitLab; a merge naming the ticket in its branch finishes it (the rule may skip Review)
  await page.goto(`/f/${encodeURIComponent(folder)}`);
  await project.getByRole('button', { name: 'Project settings' }).click();
  await dialog.locator('[data-section="git"]').click();
  await dialog.locator('[data-create-hook]').click();
  const created = dialog.locator('[data-hook-created]');
  await expect(created).toBeVisible();
  const url = await created.getByRole('textbox', { name: 'Address (URL)' }).inputValue();
  const secret = await created.getByRole('textbox', { name: 'Secret token' }).inputValue();
  const res = await page.request.post(url, {
    headers: { 'X-Gitlab-Event': 'Merge Request Hook', 'X-Gitlab-Token': secret, 'Content-Type': 'application/json' },
    data: { object_kind: 'merge_request', user: { username: 'dev' }, object_attributes: { action: 'merge', iid: 7, title: 'Login form', source_branch: `feature/${key.toLowerCase()}-1-login`, url: 'https://git.example/mr/7', description: '' } },
  });
  expect(res.status()).toBe(200);
  await expect.poll(async () => (await serverNote(page.request, ticketId))?.content ?? '').toContain('status: Done');
  expect((await serverNote(page.request, ticketId))?.content).toContain('Merged: https://git.example/mr/7');
});

test('ticket types: an epic with a feature below it, doc search and hidden frontmatter', async ({ page }) => {
  await enableFeature(page, 'tickets');
  const folder = `Types ${uid()}`;
  const key = `K${letters()}`;
  await seed(page.request, [{ path: `${folder}/Architecture overview.md`, content: 'How sync works' }]);
  await page.goto(`/f/${encodeURIComponent(folder)}`);
  await page.locator('[data-make-project]').click();
  await page.locator('[data-project-key]').fill(key);
  await page.getByRole('button', { name: 'Create project' }).click();
  const project = page.locator(`[data-project="${key}"]`);

  // An epic
  await project.locator('[data-new-ticket]').click();
  await page.locator('[data-new-ticket-title]').fill('Offline first');
  await choose(page, page.getByRole('dialog'), 'Type', 'Epic');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForURL(/\/n\/[0-9a-f]+/);
  const epicId = /\/n\/([0-9a-f]+)/.exec(page.url())![1];
  await expect(page.locator('[data-ticket-id]')).toHaveText(`${key}-1`, { timeout: 15_000 });
  // The panel shows the fields, the frontmatter row above the text stays hidden
  await expect(page.locator('.wz-props')).toHaveCount(0);
  await expect(page.locator('.wz-props-hidden')).toHaveCount(1);

  // A feature below it, from the epic's children section
  await page.locator('[data-new-child="feature"]').click();
  await page.locator('[data-new-ticket-title]').fill('Sync status');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.endsWith(epicId));
  const featureId = /\/n\/([0-9a-f]+)/.exec(page.url())![1];
  await expect.poll(async () => (await serverNote(page.request, featureId))?.content ?? '').toMatch(/kind: feature[\s\S]*parent: "\[\[\w+-1\]\]"/);
  await expect(page.locator('[data-ticket-ancestors]')).toContainText('Offline first');

  // Documentation by search: a word from the title finds the note
  const panel = page.locator('[data-ticket-panel]');
  await panel.getByRole('combobox', { name: 'Link documentation' }).fill('architec');
  await page.getByRole('option', { name: /Architecture overview/ }).click();
  await expect.poll(async () => (await serverNote(page.request, featureId))?.content ?? '').toContain('docs: ["[[Architecture overview]]"]');

  // The epic lists the feature with the progress over its children
  await page.goto(`/n/${epicId}`);
  await expect(page.locator('[data-ticket-children]')).toContainText('Sync status');
  await expect(page.locator('[data-ticket-children]')).toContainText('0/1');
});

test('milestones: status, dependencies with a conflict, blocked by on tickets and the panel beside the text', async ({ page }, info) => {
  await enableFeature(page, 'tickets');
  const folder = `Plan ${uid()}`;
  const key = `M${letters()}`;
  await seed(page.request, [{ path: `${folder}/Readme.md`, content: 'Plan' }]);
  await page.goto(`/f/${encodeURIComponent(folder)}`);
  await page.locator('[data-make-project]').click();
  await page.locator('[data-project-key]').fill(key);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.locator(`[data-project="${key}"]`)).toBeVisible();
  const ms = `${folder}/Meilensteine`;
  const [alphaId, betaId, oneId, twoId] = await seed(page.request, [
    { path: `${ms}/Alpha.md`, content: '---\ntype: milestone\nstart: 2026-11-01\ndue: 2026-11-30\nrelease: 1.0\n---\n' },
    { path: `${ms}/Beta.md`, content: '---\ntype: milestone\nstart: 2026-11-15\ndue: 2026-12-20\n---\n' },
    { path: `${folder}/Login.md`, content: `---\ntype: ticket\nid: ${key}-1\nstatus: Open\nmilestone: "[[Alpha]]"\n---\n` },
    { path: `${folder}/Logout.md`, content: `---\ntype: ticket\nid: ${key}-2\nstatus: Open\nmilestone: "[[Alpha]]"\n---\n` },
  ]);

  // A milestone without started tickets is planned; waiting for Alpha, which ends after Beta starts, is a conflict
  await page.goto(`/n/${betaId}`);
  const beta = page.locator('[data-milestone-panel]');
  await expect(beta.locator('[data-milestone-status="planned"]').first()).toBeVisible({ timeout: 15_000 });
  await choose(page, beta, 'Blocked by …', 'Alpha');
  await expect.poll(async () => (await serverNote(page.request, betaId))?.content ?? '').toContain('blockedBy: ["[[Alpha]]"]');
  await expect(beta.locator('[data-milestone-conflict]')).toContainText('Alpha');
  await expect(beta.getByText('blocked by Alpha')).toBeVisible();

  // Closing Alpha by hand while tickets are open warns; Beta is no longer blocked
  await page.goto(`/n/${alphaId}`);
  const alpha = page.locator('[data-milestone-panel]');
  await expect(alpha.getByText('blocks Beta')).toBeVisible({ timeout: 15_000 });
  await choose(page, alpha, 'Status', 'Done');
  await expect.poll(async () => (await serverNote(page.request, alphaId))?.content ?? '').toContain('status: done');
  await expect(alpha.locator('[data-milestone-open-left]')).toContainText('2 tickets');

  // "Blocked by" on a ticket is written on that ticket; the other one shows "blocks"
  await page.goto(`/n/${twoId}`);
  const two = page.locator('[data-ticket-panel]');
  await choose(page, two, 'Blocked by …', `${key}-1 · Login`);
  await expect.poll(async () => (await serverNote(page.request, twoId))?.content ?? '').toContain(`blockedBy: ["[[${key}-1]]"]`);
  await expect(two.getByText('Blocked', { exact: true }).first()).toBeVisible();
  await page.goto(`/n/${oneId}`);
  const one = page.locator('[data-ticket-panel]');
  await expect(one.getByText(`blocks ${key}-2`)).toBeVisible({ timeout: 15_000 });
  // Removing it from the blocking side clears it on the blocked ticket
  await one.getByRole('button', { name: `Remove the link to blocks ${key}-2` }).click();
  await expect.poll(async () => (await serverNote(page.request, twoId))?.content ?? '').not.toContain('blockedBy');

  // With room the panel sits beside the text
  if (info.project.name === 'desktop') {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(`/n/${oneId}`);
    const side = page.locator('[data-ticket-side]');
    const editor = page.locator('.cm-editor').first();
    await expect(side.locator('[data-ticket-panel]')).toBeVisible({ timeout: 15_000 });
    const [s, e] = [await side.boundingBox(), await editor.boundingBox()];
    expect(s!.x).toBeGreaterThan(e!.x + e!.width - 1);
  }

  // The roadmap explains its marks
  await page.goto(`/f/${encodeURIComponent(folder)}`);
  await page.locator('[data-project-tab="roadmap"]').click();
  await expect(page.locator('[data-roadmap-legend]')).toContainText('Release date');
  await expect(page.locator('[data-release-marker]')).toHaveCount(1);
});
