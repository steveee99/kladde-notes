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
  /** Id of the group that owns the note (#58); `owner` is then the group's name */
  group?: string;
  /** Release versioning (#53) is on for this note */
  versioning?: boolean;
  /** Releases of the note, newest first (metadata only; only while versioning is on) */
  releases?: NoteReleaseInfo[];
  /** Fingerprint (`contentHash`) of the latest release's text: the draft differs from it when the hashes differ */
  releaseHash?: string;
  /** Read-only readers get the latest release instead of the draft: its version (the content is that release) */
  showsRelease?: string;
  /**
   * Online mode: only the catalog entry came (path, version, access); `content` is empty until the device fetches
   * the note (`POST /api/sync/notes`)
   */
  partial?: boolean;
}

/** A released version of a note (#53); immutable once created */
export interface NoteReleaseInfo {
  /** Semantic version, e.g. "1.2.0" */
  version: string;
  releasedAt: number;
  /** Username of whoever released it */
  releasedBy: string;
  /** Optional changelog line */
  note: string;
}

export interface NoteRelease extends NoteReleaseInfo {
  path: string;
  content: string;
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
  /** All groups the user is a member of (always complete, not only changes) */
  groups?: GroupInfo[];
}

/** A member's role in a group (#58): owners manage the group, editors write, readers only read */
export type GroupRole = 'owner' | 'editor' | 'reader';

/** A group the signed-in user belongs to; its notes belong to the group and every member sees them */
export interface GroupInfo {
  id: string;
  name: string;
  /** The signed-in user's role */
  role: GroupRole;
  /** Features the group's owners switched on for every member */
  features?: GroupFeatures;
}

/** Features a group turns on for all its members, whatever their own settings say */
export interface GroupFeatures {
  /** Tickets and milestones in the group's project folders */
  tickets: boolean;
}

export interface GroupMember {
  username: string;
  avatarUrl?: string | null;
  role: GroupRole;
}

/** `GET /api/groups/:id`: a group with its members and what deleting it would remove */
export interface GroupDetails extends GroupInfo {
  createdAt: number;
  members: GroupMember[];
  /** Live notes of the group */
  notes: number;
  /** Attachments that belong to the group */
  attachments: number;
}

/** `POST /api/groups/:id/move`: own notes (or a whole folder) move into the group */
export interface GroupMoveRequest {
  /** Ids of own notes to move (a single note, or every note of a folder) */
  noteIds: string[];
  /** The folder being moved: its name is kept below `target`; without it the notes land directly in `target` */
  folder?: string;
  /** Folder inside the group ('' = top level) */
  target: string;
}

export interface GroupMoveResult {
  moved: { id: string; path: string }[];
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
  /** New note in a group (#58): the group's id; the note belongs to the group */
  group?: string;
  /** Online mode: the device does not hold the text (a move, rename or deletion); the server keeps its own */
  keepContent?: boolean;
  /** Deleted together with a folder: a random id shared by all notes of that deletion (restored as one unit) */
  trashBatch?: string;
  /** The folder that was deleted with this note (shown in the trash) */
  trashFolder?: string;
}

/**
 * Online mode: one task as a tuple, to keep `GET /api/online/tasks` small with many notes:
 * [line, status, text, due, repeat, time, doneDate, indent]; trailing nulls and the indentation "- " are left out
 */
export type OnlineTaskTuple = [number, 'open' | 'doing' | 'blocked' | 'done', string, (string | null)?, (string | null)?, (string | null)?, (string | null)?, string?];

/** Online mode: the tasks of one note, with its frontmatter title (the device knows the path from its catalog) */
export interface OnlineTaskNote {
  id: string;
  title?: string;
  tasks: OnlineTaskTuple[];
}

/** `GET /api/online/tasks?since=&sig=`: notes changed since the cursor, or all with tasks when `reset` */
export interface OnlineTasks {
  cursor: number;
  sig: string;
  reset: boolean;
  notes: OnlineTaskNote[];
}

/**
 * A node of the online graph: id, title, type (0 note, 1 PDF, 2 drawing; Zettel the device finds by the folder) and
 * the note's tags when it has any. Folder and dates come from the device's catalog.
 */
export type OnlineGraphNode = [id: string, title: string, kind: 0 | 1 | 2, tags?: string[]];

/**
 * `GET /api/online/graph?have=`: the graph of every note the user may see; `edges` are pairs of indexes into `nodes`
 * (source, target, source, target, …). `same` (without nodes and edges) when `have` names the stamp of an unchanged graph.
 */
export interface OnlineGraph {
  stamp: string;
  same?: boolean;
  nodes?: OnlineGraphNode[];
  edges?: number[];
}

