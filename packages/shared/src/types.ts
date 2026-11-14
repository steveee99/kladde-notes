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
  /** Avatar URL of the owner (only set when the owner has an avatar and the note is shared) */
  ownerAvatar?: string | null;
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
  ownerAvatar?: string | null;
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
  /** Deleted together with a folder: a random id shared by all notes of that deletion (restored as one unit) */
  trashBatch?: string;
  /** The folder that was deleted with this note (shown in the trash) */
  trashFolder?: string;
}

/** A deleted note in its owner's trash (`GET /api/trash`); restorable until it is purged */
export interface TrashEntry {
  id: string;
  path: string;
  deletedAt: number;
  /** Username of whoever deleted it when that was not the owner (a shared folder with delete permission) */
  deletedBy: string | null;
  /** Notes deleted together with a folder share this id */
  batch: string | null;
  /** The folder deleted with the note */
  folder: string | null;
  /** Size of the content in bytes */
  size: number;
}

export interface TrashList {
  entries: TrashEntry[];
  /** Days after which the server purges trashed notes (0: never) */
  retentionDays: number;
}

/** `POST /api/trash/:id/restore` answers 409 with this when the old path is taken again */
export interface TrashConflict {
  error: string;
  conflict: true;
  /** A free path next to the old one */
  suggestion: string;
}

export type PushResult =
  | { id: string; status: 'ok'; version: number }
  /** Someone changed the note in between: the client keeps `server` and saves its own text as a copy */
  | { id: string; status: 'conflict'; server: SyncedNote }
  | { id: string; status: 'forbidden' };

export interface PushResponse {
  results: PushResult[];
}

/** Sign-in options the server offers besides passkeys and passwords (`GET /api/auth/providers`) */
export interface AuthProviders {
  gitlab: {
    enabled: boolean;
    /** Button label, e.g. "GitLab" or the name of a self-hosted instance */
    label: string;
    /** New accounts without an invite are allowed */
    signup: boolean;
  };
  /** New accounts without an invite (SIGNUP_WITHOUT_INVITE) per sign-in method; otherwise an invite is needed */
  signup: { passkey: boolean; password: boolean };
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
  /** Sign-ins through other services linked to the account (e.g. GitLab) */
  externalLogins?: { provider: string; username: string; createdAt: number }[];
  /** URL of the user's profile picture, if uploaded */
  avatarUrl?: string | null;
  /** True when running in single-user desktop/standalone mode (no auth, invites, sharing or admin area) */
  standalone?: boolean;
  /** Local data directory path shown in standalone diagnostics/settings */
  dataDir?: string;
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
  avatarUrl?: string | null;
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
  avatarUrl?: string | null;
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
  ownerAvatar?: string | null;
  updatedAt: number;
  /** Notes the public note embeds (`![[…]]`) that the owner published too; others show "Not available" */
  embeds?: PublicEmbed[];
}

/** An embedded note on a public link */
export interface PublicEmbed {
  /** The link target as written in the embed, lower case */
  target: string;
  title: string;
  content: string;
  /** Its own public link */
  token: string;
}

export const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,20}$/;

/** Hidden system notes (folders, settings) live below this path and are synced like any note */
export const SYSTEM_PREFIX = '.kladde/';
export const FOLDERS_NOTE_PATH = '.kladde/folders.json';

/** Upper bound for one note; attachments go through the file store */
export const MAX_NOTE_BYTES = 2 * 1024 * 1024;
/** Upper bound for one attachment */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Default folder structure for new spaces (PARA and Zettelkasten are opt-in in settings) */
export const DEFAULT_FOLDERS = ['0 Inbox'];
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

/** A token for the import CLI (`npm run import`): may only list own note paths, upload attachments and create notes */
export interface ImportToken {
  id: string;
  name: string;
  createdAt: number;
  /** The token stops working after this */
  expiresAt: number;
  lastUsedAt: number | null;
}

/** How long a new import token may live, in days (the first is the default) */
export const IMPORT_TOKEN_DAYS = [30, 7, 90, 365] as const;

/** A new import token: the secret is shown exactly once */
export interface ImportTokenCreated {
  token: ImportToken;
  secret: string;
}

