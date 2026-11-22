import fs from 'fs';
import path from 'path';
import { test, expect, newContextAs, editor } from '../helpers';
import { generateVault } from '../fixtures/largeVault.mjs';

// Browser benchmark on a large vault (#64): `npm run build`, then `npm run bench:e2e`.
// Seeds 5,000 notes (20,000 links, 10,000 tasks) for the account `perf` and measures what users wait for.
// The numbers go to the console and to test-results/perf-large-vault.json; compare them across changes.

const NOTES = Number(process.env.BENCH_NOTES ?? 5000);

interface Result {
  name: string;
  ms: number;
  note?: string;
}

test('large vault', async ({ browser }, testInfo) => {
  test.setTimeout(Number(process.env.BENCH_TIMEOUT ?? 10 * 60_000));
  const results: Result[] = [];
  const out = path.join(testInfo.config.rootDir, '..', 'test-results', 'perf-large-vault.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // Written after every step, so a step that never finishes still leaves the earlier numbers
  const record = (name: string, ms: number, note?: string) => {
    results.push({ name, ms: Math.round(ms), note });
    console.log(`  ${name}: ${Math.round(ms)} ms ${note ?? ''}`);
    fs.writeFileSync(out, JSON.stringify({ notes: NOTES, at: new Date().toISOString(), results }, null, 2));
  };
  const stepTimeout = Number(process.env.BENCH_STEP_TIMEOUT ?? 60_000);

  // Seed through the sync API, like a device that wrote all of it
  const context = await newContextAs(browser, testInfo, 'perf');
  const api = context.request;
  const vault = generateVault({ notes: NOTES, links: NOTES * 4, tasks: NOTES * 2 });
  const existing = ((await (await api.get('/api/sync?since=0')).json()) as { notes: { id: string }[] }).notes.length;
  if (existing < NOTES) {
    for (let i = 0; i < vault.length; i += 500) {
      const changes = vault.slice(i, i + 500).map((n) => ({ ...n, baseVersion: 0, deleted: false }));
      const res = await api.post('/api/sync', { data: { changes } });
      expect(res.ok()).toBe(true);
    }
  }

  const page = await context.newPage();
  const countLocal = () =>
    page.evaluate(
      async () =>
        new Promise<number>((resolve) => {
          const dbs = indexedDB.databases ? indexedDB.databases() : Promise.resolve([]);
          void dbs.then((list) => {
            const name = list.map((d) => d.name).find((n) => n?.startsWith('kladde-'));
            if (!name) return resolve(0);
            const open = indexedDB.open(name);
            open.onsuccess = () => {
              const db = open.result;
              try {
                const req = db.transaction('notes').objectStore('notes').count();
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => resolve(0);
              } catch {
                resolve(0);
              }
            };
            open.onerror = () => resolve(0);
          });
        })
    );

  // 1. First start on a new device: download and store everything
  let t = Date.now();
  const pulled = page.waitForResponse((r) => r.url().includes('/api/sync?since=0'));
  await page.goto('/');
  const response = await pulled;
  await response.finished();
  const downloadMs = Date.now() - t;
  // Large bodies leave the browser's cache: the size is measured again through the API, outside the timing
  const syncUrl = response.url();
  record('first sync: notes downloaded', downloadMs);
  await expect(page.getByRole('button', { name: 'Synced' }).first()).toBeVisible({ timeout: Number(process.env.BENCH_SYNC_TIMEOUT ?? 120_000) });
  await expect(page.getByRole('region', { name: 'Recently edited' })).toBeVisible();
  record('first sync: stored and home shown', Date.now() - t);
  expect(await countLocal()).toBeGreaterThanOrEqual(NOTES);

  // 2. Start again: everything comes from IndexedDB
  t = Date.now();
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Recently edited' })).toBeVisible();
  record('start from IndexedDB (reload until home)', Date.now() - t);
  // Home shows before the notes are read: wait until the folder tree has them
  await expect(page.getByRole('complementary', { name: 'Folders' }).getByText(vault[0].path.split('/')[0], { exact: true }).first()).toBeVisible({ timeout: 300_000 });
  record('start from IndexedDB (reload until the folder tree is filled)', Date.now() - t);

  // 3. Typing in a note with many backlinks: Event Timing gives the time from key press to the next paint
  const target = vault[0];
  await page.goto(`/n/${target.id}`);
  await expect(editor(page)).toBeVisible({ timeout: 300_000 });
  await editor(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.evaluate(() => {
    const w = window as unknown as { __keys: number[] };
    w.__keys = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.name === 'keydown') w.__keys.push(e.duration);
    }).observe({ type: 'event', durationThreshold: 16, buffered: false } as PerformanceObserverInit);
  });
  // `BENCH_PROFILE=1`: a CPU profile of the typing (test-results/perf-typing.cpuprofile, opens in Chrome DevTools)
  const cdp = process.env.BENCH_PROFILE ? await context.newCDPSession(page) : null;
  if (cdp) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.start');
  }
  const text = ' tippen im grossen vault';
  t = Date.now();
  for (const ch of text) await page.keyboard.type(ch, { delay: 30 });
  await expect(editor(page)).toContainText('tippen im grossen vault');
  const typedMs = Date.now() - t;
  if (cdp) {
    await page.waitForTimeout(1500);
    const { profile } = await cdp.send('Profiler.stop');
    fs.writeFileSync(path.join(path.dirname(out), 'perf-typing.cpuprofile'), JSON.stringify(profile));
  }
  await page.waitForTimeout(500);
  const slow = await page.evaluate(() => (window as unknown as { __keys: number[] }).__keys);
  // Event Timing reports from 16 ms on, so a keystroke missing here was faster than that
  const sorted = [...slow, ...Array(Math.max(0, text.length - slow.length)).fill(0)].sort((a, b) => a - b);
  record('typing: median keystroke (key to paint)', sorted[Math.floor(sorted.length / 2)] ?? 0, '16 ms ≈ the next frame');
  record('typing: slowest keystroke (key to paint)', sorted.at(-1) ?? 0);
  record('typing: 30 keystrokes incl. 30 ms pauses', typedMs, 'ideal ≈ 900 ms');

  // 4. Search overlay
  await page.keyboard.press('ControlOrMeta+k');
  const box = page.getByRole('combobox', { name: 'Search' });
  await expect(box).toBeFocused();
  t = Date.now();
  await box.fill('garten budget');
  await expect(page.getByRole('option').first()).toBeVisible();
  record('search overlay: results for "garten budget"', Date.now() - t);
  await page.keyboard.press('Escape');

  // 5. Task page (10,000 tasks)
  t = Date.now();
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('checkbox').first()).toBeVisible({ timeout: stepTimeout });
  record('task page (load until first task)', Date.now() - t);

  // 6. Knowledge graph
  t = Date.now();
  await page.goto('/graph');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: stepTimeout });
  await page.waitForFunction(() => {
    const c = document.querySelector('canvas');
    return !!c && c.width > 0;
  });
  record('graph page (load until canvas)', Date.now() - t);

  const size = (await (await api.get(syncUrl)).body()).length;
  results[0].note = `${(size / 1e6).toFixed(1)} MB JSON`;

  const width = Math.max(...results.map((r) => r.name.length));
  const lines = results.map((r) => `${r.name.padEnd(width)}  ${String(r.ms).padStart(7)} ms  ${r.note ?? ''}`);
  console.log(`\nLarge vault: ${NOTES} notes · ${testInfo.project.name}\n${lines.join('\n')}\n`);
  fs.writeFileSync(out, JSON.stringify({ notes: NOTES, at: new Date().toISOString(), results }, null, 2));
  await testInfo.attach('results', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
  await context.close();
});
