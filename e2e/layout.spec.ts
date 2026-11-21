import { test, expect } from './helpers';

// The `nav:` layout switch: rail/sidebar with a mouse from 768 px, the bottom bar on phones and on tablets in portrait
test('shows the navigation that fits the device', async ({ page }, testInfo) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Navigation' });
  await expect(nav).toBeVisible();
  const destinations = nav.getByRole('button');
  const box = await nav.boundingBox();
  const viewport = page.viewportSize()!;

  if (testInfo.project.name === 'desktop') {
    // Rail on the left, with the new-note button
    expect(box!.x).toBeLessThan(10);
    expect(box!.height).toBeGreaterThan(viewport.height / 2);
    await expect(page.getByRole('button', { name: 'New note', exact: true }).first()).toBeVisible();
  } else {
    // Bottom bar across the width
    expect(box!.y + box!.height).toBeGreaterThan(viewport.height - 4);
    expect(box!.width).toBeGreaterThan(viewport.width * 0.9);
    await expect(page.getByRole('banner')).toBeVisible();
    const labels = await destinations.allInnerTexts();
    if (testInfo.project.name === 'phone') {
      // Phones: only the five main destinations (2.10.0 fixed a regression here)
      expect(await destinations.count()).toBe(5);
    } else {
      expect(labels.join(' ')).toMatch(/Search/);
      expect(await destinations.count()).toBeGreaterThan(5);
    }
  }
  // Nothing scrolls sideways
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
