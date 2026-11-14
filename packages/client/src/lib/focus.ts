import { useSyncExternalStore } from 'react';

/*
 * Focus mode: hides navigation and side panels around an open note and centers the text.
 * It lasts for this tab only (not saved) and ends when no note is open any more.
 */

let focus = false;
const listeners = new Set<() => void>();

function apply() {
  if (typeof document === 'undefined') return;
  if (focus) document.documentElement.dataset.focus = 'on';
  else delete document.documentElement.dataset.focus;
}

export function getFocusMode(): boolean {
  return focus;
}

export function setFocusMode(on: boolean): void {
  if (focus === on) return;
  focus = on;
  apply();
  listeners.forEach((l) => l());
}

export function toggleFocusMode(): void {
  setFocusMode(!focus);
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useFocusMode(): boolean {
  return useSyncExternalStore(subscribe, () => focus);
}
