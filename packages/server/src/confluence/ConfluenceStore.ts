import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ConfluenceKind, ConfluenceNoteStatus } from '@kladde/shared';
import { DataCipher } from '../crypto.js';

/** The saved connection, token included (server side only) */
export interface ConfluenceAccount {
  url: string;
  kind: ConfluenceKind;
  email: string;
  token: string;
  accountName: string;
  updatedAt: number;
}

export interface ConfluenceSyncRecord {
  id: string;
  userId: string;
  kind: 'note' | 'folder';
  noteId: string | null;
  createdAt: number;
  /** Folder path (folder sync; encrypted like note paths) */
  folder: string | null;
  spaceKey: string;
  parentId: string | null;
  parentTitle: string | null;
  trashOnDelete: boolean;
  /** Folder sync: folder path relative to the synced folder ('' = the folder itself) → page id */
  folderPages: Record<string, string>;
  /** Folder sync: notes the user stopped syncing */
  excluded: string[];
}

export interface ConfluencePageRecord {
  noteId: string;
  userId: string;
  syncId: string;
  pageId: string | null;
  title: string;
  parentId: string | null;
  /** Page version after our last update (a newer one means an edit in Confluence) */
  pageVersion: number;
  /** Note version that was synced last */
  noteVersion: number;
  status: ConfluenceNoteStatus;
  error: string | null;
  lastSyncAt: number | null;
  /** Attachment id → file name on the page, with the size that was uploaded */
  attachments: Record<string, { filename: string; size: number }>;
  labels: string[];
}

type SyncData = Omit<ConfluenceSyncRecord, 'id' | 'userId' | 'kind' | 'noteId' | 'createdAt'>;
type PageData = Omit<ConfluencePageRecord, 'noteId' | 'userId' | 'syncId' | 'pageId'>;

/**
 * Confluence connections (#48): URL and token per user, syncs and the note → page mapping. Everything
 * that names a note, a folder or a secret is encrypted with the record id in the AAD.
 */
