import { useSyncExternalStore } from 'react';

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
  if (to === location.pathname + location.search) return;
  withTransition(() => {
    if (replace) history.replaceState(null, '', to);
    else history.pushState(null, '', to);
    notify();
  });
}

export function usePath(): string {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => location.pathname
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
