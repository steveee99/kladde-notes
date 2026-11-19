import type { DatabaseSync } from 'node:sqlite';
import { mentionContext, newMentions, SYSTEM_PREFIX, type NotificationItem, type NotificationKind, type NotificationList, type PushPayload } from '@kladde/shared';
import { DataCipher, randomToken } from './crypto.js';
import type { NoteChangeEvent } from './NoteStore.js';
import type { UserStore } from './UserStore.js';

/*
 * Notifications (#69, #68): a mention in a note, a comment on one's note or a reply in a comment thread. They are
 * kept per user (the passage and text encrypted, `notification:<id>` as AAD), shown in the app and, with Web Push
 * turned on, sent to the user's devices. Nobody hears about a note they cannot open.
 */

interface NotificationRow {
  id: string;
  user_id: string;
  kind: NotificationKind;
  note_id: string;
  actor_id: string | null;
  at: number;
  read_at: number | null;
  payload: Uint8Array;
  actor_name?: string | null;
  actor_avatar?: string | null;
}

interface NotificationPayload {
  path: string;
  line?: number;
  text: string;
  threadId?: string;
}

/** Kept this long, read or not */
const KEEP_DAYS = 90;

export interface NewNotification {
  userId: string;
  kind: NotificationKind;
  noteId: string;
  actorId: string;
  path: string;
  line?: number;
  text: string;
  threadId?: string;
}

/** What a device needs to show a notification (its title is written in the device's language) */
export interface Delivery {
  kind: NotificationKind;
  actor: string;
  /** Name of the note */
  name: string;
  /** App path a click opens */
  url: string;
}

/** Delivers a notification right away: a live event to open apps and Web Push to the devices */
export type Deliver = (userId: string, d: Delivery) => void;

/** The Web Push message for a device in its language */
export function notificationPush(d: Delivery, lang: 'de' | 'en', noteId: string): PushPayload {
  const en = lang === 'en';
  const title =
    d.kind === 'mention'
      ? en ? `${d.actor} mentioned you` : `${d.actor} hat dich erwähnt`
      : d.kind === 'reply'
        ? en ? `${d.actor} replied to a comment` : `${d.actor} hat auf einen Kommentar geantwortet`
        : en ? `${d.actor} commented` : `${d.actor} hat kommentiert`;
  return { title, body: d.name, tag: `${d.kind}-${noteId}`, url: d.url, lang };
}

export class NotificationStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly cipher: DataCipher,
    private readonly users: UserStore,
    private readonly deliver: Deliver = () => {}
  ) {}

  add(n: NewNotification, now = Date.now()): void {
    const id = randomToken(12);
    const payload: NotificationPayload = { path: n.path, text: n.text.slice(0, 500), ...(n.line !== undefined ? { line: n.line } : {}), ...(n.threadId ? { threadId: n.threadId } : {}) };
    this.db
      .prepare('INSERT INTO notifications (id, user_id, kind, note_id, actor_id, at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, n.userId, n.kind, n.noteId, n.actorId, now, this.cipher.encryptJson(payload, `notification:${id}`));
    this.db.prepare('DELETE FROM notifications WHERE user_id = ? AND at < ?').run(n.userId, now - KEEP_DAYS * 86_400_000);
    const actor = this.users.getUser(n.actorId)?.username ?? '';
    const name = n.path.split('/').pop()?.replace(/\.md$/i, '') ?? '';
    const url = `/n/${n.noteId}${n.threadId ? `?thread=${encodeURIComponent(n.threadId)}` : n.line !== undefined ? `?line=${n.line + 1}` : ''}`;
    this.deliver(n.userId, { kind: n.kind, actor, name, url });
  }

  /**
   * New @mentions in a changed note: everybody newly mentioned who can see the note (and is not the author) gets a
   * notification with the line that mentions them
   */
  mentions(e: NoteChangeEvent, now = Date.now()): void {
    if (!e.actorId || e.deleted || e.previousContent === undefined || e.path.startsWith(SYSTEM_PREFIX)) return;
    const names = newMentions(e.previousContent, e.content);
    if (!names.length) return;
    const audience = new Set(e.audience);
    for (const name of names.slice(0, 50)) {
      const user = this.users.findByUsername(name);
      if (!user || user.id === e.actorId || user.bannedAt || !audience.has(user.id)) continue;
      const ctx = mentionContext(e.content, name);
      this.add({ userId: user.id, kind: 'mention', noteId: e.noteId, actorId: e.actorId, path: e.path, line: ctx?.line, text: ctx?.text ?? '' }, now);
    }
  }

  list(userId: string, limit = 100): NotificationList {
    const rows = this.db
      .prepare(
        `SELECT notifications.*, users.username AS actor_name, users.avatar_id AS actor_avatar FROM notifications
         LEFT JOIN users ON users.id = notifications.actor_id WHERE user_id = ? ORDER BY at DESC, notifications.rowid DESC LIMIT ?`
      )
      .all(userId, limit) as unknown as NotificationRow[];
    const items = rows.map((r): NotificationItem => {
      const p = this.cipher.decryptJson<NotificationPayload>(r.payload, `notification:${r.id}`);
      return {
        id: r.id,
        kind: r.kind,
        at: r.at,
        read: r.read_at !== null,
        actor: r.actor_name ?? null,
        ...(r.actor_avatar ? { actorAvatar: `/api/avatars/${r.actor_avatar}` } : {}),
        noteId: r.note_id,
        path: p.path,
        text: p.text,
        ...(p.line !== undefined ? { line: p.line } : {}),
        ...(p.threadId ? { threadId: p.threadId } : {}),
      };
    });
    return { items, unread: this.unread(userId) };
  }

  unread(userId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId) as { n: number }).n;
  }

  /** Marks the given notifications (all when `ids` is null, or those of one note) as read */
  markRead(userId: string, opts: { ids?: string[] | null; noteId?: string } = {}, now = Date.now()): void {
    if (opts.noteId) {
      this.db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND note_id = ? AND read_at IS NULL').run(now, userId, opts.noteId);
      return;
    }
    if (!opts.ids) {
      this.db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now, userId);
      return;
    }
    const stmt = this.db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL');
    for (const id of opts.ids.slice(0, 500)) if (typeof id === 'string') stmt.run(now, userId, id);
  }
}
