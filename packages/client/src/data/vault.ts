import { useSyncExternalStore } from 'react';
import {
  DEFAULT_FOLDERS,
  FOLDERS_NOTE_PATH,
  PullResponse,
  PushResponse,
  LinkIndex,
  PARA,
  SYSTEM_PREFIX,
  SyncedNote,
  Template,
  ZettelType,
  archiveTarget,
  excerpt,
  fillTemplate,
  normalizeTemplates,
  templateUsesZettelId,
  TEMPLATES_SETTING,
  joinPath,
  linkFirstMention,
  renameWikiLinks,
  restoreTarget,
  setFrontmatter,
  toDateString,
  zettelId,
  normalizeDueWords,
  splitPath,
  toggleTask,
} from '@kladde/shared';
import { api, ApiError } from '../lib/api';
import { isReadOnly } from '../lib/readOnly';
import { LocalDb, LocalNote, openLocalDb } from './db';
import { welcomeNotes } from './welcome';

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error';

export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

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
  private userId = '';
  private db: LocalDb | null = null;
  private version = 0;
  private listeners = new Set<() => void>();
  private syncing: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private events: EventSource | null = null;
  onUnauthorized: () => void = () => {};

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
    this.ready = true;
    this.emit();
    window.addEventListener('online', this.kick);
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
    this.notes.clear();
    this.ready = false;
    this.db = null;
    this.emit();
    window.removeEventListener('online', this.kick);
    document.removeEventListener('visibilitychange', this.onVisible);
  }

  private lastSyncStart = 0;
  /** Coming back to the app syncs, but not more than every 15 s (tab switching would flood the server) */
  private onVisible = () => document.visibilityState === 'visible' && Date.now() - this.lastSyncStart > 15_000 && this.kick();
  kick = () => void this.sync();

  private connectEvents() {
    if (typeof EventSource === 'undefined') return;
    this.events = new EventSource('/api/events');
    this.events.addEventListener('changed', this.kick);
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
    const note = this.notes.get(this.foldersNoteId());
    if (note) {
      try {
        for (const f of JSON.parse(note.content) as string[]) set.add(f);
      } catch {
        // broken system note: folders still come from the notes
      }
    }
    for (const n of this.list()) {
      if (n.access !== 'owner') continue;
      const { folder } = splitPath(n.path);
      // Parents too, so "a/b/c" shows a, a/b and a/b/c
      const parts = folder.split('/').filter(Boolean);
      for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('/'));
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'de', { numeric: true }));
  }

  private indexCache: { version: number; index: LinkIndex } | null = null;

  /** Link index over all visible notes, rebuilt lazily after changes */
  links(): LinkIndex {
    if (!this.indexCache || this.indexCache.version !== this.version) this.indexCache = { version: this.version, index: new LinkIndex(this.list()) };
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
    if (isReadOnly()) throw new Error('Der Lesemodus ist aktiv.');
    return this.insert(folder, title, content);
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
    this.schedule();
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
    const full = splitPath(target.path).name;
    for (const name of this.links().mentionNames(targetId)) {
      const content = linkFirstMention(note.content, name, full);
      if (content !== note.content) return this.update(noteId, { content });
    }
  }

  // ------------------------------------------------------------------ PARA & Zettelkasten

  async setFrontmatter(id: string, updates: Record<string, string | null>) {
    const note = this.get(id);
    if (note) await this.update(id, { content: setFrontmatter(note.content, updates) });
  }

  /** Moves a note to "4 Archiv/<folder>"; a project is marked as done on the way */
  async archiveNote(id: string, complete = false) {
    const note = this.get(id);
    if (!note || note.access !== 'owner') return;
    if (complete) await this.setFrontmatter(id, { status: 'fertig', abgeschlossen: toDateString(new Date()) });
    const { folder } = splitPath(note.path);
    if (!restoreTarget(folder) && folder !== PARA.archive) await this.update(id, { folder: archiveTarget(folder) });
  }

  async restoreNote(id: string) {
    const note = this.get(id);
    const target = note ? restoreTarget(splitPath(note.path).folder) : null;
    if (!note || target === null) return;
    if (/^status:\s*fertig/m.test(note.content)) await this.setFrontmatter(id, { status: 'aktiv', abgeschlossen: null });
    await this.update(id, { folder: target });
  }

  async archiveFolder(folder: string) {
    if (!restoreTarget(folder)) await this.renameFolder(folder, archiveTarget(folder));
  }

  async restoreFolder(folder: string) {
    const target = restoreTarget(folder);
    if (target) await this.renameFolder(folder, target);
  }

  /** Inbox item becomes a fleeting Zettel: id in front of the title and in the frontmatter */
  async toZettel(id: string) {
    const note = this.get(id);
    if (!note) return;
    const zid = zettelId(new Date(note.createdAt));
    const { name } = splitPath(note.path);
    await this.update(id, { content: setFrontmatter(note.content, { id: zid, typ: 'flüchtig' }), folder: PARA.zettel, title: /^\d{12}/.test(name) ? name : `${zid} ${name}` });
  }

  async createZettel(title: string, type: ZettelType, source: string): Promise<LocalNote> {
    const zid = zettelId();
    const fm = setFrontmatter('', { id: zid, typ: type, ...(type === 'literatur' ? { quelle: source } : {}) });
    const body = type === 'literatur' ? `# ${title}\n\n> Quelle: ${source}\n\n## In eigenen Worten\n\n` : `# ${title}\n\n`;
    return this.create(PARA.zettel, `${zid} ${title}`.trim(), fm + body);
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
    if (!note || note.access !== 'owner' || isReadOnly()) return;
    await this.put({ ...note, deleted: true, updatedAt: Date.now(), dirty: true });
    this.schedule(0);
  }

  async toggleTask(id: string, line: number): Promise<void> {
    const note = this.get(id);
    if (note) await this.update(id, { content: toggleTask(note.content, line) });
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
    void api('/folders/renamed', { method: 'POST', json: { from, to: target } }).catch(() => {});
  }

  isFolderEmpty(folder: string): boolean {
    return this.notesBelow(folder).length === 0;
  }

  /** Only empty folders (with empty subfolders) can be deleted */
  async deleteFolder(folder: string): Promise<boolean> {
    if (!this.isFolderEmpty(folder) || isReadOnly()) return false;
    await this.setFolders(this.storedFolders().filter((f) => f !== folder && !f.startsWith(`${folder}/`)));
    void api('/folders/deleted', { method: 'POST', json: { folder } }).catch(() => {});
    return true;
  }

  /** Quick capture: appends a line to the inbox note of the day-independent "Eingang" note */
  /** Quick capture: tasks are collected in "0 Inbox/Eingang", every thought becomes its own inbox note */
  async capture(text: string, asTask: boolean): Promise<LocalNote | undefined> {
    if (!asTask) {
      const firstLine = text.split('\n')[0];
      const title = excerpt(firstLine, 50).replace(/[\\/:#[\]|]/g, ' ').trim() || 'Gedanke';
      return this.create(PARA.inbox, title, text.includes('\n') || text.length > 50 ? `${text}\n` : '');
    }
    const line = `- [ ] ${text}`;
    const inbox = this.list().find((n) => n.path === joinPath(DEFAULT_FOLDERS[0], 'Eingang'));
    if (inbox) await this.update(inbox.id, { content: `${inbox.content.replace(/\n*$/, '')}\n${line}\n` });
    else return this.create(DEFAULT_FOLDERS[0], 'Eingang', `# Eingang\n\n${line}\n`);
    return inbox;
  }

  // ------------------------------------------------------------------ sync

  /** Pushes soon after the last edit (typing produces many) */
  schedule(delay = 1200) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.kick(), delay);
  }

  sync(): Promise<void> {
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
    if (!navigator.onLine) {
      this.setState('offline');
      return;
    }
    this.setState('syncing');
    try {
      await this.push();
      const firstPull = (await this.db.get('meta', 'cursor')) === undefined;
      await this.pull();
      if (firstPull && !this.notes.has(this.foldersNoteId())) await this.seed();
      if (this.pendingCount() > 0) await this.push();
      this.lastSync = Date.now();
      this.setState('idle');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        this.setState('error', 'Abgemeldet');
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

  /** First start of a new space: PARA folders, Zettelkasten and a welcome note */
  private async seed() {
    await this.setFolders([...this.storedFolders(), ...DEFAULT_FOLDERS]);
    for (const w of welcomeNotes()) await this.insert(w.folder, w.title, w.content);
  }

  private async push() {
    const dirty = [...this.notes.values()].filter((n) => n.dirty);
    if (!dirty.length) return;
    const { results } = await api<PushResponse>('/sync', {
      method: 'POST',
      json: {
        changes: dirty.map((n) => ({ id: n.id, baseVersion: n.version, path: n.path, content: n.content, deleted: n.deleted, createdAt: n.createdAt, updatedAt: n.updatedAt })),
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
        } else await this.put({ ...current, version: r.version, dirty: !unchanged });
      } else if (r.status === 'conflict') {
        await this.resolveConflict(current, r.server);
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
    await this.accept(server);
    if (local.deleted || local.content === server.content) return;
    const { folder, name } = splitPath(server.deleted ? local.path : server.path);
    const stamp = new Date().toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }).replace(/[/:]/g, '-');
    await this.insert(server.access === 'owner' ? folder : DEFAULT_FOLDERS[0], `${name} (Konflikt ${stamp})`, local.content);
  }
}

function cleanFolder(path: string): string {
  return path
    .split('/')
    .map((p) => p.trim().replace(/[\\]/g, '-'))
    .filter((p) => p && p !== '.' && p !== '..')
    .join('/');
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
