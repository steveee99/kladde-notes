import { openDB, DBSchema, IDBPDatabase } from 'idb';
import type { SyncedNote } from '@kladde/shared';

/** A note on this device: the last synced state plus local edits not yet pushed */
export interface LocalNote extends SyncedNote {
  dirty: boolean;
  /** Only while dirty: content and path of the synced `version` the local edits started from (three-way merge base) */
  base?: string;
  basePath?: string;
}

interface Schema extends DBSchema {
  notes: { key: string; value: LocalNote };
  meta: { key: string; value: unknown };
}

let dbPromise: Promise<IDBPDatabase<Schema>> | null = null;

/** One database per account, so two accounts on one device never mix */
export function openLocalDb(userId: string): Promise<IDBPDatabase<Schema>> {
  dbPromise = openDB<Schema>(`kladde-${userId}`, 1, {
    upgrade(db) {
      db.createObjectStore('notes', { keyPath: 'id' });
      db.createObjectStore('meta');
    },
  });
  return dbPromise;
}

export type LocalDb = IDBPDatabase<Schema>;
