import { useSyncExternalStore } from 'react';

/**
 * The folder side panel next to the navigation rail (desktop): 'sticky' = shown, 'rail' = collapsed (only the
 * rail remains). Kept per device; toggled with the panel's button, the rail's toggle and Ctrl/⌘+\.
 */
export type MaterialSidebarMode = 'rail' | 'sticky';

const KEY = 'kladde_material_sidebar';
const listeners = new Set<() => void>();

export function getMaterialSidebarMode(): MaterialSidebarMode {
  try {
    if (typeof localStorage === 'undefined') return 'sticky';
    // Shown unless the user collapsed it on this device
    return localStorage.getItem(KEY) === 'rail' ? 'rail' : 'sticky';
  } catch {
    return 'sticky';
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
