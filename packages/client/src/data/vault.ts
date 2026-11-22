import { useSyncExternalStore } from 'react';
import type { ActivityNews, NotePerson, NotificationItem, NotificationList } from '@kladde/shared';
import {
  HUMAN_ACTOR,
  actorId,
  addVerification,
  adoptedContent,
  applyMemoryFields,
  fromOkfBundle,
  isMemoryPath,
  isReservedMemoryNote,
  isoNow,
  memoryChangeKind,
  memoryUpkeep,
  setMemoryStatus,
  stampGenerated,
  toOkfBundle,
  zipStore,
  type BundleFile,
  type MemoryLogRequest,
  DEFAULT_DAILY_FOLDER,
  DEFAULT_MEMORY_FOLDER,
  DEFAULT_DAILY_FORMAT,
  DEFAULT_PARA_FOLDERS,
  DEFAULT_ZETTEL_FOLDER,
  FEATURES_SETTING,
  FOLDERS_NOTE_PATH,
  FeatureSettings,
  GroupInfo,
  GroupMoveResult,
  INBOX_FOLDER,
  PROJECT_HOME_NAME,
  PullResponse,
  PushChange,
  PushResponse,
  RoleFolderMap,
  DEFAULT_RECIPE_FOLDER,
  SharedFolder,
  LinkIndex,
  SYSTEM_PREFIX,
  SyncedNote,
  Template,
  ZettelType,
  archiveTarget,
  excerpt,
  fillTemplate,
  isFolderProjectHome,
  isSingleProjectFile,
  normalizeFeatures,
  normalizeTemplates,
  parseDate,
  parseFrontmatter,
  projectTitleOf,
  resolveDailyNote,
  resolvePeriodicNote,
  DEFAULT_WEEKLY_FOLDER,
  DEFAULT_WEEKLY_FORMAT,
  DEFAULT_MONTHLY_FOLDER,
  DEFAULT_MONTHLY_FORMAT,
  fillPeriodicTemplate,
  defaultPeriodicTemplate,
  WEEKLY_TEMPLATE_SETTING,
  MONTHLY_TEMPLATE_SETTING,
  type PeriodKind,
  templateUsesZettelId,
  TEMPLATES_SETTING,
  DAILY_TEMPLATE_SETTING,
  normalizeDailyTemplate,
  joinPath,
  linkFirstMention,
  renameWikiLinks,
  renameTag,
  notesByTag,
  restoreTarget,
  setFrontmatter,
  cleanIcon,
  dropFolderIcons,
  folderIconKey,
  FOLDER_ICONS_SETTING,
  ICON_KEY,
  normalizeFolderIcons,
  noteIconOf,
  renameFolderIcons,
  dailyDueResolver,
  toDateString,
  zettelId,
  normalizeDueWords,
  splitPath,
  toggleTask,
  setTaskStatus,
  type TaskStatus,
  takeTaskBlock,
  appendTaskLines,
  setTaskMeta,
  merge3,
  newTicketContent,
  parseProject,
  type Database,
  canWriteInGroup,
  type NoteReleaseInfo,
  type ReleaseBump,
  findDatabaseNote,
  isDatabasePath,
  newDatabaseNoteContent,
  parseDatabase,
  MILESTONE_FOLDER,
} from '@kladde/shared';
import { api, ApiError } from '../lib/api';
import { compareText, getLang, locale, t } from '../lib/i18n';
import { isReadOnly } from '../lib/readOnly';
import { clientId, presence } from '../lib/presence';
import { LocalDb, LocalNote, openLocalDb } from './db';
import { welcomeNotes } from './welcome';

/** Online mode: texts of opened notes kept on the device; older ones go back to catalog entries */
const MAX_CACHED = 300;
/** Notes fetched with their text per request */
const FETCH_BATCH = 500;

/** Window event with the server's version (from the live stream's `hello`), heard by `lib/update.ts` */
export const SERVER_VERSION_EVENT = 'kladde-server-version';

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error';

export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Synced setting with the ordered list of favorite note ids */
const FAVORITES_SETTING = 'favorites';
/** Synced setting with favorite group folders (#58): "<group id>/<folder>", the folder empty for the group itself */
const FAVORITE_GROUP_FOLDERS_SETTING = 'favoriteGroupFolders';

/**
 * The local copy of the user's space (offline first). Every edit lands in IndexedDB right away and is
 * pushed in the background; the server is asked for "everything after cursor N" on start, when coming
 * back online, on a live ping from another device and every minute.
 */
class Vault {
  notes = new Map<string, LocalNote>();
  state: SyncState = 'idle';
  message = '';
  lastSync: number | null = null;
  ready = false;
  /** Running against local standalone desktop server (always reachable even when navigator.onLine is false) */
  standalone = false;
  /**
   * Online mode (`KLADDE_MODE=online`, from /auth/me): the device holds a catalog of all notes (paths, versions,
   * access) and the text only of system notes and the notes it opened (`ensureFull`); set before `open`
   */
  online = false;
  /** Folders other users share with this user (from the last pull) */
  sharedFolders: SharedFolder[] = [];
  /** Groups the user is a member of (#58, from the last pull) */
  groups: GroupInfo[] = [];
  private userId = '';
  private db: LocalDb | null = null;
  private version = 0;
  private listeners = new Set<() => void>();
  private syncing: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private events: EventSource | null = null;
  onUnauthorized: () => void = () => {};
  onBeforeFlush: () => void = () => {};

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getVersion = () => this.version;

  /** Changes whenever a note's path, existence or access changed (caches of the folder tree key on it) */
  getPathStamp = () => this.pathStamp;

  /** The open local database and its account (the upload queue shares it) */
  localDb(): { db: LocalDb; userId: string } | null {
    return this.db && this.ready ? { db: this.db, userId: this.userId } : null;
  }

  /** Replaces a text in every note this user may edit (pending upload links once uploaded); returns how many notes had it */
  async replaceEverywhere(search: string, replacement: string): Promise<number> {
    let n = 0;
    for (const note of [...this.notes.values()]) {
      if (note.deleted || !note.content.includes(search)) continue;
      n++;
      if (note.access === 'read') continue;
      await this.put({ ...note, content: note.content.split(search).join(replacement), updatedAt: Date.now(), dirty: true });
    }
    if (n) this.schedule(250);
    return n;
  }

  /** True when some note (also one shared read-only) contains the text */
  mentions(search: string): boolean {
    for (const note of this.notes.values()) if (!note.deleted && note.content.includes(search)) return true;
    return false;
  }

  /** Re-renders the views after data that lives beside the notes changed (online mode: tasks from the server) */
  refreshViews(): void {
    this.emit();
  }

