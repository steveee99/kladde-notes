import { useSyncExternalStore } from 'react';

export type NoteSplitTab = 'toc' | 'links' | 'graph';

const INBOX_ZERO_KEY = 'kladde_inbox_zero';
const SPLIT_OPEN_KEY = 'kladde_note_split_open';
const SPLIT_TAB_KEY = 'kladde_note_split_tab';
const SOURCE_MODE_KEY = 'kladde_source_mode';

const listeners = new Set<() => void>();

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
  } catch {
    // ignore storage errors
  }
  return fallback;
}

function readSplitTab(): NoteSplitTab {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SPLIT_TAB_KEY) : null;
    if (raw === 'toc' || raw === 'links' || raw === 'graph') return raw;
  } catch {
    // ignore
  }
  return 'toc';
}

let inboxZero = readBool(INBOX_ZERO_KEY, false);
let splitOpen = readBool(SPLIT_OPEN_KEY, false);
let splitTab: NoteSplitTab = readSplitTab();
let sourceMode = readBool(SOURCE_MODE_KEY, false);

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    let changed = false;
    if (e.key === INBOX_ZERO_KEY) {
      inboxZero = readBool(INBOX_ZERO_KEY, false);
      changed = true;
    } else if (e.key === SPLIT_OPEN_KEY) {
      splitOpen = readBool(SPLIT_OPEN_KEY, false);
      changed = true;
    } else if (e.key === SPLIT_TAB_KEY) {
      splitTab = readSplitTab();
      changed = true;
    } else if (e.key === SOURCE_MODE_KEY) {
      sourceMode = readBool(SOURCE_MODE_KEY, false);
      changed = true;
    }
    if (changed) listeners.forEach((l) => l());
  });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getInboxZero(): boolean {
  return inboxZero;
}

export function setInboxZero(on: boolean): void {
  if (inboxZero === on) return;
  inboxZero = on;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(INBOX_ZERO_KEY, on ? '1' : '0');
  } catch {
    // ignore
  }
  listeners.forEach((l) => l());
}

export function useInboxZero(): boolean {
  return useSyncExternalStore(subscribe, () => inboxZero);
}

export function getNoteSplitOpen(): boolean {
  return splitOpen;
}

export function setNoteSplitOpen(on: boolean): void {
  if (splitOpen === on) return;
  splitOpen = on;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(SPLIT_OPEN_KEY, on ? '1' : '0');
  } catch {
    // ignore
  }
  listeners.forEach((l) => l());
}

export function useNoteSplitOpen(): boolean {
  return useSyncExternalStore(subscribe, () => splitOpen);
}

export function getNoteSplitTab(): NoteSplitTab {
  return splitTab;
}

export function setNoteSplitTab(tab: NoteSplitTab): void {
  if (splitTab === tab) return;
  splitTab = tab;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(SPLIT_TAB_KEY, tab);
  } catch {
    // ignore
  }
  listeners.forEach((l) => l());
}

export function useNoteSplitTab(): NoteSplitTab {
  return useSyncExternalStore(subscribe, () => splitTab);
}

/** Code view: notes are edited as plain Markdown without live preview (per device) */
export function setSourceMode(on: boolean): void {
  if (sourceMode === on) return;
  sourceMode = on;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(SOURCE_MODE_KEY, on ? '1' : '0');
  } catch {
    // ignore
  }
  listeners.forEach((l) => l());
}

export function useSourceMode(): boolean {
  return useSyncExternalStore(subscribe, () => sourceMode);
}
