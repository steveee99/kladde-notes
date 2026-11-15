import {
  LinkIndex,
  SYSTEM_PREFIX,
  confluenceFolderBody,
  extractMeta,
  markdownToConfluence,
  runQuery,
  type ConfluenceNoteState,
  type ConfluenceOverview,
  type ConfluenceSyncInfo,
  type ConfluenceSyncInput,
  type SyncedNote,
} from '@kladde/shared';
import type { NoteChangeEvent, NoteStore } from '../NoteStore.js';
import type { FileStore } from '../FileStore.js';
import { taskDueOf } from '../mcp/tools.js';
import { ConfluenceClient, ConfluenceError, type HttpTransport } from './ConfluenceClient.js';
import { ConfluencePageRecord, ConfluenceStore, ConfluenceSyncRecord } from './ConfluenceStore.js';

/** Edits are pushed this long after the last change of a note */
export const DEFAULT_DEBOUNCE_MS = 30_000;
const FILE_ID_RE = /^\/api\/files\/([A-Za-z0-9_-]{22})(?:[?#].*)?$/;

export interface ConfluenceSyncOptions {
  transport: HttpTransport;
  debounceMs?: number;
}

const folderOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const lastSegment = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

/**
 * One-way sync of notes and folders to Confluence (#48). Kladde is the source: pages are created and
 * updated from the notes and never read back. Edits are pushed debounced in the background, "Sync now"
 * runs right away. A page that was changed in Confluence since our last update is not overwritten
 * without `force` (the note shows a conflict).
 */
export class ConfluenceSync {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Jobs run one after another per user (a folder sync and a note edit must not race) */
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly debounceMs: number;

  constructor(
    readonly store: ConfluenceStore,
    private readonly notes: NoteStore,
    private readonly files: FileStore,
    private readonly opts: ConfluenceSyncOptions
  ) {
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  get transport(): HttpTransport {
    return this.opts.transport;
  }

  client(userId: string): ConfluenceClient | null {
    const account = this.store.account(userId);
    return account ? new ConfluenceClient(account, this.opts.transport) : null;
  }

  private ownNotes(userId: string): SyncedNote[] {
    return this.notes.ownedNotes(userId).filter((n) => !n.path.startsWith(SYSTEM_PREFIX));
  }

  private inFolder(sync: ConfluenceSyncRecord, note: { id: string; path: string }): boolean {
    return sync.kind === 'folder' && !!sync.folder && note.path.startsWith(`${sync.folder}/`) && !sync.excluded.includes(note.id);
  }

  /** The sync a note belongs to: its mapping, else a folder sync that contains it */
  private syncFor(userId: string, note: { id: string; path: string }, record: ConfluencePageRecord | null): ConfluenceSyncRecord | null {
    if (record) return this.store.sync(userId, record.syncId);
    return this.store.syncs(userId).find((s) => (s.kind === 'note' && s.noteId === note.id) || this.inFolder(s, note)) ?? null;
  }

  // ---------------------------------------------------------------- jobs

  private enqueue<T>(userId: string, job: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(userId) ?? Promise.resolve();
    const next = prev.then(job, job);
    const tail = next.catch(() => undefined);
    this.chains.set(userId, tail);
    void tail.then(() => this.chains.get(userId) === tail && this.chains.delete(userId));
    return next;
  }

  /** Resolves when no job and no debounced push is waiting (tests) */
  async idle(): Promise<void> {
    while (this.chains.size || this.timers.size) {
      if (this.timers.size) {
        for (const [key, timer] of this.timers) {
          clearTimeout(timer);
          this.timers.delete(key);
          const [userId, noteId] = key.split('\n');
          void this.enqueue(userId, () => this.syncNoteById(userId, noteId, false));
        }
      }
      await Promise.all([...this.chains.values()]);
    }
  }

  private schedule(userId: string, noteId: string): void {
    const key = `${userId}\n${noteId}`;
    const prev = this.timers.get(key);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.enqueue(userId, () => this.syncNoteById(userId, noteId, false)).catch((err) => console.error('Confluence sync failed:', err));
    }, this.debounceMs);
    timer.unref();
    this.timers.set(key, timer);
  }

  /** Called for every accepted note change (NoteStore listener) */
  onNoteChange(event: NoteChangeEvent): void {
    if (event.path.startsWith(SYSTEM_PREFIX) || !this.store.hasAccount(event.ownerId)) return;
    const record = this.store.page(event.noteId);
    if (event.deleted) {
      if (!record) return;
      const sync = this.store.sync(event.ownerId, record.syncId);
      if (sync?.trashOnDelete) void this.enqueue(event.ownerId, () => this.dropPage(event.ownerId, record, true)).catch(() => undefined);
      return;
    }
    if (record || this.syncFor(event.ownerId, { id: event.noteId, path: event.path }, null)) this.schedule(event.ownerId, event.noteId);
  }

  // ---------------------------------------------------------------- API

  createSync(userId: string, input: ConfluenceSyncInput): ConfluenceSyncRecord {
    const spaceKey = String(input.spaceKey ?? '').trim();
    if (!/^[A-Za-z0-9~_-]{1,255}$/.test(spaceKey)) throw new ConfluenceError('Bitte einen Bereich (Space) wählen.');
    const parentId = input.parentId ? String(input.parentId) : null;
    if (parentId && !/^\d{1,30}$/.test(parentId)) throw new ConfluenceError('Ungültige übergeordnete Seite.');
    const own = this.ownNotes(userId);
    const base = { spaceKey, parentId, parentTitle: input.parentTitle ? String(input.parentTitle).slice(0, 255) : null, trashOnDelete: input.trashOnDelete === true };
    if (input.kind === 'note') {
      const note = own.find((n) => n.id === input.noteId);
      // Only the owner sets up a sync: shared notes are never synced on someone else's behalf
      if (!note) throw new ConfluenceError('Nur eigene Notizen lassen sich synchronisieren.', 404);
      const record = this.store.page(note.id);
      if (record) throw new ConfluenceError('Diese Notiz wird schon synchronisiert.', 409);
      return this.store.createSync(userId, { kind: 'note', noteId: note.id, folder: null, ...base });
    }
    // Split instead of a trimming regex: linear for any input (also collapses double slashes)
    const folder = String(input.folder ?? '').split('/').filter(Boolean).join('/');
    if (!folder || folder.startsWith(SYSTEM_PREFIX.slice(0, -1)) || folder.split('/').some((p) => p === '..' || p === '.')) throw new ConfluenceError('Ungültiger Ordner.');
    if (this.store.syncs(userId).some((s) => s.kind === 'folder' && s.folder === folder)) throw new ConfluenceError('Dieser Ordner wird schon synchronisiert.', 409);
    return this.store.createSync(userId, { kind: 'folder', noteId: null, folder, ...base });
  }

  /** Sync now: a whole sync (all its notes) */
  runSync(userId: string, syncId: string, force = false): Promise<void> {
    return this.enqueue(userId, async () => {
      const sync = this.store.sync(userId, syncId);
      if (!sync) throw new ConfluenceError('Synchronisierung nicht gefunden.', 404);
      const own = this.ownNotes(userId);
      if (sync.kind === 'note') {
        const note = own.find((n) => n.id === sync.noteId);
        if (note) await this.syncNote(userId, sync, note, force, own);
        return;
      }
      const client = this.client(userId);
      if (!client) throw new ConfluenceError('Keine Verbindung zu Confluence eingerichtet.');
      const members = own.filter((n) => this.inFolder(sync, n)).sort((a, b) => a.path.localeCompare(b.path));
      await this.folderPage(client, sync, '');
      for (const note of members) await this.syncNote(userId, sync, note, force, own);
      // Notes that left the folder (moved or deleted): their page stays unless the sync trashes it
      const memberIds = new Set(members.map((n) => n.id));
      for (const record of this.store.pages(userId).filter((p) => p.syncId === sync.id && !memberIds.has(p.noteId))) {
        await this.dropPage(userId, record, sync.trashOnDelete);
      }
    });
  }

  /** Sync now / overwrite after a conflict: one note */
  runNote(userId: string, noteId: string, force = false): Promise<void> {
    return this.enqueue(userId, () => this.syncNoteById(userId, noteId, force));
  }

  /** "Stop syncing this note": the page stays in Confluence */
  stopNote(userId: string, noteId: string): boolean {
    const record = this.store.page(noteId);
    if (!record || record.userId !== userId) return false;
    const sync = this.store.sync(userId, record.syncId);
    if (sync?.kind === 'note') this.store.deleteSync(userId, sync.id);
    else {
      if (sync && !sync.excluded.includes(noteId)) this.store.updateSync({ ...sync, excluded: [...sync.excluded, noteId] });
      this.store.deletePage(noteId);
    }
    return true;
  }

  stopSync(userId: string, syncId: string): boolean {
    return this.store.deleteSync(userId, syncId);
  }

  noteState(userId: string, noteId: string): ConfluenceNoteState | null {
    const record = this.store.page(noteId);
    if (record && record.userId === userId) return this.toState(record);
    const note = this.ownNotes(userId).find((n) => n.id === noteId);
    const sync = note ? this.syncFor(userId, note, null) : null;
    return sync ? { noteId, syncId: sync.id, pageId: null, pageUrl: null, status: 'pending', error: null, lastSyncAt: null } : null;
  }

  private toState(record: ConfluencePageRecord): ConfluenceNoteState {
    const client = this.client(record.userId);
    return {
      noteId: record.noteId,
      syncId: record.syncId,
      pageId: record.pageId,
      pageUrl: record.pageId && client ? client.pageUrl(record.pageId) : null,
      status: record.status,
      error: record.error,
      lastSyncAt: record.lastSyncAt,
    };
  }

  overview(userId: string): Omit<ConfluenceOverview, 'connection'> {
    const own = this.ownNotes(userId);
    const titles = new Map(own.map((n) => [n.id, extractMeta(n.path, n.content).title]));
    const pages = this.store.pages(userId);
    const client = this.client(userId);
    const syncs: ConfluenceSyncInfo[] = this.store.syncs(userId).map((s) => {
      const mine = pages.filter((p) => p.syncId === s.id);
      const pageId = s.kind === 'folder' ? (s.folderPages[''] ?? null) : (mine[0]?.pageId ?? null);
      const synced = mine.map((p) => p.lastSyncAt ?? 0).filter(Boolean);
      return {
        id: s.id,
        kind: s.kind,
        label: s.kind === 'folder' ? (s.folder ?? '') : (titles.get(s.noteId ?? '') ?? s.noteId ?? ''),
        noteId: s.noteId,
        folder: s.folder,
        spaceKey: s.spaceKey,
        parentId: s.parentId,
        parentTitle: s.parentTitle,
        trashOnDelete: s.trashOnDelete,
        createdAt: s.createdAt,
        pageUrl: pageId && client ? client.pageUrl(pageId) : null,
        notes: mine.length,
        errors: mine.filter((p) => p.status === 'error').length,
        conflicts: mine.filter((p) => p.status === 'conflict').length,
        lastSyncAt: synced.length ? Math.max(...synced) : null,
      };
    });
    const notes: ConfluenceOverview['notes'] = {};
    for (const s of this.store.syncs(userId)) {
      for (const n of own) if ((s.kind === 'note' && s.noteId === n.id) || this.inFolder(s, n)) notes[n.id] = 'pending';
    }
    for (const p of pages) notes[p.noteId] = p.status;
    return { syncs, notes };
  }

  /** After the start: pushes what changed while the server was down (unchanged notes cost no request) */
  catchUp(): void {
    for (const userId of this.store.usersWithAccount()) {
      for (const sync of this.store.syncs(userId)) void this.runSync(userId, sync.id).catch((err) => console.error('Confluence sync failed:', (err as Error).message));
    }
  }

  // ---------------------------------------------------------------- work

  private async syncNoteById(userId: string, noteId: string, force: boolean): Promise<void> {
    const own = this.ownNotes(userId);
    const note = own.find((n) => n.id === noteId);
    const record = this.store.page(noteId);
    if (!note) return;
    const sync = this.syncFor(userId, note, record);
    if (!sync) return;
    if (sync.kind === 'folder' && !this.inFolder(sync, note)) {
      // Moved out of the synced folder
      if (record) await this.dropPage(userId, record, sync.trashOnDelete);
      return;
    }
    await this.syncNote(userId, sync, note, force, own);
  }

  /** Removes the mapping; with `trash` the page goes to the Confluence trash too */
  private async dropPage(userId: string, record: ConfluencePageRecord, trash: boolean): Promise<void> {
    if (trash && record.pageId) {
      const client = this.client(userId);
      try {
        await client?.trashPage(record.pageId);
      } catch (err) {
        console.error('Confluence: page could not be moved to the trash:', (err as Error).message);
      }
    }
    this.store.deletePage(record.noteId);
  }

  /** Page id of a folder (relative to the synced folder), created on demand with its parents */
  private async folderPage(client: ConfluenceClient, sync: ConfluenceSyncRecord, rel: string): Promise<string | null> {
    const known = sync.folderPages[rel];
    if (known && (await client.page(known))) return known;
    const parent = rel === '' ? sync.parentId : await this.folderPage(client, sync, folderOf(rel));
    const title = lastSegment(rel === '' ? sync.folder! : rel);
    const page = await this.createUnique(client, { spaceKey: sync.spaceKey, parentId: parent, title, body: confluenceFolderBody() }, lastSegment(sync.folder!));
    sync.folderPages[rel] = page.id;
    this.store.updateSync(sync);
    return page.id;
  }

  /** Titles are unique per space: on a clash the page gets the synced folder's name as a suffix */
  private async createUnique(client: ConfluenceClient, input: { spaceKey: string; parentId: string | null; title: string; body: string }, suffix: string) {
    try {
      return await client.createPage(input);
    } catch (err) {
      if (!(err instanceof ConfluenceError) || err.status !== 400 || !/title/i.test(err.message) || !suffix) throw err;
      return client.createPage({ ...input, title: `${input.title} (${suffix})` });
    }
  }

  private async syncNote(userId: string, sync: ConfluenceSyncRecord, note: SyncedNote, force: boolean, own: SyncedNote[]): Promise<void> {
    const existing = this.store.page(note.id);
    if (existing && existing.syncId !== sync.id) return;
    const record: ConfluencePageRecord = existing ?? {
      noteId: note.id,
      userId,
      syncId: sync.id,
      pageId: null,
      title: '',
      parentId: null,
      pageVersion: 0,
      noteVersion: 0,
      status: 'pending',
      error: null,
      lastSyncAt: null,
      attachments: {},
      labels: [],
    };
    const client = this.client(userId);
    if (!client) return;
    try {
      const parentId = sync.kind === 'folder' ? await this.folderPage(client, sync, note.path.slice(sync.folder!.length + 1).includes('/') ? folderOf(note.path.slice(sync.folder!.length + 1)) : '') : sync.parentId;
      if (!force && record.status === 'ok' && record.noteVersion === note.version && record.parentId === parentId) return;

      const page = this.convert(userId, sync, note, own, record);
      let remote = record.pageId ? await client.page(record.pageId) : null;
      if (record.pageId && !remote && !force) {
        this.store.savePage({ ...record, status: 'error', error: 'Die Seite wurde in Confluence gelöscht. „Jetzt synchronisieren“ legt sie neu an.' });
        return;
      }
      if (remote && remote.version > record.pageVersion && !force) {
        this.store.savePage({ ...record, status: 'conflict', error: 'Die Seite wurde in Confluence geändert. Überschreiben oder die Synchronisierung beenden?' });
        return;
      }
      const suffix = sync.folder ? lastSegment(sync.folder) : '';
      // Keep a title that got a suffix because of a clash, as long as the note's title did not change
      let title = record.title && record.title !== page.title && record.title.startsWith(`${page.title} (`) ? record.title : page.title;
      if (!remote) {
        const created = await this.createUnique(client, { spaceKey: sync.spaceKey, parentId, title: page.title, body: page.body }, suffix);
        record.pageId = created.id;
        record.attachments = {};
        record.labels = [];
        remote = created;
        title = created.title || title;
        // A new page needs its attachments, so the body is written again below
      }
      for (const att of page.attachments) {
        const file = this.files.load(att.fileId);
        if (!file) continue;
        const known = record.attachments[att.fileId];
        if (known && known.filename === att.filename && known.size === file.data.length) continue;
        await client.putAttachment(record.pageId!, att.filename, file.mime, file.data);
        record.attachments[att.fileId] = { filename: att.filename, size: file.data.length };
      }
      const current = (await client.page(record.pageId!)) ?? remote;
      const update = (t: string) => client.updatePage(record.pageId!, { spaceKey: sync.spaceKey, parentId, title: t, body: page.body, version: current.version + 1 });
      let updated;
      try {
        updated = await update(title);
      } catch (err) {
        // Renamed onto a title that exists in the space
        if (!(err instanceof ConfluenceError) || err.status !== 400 || !/title/i.test(err.message) || !suffix || title !== page.title) throw err;
        updated = await update(`${page.title} (${suffix})`);
      }
      const newLabels = page.labels.filter((l) => !record.labels.includes(l));
      if (newLabels.length) await client.addLabels(record.pageId!, newLabels);
      this.store.savePage({
        ...record,
        title: updated.title || page.title,
        parentId,
        pageVersion: updated.version,
        noteVersion: note.version,
        status: 'ok',
        error: null,
        lastSyncAt: Date.now(),
        labels: [...new Set([...record.labels, ...page.labels])],
      });
    } catch (err) {
      const message = err instanceof ConfluenceError ? err.message : `Synchronisierung fehlgeschlagen (${(err as Error).message}).`;
      this.store.savePage({ ...record, status: 'error', error: message });
    }
  }

  private convert(userId: string, sync: ConfluenceSyncRecord, note: SyncedNote, own: SyncedNote[], record: ConfluencePageRecord) {
    const index = new LinkIndex(own);
    const names = new Map<string, string>();
    const used = new Set<string>();
    const dueOf = taskDueOf(this.notes, userId);
    return markdownToConfluence(note.path, note.content, {
      spaceKey: sync.spaceKey,
      linkTitle: (target) => {
        const id = index.resolve(target);
        if (!id || id === note.id) return id === note.id ? record.title || null : null;
        const target_ = this.store.page(id);
        return target_?.pageId && target_.userId === userId && target_.status !== 'error' ? target_.title : null;
      },
      attachment: (url) => {
        const m = FILE_ID_RE.exec(url);
        const meta = m ? this.files.meta(m[1]) : null;
        if (!meta || !/^(image\/|application\/pdf$|audio\/)/.test(meta.mime)) return null;
        let filename = names.get(meta.id);
        if (!filename) {
          filename = meta.name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').trim() || `datei-${meta.id.slice(0, 6)}`;
          if (used.has(filename.toLowerCase())) {
            const dot = filename.lastIndexOf('.');
            filename = dot > 0 ? `${filename.slice(0, dot)}-${meta.id.slice(0, 6)}${filename.slice(dot)}` : `${filename}-${meta.id.slice(0, 6)}`;
          }
          used.add(filename.toLowerCase());
          names.set(meta.id, filename);
        }
        return { fileId: meta.id, filename, mime: meta.mime };
      },
      query: (src) => runQuery(src, own, new Date(), { defaultDue: dueOf }),
    });
  }
}