  private emit() {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  private opening: Promise<void> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;

  open(userId: string): Promise<void> {
    if (this.userId === userId && this.opening) return this.opening;
    this.close();
    this.userId = userId;
    this.opening = this.load(userId);
    return this.opening;
  }

  private async load(userId: string): Promise<void> {
    const db = await openLocalDb(userId, this.online);
    if (this.userId !== userId) return;
    this.db = db;
    for (const n of await this.db.getAll('notes')) this.notes.set(n.id, n);
    this.pathStamp++;
    this.sharedFolders = ((await this.db.get('meta', 'sharedFolders')) as SharedFolder[] | undefined) ?? [];
    this.groups = ((await this.db.get('meta', 'groups')) as GroupInfo[] | undefined) ?? [];
    this.ready = true;
    this.emit();
    window.addEventListener('online', this.kick);
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('beforeunload', this.onPageHide);
    document.addEventListener('visibilitychange', this.onVisible);
    this.interval = setInterval(() => document.visibilityState === 'visible' && this.kick(), 60_000);
    this.connectEvents();
    await this.sync();
  }

  close() {
    this.opening = null;
    this.userId = '';
    if (this.interval) clearInterval(this.interval);
    this.events?.close();
    this.events = null;
    presence.reset();
    this.notes.clear();
    this.pathStamp++;
    this.memCursor = null;
    this.fetching.clear();
    this.relinks = [];
    this.sharedFolders = [];
    this.groups = [];
    this.ready = false;
    this.db = null;
    this.emit();
    window.removeEventListener('online', this.kick);
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('beforeunload', this.onPageHide);
    document.removeEventListener('visibilitychange', this.onVisible);
  }

  private lastSyncStart = 0;
  /** Coming back to the app syncs (and hiding with unsaved edits flushes immediately) */
  private onVisible = () => {
    if (document.visibilityState === 'hidden') {
      if (this.standalone || this.pendingCount() > 0) this.flushKeepalive();
      return;
    }
    if (Date.now() - this.lastSyncStart > 15_000) this.kick();
  };
  private onPageHide = () => this.flushKeepalive();
  kick = () => void this.sync();

  /** Flushes dirty notes immediately with keepalive so closing the app window persists edits to SQLite */
  flushKeepalive() {
    try {
      this.onBeforeFlush();
    } catch {
      // ignore editor flush issues during unload
    }
    const changes = [...this.notes.values()].filter((n) => n.dirty).map(toChange);
    if (!changes.length) return;
    const body = JSON.stringify({ changes });
    // Fetch keepalive allows up to ~64 KiB; chunk larger payloads cleanly if needed
    if (body.length <= 60_000 && typeof fetch === 'function') {
      void fetch('/api/sync', {
        method: 'POST',
        keepalive: true,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body,
      }).catch(() => {});
    } else {
      void this.sync();
    }
  }

  private connectEvents() {
    if (typeof EventSource === 'undefined') return;
    this.events = new EventSource(`/api/events?client=${clientId}`);
    this.events.addEventListener('changed', this.kick);
    this.events.addEventListener('hello', presence.reconnected);
    // The server's version (lib/update.ts): a deploy restarts the server, the stream reconnects and the app updates at once
    this.events.addEventListener('hello', (e) => {
      try {
        const { version } = JSON.parse((e as MessageEvent<string>).data) as { version?: unknown };
        if (typeof version === 'string') window.dispatchEvent(new CustomEvent(SERVER_VERSION_EVENT, { detail: version }));
      } catch {
        // malformed event: ignore
      }
    });
    this.events.addEventListener('hello', () => void this.loadNotifications());
    this.events.addEventListener('notification', () => void this.loadNotifications());
    this.events.addEventListener('comments', (e) => {
      try {
        const { noteId } = JSON.parse((e as MessageEvent<string>).data) as { noteId: string };
        this.commentListeners.forEach((fn) => fn(noteId));
      } catch {
        // malformed event: ignore
      }
    });
    this.events.addEventListener('presence', (e) => {
      try {
        presence.receive(JSON.parse((e as MessageEvent<string>).data));
      } catch {
        // malformed event: ignore
      }
    });
    this.events.addEventListener('cursor', (e) => {
      try {
        presence.receiveCursor(JSON.parse((e as MessageEvent<string>).data));
      } catch {
        // malformed event: ignore
      }
    });
  }

  // ------------------------------------------------------------------ online mode

  /** Online mode: the sync cursor lives in memory (each start loads the catalog again) */
  private memCursor: number | null = null;
  private fetching = new Map<string, Promise<LocalNote | undefined>>();
  /** Online mode: renames whose links the server still has to rewrite (sent with the next sync) */
  private relinks: { noteId: string; oldName: string; newName: string }[] = [];

  /** True while only the note's catalog entry is on the device (online mode): its text loads when it opens */
  isPartial(id: string): boolean {
    return !!this.notes.get(id)?.partial;
  }

  /**
   * The note with its text: fetched from the server when the device has only its catalog entry, then kept (up to
   * MAX_CACHED notes). Rejects when the server cannot be reached.
   */
  ensureFull(id: string): Promise<LocalNote | undefined> {
    const note = this.notes.get(id);
    if (!note || !note.partial) return Promise.resolve(note);
    const running = this.fetching.get(id);
    if (running) return running;
    const p = this.fetchFull([id])
      .then(async () => {
        await this.evictCached();
        return this.notes.get(id);
      })
      .finally(() => this.fetching.delete(id));
    this.fetching.set(id, p);
    return p;
  }

  /**
   * The note for an edit of its text: loaded first in online mode (a table cell, a task on the task page, a status on
   * the board of a note that was never opened); undefined when it is gone or its text cannot be loaded
   */
  private async withText(id: string): Promise<LocalNote | undefined> {
    if (this.notes.get(id)?.partial) await this.ensureFull(id).catch(() => {});
    const note = this.get(id);
    return note?.partial ? undefined : note;
  }

  /** Starts loading a note's text in the background (embeds, previews) */
  prefetch(id: string): void {
    if (this.notes.get(id)?.partial) void this.ensureFull(id).catch(() => {});
  }

  /** Texts from the server, in batches; local edits made meanwhile (a move, a deletion) are kept */
  private async fetchFull(ids: string[], opts: { keep?: boolean } = {}): Promise<void> {
    for (let i = 0; i < ids.length; i += FETCH_BATCH) {
      const { notes } = await api<{ notes: SyncedNote[] }>('/sync/notes', { method: 'POST', json: { ids: ids.slice(i, i + FETCH_BATCH) } });
      const now = Date.now();
      const full: LocalNote[] = [];
      for (const server of notes) {
        const local = this.notes.get(server.id);
        if (!local || !local.partial) continue;
        if (local.dirty) {
          // Moved or deleted here before the text came: the text joins the pending change
          const { partial: _p, ...rest } = local;
          full.push({ ...rest, content: server.content, version: server.version, base: server.content, basePath: server.path, cachedAt: now });
        } else full.push(opts.keep ? { ...server, dirty: false } : { ...server, dirty: false, cachedAt: now });
      }
      await this.storeMany(full);
    }
  }

  /** Writes many notes to memory and IndexedDB in one transaction with one update (#64); catalog entries stay in memory */
  private async storeMany(list: LocalNote[], removed: string[] = []): Promise<void> {
    if (!list.length && !removed.length) return;
    for (const n of list) this.notes.set(n.id, n);
    this.pathStamp++;
    this.emit();
    if (!this.db) return;
    const tx = this.db.transaction('notes', 'readwrite');
    await Promise.all([...list.map((n) => (n.partial && !n.dirty ? tx.store.delete(n.id) : tx.store.put(n))), ...removed.map((id) => tx.store.delete(id)), tx.done]);
  }

  /** `pathStamp` of the last look at the database folders (online mode) */
  private databaseStamp = -1;

  /**
   * Online mode: tables and ticket projects need the frontmatter of every row, so the notes of database folders (the
   * database note, the notes directly in its folder and a project's milestones) are loaded in full and kept, not
   * counted among the MAX_CACHED opened notes. Looked at again when a path changed.
   */
  private async loadDatabaseFolders(): Promise<void> {
    const stamp = this.pathStamp;
    if (this.databaseStamp === stamp) return;
    const spaceOf = (n: LocalNote) => (n.group ? `g:${n.group}` : n.owner ? `u:${n.owner}` : '');
    const folders = new Set<string>();
    for (const n of this.notes.values()) if (!n.deleted && isDatabasePath(n.path)) folders.add(`${spaceOf(n)}|${splitPath(n.path).folder}`);
    if (!folders.size) {
      this.databaseStamp = stamp;
      return;
    }
    const ids: string[] = [];
    for (const n of this.notes.values()) {
      if (n.deleted) continue;
      const folder = splitPath(n.path).folder;
      const space = spaceOf(n);
      const inDatabase =
        folders.has(`${space}|${folder}`) ||
        (folder.endsWith(`/${MILESTONE_FOLDER}`) && folders.has(`${space}|${folder.slice(0, -MILESTONE_FOLDER.length - 1)}`));
      if (!inDatabase) continue;
      if (n.partial) ids.push(n.id);
      // Opened before: no longer one of the opened notes that make room for others
      else if (n.cachedAt) this.notes.set(n.id, { ...n, cachedAt: undefined });
    }
    // Set only once loaded: when the server cannot be reached, the next sync tries again
    if (ids.length) await this.fetchFull(ids, { keep: true });
    this.databaseStamp = stamp;
  }

  /** Keeps the texts of at most MAX_CACHED opened notes; the ones opened longest ago become catalog entries again */
  private async evictCached(): Promise<void> {
    const cached = [...this.notes.values()].filter((n) => n.cachedAt && !n.partial);
    if (cached.length <= MAX_CACHED) return;
    cached.sort((a, b) => (a.cachedAt ?? 0) - (b.cachedAt ?? 0));
    const slim = cached
      .slice(0, cached.length - MAX_CACHED)
      .filter((n) => !n.dirty && n.id !== this.viewing)
      .map(toCatalogEntry);
    await this.storeMany(slim);
  }

  /** Sends the renames whose links the server rewrites (online mode); kept for the next sync when that fails */
  private async sendRelinks(): Promise<void> {
    while (this.relinks.length) {
      await api('/sync/relink', { method: 'POST', json: this.relinks[0] });
      this.relinks.shift();
    }
  }

  // ------------------------------------------------------------------ queries

  /** Visible notes (no system notes, no deleted ones) */
  list(): LocalNote[] {
    // Kept until the next change: many views ask on every render (#64). Callers filter or copy before sorting
    if (this.listCache?.version !== this.version) this.listCache = { version: this.version, notes: [...this.notes.values()].filter((n) => !n.deleted && !n.path.startsWith(SYSTEM_PREFIX)) };
    return this.listCache.notes;
  }
  private listCache: { version: number; notes: LocalNote[] } | null = null;

  get(id: string): LocalNote | undefined {
    const n = this.notes.get(id);
    return n && !n.deleted ? n : undefined;
  }

  pendingCount(): number {
    let n = 0;
    for (const note of this.notes.values()) if (note.dirty) n++;
    return n;
  }

  private foldersNoteId() {
    return `sysfolders-${this.userId}`;
  }

  private foldersCache: { stamp: number; stored: string | undefined; lang: string; folders: string[] } | null = null;

  /** All folders of the own space, sorted; kept until the next change, since every view with a folder list asks (#64) */
  folders(): string[] {
    const lang = getLang();
    // Depends only on the paths and the stored folder list, not on texts: typing keeps it
    const stored = this.notes.get(this.foldersNoteId())?.content;
    const c = this.foldersCache;
    if (c && c.stamp === this.pathStamp && c.stored === stored && c.lang === lang) return c.folders;
    // Shared between callers: frozen, so nobody changes it by accident
    const folders = Object.freeze(this.computeFolders()) as string[];
    this.foldersCache = { stamp: this.pathStamp, stored, lang, folders };
    return folders;
  }

  private computeFolders(): string[] {
    const set = new Set<string>();
    const addWithParents = (folder: string) => {
      const parts = folder.split('/').filter(Boolean);
      for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('/'));
    };
    const note = this.notes.get(this.foldersNoteId());
    if (note) {
      try {
        for (const f of JSON.parse(note.content) as string[]) addWithParents(f);
      } catch {
        // broken system note: folders still come from the notes
      }
    }
    for (const n of this.list()) {
      if (n.access !== 'owner') continue;
      addWithParents(splitPath(n.path).folder);
    }
    return [...set].sort((a, b) => compareText(a, b));
  }

  private indexCache: { version: number; index: LinkIndex } | null = null;

  /**
   * Link index over all visible notes, rebuilt lazily after changes. Built from the previous index, so only changed
   * notes are parsed again, and a change that touches no title or link keeps the lookup tables (#64).
   */
  links(): LinkIndex {
    if (!this.indexCache || this.indexCache.version !== this.version) {
      // Online mode: only the notes whose text is here; links to the others resolve through the catalog (their names
      // and paths), backlinks and mentions come from the server (`onlineBacklinks`)
      const notes = this.online ? this.list().filter((n) => !n.partial) : this.list();
      const index = new LinkIndex(notes, this.roleConfig(), this.indexCache?.index);
      if (this.online) index.fallback = (link) => this.catalogResolve(link);
      this.indexCache = { version: this.version, index };
    }
    return this.indexCache.index;
  }

  /** Bumped when a note is added, removed, moved or renamed: the catalog lookup is built again only then */
  private pathStamp = 0;
  private catalogCache: { stamp: number; byName: Map<string, string>; byPath: Map<string, string> } | null = null;

  /** Online mode: a link by name or path to a note the device holds only as a catalog entry */
  private catalogResolve(link: string): string | null {
    if (this.catalogCache?.stamp !== this.pathStamp) {
      const byName = new Map<string, string>();
      const byPath = new Map<string, string>();
      for (const n of this.notes.values()) {
        if (n.deleted || n.path.startsWith(SYSTEM_PREFIX)) continue;
        const path = n.path.replace(/\.md$/i, '').toLowerCase();
        byPath.set(path, n.id);
        const name = path.slice(path.lastIndexOf('/') + 1);
        if (!byName.has(name)) byName.set(name, n.id);
      }
      this.catalogCache = { stamp: this.pathStamp, byName, byPath };
    }
    const key = link.trim().toLowerCase().replace(/^\.?\/+/, '').replace(/\.md$/, '');
    return this.catalogCache.byName.get(key) ?? this.catalogCache.byPath.get(key) ?? null;
  }

  findByTitle(title: string): LocalNote | undefined {
    const id = this.links().resolve(title);
    if (id) return this.get(id);
    const t = title.trim().toLowerCase();
    return this.list().find((n) => splitPath(n.path).name.toLowerCase() === t || n.path.toLowerCase() === `${t}.md`);
  }

  // ------------------------------------------------------------------ edits

