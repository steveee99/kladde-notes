import { useSyncExternalStore } from 'react';

/**
 * Read-only mode for the whole app on this device: notes, tasks and folders cannot be changed.
 * Elements with the class `edit-only` are hidden through `html[data-readonly]` (see index.css).
 */
const KEY = 'kladde_readonly';
const listeners = new Set<() => void>();

function load(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

let current = load();

function apply() {
  if (current) document.documentElement.dataset.readonly = '';
  else delete document.documentElement.dataset.readonly;
}
apply();

export function isReadOnly(): boolean {
  return current;
}

export function setReadOnly(on: boolean): void {
  if (on === current) return;
  current = on;
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    // private mode: the choice lasts for this visit
  }
  apply();
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useReadOnly(): boolean {
  return useSyncExternalStore(subscribe, isReadOnly);
}
