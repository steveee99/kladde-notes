import { openDB, DBSchema, IDBPDatabase } from 'idb';
import type { SyncedNote } from '@kladde/shared';

/** A note on this device: the last synced state plus local edits not yet pushed */
export interface LocalNote extends SyncedNote {
  dirty: boolean;
  /** Only while dirty: content and path of the synced `version` the local edits started from (three-way merge base) */
  base?: string;
  basePath?: string;
  /** Only while a deletion is pushed: the folder deletion this note was part of (restored as one unit from the trash) */
  trashBatch?: string;
  trashFolder?: string;
  /** Online mode: when the text of this note was loaded (the oldest ones are dropped again) */
  cachedAt?: number;
}

/** An attachment added while offline (#28): kept on this device until it is uploaded */
export interface PendingUpload {
  id: string;
  name: string;
  mime: string;
  size: number;
  blob: Blob;
  createdAt: number;
  /** Why the server refused it (too large, …); such uploads wait for retry or discard */
  error?: string;
}

interface Schema extends DBSchema {
  notes: { key: string; value: LocalNote };
  meta: { key: string; value: unknown };
  uploads: { key: string; value: PendingUpload };
}

let dbPromise: Promise<IDBPDatabase<Schema>> | null = null;

/**
 * One database per account, so two accounts on one device never mix. In online mode a separate one, which holds only
 * the notes the device has the text of (opened ones, unsaved edits), not the offline copy of the whole vault.
 */
export function openLocalDb(userId: string, online = false): Promise<IDBPDatabase<Schema>> {
  dbPromise = openDB<Schema>(online ? `kladde-online-${userId}` : `kladde-${userId}`, 2, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('notes', { keyPath: 'id' });
        db.createObjectStore('meta');
      }
      // 2: attachments waiting for a connection
      if (oldVersion < 2) db.createObjectStore('uploads', { keyPath: 'id' });
    },
  });
  return dbPromise;
}

export type LocalDb = IDBPDatabase<Schema>;
