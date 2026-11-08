import { DatabaseSync } from 'node:sqlite';

/** What gets recorded: everything that changes who can get into an account, and every admin action */
export type AuditEvent =
  | 'login'
  | 'login_failed'
  | 'login_blocked'
  | 'register'
  | 'logout'
  | 'password_changed'
  | 'account_deleted'
  | 'admin_command'
  | 'mcp_token_created'
  | 'mcp_connected'
  | 'mcp_revoked';

export interface AuditEntry {
  at: number;
  event: AuditEvent;
  userId: string | null;
  username: string | null;
  ip: string | null;
  detail: string | null;
}

/** Entries older than this are deleted */
export const AUDIT_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * Append-only log in the shared SQLite file, so misuse (password guessing,
 * a taken-over account, admin actions) can be traced afterwards.
 */
export class AuditLog {
  constructor(private readonly db: DatabaseSync) {}

  record(event: AuditEvent, entry: Partial<Omit<AuditEntry, 'at' | 'event'>> = {}, now = Date.now()): void {
    try {
      this.db
        .prepare('INSERT INTO audit_log (at, event, user_id, username, ip, detail) VALUES (?, ?, ?, ?, ?, ?)')
        .run(now, event, entry.userId ?? null, entry.username?.slice(0, 64) ?? null, entry.ip ?? null, entry.detail?.slice(0, 200) ?? null);
    } catch (err) {
      // The log must never break a login
      console.error('Audit log write failed:', err);
    }
  }

  /** Newest first; with `event` only that kind */
  recent(limit = 20, event?: AuditEvent): AuditEntry[] {
    const rows = (
      event
        ? this.db.prepare('SELECT * FROM audit_log WHERE event = ? ORDER BY id DESC LIMIT ?').all(event, limit)
        : this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit)
    ) as unknown as { at: number; event: AuditEvent; user_id: string | null; username: string | null; ip: string | null; detail: string | null }[];
    return rows.map((row) => ({
      at: row.at,
      event: row.event,
      userId: row.user_id,
      username: row.username,
      ip: row.ip,
      detail: row.detail,
    }));
  }

  prune(now = Date.now()): number {
    return Number(this.db.prepare('DELETE FROM audit_log WHERE at < ?').run(now - AUDIT_MAX_AGE_MS).changes);
  }
}
