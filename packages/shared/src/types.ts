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
  /** A shared note the user may delete (folder share with delete permission) */
  canDelete?: boolean;
}

/** What a user may do in a folder shared with them (reading is always allowed) */
export interface FolderPermissions {
  canWrite: boolean;
  /** Create notes in the folder; they belong to the owner and live in the owner's space */
  canCreate: boolean;
  canDelete: boolean;
}

/** A folder another user shares with the signed-in user */
export interface SharedFolder extends FolderPermissions {
  owner: string;
  folder: string;
}

export interface PullResponse {
  notes: SyncedNote[];
  /** Ids the user lost access to (share revoked) */
  revoked: string[];
  cursor: number;
  /** All folders other users currently share with the user (always complete, not only changes) */
  sharedFolders?: SharedFolder[];
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
  /** New note in a folder another user shares with the caller: that user's name; the note belongs to them */
  owner?: string;
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
  /** Can also sign in with username and password (e.g. on a plain-HTTP home network, where passkeys do not work) */
  hasPassword: boolean;
  /** Sees the admin area (accounts, invites, password reset) */
  isAdmin: boolean;
}

export const PASSWORD_MIN_LENGTH = 8;

/** One account as the admin area lists it */
export interface AdminUser {
  id: string;
  username: string;
  createdAt: number;
  bannedAt: number | null;
  isAdmin: boolean;
  hasPassword: boolean;
  passkeys: number;
  notes: number;
  lastSeenAt: number | null;
}

export interface AdminInvite {
  code: string;
  note: string;
  createdAt: number;
  expiresAt: number;
  usedBy: string | null;
  usedAt: number | null;
}

export interface AdminAuditEntry {
  at: number;
  event: string;
  username: string | null;
  ip: string | null;
  detail: string | null;
}

export interface AdminStatus {
  version: string;
  startedAt: number;
  users: number;
  notes: number;
  shares: number;
  connections: number;
}

export interface NoteShare {
  username: string;
  canWrite: boolean;
  /** Set when the access comes from a shared folder (managed there, not on the note) */
  viaFolder?: string;
  /** Folder shares only: may create notes in the folder */
  canCreate?: boolean;
  /** Folder shares only: may delete notes in the folder */
  canDelete?: boolean;
}

export interface FolderShares {
  /** Users this folder is shared with (including its subfolders and notes added later) */
  users: NoteShare[];
  /** Users who see the folder because a parent folder is shared with them */
  inherited: NoteShare[];
}

/** One saved state of a note (its content is loaded per version) */
export interface NoteVersionInfo {
  id: string;
  /** When this state was last saved */
  savedAt: number;
  path: string;
  size: number;
}

export interface NoteVersion extends NoteVersionInfo {
  content: string;
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

/** An AI assistant with access to the user's notes over MCP (OAuth connection or personal token) */
export interface McpConnection {
  id: string;
  name: string;
  kind: 'oauth' | 'token';
  canWrite: boolean;
  createdAt: number;
  lastUsedAt: number | null;
}

/** A new personal token: the secret is shown exactly once */
export interface McpTokenCreated {
  connection: McpConnection;
  token: string;
}

/** What the consent page shows before an AI assistant gets access */
export interface OAuthRequestInfo {
  clientName: string;
  redirectHost: string;
  wantsWrite: boolean;
}

/** Git sync of a user's own notes to a remote repository (branch main); the access token is never sent back */
export interface GitSyncSettings {
  url: string;
  email: string;
  hasToken: boolean;
  /** Commit message; {date} (YYYY-MM-DD) and {time} (HH:MM) are replaced */
  message: string;
  enabled: boolean;
  lastRunAt: number | null;
  lastStatus: 'ok' | 'unchanged' | 'error' | null;
  lastError: string | null;
}

export const DEFAULT_GIT_MESSAGE = 'Kladde-Sync {date}';
