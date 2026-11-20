import { useSyncExternalStore } from 'react';

/*
 * Tabs of open notes (Werkbank, desktop): every note opened in the main pane gets a tab next to the active one.
 * Kept per device in localStorage, like the side panel's width; notes that no longer exist are dropped when
 * the tabs are shown (`NoteTabs`).
 */

const KEY = 'kladde_tabs';
/** More tabs than this push out the one used least recently */
export const MAX_TABS = 15;

interface TabState {
  ids: string[];
  /** Least recently used first, for dropping a tab when there are too many */
  used: string[];
}

const listeners = new Set<() => void>();

function read(): TabState {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    const clean = Array.isArray(ids) ? [...new Set(ids.filter((x): x is string => typeof x === 'string'))].slice(0, MAX_TABS) : [];
    return { ids: clean, used: [...clean] };
  } catch {
    return { ids: [], used: [] };
  }
}

let state: TabState = read();

function write(next: TabState): void {
  state = next;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(next.ids));
  } catch {
    // private mode / storage blocked: tabs only for this session
  }
  listeners.forEach((l) => l());
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      state = read();
      listeners.forEach((l) => l());
    }
  });
}

export function tabIds(): string[] {
  return state.ids;
}

/** Opens a tab for the note (after `after`, the tab that was active) or marks its tab as used */
export function touchTab(id: string, after?: string | null): void {
  const used = [...state.used.filter((x) => x !== id), id];
  if (state.ids.includes(id)) {
    state = { ...state, used };
    return;
  }
  const ids = [...state.ids];
  const at = after ? ids.indexOf(after) : -1;
  ids.splice(at >= 0 ? at + 1 : ids.length, 0, id);
  while (ids.length > MAX_TABS) {
    const drop = used.find((x) => x !== id && ids.includes(x)) ?? ids[0];
    ids.splice(ids.indexOf(drop), 1);
    used.splice(used.indexOf(drop), 1);
  }
  write({ ids, used });
}

/** Closes a tab; returns the tab that should become active when it was the active one (or null) */
export function closeTab(id: string): string | null {
  const i = state.ids.indexOf(id);
  if (i < 0) return null;
  const ids = state.ids.filter((x) => x !== id);
  write({ ids, used: state.used.filter((x) => x !== id) });
  return ids[i] ?? ids[i - 1] ?? null;
}

/** Keeps only the given tab */
export function closeOtherTabs(id: string): void {
  write({ ids: state.ids.filter((x) => x === id), used: state.used.filter((x) => x === id) });
}

/** Drops tabs whose notes are gone (deleted, no longer shared) */
export function pruneTabs(exists: (id: string) => boolean): void {
  const ids = state.ids.filter(exists);
  if (ids.length !== state.ids.length) write({ ids, used: state.used.filter(exists) });
}

/** Moves a tab to another position (drag and drop in the tab row) */
export function moveTab(id: string, to: number): void {
  const ids = state.ids.filter((x) => x !== id);
  if (ids.length === state.ids.length) return;
  ids.splice(Math.max(0, Math.min(to, ids.length)), 0, id);
  write({ ...state, ids });
}

/** The tab next to the given one (direction +1 right, -1 left), wrapping around */
export function neighborTab(id: string | null, direction: 1 | -1): string | null {
  if (!state.ids.length) return null;
  const i = id ? state.ids.indexOf(id) : -1;
  if (i < 0) return state.ids[direction > 0 ? 0 : state.ids.length - 1];
  return state.ids[(i + direction + state.ids.length) % state.ids.length];
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useTabs(): string[] {
  return useSyncExternalStore(subscribe, () => state.ids);
}
