import { test, expect, enableFeature, serverNotes, uid } from './helpers';

// Habit tracker (#134, opt-in)

test('set up a habit, check it off today and on an earlier day, and take a check-in back', async ({ page }) => {
  await enableFeature(page, 'habits');
  await page.goto('/habits');
  const name = `Laufen ${uid()}`;
  await page.locator('[data-new-habit]').click();
  const form = page.locator('[data-habit-form]');
  await form.getByRole('textbox', { name: 'Icon' }).fill('🏃');
  await form.getByRole('textbox', { name: 'Name' }).fill(name);
  await form.getByRole('button', { name: 'Save' }).click();
  const card = page.locator('[data-habit]').filter({ hasText: name });
  await expect(card).toBeVisible();
  const id = (await card.getAttribute('data-habit'))!;

  // The definition is a hidden note at the top of the space
  await expect.poll(async () => (await serverNotes(page.request)).some((n) => /^_habits-[0-9a-f-]+\.md$/.test(n.path) && n.content.includes(`${name} | daily | ${id}`))).toBe(true);

  await card.locator('[data-habit-today]').click();
  await expect(card.locator('[data-habit-today]')).toHaveAttribute('aria-pressed', 'true');
  await expect(card.locator('[data-habit-streak]')).toContainText('1 days');
  // The check-in is a done task in today's daily note
  await expect
    .poll(async () => (await serverNotes(page.request)).some((n) => n.content.includes(`- [x] 🏃 ${name} #habit/${id}`)))
    .toBe(true);

  // Yesterday as well: a streak of two
  const days = card.getByRole('group', { name: 'The last 7 days' }).getByRole('button');
  await days.nth(5).click();
  await expect(card.locator('[data-habit-streak]')).toContainText('2 days');

  // The home page offers today's habits
  await page.goto('/');
  const chip = page.locator('[data-habits-today]').getByRole('button', { name });
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
  await page.goto('/habits');
  await expect(card.locator('[data-habit-streak]')).toContainText('1 days');
});
