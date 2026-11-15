import { DatabaseSync } from 'node:sqlite';
import crypto from 'crypto';
import type { ImportToken, ImportTokenCreated } from '@kladde/shared';
import { randomToken, sha256 } from '../crypto.js';
import { AccountError } from '../UserStore.js';

const DAY_MS = 24 * 60 * 60 * 1000;

interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
}

const toToken = (r: TokenRow): ImportToken => ({
  id: r.id,
  name: r.name,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  lastUsedAt: r.last_used_at ?? null,
});

export interface BearerTokenConfig {
  /** Table with the columns of `import_tokens` */
  table: 'import_tokens' | 'shortcut_tokens';
  /** Prefix of the secret, so one kind of token is never mistaken for another */
  prefix: string;
  /** Allowed lifetimes in days */
  days: readonly number[];
  /** Name when the user gives none */
  defaultName: string;
  /** Kind of token in error messages ("Import-Token") */
  label: string;
  maxPerUser?: number;
}

/**
 * Bearer tokens a user creates in the settings for one narrow API (import CLI, Apple Shortcuts): they
 * expire after the chosen days, can be revoked, at most a few per user, and only SHA-256 hashes of the
 * secrets are stored.
 */
export class BearerTokenStore {
  private readonly max: number;

  constructor(
    private readonly db: DatabaseSync,
    private readonly config: BearerTokenConfig
  ) {
    this.max = config.maxPerUser ?? 5;
  }

  create(userId: string, name: unknown, days: unknown = this.config.days[0], now = Date.now()): ImportTokenCreated {
    const { table, days: allowed, label } = this.config;
    if (!allowed.includes(days as number)) {
      throw new AccountError(`Ungültige Gültigkeit – erlaubt sind ${[...allowed].sort((a, b) => a - b).join(', ')} Tage.`);
    }
    // Expired tokens no longer count against the limit
    this.db.prepare(`DELETE FROM ${table} WHERE user_id = ? AND expires_at <= ?`).run(userId, now);
    const n = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(userId) as { n: number }).n);
    if (n >= this.max) throw new AccountError(`Höchstens ${this.max} ${label}s – widerrufe zuerst ein altes.`, 409);
    const cleanName = (typeof name === 'string' ? name.trim() : '').slice(0, 60) || this.config.defaultName;
    const id = crypto.randomUUID();
    const secret = `${this.config.prefix}${randomToken(32)}`;
    const expiresAt = now + (days as number) * DAY_MS;
    this.db
      .prepare(`INSERT INTO ${table} (id, user_id, name, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, userId, cleanName, sha256(secret), now, expiresAt);
    return { token: { id, name: cleanName, createdAt: now, expiresAt, lastUsedAt: null }, secret };
  }

  list(userId: string): ImportToken[] {
    return (this.db.prepare(`SELECT * FROM ${this.config.table} WHERE user_id = ? ORDER BY created_at DESC`).all(userId) as unknown as TokenRow[]).map(toToken);
  }

  /** The revoked token, null if it is unknown or someone else's */
  revoke(userId: string, id: string): ImportToken | null {
    const row = this.db.prepare(`SELECT * FROM ${this.config.table} WHERE id = ? AND user_id = ?`).get(id, userId) as TokenRow | undefined;
    if (!row) return null;
    this.db.prepare(`DELETE FROM ${this.config.table} WHERE id = ?`).run(id);
    return toToken(row);
  }

  /** The owner of a bearer token, null if unknown or expired (bans are checked by the caller) */
  userIdFor(token: string | undefined, now = Date.now()): string | null {
    if (!token || !token.startsWith(this.config.prefix) || token.length > 200) return null;
    const row = this.db.prepare(`SELECT * FROM ${this.config.table} WHERE token_hash = ?`).get(sha256(token)) as TokenRow | undefined;
    if (!row || row.expires_at <= now) return null;
    // Only write once a minute: every request reads the token
    if ((row.last_used_at ?? 0) < now - 60_000) this.db.prepare(`UPDATE ${this.config.table} SET last_used_at = ? WHERE id = ?`).run(now, row.id);
    return row.user_id;
  }
}
