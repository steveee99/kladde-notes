import { DatabaseSync } from 'node:sqlite';
import crypto from 'crypto';
import { IMPORT_TOKEN_DAYS, type ImportToken, type ImportTokenCreated } from '@kladde/shared';
import { randomToken, sha256 } from '../crypto.js';
import { AccountError } from '../UserStore.js';

const MAX_TOKENS_PER_USER = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Different from MCP's `kld_`, so neither kind of token is mistaken for the other */
const TOKEN_PREFIX = 'kli_';

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

/**
 * Tokens for the import CLI, created by the user in the settings (expire after the chosen days, revocable).
 * They only work on `/api/import`. Only SHA-256 hashes of the secrets are stored.
 */
export class ImportTokenStore {
  constructor(private readonly db: DatabaseSync) {}

  create(userId: string, name: unknown, days: unknown = IMPORT_TOKEN_DAYS[0], now = Date.now()): ImportTokenCreated {
    if (!IMPORT_TOKEN_DAYS.includes(days as (typeof IMPORT_TOKEN_DAYS)[number])) {
      throw new AccountError(`Ungültige Gültigkeit – erlaubt sind ${[...IMPORT_TOKEN_DAYS].sort((a, b) => a - b).join(', ')} Tage.`);
    }
    // Expired tokens no longer count against the limit
    this.db.prepare('DELETE FROM import_tokens WHERE user_id = ? AND expires_at <= ?').run(userId, now);
    const n = Number((this.db.prepare('SELECT COUNT(*) AS n FROM import_tokens WHERE user_id = ?').get(userId) as { n: number }).n);
    if (n >= MAX_TOKENS_PER_USER) throw new AccountError(`Höchstens ${MAX_TOKENS_PER_USER} Import-Tokens – widerrufe zuerst ein altes.`, 409);
    const cleanName = (typeof name === 'string' ? name.trim() : '').slice(0, 60) || 'Import-Token';
    const id = crypto.randomUUID();
    const secret = `${TOKEN_PREFIX}${randomToken(32)}`;
    const expiresAt = now + (days as number) * DAY_MS;
    this.db
      .prepare('INSERT INTO import_tokens (id, user_id, name, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, userId, cleanName, sha256(secret), now, expiresAt);
    return { token: { id, name: cleanName, createdAt: now, expiresAt, lastUsedAt: null }, secret };
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

  /** The owner of a bearer token, null if unknown or expired (bans are checked by the caller) */
  userIdFor(token: string | undefined, now = Date.now()): string | null {
    if (!token || !token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
    const row = this.db.prepare('SELECT * FROM import_tokens WHERE token_hash = ?').get(sha256(token)) as TokenRow | undefined;
    if (!row || row.expires_at <= now) return null;
    // Only write once a minute: every import request reads the token
    if ((row.last_used_at ?? 0) < now - 60_000) this.db.prepare('UPDATE import_tokens SET last_used_at = ? WHERE id = ?').run(now, row.id);
    return row.user_id;
  }
}
