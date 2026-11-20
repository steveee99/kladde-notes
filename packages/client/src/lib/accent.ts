import { useSyncExternalStore } from 'react';
import { DEFAULT_ACCENT, isAccent, normalizeAccent, type Accent, type Me } from '@kladde/shared';
import { api } from './api';

/*
 * Accent color of the Werkbank design (docs/DESIGN.md). It belongs to the account (`Me.accent`, stored on the
 * server) and is cached on the device, so the inline script in index.html sets `data-accent` before the first
 * paint, also offline. The CSS values per preset and scheme are in index.css (`[data-accent='…']`).
 */

const KEY = 'kladde_accent';
const listeners = new Set<() => void>();

function readCached(): Accent {
  try {
    return typeof localStorage === 'undefined' ? DEFAULT_ACCENT : normalizeAccent(localStorage.getItem(KEY));
  } catch {
    return DEFAULT_ACCENT;
  }
}

let current: Accent = readCached();

function apply(accent: Accent): void {
  current = accent;
  if (typeof document !== 'undefined') document.documentElement.dataset.accent = accent;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, accent);
  } catch {
    // private mode / storage blocked: only for this session
  }
  listeners.forEach((l) => l());
}

export function getAccent(): Accent {
  return current;
}

/** Takes the account's accent (after sign-in or a fresh /auth/me) */
export function applyAccentOf(me: Pick<Me, 'accent'>): void {
  const accent = normalizeAccent(me.accent);
  if (accent !== current || document.documentElement.dataset.accent !== accent) apply(accent);
}

/** Picks an accent: shows it at once, stores it with the account and hands the updated account back */
export async function chooseAccent(accent: Accent, onMe?: (me: Me) => void): Promise<void> {
  if (!isAccent(accent)) return;
  const before = current;
  apply(accent);
  try {
    const me = await api<Me>('/me/accent', { method: 'PUT', json: { accent } });
    onMe?.(me);
  } catch (err) {
    apply(before);
    throw err;
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      current = readCached();
      document.documentElement.dataset.accent = current;
      listeners.forEach((l) => l());
    }
  });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useAccent(): Accent {
  return useSyncExternalStore(subscribe, () => current);
}
