import { test, expect, createNote, typeInEditor, uid } from './helpers';

// Instant updates: the live event stream greets every (re)connecting client with the server's version, so open
// apps notice a deploy (which restarts the server) within seconds; lib/update.ts compares it with its own

test('the event stream tells clients the server version', async ({ page }) => {
  await page.goto('/');
  const health = (await (await page.request.get('/health')).json()) as { version: string };
  const hello = await page.evaluate(
    () =>
      new Promise<unknown>((resolve, reject) => {
        const events = new EventSource('/api/events?client=e2e-update-check');
        events.addEventListener('hello', (e) => {
          events.close();
          resolve(JSON.parse((e as MessageEvent<string>).data));
        });
        setTimeout(() => reject(new Error('no hello')), 10_000);
      })
  );
  expect(hello).toEqual({ version: health.version });
});

test('a new server version reloads the app after a typing pause, even with the cursor in the editor', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await createNote(page, `Update ${uid()}`);
  await typeInEditor(page, 'Text');
  await page.evaluate(() => {
    (window as unknown as { beforeUpdate?: boolean }).beforeUpdate = true;
    window.dispatchEvent(new CustomEvent('kladde-server-version', { detail: '999.0.0' }));
  });
  // Not while typing: still the same page a moment later
  await page.waitForTimeout(3000);
  expect(await page.evaluate(() => (window as unknown as { beforeUpdate?: boolean }).beforeUpdate)).toBe(true);
  // After the pause (10 s without input) the app reloads although the editor still has the focus
  await expect.poll(() => page.evaluate(() => (window as unknown as { beforeUpdate?: boolean }).beforeUpdate ?? false), { timeout: 30_000 }).toBe(false);
});
