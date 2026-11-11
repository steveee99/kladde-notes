import { useSyncExternalStore } from 'react';
import type { PresenceAnnounce, PresenceUpdate, PresenceViewer } from '@kladde/shared';
import { api } from './api';

/** One id per tab/window: two tabs on one device count as two clients, like two devices */
export const clientId = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

const HEARTBEAT_MS = 25_000;
const EMPTY: PresenceViewer[] = [];

/**
 * Who else has a note open right now (other people and the user's other devices). The open note is announced
 * to the server, which sends `presence` live events to everybody who may see that note.
 */
class PresenceStore {
  private byNote = new Map<string, PresenceViewer[]>();
  private listeners = new Set<() => void>();
  private current: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  viewers(noteId: string | null): PresenceViewer[] {
    return (noteId && this.byNote.get(noteId)) || EMPTY;
  }

  /** More than this one device/tab has the note open: edits are exchanged right away */
  isLive(noteId: string): boolean {
    return this.viewers(noteId).reduce((n, v) => n + v.clients, 0) > 1;
  }

  /** The note open in this tab (null when none) */
  setNote(noteId: string | null) {
    if (this.current === noteId) return;
    this.current = noteId;
    if (this.timer) clearInterval(this.timer);
    this.timer = noteId ? setInterval(() => void this.announce(), HEARTBEAT_MS) : null;
    void this.announce();
  }

  /** Live stream (re)connected: the server may have forgotten this client */
  reconnected = () => void this.announce();

  receive(update: PresenceUpdate) {
    this.byNote.set(update.noteId, update.viewers);
    this.emit();
  }

  /** Signed out or closed */
  reset() {
    this.setNote(null);
    this.byNote.clear();
    this.emit();
  }

  private async announce() {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    const noteId = this.current;
    try {
      const update = await api<PresenceUpdate | null>('/presence', { method: 'POST', json: { clientId, noteId } satisfies PresenceAnnounce });
      if (update) this.receive(update);
    } catch {
      // Offline or the note is not (yet) on the server: nobody else can be there
    }
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }
}

export const presence = new PresenceStore();

/** Everybody on the note (this user included, with all open devices/tabs) */
export function usePresence(noteId: string | null): PresenceViewer[] {
  return useSyncExternalStore(presence.subscribe, () => presence.viewers(noteId));
}
