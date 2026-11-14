import { useSyncExternalStore } from 'react';

/**
 * Where the app lives: `/` normally, a sub path such as `/kladde-notes/` for the GitHub Pages demo.
 * Routes (`/n/<id>`, …) are always written without it.
 */
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

/** The current route, without the base path */
export function currentPath(): string {
  const p = location.pathname;
  if (!BASE) return p;
  return p === BASE || p.startsWith(`${BASE}/`) ? p.slice(BASE.length) || '/' : p;
}

/** A file of the app itself (icons, fonts) under the base path */
export function appUrl(path: string): string {
  return `${BASE}${path}`;
}

/** Minimal history router; page changes run through the View Transitions API where available */
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
window.addEventListener('popstate', () => withTransition(notify));

function withTransition(fn: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (doc.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) doc.startViewTransition(fn);
  else fn();
}

export function navigate(to: string, replace = false): void {
  if (to === currentPath() + location.search) return;
  withTransition(() => {
    if (replace) history.replaceState(null, '', BASE + to);
    else history.pushState(null, '', BASE + to);
    notify();
  });
}

export function usePath(): string {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    currentPath
  );
}

export function match(path: string, pattern: string): Record<string, string> | null {
  const p = pattern.split('/');
  const a = path.split('/');
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(a[i]);
    else if (p[i] !== a[i]) return null;
  }
  return params;
}
