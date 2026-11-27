import type { DatabaseSync } from 'node:sqlite';
import { mentionContext, newMentions, SYSTEM_PREFIX, type NotificationItem, type NotificationKind, type NotificationList, type PushPayload } from '@kladde/shared';
import { DataCipher, randomToken } from './crypto.js';
import type { NoteChangeEvent } from './NoteStore.js';
import type { UserStore } from './UserStore.js';

/*
 * Notifications (#69, #68): a mention in a note, a comment on one's note, a reply in a comment thread or being added
 * to a group. They are
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
  rowid: number;
  actor_name?: string | null;
  actor_avatar?: string | null;
}

/** A headline in the interface's languages (plugins) */
export type NotificationTitle = string | { de: string; en?: string };

interface NotificationPayload {
  path: string;
  line?: number;
  text: string;
  threadId?: string;
  groupId?: string;
  plugin?: string;
  title?: NotificationTitle;
  href?: string;
}

/** Kept this long, read or not */
const KEEP_DAYS = 90;

export interface NewNotification {
  userId: string;
  kind: NotificationKind;
  /** Empty for `group_added` (and plugin notifications that point to no note) */
  noteId: string;
  /** Who did it; null for plugin notifications */
  actorId: string | null;
  /** Path of the note, the group's name, or the plugin's name */
  path: string;
  line?: number;
  text: string;
  threadId?: string;
  groupId?: string;
  /** `plugin`: the plugin, its headline and the app path a click opens (`/p/<id>/…` or a note) */
  plugin?: string;
  title?: NotificationTitle;
  href?: string;
  /** Push messages with the same tag replace each other */
  tag?: string;
}

/** A page of the list holds at most this many */
export const NOTIFICATION_PAGE_MAX = 100;

/** App path a notification opens */
export function notificationUrl(n: { kind?: NotificationKind; noteId: string; line?: number; threadId?: string; groupId?: string; href?: string }): string {
  if (n.kind === 'plugin') return n.href ?? (n.noteId ? `/n/${n.noteId}` : '/');
  if (n.kind === 'cockpit') return `/cockpit/${encodeURIComponent(n.noteId)}`;
  if (n.groupId) return `/groups/${encodeURIComponent(n.groupId)}`;
  return `/n/${n.noteId}${n.threadId ? `?thread=${encodeURIComponent(n.threadId)}` : n.line !== undefined ? `?line=${n.line + 1}` : ''}`;
}

/** What a device needs to show a notification (its title is written in the device's language) */
export interface Delivery {
  kind: NotificationKind;
  actor: string;
  /** Name of the note */
  name: string;
  /** App path a click opens */
  url: string;
  /** Cockpit and plugins: the body of the push */
  text?: string;
  /** Plugins: the headline */
  title?: NotificationTitle;
  /** Plugins: replaces the note in the push's tag */
  tag?: string;
}

/** Delivers a notification right away: a live event to open apps and Web Push to the devices */
export type Deliver = (userId: string, d: Delivery) => void;

/** The Web Push message for a device in its language */
export function notificationPush(d: Delivery, lang: 'de' | 'en', noteId: string): PushPayload {
  const en = lang === 'en';
  if (d.kind === 'plugin') {
    const title = typeof d.title === 'object' ? (en ? (d.title.en ?? d.title.de) : d.title.de) : (d.title ?? d.name);
    return { title, body: d.text ?? '', tag: `plugin-${d.tag ?? noteId}`, url: d.url, lang };
  }
  const title =
    d.kind === 'mention'
      ? en ? `${d.actor} mentioned you` : `${d.actor} hat dich erwähnt`
      : d.kind === 'reply'
        ? en ? `${d.actor} replied to a comment` : `${d.actor} hat auf einen Kommentar geantwortet`
        : d.kind === 'group_added'
          ? en ? `${d.actor} added you to a group` : `${d.actor} hat dich zu einer Gruppe hinzugefügt`
          : d.kind === 'cockpit'
            ? en ? `New in “${d.name}”` : `Neu in „${d.name}“`
            : en ? `${d.actor} commented` : `${d.actor} hat kommentiert`;
  return { title, body: d.kind === 'cockpit' ? (d.text ?? '') : d.name, tag: `${d.kind}-${noteId}`, url: d.url, lang };
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
    const payload: NotificationPayload = {
      path: n.path,
      text: n.text.slice(0, 500),
      ...(n.line !== undefined ? { line: n.line } : {}),
      ...(n.threadId ? { threadId: n.threadId } : {}),
      ...(n.groupId ? { groupId: n.groupId } : {}),
      ...(n.plugin ? { plugin: n.plugin } : {}),
      ...(n.title ? { title: n.title } : {}),
      ...(n.href ? { href: n.href } : {}),
    };
    this.db
      .prepare('INSERT INTO notifications (id, user_id, kind, note_id, actor_id, at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, n.userId, n.kind, n.noteId, n.actorId, now, this.cipher.encryptJson(payload, `notification:${id}`));
    this.db.prepare('DELETE FROM notifications WHERE user_id = ? AND at < ?').run(n.userId, now - KEEP_DAYS * 86_400_000);
    const actor = n.actorId ? (this.users.getUser(n.actorId)?.username ?? '') : '';
    const name = n.groupId || n.kind === 'cockpit' || n.kind === 'plugin' ? n.path : (n.path.split('/').pop()?.replace(/\.md$/i, '') ?? '');
    this.deliver(n.userId, {
      kind: n.kind,
      actor,
      name,
      url: notificationUrl(n),
      ...(n.kind === 'cockpit' || n.kind === 'plugin' ? { text: n.text.slice(0, 300) } : {}),
      ...(n.kind === 'plugin' ? { title: n.title, ...(n.tag ? { tag: n.tag } : {}) } : {}),
    });
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

  /**
   * Newest first, `limit` at a time; `before` is the `next` of the page before (the time and row of its last one), so
   * notifications arriving in between do not shift the pages
   */
  list(userId: string, limit = NOTIFICATION_PAGE_MAX, before?: string | null): NotificationList {
    const take = Math.max(1, Math.min(NOTIFICATION_PAGE_MAX, Math.floor(limit) || NOTIFICATION_PAGE_MAX));
    const cursor = /^(\d+)\.(\d+)$/.exec(before ?? '');
    const rows = this.db
      .prepare(
        `SELECT notifications.*, notifications.rowid AS rowid, users.username AS actor_name, users.avatar_id AS actor_avatar FROM notifications
         LEFT JOIN users ON users.id = notifications.actor_id WHERE user_id = ?
         ${cursor ? 'AND (at < ? OR (at = ? AND notifications.rowid < ?))' : ''}
         ORDER BY at DESC, notifications.rowid DESC LIMIT ?`
      )
      .all(userId, ...(cursor ? [Number(cursor[1]), Number(cursor[1]), Number(cursor[2])] : []), take + 1) as unknown as NotificationRow[];
    const more = rows.length > take;
    if (more) rows.length = take;
    const last = rows[rows.length - 1];
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
        ...(p.groupId ? { groupId: p.groupId } : {}),
        ...(p.plugin ? { plugin: p.plugin } : {}),
        ...(p.title ? { title: p.title } : {}),
        ...(p.href ? { href: p.href } : {}),
      };
    });
    return { items, unread: this.unread(userId), next: more && last ? `${last.at}.${last.rowid}` : null };
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