  private async put(note: LocalNote) {
    const previous = this.notes.get(note.id);
    // Online mode: a catalog entry has no text, so a text computed from it would replace the real one. Code that
    // changes a text loads the note first (`ensureFull`); a path change or deletion goes out without the text
    if (note.partial && previous?.partial && note.content !== previous.content) note = { ...note, content: previous.content };
    if (!previous || previous.path !== note.path || previous.deleted !== note.deleted) this.pathStamp++;
    if (!note.dirty) {
      // Synced: the content itself is the base
      if (note.base !== undefined || note.basePath !== undefined) {
        const { base: _base, basePath: _basePath, ...rest } = note;
        note = rest;
      }
    } else if (note.base === undefined && note.version > 0) {
      // First local edit since the last sync: remember what it started from (for merging with others' edits)
      const before = this.notes.get(note.id);
      if (before && !before.dirty && before.version === note.version) note = { ...note, base: before.content, basePath: before.path };
    }
    this.notes.set(note.id, note);
    this.emit();
    if (note.partial && !note.dirty) await this.db?.delete('notes', note.id);
    else await this.db?.put('notes', note);
  }

  /** A free path for `title` in `folder` of one space (own notes, one other owner's space, or a group) */
  private uniquePath(folder: string, title: string, ignoreId?: string, space = 'own'): string {
    let candidate = joinPath(folder, title);
    const taken = (path: string) => [...this.notes.values()].some((n) => !n.deleted && n.id !== ignoreId && n.path === path && spaceOf(n) === space);
    for (let i = 2; taken(candidate); i++) {
      candidate = joinPath(folder, `${title} ${i}`);
    }
    return candidate;
  }

  /** A note the user creates; blocked in read-only mode */
  async create(folder: string, title: string, content = ''): Promise<LocalNote> {
    if (isReadOnly()) throw new Error(t('vault.readOnlyError'));
    // A new empty note in a database folder (#76) starts with the properties prefilled
    if (content === '' && folder) {
      const dbNote = findDatabaseNote(folder, this.list().filter((n) => n.access === 'owner' && !n.group));
      const db = dbNote && parseDatabase(dbNote.content);
      if (db && !isDatabasePath(`${folder}/${title}.md`)) content = this.newRowContent(dbNote.content, db, title, this.features().tickets.enabled);
    }
    return this.insert(folder, title, content);
  }

  /** Content of a new empty note in a database folder: a ticket in a project where tickets are on, else the database's properties */
  private newRowContent(dbContent: string, db: Database, title: string, ticketsOn: boolean): string {
    const project = ticketsOn ? parseProject(dbContent) : null;
    return project ? newTicketContent({ key: project.key, status: project.workflow[0] }) : newDatabaseNoteContent(db, title);
  }

  /** A note in a folder another user shares with this user: it belongs to them and lives in their space */
  async createShared(shared: SharedFolder, title: string, content = ''): Promise<LocalNote> {
    if (isReadOnly()) throw new Error(t('vault.readOnlyError'));
    if (!shared.canCreate) throw new Error(t('vault.sharedNoCreate'));
    const now = Date.now();
    const note: LocalNote = {
      id: newId(),
      path: this.uniquePath(shared.folder, title, undefined, `user:${shared.owner}`),
      content,
      version: 0,
      createdAt: now,
      updatedAt: now,
      deleted: false,
      access: 'write',
      owner: shared.owner,
      ...(shared.canDelete ? { canDelete: true } : {}),
      dirty: true,
    };
    await this.put(note);
    this.schedule();
    return note;
  }

  // ------------------------------------------------------------------ groups (#58)

  group(id: string | undefined): GroupInfo | undefined {
    return id ? this.groups.find((g) => g.id === id) : undefined;
  }

  /** Visible notes of a group */
  groupNotes(groupId: string): LocalNote[] {
    return this.list().filter((n) => n.group === groupId);
  }

