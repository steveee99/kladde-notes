import { useSyncExternalStore } from 'react';
import type { SharedFolder } from '@kladde/shared';
import type { NewNoteKind } from './newNote';

/**
 * App-wide dialogs (new note of any kind, new Zettel, recipe import), opened from anywhere. A new note
 * can start as a given `type` and live in a folder another user shares (`shared`).
 */
export type DialogState =
  | { kind: 'note'; folder?: string; type?: NewNoteKind; shared?: SharedFolder }
  | { kind: 'zettel' }
  | { kind: 'recipe'; url?: string }
  | null;

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
