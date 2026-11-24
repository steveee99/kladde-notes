import { useSyncExternalStore } from 'react';
import type { SharedFolder } from '@kladde/shared';
import type { NewNoteKind } from './newNote';
import type { UploadedFile } from '../editor/host';

/**
 * App-wide dialogs (new note of any kind, new Zettel, recipe import), opened from anywhere. A new note
 * can start as a given `type` and live in a folder another user shares (`shared`).
 */
export type DialogState =
  | { kind: 'note'; folder?: string; type?: NewNoteKind; shared?: SharedFolder; group?: string }
  | { kind: 'zettel' }
  | { kind: 'recipe'; url?: string }
  | { kind: 'clip'; url?: string; title?: string; selection?: string }
  | { kind: 'variables'; space: string; folder: string }
  | { kind: 'attachment'; onPick: (file: UploadedFile) => void }
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
