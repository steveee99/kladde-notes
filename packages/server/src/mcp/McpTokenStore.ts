import { DatabaseSync } from 'node:sqlite';
import crypto from 'crypto';
import type { McpConnection } from '@kladde/shared';
import { randomToken, sha256 } from '../crypto.js';
import { AccountError } from '../UserStore.js';

/** OAuth access tokens are short-lived; the client renews them with its refresh token */
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
/** A connection that was not used for this long stops working */
export const CONNECTION_MAX_IDLE_MS = 90 * 24 * 60 * 60 * 1000;
/** Registered clients that never got a token are removed after this */
const UNUSED_CLIENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_CONNECTIONS_PER_USER = 50;

const TOKEN_PREFIX = 'kld_';

export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  createdAt: number;
}

/** Who is behind a bearer token */
export interface McpGrant {
  connectionId: string;
  userId: string;
  canWrite: boolean;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  canWrite: boolean;
}

interface TokenRow {
  id: string;
  user_id: string;
  client_id: string | null;
  name: string;
  can_write: number;
  access_expires_at: number | null;
  created_at: number;
  last_used_at: number | null;
}

const toConnection = (r: TokenRow): McpConnection => ({
  id: r.id,
  name: r.name,
  kind: r.client_id ? 'oauth' : 'token',
  canWrite: !!r.can_write,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at ?? null,
});

/** A redirect target an authorization code may be sent to: https, http on loopback, or an app's own scheme */
export function isAllowedRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== 'string' || uri.length > 500) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !['javascript:', 'data:', 'file:', 'blob:', 'vbscript:', 'about:', 'ftp:', 'ws:', 'wss:'].includes(url.protocol);
}

const newToken = () => `${TOKEN_PREFIX}${randomToken(32)}`;

/**
 * Access for AI assistants over MCP. Two kinds share one table:
 * OAuth connections (client_id set, access token expires, refresh token rotates) and
 * personal tokens the user creates in the settings (no expiry, no refresh).
 * Only SHA-256 hashes of the secrets are stored.
 */
export class McpTokenStore {
  constructor(private readonly db: DatabaseSync) {}

  // ------------------------------------------------------------------ clients (dynamic registration)

