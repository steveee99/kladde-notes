import { useSyncExternalStore } from 'react';

/*
 * What the folder tree shows besides notes (per browser, not synced): tickets, milestones and finished ones.
 * All off by default, so project folders do not flood the tree.
 */

export interface TreePrefs {
  /** Tickets of projects */
  tickets: boolean;
  /** Milestones of projects */
  milestones: boolean;
  /** Finished tickets and milestones (done, cancelled) */
  done: boolean;
}

const KEY = 'kladde_tree_prefs';
const DEFAULTS: TreePrefs = { tickets: false, milestones: false, done: false };
const listeners = new Set<() => void>();

function read(): TreePrefs {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as Partial<Record<keyof TreePrefs, unknown>>) : {};
    return { tickets: v.tickets === true, milestones: v.milestones === true, done: v.done === true };
  } catch {
    return { ...DEFAULTS };
  }
}

let prefs = read();

export function getTreePrefs(): TreePrefs {
  return prefs;
}

export function setTreePrefs(patch: Partial<TreePrefs>): void {
  prefs = { ...prefs, ...patch };
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // storage blocked: only for this session
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useTreePrefs(): TreePrefs {
  return useSyncExternalStore(subscribe, () => prefs);
}