/** A deleted note in its owner's trash (`GET /api/trash`); restorable until it is purged */
/** An export of the whole account as a ZIP archive (#93), made in the background and downloadable once */
export interface AccountExportStatus {
  id: string;
  state: 'running' | 'ready' | 'failed';
  createdAt: number;
  finishedAt: number | null;
  /** After this the archive is deleted, downloaded or not */
  expiresAt: number | null;
  /** Bytes of the archive */
  size: number;
  notes: number;
  files: number;
  /** The note history is included */
  history: boolean;
  error: string | null;
}

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
  /** Name of the group the note belongs to (#58), when it is not the user's own */
  group?: string;
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
  /**
   * `content` is set when the server changed the text on arrival (a ticket got its number, a status change the
   * project's transitions do not allow was undone: `rejectedStatus`, automations ran: `automations` (their names))
   */
  | { id: string; status: 'ok'; version: number; content?: string; rejectedStatus?: string; automations?: string[] }
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
  /** Accent color of the Werkbank design, chosen per account (`ACCENTS` in accent.ts; default 'blue') */
  accent?: string;
  /** True when running in single-user desktop/standalone mode (no auth, invites, sharing or admin area) */
  standalone?: boolean;
  /** Local data directory path shown in standalone diagnostics/settings */
  dataDir?: string;
  /** The server can transcribe voice notes (TRANSCRIBE_URL is set) */
  transcription?: boolean;
  /**
   * Online mode (`KLADDE_MODE=online`): devices keep only a catalog of the notes and load the text of a note when it
   * opens; nothing works without a connection
   */
  online?: boolean;
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
  /** Storage used and the quota that applies (#91) */
  storage: StorageUsage;
}

/** Warn when this share of the quota is used (#91) */
export const STORAGE_WARN_RATIO = 0.8;

/** What an account or group stores, in bytes (#91) */
export interface StorageUsage {
  notes: number;
  attachments: number;
  /** Version history and releases */
  history: number;
  trash: number;
  total: number;
  /** Quota in bytes that applies (own limit or the server default); null = unlimited */
  quota: number | null;
  /** The quota was set for this account/group by an admin (otherwise it is the default, if any) */
  customQuota: boolean;
}

/** The signed-in user's own usage and that of their groups (#91) */
export interface MyStorage {
  user: StorageUsage;
  groups: { id: string; name: string; storage: StorageUsage }[];
}