  registerClient(name: unknown, redirectUris: unknown, now = Date.now()): OAuthClient {
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 10 || !redirectUris.every(isAllowedRedirectUri)) {
      throw new AccountError('invalid_redirect_uri');
    }
    const cleanName = (typeof name === 'string' ? name.trim() : '').slice(0, 80) || 'KI-Assistent';
    this.db
      .prepare('DELETE FROM oauth_clients WHERE created_at < ? AND id NOT IN (SELECT client_id FROM mcp_tokens WHERE client_id IS NOT NULL)')
      .run(now - UNUSED_CLIENT_MAX_AGE_MS);
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)').run(id, cleanName, JSON.stringify(redirectUris), now);
    return { id, name: cleanName, redirectUris: redirectUris as string[], createdAt: now };
  }

  getClient(id: unknown): OAuthClient | null {
    if (typeof id !== 'string') return null;
    const row = this.db.prepare('SELECT * FROM oauth_clients WHERE id = ?').get(id) as
      | { id: string; name: string; redirect_uris: string; created_at: number }
      | undefined;
    return row ? { id: row.id, name: row.name, redirectUris: JSON.parse(row.redirect_uris), createdAt: row.created_at } : null;
  }

  // ------------------------------------------------------------------ issuing

  private checkLimit(userId: string): void {
    const n = Number((this.db.prepare('SELECT COUNT(*) AS n FROM mcp_tokens WHERE user_id = ?').get(userId) as { n: number }).n);
    if (n >= MAX_CONNECTIONS_PER_USER) throw new AccountError('Zu viele Verbindungen – entferne zuerst alte in den Einstellungen.', 409);
  }

  /** A personal token for clients without OAuth (sent as "Authorization: Bearer …") */
  createPersonalToken(userId: string, name: unknown, canWrite: boolean, now = Date.now()): { connection: McpConnection; token: string } {
    this.checkLimit(userId);
    const cleanName = (typeof name === 'string' ? name.trim() : '').slice(0, 60) || 'Zugriffstoken';
    const id = crypto.randomUUID();
    const token = newToken();
    this.db
      .prepare('INSERT INTO mcp_tokens (id, user_id, client_id, name, can_write, access_hash, access_expires_at, refresh_hash, created_at) VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL, ?)')
      .run(id, userId, cleanName, canWrite ? 1 : 0, sha256(token), now);
    return { connection: this.connection(id)!, token };
  }

  /** After the user agreed on the consent page and the client redeemed its code */
  issueOAuth(userId: string, client: OAuthClient, canWrite: boolean, now = Date.now()): IssuedTokens {
    this.checkLimit(userId);
    const id = crypto.randomUUID();
    const accessToken = newToken();
    const refreshToken = newToken();
    this.db
      .prepare('INSERT INTO mcp_tokens (id, user_id, client_id, name, can_write, access_hash, access_expires_at, refresh_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, client.id, client.name, canWrite ? 1 : 0, sha256(accessToken), now + ACCESS_TOKEN_TTL_MS, sha256(refreshToken), now, now);
    return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_MS / 1000, canWrite };
  }

  /** Rotates both tokens; the old refresh token stops working. Null if unknown, of another client or idle too long */
  refresh(refreshToken: unknown, clientId: unknown, now = Date.now()): IssuedTokens | null {
    if (typeof refreshToken !== 'string' || typeof clientId !== 'string') return null;
    const row = this.db.prepare('SELECT * FROM mcp_tokens WHERE refresh_hash = ?').get(sha256(refreshToken)) as (TokenRow & { client_id: string }) | undefined;
    if (!row || row.client_id !== clientId) return null;
    if ((row.last_used_at ?? row.created_at) < now - CONNECTION_MAX_IDLE_MS) {
      this.db.prepare('DELETE FROM mcp_tokens WHERE id = ?').run(row.id);
      return null;
    }
    const accessToken = newToken();
    const nextRefresh = newToken();
    this.db
      .prepare('UPDATE mcp_tokens SET access_hash = ?, access_expires_at = ?, refresh_hash = ?, last_used_at = ? WHERE id = ?')
      .run(sha256(accessToken), now + ACCESS_TOKEN_TTL_MS, sha256(nextRefresh), now, row.id);
    return { accessToken, refreshToken: nextRefresh, expiresIn: ACCESS_TOKEN_TTL_MS / 1000, canWrite: !!row.can_write };
  }

  // ------------------------------------------------------------------ checking

  /** The grant behind a bearer token, null if unknown or expired (bans are checked by the caller) */
  grantFor(token: string | undefined, now = Date.now()): McpGrant | null {
    if (!token || !token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
    const row = this.db.prepare('SELECT * FROM mcp_tokens WHERE access_hash = ?').get(sha256(token)) as TokenRow | undefined;
    if (!row) return null;
    if (row.access_expires_at !== null && row.access_expires_at < now) return null;
    // Only write once a minute: every MCP call reads the token
    if ((row.last_used_at ?? 0) < now - 60_000) this.db.prepare('UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?').run(now, row.id);
    return { connectionId: row.id, userId: row.user_id, canWrite: !!row.can_write };
  }

  // ------------------------------------------------------------------ managing

  connection(id: string): McpConnection | null {
    const row = this.db.prepare('SELECT * FROM mcp_tokens WHERE id = ?').get(id) as TokenRow | undefined;
    return row ? toConnection(row) : null;
  }

  connectionsOf(userId: string): McpConnection[] {
    return (this.db.prepare('SELECT * FROM mcp_tokens WHERE user_id = ? ORDER BY created_at DESC').all(userId) as unknown as TokenRow[]).map(toConnection);
  }

  revoke(userId: string, id: string): boolean {
    return this.db.prepare('DELETE FROM mcp_tokens WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  }

  /** Revocation by the client itself (RFC 7009): either of its tokens ends the connection */
  revokeByToken(token: unknown, clientId: unknown): void {
    if (typeof token !== 'string' || typeof clientId !== 'string') return;
    const hash = sha256(token);
    this.db.prepare('DELETE FROM mcp_tokens WHERE client_id = ? AND (access_hash = ? OR refresh_hash = ?)').run(clientId, hash, hash);
  }
}
