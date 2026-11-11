import type { PresenceUpdate, PresenceViewer } from '@kladde/shared';

/** A client that has not sent a heartbeat for this long is gone (it sends one every 25 s) */
export const PRESENCE_TTL_MS = 70_000;
const CLIENT_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

interface Session {
  userId: string;
  noteId: string;
  at: number;
}

interface PresenceDeps {
  audienceOf(noteId: string): string[] | null;
}

interface UserInfo {
  username: string;
  avatarUrl: string | null;
}

interface Sender {
  send(userIds: Iterable<string>, event: string, data: unknown): void;
}

/**
 * Who has which note open right now (in memory only: nothing about it is stored). Each device/tab is one
 * client; changes are sent as the live event `presence` to everybody who may see the note.
 */
export class Presence {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly notes: PresenceDeps,
    private readonly userOf: (id: string) => UserInfo | null,
    private readonly live: Sender,
    private readonly now: () => number = Date.now
  ) {
    const sweep = setInterval(() => this.sweep(), 20_000);
    sweep.unref?.();
  }

  static validClient(clientId: string): boolean {
    return CLIENT_PATTERN.test(clientId);
  }

  /** The client now has `noteId` open (or none); returns who is on that note */
  announce(userId: string, clientId: string, noteId: string | null): PresenceUpdate | null {
    const key = `${userId}:${clientId}`;
    const before = this.sessions.get(key);
    const audience = noteId ? this.notes.audienceOf(noteId) : null;
    // Only notes the user may see; anything else counts as "no note open"
    const target = noteId && audience?.includes(userId) ? noteId : null;
    if (target) this.sessions.set(key, { userId, noteId: target, at: this.now() });
    else this.sessions.delete(key);
    if (before && before.noteId !== target) this.broadcast(before.noteId);
    if (target && before?.noteId !== target) this.broadcast(target, audience!);
    return target ? { noteId: target, viewers: this.viewers(target) } : null;
  }

  /** The client's live stream closed */
  leave(userId: string, clientId: string): void {
    const key = `${userId}:${clientId}`;
    const before = this.sessions.get(key);
    if (!before) return;
    this.sessions.delete(key);
    this.broadcast(before.noteId);
  }

  viewers(noteId: string): PresenceViewer[] {
    const byUser = new Map<string, number>();
    for (const s of this.sessions.values()) if (s.noteId === noteId) byUser.set(s.userId, (byUser.get(s.userId) ?? 0) + 1);
    const out: PresenceViewer[] = [];
    for (const [userId, clients] of byUser) {
      const user = this.userOf(userId);
      if (user) out.push({ userId, username: user.username, avatarUrl: user.avatarUrl, clients });
    }
    return out.sort((a, b) => a.username.localeCompare(b.username));
  }

  /** Drops clients without heartbeat */
  sweep(): void {
    const limit = this.now() - PRESENCE_TTL_MS;
    const touched = new Set<string>();
    for (const [key, s] of this.sessions) {
      if (s.at < limit) {
        this.sessions.delete(key);
        touched.add(s.noteId);
      }
    }
    for (const noteId of touched) this.broadcast(noteId);
  }

  private broadcast(noteId: string, audience = this.notes.audienceOf(noteId)): void {
    if (!audience?.length) return;
    const update: PresenceUpdate = { noteId, viewers: this.viewers(noteId) };
    this.live.send(audience, 'presence', update);
  }
}
