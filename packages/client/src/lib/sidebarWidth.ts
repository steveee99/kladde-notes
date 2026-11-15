import { useSyncExternalStore } from 'react';

/** Width of the expanded (sticky) sidebar, dragged at its edge and kept per device */
const KEY = 'kladde_sidebar_width';
export const SIDEBAR_WIDTH_DEFAULT = 320;
export const SIDEBAR_WIDTH_MIN = 260;
export const SIDEBAR_WIDTH_MAX = 480;

const listeners = new Set<() => void>();

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.round(Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, width)));
}

function read(): number {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
    return raw === null ? SIDEBAR_WIDTH_DEFAULT : clampSidebarWidth(Number(raw));
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

let current = read();

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      current = read();
      listeners.forEach((l) => l());
    }
  });
}

/** Sets the width; `persist: false` only updates the layout (while dragging) */
export function setSidebarWidth(width: number, persist = true): void {
  const next = clampSidebarWidth(width);
  if (next !== current) {
    current = next;
    listeners.forEach((l) => l());
  }
  if (!persist) return;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, String(next));
  } catch {
    // private mode / storage blocked: only for this session
  }
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useSidebarWidth(): number {
  return useSyncExternalStore(subscribe, () => current);
}