  /** Folders of a group, from the paths of its notes (with their parents) */
  groupFolders(groupId: string): string[] {
    const set = new Set<string>();
    for (const n of this.groupNotes(groupId)) {
      const parts = splitPath(n.path).folder.split('/').filter(Boolean);
      for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('/'));
    }
    return [...set].sort((a, b) => compareText(a, b));
  }

  /** Groups the user may create notes in (and move notes into) */
  writableGroups(): GroupInfo[] {
    return this.groups.filter((g) => canWriteInGroup(g.role));
  }

  /** A group note the user may rename, move and delete (owners and editors of the group) */
  managesGroupNote(note: LocalNote): boolean {
    return !!note.group && note.access === 'write' && canWriteInGroup(this.group(note.group)?.role);
  }

  /** A new note in a group: it belongs to the group, every member sees it */
  async createInGroup(groupId: string, folder: string, title: string, content = ''): Promise<LocalNote> {
    if (isReadOnly()) throw new Error(t('vault.readOnlyError'));
    const group = this.group(groupId);
    if (!group || !canWriteInGroup(group.role)) throw new Error(t('groups.noWrite'));
    // A new empty note in a group database or project starts with its properties too
    if (content === '' && folder && !isDatabasePath(`${folder}/${title}.md`)) {
      const dbNote = findDatabaseNote(folder, this.groupNotes(groupId));
      const db = dbNote && parseDatabase(dbNote.content);
      if (db) content = this.newRowContent(dbNote.content, db, title, !!group.features?.tickets);
    }
    const now = Date.now();
    const note: LocalNote = {
      id: newId(),
      path: this.uniquePath(folder, title, undefined, `group:${group.id}`),
      content,
      version: 0,
      createdAt: now,
      updatedAt: now,
      deleted: false,
      access: 'write',
      owner: group.name,
      group: group.id,
      canDelete: true,
      dirty: true,
    };
    await this.put(note);
    this.schedule();
    return note;
  }

  /**
   * Copies a note next to itself as "<name> (Copy)" (localized). Works for own notes, group notes the user may
   * write and notes in a shared folder that allows new notes; a frontmatter `id` is left out so links keep
   * resolving to the original.
   */
  async duplicate(id: string): Promise<LocalNote> {
    if (isReadOnly()) throw new Error(t('vault.readOnlyError'));
    // Online mode: copied with its text
    const note = await this.ensureFull(id);
    if (!note || note.deleted) throw new Error(t('vault.duplicateMissing'));
    const { folder, name } = splitPath(note.path);
    const title = t('note.copyName', { name });
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(note.content)?.[1];
    const content = frontmatter && /^id:/im.test(frontmatter) ? setFrontmatter(note.content, { id: null }) : note.content;
    if (note.group) return this.createInGroup(note.group, folder, title, content);
    if (note.access === 'owner') return this.insert(folder, title, content);
    const shared = this.sharedFolderOf(note);
    if (!shared) throw new Error(t('vault.sharedNoCreate'));
    return this.createShared(shared, title, content);
  }

  /**
   * Moves own notes into a group (online only): a single note lands in `target`, a whole `folder` keeps its name
   * and structure below it. Shares of the notes end; links between them keep working.
   */
  async moveToGroup(groupId: string, noteIds: string[], target: string, folder?: string): Promise<GroupMoveResult> {
    if (isReadOnly()) throw new Error(t('vault.readOnlyError'));
    await this.sync();
    if (noteIds.some((id) => this.notes.get(id)?.dirty)) throw new Error(t('groups.moveNotSynced'));
    const result = await api<GroupMoveResult>(`/groups/${encodeURIComponent(groupId)}/move`, { method: 'POST', json: { noteIds, target, ...(folder ? { folder } : {}) } });
    if (folder) {
      await this.setFolders(this.storedFolders().filter((f) => f !== folder && !f.startsWith(`${folder}/`)));
      // Folder shares of the moved folder end with it
      void api('/folders/deleted', { method: 'POST', json: { folder } }).catch(() => {});
    }
    await this.sync();
    return result;
  }

  /** Own notes inside `folder` and its subfolders (what moving the folder into a group takes along) */
  notesOfFolder(folder: string): LocalNote[] {
    return this.notesBelow(folder);
  }

  /** The shared folder (of its owner) a shared note lies in, the innermost one first */
  sharedFolderOf(note: LocalNote): SharedFolder | undefined {
    if (note.access === 'owner') return undefined;
    return this.sharedFolders
      .filter((f) => f.owner === note.owner && note.path.startsWith(`${f.folder}/`))
      .sort((a, b) => b.folder.length - a.folder.length)[0];
  }

  /** Also used by sync (conflict copies) and the first start, which read-only mode must not stop */
  private async insert(folder: string, title: string, content: string): Promise<LocalNote> {
    const now = Date.now();
    const note: LocalNote = {
      id: newId(),
      path: this.uniquePath(folder, title),
      content,
      version: 0,
      createdAt: now,
      updatedAt: now,
      deleted: false,
      access: 'owner',
      dirty: true,
    };
    await this.put(note);
    this.schedule();
    return note;
  }

  async update(id: string, patch: { content?: string; folder?: string; title?: string }): Promise<void> {
    const note = this.notes.get(id);
    if (!note || note.access === 'read' || isReadOnly()) return;
    let path = note.path;
    if ((note.access === 'owner' || this.managesGroupNote(note)) && (patch.folder !== undefined || patch.title !== undefined)) {
      const cur = splitPath(note.path);
      path = this.uniquePath(patch.folder ?? cur.folder, patch.title ?? cur.name, id, spaceOf(note));
    }
    const content = patch.content !== undefined ? normalizeDueWords(patch.content) : note.content;
    if (content === note.content && path === note.path) return;
    await this.put({ ...note, content, path, updatedAt: Date.now(), dirty: true });
    const oldName = splitPath(note.path).name;
    const newName = splitPath(path).name;
    if (oldName !== newName) await this.relink(id, oldName, newName);
    // Someone else has the note open: hand the edit over right away
    this.schedule(presence.isLive(id) ? 250 : 1200);
  }

  /** After a rename every [[Old Title]] in notes the user may edit points to the new title */
  private async relink(renamedId: string, oldName: string, newName: string) {
    if (this.online) {
      // The server holds the texts: it rewrites the links, the changed notes come back with the next pull
      this.relinks.push({ noteId: renamedId, oldName, newName });
      return;
    }
    for (const n of [...this.notes.values()]) {
      if (n.deleted || n.id === renamedId || n.access === 'read' || !n.content.includes('[[')) continue;
      const content = renameWikiLinks(n.content, oldName, newName);
      if (content !== n.content) await this.put({ ...n, content, updatedAt: Date.now(), dirty: true });
    }
  }

  private tagCache: { version: number; tags: { tag: string; count: number }[] } | null = null;

  /** All tags of the visible notes with their note counts, most used first (tag autocomplete) */
  tagCounts(): { tag: string; count: number }[] {
    if (!this.tagCache || this.tagCache.version !== this.version) {
      const tags = [...notesByTag(this.list())].map(([tag, ids]) => ({ tag, count: ids.length }));
      tags.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
      this.tagCache = { version: this.version, tags };
    }
    return this.tagCache.tags;
  }

  /** Own notes (no system notes, nothing shared by others): the scope of the tag overview */
  ownNotes(): LocalNote[] {
    return this.list().filter((n) => n.access === 'owner');
  }

  /**
   * Renames a tag (and the tags nested below it) in all own notes; onto an existing tag this merges them.
   * Like `relink`, every changed note is a normal synced edit. Returns the number of changed notes.
   */
  /** New contents for many notes at once: one IndexedDB transaction and one emit (#64); returns how many changed */
  async updateContents(changes: { id: string; content: string }[]): Promise<number> {
    if (isReadOnly()) return 0;
    const now = Date.now();
    const written: LocalNote[] = [];
    for (const c of changes) {
      const before = this.notes.get(c.id);
      // Online mode: a catalog entry's text is not here, so a new text for it was computed from nothing
      if (!before || before.deleted || before.partial || before.access === 'read' || before.content === c.content) continue;
      let note: LocalNote = { ...before, content: c.content, updatedAt: now, dirty: true };
      if (note.base === undefined && note.version > 0 && !before.dirty) note = { ...note, base: before.content, basePath: before.path };
      this.notes.set(note.id, note);
      written.push(note);
    }
    if (!written.length) return 0;
    this.emit();
    if (this.db) {
      const tx = this.db.transaction('notes', 'readwrite');
      await Promise.all([...written.map((n) => tx.store.put(n)), tx.done]);
    }
    this.schedule();
    return written.length;
  }

  async renameTag(from: string, to: string): Promise<number> {
    if (isReadOnly()) return 0;
    let changed = 0;
    for (const n of this.ownNotes()) {
      const content = renameTag(n.content, from, to);
      if (content === n.content) continue;
      await this.put({ ...n, content, updatedAt: Date.now(), dirty: true });
      changed++;
    }
    if (changed) this.schedule();
    return changed;
  }

  /** Replaces the first plain mention of the target's title in `noteId` with a link */
  async linkMention(noteId: string, targetId: string) {
    const note = await this.withText(noteId);
    const target = this.get(targetId);
    if (!note || !target) return;
    const full = this.links().notes.get(targetId)?.title ?? splitPath(target.path).name;
    for (const name of this.links().mentionNames(targetId)) {
      const content = linkFirstMention(note.content, name, full);
      if (content !== note.content) return this.update(noteId, { content });
    }
  }

  // ------------------------------------------------------------------ Daily Notes, PARA, Zettelkasten & Features

  private featuresCache: { version: number; features: FeatureSettings } | null = null;

  /** The feature settings; kept until the next change, since many views ask on every render (#64) */
  features(): FeatureSettings {
    if (this.featuresCache?.version !== this.version) this.featuresCache = { version: this.version, features: normalizeFeatures(this.setting(FEATURES_SETTING), this.folders()) };
    return this.featuresCache.features;
  }

  roleConfig(): RoleFolderMap {
    const f = this.features();
    return {
      inbox: INBOX_FOLDER,
      projects: f.para.enabled ? f.para.folders.projects : null,
      areas: f.para.enabled ? f.para.folders.areas : null,
      resources: f.para.enabled ? f.para.folders.resources : null,
      archive: f.para.enabled ? f.para.folders.archive : null,
      zettel: f.zettel.enabled ? f.zettel.folder : null,
    };
  }

  /** Due date of tasks without their own date: tasks in a daily note belong to its day */
  taskDueResolver(): (path: string) => string | null {
    return dailyDueResolver(this.features().daily);
  }

  findDailyNote(date: Date | string = new Date()): LocalNote | undefined {
    const { daily } = this.features();
    if (!daily.enabled) return undefined;
    const dateObj = typeof date === 'string' ? parseDate(date) : date;
    const resolved = resolveDailyNote(daily, dateObj, getLang());
    const target = resolved.path.toLowerCase();
    return this.list().find((n) => n.access === 'owner' && n.path.toLowerCase() === target);
  }

  async openDailyNote(date: Date | string = new Date()): Promise<LocalNote> {
    const { daily } = this.features();
    const dateObj = typeof date === 'string' ? parseDate(date) : date;
    const resolved = resolveDailyNote(daily, dateObj, getLang());
    const target = resolved.path.toLowerCase();
    const existing = this.list().find((n) => n.access === 'owner' && n.path.toLowerCase() === target);
    if (existing) return existing;
    if (isReadOnly()) throw new Error(t('vault.readOnlyError'));
    // The title already shows the date, so the daily template starts without a heading
    return this.insert(resolved.folder, resolved.name, fillTemplate(this.dailyTemplate(), { title: resolved.name, date: toDateString(dateObj) }));
  }

  /** Settings of weekly or monthly notes (#73) */
  periodSettings(kind: PeriodKind) {
    const f = this.features();
    return kind === 'week' ? f.weekly : f.monthly;
  }

  /** The weekly or monthly note of the period containing `date`, if it exists */
  findPeriodicNote(kind: PeriodKind, date: Date | string = new Date()): LocalNote | undefined {
    const settings = this.periodSettings(kind);
    if (!settings.enabled) return undefined;
    const target = resolvePeriodicNote(kind, settings, date, getLang()).path.toLowerCase();
    return this.list().find((n) => n.access === 'owner' && n.path.toLowerCase() === target);
  }

  /** Opens the weekly or monthly note of the period containing `date`, creating it from its template */
  async openPeriodicNote(kind: PeriodKind, date: Date | string = new Date()): Promise<LocalNote> {
    const existing = this.findPeriodicNote(kind, date);
    if (existing) return existing;
    if (isReadOnly()) throw new Error(t('vault.readOnlyError'));
    const lang = getLang();
    const settings = this.periodSettings(kind);
    const resolved = resolvePeriodicNote(kind, settings, date, lang);
    const { daily, weekly } = this.features();
    const content = fillPeriodicTemplate(kind, this.periodicTemplate(kind), date, {
      title: resolved.name,
      lang,
      // Links to the day's and week's notes, also those not written yet (they open as new notes)
      dayName: daily.enabled ? (d) => resolveDailyNote(daily, parseDate(d), lang).name : undefined,
      weekName: weekly.enabled ? (w) => resolvePeriodicNote('week', weekly, w, lang).name : undefined,
    });
    if (settings.folder && !this.storedFolders().includes(settings.folder)) await this.setFolders([...this.storedFolders(), settings.folder]);
    return this.insert(resolved.folder, resolved.name, content);
  }

  periodicTemplate(kind: PeriodKind): string {
    const stored = this.setting(kind === 'week' ? WEEKLY_TEMPLATE_SETTING : MONTHLY_TEMPLATE_SETTING);
    return typeof stored === 'string' ? stored : defaultPeriodicTemplate(kind, getLang());
  }

  async savePeriodicTemplate(kind: PeriodKind, content: string): Promise<void> {
    await this.setSetting(kind === 'week' ? WEEKLY_TEMPLATE_SETTING : MONTHLY_TEMPLATE_SETTING, content);
  }

  async updateFeatures(next: FeatureSettings): Promise<FeatureSettings> {
    if (isReadOnly()) throw new Error(t('vault.readOnlyError'));
    const prev = this.features();
    const clean = normalizeFeatures(next, this.folders());
    await this.setSetting(FEATURES_SETTING, clean);
    const needed: string[] = [];
    if (clean.para.enabled) {
      needed.push(clean.para.folders.projects, clean.para.folders.areas, clean.para.folders.resources, clean.para.folders.archive);
    }
    if (clean.zettel.enabled) needed.push(clean.zettel.folder);
    if (clean.recipe.enabled) needed.push(clean.recipe.folder);
    if (clean.daily.enabled && clean.daily.folder && (!prev.daily.enabled || clean.daily.folder !== prev.daily.folder)) {
      needed.push(clean.daily.folder);
    }
    const existing = new Set(this.storedFolders());
    const missing = needed.map((f) => cleanFolder(f)).filter((f) => f && !existing.has(f));
    if (missing.length) await this.setFolders([...this.storedFolders(), ...missing]);
    return clean;
  }

  async setFrontmatter(id: string, updates: Record<string, string | null>) {
    const note = await this.withText(id);
    if (note) await this.update(id, { content: setFrontmatter(note.content, updates) });
  }

  /** Converts a single-file project (`<projects>/<Name>.md`) into a folder project (`<projects>/<Name>/Home.md`) */
  async convertProjectToFolder(id: string): Promise<boolean> {
    const note = this.get(id);
    const rc = this.roleConfig();
    if (!note || note.access !== 'owner' || isReadOnly() || !rc.projects) return false;
    if (!isSingleProjectFile(note.path, rc)) return false;
    const { folder, name } = splitPath(note.path);
    let targetFolder = `${folder}/${name}`;
    for (
      let i = 2;
      [...this.notes.values()].some(
        (n) => !n.deleted && n.id !== id && n.path.toLowerCase() === `${targetFolder}/${PROJECT_HOME_NAME}.md`.toLowerCase()
      );
      i++
    ) {
      targetFolder = `${folder}/${name} ${i}`;
    }
    const targetPath = this.uniquePath(targetFolder, PROJECT_HOME_NAME, id);
    await this.put({ ...note, path: targetPath, updatedAt: Date.now(), dirty: true });
    const existingFolders = new Set(this.storedFolders());
    if (!existingFolders.has(targetFolder)) await this.setFolders([...existingFolders, targetFolder]);
    const leaf = targetFolder.split('/').pop()!;
    if (leaf !== name) await this.relink(id, name, leaf);
    this.schedule();
    return true;
  }

  /** Renames a project note; for folder projects (`Home.md`), renames its folder so the project name and subnotes stay together */
  async renameProject(id: string, nextTitle: string): Promise<void> {
    const note = this.get(id);
    const rc = this.roleConfig();
    if (!note || note.access !== 'owner' || isReadOnly()) return;
    const cleanLeaf = nextTitle.trim().replace(/[\\/]/g, '-');
    if (!cleanLeaf) return;
    if (!isFolderProjectHome(note.path, rc)) {
      await this.update(id, { title: cleanLeaf });
      return;
    }
    const { folder } = splitPath(note.path);
    const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';
    const oldTitle = projectTitleOf(note.path, note.content, rc);
    const desiredBase = parent ? `${parent}/${cleanLeaf}` : cleanLeaf;
    let targetFolder = desiredBase;
    if (targetFolder !== folder) {
      for (let i = 2; this.notesBelow(targetFolder).length > 0; i++) {
        targetFolder = `${desiredBase} ${i}`;
      }
      await this.renameFolder(folder, targetFolder);
    }
    const finalLeaf = targetFolder.split('/').pop()!;
    const updatedNote = this.get(id);
    if (updatedNote && parseFrontmatter(updatedNote.content).data.title !== undefined) {
      await this.update(id, { content: setFrontmatter(updatedNote.content, { title: finalLeaf }) });
    }
    if (oldTitle.toLowerCase() !== finalLeaf.toLowerCase()) {
      await this.relink(id, oldTitle, finalLeaf);
    }
    this.schedule();
  }

  /** Completes a project and moves it to the archive (including subnotes for folder projects) */
  async archiveProject(id: string) {
    const note = this.get(id);
    const { para } = this.features();
    const rc = this.roleConfig();
    if (!note || note.access !== 'owner' || !para.enabled) return;
    if (isFolderProjectHome(note.path, rc)) {
      await this.setFrontmatter(id, { status: 'fertig', abgeschlossen: toDateString(new Date()) });
      await this.archiveFolder(splitPath(note.path).folder);
      return;
    }
    await this.archiveNote(id, true);
  }

  /** Moves a note to "<archive>/<folder>"; a project is marked as done on the way */
  async archiveNote(id: string, complete = false) {
    const note = this.get(id);
    const { para } = this.features();
    if (!note || note.access !== 'owner' || !para.enabled) return;
    const archive = para.folders.archive;
    if (complete) await this.setFrontmatter(id, { status: 'fertig', abgeschlossen: toDateString(new Date()) });
    const { folder } = splitPath(note.path);
    if (!restoreTarget(folder, archive) && folder !== archive) {
      await this.update(id, { folder: archiveTarget(folder, archive) });
    }
  }

  async restoreNote(id: string) {
    const note = this.get(id);
    const { para } = this.features();
    if (!note || !para.enabled) return;
    const { folder, name } = splitPath(note.path);
    const target = restoreTarget(folder, para.folders.archive);
    if (target === null) return;
    if (/^status:\s*fertig/m.test(note.content)) await this.setFrontmatter(id, { status: 'aktiv', abgeschlossen: null });
    if (isFolderProjectHome(joinPath(target, name), this.roleConfig())) {
      await this.restoreFolder(folder);
      return;
    }
    await this.update(id, { folder: target });
  }

  async archiveFolder(folder: string) {
    const { para } = this.features();
    if (!para.enabled) return;
    const archive = para.folders.archive;
    if (!restoreTarget(folder, archive) && folder !== archive) {
      await this.renameFolder(folder, archiveTarget(folder, archive));
    }
  }

  async restoreFolder(folder: string) {
    const { para } = this.features();
    if (!para.enabled) return;
    const target = restoreTarget(folder, para.folders.archive);
    if (target) await this.renameFolder(folder, target);
  }

  /** Inbox item becomes a fleeting Zettel: id in front of the title and in the frontmatter */
  async toZettel(id: string) {
    const note = await this.withText(id);
    const { zettel } = this.features();
    if (!note || !zettel.enabled) return;
    const zid = zettelId(new Date(note.createdAt));
    const { name } = splitPath(note.path);
    await this.update(id, {
      content: setFrontmatter(note.content, { id: zid, typ: 'flüchtig' }),
      folder: zettel.folder,
      title: /^\d{12}/.test(name) ? name : `${zid} ${name}`,
    });
  }

  async createZettel(title: string, type: ZettelType, source: string): Promise<LocalNote> {
    const { zettel } = this.features();
    const zid = zettelId();
    const fm = setFrontmatter('', { id: zid, typ: type, ...(type === 'literatur' ? { quelle: source } : {}) });
    const body = type === 'literatur' ? `# ${title}\n\n> ${t('vault.sourceLabel')}: ${source}\n\n## ${t('vault.inOwnWords')}\n\n` : `# ${title}\n\n`;
    return this.create(zettel.folder, `${zid} ${title}`.trim(), fm + body);
  }

  /** A note from a template (or a blank one); with `shared` it goes into that shared folder, with `group` into `folder` of that group */
  async createFromTemplate(template: Template | null, title: string, folder: string, shared?: SharedFolder, group?: string): Promise<LocalNote> {
    const make = (name: string, content: string) =>
      group ? this.createInGroup(group, folder, name, content) : shared ? this.createShared(shared, name, content) : this.create(folder, name, content);
    if (!template) return make(title, '');
    const zid = zettelId();
    const content = fillTemplate(template.content, { title, zid });
    return make(templateUsesZettelId(template.content) ? `${zid} ${title}` : title, content);
  }

  /** Own templates, kept in the synced settings (none at first) */
  templates(): Template[] {
    return normalizeTemplates(this.setting(TEMPLATES_SETTING));
  }

  async saveTemplate(template: Template): Promise<void> {
    const list = this.templates();
    const i = list.findIndex((t) => t.id === template.id);
    if (i >= 0) list[i] = template;
    else list.push(template);
    await this.setSetting(TEMPLATES_SETTING, list);
  }

  /** Content for new daily notes (synced setting, shown as a fixed entry under templates) */
  dailyTemplate(): string {
    return normalizeDailyTemplate(this.setting(DAILY_TEMPLATE_SETTING));
  }

  async saveDailyTemplate(content: string): Promise<void> {
    await this.setSetting(DAILY_TEMPLATE_SETTING, content);
  }

  async removeTemplate(id: string): Promise<void> {
    await this.setSetting(TEMPLATES_SETTING, this.templates().filter((t) => t.id !== id));
  }

  // ------------------------------------------------------------------ favorites (synced setting)

  /** Favorite note ids in the user's order; ids of deleted or unknown notes are skipped */
  favoriteIds(): string[] {
    const raw = this.setting<unknown>(FAVORITES_SETTING);
    if (!Array.isArray(raw)) return [];
    return raw.filter((id): id is string => typeof id === 'string' && !!this.get(id));
  }

  isFavorite(id: string): boolean {
    return this.favoriteIds().includes(id);
  }

  /** Adds or removes a note from the favorites; returns whether it is a favorite afterwards */
  async toggleFavorite(id: string): Promise<boolean> {
    if (isReadOnly()) throw new Error(t('vault.readOnlyError'));
    const list = this.favoriteIds();
    const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
    await this.setSetting(FAVORITES_SETTING, next);
    return next.includes(id);
  }

  /** Favorite group folders (#58) in the user's order; groups the user left and folders without notes are skipped */
  favoriteGroupFolders(): { group: GroupInfo; folder: string }[] {
    const raw = this.setting<unknown>(FAVORITE_GROUP_FOLDERS_SETTING);
    if (!Array.isArray(raw)) return [];
    const out: { group: GroupInfo; folder: string }[] = [];
    for (const key of raw) {
      if (typeof key !== 'string') continue;
      const i = key.indexOf('/');
      const group = this.group(i < 0 ? key : key.slice(0, i));
      const folder = i < 0 ? '' : key.slice(i + 1);
      if (group && (!folder || this.groupFolders(group.id).includes(folder))) out.push({ group, folder });
    }
    return out;
  }

  isFavoriteGroupFolder(groupId: string, folder: string): boolean {
    return this.favoriteGroupFolders().some((f) => f.group.id === groupId && f.folder === folder);
  }

  /** Adds or removes a group folder (or the group itself, `folder` empty) from the favorites */
  async toggleFavoriteGroupFolder(groupId: string, folder: string): Promise<boolean> {
    if (isReadOnly()) throw new Error(t('vault.readOnlyError'));
    const key = `${groupId}/${folder}`;
    const list = this.favoriteGroupFolders().map((f) => `${f.group.id}/${f.folder}`);
    const next = list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
    await this.setSetting(FAVORITE_GROUP_FOLDERS_SETTING, next);
    return next.includes(key);
  }

  // ------------------------------------------------------------------ icons (opt-in feature)

  private iconCache: { version: number; icons: Record<string, string> } | null = null;

  /** Folder icons from the synced settings: folder path (group folders `g:<group id>/<folder>`) → emoji */
  folderIcons(): Record<string, string> {
    if (!this.iconCache || this.iconCache.version !== this.version) {
      this.iconCache = { version: this.version, icons: normalizeFolderIcons(this.setting(FOLDER_ICONS_SETTING)) };
    }
    return this.iconCache.icons;
  }

  /** The icon of an own folder, or with `groupId` of a group folder; null without one or with icons turned off */
  folderIcon(folder: string, groupId?: string): string | null {
    if (!this.features().icons.enabled) return null;
    return this.folderIcons()[folderIconKey(folder, groupId)] ?? null;
  }

  /** Sets (or with null removes) a folder icon */
  async setFolderIcon(folder: string, icon: string | null, groupId?: string): Promise<void> {
    if (isReadOnly()) throw new Error(t('vault.readOnlyError'));
    const key = folderIconKey(folder, groupId);
    const next = { ...this.folderIcons() };
    const clean = cleanIcon(icon);
    if (clean) next[key] = clean;
    else delete next[key];
    await this.setSetting(FOLDER_ICONS_SETTING, next);
  }

  /** The icon a note sets in its frontmatter; null without one or with icons turned off */
  noteIcon(note: Pick<LocalNote, 'content'>): string | null {
    return this.features().icons.enabled ? noteIconOf(note.content) : null;
  }

  /** Writes (or with null removes) the `icon` frontmatter key of a note the user may edit */
  async setNoteIcon(id: string, icon: string | null): Promise<void> {
    const note = await this.withText(id);
    if (!note) return;
    await this.update(id, { content: setFrontmatter(note.content, { [ICON_KEY]: cleanIcon(icon) }) });
  }

  // ------------------------------------------------------------------ synced settings (system note)

  private settingsId() {
    return `syssettings-${this.userId}`;
  }

  setting<T>(key: string): T | undefined {
    const n = this.notes.get(this.settingsId());
    return n ? (safeObject(n.content)[key] as T | undefined) : undefined;
  }

  async setSetting(key: string, value: unknown) {
    const id = this.settingsId();
    const current = this.notes.get(id);
    const content = JSON.stringify({ ...(current ? safeObject(current.content) : {}), [key]: value });
    const now = Date.now();
    if (current) await this.put({ ...current, content, updatedAt: now, dirty: true });
    else await this.put({ id, path: `${SYSTEM_PREFIX}settings.json`, content, version: 0, createdAt: now, updatedAt: now, deleted: false, access: 'owner', dirty: true });
    this.schedule();
  }

  async remove(id: string): Promise<void> {
    const note = this.notes.get(id);
    if (!note || !this.canDelete(note) || isReadOnly()) return;
    await this.put({ ...note, deleted: true, updatedAt: Date.now(), dirty: true });
    // The memory's index drops the entry (#94)
    if (this.isMemoryNote(note)) await this.memoryUpkeep(note.path, null);
    this.schedule(0);
  }

  // ------------------------------------------------------------------ AI memory (#94)

  /** The signed-in user's name: their actor id (`human:<name>`) in the AI memory */
  actorName = '';

  /** The memory folder when the AI memory is on, else null */
  memoryFolder(): string | null {
    const memory = this.features().memory;
    return memory.enabled ? memory.folder : null;
  }

  /** An own note inside the memory folder (index and log included) */
  isMemoryNote(note: LocalNote): boolean {
    const folder = this.memoryFolder();
    return !!folder && spaceOf(note) === 'own' && isMemoryPath(note.path, folder);
  }

  humanActor(): string {
    return `${HUMAN_ACTOR}${actorId(this.actorName || 'user')}`;
  }

  private ownSpaceNotes(): LocalNote[] {
    return this.list().filter((n) => spaceOf(n) === 'own');
  }

  /** Brings the indexes (and with `log` the log) of the memory up to date after `path` changed */
  async memoryUpkeep(path: string, log: MemoryLogRequest | null): Promise<void> {
    const folder = this.memoryFolder();
    if (!folder || isReadOnly()) return;
    const own = this.ownSpaceNotes();
    const index = new LinkIndex(own, this.roleConfig());
    for (const w of memoryUpkeep(own, folder, path, (t) => index.resolve(t), log)) {
      if (w.id) await this.update(w.id, { content: w.content });
      else {
        const { folder: dir, name } = splitPath(w.path);
        await this.insert(dir, name, w.content);
      }
    }
  }

  private memoryLog(kind: MemoryLogRequest['kind']): MemoryLogRequest {
    return { kind, actor: this.humanActor(), date: isoNow().slice(0, 10) };
  }

  /**
   * After the user edited a memory note (called when they leave it): `generated` names them, index and log follow.
   * `before` is the content when the note was opened ('' for a new note).
   */
  async finishMemoryEdit(id: string, before: string): Promise<void> {
    const note = this.get(id);
    if (!note || !this.isMemoryNote(note) || isReservedMemoryNote(note.path) || note.content === before || isReadOnly()) return;
    const content = stampGenerated(note.content, this.humanActor());
    await this.update(id, { content });
    await this.memoryUpkeep(note.path, this.memoryLog(memoryChangeKind(before.trim() ? before : null, content)));
  }

  /** The user confirms a memory note (`verified: human:<name>`) */
  async verifyMemoryNote(id: string): Promise<void> {
    const note = this.get(id);
    if (!note || !this.isMemoryNote(note)) return;
    await this.update(id, { content: addVerification(note.content, this.humanActor()) });
  }

  /** draft / stable / deprecated; deprecating is logged */
  async setMemoryNoteStatus(id: string, status: string): Promise<void> {
    const note = this.get(id);
    if (!note || !this.isMemoryNote(note)) return;
    const content = stampGenerated(setMemoryStatus(note.content, status), this.humanActor());
    await this.update(id, { content });
    await this.memoryUpkeep(note.path, this.memoryLog(memoryChangeKind(note.content, content)));
  }

  /** Sets the required `type` (quick fix for notes the user created in the memory) */
  async setMemoryNoteType(id: string, type: string): Promise<void> {
    const note = this.get(id);
    if (!note || !this.isMemoryNote(note)) return;
    await this.update(id, { content: applyMemoryFields(note.content, { type }) });
  }

  /** Copies a memory note into the user's own notes, without agent metadata and with a link back */
  async adoptMemoryNote(id: string, folder: string): Promise<LocalNote | null> {
    const note = this.get(id);
    if (!note) return null;
    const name = splitPath(note.path).name;
    const target = this.links().resolve(name) === id ? name : note.path.replace(/\.md$/, '');
    return this.create(folder, name, adoptedContent(note.content, target));
  }

  /** The memory as an OKF bundle (ZIP) */
  memoryBundle(): Uint8Array | null {
    const folder = this.memoryFolder();
    if (!folder) return null;
    const index = this.links();
    return zipStore(toOkfBundle(this.ownSpaceNotes(), folder, (t) => index.resolve(t)));
  }

  /** Imports the Markdown files of an OKF bundle into the memory; existing paths are left alone */
  async importMemoryBundle(files: BundleFile[]): Promise<{ created: number; skipped: number }> {
    const folder = this.memoryFolder();
    if (!folder || isReadOnly()) return { created: 0, skipped: 0 };
    const taken = new Set(this.ownSpaceNotes().map((n) => n.path.toLowerCase()));
    let created = 0;
    let skipped = 0;
    for (const f of fromOkfBundle(files, folder)) {
      if (taken.has(f.path.toLowerCase())) {
        skipped++;
        continue;
      }
      const { folder: dir, name } = splitPath(f.path);
      await this.insert(dir, name, f.content);
      created++;
    }
    return { created, skipped };
  }

  /** Own notes, and shared ones from a folder share that allows deleting */
  canDelete(note: LocalNote): boolean {
    return note.access === 'owner' || (note.access === 'write' && !!note.canDelete);
  }

  // Free tasks (not tied to a note) live in a hidden system note and are merged with the tasks of all notes on the home screen
  freeTasksId() {
    return `sysfreetasks-${this.userId}`;
  }

  async addFreeTask(text: string): Promise<void> {
    if (isReadOnly()) return;
    const id = this.freeTasksId();
    const line = `- [ ] ${text}`;
    const current = this.notes.get(id);
    if (current && !current.deleted) await this.update(id, { content: `${current.content.replace(/\n*$/, '')}\n${line}\n` });
    else {
      const now = Date.now();
      await this.put({ id, path: `${SYSTEM_PREFIX}tasks.md`, content: `${line}\n`, version: current?.version ?? 0, createdAt: now, updatedAt: now, deleted: false, access: 'owner', dirty: true });
      this.schedule();
    }
  }

  freeTasksNote(): LocalNote | undefined {
    return this.get(this.freeTasksId());
  }

  async setTaskMeta(id: string, line: number, meta: { due?: string | null; repeat?: string | null }): Promise<void> {
    const note = await this.withText(id);
    if (note) await this.update(id, { content: setTaskMeta(note.content, line, meta) });
  }

  async toggleTask(id: string, line: number): Promise<void> {
    const note = await this.withText(id);
    if (note) await this.update(id, { content: toggleTask(note.content, line) });
  }

  async setTaskStatus(id: string, line: number, status: TaskStatus): Promise<void> {
    const note = await this.withText(id);
    if (note) await this.update(id, { content: setTaskStatus(note.content, line, status) });
  }

  /**
   * Moves open tasks (with their subtasks) from other notes to the end of `targetId`, e.g. from
   * earlier daily notes into today's. Items are taken in the given order.
   */
  async carryOverTasks(targetId: string, items: { noteId: string; line: number }[]): Promise<void> {
    const target = this.get(targetId);
    if (!target || isReadOnly()) return;
    const moved = new Map<string, string[]>();
    const byNote = new Map<string, number[]>();
    for (const it of items) if (it.noteId !== targetId) byNote.set(it.noteId, [...(byNote.get(it.noteId) ?? []), it.line]);
    for (const [noteId, lines] of byNote) {
      const note = this.get(noteId);
      if (!note || note.access === 'read') continue;
      let content = note.content;
      // From the bottom up, so the line numbers above stay valid
      for (const line of [...lines].sort((a, b) => b - a)) {
        const taken = takeTaskBlock(content, line);
        if (!taken) continue;
        content = taken.content;
        moved.set(`${noteId}:${line}`, taken.block);
      }
      if (content !== note.content) await this.update(noteId, { content });
    }
    const lines = items.flatMap((it) => moved.get(`${it.noteId}:${it.line}`) ?? []);
    if (lines.length) await this.update(targetId, { content: appendTaskLines(this.get(targetId)!.content, lines) });
  }

  private storedFolders(): string[] {
    const note = this.notes.get(this.foldersNoteId());
    return note && !note.deleted ? safeList(note.content) : [];
  }

  private async setFolders(list: string[]): Promise<void> {
    const id = this.foldersNoteId();
    const current = this.notes.get(id);
    const content = JSON.stringify([...new Set(list)].sort());
    if (current?.content === content) return;
    const now = Date.now();
    if (current) await this.put({ ...current, content, deleted: false, updatedAt: now, dirty: true });
    else await this.put({ id, path: FOLDERS_NOTE_PATH, content, version: 0, createdAt: now, updatedAt: now, deleted: false, access: 'owner', dirty: true });
    this.schedule();
  }

  async addFolder(path: string): Promise<string | null> {
    const clean = cleanFolder(path);
    if (!clean || isReadOnly()) return null;
    await this.setFolders([...this.storedFolders(), clean]);
    return clean;
  }

  /** Notes of the user inside `folder` or one of its subfolders */
  private notesBelow(folder: string): LocalNote[] {
    return [...this.notes.values()].filter((n) => {
      if (n.deleted || n.access !== 'owner' || n.path.startsWith(SYSTEM_PREFIX)) return false;
      const f = splitPath(n.path).folder;
      return f === folder || f.startsWith(`${folder}/`);
    });
  }

  /** False when `target` is the folder itself or lies inside it */
  canMoveFolder(from: string, target: string): boolean {
    return target !== from && !target.startsWith(`${from}/`);
  }

  async moveNote(id: string, folder: string): Promise<void> {
    const note = this.get(id);
    if (note && splitPath(note.path).folder !== folder) await this.update(id, { folder });
  }

  /** Moves `from` (with all subfolders and notes) below `parent` ('' = top level) */
  async moveFolder(from: string, parent: string): Promise<void> {
    const name = from.split('/').pop()!;
    await this.renameFolder(from, parent ? `${parent}/${name}` : name);
  }

  /** Renames or moves a folder: every note and subfolder below it follows */
  async renameFolder(from: string, to: string): Promise<void> {
    const target = cleanFolder(to);
    if (!target || !this.canMoveFolder(from, target) || isReadOnly()) return;
    const swap = (f: string) => (f === from || f.startsWith(`${from}/`) ? target + f.slice(from.length) : f);
    for (const note of this.notesBelow(from)) {
      const { folder, name } = splitPath(note.path);
      await this.put({ ...note, path: this.uniquePath(swap(folder), name, note.id), updatedAt: Date.now(), dirty: true });
    }
    await this.setFolders([...this.storedFolders().map(swap), target]);
    const icons = this.folderIcons();
    if (Object.keys(icons).some((k) => k === from || k.startsWith(`${from}/`))) await this.setSetting(FOLDER_ICONS_SETTING, renameFolderIcons(icons, from, target));
    this.schedule();
    // Folder shares follow the folder (best effort: offline, the notes leave the share until it is set again)
    if (!this.standalone) void api('/folders/renamed', { method: 'POST', json: { from, to: target } }).catch(() => {});
  }

  isFolderEmpty(folder: string): boolean {
    return !this.folderCounts().has(folder);
  }

  /** Only empty folders (with empty subfolders) can be deleted */
  async deleteFolder(folder: string): Promise<boolean> {
    if (!this.isFolderEmpty(folder) || isReadOnly()) return false;
    await this.setFolders(this.storedFolders().filter((f) => f !== folder && !f.startsWith(`${folder}/`)));
    await this.forgetFolderIcons(folder);
    if (!this.standalone) void api('/folders/deleted', { method: 'POST', json: { folder } }).catch(() => {});
    return true;
  }

  /** A deleted folder takes its icons along, so a new folder with the same name starts without one */
  private async forgetFolderIcons(folder: string) {
    const icons = this.folderIcons();
    const next = dropFolderIcons(icons, folder);
    if (Object.keys(next).length !== Object.keys(icons).length) await this.setSetting(FOLDER_ICONS_SETTING, next);
  }

  /** Number of own notes inside `folder` and its subfolders */
  notesInFolder(folder: string): number {
    return this.folderCounts().get(folder) ?? 0;
  }

  private countsCache: { stamp: number; counts: Map<string, number> } | null = null;

  /** Own notes per folder, its subfolders included; once per change instead of once per folder row (#64) */
  private folderCounts(): Map<string, number> {
    if (this.countsCache?.stamp === this.pathStamp) return this.countsCache.counts;
    const counts = new Map<string, number>();
    for (const n of this.notes.values()) {
      if (n.deleted || n.access !== 'owner' || n.path.startsWith(SYSTEM_PREFIX)) continue;
      let f = splitPath(n.path).folder;
      while (f) {
        counts.set(f, (counts.get(f) ?? 0) + 1);
        const cut = f.lastIndexOf('/');
        f = cut < 0 ? '' : f.slice(0, cut);
      }
    }
    this.countsCache = { stamp: this.pathStamp, counts };
    return counts;
  }

  /** Deletes a folder with every note and subfolder below it */
  async deleteFolderWithNotes(folder: string): Promise<boolean> {
    if (!folder || isReadOnly()) return false;
    const now = Date.now();
    const trashBatch = newId();
    for (const note of this.notesBelow(folder)) await this.put({ ...note, deleted: true, updatedAt: now, dirty: true, trashBatch, trashFolder: folder });
    await this.setFolders(this.storedFolders().filter((f) => f !== folder && !f.startsWith(`${folder}/`)));
    await this.forgetFolderIcons(folder);
    this.schedule(0);
    if (!this.standalone) void api('/folders/deleted', { method: 'POST', json: { folder } }).catch(() => {});
    return true;
  }

  /**
   * Quick capture: tasks are collected in "0 Inbox/Eingang", every thought becomes its own inbox note.
   * With a `title` (shared from another app) the whole text becomes the content of a note with that title.
   */
  async capture(text: string, asTask: boolean, title?: string): Promise<LocalNote | undefined> {
    if (!asTask && title?.trim()) return this.create(INBOX_FOLDER, title.trim(), `${text}\n`);
    if (!asTask) {
      const firstLine = text.split('\n')[0];
      const title = excerpt(firstLine, 50).replace(/[\\/:#[\]|]/g, ' ').trim() || t('home.welcomeDefaultNoteName');
      return this.create(INBOX_FOLDER, title, text.includes('\n') || text.length > 50 ? `${text}\n` : '');
    }
    const line = `- [ ] ${text}`;
    const inbox = this.list().find((n) => n.path === joinPath(INBOX_FOLDER, 'Eingang'));
    if (inbox) await this.update(inbox.id, { content: `${inbox.content.replace(/\n*$/, '')}\n${line}\n` });
    else return this.create(INBOX_FOLDER, 'Eingang', `# ${t('home.inboxTaskHeading')}\n\n${line}\n`);
    return inbox;
  }

  // ------------------------------------------------------------------ release versioning (#53)

  /** Turns release versioning of an own note on or off (online only; releases are kept when turned off) */
  async setVersioning(id: string, enabled: boolean): Promise<void> {
    const server = await api<SyncedNote>(`/notes/${id}/versioning`, { method: 'PUT', json: { enabled } });
    const local = this.notes.get(id);
    if (local) await this.put(withReleaseState(local, server));
    this.emit();
  }

  /**
   * Releases the note's current text as the next version. Local edits are pushed first: the server releases
   * exactly the version this device has, and refuses when someone changed the note in the meantime.
   */
  async release(id: string, bump: ReleaseBump, note: string): Promise<NoteReleaseInfo> {
    await this.sync();
    const local = this.notes.get(id);
    if (!local || local.dirty || local.version === 0) throw new Error(t('release.notSynced'));
    const res = await api<{ release: NoteReleaseInfo }>(`/notes/${id}/releases`, { method: 'POST', json: { bump, note, baseVersion: local.version } });
    await this.sync();
    return res.release;
  }

  // ------------------------------------------------------------------ sync

  /** Pushes soon after the last edit (typing produces many) */
  schedule(delay = 1200) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.kick(), delay);
  }

  sync(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.syncing) {
      this.again = true;
      return this.syncing;
    }
    this.syncing = this.runSync().finally(() => {
      this.syncing = null;
      if (this.again) {
        this.again = false;
        void this.sync();
      }
    });
    return this.syncing;
  }

  private async runSync(): Promise<void> {
    if (!this.db) return;
    this.lastSyncStart = Date.now();
    if (!this.standalone && !navigator.onLine) {
      this.setState('offline');
      return;
    }
    this.setState('syncing');
    try {
      await this.push();
      const firstPull = this.online ? this.memCursor === null && this.notes.size === 0 : (await this.db.get('meta', 'cursor')) === undefined;
      await this.pull();
      if (this.relinks.length) await this.sendRelinks();
      if (this.online) await this.loadDatabaseFolders();
      if (firstPull && !this.notes.has(this.foldersNoteId())) await this.seed();
      else if (this.notes.has(this.foldersNoteId()) && this.setting(FEATURES_SETTING) === undefined && !isReadOnly()) {
        await this.setSetting(FEATURES_SETTING, this.features());
      }
      if (this.pendingCount() > 0) await this.push();
      this.lastSync = Date.now();
      this.setState('idle');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        this.setState('error', t('common.signedOutError'));
        this.onUnauthorized();
      } else if (err instanceof ApiError) this.setState('error', err.message);
      else this.setState('offline');
    }
  }

  private setState(state: SyncState, message = '') {
    this.state = state;
    this.message = message;
    this.emit();
  }

  /** First start of a new space: Inbox and the folders of the standard features (PARA, Zettelkasten), default daily note settings, disabled opt-in features, and welcome notes */
  private async seed() {
    await this.setFolders([...this.storedFolders(), INBOX_FOLDER, ...Object.values(DEFAULT_PARA_FOLDERS), DEFAULT_ZETTEL_FOLDER]);
    await this.setSetting(FEATURES_SETTING, {
      para: { enabled: true, folders: { ...DEFAULT_PARA_FOLDERS } },
      zettel: { enabled: true, folder: DEFAULT_ZETTEL_FOLDER },
      recipe: { enabled: false, folder: DEFAULT_RECIPE_FOLDER },
      daily: { enabled: true, folder: DEFAULT_DAILY_FOLDER, format: DEFAULT_DAILY_FORMAT },
      heatmap: { enabled: false },
      review: { enabled: false },
      favorites: { enabled: false },
      writingStats: { enabled: true },
      focus: { enabled: true, dim: false },
      icons: { enabled: false },
      memory: { enabled: false, folder: DEFAULT_MEMORY_FOLDER },
      notifications: { enabled: false },
      calendar: { enabled: false },
      shortcuts: { enabled: false },
      mcp: { enabled: false },
      database: { enabled: false },
      tickets: { enabled: false },
      presentation: { enabled: false },
      callouts: { enabled: true },
      calendarView: { enabled: true },
      activity: { enabled: true },
      mentions: { enabled: true },
      comments: { enabled: true },
      weekly: { enabled: false, folder: DEFAULT_WEEKLY_FOLDER, format: DEFAULT_WEEKLY_FORMAT },
      monthly: { enabled: false, folder: DEFAULT_MONTHLY_FOLDER, format: DEFAULT_MONTHLY_FORMAT },
    } satisfies FeatureSettings);
    for (const w of welcomeNotes(getLang())) await this.insert(w.folder, w.title, w.content);
  }

  private async push() {
    const dirty = [...this.notes.values()].filter((n) => n.dirty);
    if (!dirty.length) return;
    const { results } = await api<PushResponse>('/sync', { method: 'POST', json: { changes: dirty.map(toChange) } });
    const pushed = new Map(dirty.map((n) => [n.id, n]));
    for (const r of results) {
      const sent = pushed.get(r.id);
      const current = this.notes.get(r.id);
      if (!sent || !current) continue;
      if (r.status === 'ok') {
        const unchanged = current.updatedAt === sent.updatedAt;
        if (current.deleted && unchanged) {
          this.notes.delete(r.id);
          this.pathStamp++;
          await this.db!.delete('notes', r.id);
        } else if (unchanged) await this.put({ ...current, version: r.version, dirty: false, ...(r.content !== undefined && !current.partial ? { content: r.content } : {}) });
        // Edited again while the push was underway: the pushed state is the new base (with what the server changed)
        else if (r.content !== undefined && !current.partial) await this.put({ ...current, content: merge3(sent.content, current.content, r.content).text, version: r.version, dirty: true, base: r.content, basePath: sent.path });
        else await this.put({ ...current, version: r.version, dirty: true, base: sent.content, basePath: sent.path });
      } else if (r.status === 'conflict') {
        await this.resolveConflict(current, r.server);
      } else if (current.version === 0 && current.access !== 'owner' && !current.deleted) {
        // Creating in a shared folder or group is no longer allowed: the text stays, as an own note in the inbox
        const { owner: _owner, canDelete: _canDelete, group: _group, ...rest } = current;
        await this.put({ ...rest, access: 'owner', path: this.uniquePath(INBOX_FOLDER, splitPath(current.path).name, current.id), dirty: true });
      } else if (current.deleted && current.access !== 'owner') {
        // Deleting is not (or no longer) allowed: the note comes back
        await this.put({ ...current, deleted: false, canDelete: false, dirty: false });
      } else {
        // Not allowed (e.g. read-only share): drop the local change
        await this.put({ ...current, dirty: false });
      }
    }
  }

  // ------------------------------------------------------------------ mentions and notifications (#69)

  /** People who can see a note (the ones a mention reaches), by note id */
  private people = new Map<string, NotePerson[]>();
  private peopleLoading = new Set<string>();

  /** People who can see the note; loads them the first time (an empty list until then, or offline) */
  peopleOf(noteId: string): NotePerson[] {
    const known = this.people.get(noteId);
    if (known) return known;
    if (!this.standalone && !this.peopleLoading.has(noteId) && this.notes.get(noteId)?.version) {
      this.peopleLoading.add(noteId);
      void api<NotePerson[]>(`/notes/${encodeURIComponent(noteId)}/people`)
        .then((list) => {
          this.people.set(noteId, list);
          this.emit();
        })
        .catch(() => {})
        .finally(() => this.peopleLoading.delete(noteId));
    }
    return [];
  }

  /** Asks again who can see the note (after sharing it) */
  refreshPeople(noteId: string) {
    this.people.delete(noteId);
    this.peopleOf(noteId);
  }

  notifications: NotificationItem[] = [];
  unreadNotifications = 0;

  async loadNotifications(): Promise<void> {
    if (this.standalone) return;
    try {
      const list = await api<NotificationList>('/notifications');
      this.notifications = list.items;
      this.unreadNotifications = list.unread;
      this.emit();
    } catch {
      // offline or an old server: keep what is there
    }
  }

  /** Marks notifications read: some by id, those of a note, or all */
  async readNotifications(opts: { ids?: string[]; noteId?: string } = {}): Promise<void> {
    const affected = this.notifications.filter((n) => !n.read && (opts.ids ? opts.ids.includes(n.id) : opts.noteId ? n.noteId === opts.noteId : true));
    if (!affected.length) return;
    for (const n of affected) n.read = true;
    this.unreadNotifications = Math.max(0, this.unreadNotifications - affected.length);
    this.emit();
    try {
      const res = await api<{ unread: number }>('/notifications/read', { method: 'POST', json: opts.ids ? { ids: opts.ids } : opts.noteId ? { noteId: opts.noteId } : {} });
      this.unreadNotifications = res.unread;
      this.emit();
    } catch {
      // read again on the next load
    }
  }

  /** Comment threads changed on a note (#68): listeners load them again */
  readonly commentListeners = new Set<(noteId: string) => void>();

  /** Notes someone else changed since the user last opened them (#70), by id */
  private news = new Map<string, { at: number; by: string | null }>();
  private newsTimer: ReturnType<typeof setTimeout> | null = null;
  /** The note open in the editor: changes to it are seen as they come in */
  viewing: string | null = null;

  /** Fetches the "new since your last visit" marks again, shortly after the last pull */
  private refreshNews() {
    if (this.standalone) return;
    if (this.newsTimer) clearTimeout(this.newsTimer);
    this.newsTimer = setTimeout(() => {
      this.newsTimer = null;
      void api<ActivityNews>('/activity/news')
        .then((r) => {
          const next = new Map(r.notes.filter((n) => n.id !== this.viewing).map((n) => [n.id, { at: n.at, by: n.by }]));
          if (next.size === 0 && this.news.size === 0) return;
          this.news = next;
          this.emit();
        })
        .catch(() => {});
    }, 400);
  }

  /** Who changed the note since the user last opened it, if somebody did */
  newsOf(id: string): { at: number; by: string | null } | undefined {
    return this.news.get(id);
  }

  /** The user opened (or left) the note: it is no longer new to them, on every device */
  markSeen(id: string) {
    if (this.news.delete(id)) this.emit();
    if (!this.standalone) void api('/activity/seen', { method: 'POST', json: { noteId: id } }).catch(() => {});
  }

  private async pull() {
    const since = this.online ? (this.memCursor ?? 0) : (((await this.db!.get('meta', 'cursor')) as number | undefined) ?? 0);
    const res = await api<PullResponse>(`/sync?since=${since}${this.online ? '&light=1' : ''}`);
    // Online mode: notes whose text is on the device and changed on the server get their new text
    const wanted: string[] = [];
    // Notes taken as they are go into memory right away and to IndexedDB in one transaction with one update of the
    // UI at the end: a first sync of thousands of notes would otherwise write and re-render once per note (#64)
    const stored: LocalNote[] = [];
    const removed: string[] = [];
    // Online mode: catalog entries that replace a note stored with its text (only those are in IndexedDB)
    const dropped = new Set<string>();
    for (const server of res.notes) {
      const local = this.notes.get(server.id);
      if (server.partial && local && !local.partial) {
        if (local.version < server.version) wanted.push(server.id);
        else if (local.dirty || local.version === server.version) {
          // The text on the device is current: take only the catalog's news (release state, access)
          if (local.version === server.version && !local.dirty) {
            const note: LocalNote = { ...withReleaseState(local, server), access: server.access };
            this.notes.set(note.id, note);
            stored.push(note);
          }
        }
        continue;
      }
      if (local?.dirty && local.version < server.version) await this.resolveConflict(local, server);
      else if (local?.dirty) {
        // Same version, only the release state changed (#53): keep the local edits, take the new state
        if (local.version === server.version) await this.put(withReleaseState(local, server));
        continue;
      } else if (server.deleted) {
        this.notes.delete(server.id);
        this.pathStamp++;
        removed.push(server.id);
      } else if (server.partial) {
        // Online mode: catalog entries stay in memory
        this.notes.set(server.id, { ...server, dirty: false });
        if (local && !local.partial) dropped.add(server.id);
      } else {
        const note: LocalNote = { ...server, dirty: false };
        this.notes.set(note.id, note);
        stored.push(note);
      }
    }
    removed.push(...dropped);
    for (const id of res.revoked) {
      this.notes.delete(id);
      this.pathStamp++;
      removed.push(id);
    }
    if (wanted.length) {
      for (let i = 0; i < wanted.length; i += FETCH_BATCH) {
        const { notes } = await api<{ notes: SyncedNote[] }>('/sync/notes', { method: 'POST', json: { ids: wanted.slice(i, i + FETCH_BATCH) } });
        for (const server of notes) {
          const local = this.notes.get(server.id);
          if (local?.dirty) await this.resolveConflict(local, server);
          else {
            const note: LocalNote = { ...server, dirty: false, ...(local?.cachedAt ? { cachedAt: local.cachedAt } : {}) };
            this.notes.set(note.id, note);
            stored.push(note);
          }
        }
      }
    }
    if (stored.length || removed.length) {
      const tx = this.db!.transaction('notes', 'readwrite');
      await Promise.all([...stored.map((n) => tx.store.put(n)), ...removed.map((id) => tx.store.delete(id)), tx.done]);
    }
    if (res.sharedFolders) {
      this.sharedFolders = res.sharedFolders;
      await this.db!.put('meta', res.sharedFolders, 'sharedFolders');
    }
    if (res.groups) {
      this.groups = res.groups;
      await this.db!.put('meta', res.groups, 'groups');
    }
    if (res.notes.length || res.revoked.length) this.pathStamp++;
    if (this.online) this.memCursor = res.cursor;
    else await this.db!.put('meta', res.cursor, 'cursor');
    this.emit();
    if (res.notes.length || since === 0 || !this.newsLoaded) {
      this.newsLoaded = true;
      this.refreshNews();
    }
  }
  private newsLoaded = false;

  private async accept(server: SyncedNote) {
    if (server.deleted) {
      this.notes.delete(server.id);
      this.pathStamp++;
      await this.db!.delete('notes', server.id);
    } else await this.put({ ...server, dirty: false });
  }

  /** Both sides changed the note: the server's version wins, the local text survives as a copy */
  private async resolveConflict(local: LocalNote, server: SyncedNote) {
    if (local.id === this.foldersNoteId()) {
      const merged = new Set<string>([...safeList(local.content), ...safeList(server.content)]);
      await this.put({ ...server, content: JSON.stringify([...merged].sort()), dirty: true });
      return;
    }
    if (local.id === this.settingsId()) {
      await this.put({ ...server, content: JSON.stringify({ ...safeObject(server.content), ...safeObject(local.content) }), dirty: true });
      return;
    }
    // Online mode: moved or deleted here without the text, changed elsewhere: the move or deletion goes out again
    if (local.partial) {
      if (server.deleted) return this.accept(server);
      const renamedHere = local.basePath !== undefined && local.path !== local.basePath && server.path === local.basePath;
      await this.put({ ...server, path: renamedHere && server.access === 'owner' ? local.path : server.path, deleted: local.deleted, dirty: true, ...(server.partial ? {} : { base: server.content, basePath: server.path }) });
      this.schedule(250);
      return;
    }
    // Both changed the text: apply both sides' edits (the result is pushed as a new version)
    if (!local.deleted && !server.deleted && local.base !== undefined && local.content !== server.content) {
      const merged = merge3(local.base, local.content, server.content);
      if (merged.clean) {
        const renamedHere = local.basePath !== undefined && local.path !== local.basePath && server.path === local.basePath;
        const path = renamedHere && server.access === 'owner' ? local.path : server.path;
        await this.put({ ...server, content: merged.text, path, dirty: true, base: server.content, basePath: server.path });
        this.schedule(250);
        return;
      }
    }
    await this.accept(server);
    if (local.deleted || local.content === server.content) return;
    const { folder, name } = splitPath(server.deleted ? local.path : server.path);
    const stamp = new Date().toLocaleString(locale(getLang()), { dateStyle: 'short', timeStyle: 'short' }).replace(/[/:]/g, '-');
    await this.insert(server.access === 'owner' ? folder : INBOX_FOLDER, t('vault.conflictCopy', { name, stamp }), local.content);
  }
}

