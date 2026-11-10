import { useSyncExternalStore } from 'react';

export type ThemeChoice = 'material';

/** Always applies the Material 3 theme (theme switcher removed) */
export function applyTheme(): void {
  const root = document.documentElement;
  root.dataset.theme = 'material';
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim().split(/\s+/).join(',');
  if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', `rgb(${bg})`);
}

function subscribeTheme(cb: () => void): () => void {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => mo.disconnect();
}

export function useResolvedTheme(): string {
  return useSyncExternalStore(subscribeTheme, () => document.documentElement.dataset.theme ?? 'material');
}
