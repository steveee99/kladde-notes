import { DatabaseSync } from 'node:sqlite';
import crypto from 'crypto';
import { USERNAME_PATTERN } from '@kladde/shared';
import { randomToken, sha256 } from './crypto.js';

/** Sessions unused for this long stop working */
export const SESSION_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
/** Unused invite codes stop working after this */
export const INVITE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** A code for adding a new device works this long */
export const DEVICE_LINK_MAX_AGE_MS = 15 * 60 * 1000;

export class AccountError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
  }
}

export interface UserRecord {
  id: string;
  username: string;
  createdAt: number;
  bannedAt: number | null;
}

export interface StoredCredential {
  id: string;
  userId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface InviteInfo {
  code: string;
  note: string;
  createdAt: number;
  expiresAt: number;
  usedBy: string | null;
  usedAt: number | null;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Upper case without dashes or spaces, so "abcd-efgh" and "ABCDEFGH" are the same code */
export function normalizeCode(code: unknown): string {
  return typeof code === 'string' ? code.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
}

export const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

function randomCode(): string {
  let code = '';
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

type Row = Record<string, unknown>;
const toUser = (r: Row): UserRecord => ({
  id: r.id as string,
  username: r.username as string,
  createdAt: r.created_at as number,
  bannedAt: (r.banned_at as number | null) ?? null,
});
const toCredential = (r: Row): StoredCredential => ({
  id: r.id as string,
  userId: r.user_id as string,
  publicKey: new Uint8Array(r.public_key as Uint8Array),
  counter: r.counter as number,
  transports: JSON.parse(r.transports as string),
  name: r.name as string,
  createdAt: r.created_at as number,
  lastUsedAt: (r.last_used_at as number | null) ?? null,
});

/** Accounts without passwords: a passkey (or several, one per device) is the only way in */
export class UserStore {
  constructor(private readonly db: DatabaseSync) {}

  // ------------------------------------------------------------------ users

  getUser(id: string): UserRecord | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    return row ? toUser(row) : null;
  }

  findByUsername(username: string): UserRecord | null {
    const row = this.db.prepare('SELECT * FROM users WHERE username_lower = ?').get(username.trim().toLowerCase()) as Row | undefined;
    return row ? toUser(row) : null;
  }

  listUsers(): UserRecord[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY username_lower').all() as Row[]).map(toUser);
  }

  countUsers(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n);
  }

  checkNewUsername(username: unknown): string {
    const name = typeof username === 'string' ? username.trim() : '';
    if (!USERNAME_PATTERN.test(name)) throw new AccountError('Der Benutzername braucht 3–20 Zeichen (Buchstaben, Ziffern, _ . -).');
    if (this.findByUsername(name)) throw new AccountError('Dieser Benutzername ist schon vergeben.', 409);
    return name;
  }

  createUser(username: string, now = Date.now()): UserRecord {
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO users (id, username, username_lower, created_at) VALUES (?, ?, ?, ?)').run(id, username, username.toLowerCase(), now);
    return this.getUser(id)!;
  }

  setBanned(id: string, banned: boolean): boolean {
    const ok = this.db.prepare('UPDATE users SET banned_at = ? WHERE id = ?').run(banned ? Date.now() : null, id).changes > 0;
    if (ok && banned) this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return ok;
  }

  // ------------------------------------------------------------------ passkeys

  addCredential(cred: Omit<StoredCredential, 'lastUsedAt'>): void {
    this.db
      .prepare('INSERT INTO credentials (id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(cred.id, cred.userId, cred.publicKey, cred.counter, JSON.stringify(cred.transports), cred.name.slice(0, 60), cred.createdAt);
  }

  getCredential(id: string): StoredCredential | null {
    const row = this.db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as Row | undefined;
    return row ? toCredential(row) : null;
  }

  credentialsOf(userId: string): StoredCredential[] {
    return (this.db.prepare('SELECT * FROM credentials WHERE user_id = ? ORDER BY created_at').all(userId) as Row[]).map(toCredential);
  }

  touchCredential(id: string, counter: number, now = Date.now()): void {
    this.db.prepare('UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?').run(counter, now, id);
  }

  renameCredential(userId: string, id: string, name: string): boolean {
    return this.db.prepare('UPDATE credentials SET name = ? WHERE id = ? AND user_id = ?').run(name.slice(0, 60), id, userId).changes > 0;
  }

  /** The last passkey cannot be removed, the account would be locked for good */
  deleteCredential(userId: string, id: string): boolean {
    if (this.credentialsOf(userId).length <= 1) throw new AccountError('Der letzte Passkey kann nicht gelöscht werden.', 409);
    return this.db.prepare('DELETE FROM credentials WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  }

  // ------------------------------------------------------------------ sessions

  createSession(userId: string, now = Date.now()): string {
    const token = randomToken();
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)').run(sha256(token), userId, now, now);
    return token;
  }

  /** The user of a session token, null if unknown, expired or banned; refreshes the token's last use */
  userForSession(token: string | undefined, now = Date.now()): UserRecord | null {
    if (!token) return null;
    const hash = sha256(token);
    const row = this.db.prepare('SELECT user_id, last_used_at FROM sessions WHERE token_hash = ?').get(hash) as
      | { user_id: string; last_used_at: number }
      | undefined;
    if (!row) return null;
    if (row.last_used_at < now - SESSION_MAX_AGE_MS) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
      return null;
    }
    const user = this.getUser(row.user_id);
    if (!user || user.bannedAt) return null;
    // Only write once an hour: every request reads the session
    if (row.last_used_at < now - 60 * 60 * 1000) this.db.prepare('UPDATE sessions SET last_used_at = ? WHERE token_hash = ?').run(now, hash);
    return user;
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  // ------------------------------------------------------------------ invites

  createInvite(note: string, now = Date.now()): InviteInfo {
    let code: string;
    do code = randomCode();
    while (this.db.prepare('SELECT 1 FROM invites WHERE code = ?').get(code));
    const cleanNote = note.trim().slice(0, 80);
    this.db.prepare('INSERT INTO invites (code, note, created_at) VALUES (?, ?, ?)').run(code, cleanNote, now);
    return { code: formatCode(code), note: cleanNote, createdAt: now, expiresAt: now + INVITE_MAX_AGE_MS, usedBy: null, usedAt: null };
  }

  listInvites(): InviteInfo[] {
    const rows = this.db
      .prepare(
        `SELECT invites.*, users.username AS used_by_name FROM invites LEFT JOIN users ON users.id = invites.used_by
         ORDER BY invites.created_at DESC`
      )
      .all() as Row[];
    return rows.map((r) => ({
      code: formatCode(r.code as string),
      note: r.note as string,
      createdAt: r.created_at as number,
      expiresAt: (r.created_at as number) + INVITE_MAX_AGE_MS,
      usedBy: (r.used_by_name as string | null) ?? null,
      usedAt: (r.used_at as number | null) ?? null,
    }));
  }

  /** Throws unless the code is unused and not expired */
  checkInvite(code: unknown, now = Date.now()): string {
    const clean = normalizeCode(code);
    const row = this.db.prepare('SELECT created_at, used_by FROM invites WHERE code = ?').get(clean) as
      | { created_at: number; used_by: string | null }
      | undefined;
    if (!row || row.used_by || row.created_at < now - INVITE_MAX_AGE_MS) {
      throw new AccountError('Der Einladungscode ist ungültig, schon benutzt oder abgelaufen.', 403);
    }
    return clean;
  }

  useInvite(code: string, userId: string, now = Date.now()): void {
    this.db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?').run(userId, now, normalizeCode(code));
  }

  deleteInvite(code: string): boolean {
    return this.db.prepare('DELETE FROM invites WHERE code = ?').run(normalizeCode(code)).changes > 0;
  }

  hasOpenInvite(now = Date.now()): boolean {
    return !!this.db.prepare('SELECT 1 FROM invites WHERE used_by IS NULL AND created_at >= ?').get(now - INVITE_MAX_AGE_MS);
  }

  // ------------------------------------------------------------------ new devices

  /** One-time code a signed-in user shows on a new device to add a passkey there */
  createDeviceLink(userId: string, now = Date.now()): { code: string; expiresAt: number } {
    this.db.prepare('DELETE FROM device_links WHERE user_id = ? OR created_at < ?').run(userId, now - DEVICE_LINK_MAX_AGE_MS);
    const code = randomCode();
    this.db.prepare('INSERT INTO device_links (code, user_id, created_at) VALUES (?, ?, ?)').run(code, userId, now);
    return { code: formatCode(code), expiresAt: now + DEVICE_LINK_MAX_AGE_MS };
  }

  userForDeviceLink(code: unknown, now = Date.now()): UserRecord {
    const row = this.db.prepare('SELECT user_id, created_at FROM device_links WHERE code = ?').get(normalizeCode(code)) as
      | { user_id: string; created_at: number }
      | undefined;
    const user = row && row.created_at >= now - DEVICE_LINK_MAX_AGE_MS ? this.getUser(row.user_id) : null;
    if (!user || user.bannedAt) throw new AccountError('Der Gerätecode ist ungültig oder abgelaufen.', 403);
    return user;
  }

  useDeviceLink(code: string): void {
    this.db.prepare('DELETE FROM device_links WHERE code = ?').run(normalizeCode(code));
  }
}
