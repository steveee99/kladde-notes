import { useSyncExternalStore } from 'react';

export const WIDESCREEN_PRESETS = [50, 80, 100] as const;
export const DEFAULT_PERCENT = 80;
export const MIN_PERCENT = 35;
export const MAX_PERCENT = 100;

export interface WidescreenConfig {
  percent: number;
  custom: boolean;
}

export const DEFAULT_WIDESCREEN: WidescreenConfig = {
  percent: DEFAULT_PERCENT,
  custom: false,
};

const KEY = 'kladde_widescreen';
const listeners = new Set<() => void>();

export function clampPercent(percent: unknown): number {
  if (typeof percent !== 'number' || Number.isNaN(percent)) return DEFAULT_PERCENT;
  return Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, Math.round(percent)));
}

export function getWidescreen(): WidescreenConfig {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_WIDESCREEN;
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_WIDESCREEN;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed?.percent === 'number') {
      const percent = clampPercent(parsed.percent);
      const custom = typeof parsed.custom === 'boolean' ? parsed.custom : !(WIDESCREEN_PRESETS as readonly number[]).includes(percent);
      return { percent, custom };
    }
    // Migrate legacy pixel/fluid config cleanly
    if (parsed?.mode === 'fluid') return { percent: 100, custom: false };
    return DEFAULT_WIDESCREEN;
  } catch {
    return DEFAULT_WIDESCREEN;
  }
}

let current: WidescreenConfig = getWidescreen();

export function applyWidescreen(config: WidescreenConfig = current): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (!root) return;
  root.dataset.widescreen = String(config.percent);
  root.style.setProperty('--content-width', `${config.percent}%`);
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
  const sanitized: WidescreenConfig = {
    percent: clampPercent(next.percent),
    custom: Boolean(next.custom),
  };
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
