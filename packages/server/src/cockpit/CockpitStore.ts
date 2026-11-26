import type { DatabaseSync } from 'node:sqlite';
import type { CockpitProvider, CockpitWidget } from '@kladde/shared';
import type { DataCipher } from '../crypto.js';

/** A personal GitLab token for one of the configured instances (server side only) */
export interface GitlabConnection {
  instanceId: string;
  token: string;
  /** Of the account the token belongs to, read when it was saved */
  username: string;
  userId: number;
  name: string;
}

/** A personal Jira connection: Cloud with e-mail and API token, Data Center with a personal access token */
export interface JiraConnection {
  url: string;
  kind: 'cloud' | 'datacenter';
  email: string;
  token: string;
  accountName: string;
  /** `accountId` (Cloud) or `name` (Data Center) of the connected account */
  accountId: string;
}

export interface ConnectionOf {
  gitlab: GitlabConnection;
  jira: JiraConnection;
}

/** What the notification job keeps per dashboard: its notifying widgets and the rows already seen */
export interface WatchPayload {
  vars: Record<string, string>;
  widgets: CockpitWidget[];
  /** Row ids per widget id at the last read; a widget missing here has not been read yet (no notification then) */
  seen: Record<string, string[]>;
}

const MAX_SEEN = 500;

/**
 * Storage of the development cockpit: connections (one per user and provider) and the dashboards whose widgets notify.
 * Tokens, widgets and seen rows are encrypted with the user (and provider) or the note id in the AAD.
 */
export class CockpitStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly cipher: DataCipher
  ) {}

  // ---------------------------------------------------------------- connections

  connection<P extends CockpitProvider>(userId: string, provider: P): (ConnectionOf[P] & { updatedAt: number }) | null {
    const row = this.db.prepare('SELECT data, updated_at FROM cockpit_connections WHERE user_id = ? AND provider = ?').get(userId, provider) as { data: Uint8Array; updated_at: number } | undefined;
    if (!row) return null;
    try {
      return { ...this.cipher.decryptJson<ConnectionOf[P]>(row.data, `cockpit-connection:${userId}:${provider}`), updatedAt: row.updated_at };
    } catch {
      // Another DATA_KEY: the connection has to be entered again
      return null;
    }
  }

  saveConnection<P extends CockpitProvider>(userId: string, provider: P, data: ConnectionOf[P], now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO cockpit_connections (user_id, provider, updated_at, data) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, provider) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data`
      )
      .run(userId, provider, now, this.cipher.encryptJson(data, `cockpit-connection:${userId}:${provider}`));
  }

  removeConnection(userId: string, provider: CockpitProvider): boolean {
    return Number(this.db.prepare('DELETE FROM cockpit_connections WHERE user_id = ? AND provider = ?').run(userId, provider).changes) > 0;
  }

  // ---------------------------------------------------------------- watches

  watch(noteId: string): { userId: string; nextAt: number; payload: WatchPayload } | null {
    const row = this.db.prepare('SELECT user_id, next_at, payload FROM cockpit_watches WHERE note_id = ?').get(noteId) as { user_id: string; next_at: number; payload: Uint8Array } | undefined;
    if (!row) return null;
    try {
      return { userId: row.user_id, nextAt: row.next_at, payload: this.cipher.decryptJson<WatchPayload>(row.payload, `cockpit-watch:${noteId}`) };
    } catch {
      return null;
    }
  }

  /** Registers (or changes) the notifying widgets of a dashboard; rows seen by widgets that stay are kept */
  setWatch(noteId: string, userId: string, vars: Record<string, string>, widgets: CockpitWidget[], now = Date.now()): void {
    const before = this.watch(noteId);
    const keep = new Set(widgets.map((w) => w.id));
    const seen = Object.fromEntries(Object.entries(before?.payload.seen ?? {}).filter(([id]) => keep.has(id)));
    const payload: WatchPayload = { vars, widgets, seen };
    this.db
      .prepare(
        `INSERT INTO cockpit_watches (note_id, user_id, next_at, payload) VALUES (?, ?, ?, ?)
         ON CONFLICT(note_id) DO UPDATE SET user_id = excluded.user_id, payload = excluded.payload`
      )
      .run(noteId, userId, before?.nextAt ?? now, this.cipher.encryptJson(payload, `cockpit-watch:${noteId}`));
  }

  dropWatch(noteId: string): void {
    this.db.prepare('DELETE FROM cockpit_watches WHERE note_id = ?').run(noteId);
  }

  /** After a read: the rows now seen per widget and when the next read is due */
  saveSeen(noteId: string, seen: Record<string, string[]>, nextAt: number): void {
    const w = this.watch(noteId);
    if (!w) return;
    const capped = Object.fromEntries(Object.entries(seen).map(([id, ids]) => [id, ids.slice(0, MAX_SEEN)]));
    this.db
      .prepare('UPDATE cockpit_watches SET next_at = ?, payload = ? WHERE note_id = ?')
      .run(nextAt, this.cipher.encryptJson({ ...w.payload, seen: capped }, `cockpit-watch:${noteId}`), noteId);
  }

  /** Dashboards due for a read, oldest first */
  due(now: number, limit: number): string[] {
    return (this.db.prepare('SELECT note_id FROM cockpit_watches WHERE next_at <= ? ORDER BY next_at LIMIT ?').all(now, limit) as { note_id: string }[]).map((r) => r.note_id);
  }

  /** Pushes a dashboard's next read back (an error, a switched-off feature) */
  postpone(noteId: string, nextAt: number): void {
    this.db.prepare('UPDATE cockpit_watches SET next_at = ? WHERE note_id = ?').run(nextAt, noteId);
  }
}