/** A group as the admin area lists its storage (#91) */
export interface AdminGroupStorage {
  id: string;
  name: string;
  members: number;
  storage: StorageUsage;
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

/** Why a backup was taken */
export type AdminBackupTrigger = 'manual' | 'scheduled' | 'pre-restore' | 'pre-migration' | 'unknown';

/** One backup in the admin area (#65) */
export interface AdminBackup {
  /** Folder or file name below the backup directory, e.g. `kladde-2026-11-18-12-00-00` */
  id: string;
  createdAt: number;
  /** Bytes of the database copy plus the attachments */
  size: number;
  /** `full`: database and the (encrypted) attachments and profile pictures; `database`: only a database copy (older backups, pre-migration copies, the CLI) */
  kind: 'full' | 'database';
  trigger: AdminBackupTrigger;
  /** Attachments and profile pictures in the backup */
  files: number;
  /** Kladde version that took it (full backups) */
  version: string | null;
  /** Only full backups whose schema this version knows can be restored */
  restorable: boolean;
}

export interface AdminBackupSchedule {
  /** A full backup once a day */
  enabled: boolean;
  /** How many daily backups are kept; manual ones stay until deleted */
  keep: number;
}

export interface AdminBackupOverview {
  backups: AdminBackup[];
  schedule: AdminBackupSchedule;
  /** Where the backups are stored on the server */
  dir: string;
  /** Whether a backup is being created right now */
  busy: boolean;
}

export interface AdminStatus {
  version: string;
  startedAt: number;
  users: number;
  notes: number;
  shares: number;
  connections: number;
}

/** A job the server ran: a device's sync (only those that sent changes) or a background job */
export type AdminJobKind = 'sync' | 'backup' | 'trash';

export interface AdminJob {
  kind: AdminJobKind;
  at: number;
  durationMs: number;
  ok: boolean;
  /** Account of a device sync */
  user?: string;
  /** Changes sent (sync), notes purged (trash) */
  count?: number;
  /** Changes the server did not take as sent (conflicts, refused) */
  rejected?: number;
  /** Short reason of a failed job */
  error?: string;
}

/** The admin dashboard: what the server holds, how it runs, who is online and what it did lately */
export interface AdminOverview {
  version: string;
  startedAt: number;
  /** Notes count once, however many people they are shared with */
  counts: { users: number; groups: number; notes: number; databases: number; shares: number; attachments: number; invites: number };
  online: { connections: number; users: { username: string; avatarUrl?: string | null; devices: number }[] };
  system: {
    platform: string;
    node: string;
    cpu: { cores: number; model: string; load: [number, number, number]; /** 0..1 of all cores since the last look */ system: number | null; /** 0..1 of one core */ process: number | null };
    memory: { total: number; free: number; rss: number; heap: number };
    /** The disk of the data directory; null when it cannot be read */
    disk: { total: number; free: number } | null;
    /** Bytes Kladde holds: the database file, notes, attachments, history, trash */
    storage: { database: number; notes: number; attachments: number; history: number; trash: number };
  };
  lastBackupAt: number | null;
  /** Newest first, kept in memory since the start */
  jobs: AdminJob[];
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
  /** Values of the variables (`{{var:name}}`) the note uses, resolved from its folders; nothing else of them is sent */
  variables?: Record<string, string>;
  /** Definition note of the note's custom type (`type: custom:<name>`), when it has one */
  noteType?: string;
  /** Notes the public note embeds (`![[…]]`) that the owner published too; others show "Not available" */
  embeds?: PublicEmbed[];
  /** Versioned note (#53): the content is its latest release; the releases fill the placeholders */
  versioning?: boolean;
  releases?: NoteReleaseInfo[];
  showsRelease?: string;
}

/** An embedded note on a public link */
export interface PublicEmbed {
  /** The link target as written in the embed, lower case */
  target: string;
  title: string;
  content: string;
  /** Values of the variables it uses */
  variables?: Record<string, string>;
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

/** How long a new Apple Shortcuts token may live, in days (the first is the default): it sits on a phone for long */
export const SHORTCUT_TOKEN_DAYS = [365, 90, 30, 7] as const;

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

/** Where merge request events come from */
export type TicketHookProvider = 'gitlab' | 'github';

/**
 * A webhook of a ticket project (`POST /api/hooks/<id>`): GitLab or GitHub report merge/pull requests, and the
 * project's automations react to them on the tickets named in the title, branch or description
 */
export interface TicketHook {
  id: string;
  provider: TicketHookProvider;
  name: string;
  /** User name of who created it; changes run as this person */
  createdBy: string;
  createdAt: number;
  /** Full address to enter at GitLab/GitHub */
  url: string;
  /** The last delivery: when, what happened and whether it worked */
  last: { at: number; ok: boolean; summary: string } | null;
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

/** A match inside the text of a PDF or image attachment (#37): the notes that embed it lead to it */
export interface AttachmentSearchHit {
  fileId: string;
  name: string;
  mime: string;
  url: string;
  /** 1-based page of a PDF; images have one page */
  page: number;
  snippet: string;
  /** True when the text came from OCR (scanned page or image) */
  ocr: boolean;
  notes: AttachmentNoteRef[];
}

export interface AttachmentSearchResponse {
  hits: AttachmentSearchHit[];
  /** Attachments still waiting for text extraction */
  pending: number;
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

// ---------------------------------------------------------------- activity feed (#70)

export type ActivityKind =
  | 'created'
  | 'edited'
  | 'moved'
  | 'deleted'
  | 'restored'
  | 'released'
  | 'member_added'
  | 'member_removed'
  | 'member_role'
  | 'folder_shared'
  | 'folder_unshared';

/** One entry of the activity of a group or a shared folder; edits of one person to one note are grouped per hour */
export interface ActivityEntry {
  id: string;
  kind: ActivityKind;
  /** When it happened (for grouped edits: the last one) */
  at: number;
  /** Grouped edits: how many saves */
  count: number;
  /** Who did it; null when the account is gone */
  actor: string | null;
  noteId: string | null;
  /** Path of the note (in a group: inside the group) */
  path?: string;
  previousPath?: string;
  /** `released`: the new version */
  version?: string;
  /** Membership and share changes: whom it concerns and their role */
  member?: string;
  role?: string;
  folder?: string;
}

export interface ActivityList {
  entries: ActivityEntry[];
}

/** Notes someone else changed since the user last opened them (marks in the folder tree) */
export interface ActivityNews {
  notes: { id: string; at: number; by: string | null }[];
}

// ---------------------------------------------------------------- notifications (#69, #68)

export type NotificationKind = 'mention' | 'comment' | 'reply';

/** Something that happened for the user: a mention in a note, a comment on their note or a reply in a thread */
export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  at: number;
  read: boolean;
  /** Who did it; null when the account is gone */
  actor: string | null;
  actorAvatar?: string | null;
  noteId: string;
  /** Path of the note as the user sees it (in a group: inside the group) */
  path: string;
  /** 0-based line of the passage */
  line?: number;
  /** The line or comment text */
  text: string;
  /** Comment thread (#68) */
  threadId?: string;
}

export interface NotificationList {
  items: NotificationItem[];
  unread: number;
}

/** Someone who can see a note: the people a mention can reach */
export interface NotePerson {
  username: string;
  avatarUrl?: string | null;
}
