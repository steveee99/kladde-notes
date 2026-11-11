import { useSyncExternalStore } from 'react';
import type { CursorAnnounce, CursorPosition, CursorUpdate, PresenceAnnounce, PresenceCursor, PresenceUpdate, PresenceViewer } from '@kladde/shared';
import { api } from './api';

/** One id per tab/window: two tabs on one device count as two clients, like two devices */
export const clientId = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

const HEARTBEAT_MS = 25_000;
/** Cursor moves are sent at most this often */
const CURSOR_MS = 80;
const EMPTY: PresenceViewer[] = [];
const NO_CURSORS: PresenceCursor[] = [];

/**
 * Who else has a note open right now (other people and the user's other devices). The open note is announced
 * to the server, which sends `presence` live events to everybody who may see that note.
 */
class PresenceStore {
  private byNote = new Map<string, PresenceViewer[]>();
  /** Other devices/tabs' cursors per note (this tab's own one left out) */
  private cursorsByNote = new Map<string, PresenceCursor[]>();
  /** This tab's cursor in the open note: sent while others are there */
  private own: CursorPosition | null = null;
  private ownSent = true;
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;
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

  /** Where the other devices/tabs on the note have their cursors */
  cursors(noteId: string | null): PresenceCursor[] {
    return (noteId && this.cursorsByNote.get(noteId)) || NO_CURSORS;
  }

  /** This tab's cursor moved in the open note: passed on (throttled) while somebody else is there */
  moveCursor(noteId: string, pos: CursorPosition) {
    if (noteId !== this.current) return;
    this.own = pos;
    this.ownSent = false;
    if (this.isLive(noteId) && !this.cursorTimer) this.cursorTimer = setTimeout(() => this.sendCursor(), CURSOR_MS);
  }

  /** More than this one device/tab has the note open: edits are exchanged right away */
  isLive(noteId: string): boolean {
    return this.viewers(noteId).reduce((n, v) => n + v.clients, 0) > 1;
  }

  /** The note open in this tab (null when none) */
  setNote(noteId: string | null) {
    if (this.current === noteId) return;
    this.current = noteId;
    this.own = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = noteId ? setInterval(() => void this.announce(), HEARTBEAT_MS) : null;
    void this.announce();
  }

  /** Live stream (re)connected: the server may have forgotten this client */
  reconnected = () => void this.announce();

  receive(update: PresenceUpdate) {
    this.byNote.set(update.noteId, update.viewers);
    if (update.cursors) this.cursorsByNote.set(update.noteId, update.cursors.filter((c) => c.clientId !== clientId));
    // Somebody joined: they learn where this tab's cursor is
    if (update.noteId === this.current && this.own && this.isLive(update.noteId) && !update.cursors?.some((c) => c.clientId === clientId)) this.ownSent = false;
    if (!this.ownSent && update.noteId === this.current && this.isLive(update.noteId) && !this.cursorTimer) this.cursorTimer = setTimeout(() => this.sendCursor(), CURSOR_MS);
    this.emit();
  }

  receiveCursor({ noteId, cursor }: CursorUpdate) {
    if (cursor.clientId === clientId) return;
    const list = this.cursors(noteId).filter((c) => c.clientId !== cursor.clientId);
    this.cursorsByNote.set(noteId, [...list, cursor]);
    this.emit();
  }

  /** Signed out or closed */
  reset() {
    this.setNote(null);
    this.byNote.clear();
    this.cursorsByNote.clear();
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

  private async sendCursor() {
    this.cursorTimer = null;
    const noteId = this.current;
    const pos = this.own;
    if (!noteId || !pos || this.ownSent) return;
    this.ownSent = true;
    try {
      await api('/presence/cursor', { method: 'POST', json: { clientId, noteId, ...pos } satisfies CursorAnnounce });
    } catch {
      // Offline: the next move sends it again
    }
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }
}

export const presence = new PresenceStore();

/** The other devices/tabs' cursors in the note */
export function useCursors(noteId: string | null): PresenceCursor[] {
  return useSyncExternalStore(presence.subscribe, () => presence.cursors(noteId));
}

/** Everybody on the note (this user included, with all open devices/tabs) */
export function usePresence(noteId: string | null): PresenceViewer[] {
  return useSyncExternalStore(presence.subscribe, () => presence.viewers(noteId));
}
