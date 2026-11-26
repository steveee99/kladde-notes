import { test, expect, expectOnServer, uid } from './helpers';

// Subtasks with progress and task dependencies (#75)

const hexId = () => [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');

test('subtasks show their progress and dependent tasks wait, also across notes', async ({ page }) => {
  const tag = uid();
  const now = Date.now();
  const plan = { id: hexId(), path: `Sub ${tag}/Plan.md`, content: `- [ ] Umzug ${tag} 🆔 umzug${tag}\n  - [x] Kartons ${tag}\n  - [ ] Packen ${tag}\n` };
  const party = { id: hexId(), path: `Sub ${tag}/Party.md`, content: `- [ ] Party ${tag} ⛔ umzug${tag}\n` };
  const changes = [plan, party].map((n) => ({ ...n, baseVersion: 0, deleted: false, createdAt: now, updatedAt: now }));
  expect((await page.request.post('/api/sync', { data: { changes } })).ok()).toBe(true);

  await page.goto('/tasks');
  const umzug = page.getByRole('listitem').filter({ hasText: `Umzug ${tag}` });
  await expect(umzug.locator('[data-task-progress]')).toHaveText('1/2');
  const partyRow = page.getByRole('listitem').filter({ hasText: `Party ${tag}` });
  await expect(partyRow.locator('[data-task-waiting]')).toBeVisible();
  await page.locator('[data-actionable-only]').click();
  await expect(partyRow).toBeHidden();
  await expect(umzug).toBeVisible();
  await page.locator('[data-actionable-only]').click();

  // In the editor: the progress chip on the parent, the id and the dependency as chips
  await page.goto(`/n/${plan.id}`);
  await expect(page.locator('.cm-due[data-kind="progress"]')).toHaveText('1/2');
  await expect(page.locator('.cm-due[data-kind="id"]')).toHaveText(`umzug${tag}`);

  // With "complete parent tasks" on, ticking the last subtask finishes the parent, and the party no longer waits
  await page.goto('/settings/appearance');
  await page.locator('#complete-parents-switch').click();
  await expect(page.locator('#complete-parents-switch')).toBeChecked();
  await page.goto('/tasks');
  await page.getByRole('checkbox', { name: `Packen ${tag}` }).click();
  await expectOnServer(page.request, plan.id, new RegExp(`- \\[x\\] Umzug ${tag} 🆔 umzug${tag} ✅`));
  await expect(page.getByRole('listitem').filter({ hasText: `Party ${tag}` }).locator('[data-task-waiting]')).toBeHidden();
});