export class ConfluenceStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly cipher: DataCipher
  ) {}

  // ---------------------------------------------------------------- account

  account(userId: string): ConfluenceAccount | null {
    const row = this.db.prepare('SELECT data, updated_at FROM confluence_accounts WHERE user_id = ?').get(userId) as { data: Uint8Array; updated_at: number } | undefined;
    if (!row) return null;
    try {
      return { ...this.cipher.decryptJson<Omit<ConfluenceAccount, 'updatedAt'>>(row.data, `confluence-account:${userId}`), updatedAt: row.updated_at };
    } catch {
      return null;
    }
  }

  saveAccount(userId: string, account: Omit<ConfluenceAccount, 'updatedAt'>, now = Date.now()): void {
    const data = this.cipher.encryptJson(account, `confluence-account:${userId}`);
    this.db
      .prepare('INSERT INTO confluence_accounts (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
      .run(userId, data, now);
  }

  /** Removes the connection and every sync of the user (the pages in Confluence stay) */
  removeAccount(userId: string): boolean {
    const res = this.db.prepare('DELETE FROM confluence_accounts WHERE user_id = ?').run(userId);
    this.db.prepare('DELETE FROM confluence_syncs WHERE user_id = ?').run(userId);
    return Number(res.changes) > 0;
  }

  hasAccount(userId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM confluence_accounts WHERE user_id = ?').get(userId);
  }

  usersWithAccount(): string[] {
    return (this.db.prepare('SELECT user_id FROM confluence_accounts').all() as { user_id: string }[]).map((r) => r.user_id);
  }

  // ---------------------------------------------------------------- syncs

  private toSync(row: { id: string; user_id: string; kind: string; note_id: string | null; data: Uint8Array; created_at: number }): ConfluenceSyncRecord | null {
    try {
      const data = this.cipher.decryptJson<SyncData>(row.data, `confluence-sync:${row.id}`);
      return {
        id: row.id,
        userId: row.user_id,
        kind: row.kind === 'folder' ? 'folder' : 'note',
        noteId: row.note_id,
        createdAt: row.created_at,
        folder: data.folder ?? null,
        spaceKey: data.spaceKey,
        parentId: data.parentId ?? null,
        parentTitle: data.parentTitle ?? null,
        trashOnDelete: !!data.trashOnDelete,
        folderPages: data.folderPages ?? {},
        excluded: data.excluded ?? [],
      };
    } catch {
      return null;
    }
  }

  syncs(userId: string): ConfluenceSyncRecord[] {
    const rows = this.db.prepare('SELECT * FROM confluence_syncs WHERE user_id = ? ORDER BY created_at').all(userId) as Parameters<ConfluenceStore['toSync']>[0][];
    return rows.map((r) => this.toSync(r)).filter((s): s is ConfluenceSyncRecord => !!s);
  }

  sync(userId: string, id: string): ConfluenceSyncRecord | null {
    const row = this.db.prepare('SELECT * FROM confluence_syncs WHERE id = ? AND user_id = ?').get(id, userId) as Parameters<ConfluenceStore['toSync']>[0] | undefined;
    return row ? this.toSync(row) : null;
  }

  createSync(userId: string, input: Omit<ConfluenceSyncRecord, 'id' | 'userId' | 'createdAt' | 'folderPages' | 'excluded'>, now = Date.now()): ConfluenceSyncRecord {
    const id = crypto.randomBytes(12).toString('base64url');
    const record: ConfluenceSyncRecord = { ...input, id, userId, createdAt: now, folderPages: {}, excluded: [] };
    this.db
      .prepare('INSERT INTO confluence_syncs (id, user_id, kind, note_id, data, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, userId, record.kind, record.noteId, this.cipher.encryptJson(this.syncData(record), `confluence-sync:${id}`), now);
    return record;
  }

  updateSync(record: ConfluenceSyncRecord): void {
    this.db.prepare('UPDATE confluence_syncs SET data = ? WHERE id = ? AND user_id = ?').run(this.cipher.encryptJson(this.syncData(record), `confluence-sync:${record.id}`), record.id, record.userId);
  }

  private syncData(r: ConfluenceSyncRecord): SyncData {
    return {
      folder: r.folder,
      spaceKey: r.spaceKey,
      parentId: r.parentId,
      parentTitle: r.parentTitle,
      trashOnDelete: r.trashOnDelete,
      folderPages: r.folderPages,
      excluded: r.excluded,
    };
  }

  /** Stops a sync; its page mapping goes with it (the pages in Confluence stay) */
  deleteSync(userId: string, id: string): boolean {
    return Number(this.db.prepare('DELETE FROM confluence_syncs WHERE id = ? AND user_id = ?').run(id, userId).changes) > 0;
  }

  // ---------------------------------------------------------------- pages

  private toPage(row: { note_id: string; user_id: string; sync_id: string; page_id: string | null; data: Uint8Array }): ConfluencePageRecord | null {
    try {
      const data = this.cipher.decryptJson<PageData>(row.data, `confluence-page:${row.note_id}`);
      return { ...data, attachments: data.attachments ?? {}, labels: data.labels ?? [], noteId: row.note_id, userId: row.user_id, syncId: row.sync_id, pageId: row.page_id };
    } catch {
      return null;
    }
  }

  page(noteId: string): ConfluencePageRecord | null {
    const row = this.db.prepare('SELECT * FROM confluence_pages WHERE note_id = ?').get(noteId) as Parameters<ConfluenceStore['toPage']>[0] | undefined;
    return row ? this.toPage(row) : null;
  }

  pages(userId: string): ConfluencePageRecord[] {
    const rows = this.db.prepare('SELECT * FROM confluence_pages WHERE user_id = ?').all(userId) as Parameters<ConfluenceStore['toPage']>[0][];
    return rows.map((r) => this.toPage(r)).filter((p): p is ConfluencePageRecord => !!p);
  }

  savePage(record: ConfluencePageRecord, now = Date.now()): void {
    const { noteId, userId, syncId, pageId, ...data } = record;
    this.db
      .prepare(
        `INSERT INTO confluence_pages (note_id, user_id, sync_id, page_id, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(note_id) DO UPDATE SET user_id = excluded.user_id, sync_id = excluded.sync_id, page_id = excluded.page_id, data = excluded.data, updated_at = excluded.updated_at`
      )
      .run(noteId, userId, syncId, pageId, this.cipher.encryptJson(data, `confluence-page:${noteId}`), now);
  }

  deletePage(noteId: string): void {
    this.db.prepare('DELETE FROM confluence_pages WHERE note_id = ?').run(noteId);
  }
}
