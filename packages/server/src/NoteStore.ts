import { DatabaseSync } from 'node:sqlite';
import { NoteVersion, NoteVersionInfo, FolderPermissions, FolderShares, NoteAccess, NoteShare, NoteShares, PublicNote, PullResponse, PushChange, PushResult, SharedFolder, SYSTEM_PREFIX, SyncedNote } from '@kladde/shared';
import { DataCipher, randomToken } from './crypto.js';
import { transaction } from './db.js';

/** Upper bound for one note; attachments go through the file store */
export const MAX_NOTE_BYTES = 2 * 1024 * 1024;
/** A pause this long starts a new version; saves closer together update the newest one (a writing session is one version) */
export const VERSION_PAUSE_MS = 10 * 60 * 1000;
/** Even without a pause, a version never grows beyond this span */
export const VERSION_MAX_SPAN_MS = 60 * 60 * 1000;
/** Older versions of a note are dropped beyond this many */
export const MAX_VERSIONS = 100;
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

interface VersionRow {
  id: string;
  note_id: string;
  created_at: number;
  saved_at: number;
  payload: Uint8Array;
}

interface Payload {
  path: string;
  content: string;
}

/** A folder share with the folder path decrypted */
interface FolderShare extends FolderPermissions {
  id: string;
  userId: string;
  folder: string;
}

/** Create or delete only make sense together with editing */
export function normalizePermissions(p: Partial<FolderPermissions>): FolderPermissions {
  const canCreate = !!p.canCreate;
  const canDelete = !!p.canDelete;
  return { canWrite: !!p.canWrite || canCreate || canDelete, canCreate, canDelete };
}

const rank = (f: FolderPermissions) => Number(f.canWrite) + Number(f.canCreate) + Number(f.canDelete);

