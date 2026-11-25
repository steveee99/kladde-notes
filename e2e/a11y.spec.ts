import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, createNote, editor, expectOnServer, noteMenu, serverNote, uid } from './helpers';

// Accessibility audit (#63): axe (WCAG 2.1 A/AA) on the main views and overlays in every color scheme,
// plus the keyboard paths through dialogs, menus and the Kanban board
const SCHEMES = ['dark', 'mocha', 'light'] as const;

async function violations(page: Page, label: string): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return result.violations.map(
    (v) => `${label}: ${v.id} (${v.impact}) ×${v.nodes.length} – ${v.nodes
      .slice(0, 3)
      .map((n) => n.target.join(' '))
      .join(' | ')}`
  );
}

async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  // Let entry animations finish so contrast is measured on the final colors
  await page.waitForTimeout(400);
}

const isDesktop = (name: string) => name === 'desktop';

for (const scheme of SCHEMES) {
  test(`views and overlays have no axe violations in the ${scheme} scheme`, async ({ page }, testInfo) => {
    test.slow();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript((s) => localStorage.setItem('kladde_color_scheme', s), scheme);
    const id = await createNote(page, `A11y ${uid()}`, '# Heading\n\n- [ ] A task due:today\n- [/] Doing something\n\nSome **bold** text and a [[Link]].');
    await expectOnServer(page.request, id, 'Doing something');
    const problems: string[] = [];
    const scan = async (label: string) => {
      await settle(page);
      problems.push(...(await violations(page, label)));
    };

    for (const [label, path] of [
      ['home', '/'],
      ['note', `/n/${id}`],
      ['tasks', '/tasks'],
      ['notes', '/notes'],
      ['tags', '/tags'],
      ['groups', '/groups'],
      ['settings', '/settings'],
      ['trash', '/trash'],
    ] as const) {
      await page.goto(path);
      await scan(label);
    }

    // Overlays and other states
    await page.goto('/tasks');
    await page.getByRole('button', { name: 'Kanban' }).click();
    await scan('kanban');

    await page.goto(`/n/${id}`);
    await page.getByRole('button', { name: 'Side pane (outline, links, graph)' }).click();
    await scan('side pane');
    await page.keyboard.press('Escape');

    await noteMenu(page, 'Share');
    await scan('share dialog');
    await page.keyboard.press('Escape');

    await page.goto('/settings');
    await page.locator('[data-open-features]').click();
    await scan('features dialog');
    await page.locator('[data-features-dialog] [data-tab="active"]').click();
    await page.locator('[data-features-dialog] [data-feature="para"] button').first().click();
    await scan('feature detail');
    await page.keyboard.press('Escape');

    if (isDesktop(testInfo.project.name)) {
      await page.getByRole('button', { name: 'New note', exact: true }).first().click();
      await scan('new note dialog');
      await page.keyboard.press('Escape');

      await page.keyboard.press('ControlOrMeta+k');
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.type('Heading');
      await scan('search');
      await page.keyboard.press('Escape');

      await page.goto('/admin');
      await scan('admin');

      await page.locator('[data-notifications-button]:visible').click();
      await expect(page.getByRole('dialog', { name: 'Notifications' })).toBeVisible();
      await scan('notifications panel');
      await page.keyboard.press('Escape');
    } else {
      await page.goto('/');
      await page.getByRole('button', { name: 'Menu' }).click();
      await scan('drawer');
    }

    expect(problems).toEqual([]);
  });
}

test('dialogs keep the focus inside, close with Escape and give it back', async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo.project.name), 'the rail button exists on desktop only');
  await page.goto('/');
  const opener = page.getByRole('button', { name: 'New note', exact: true }).first();
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'New note' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('input[placeholder="Title"]')).toBeFocused();

  // Tab around the whole dialog and stay inside
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test('the share dialog and the phone drawer close with Escape', async ({ page }, testInfo) => {
  await createNote(page, `Keys ${uid()}`, 'Text');
  await noteMenu(page, 'Share');
  const share = page.getByRole('dialog', { name: 'Share' });
  await expect(share).toBeVisible();
  await expect(share.getByRole('textbox', { name: 'Username' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(share).toBeHidden();
  await expect(editor(page)).toBeVisible();

  if (!isDesktop(testInfo.project.name)) {
    const menu = page.getByRole('button', { name: 'Menu' });
    await menu.click();
    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    await expect(drawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(menu).toBeFocused();
  }
});

test('a Kanban card changes its status with the keyboard', async ({ page }) => {
  const task = `Keyboard task ${uid()}`;
  const id = await createNote(page, `Board ${uid()}`, `- [ ] ${task}`);
  await expectOnServer(page.request, id, task);
  await page.goto('/tasks');
  await page.getByRole('button', { name: 'Kanban' }).click();
  const statusButton = page.getByRole('button', { name: new RegExp(`\\(Open\\): ${task}$`) });
  await statusButton.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: 'Change status' });
  await expect(menu.getByRole('menuitemradio', { name: 'Open' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitemradio', { name: 'In progress' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  await expect(page.getByTestId('kanban-doing').getByText(task)).toBeVisible();
  await expect(page.getByTestId('kanban-open').getByText(task)).toHaveCount(0);
  await expect.poll(async () => (await serverNote(page.request, id))?.content ?? '').not.toContain(`- [ ] ${task}`);
});

test('respects prefers-reduced-motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const durations = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.className = 'anim-sheet anim-fade-up';
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const result = [style.animationDuration, style.transitionDuration];
    probe.remove();
    return result;
  });
  for (const d of durations) expect(parseFloat(d)).toBeLessThanOrEqual(0.001);
});

test('navigation badges are announced with their meaning', async ({ page }) => {
  // The welcome note brings overdue and today's tasks, so the Tasks destination has a badge
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Navigation' });
  await expect(nav.getByRole('button', { name: /^Tasks\s*, \d+ overdue or due today$/ })).toBeVisible();
});
