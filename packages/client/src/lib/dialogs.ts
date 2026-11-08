import { useSyncExternalStore } from 'react';

/** App-wide dialogs (new note from template, new Zettel, recipe import), opened from anywhere */
export type DialogState = { kind: 'note'; folder?: string } | { kind: 'zettel' } | { kind: 'recipe'; url?: string } | null;

let state: DialogState = null;
const listeners = new Set<() => void>();

export function openDialog(next: DialogState) {
  state = next;
  listeners.forEach((l) => l());
}

export const closeDialog = () => openDialog(null);

export function useDialog(): DialogState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state
  );
}