/** True when the note at `path` lies in `folder` or one of its subfolders (system notes are never shared) */
export function inFolder(path: string, folder: string): boolean {
  return !path.startsWith(SYSTEM_PREFIX) && path.startsWith(`${folder}/`);
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

  private toSynced(row: NoteRow, access: NoteAccess, owner?: string, ownerAvatar?: string | null): SyncedNote {
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
      ...(ownerAvatar ? { ownerAvatar: `/api/avatars/${ownerAvatar}` } : {}),
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

  /** Everybody who may see the note (owner and shares), or null for an unknown/deleted note; for live presence */
  audienceOf(noteId: string): string[] | null {
    if (!ID_PATTERN.test(noteId)) return null;
    const row = this.getRow(noteId);
    return row && !row.deleted ? this.audience(row) : null;
  }

  pull(userId: string, since: number): PullResponse {
    const cursor = this.currentSeq();
    const own = this.db.prepare('SELECT * FROM notes WHERE owner_id = ? AND seq > ? ORDER BY seq').all(userId, since) as unknown as NoteRow[];
    const shared = this.db
      .prepare(
        `SELECT notes.*, shares.can_write, users.username AS owner_name, users.avatar_id AS owner_avatar, folder_shares.can_delete FROM shares
         JOIN notes ON notes.id = shares.note_id JOIN users ON users.id = notes.owner_id
         LEFT JOIN folder_shares ON folder_shares.id = shares.folder_share_id
         WHERE shares.user_id = ? AND (notes.seq > ? OR shares.seq > ?) AND notes.deleted = 0`
      )
      .all(userId, since, since) as unknown as (NoteRow & { can_write: number; owner_name: string; owner_avatar: string | null; can_delete: number | null })[];
    const revoked = this.db
      .prepare('SELECT DISTINCT note_id FROM share_revocations WHERE user_id = ? AND seq > ?')
      .all(userId, since) as { note_id: string }[];
    const sharedIds = new Set(shared.map((s) => s.id));
    return {
      notes: [
        ...own.map((r) => this.toSynced(r, 'owner')),
        ...shared.map((r) => ({ ...this.toSynced(r, r.can_write ? 'write' : 'read', r.owner_name, r.owner_avatar), ...(r.can_delete ? { canDelete: true } : {}) })),
      ],
      revoked: revoked.map((r) => r.note_id).filter((id) => !sharedIds.has(id) && !this.isShared(id, userId)),
      cursor,
      sharedFolders: this.sharedWith(userId),
    };
  }

  /** Folders other users share with `userId` */
  sharedWith(userId: string): SharedFolder[] {
    const rows = this.db
      .prepare(
        `SELECT folder_shares.*, users.username AS owner_name, users.avatar_id AS owner_avatar FROM folder_shares JOIN users ON users.id = folder_shares.owner_id
         WHERE folder_shares.user_id = ? AND users.banned_at IS NULL`
      )
      .all(userId) as { id: string; can_write: number; can_create: number; can_delete: number; payload: Uint8Array; owner_name: string; owner_avatar: string | null }[];
    return rows
      .map((r) => ({
        owner: r.owner_name,
        ...(r.owner_avatar ? { ownerAvatar: `/api/avatars/${r.owner_avatar}` } : {}),
        folder: this.cipher.decryptJson<{ folder: string }>(r.payload, `folder_share:${r.id}`).folder,
        canWrite: !!r.can_write,
        canCreate: !!r.can_create,
        canDelete: !!r.can_delete,
      }))
      .sort((a, b) => a.owner.localeCompare(b.owner, 'de') || a.folder.localeCompare(b.folder, 'de'));
  }

  /** Owner id when `userId` may create a note at `path` in a folder `ownerName` shares with them */
  private createGrant(userId: string, ownerName: unknown, path: string): string | null {
    if (typeof ownerName !== 'string') return null;
    const owner = this.db.prepare('SELECT id FROM users WHERE username_lower = ? AND banned_at IS NULL').get(ownerName.toLowerCase()) as { id: string } | undefined;
    if (!owner || owner.id === userId) return null;
    const allowed = this.folderSharesOf(owner.id).some((f) => f.userId === userId && f.canCreate && inFolder(path, f.folder));
    return allowed ? owner.id : null;
  }

  /** A recipient may delete a note when the folder share it comes through allows it */
  private canDeleteShared(noteId: string, userId: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM shares JOIN folder_shares ON folder_shares.id = shares.folder_share_id WHERE shares.note_id = ? AND shares.user_id = ? AND folder_shares.can_delete = 1')
      .get(noteId, userId);
  }

  private isShared(noteId: string, userId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM shares WHERE note_id = ? AND user_id = ?').get(noteId, userId);
  }

  push(userId: string, changes: PushChange[]): PushResult[] {
    const events: NoteChangeEvent[] = [];
    // Only needed when the caller creates or moves own notes; decrypted once per push
    let cached: FolderShare[] | undefined;
    const folderShares = () => (cached ??= this.folderSharesOf(userId));
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
          // In a folder shared with the caller, the note belongs to the folder's owner (and lives in their space)
          let ownerId = userId;
          if (change.owner !== undefined) {
            const grant = this.createGrant(userId, change.owner, path);
            if (!grant || change.deleted) return { id: change.id, status: 'forbidden' };
            ownerId = grant;
          }
          const seq = this.nextSeq();
          const createdAt = Math.min(Number(change.createdAt) || now, now);
          this.db
            .prepare('INSERT INTO notes (id, owner_id, version, seq, created_at, updated_at, deleted, payload) VALUES (?, ?, 1, ?, ?, ?, ?, ?)')
            .run(change.id, ownerId, seq, createdAt, updatedAt, change.deleted ? 1 : 0, this.cipher.encryptJson({ path, content }, `note:${change.id}`));
          if (!change.deleted) this.recordVersion(change.id, path, content, now);
          const shares = ownerId === userId ? folderShares() : this.folderSharesOf(ownerId);
          const added = change.deleted ? [] : this.applyFolderShares(ownerId, change.id, path, seq, shares);
          events.push({ noteId: change.id, ownerId, audience: [...new Set([ownerId, userId, ...added])], path, previousPath: null, content, deleted: !!change.deleted });
          return { id: change.id, status: 'ok', version: 1 };
        }
        const access = this.accessOf(userId, row);
        if (access !== 'owner' && access !== 'write') return { id: change.id, status: 'forbidden' };
        if (row.version !== change.baseVersion) {
          return { id: change.id, status: 'conflict', server: this.toSynced(row, access) };
        }
        // A recipient deletes only with the folder share's permission (and an unknown owner is refused)
        if (access !== 'owner' && change.deleted && !this.canDeleteShared(row.id, userId)) return { id: change.id, status: 'forbidden' };
        const old = this.payload(row);
        // Only the owner moves or renames a note: it lives in their space. Deleting also needs the folder share's permission
        const path = access === 'owner' ? cleanPath(change.path) : old.path;
        const deleted = !!change.deleted;
        const seq = this.nextSeq();
        this.db
          .prepare('UPDATE notes SET version = version + 1, seq = ?, updated_at = ?, deleted = ?, payload = ? WHERE id = ?')
          .run(seq, updatedAt, deleted ? 1 : 0, this.cipher.encryptJson({ path, content: deleted ? '' : content }, `note:${row.id}`), row.id);
        if (deleted) this.db.prepare('DELETE FROM note_versions WHERE note_id = ?').run(row.id);
        else if (path !== old.path || content !== old.content) this.recordVersion(row.id, path, content, now);
        const audience = this.audience(row);
        if (deleted) this.dropShares(row.id, seq);
        else if (access === 'owner' && path !== old.path) audience.push(...this.applyFolderShares(userId, row.id, path, seq, folderShares()));
        events.push({ noteId: row.id, ownerId: row.owner_id, audience: [...new Set(audience)], path, previousPath: old.path, content, deleted });
        return { id: change.id, status: 'ok', version: row.version + 1 };
      })
    );
    for (const e of events) this.onChange(e);
    return results;
  }

  /** Keeps the history: saves close together share one version, the oldest ones fall off */
  private recordVersion(noteId: string, path: string, content: string, now: number): void {
    const payload = (id: string) => this.cipher.encryptJson({ path, content }, `note_version:${id}`);
    const last = this.db.prepare('SELECT id, created_at, saved_at FROM note_versions WHERE note_id = ? ORDER BY saved_at DESC, rowid DESC LIMIT 1').get(noteId) as
      | { id: string; created_at: number; saved_at: number }
      | undefined;
    if (last && now - last.saved_at < VERSION_PAUSE_MS && now - last.created_at < VERSION_MAX_SPAN_MS) {
      this.db.prepare('UPDATE note_versions SET saved_at = ?, payload = ? WHERE id = ?').run(now, payload(last.id), last.id);
      return;
    }
    const id = randomToken(12);
    this.db.prepare('INSERT INTO note_versions (id, note_id, created_at, saved_at, payload) VALUES (?, ?, ?, ?, ?)').run(id, noteId, now, now, payload(id));
    this.db
      .prepare('DELETE FROM note_versions WHERE note_id = ? AND id NOT IN (SELECT id FROM note_versions WHERE note_id = ? ORDER BY saved_at DESC, rowid DESC LIMIT ?)')
      .run(noteId, noteId, MAX_VERSIONS);
  }

  /** Newest first; anybody who can see the note may look at its history */
  versions(userId: string, noteId: string): NoteVersionInfo[] {
    this.readableRow(userId, noteId);
    const rows = this.db.prepare('SELECT * FROM note_versions WHERE note_id = ? ORDER BY saved_at DESC, rowid DESC').all(noteId) as unknown as VersionRow[];
    return rows.map((r) => {
      const v = this.versionOf(r);
      return { id: r.id, savedAt: r.saved_at, path: v.path, size: Buffer.byteLength(v.content) };
    });
  }

  version(userId: string, noteId: string, versionId: string): NoteVersion {
    this.readableRow(userId, noteId);
    const r = this.db.prepare('SELECT * FROM note_versions WHERE id = ? AND note_id = ?').get(versionId, noteId) as VersionRow | undefined;
    if (!r) throw new Error('not found');
    const v = this.versionOf(r);
    return { id: r.id, savedAt: r.saved_at, path: v.path, size: Buffer.byteLength(v.content), content: v.content };
  }

  private versionOf(r: VersionRow): Payload {
    return this.cipher.decryptJson<Payload>(r.payload, `note_version:${r.id}`);
  }

  private readableRow(userId: string, noteId: string): NoteRow {
    const row = this.getRow(noteId);
    if (!row || row.deleted || !this.accessOf(userId, row)) throw new Error('not found');
    return row;
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
      .prepare(
        'SELECT users.username, users.avatar_id, shares.can_write, shares.folder_share_id FROM shares JOIN users ON users.id = shares.user_id WHERE note_id = ? ORDER BY users.username_lower'
      )
      .all(noteId) as { username: string; avatar_id: string | null; can_write: number; folder_share_id: string | null }[];
    const folders = new Map(this.folderSharesOf(userId).map((f) => [f.id, f.folder]));
    const link = this.db.prepare('SELECT token FROM public_links WHERE note_id = ?').get(noteId) as { token: string } | undefined;
    return {
      users: users.map((u): NoteShare => {
        const viaFolder = u.folder_share_id ? folders.get(u.folder_share_id) : undefined;
        return {
          username: u.username,
          ...(u.avatar_id ? { avatarUrl: `/api/avatars/${u.avatar_id}` } : {}),
          canWrite: !!u.can_write,
          ...(viaFolder ? { viaFolder } : {}),
        };
      }),
      publicToken: link?.token ?? null,
    };
  }

  share(userId: string, noteId: string, targetUserId: string, canWrite: boolean): string[] {
    const row = this.ownedRow(userId, noteId);
    if (targetUserId === userId) throw new Error('self');
    const seq = this.nextSeq();
    this.db
      .prepare(
        'INSERT INTO shares (note_id, user_id, can_write, seq) VALUES (?, ?, ?, ?) ON CONFLICT(note_id, user_id) DO UPDATE SET can_write = excluded.can_write, seq = excluded.seq, folder_share_id = NULL'
      )
      .run(noteId, targetUserId, canWrite ? 1 : 0, seq);
    return this.audience(row);
  }

  /** Removes a direct share; a share through a shared folder stays (it is managed on the folder) */
  unshare(userId: string, noteId: string, targetUserId: string): void {
    const row = this.ownedRow(userId, noteId);
    transaction(this.db, () => {
      const seq = this.nextSeq();
      if (this.db.prepare('DELETE FROM shares WHERE note_id = ? AND user_id = ? AND folder_share_id IS NULL').run(noteId, targetUserId).changes > 0) {
        this.db.prepare('INSERT INTO share_revocations (note_id, user_id, seq) VALUES (?, ?, ?)').run(noteId, targetUserId, seq);
        // The folder may still share it (the recipient pulls it again with this seq)
        this.applyFolderShares(userId, noteId, this.payload(row).path, seq, this.folderSharesOf(userId));
      }
    });
  }

  // ------------------------------------------------------------------ folder shares

  private folderSharesOf(ownerId: string): FolderShare[] {
    const rows = this.db.prepare('SELECT id, user_id, can_write, can_create, can_delete, payload FROM folder_shares WHERE owner_id = ?').all(ownerId) as {
      id: string;
      user_id: string;
      can_write: number;
      can_create: number;
      can_delete: number;
      payload: Uint8Array;
    }[];
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      canWrite: !!r.can_write,
      canCreate: !!r.can_create,
      canDelete: !!r.can_delete,
      folder: this.cipher.decryptJson<{ folder: string }>(r.payload, `folder_share:${r.id}`).folder,
    }));
  }

  /**
   * Brings the folder-derived shares of one note in line with its path: it is shared with everybody a containing folder is
   * shared with, and with nobody else through a folder. Direct shares stay untouched. Returns the users whose access changed.
   */
  private applyFolderShares(ownerId: string, noteId: string, path: string, seq: number, list: FolderShare[]): string[] {
    const wanted = new Map<string, FolderShare>();
    for (const f of list) {
      if (f.userId === ownerId || !inFolder(path, f.folder)) continue;
      const prev = wanted.get(f.userId);
      if (!prev || rank(f) > rank(prev)) wanted.set(f.userId, f);
    }
    const current = this.db.prepare('SELECT user_id, can_write, folder_share_id FROM shares WHERE note_id = ?').all(noteId) as {
      user_id: string;
      can_write: number;
      folder_share_id: string | null;
    }[];
    const changed: string[] = [];
    for (const cur of current) {
      if (!cur.folder_share_id || wanted.has(cur.user_id)) continue;
      this.db.prepare('DELETE FROM shares WHERE note_id = ? AND user_id = ?').run(noteId, cur.user_id);
      this.db.prepare('INSERT INTO share_revocations (note_id, user_id, seq) VALUES (?, ?, ?)').run(noteId, cur.user_id, seq);
      changed.push(cur.user_id);
    }
    for (const [user, f] of wanted) {
      const cur = current.find((c) => c.user_id === user);
      if (!cur) {
        this.db.prepare('INSERT INTO shares (note_id, user_id, can_write, seq, folder_share_id) VALUES (?, ?, ?, ?, ?)').run(noteId, user, f.canWrite ? 1 : 0, seq, f.id);
        changed.push(user);
      } else if (cur.folder_share_id && (cur.folder_share_id !== f.id || !!cur.can_write !== f.canWrite)) {
        this.db.prepare('UPDATE shares SET can_write = ?, seq = ?, folder_share_id = ? WHERE note_id = ? AND user_id = ?').run(f.canWrite ? 1 : 0, seq, f.id, noteId, user);
        changed.push(user);
      }
    }
    return changed;
  }

  /** Re-applies all folder shares of the owner to all of their live notes; returns the users whose access changed */
  private applyAllFolderShares(ownerId: string, seq: number): string[] {
    const list = this.folderSharesOf(ownerId);
    const rows = this.db.prepare('SELECT * FROM notes WHERE owner_id = ? AND deleted = 0').all(ownerId) as unknown as NoteRow[];
    const changed = new Set<string>();
    for (const r of rows) for (const u of this.applyFolderShares(ownerId, r.id, this.payload(r).path, seq, list)) changed.add(u);
    return [...changed];
  }

  /** Who the folder is shared with, and who sees it through a parent folder */
  folderShares(ownerId: string, folder: string): FolderShares {
    const clean = cleanPath(folder);
    const infos = new Map<string, { username: string; avatar_id: string | null }>();
    const infoOf = (id: string) => {
      if (!infos.has(id)) {
        infos.set(id, this.db.prepare('SELECT username, avatar_id FROM users WHERE id = ?').get(id) as { username: string; avatar_id: string | null });
      }
      return infos.get(id)!;
    };
    const list = this.folderSharesOf(ownerId);
    const sort = (a: NoteShare, b: NoteShare) => a.username.localeCompare(b.username, 'de');
    return {
      users: list
        .filter((f) => f.folder === clean)
        .map((f) => {
          const u = infoOf(f.userId);
          return {
            username: u.username,
            ...(u.avatar_id ? { avatarUrl: `/api/avatars/${u.avatar_id}` } : {}),
            canWrite: f.canWrite,
            canCreate: f.canCreate,
            canDelete: f.canDelete,
          };
        })
        .sort(sort),
      inherited: list
        .filter((f) => clean.startsWith(`${f.folder}/`))
        .map((f) => {
          const u = infoOf(f.userId);
          return {
            username: u.username,
            ...(u.avatar_id ? { avatarUrl: `/api/avatars/${u.avatar_id}` } : {}),
            canWrite: f.canWrite,
            canCreate: f.canCreate,
            canDelete: f.canDelete,
            viaFolder: f.folder,
          };
        })
        .sort(sort),
    };
  }

  /** Shares the folder (with subfolders, including notes added later) with another user; returns who should pull */
  shareFolder(ownerId: string, folder: string, targetUserId: string, permissions: Partial<FolderPermissions>): string[] {
    const clean = cleanPath(folder);
    if (targetUserId === ownerId) throw new Error('self');
    const p = normalizePermissions(permissions);
    const flags = [p.canWrite ? 1 : 0, p.canCreate ? 1 : 0, p.canDelete ? 1 : 0];
    return transaction(this.db, () => {
      const seq = this.nextSeq();
      const existing = this.folderSharesOf(ownerId).find((f) => f.folder === clean && f.userId === targetUserId);
      if (existing) {
        this.db.prepare('UPDATE folder_shares SET can_write = ?, can_create = ?, can_delete = ? WHERE id = ?').run(...flags, existing.id);
        // The recipient pulls the notes again and learns the new delete permission
        this.db.prepare('UPDATE shares SET seq = ? WHERE folder_share_id = ?').run(seq, existing.id);
      } else {
        const id = randomToken(12);
        this.db
          .prepare('INSERT INTO folder_shares (id, owner_id, user_id, can_write, can_create, can_delete, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, ownerId, targetUserId, ...flags, this.cipher.encryptJson({ folder: clean }, `folder_share:${id}`), Date.now());
      }
      return [ownerId, targetUserId, ...this.applyAllFolderShares(ownerId, seq)];
    });
  }

  /** Stops sharing the folder with the user; notes shared directly or through another folder stay shared */
  unshareFolder(ownerId: string, folder: string, targetUserId: string): string[] {
    const clean = cleanPath(folder);
    return transaction(this.db, () => {
      const existing = this.folderSharesOf(ownerId).find((f) => f.folder === clean && f.userId === targetUserId);
      if (!existing) return [];
      const seq = this.nextSeq();
      // Re-apply without the share first, so every note it covered gets a revocation (or moves to another folder share)
      const rest = this.folderSharesOf(ownerId).filter((f) => f.id !== existing.id);
      const rows = this.db
        .prepare('SELECT notes.* FROM shares JOIN notes ON notes.id = shares.note_id WHERE shares.folder_share_id = ?')
        .all(existing.id) as unknown as NoteRow[];
      for (const r of rows) this.applyFolderShares(ownerId, r.id, this.payload(r).path, seq, rest);
      this.db.prepare('DELETE FROM folder_shares WHERE id = ?').run(existing.id);
      return [ownerId, targetUserId];
    });
  }

  /** A folder was renamed or moved: its shares (and those of its subfolders) follow */
  renameFolderShares(ownerId: string, from: string, to: string): string[] {
    const source = cleanPath(from);
    const target = cleanPath(to);
    return transaction(this.db, () => {
      let moved = false;
      for (const f of this.folderSharesOf(ownerId)) {
        if (f.folder !== source && !f.folder.startsWith(`${source}/`)) continue;
        const folder = target + f.folder.slice(source.length);
        this.db.prepare('UPDATE folder_shares SET payload = ? WHERE id = ?').run(this.cipher.encryptJson({ folder }, `folder_share:${f.id}`), f.id);
        moved = true;
      }
      return moved ? [ownerId, ...this.applyAllFolderShares(ownerId, this.nextSeq())] : [];
    });
  }

  /** The folder was deleted: forget its shares (and those of its subfolders) */
  dropFolderShares(ownerId: string, folder: string): string[] {
    const clean = cleanPath(folder);
    const affected = this.folderSharesOf(ownerId).filter((f) => f.folder === clean || f.folder.startsWith(`${clean}/`));
    return affected.flatMap((f) => this.unshareFolder(ownerId, f.folder, f.userId));
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
      .prepare(
        'SELECT notes.*, users.username AS owner_name, users.avatar_id AS owner_avatar FROM public_links JOIN notes ON notes.id = public_links.note_id JOIN users ON users.id = notes.owner_id WHERE token = ? AND notes.deleted = 0'
      )
      .get(token) as (NoteRow & { owner_name: string; owner_avatar: string | null }) | undefined;
    if (!row) return null;
    const p = this.payload(row);
    return {
      path: p.path,
      content: p.content,
      owner: row.owner_name,
      ...(row.owner_avatar ? { ownerAvatar: `/api/avatars/${row.owner_avatar}` } : {}),
      updatedAt: row.updated_at,
    };
  }

  /** Bumps share sequence numbers and returns recipient user ids when an owner updates or removes their avatar */
  refreshSharedAvatar(userId: string): string[] {
    return transaction(this.db, () => {
      const recipients = this.db
        .prepare(
          `SELECT DISTINCT user_id FROM (
             SELECT shares.user_id AS user_id FROM shares JOIN notes ON notes.id = shares.note_id WHERE notes.owner_id = ? AND notes.deleted = 0
             UNION
             SELECT user_id FROM folder_shares WHERE owner_id = ?
           )`
        )
        .all(userId, userId) as { user_id: string }[];
      if (!recipients.length) return [];
      const seq = this.nextSeq();
      this.db
        .prepare('UPDATE shares SET seq = ? WHERE note_id IN (SELECT id FROM notes WHERE owner_id = ? AND deleted = 0)')
        .run(seq, userId);
      return recipients.map((r) => r.user_id);
    });
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