function cleanFolder(path: string): string {
  const cleaned = path
    .split('/')
    .map((p) => p.trim().replace(/[\\]/g, '-'))
    .filter((p) => p && p !== '.' && p !== '..')
    .join('/');
  return cleaned === '.kladde' || cleaned.toLowerCase().startsWith('.kladde/') ? '' : cleaned;
}

/** Which space a note lives in: own notes, another user's space (shares) or a group (#58) */
function spaceOf(n: LocalNote): string {
  if (n.group) return `group:${n.group}`;
  return n.access === 'owner' ? 'own' : `user:${n.owner ?? ''}`;
}

/** A local note as a pushed change; catalog entries (online mode) move, rename and delete without the text */
function toChange(n: LocalNote): PushChange {
  return {
    id: n.id,
    baseVersion: n.version,
    path: n.path,
    content: n.partial ? '' : n.content,
    deleted: n.deleted,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    ...(n.partial ? { keepContent: true } : {}),
    // New note in a folder someone shares with us or in a group: it is created in their space
    ...newNoteSpace(n),
    // Deleted with a folder: the trash restores the whole folder as one unit
    ...(n.deleted && n.trashBatch ? { trashBatch: n.trashBatch, trashFolder: n.trashFolder } : {}),
  };
}

/** An opened note as a catalog entry again (online mode): the text is dropped from the device */
function toCatalogEntry(n: LocalNote): LocalNote {
  const { cachedAt: _c, base: _b, basePath: _bp, ...rest } = n;
  return { ...rest, content: '', partial: true };
}

