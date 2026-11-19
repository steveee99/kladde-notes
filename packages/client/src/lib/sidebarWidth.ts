import { useSyncExternalStore } from 'react';

/** A width dragged at a panel edge and kept per device */
export interface WidthStore {
  readonly min: number;
  readonly max: number;
  readonly fallback: number;
  clamp(width: number): number;
  get(): number;
  /** Sets the width; `persist: false` only updates the layout (while dragging) */
  set(width: number, persist?: boolean): void;
  subscribe(l: () => void): () => void;
}

export function createWidthStore(key: string, fallback: number, min: number, max: number): WidthStore {
  const listeners = new Set<() => void>();
  const clamp = (width: number) => (Number.isFinite(width) ? Math.round(Math.min(max, Math.max(min, width))) : fallback);
  const read = () => {
    try {
      const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
      return raw === null ? fallback : clamp(Number(raw));
    } catch {
      return fallback;
    }
  };
  let current = read();
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
      if (e.key === key) {
        current = read();
        listeners.forEach((l) => l());
      }
    });
  }
  return {
    min,
    max,
    fallback,
    clamp,
    get: () => current,
    set(width, persist = true) {
      const next = clamp(width);
      if (next !== current) {
        current = next;
        listeners.forEach((l) => l());
      }
      if (!persist) return;
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(key, String(next));
      } catch {
        // private mode / storage blocked: only for this session
      }
    },
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

/** Width of the expanded (sticky) left sidebar */
export const SIDEBAR_WIDTH_DEFAULT = 320;
export const SIDEBAR_WIDTH_MIN = 260;
export const SIDEBAR_WIDTH_MAX = 480;
export const sidebarWidth = createWidthStore('kladde_sidebar_width', SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX);

/** Width of the right side panel of a note (outline, tasks, backlinks, comments) */
export const sidePaneWidth = createWidthStore('kladde_side_pane_width', 352, 280, 640);

export const clampSidebarWidth = (width: number) => sidebarWidth.clamp(width);
export const setSidebarWidth = (width: number, persist = true) => sidebarWidth.set(width, persist);

export function useWidth(store: WidthStore): number {
  return useSyncExternalStore(store.subscribe, store.get);
}

export function useSidebarWidth(): number {
  return useWidth(sidebarWidth);
}
