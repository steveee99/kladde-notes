import { useSyncExternalStore } from 'react';

export type MaterialSidebarMode = 'overlay' | 'sticky';

const KEY = 'kladde_material_sidebar';
const listeners = new Set<() => void>();

export function getMaterialSidebarMode(): MaterialSidebarMode {
  try {
    if (typeof localStorage === 'undefined') return 'overlay';
    return localStorage.getItem(KEY) === 'sticky' ? 'sticky' : 'overlay';
  } catch {
    return 'overlay';
  }
}

let current: MaterialSidebarMode = getMaterialSidebarMode();

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      current = getMaterialSidebarMode();
      listeners.forEach((l) => l());
    }
  });
}

export function setMaterialSidebarMode(mode: MaterialSidebarMode): void {
  const next: MaterialSidebarMode = mode === 'sticky' ? 'sticky' : 'overlay';
  if (current === next) return;
  current = next;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, next);
  } catch {
    // private mode / storage blocked
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useMaterialSidebarMode(): MaterialSidebarMode {
  return useSyncExternalStore(subscribe, () => current);
}