/** What a new note tells the server about where it belongs: a group, or a folder another user shares */
function newNoteSpace(n: LocalNote): { group?: string; owner?: string } {
  if (n.version !== 0) return {};
  if (n.group) return { group: n.group };
  return n.access !== 'owner' && n.owner ? { owner: n.owner } : {};
}

const safeObject = (s: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};

const safeList = (s: string): string[] => {
  try {
    return JSON.parse(s);
  } catch {
    return [];
  }
};

export const vault = new Vault();

/** Re-renders on every change of the vault; read the data from `vault` afterwards */
export function useVault(): number {
  return useSyncExternalStore(vault.subscribe, vault.getVersion);
}

// Development: a hot reload of this module would leave the old instance running (listeners, SSE,
// timers) next to a new, unopened one – close it and reload the page instead
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    vault.close();
    location.reload();
  });
}

/** `local` with the release state (#53) of `server`: versioning, releases, release fingerprint */
function withReleaseState(local: LocalNote, server: SyncedNote): LocalNote {
  const { versioning: _v, releases: _r, releaseHash: _h, showsRelease: _s, ...rest } = local;
  return {
    ...rest,
    ...(server.versioning ? { versioning: true, releases: server.releases ?? [] } : {}),
    ...(server.releaseHash ? { releaseHash: server.releaseHash } : {}),
    ...(server.showsRelease ? { showsRelease: server.showsRelease } : {}),
  };
}
