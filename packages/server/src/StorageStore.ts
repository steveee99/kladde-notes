import { DatabaseSync } from 'node:sqlite';
import { STORAGE_WARN_RATIO, type AdminGroupStorage, type StorageUsage } from '@kladde/shared';
import { AccountError } from './UserStore.js';

const MB = 1024 * 1024;

/** `STORAGE_QUOTA_MB`: default quota per account and group in MB (unset, `0` or invalid = unlimited) */
export function defaultQuotaBytes(env: NodeJS.ProcessEnv): number | null {
  const mb = Number(env.STORAGE_QUOTA_MB?.trim());
  return Number.isFinite(mb) && mb > 0 ? Math.floor(mb * MB) : null;
}

/** An upload would exceed the quota: 413 so clients keep the file and show the message (#91) */
export class QuotaError extends AccountError {
  constructor(message = 'Der Speicherplatz ist aufgebraucht. Lösche Anhänge oder frage einen Admin nach mehr Platz.') {
    super(message, 413);
  }
}

/**
 * Storage per account and group (#91): bytes of notes, attachments, history (versions and releases) and trash,
 * an optional quota (own limit set by an admin, else the server default) enforced when attachments are uploaded.
 * Note and history sizes are the encrypted records as stored.
 */
export class StorageStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly defaultQuota: number | null = null
  ) {}

  private one(sql: string, ownerId: string): number {
    return Number((this.db.prepare(sql).get(ownerId) as { n: number | null }).n ?? 0);
  }

  /** Name of an account or group, null when there is none */
  ownerName(ownerId: string): string | null {
    return (this.db.prepare('SELECT username FROM users WHERE id = ?').get(ownerId) as { username: string } | undefined)?.username ?? null;
  }

  quotaOf(ownerId: string): { quota: number | null; custom: boolean } {
    const row = this.db.prepare('SELECT quota_bytes FROM storage_quotas WHERE owner_id = ?').get(ownerId) as { quota_bytes: number } | undefined;
    if (row) return { quota: row.quota_bytes > 0 ? row.quota_bytes : null, custom: true };
    return { quota: this.defaultQuota, custom: false };
  }

  usage(ownerId: string): StorageUsage {
    const notes = this.one('SELECT SUM(LENGTH(payload)) AS n FROM notes WHERE owner_id = ? AND deleted = 0', ownerId);
    const attachments = this.one('SELECT SUM(size) AS n FROM files WHERE owner_id = ?', ownerId);
    const history =
      this.one('SELECT SUM(LENGTH(v.payload)) AS n FROM note_versions v JOIN notes ON notes.id = v.note_id WHERE notes.owner_id = ?', ownerId) +
      this.one('SELECT SUM(LENGTH(r.payload)) AS n FROM note_releases r JOIN notes ON notes.id = r.note_id WHERE notes.owner_id = ?', ownerId);
    const trash = this.one('SELECT SUM(LENGTH(payload)) AS n FROM trash WHERE owner_id = ?', ownerId);
    const { quota, custom } = this.quotaOf(ownerId);
    return { notes, attachments, history, trash, total: notes + attachments + history + trash, quota, customQuota: custom };
  }

  /** 0 or null removes the own limit (back to the default); a positive number of bytes sets it */
  setQuota(ownerId: string, bytes: number | null | 'unlimited'): void {
    if (bytes === null) {
      this.db.prepare('DELETE FROM storage_quotas WHERE owner_id = ?').run(ownerId);
      return;
    }
    // Stored as 0 = explicitly unlimited, even when the server has a default
    const value = bytes === 'unlimited' ? 0 : Math.floor(bytes);
    if (!Number.isFinite(value) || value < 0) throw new AccountError('Ungültiges Limit.', 400);
    this.db
      .prepare('INSERT INTO storage_quotas (owner_id, quota_bytes) VALUES (?, ?) ON CONFLICT(owner_id) DO UPDATE SET quota_bytes = excluded.quota_bytes')
      .run(ownerId, value);
  }

  /** Throws a QuotaError when `extra` more bytes would exceed the owner's quota */
  assertRoom(ownerId: string, extra: number): void {
    const { quota } = this.quotaOf(ownerId);
    if (quota === null) return;
    const used = this.usage(ownerId).total;
    if (used + extra > quota) {
      const left = Math.max(0, quota - used);
      throw new QuotaError(`Der Speicherplatz reicht nicht (${Math.round(used / MB)} von ${Math.round(quota / MB)} MB belegt, ${(left / MB).toFixed(1)} MB frei).`);
    }
  }

  /** Share of the quota in use, or null without quota */
  ratio(usage: StorageUsage): number | null {
    return usage.quota ? usage.total / usage.quota : null;
  }

  isNearLimit(usage: StorageUsage): boolean {
    const r = this.ratio(usage);
    return r !== null && r >= STORAGE_WARN_RATIO;
  }

  groups(): AdminGroupStorage[] {
    const rows = this.db
      .prepare('SELECT users.id, users.username, (SELECT COUNT(*) FROM group_members WHERE group_id = users.id) AS members FROM users WHERE is_group = 1 ORDER BY username_lower')
      .all() as { id: string; username: string; members: number }[];
    return rows.map((r) => ({ id: r.id, name: r.username, members: Number(r.members), storage: this.usage(r.id) }));
  }
}
