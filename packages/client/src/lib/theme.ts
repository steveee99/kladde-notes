import { useSyncExternalStore } from 'react';

export type ThemeChoice = 'system' | 'light' | 'material';
const KEY = 'kladde_theme';

export function getTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(KEY);
    // The former dark themes ('dark', 'oled') are gone: Material is the dark theme now
    if (stored === 'dark' || stored === 'oled') return 'material';
    return (stored as ThemeChoice) || 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(choice: ThemeChoice = getTheme()): void {
  const resolved = choice === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'material' : 'light') : choice;
  const root = document.documentElement;
  root.dataset.theme = resolved;
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim().split(/\s+/).join(',');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', `rgb(${bg})`);
}

export function setTheme(choice: ThemeChoice): void {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    // private mode: the choice lasts for this visit
  }
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (doc.startViewTransition) doc.startViewTransition(() => applyTheme(choice));
  else applyTheme(choice);
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => getTheme() === 'system' && applyTheme());

/** The theme in effect right now (never 'system'); components with their own layout per theme re-render on changes */
function subscribeTheme(cb: () => void): () => void {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => mo.disconnect();
}
export function useResolvedTheme(): string {
  return useSyncExternalStore(subscribeTheme, () => document.documentElement.dataset.theme ?? 'light');
}
