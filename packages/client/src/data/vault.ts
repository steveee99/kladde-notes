import { useSyncExternalStore } from 'react';
import {
  DEFAULT_DAILY_FOLDER,
  DEFAULT_DAILY_FORMAT,
  DEFAULT_PARA_FOLDERS,
  DEFAULT_ZETTEL_FOLDER,
  FEATURES_SETTING,
  FOLDERS_NOTE_PATH,
  FeatureSettings,
  INBOX_FOLDER,
  PROJECT_HOME_NAME,
  PullResponse,
  PushResponse,
  RoleFolderMap,
  STANDALONE_RECIPE_FOLDER,
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
  templateUsesZettelId,
  TEMPLATES_SETTING,
  joinPath,
  linkFirstMention,
  renameWikiLinks,
  restoreTarget,
  setFrontmatter,
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
} from '@kladde/shared';
import { api, ApiError } from '../lib/api';
import { getLang, locale, t } from '../lib/i18n';
import { isReadOnly } from '../lib/readOnly';
import { clientId, presence } from '../lib/presence';
import { LocalDb, LocalNote, openLocalDb } from './db';
import { welcomeNotes } from './welcome';

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error';

export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Synced setting with the ordered list of favorite note ids */
const FAVORITES_SETTING = 'favorites';

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
  /** Folders other users share with this user (from the last pull) */
  sharedFolders: SharedFolder[] = [];
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
    const db = await openLocalDb(userId);
    if (this.userId !== userId) return;
    this.db = db;
    for (const n of await this.db.getAll('notes')) this.notes.set(n.id, n);
    this.sharedFolders = ((await this.db.get('meta', 'sharedFolders')) as SharedFolder[] | undefined) ?? [];
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
    this.sharedFolders = [];
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
    const dirty = [...this.notes.values()].filter((n) => n.dirty);
    if (!dirty.length) return;
    const changes = dirty.map((n) => ({
      id: n.id,
      baseVersion: n.version,
      path: n.path,
      content: n.content,
      deleted: n.deleted,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
      ...(n.version === 0 && n.access !== 'owner' && n.owner ? { owner: n.owner } : {}),
    }));
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

  // ------------------------------------------------------------------ queries

  /** Visible notes (no system notes, no deleted ones) */
  list(): LocalNote[] {
    return [...this.notes.values()].filter((n) => !n.deleted && !n.path.startsWith(SYSTEM_PREFIX));
  }

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

  folders(): string[] {
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
    return [...set].sort((a, b) => a.localeCompare(b, locale(getLang()), { numeric: true }));
  }

  private indexCache: { version: number; index: LinkIndex } | null = null;

  /** Link index over all visible notes, rebuilt lazily after changes */
  links(): LinkIndex {
    if (!this.indexCache || this.indexCache.version !== this.version) {
      this.indexCache = { version: this.version, index: new LinkIndex(this.list(), this.roleConfig()) };
    }
    return this.indexCache.index;
  }

  findByTitle(title: string): LocalNote | undefined {
    const id = this.links().resolve(title);
    if (id) return this.get(id);
    const t = title.trim().toLowerCase();
    return this.list().find((n) => splitPath(n.path).name.toLowerCase() === t || n.path.toLowerCase() === `${t}.md`);
  }

  // ------------------------------------------------------------------ edits

  private async put(note: LocalNote) {
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
    await this.db?.put('notes', note);
  }

  private uniquePath(folder: string, title: string, ignoreId?: string): string {
    let candidate = joinPath(folder, title);
    for (let i = 2; [...this.notes.values()].some((n) => !n.deleted && n.id !== ignoreId && n.path === candidate); i++) {
      candidate = joinPath(folder, `${title} ${i}`);
    }
    return candidate;
  }

  /** A note the user creates; blocked in read-only mode */
  async create(folder: string, title: string, content = ''): Promise<LocalNote> {
    if (isReadOnly()) throw new Error(t('vault.readOnlyError'));
    return this.insert(folder, title, content);
  }

  /** A note in a folder another user shares with this user: it belongs to them and lives in their space */
  async createShared(shared: SharedFolder, title: string, content = ''): Promise<LocalNote> {
    if (isReadOnly()) throw new Error(t('vault.readOnlyError'));
    if (!shared.canCreate) throw new Error(t('vault.sharedNoCreate'));
    const now = Date.now();
    const note: LocalNote = {
      id: newId(),
      path: this.uniquePath(shared.folder, title),
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
    if (note.access === 'owner' && (patch.folder !== undefined || patch.title !== undefined)) {
      const cur = splitPath(note.path);
      path = this.uniquePath(patch.folder ?? cur.folder, patch.title ?? cur.name, id);
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
    for (const n of [...this.notes.values()]) {
      if (n.deleted || n.id === renamedId || n.access === 'read' || !n.content.includes('[[')) continue;
      const content = renameWikiLinks(n.content, oldName, newName);
      if (content !== n.content) await this.put({ ...n, content, updatedAt: Date.now(), dirty: true });
    }
  }

  /** Replaces the first plain mention of the target's title in `noteId` with a link */
  async linkMention(noteId: string, targetId: string) {
    const note = this.get(noteId);
    const target = this.get(targetId);
    if (!note || !target) return;
    const full = this.links().notes.get(targetId)?.title ?? splitPath(target.path).name;
    for (const name of this.links().mentionNames(targetId)) {
      const content = linkFirstMention(note.content, name, full);
      if (content !== note.content) return this.update(noteId, { content });
    }
  }

  // ------------------------------------------------------------------ Daily Notes, PARA, Zettelkasten & Features

  features(): FeatureSettings {
    return normalizeFeatures(this.setting(FEATURES_SETTING), this.folders());
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
    const heading = /^\d{1,2}$/.test(resolved.name) ? toDateString(dateObj) : resolved.name;
    return this.insert(resolved.folder, resolved.name, `# ${heading}\n\n`);
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
    const note = this.get(id);
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
    const note = this.get(id);
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

  async createFromTemplate(template: Template | null, title: string, folder: string): Promise<LocalNote> {
    if (!template) return this.create(folder, title, '');
    const zid = zettelId();
    const content = fillTemplate(template.content, { title, zid });
    return this.create(folder, templateUsesZettelId(template.content) ? `${zid} ${title}` : title, content);
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
    this.schedule(0);
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
    const note = this.get(id);
    if (note) await this.update(id, { content: setTaskMeta(note.content, line, meta) });
  }

  async toggleTask(id: string, line: number): Promise<void> {
    const note = this.get(id);
    if (note) await this.update(id, { content: toggleTask(note.content, line) });
  }

  async setTaskStatus(id: string, line: number, status: TaskStatus): Promise<void> {
    const note = this.get(id);
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
    this.schedule();
    // Folder shares follow the folder (best effort: offline, the notes leave the share until it is set again)
    if (!this.standalone) void api('/folders/renamed', { method: 'POST', json: { from, to: target } }).catch(() => {});
  }

  isFolderEmpty(folder: string): boolean {
    return this.notesBelow(folder).length === 0;
  }

  /** Only empty folders (with empty subfolders) can be deleted */
  async deleteFolder(folder: string): Promise<boolean> {
    if (!this.isFolderEmpty(folder) || isReadOnly()) return false;
    await this.setFolders(this.storedFolders().filter((f) => f !== folder && !f.startsWith(`${folder}/`)));
    if (!this.standalone) void api('/folders/deleted', { method: 'POST', json: { folder } }).catch(() => {});
    return true;
  }

  /** Quick capture: appends a line to the inbox note of the day-independent "Eingang" note */
  /** Quick capture: tasks are collected in "0 Inbox/Eingang", every thought becomes its own inbox note */
  async capture(text: string, asTask: boolean): Promise<LocalNote | undefined> {
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
      const firstPull = (await this.db.get('meta', 'cursor')) === undefined;
      await this.pull();
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

  /** First start of a new space: Inbox folder, default daily note settings, disabled opt-in features, and welcome notes */
  private async seed() {
    await this.setFolders([...this.storedFolders(), INBOX_FOLDER]);
    await this.setSetting(FEATURES_SETTING, {
      para: { enabled: false, folders: { ...DEFAULT_PARA_FOLDERS } },
      zettel: { enabled: false, folder: DEFAULT_ZETTEL_FOLDER },
      recipe: { enabled: false, folder: STANDALONE_RECIPE_FOLDER },
      daily: { enabled: true, folder: DEFAULT_DAILY_FOLDER, format: DEFAULT_DAILY_FORMAT },
      heatmap: { enabled: false },
      review: { enabled: false },
      favorites: { enabled: false },
    } satisfies FeatureSettings);
    for (const w of welcomeNotes(getLang())) await this.insert(w.folder, w.title, w.content);
  }

  private async push() {
    const dirty = [...this.notes.values()].filter((n) => n.dirty);
    if (!dirty.length) return;
    const { results } = await api<PushResponse>('/sync', {
      method: 'POST',
      json: {
        changes: dirty.map((n) => ({
          id: n.id,
          baseVersion: n.version,
          path: n.path,
          content: n.content,
          deleted: n.deleted,
          createdAt: n.createdAt,
          updatedAt: n.updatedAt,
          // New note in a folder someone shares with us: it is created in their space
          ...(n.version === 0 && n.access !== 'owner' && n.owner ? { owner: n.owner } : {}),
        })),
      },
    });
    const pushed = new Map(dirty.map((n) => [n.id, n]));
    for (const r of results) {
      const sent = pushed.get(r.id);
      const current = this.notes.get(r.id);
      if (!sent || !current) continue;
      if (r.status === 'ok') {
        const unchanged = current.updatedAt === sent.updatedAt;
        if (current.deleted && unchanged) {
          this.notes.delete(r.id);
          await this.db!.delete('notes', r.id);
        } else if (unchanged) await this.put({ ...current, version: r.version, dirty: false });
        // Edited again while the push was underway: the pushed state is the new base
        else await this.put({ ...current, version: r.version, dirty: true, base: sent.content, basePath: sent.path });
      } else if (r.status === 'conflict') {
        await this.resolveConflict(current, r.server);
      } else if (current.version === 0 && current.access !== 'owner' && !current.deleted) {
        // Creating in a shared folder is no longer allowed: the text stays, as an own note in the inbox
        const { owner: _owner, canDelete: _canDelete, ...rest } = current;
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

  private async pull() {
    const since = ((await this.db!.get('meta', 'cursor')) as number | undefined) ?? 0;
    const res = await api<PullResponse>(`/sync?since=${since}`);
    for (const server of res.notes) {
      const local = this.notes.get(server.id);
      if (local?.dirty && local.version < server.version) await this.resolveConflict(local, server);
      else if (local?.dirty) continue;
      else await this.accept(server);
    }
    for (const id of res.revoked) {
      this.notes.delete(id);
      await this.db!.delete('notes', id);
    }
    if (res.sharedFolders) {
      this.sharedFolders = res.sharedFolders;
      await this.db!.put('meta', res.sharedFolders, 'sharedFolders');
    }
    await this.db!.put('meta', res.cursor, 'cursor');
    this.emit();
  }

  private async accept(server: SyncedNote) {
    if (server.deleted) {
      this.notes.delete(server.id);
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
