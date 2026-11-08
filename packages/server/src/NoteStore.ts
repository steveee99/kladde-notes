import { DatabaseSync } from 'node:sqlite';
import { NoteAccess, NoteShares, PublicNote, PullResponse, PushChange, PushResult, SyncedNote } from '@kladde/shared';
import { DataCipher, randomToken } from './crypto.js';
import { transaction } from './db.js';

/** Upper bound for one note; attachments go through the file store */
export const MAX_NOTE_BYTES = 2 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

interface NoteRow {
  id: string;
  owner_id: string;
  version: number;
  seq: number;
  created_at: number;
  updated_at: number;
  deleted: number;
  payload: Uint8Array;
}

interface Payload {
  path: string;
  content: string;
}

/** Called after every accepted change: who should hear about it (live update, export) */
export interface NoteChangeEvent {
  noteId: string;
  ownerId: string;
  /** Everybody who can see the note (owner and share recipients) */
  audience: string[];
  path: string;
  previousPath: string | null;
  content: string;
  deleted: boolean;
}

export function cleanPath(path: unknown): string {
  if (typeof path !== 'string') throw new Error('invalid path');
  const parts = path
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p && p !== '.' && p !== '..');
  if (!parts.length) throw new Error('invalid path');
  return parts.join('/').slice(0, 400);
}

/**
 * Notes are stored encrypted (path and content); the server only sees ids, versions and timestamps.
 * Every change gets the next value of a global sequence, so a client asks for "everything after N".
 */
