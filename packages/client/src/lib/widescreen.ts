import { useSyncExternalStore } from 'react';

export type WidescreenMode = 'fluid' | 'fixed';

export interface WidescreenConfig {
  mode: WidescreenMode;
  width: number;
}

export const DEFAULT_FIXED_WIDTH = 1200;
export const MIN_WIDTH = 480;
export const MAX_WIDTH = 3840;

export const DEFAULT_WIDESCREEN: WidescreenConfig = {
  mode: 'fixed',
  width: DEFAULT_FIXED_WIDTH,
};

const KEY = 'kladde_widescreen';
const listeners = new Set<() => void>();

function clampWidth(width: unknown): number {
  if (typeof width !== 'number' || Number.isNaN(width)) return DEFAULT_FIXED_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));
}

export function getWidescreen(): WidescreenConfig {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_WIDESCREEN;
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_WIDESCREEN;
    const parsed = JSON.parse(raw);
    const mode: WidescreenMode = parsed.mode === 'fluid' ? 'fluid' : 'fixed';
    const width = clampWidth(parsed.width);
    return { mode, width };
  } catch {
    return DEFAULT_WIDESCREEN;
  }
}

let current: WidescreenConfig = getWidescreen();

export function applyWidescreen(config: WidescreenConfig = current): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (!root) return;
  root.dataset.widescreen = config.mode;
  root.style.setProperty('--content-width', config.mode === 'fluid' ? 'none' : `${config.width}px`);
}

// Initial application on script evaluation
applyWidescreen(current);

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      current = getWidescreen();
      applyWidescreen(current);
      listeners.forEach((l) => l());
    }
  });
}

export function setWidescreen(next: WidescreenConfig): void {
  const mode: WidescreenMode = next.mode === 'fluid' ? 'fluid' : 'fixed';
  const width = clampWidth(next.width);
  const sanitized: WidescreenConfig = { mode, width };
  current = sanitized;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(KEY, JSON.stringify(sanitized));
    }
  } catch {
    // Private mode / quota exceeded
  }
  applyWidescreen(sanitized);
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useWidescreen(): WidescreenConfig {
  return useSyncExternalStore(subscribe, () => current);
}
