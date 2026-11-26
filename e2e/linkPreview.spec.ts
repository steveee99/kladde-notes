import { test, expect, editor, enableFeature, uid } from './helpers';

// Preview of [[links]] on hover (#130, opt-in)

const hexId = () => [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');

test('hovering a link shows the linked note, also a section of it, and the card opens it', async ({ page }) => {
  const name = `Ziel${uid()}`;
  const now = Date.now();
  const target = { id: hexId(), path: `Preview/${name}.md`, content: `# ${name}\nErster **wichtiger** Satz mit [[Anderes|Link]].\n\n## Details\nNur im Abschnitt.\n` };
  const source = { id: hexId(), path: `Preview/Quelle ${name}.md`, content: `Siehe [[${name}]] und [[${name}#Details]] und [[Fehlt${name}]].\n\nZweite Zeile\n` };
  const changes = [target, source].map((n) => ({ ...n, baseVersion: 0, deleted: false, createdAt: now, updatedAt: now }));
  expect((await page.request.post('/api/sync', { data: { changes } })).ok()).toBe(true);

  // Off by default: no card
  await page.goto(`/n/${source.id}`);
  await page.locator('.cm-content').first().locator('text=Zweite Zeile').click();
  const links = editor(page).locator('[data-wiki-target]');
  await links.first().hover();
  await page.waitForTimeout(800);
  await expect(page.locator('.link-preview')).toHaveCount(0);

  await enableFeature(page, 'linkPreview');
  await page.goto(`/n/${source.id}`);
  await page.locator('.cm-content').first().locator('text=Zweite Zeile').click();
  await editor(page).locator(`[data-wiki-target="${name}"]`).hover();
  const card = page.locator('.link-preview');
  await expect(card).toBeVisible();
  await expect(card).toContainText(name);
  await expect(card).toContainText('Erster wichtiger Satz mit Link.');

  await editor(page).locator(`[data-wiki-target="${name}#Details"]`).hover();
  await expect(card).toContainText('Nur im Abschnitt.');
  await expect(card).not.toContainText('Erster');

  await editor(page).locator(`[data-wiki-target="Fehlt${name}"]`).hover();
  await expect(card).toContainText('does not exist');

  await editor(page).locator(`[data-wiki-target="${name}"]`).hover();
  await expect(card).toContainText('Erster');
  await card.click();
  await page.waitForURL(new RegExp(`/n/${target.id}`));
});