/** What a calendar feed contains */
export interface CalendarFeedOptions {
  /** Also list finished tasks (marked ✓) */
  includeDone: boolean;
  /** Only notes in this folder (and below); empty = all */
  folder: string;
  /** Only tasks whose note has this tag or that contain it as #tag; empty = all */
  tag: string;
  /** false shows every event as "Task" instead of the task text */
  showTitles: boolean;
  /** Language of the placeholder title */
  lang: 'de' | 'en';
}

/** A calendar feed (`/api/calendar/<token>.ics`) with the user's own tasks that have a due date */
export interface CalendarFeed {
  id: string;
  name: string;
  createdAt: number;
  /** The feed stops working after this */
  expiresAt: number;
  lastUsedAt: number | null;
  options: CalendarFeedOptions;
}

/** How long a new calendar feed may live, in days (the first is the default) */
export const CALENDAR_FEED_DAYS = [365, 30, 90] as const;

/** A new calendar feed: its secret address is shown exactly once */
export interface CalendarFeedCreated {
  feed: CalendarFeed;
  /** Path of the feed (`/api/calendar/<token>.ics`); the client puts its origin in front */
  path: string;
}

/** Reminder settings of one device (Settings → Notifications) */
export interface PushSettings {
  /** Daily digest ("3 tasks due today, 1 overdue") at this local time "HH:MM"; null = off */
  digestTime: string | null;
  /** No notifications from … to … (local "HH:MM", may wrap midnight); both null = off */
  quietStart: string | null;
  quietEnd: string | null;
  /** Put the task text into the notification (passes the push service, end-to-end encrypted) */
  showText: boolean;
  /** IANA time zone of the device, e.g. "Europe/Berlin" */
  timeZone: string;
  lang: 'de' | 'en';
}

/** A device that receives reminders */
export interface PushDevice {
  id: string;
  /** Short label from the browser, e.g. "Chrome · Android" */
  name: string;
  createdAt: number;
  lastSentAt: number | null;
  settings: PushSettings;
}

/** What a push message carries (encrypted for the device); no note text unless `showText` is on */
export interface PushPayload {
  title: string;
  body: string;
  /** Replaces an older notification with the same tag */
  tag: string;
  /** App path a click opens */
  url: string;
  /** For the "Done" / "Tomorrow" actions of a single task */
  task?: { noteId: string; line: number; check: string };
  /** Language of the action buttons */
  lang?: 'de' | 'en';
}

/** What the consent page shows before an AI assistant gets access */
export interface OAuthRequestInfo {
  clientName: string;
  redirectHost: string;
  wantsWrite: boolean;
}

/** A note referencing an attachment */
export interface AttachmentNoteRef {
  id: string;
  path: string;
  title: string;
}

/** Server-stored attachment metadata together with note references */
export interface AttachmentInfo {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: number;
  url: string;
  usedIn: AttachmentNoteRef[];
}

export interface DeleteFilesResponse {
  deleted: string[];
  skippedUsed: string[];
  notFound: string[];
}

/** Someone who has a note open right now (all their devices/tabs together) */
export interface PresenceViewer {
  userId: string;
  username: string;
  avatarUrl?: string | null;
  /** Open devices/tabs of this user on the note */
  clients: number;
}

/** Sent as the live event `presence` to everybody who may see the note, and returned when announcing */
export interface PresenceUpdate {
  noteId: string;
  viewers: PresenceViewer[];
  /** Last known cursor of every device/tab on the note that has sent one */
  cursors?: PresenceCursor[];
}

/** Where a device/tab's cursor is in a note */
export interface CursorPosition {
  /** Character offsets in the sender's text */
  head: number;
  anchor: number;
  /** Up to 24 characters right before `head`: finds the spot again when the receiver's text differs a little */
  ctx: string;
}

export interface PresenceCursor extends CursorPosition {
  clientId: string;
  userId: string;
}

/** Sent as the live event `cursor` when a device/tab moves its cursor */
export interface CursorUpdate {
  noteId: string;
  cursor: PresenceCursor;
}

/** A client reports its cursor in the note it has open */
export interface CursorAnnounce extends CursorPosition {
  clientId: string;
  noteId: string;
}

/** A client (device/tab) announces which note it has open; `noteId: null` = none */
export interface PresenceAnnounce {
  clientId: string;
  noteId: string | null;
}
