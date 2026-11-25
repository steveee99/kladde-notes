import { useSyncExternalStore } from 'react';

/*
 * Tabs of open notes (Werkbank, desktop): every note opened in the main pane gets a tab next to the active one.
 * Kept per device in localStorage, like the side panel's width; notes that no longer exist are dropped when
 * the tabs are shown (`NoteTabs`).
 */

const KEY = 'kladde_tabs';
const PIN_KEY = 'kladde_tabs_pinned';
/** More tabs than this push out the one used least recently */
export const MAX_TABS = 15;

interface TabState {
  /** Pinned tabs come first */
  ids: string[];
  /** Least recently used first, for dropping a tab when there are too many */
  used: string[];
  /** Pinned tabs stay open until they are unpinned: closing does nothing and they are never pushed out */
  pinned: string[];
}

const listeners = new Set<() => void>();

function readList(key: string): string[] {
  const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  const ids = raw ? (JSON.parse(raw) as unknown) : [];
  return Array.isArray(ids) ? [...new Set(ids.filter((x): x is string => typeof x === 'string'))] : [];
}

/** Pinned tabs first, in their order */
function ordered(ids: string[], pinned: string[]): string[] {
  return [...ids.filter((x) => pinned.includes(x)), ...ids.filter((x) => !pinned.includes(x))];
}

function read(): TabState {
  try {
    const all = readList(KEY);
    const pinned = readList(PIN_KEY).filter((x) => all.includes(x));
    const clean = ordered(all, pinned).slice(0, Math.max(MAX_TABS, pinned.length));
    return { ids: clean, used: [...clean], pinned };
  } catch {
    return { ids: [], used: [], pinned: [] };
  }
}

let state: TabState = read();

function write(next: TabState): void {
  state = next;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(KEY, JSON.stringify(next.ids));
      localStorage.setItem(PIN_KEY, JSON.stringify(next.pinned));
    }
  } catch {
    // private mode / storage blocked: tabs only for this session
  }
  listeners.forEach((l) => l());
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY || e.key === PIN_KEY) {
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
  const { pinned } = state;
  const ids = [...state.ids];
  const at = after ? ids.indexOf(after) : -1;
  ids.splice(Math.max(at >= 0 ? at + 1 : ids.length, pinned.length), 0, id);
  while (ids.length > MAX_TABS) {
    const drop = used.find((x) => x !== id && ids.includes(x) && !pinned.includes(x));
    if (!drop) break;
    ids.splice(ids.indexOf(drop), 1);
    used.splice(used.indexOf(drop), 1);
  }
  write({ ids, used, pinned });
}

export function isPinnedTab(id: string): boolean {
  return state.pinned.includes(id);
}

/** Pins or unpins a tab; pinned tabs move to the start of the row */
export function setTabPinned(id: string, pin: boolean): void {
  if (!state.ids.includes(id) || state.pinned.includes(id) === pin) return;
  const pinned = pin ? [...state.pinned, id] : state.pinned.filter((x) => x !== id);
  const ids = ordered(state.ids.filter((x) => x !== id), pinned);
  ids.splice(pin ? pinned.length - 1 : pinned.length, 0, id);
  write({ ...state, ids, pinned });
}

/** Closes the given tabs except pinned ones; returns the tab to show when `active` was among them */
function closeMany(drop: (id: string, i: number) => boolean, active: string | null): string | null {
  const all = state.ids;
  const keep = all.filter((x, i) => state.pinned.includes(x) || !drop(x, i));
  if (keep.length === all.length) return null;
  const i = active ? all.indexOf(active) : -1;
  write({ ids: keep, used: state.used.filter((x) => keep.includes(x)), pinned: state.pinned });
  if (!active || keep.includes(active) || i < 0) return null;
  const after = all.slice(i + 1).find((x) => keep.includes(x));
  const before = all.slice(0, i).reverse().find((x) => keep.includes(x));
  return after ?? before ?? null;
}

/** Closes a tab (pinned tabs stay); returns the tab that should become active when it was the active one (or null) */
export function closeTab(id: string): string | null {
  return closeMany((x) => x === id, id);
}

/** Keeps only the given tab and the pinned ones */
export function closeOtherTabs(id: string): void {
  closeMany((x) => x !== id, null);
}

/** Closes the unpinned tabs right (+1) or left (-1) of the given one; returns the tab to show when `active` was closed */
export function closeTabsBeside(id: string, side: 1 | -1, active: string | null): string | null {
  const at = state.ids.indexOf(id);
  if (at < 0) return null;
  return closeMany((_, i) => (side > 0 ? i > at : i < at), active);
}

/** Drops tabs whose notes are gone (deleted, no longer shared) */
export function pruneTabs(exists: (id: string) => boolean): void {
  const ids = state.ids.filter(exists);
  if (ids.length !== state.ids.length) write({ ids, used: state.used.filter(exists), pinned: state.pinned.filter(exists) });
}

/** Moves a tab to another position (drag and drop in the tab row); pinned and other tabs stay in their own groups */
export function moveTab(id: string, to: number): void {
  const ids = state.ids.filter((x) => x !== id);
  if (ids.length === state.ids.length) return;
  const n = state.pinned.length;
  const pinned = state.pinned.includes(id);
  const lo = pinned ? 0 : n;
  const hi = pinned ? n - 1 : ids.length;
  ids.splice(Math.max(lo, Math.min(to, hi)), 0, id);
  const order = pinned ? ids.filter((x) => state.pinned.includes(x)) : state.pinned;
  write({ ...state, ids, pinned: order });
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

export function usePinnedTabs(): string[] {
  return useSyncExternalStore(subscribe, () => state.pinned);
}
