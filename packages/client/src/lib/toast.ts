import { useSyncExternalStore } from 'react';

/**
 * The app's snackbar (rendered by `Shell`): a short message, optionally with one action such as "Undo" (#131).
 * Messages with an action stay longer, so there is time to reach the button.
 */
export type ToastTone = 'ok' | 'warn' | 'danger';
export interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
  action?: { label: string; run: () => void | Promise<void> };
}

let current: Toast | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function showToast(text: string, tone: ToastTone = 'ok', action?: Toast['action']): void {
  current = { id: nextId++, text, tone, action };
  if (timer) clearTimeout(timer);
  timer = setTimeout(hideToast, action ? 7000 : 2600);
  emit();
}

export function hideToast(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!current) return;
  current = null;
  emit();
}

/** Keeps the toast up while the pointer or the focus is on it (its action stays reachable) */
export function holdToast(hold: boolean): void {
  if (!current) return;
  if (timer) clearTimeout(timer);
  timer = hold ? null : setTimeout(hideToast, 3000);
}

export function useToast(): Toast | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current
  );
}
