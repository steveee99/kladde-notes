import { useSyncExternalStore } from 'react';

/**
 * Syntax colors of fenced code blocks, chosen per device (Settings → Appearance). Each theme has a dark and a light
 * variant and follows the color scheme; the values are the --syn-* tokens in index.css under `[data-code-theme]`.
 * 'kladde' (no attribute) uses the Werkbank tokens and the account's accent. index.html sets the attribute before
 * the first paint.
 */
export const CODE_THEMES = ['kladde', 'catppuccin', 'github', 'one'] as const;
export type CodeTheme = (typeof CODE_THEMES)[number];

const KEY = 'kladde_code_theme';
const listeners = new Set<() => void>();

function read(): CodeTheme {
  try {
    const v = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
    return (CODE_THEMES as readonly string[]).includes(v ?? '') ? (v as CodeTheme) : 'kladde';
  } catch {
    return 'kladde';
  }
}

let current: CodeTheme = read();

function apply(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (current === 'kladde') delete root.dataset.codeTheme;
  else root.dataset.codeTheme = current;
}

export function getCodeTheme(): CodeTheme {
  return current;
}

export function setCodeTheme(theme: CodeTheme): void {
  if (theme === current) return;
  current = theme;
  try {
    if (typeof localStorage !== 'undefined') {
      if (theme === 'kladde') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, theme);
    }
  } catch {
    // private mode / storage blocked: only for this session
  }
  apply();
  listeners.forEach((l) => l());
}

if (typeof window !== 'undefined') {
  apply();
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      current = read();
      apply();
      listeners.forEach((l) => l());
    }
  });
}

export function useCodeTheme(): CodeTheme {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current
  );
}
