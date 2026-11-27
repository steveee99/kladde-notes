import type { DatabaseSync } from 'node:sqlite';
import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';

export { PluginError, localize, pluginTablePrefix, type Localized, type PluginLang } from './index.js';

/** An account as plugins see it */
export interface PluginUser {
  id: string;
  username: string;
  displayName: string | null;
  isAdmin: boolean;
}

/** A note as plugins see it (always the full text) */
export interface PluginNote {
  id: string;
  /** Path inside its space (own notes or the group's notes) */
  path: string;
  content: string;
  /** Server version; pass it as `baseVersion` when changing the note */
  version: number;
  createdAt: number;
  updatedAt: number;
  /** `owner`: the user's own note; `write`/`read`: a group note (readers cannot change it) */
  access: 'owner' | 'write' | 'read';
  /** Id and name of the group that owns the note */
  group?: { id: string; name: string };
  /** Frontmatter `type` (plugin notes: `plugin:<id>:<kind>`) */
  type?: string;
}

/** Which notes `notes.list` returns */
export interface PluginNoteFilter {
  /** Exact frontmatter `type` */
  type?: string;
  /** Only notes in this folder or below (path inside the space) */
  folder?: string;
  /** Also the notes of the user's groups (default: only the own notes) */
  groups?: boolean;
}

/**
 * Notes of a user, read and written through Kladde's sync: every change is encrypted, gets the next sequence
 * number, reaches all devices and the activity feed, and passes the same rights checks as a change from the app.
 */
export interface PluginNotes {
  list(userId: string, filter?: PluginNoteFilter): PluginNote[];
  get(userId: string, id: string): PluginNote | null;
  /** New note; `group` (a group id) puts it into a group the user may write in. Throws `PluginError` 409 when the path is taken */
  create(userId: string, note: { path: string; content: string; group?: string }): PluginNote;
  /** Changes text and/or path; throws `PluginError` 409 when someone changed the note since `baseVersion` */
  update(userId: string, id: string, change: { baseVersion: number; content?: string; path?: string }): PluginNote;
  /** Moves the note to the trash */
  remove(userId: string, id: string): void;
}

/** Encryption with Kladde's data key; the record id (with the plugin id) is the associated data */
export interface PluginCipher {
  seal(recordId: string, value: string): Uint8Array;
  open(recordId: string, sealed: Uint8Array): string;
  sealJson(recordId: string, value: unknown): Uint8Array;
  openJson<T = unknown>(recordId: string, sealed: Uint8Array): T;
}

export interface PluginLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
}

/** What the host gives a server plugin */
export interface PluginServerContext {
  readonly id: string;
  /** Version of Kladde */
  readonly hostVersion: string;
  /** Version of `@kladde/plugin-api` the host provides */
  readonly apiVersion: string;
  /**
   * The shared SQLite database. Use only own tables (`table(name)`); never write Kladde's tables, never store
   * contents unencrypted (`cipher`). Statements are synchronous; wrap several writes in `transaction`.
   */
  readonly db: DatabaseSync;
  /** Full name of an own table: `table('entries')` → `p_<id>_entries` */
  table(name: string): string;
  /** Runs `fn` in one transaction */
  transaction<T>(fn: () => T): T;
  readonly cipher: PluginCipher;
  readonly notes: PluginNotes;
  user(id: string): PluginUser | null;
  /** The signed-in user of a request to the plugin's routes */
  userOf(req: Request): PluginUser;
  /** Whether the user switched the plugin on (Settings → Features) */
  enabledFor(userId: string): boolean;
  /** `env('TOKEN')` reads `PLUGIN_<ID>_TOKEN` (id upper case, dashes as underscores); other variables stay hidden */
  env(name: string): string | undefined;
  readonly log: PluginLog;
}

/** One schema step of a plugin; released steps never change (their checksum is checked at every start) */
export interface PluginMigration {
  /** 1, 2, 3, … ascending */
  version: number;
  description: string;
  /** SQL to run; checked strictly (any change to a released step stops the start) */
  sql?: string;
  /** Code to run instead of (or after) `sql`, e.g. to move data; its checksum covers version and description only */
  up?(db: DatabaseSync, ctx: PluginServerContext): void;
}

/** Work that runs every few minutes in the background (one run at a time) */
export interface PluginJob {
  name: string;
  everyMinutes: number;
  run(ctx: PluginServerContext): void | Promise<void>;
}

/** A file of the plugin in the user's account export (`_plugins/<id>/<name>`) */
export interface PluginExportFile {
  name: string;
  content: string | Uint8Array;
}

/** A note change as plugins see it */
export interface PluginNoteEvent {
  noteId: string;
  /** The user or group that owns the note */
  ownerId: string;
  /** Who made the change */
  actorId?: string;
  path: string;
  previousPath: string | null;
  content: string;
  deleted: boolean;
  /** Frontmatter `type` of the new text */
  type?: string;
}

export interface ServerPlugin {
  /** The same id as `kladde.id` in package.json */
  id: string;
  /** Own tables, created and changed in order; tables must start with `p_<id>_` */
  migrations?: PluginMigration[];
  /** Routes under `/api/p/<id>/…` for signed-in users who switched the plugin on */
  routes?(router: Router, ctx: PluginServerContext): void;
  /** Routes under `/api/p/<id>/public/…` without an account (webhooks); check secrets yourself */
  publicRoutes?(router: Router, ctx: PluginServerContext): void;
  /** Called after every accepted note change (errors are logged, never stop the sync) */
  onNoteChange?(event: PluginNoteEvent, ctx: PluginServerContext): void;
  jobs?: PluginJob[];
  /** Files for the user's account export */
  exportAccount?(userId: string, ctx: PluginServerContext): PluginExportFile[] | Promise<PluginExportFile[]>;
  /** Called once after the migrations, before the first request */
  start?(ctx: PluginServerContext): void;
}

/** Declares a server plugin (only types the object; the host does the rest) */
export function defineServerPlugin(plugin: ServerPlugin): ServerPlugin {
  return plugin;
}

/** Wraps an async route handler so rejected promises reach the host's error handling */
export function handle(fn: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res, next))
      .catch(next);
  };
}
