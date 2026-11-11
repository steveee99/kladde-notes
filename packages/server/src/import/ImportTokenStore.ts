import { DatabaseSync } from 'node:sqlite';
import crypto from 'crypto';
import type { ImportToken, ImportTokenCreated } from '@kladde/shared';
import { randomToken, sha256 } from '../crypto.js';
import { AccountError } from '../UserStore.js';

const MAX_TOKENS_PER_USER = 20;

/** Different from MCP's `kld_`, so neither kind of token is mistaken for the other */
const TOKEN_PREFIX = 'kli_';

interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

const toToken = (r: TokenRow): ImportToken => ({
  id: r.id,
  name: r.name,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at ?? null,
});

/**
 * Tokens for the import CLI, created by the user in the settings (no expiry, revocable).
 * They only work on `/api/import`. Only SHA-256 hashes of the secrets are stored.
 */
export class ImportTokenStore {
  constructor(private readonly db: DatabaseSync) {}

  create(userId: string, name: unknown, now = Date.now()): ImportTokenCreated {
    const n = Number((this.db.prepare('SELECT COUNT(*) AS n FROM import_tokens WHERE user_id = ?').get(userId) as { n: number }).n);
    if (n >= MAX_TOKENS_PER_USER) throw new AccountError('Zu viele Import-Tokens – widerrufe zuerst alte in den Einstellungen.', 409);
    const cleanName = (typeof name === 'string' ? name.trim() : '').slice(0, 60) || 'Import-Token';
    const id = crypto.randomUUID();
    const secret = `${TOKEN_PREFIX}${randomToken(32)}`;
    this.db
      .prepare('INSERT INTO import_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, userId, cleanName, sha256(secret), now);
    return { token: { id, name: cleanName, createdAt: now, lastUsedAt: null }, secret };
  }

  list(userId: string): ImportToken[] {
    return (this.db.prepare('SELECT * FROM import_tokens WHERE user_id = ? ORDER BY created_at DESC').all(userId) as unknown as TokenRow[]).map(toToken);
  }

  /** The revoked token, null if it is unknown or someone else's */
  revoke(userId: string, id: string): ImportToken | null {
    const row = this.db.prepare('SELECT * FROM import_tokens WHERE id = ? AND user_id = ?').get(id, userId) as TokenRow | undefined;
    if (!row) return null;
    this.db.prepare('DELETE FROM import_tokens WHERE id = ?').run(id);
    return toToken(row);
  }

  /** The owner of a bearer token, null if unknown (bans are checked by the caller) */
  userIdFor(token: string | undefined, now = Date.now()): string | null {
    if (!token || !token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
    const row = this.db.prepare('SELECT * FROM import_tokens WHERE token_hash = ?').get(sha256(token)) as TokenRow | undefined;
    if (!row) return null;
    // Only write once a minute: every import request reads the token
    if ((row.last_used_at ?? 0) < now - 60_000) this.db.prepare('UPDATE import_tokens SET last_used_at = ? WHERE id = ?').run(now, row.id);
    return row.user_id;
  }
}
