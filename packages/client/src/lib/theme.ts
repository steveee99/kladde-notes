import { useSyncExternalStore } from 'react';

export type ThemeChoice = 'material';
/** Color scheme of the Material 3 design, stored per device ('system' follows the OS) */
export type ColorSchemeChoice = 'dark' | 'light' | 'system';
export type ColorScheme = 'dark' | 'light';

const KEY = 'kladde_color_scheme';
const listeners = new Set<() => void>();
const lightQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

function readChoice(): ColorSchemeChoice {
  try {
    if (typeof localStorage === 'undefined') return 'dark';
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'system' ? v : 'dark';
  } catch {
    return 'dark';
  }
}

let current: ColorSchemeChoice = readChoice();

export function getColorSchemeChoice(): ColorSchemeChoice {
  return current;
}

function resolveScheme(choice: ColorSchemeChoice): ColorScheme {
  if (choice === 'system') return lightQuery?.matches ? 'light' : 'dark';
  return choice;
}

/** Applies the Material 3 theme with the resolved color scheme and updates the browser bar color */
export function applyTheme(): void {
  const root = document.documentElement;
  root.dataset.theme = 'material';
  root.dataset.scheme = resolveScheme(current);
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim().split(/\s+/).join(',');
  if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', `rgb(${bg})`);
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      current = readChoice();
      applyTheme();
      listeners.forEach((l) => l());
    }
  });
  // Only matters while the choice is 'system'
  lightQuery?.addEventListener('change', () => {
    if (current === 'system') applyTheme();
  });
}

export function setColorSchemeChoice(choice: ColorSchemeChoice): void {
  if (current === choice) return;
  current = choice;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, choice);
  } catch {
    // private mode / storage blocked
  }
  applyTheme();
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useColorSchemeChoice(): ColorSchemeChoice {
  return useSyncExternalStore(subscribe, () => current);
}

function subscribeRoot(cb: () => void): () => void {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-scheme'] });
  return () => mo.disconnect();
}

export function useResolvedTheme(): string {
  return useSyncExternalStore(subscribeRoot, () => document.documentElement.dataset.theme ?? 'material');
}

/** The scheme in effect right now ('system' already resolved) */
export function useResolvedScheme(): ColorScheme {
  return useSyncExternalStore(subscribeRoot, () => (document.documentElement.dataset.scheme === 'light' ? 'light' : 'dark'));
}
