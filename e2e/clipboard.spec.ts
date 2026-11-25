import { createNote, expect, expectSynced, noteMenu, test, uid } from './helpers';

test('copy buttons work without navigator.clipboard, as over plain HTTP', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => {
    const real = navigator.clipboard;
    (window as unknown as { pasted: () => Promise<string> }).pasted = () => real.readText();
    Object.defineProperty(Navigator.prototype, 'clipboard', { value: undefined, configurable: true });
  });
  const pasted = () => page.evaluate(() => (window as unknown as { pasted: () => Promise<string> }).pasted());
  const code = `const a = '${uid()}';`;
  await createNote(page, `Copy ${uid()}`, `\`\`\`js\n${code}\n\`\`\`\n\nEnd\n`);
  expect(await page.evaluate(() => navigator.clipboard)).toBeUndefined();

  const copy = page.locator('.cm-code-copy').first();
  await copy.click();
  await expect(copy).toHaveText(/copied/i);
  expect((await pasted()).trim()).toBe(code);
  // The editor keeps the focus
  expect(await page.evaluate(() => !!document.activeElement?.closest('.cm-content'))).toBe(true);

  // Inside a dialog that traps the focus
  await expectSynced(page);
  await noteMenu(page, /^Share/);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('switch', { name: /Public link/ }).click();
  const link = dialog.getByRole('button').filter({ hasText: 'http' });
  await link.click();
  await expect(dialog.getByText(/copied/i)).toBeVisible();
  expect(await pasted()).toMatch(/^http/);
});
