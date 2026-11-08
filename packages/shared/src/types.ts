/** What the signed-in user may do with a note */
export type NoteAccess = 'owner' | 'write' | 'read';

/** A note as the server stores and syncs it. `path` is "Folder/Sub/Title.md" relative to the owner's space */
export interface SyncedNote {
  id: string;
  path: string;
  content: string;
  /** Server version, raised by every accepted change; 0 = never synced */
  version: number;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
  access: NoteAccess;
  /** Username of the owner (only set for notes shared with the user) */
  owner?: string;
}

export interface PullResponse {
  notes: SyncedNote[];
  /** Ids the user lost access to (share revoked) */
  revoked: string[];
  cursor: number;
}

export interface PushChange {
  id: string;
  /** Version the change was made on; 0 for new notes */
  baseVersion: number;
  path: string;
  content: string;
  deleted: boolean;
  createdAt: number;
  updatedAt: number;
}

export type PushResult =
  | { id: string; status: 'ok'; version: number }
  /** Someone changed the note in between: the client keeps `server` and saves its own text as a copy */
  | { id: string; status: 'conflict'; server: SyncedNote }
  | { id: string; status: 'forbidden' };

export interface PushResponse {
  results: PushResult[];
}

export interface Me {
  id: string;
  username: string;
  createdAt: number;
  passkeys: { id: string; name: string; createdAt: number; lastUsedAt: number | null }[];
}

export interface NoteShare {
  username: string;
  canWrite: boolean;
}

export interface NoteShares {
  users: NoteShare[];
  /** Public read-only link token, null if none */
  publicToken: string | null;
}

export interface PublicNote {
  path: string;
  content: string;
  owner: string;
  updatedAt: number;
}

export const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,20}$/;

/** Hidden system notes (folders, settings) live below this path and are synced like any note */
export const SYSTEM_PREFIX = '.kladde/';
export const FOLDERS_NOTE_PATH = '.kladde/folders.json';

/** Default folder structure (PARA + Zettelkasten) for new spaces */
export const DEFAULT_FOLDERS = ['0 Inbox', '1 Projekte', '2 Bereiche', '3 Ressourcen', '4 Archiv', 'Zettelkasten'];
export const INBOX_FOLDER = '0 Inbox';
export const ZETTEL_FOLDER = 'Zettelkasten';