export class NoteStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly cipher: DataCipher,
    private readonly onChange: (event: NoteChangeEvent) => void = () => {}
  ) {}

  private nextSeq(): number {
    const row = this.db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'seq' RETURNING value").get() as { value: number };
    return row.value;
  }

  currentSeq(): number {
    return (this.db.prepare("SELECT value FROM counters WHERE name = 'seq'").get() as { value: number }).value;
  }

  private payload(row: NoteRow): Payload {
    return this.cipher.decryptJson<Payload>(row.payload, `note:${row.id}`);
  }

  private toSynced(row: NoteRow, access: NoteAccess, owner?: string): SyncedNote {
    const p = this.payload(row);
    return {
      id: row.id,
      path: p.path,
      content: p.content,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deleted: !!row.deleted,
      access,
      ...(owner ? { owner } : {}),
    };
  }

  private getRow(id: string): NoteRow | undefined {
    return this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined;
  }

  accessOf(userId: string, row: NoteRow): NoteAccess | null {
    if (row.owner_id === userId) return 'owner';
    const share = this.db.prepare('SELECT can_write FROM shares WHERE note_id = ? AND user_id = ?').get(row.id, userId) as
      | { can_write: number }
      | undefined;
    return share ? (share.can_write ? 'write' : 'read') : null;
  }

  private audience(row: NoteRow): string[] {
    const shared = this.db.prepare('SELECT user_id FROM shares WHERE note_id = ?').all(row.id) as { user_id: string }[];
    return [row.owner_id, ...shared.map((s) => s.user_id)];
  }

  pull(userId: string, since: number): PullResponse {
    const cursor = this.currentSeq();
    const own = this.db.prepare('SELECT * FROM notes WHERE owner_id = ? AND seq > ? ORDER BY seq').all(userId, since) as unknown as NoteRow[];
    const shared = this.db
      .prepare(
        `SELECT notes.*, shares.can_write, users.username AS owner_name FROM shares
         JOIN notes ON notes.id = shares.note_id JOIN users ON users.id = notes.owner_id
         WHERE shares.user_id = ? AND (notes.seq > ? OR shares.seq > ?) AND notes.deleted = 0`
      )
      .all(userId, since, since) as unknown as (NoteRow & { can_write: number; owner_name: string })[];
    const revoked = this.db
      .prepare('SELECT DISTINCT note_id FROM share_revocations WHERE user_id = ? AND seq > ?')
      .all(userId, since) as { note_id: string }[];
    const sharedIds = new Set(shared.map((s) => s.id));
    return {
      notes: [...own.map((r) => this.toSynced(r, 'owner')), ...shared.map((r) => this.toSynced(r, r.can_write ? 'write' : 'read', r.owner_name))],
      revoked: revoked.map((r) => r.note_id).filter((id) => !sharedIds.has(id) && !this.isShared(id, userId)),
      cursor,
    };
  }

  private isShared(noteId: string, userId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM shares WHERE note_id = ? AND user_id = ?').get(noteId, userId);
  }

  push(userId: string, changes: PushChange[]): PushResult[] {
    const events: NoteChangeEvent[] = [];
    const results = transaction(this.db, () =>
      changes.map((change): PushResult => {
        if (typeof change?.id !== 'string' || !ID_PATTERN.test(change.id)) return { id: String(change?.id), status: 'forbidden' };
        const content = typeof change.content === 'string' ? change.content : '';
        if (Buffer.byteLength(content) > MAX_NOTE_BYTES) return { id: change.id, status: 'forbidden' };
        const now = Date.now();
        const updatedAt = Math.min(Number(change.updatedAt) || now, now);
        const row = this.getRow(change.id);
        if (!row) {
          const path = cleanPath(change.path);
          const seq = this.nextSeq();
          const createdAt = Math.min(Number(change.createdAt) || now, now);
          this.db
            .prepare('INSERT INTO notes (id, owner_id, version, seq, created_at, updated_at, deleted, payload) VALUES (?, ?, 1, ?, ?, ?, ?, ?)')
            .run(change.id, userId, seq, createdAt, updatedAt, change.deleted ? 1 : 0, this.cipher.encryptJson({ path, content }, `note:${change.id}`));
          events.push({ noteId: change.id, ownerId: userId, audience: [userId], path, previousPath: null, content, deleted: !!change.deleted });
          return { id: change.id, status: 'ok', version: 1 };
        }
        const access = this.accessOf(userId, row);
        if (access !== 'owner' && access !== 'write') return { id: change.id, status: 'forbidden' };
        if (row.version !== change.baseVersion) {
          return { id: change.id, status: 'conflict', server: this.toSynced(row, access) };
        }
        const old = this.payload(row);
        // Only the owner moves, renames or deletes a note: it lives in their space
        const path = access === 'owner' ? cleanPath(change.path) : old.path;
        const deleted = access === 'owner' ? !!change.deleted : !!row.deleted;
        const seq = this.nextSeq();
        this.db
          .prepare('UPDATE notes SET version = version + 1, seq = ?, updated_at = ?, deleted = ?, payload = ? WHERE id = ?')
          .run(seq, updatedAt, deleted ? 1 : 0, this.cipher.encryptJson({ path, content: deleted ? '' : content }, `note:${row.id}`), row.id);
        const audience = this.audience(row);
        if (deleted) this.dropShares(row.id, seq);
        events.push({ noteId: row.id, ownerId: row.owner_id, audience, path, previousPath: old.path, content, deleted });
        return { id: change.id, status: 'ok', version: row.version + 1 };
      })
    );
    for (const e of events) this.onChange(e);
    return results;
  }

  private dropShares(noteId: string, seq: number): void {
    const users = this.db.prepare('SELECT user_id FROM shares WHERE note_id = ?').all(noteId) as { user_id: string }[];
    for (const u of users) this.db.prepare('INSERT INTO share_revocations (note_id, user_id, seq) VALUES (?, ?, ?)').run(noteId, u.user_id, seq);
    this.db.prepare('DELETE FROM shares WHERE note_id = ?').run(noteId);
    this.db.prepare('DELETE FROM public_links WHERE note_id = ?').run(noteId);
  }

  // ------------------------------------------------------------------ sharing

  private ownedRow(userId: string, noteId: string): NoteRow {
    const row = this.getRow(noteId);
    if (!row || row.owner_id !== userId || row.deleted) throw new Error('not found');
    return row;
  }

  shares(userId: string, noteId: string): NoteShares {
    this.ownedRow(userId, noteId);
    const users = this.db
      .prepare('SELECT users.username, shares.can_write FROM shares JOIN users ON users.id = shares.user_id WHERE note_id = ? ORDER BY users.username_lower')
      .all(noteId) as { username: string; can_write: number }[];
    const link = this.db.prepare('SELECT token FROM public_links WHERE note_id = ?').get(noteId) as { token: string } | undefined;
    return { users: users.map((u) => ({ username: u.username, canWrite: !!u.can_write })), publicToken: link?.token ?? null };
  }

  share(userId: string, noteId: string, targetUserId: string, canWrite: boolean): string[] {
    const row = this.ownedRow(userId, noteId);
    if (targetUserId === userId) throw new Error('self');
    const seq = this.nextSeq();
    this.db
      .prepare('INSERT INTO shares (note_id, user_id, can_write, seq) VALUES (?, ?, ?, ?) ON CONFLICT(note_id, user_id) DO UPDATE SET can_write = excluded.can_write, seq = excluded.seq')
      .run(noteId, targetUserId, canWrite ? 1 : 0, seq);
    return this.audience(row);
  }

  unshare(userId: string, noteId: string, targetUserId: string): void {
    this.ownedRow(userId, noteId);
    const seq = this.nextSeq();
    if (this.db.prepare('DELETE FROM shares WHERE note_id = ? AND user_id = ?').run(noteId, targetUserId).changes > 0) {
      this.db.prepare('INSERT INTO share_revocations (note_id, user_id, seq) VALUES (?, ?, ?)').run(noteId, targetUserId, seq);
    }
  }

  setPublic(userId: string, noteId: string, enabled: boolean): string | null {
    this.ownedRow(userId, noteId);
    if (!enabled) {
      this.db.prepare('DELETE FROM public_links WHERE note_id = ?').run(noteId);
      return null;
    }
    const existing = this.db.prepare('SELECT token FROM public_links WHERE note_id = ?').get(noteId) as { token: string } | undefined;
    if (existing) return existing.token;
    const token = randomToken(18);
    this.db.prepare('INSERT INTO public_links (token, note_id, created_at) VALUES (?, ?, ?)').run(token, noteId, Date.now());
    return token;
  }

  publicNote(token: string): PublicNote | null {
    const row = this.db
      .prepare('SELECT notes.*, users.username AS owner_name FROM public_links JOIN notes ON notes.id = public_links.note_id JOIN users ON users.id = notes.owner_id WHERE token = ? AND notes.deleted = 0')
      .get(token) as (NoteRow & { owner_name: string }) | undefined;
    if (!row) return null;
    const p = this.payload(row);
    return { path: p.path, content: p.content, owner: row.owner_name, updatedAt: row.updated_at };
  }

  /** The user's own live notes with ids and versions (MCP access: only the own space, never shared notes) */
  ownedNotes(userId: string): SyncedNote[] {
    const rows = this.db.prepare('SELECT * FROM notes WHERE owner_id = ? AND deleted = 0').all(userId) as unknown as NoteRow[];
    return rows.map((r) => this.toSynced(r, 'owner'));
  }

  /** All live notes of a user (for the export mirror) */
  allOf(userId: string): { path: string; content: string }[] {
    const rows = this.db.prepare('SELECT * FROM notes WHERE owner_id = ? AND deleted = 0').all(userId) as unknown as NoteRow[];
    return rows.map((r) => this.payload(r));
  }

  counts(): { notes: number; shares: number } {
    const n = this.db.prepare('SELECT COUNT(*) AS n FROM notes WHERE deleted = 0').get() as { n: number };
    const s = this.db.prepare('SELECT COUNT(*) AS n FROM shares').get() as { n: number };
    return { notes: n.n, shares: s.n };
  }
}
