import { useEffect, useSyncExternalStore } from 'react';
import type { ConfluenceOverview } from '@kladde/shared';
import { api } from './api';

/**
 * Confluence sync (#48): the overview (connection, syncs, state per note) is loaded once and refreshed
 * after every action, so the note view can show its badge without a request per note.
 */
let overview: ConfluenceOverview | null = null;
let loading: Promise<ConfluenceOverview | null> | null = null;
let unavailable = false;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());

export function setConfluenceOverview(next: ConfluenceOverview): void {
  overview = next;
  emit();
}

export function refreshConfluence(): Promise<ConfluenceOverview | null> {
  if (unavailable) return Promise.resolve(null);
  loading ??= api<ConfluenceOverview>('/confluence')
    .then(
      (res) => {
        setConfluenceOverview(res);
        return res;
      },
      (err: { status?: number }) => {
        // Demo or an older server: no Confluence
        if (err.status === 404 || err.status === 400) {
          unavailable = true;
          emit();
        }
        return null;
      }
    )
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** The current overview; null until loaded (or when the server has no Confluence) */
export function useConfluence(): ConfluenceOverview | null {
  const value = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => overview
  );
  useEffect(() => {
    if (!overview) void refreshConfluence();
  }, []);
  return value;
}

export function confluenceAvailable(): boolean {
  return !unavailable;
}

/**
 * Confluence is a feature that is on once the user has saved a connection (address and API token):
 * only then do the note menu, the folder tree and the dialogs offer it.
 */
export function useConfluenceConnected(): boolean {
  return !!useConfluence()?.connection;
}
