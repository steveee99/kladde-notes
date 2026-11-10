import { useSyncExternalStore } from 'react';

export type MaterialSidebarMode = 'rail' | 'sticky';

const KEY = 'kladde_material_sidebar';
const listeners = new Set<() => void>();

export function getMaterialSidebarMode(): MaterialSidebarMode {
  try {
    if (typeof localStorage === 'undefined') return 'rail';
    // Migrate legacy 'overlay' directly to compact 'rail'
    return localStorage.getItem(KEY) === 'sticky' ? 'sticky' : 'rail';
  } catch {
    return 'rail';
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
  const next: MaterialSidebarMode = mode === 'sticky' ? 'sticky' : 'rail';
  if (current === next) return;
  current = next;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, next);
  } catch {
    // private mode / storage blocked
  }
  listeners.forEach((l) => l());
}

export function toggleMaterialSidebarMode(): void {
  setMaterialSidebarMode(current === 'sticky' ? 'rail' : 'sticky');
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useMaterialSidebarMode(): MaterialSidebarMode {
  return useSyncExternalStore(subscribe, () => current);
}
