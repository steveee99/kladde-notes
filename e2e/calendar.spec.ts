import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext } from '@playwright/test';
import { test, expect, uid, noteTitle } from './helpers';

// Calendar view (#72): tasks by due date in month, week and agenda; drag to reschedule; a day opens its daily note

const hexId = () => [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** A neighbouring day in the same week (Monday to Sunday) and month as today, so the week and month views show both */
const near = (() => {
  const today = new Date();
  const week = (d: Date) => {
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return monday.toDateString();
  };
  for (const offset of [1, -1]) {
    const d = new Date(today);
    d.setDate(d.getDate() + offset);
    if (d.getMonth() === today.getMonth() && week(d) === week(today)) return offset;
  }
  return 1;
})();

async function seed(request: APIRequestContext, path: string, content: string): Promise<string> {
  const id = hexId();
  const now = Date.now();
  const res = await request.post('/api/sync', { data: { changes: [{ id, baseVersion: 0, path, content, deleted: false, createdAt: now, updatedAt: now }] } });
  expect(res.ok()).toBe(true);
  return id;
}

test('the calendar shows tasks and dated notes, reschedules by drag and drop and opens daily notes', async ({ page }) => {
  const tag = `kal${uid()}`;
  const task = `Zahnarzt anrufen ${uid()}`;
  const other = `Steuer ${uid()}`;
  const meeting = `Meeting ${uid()}`;
  const id = await seed(page.request, `Kalender ${uid()}.md`, `- [ ] ${task} 📅 ${day(0)} ⏰ 09:30 #${tag}\n- [ ] ${other} 📅 ${day(1)}\n`);
  await seed(page.request, `${meeting}.md`, `---\ndate: ${day(near)}\n---\nAgenda`);

  await page.goto('/calendar');
  const view = page.locator('[data-calendar-view]');
  await expect(view.locator('[data-calendar="month"]')).toBeVisible({ timeout: 15_000 });
  const entry = view.locator('[data-calendar-entry="task"]', { hasText: task });
  await expect(entry).toBeVisible();
  await expect(entry).toContainText('09:30');
  await expect(view.locator(`[data-drop-day="${day(near)}"]`).getByText(meeting)).toBeVisible();

  // The tag filter keeps only the tagged task
  await view.getByRole('combobox', { name: 'Filter by tag' }).click();
  await page.getByRole('option', { name: `#${tag}` }).click();
  await expect(view.getByText(other)).toHaveCount(0);
  await expect(entry).toBeVisible();
  await view.getByRole('combobox', { name: 'Filter by tag' }).click();
  await page.getByRole('option', { name: 'All tags' }).click();

  // Drag the task to the next day: its line gets the new due date
  await entry.dragTo(view.locator(`[data-drop-day="${day(near)}"]`));
  await expect(view.locator(`[data-drop-day="${day(near)}"]`).locator('[data-calendar-entry="task"]', { hasText: task })).toBeVisible();
  await expect
    .poll(async () => {
      const res = await page.request.get('/api/sync?since=0');
      const body = (await res.json()) as { notes: { id: string; content: string }[] };
      return body.notes.find((c) => c.id === id)?.content ?? '';
    }, { timeout: 15_000 })
    .toContain(`📅 ${day(near)}`);

  // Week and agenda
  await view.getByRole('button', { name: 'Week' }).click();
  await expect(view.locator('[data-calendar="week"]').getByText(task)).toBeVisible();
  await view.getByRole('button', { name: 'Agenda' }).click();
  await expect(view.locator('[data-calendar="agenda"]').getByText(other)).toBeVisible();

  const axe = await new AxeBuilder({ page }).include('[data-calendar-view]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);

  // A day opens its daily note
  await view.getByRole('button', { name: 'Month' }).click();
  await view.getByRole('button', { name: /^Open the daily note for/ }).and(page.locator('[aria-current="date"]')).click();
  await expect(noteTitle(page)).toHaveValue(day(0), { timeout: 15_000 });
});
