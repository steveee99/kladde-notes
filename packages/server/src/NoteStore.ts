import { DatabaseSync } from 'node:sqlite';
import { GroupInfo, GroupMoveRequest, GroupRole, canWriteInGroup, groupMovePath, NoteRelease, NoteReleaseInfo, ReleaseBump, NoteVersion, NoteVersionInfo, FolderPermissions, FolderShares, NoteAccess, NoteShare, NoteShares, PublicNote, type PublicSiteNote, isHiddenPath, PullResponse, PushChange, PushResult, SharedFolder, SYSTEM_PREFIX, SyncedNote, TrashEntry, MAX_NOTE_BYTES, MAX_EMBED_DEPTH, LinkIndex, PublicEmbed, cleanPath, cleanReleaseNote, assignTicketNumber, canTransition, isSchemaPath, isTicketContent, parseProject, runAutomations, setTicketFields, hasVariables, isVariablesPath, isNoteTypePath, noteTypesOf, findNoteType, customTypeOf, writeNoteType, propertyPosition, type NoteType, usedVariables, variableDefinitions, variableScope, type VariableDefinitions, type VariableScope, subtaskProgress, ticketEvents, ticketMeta, workflowStatus, type ProjectConfig, contentHash, embedsOf, extractMeta, numberedTicketId, parseGroupFeatures, fillReleasePlaceholders, formatSemVer, nextVersion, parseSemVer, publicRemoteContent, remoteNoteOf, type RemoteSource, type RemoteSnapshot, splitPath, renameWikiLinks } from '@kladde/shared';
import { DataCipher, randomToken } from './crypto.js';
import { transaction } from './db.js';

export { MAX_NOTE_BYTES, cleanPath };
/** A pause this long starts a new version; saves closer together update the newest one (a writing session is one version) */
export const VERSION_PAUSE_MS = 10 * 60 * 1000;
/** Even without a pause, a version never grows beyond this span */
export const VERSION_MAX_SPAN_MS = 60 * 60 * 1000;
/** Older versions of a note are dropped beyond this many */
export const MAX_VERSIONS = 100;
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

interface NoteRow {
  id: string;
  owner_id: string;
  version: number;
  seq: number;
  created_at: number;
  updated_at: number;
  deleted: number;
  payload: Uint8Array;
}

interface VersionRow {
  id: string;
  note_id: string;
  created_at: number;
  saved_at: number;
  payload: Uint8Array;
}

interface Payload {
  path: string;
  content: string;
}

interface TrashRow {
  note_id: string;
  owner_id: string;
  deleted_at: number;
  deleted_by: string | null;
  batch: string | null;
  payload: Uint8Array;
}

interface ReleaseRow {
  id: string;
  note_id: string;
  major: number;
  minor: number;
  patch: number;
  released_at: number;
  payload: Uint8Array;
}

/** What a release keeps (encrypted, `note_release:<id>` as AAD): the frozen text and who released it */
interface ReleasePayload {
  path: string;
  content: string;
  note: string;
  releasedBy: string;
}

/** A release was asked for on another state of the note than the server's (sync first) */
export class ReleaseConflict extends Error {
  constructor() {
    super('conflict');
  }
}

/** Releasing needs versioning to be turned on for the note */
export class VersioningOff extends Error {
  constructor() {
    super('versioning off');
  }
}

/** What the trash keeps of a deleted note (encrypted, the note id as AAD) */
interface TrashPayload {
  path: string;
  content: string;
  folder: string | null;
}

/** Restoring would overwrite a note that took the old path in the meantime */
export class TrashPathTaken extends Error {
  constructor(readonly suggestion: string) {
    super('path taken');
  }
}

/** `path` itself, or the first "Name 2.md", "Name 3.md", … that is not in `taken` */
export function freePath(path: string, taken: Set<string>): string {
  if (!taken.has(path)) return path;
  const { folder, name } = splitPath(path);
  for (let i = 2; ; i++) {
    const candidate = `${folder ? `${folder}/` : ''}${name} ${i}.md`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A catalog entry of online mode: no text, and no copy of a remote document either */
function lightEntry(n: SyncedNote): SyncedNote {
  const { remoteSnapshot: _s, ...rest } = n;
  return { ...rest, content: '', partial: true };
}

/** A folder share with the folder path decrypted */
interface FolderShare extends FolderPermissions {
  id: string;
  userId: string;
  folder: string;
}

/** Create or delete only make sense together with editing */
export function normalizePermissions(p: Partial<FolderPermissions>): FolderPermissions {
  const canCreate = !!p.canCreate;
  const canDelete = !!p.canDelete;
  return { canWrite: !!p.canWrite || canCreate || canDelete, canCreate, canDelete };
}

const rank = (f: FolderPermissions) => Number(f.canWrite) + Number(f.canCreate) + Number(f.canDelete);

/** True when the note at `path` lies in `folder` or one of its subfolders (system notes are never shared) */
export function inFolder(path: string, folder: string): boolean {
  return !path.startsWith(SYSTEM_PREFIX) && path.startsWith(`${folder}/`);
}

/** Called after every accepted change: who should hear about it (live update, export) */
export interface NoteChangeEvent {
  noteId: string;
  ownerId: string;
  /** Everybody who can see the note (owner and share recipients) */
  audience: string[];
  path: string;
  previousPath: string | null;
  content: string;
  deleted: boolean;
  /** Who made the change (activity feed, #70) */
  actorId?: string;
  /** The text before the change ('' for a new note): new @mentions are the difference (#69) */
  previousContent?: string;
  /** Changes that are not a plain edit: a restore from the trash or a new release (with its version) */
  action?: 'restored' | 'released';
  version?: string;
}

/**
 * Notes are stored encrypted (path and content); the server only sees ids, versions and timestamps.
 * Every change gets the next value of a global sequence, so a client asks for "everything after N".
 */
export class NoteStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly cipher: DataCipher,
    private readonly onChange: (event: NoteChangeEvent) => void = () => {}
  ) {}

  private nextSeq(): number {
    const row = this.db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'seq' RETURNING value").get() as { value: number };
    return row.value;
  }

  currentSeq(): number {
    return (this.db.prepare("SELECT value FROM counters WHERE name = 'seq'").get() as { value: number }).value;
  }

  private payload(row: NoteRow): Payload {
    return this.cipher.decryptJson<Payload>(row.payload, `note:${row.id}`);
  }

  private toSynced(row: NoteRow, access: NoteAccess, owner?: string, ownerAvatar?: string | null): SyncedNote {
    const p = this.payload(row);
    const note: SyncedNote = {
      id: row.id,
      path: p.path,
      content: p.content,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deleted: !!row.deleted,
      access,
      ...(owner ? { owner } : {}),
      ...(ownerAvatar ? { ownerAvatar: `/api/avatars/${ownerAvatar}` } : {}),
    };
    if (row.deleted) return note;
    if (!this.versioningOn(row.id)) return this.withRemoteSnapshot(note);
    // Release versioning (#53): readers see the latest release, owner and editors work on the draft
    const rows = this.releaseRows(row.id);
    note.versioning = true;
    note.releases = rows.map((r) => this.releaseInfo(r));
    if (rows[0]) {
      const latest = this.releasePayload(rows[0]);
      note.releaseHash = contentHash(latest.content);
      if (access === 'read') {
        note.content = latest.content;
        note.showsRelease = note.releases[0].version;
      }
    }
    return this.withRemoteSnapshot(note);
  }

  /** Kept copies of synced remote notes (`RemoteSnapshotStore`), set when the server syncs them */
  remoteSnapshots: { current(noteId: string, content: string): RemoteSnapshot | null } | null = null;

  /** A synced remote note travels with the copy of its document, so devices search and show it without a connection */
  private withRemoteSnapshot(note: SyncedNote): SyncedNote {
    const snap = this.remoteSnapshots?.current(note.id, note.content);
    if (snap) note.remoteSnapshot = snap;
    return note;
  }

  /** A new seq without a new version, from outside (a synced remote note's copy changed): devices pull the note again */
  touchNote(noteId: string): void {
    const row = this.getRow(noteId);
    if (!row || row.deleted) return;
    this.onChange(this.touch(row));
  }

  /** The source of a remote note as stored (its owner's view), with the space and folder its variables come from */
  storedRemoteSource(noteId: string): { source: RemoteSource; ownerId: string; folder: string } | null {
    const row = this.getRow(noteId);
    if (!row || row.deleted) return null;
    const p = this.payload(row);
    const source = remoteNoteOf(p.content);
    return source && { source, ownerId: row.owner_id, folder: splitPath(p.path).folder };
  }

  /** The user's role in a group (#58), null when `groupId` is no group or they are not a member */
  groupRole(groupId: string, userId: string): GroupRole | null {
    const row = this.db.prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId) as { role: GroupRole } | undefined;
    return row?.role ?? null;
  }

  /** Username of an account (for "assigned to me") */
  usernameOf(userId: string): string | null {
    return (this.db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined)?.username ?? null;
  }

  /** Groups the user is a member of, by name */
  groupsOf(userId: string): GroupInfo[] {
    const rows = this.db
      .prepare('SELECT users.id, users.username, users.group_features, group_members.role FROM group_members JOIN users ON users.id = group_members.group_id WHERE group_members.user_id = ?')
      .all(userId) as { id: string; username: string; group_features: string | null; role: GroupRole }[];
    return rows
      .map((r) => ({ id: r.id, name: r.username, role: r.role, features: parseGroupFeatures(r.group_features) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'de') || a.id.localeCompare(b.id));
  }

  // ------------------------------------------------------------------ ticket numbers

  /** The next ticket number of a project key in an owner's space (a user or a group) */
  private nextTicketNumber(ownerId: string, key: string): number {
    const mac = this.cipher.mac(key, 'ticket-key');
    const row = this.db.prepare('SELECT value FROM ticket_counters WHERE owner_id = ? AND key_mac = ?').get(ownerId, mac) as { value: number } | undefined;
    const next = (row ? row.value : this.highestTicketNumber(ownerId, key)) + 1;
    this.db
      .prepare('INSERT INTO ticket_counters (owner_id, key_mac, value) VALUES (?, ?, ?) ON CONFLICT(owner_id, key_mac) DO UPDATE SET value = excluded.value')
      .run(ownerId, mac, next);
    return next;
  }

  /** Before the first number of a key: the highest one already used in the owner's notes and trash (imports, older notes) */
  private highestTicketNumber(ownerId: string, key: string): number {
    let max = 0;
    const rows = this.db.prepare('SELECT * FROM notes WHERE owner_id = ? AND deleted = 0').all(ownerId) as unknown as NoteRow[];
    for (const content of [...rows.map((r) => this.payload(r).content), ...this.trashedContents(ownerId)]) {
      const id = numberedTicketId(content);
      if (id && id.key === key) max = Math.max(max, id.number);
    }
    return max;
  }

  /** A ticket that arrives with a number above the counter (written by hand or imported) moves the counter up */
  private observeTicketNumber(ownerId: string, content: string): void {
    const id = numberedTicketId(content);
    if (!id) return;
    const mac = this.cipher.mac(id.key, 'ticket-key');
    const row = this.db.prepare('SELECT value FROM ticket_counters WHERE owner_id = ? AND key_mac = ?').get(ownerId, mac) as { value: number } | undefined;
    if (row && row.value >= id.number) return;
    const value = Math.max(id.number, row ? row.value : this.highestTicketNumber(ownerId, id.key));
    this.db.prepare('INSERT INTO ticket_counters (owner_id, key_mac, value) VALUES (?, ?, ?) ON CONFLICT(owner_id, key_mac) DO UPDATE SET value = excluded.value').run(ownerId, mac, value);
  }

  // ------------------------------------------------------------------ ticket workflows

  /** Projects (database notes with a `project` block) per owner and folder; dropped when a database note changes */
  private projectCache = new Map<string, Map<string, { id: string; config: ProjectConfig }>>();
  /** Last workflow status of a ticket, so typing a status by hand (unknown values in between) is still checked */
  private lastStatus = new Map<string, string>();

  private projectsOf(ownerId: string): Map<string, { id: string; config: ProjectConfig }> {
    let found = this.projectCache.get(ownerId);
    if (found) return found;
    found = new Map();
    const rows = this.db.prepare('SELECT * FROM notes WHERE owner_id = ? AND deleted = 0 ORDER BY created_at, id').all(ownerId) as unknown as NoteRow[];
    for (const r of rows) {
      const p = this.payload(r);
      if (!isSchemaPath(p.path)) continue;
      const config = parseProject(p.content);
      const folder = splitPath(p.path).folder;
      if (config && !found.has(folder)) found.set(folder, { id: r.id, config });
    }
    this.projectCache.set(ownerId, found);
    return found;
  }

  /** Ids of the database notes that make the owner's ticket projects */
  projectIdsOf(ownerId: string): string[] {
    return [...this.projectsOf(ownerId).values()].map((p) => p.id);
  }

  /** The project of a database note (live), with its folder and owner */
  projectOf(noteId: string): { ownerId: string; folder: string; config: ProjectConfig } | null {
    const row = ID_PATTERN.test(noteId) ? this.getRow(noteId) : undefined;
    if (!row || row.deleted) return null;
    const p = this.payload(row);
    const config = isSchemaPath(p.path) ? parseProject(p.content) : null;
    return config ? { ownerId: row.owner_id, folder: splitPath(p.path).folder, config } : null;
  }

  /**
   * A ticket arrives: a status change the project's transitions do not allow is undone (unless the change comes
   * from an automation, `trusted`), then the project's automations run for creation, status change and finished
   * sub-tasks. Other notes and tickets outside projects stay as they are.
   */
  private applyWorkflow(ownerId: string, noteId: string, path: string, previous: string | null, content: string, actorId: string, trusted: boolean): { content: string; rejectedStatus?: string; automations?: string[] } {
    if (!isTicketContent(content)) {
      this.lastStatus.delete(noteId);
      return { content };
    }
    const project = this.projectsOf(ownerId).get(splitPath(path).folder)?.config;
    if (!project) return { content };
    const before = previous !== null && isTicketContent(previous) ? ticketMeta(previous) : null;
    const from = before ? (workflowStatus(project.workflow, before.status) ?? this.lastStatus.get(noteId) ?? before.status) : null;
    let status = ticketMeta(content).status;
    let rejectedStatus: string | undefined;
    const to = workflowStatus(project.workflow, status);
    if (from !== null && to && !trusted && !canTransition(project, from, to)) {
      content = setTicketFields(content, { status: from });
      rejectedStatus = to;
      status = from;
    }
    // A status outside the workflow (typed half-way) is no change yet
    const next = workflowStatus(project.workflow, status) ?? from ?? status;
    const events = ticketEvents(before && from !== null ? { status: from, progress: subtaskProgress(previous!) } : null, { status: next, progress: subtaskProgress(content) });
    const run = runAutomations(project, content, events, { actor: this.usernameOf(actorId) ?? undefined });
    content = run.content;
    const final = workflowStatus(project.workflow, ticketMeta(content).status);
    if (final) this.lastStatus.set(noteId, final);
    return { content, ...(rejectedStatus ? { rejectedStatus } : {}), ...(run.applied.length ? { automations: run.applied.map((a) => a.name || a.id) } : {}) };
  }

  /** Numbers a provisional ticket (`KLD-?`) of `ownerId`; the content unchanged when it is none */
  private numberTicket(ownerId: string, content: string): string {
    if (!content.startsWith('---')) return content;
    const numbered = assignTicketNumber(content, (key) => this.nextTicketNumber(ownerId, key));
    if (numbered) return numbered;
    this.observeTicketNumber(ownerId, content);
    return content;
  }

  private groupName(groupId: string): string {
    return (this.db.prepare('SELECT username FROM users WHERE id = ? AND is_group = 1').get(groupId) as { username: string } | undefined)?.username ?? '';
  }

  /** A note as `userId` sees it: group notes (#58) carry the group, its name as owner and the delete permission */
  private syncedFor(row: NoteRow, userId: string, access: NoteAccess): SyncedNote {
    if (row.owner_id === userId) return this.toSynced(row, access);
    const role = this.groupRole(row.owner_id, userId);
    if (!role) return this.toSynced(row, access);
    return { ...this.toSynced(row, access, this.groupName(row.owner_id)), group: row.owner_id, ...(canWriteInGroup(role) ? { canDelete: true } : {}) };
  }

  /** Owner, or a writing member of the group that owns the note: may rename, move and delete it, and manage its releases */
  private canManage(row: NoteRow, userId: string): boolean {
    return row.owner_id === userId || canWriteInGroup(this.groupRole(row.owner_id, userId));
  }

  // ------------------------------------------------------------------ variables

  /** Variable definitions per owner (user or group); dropped when a definition note changes */
  private variableCache = new Map<string, VariableDefinitions>();

  /** The variables (`{{var:name}}`) the notes in `folder` of this owner see */
  variablesOf(ownerId: string, folder: string): VariableScope {
    let definitions = this.variableCache.get(ownerId);
    if (!definitions) {
      const rows = this.db.prepare('SELECT * FROM notes WHERE owner_id = ? AND deleted = 0').all(ownerId) as unknown as NoteRow[];
      const found: Payload[] = [];
      for (const r of rows) {
        const p = this.payload(r);
        if (isVariablesPath(p.path)) found.push(p);
      }
      definitions = variableDefinitions(found);
      this.variableCache.set(ownerId, definitions);
    }
    return variableScope(folder, definitions);
  }

  /** The values a public page needs: only of the variables the text uses */
  private publicVariables(ownerId: string, path: string, content: string): { variables?: Record<string, string> } {
    if (!hasVariables(content)) return {};
    const variables = usedVariables(content, this.variablesOf(ownerId, splitPath(path).folder));
    return Object.keys(variables).length ? { variables } : {};
  }

  // ------------------------------------------------------------------ custom note types

  /** Custom note types per owner (user or group); dropped when a definition note changes */
  private typeCache = new Map<string, NoteType[]>();

  noteTypesOf(ownerId: string): NoteType[] {
    let types = this.typeCache.get(ownerId);
    if (!types) {
      const rows = this.db.prepare('SELECT * FROM notes WHERE owner_id = ? AND deleted = 0').all(ownerId) as unknown as NoteRow[];
      types = noteTypesOf(rows.map((r) => this.payload(r)).filter((p) => isNoteTypePath(p.path)));
      this.typeCache.set(ownerId, types);
    }
    return types;
  }

  /** The definition a public page needs to show the note's properties as modelled: only what guests see, without options, defaults and former names */
  private publicNoteType(ownerId: string, content: string): { noteType?: string } {
    const name = customTypeOf(content);
    const type = name === null ? null : findNoteType(this.noteTypesOf(ownerId), name);
    if (!type) return {};
    const properties = type.properties.filter((p) => propertyPosition(type, p) !== 'hidden').map((p) => ({ ...p, options: [], default: '' }));
    return { noteType: writeNoteType('', { ...type, aliases: [], properties }) };
  }

  // ------------------------------------------------------------------ release versioning (#53)

  private versioningOn(noteId: string): boolean {
    const row = this.db.prepare('SELECT enabled FROM note_versioning WHERE note_id = ?').get(noteId) as { enabled: number } | undefined;
    return !!row?.enabled;
  }

  /** Newest version first */
  private releaseRows(noteId: string): ReleaseRow[] {
    return this.db.prepare('SELECT * FROM note_releases WHERE note_id = ? ORDER BY major DESC, minor DESC, patch DESC').all(noteId) as unknown as ReleaseRow[];
  }

  private releasePayload(r: ReleaseRow): ReleasePayload {
    return this.cipher.decryptJson<ReleasePayload>(r.payload, `note_release:${r.id}`);
  }

  private releaseInfo(r: ReleaseRow, p: ReleasePayload = this.releasePayload(r)): NoteReleaseInfo {
    return { version: formatSemVer(r), releasedAt: r.released_at, releasedBy: p.releasedBy, note: p.note };
  }

  /**
   * What exports show of a note (export mirror, Confluence, public links): with versioning on, the latest
   * release (the draft while there is none) with the placeholders filled in; otherwise the note as it is.
   */
  private published(noteId: string, draft: string): string {
    if (!this.versioningOn(noteId)) return draft;
    const rows = this.releaseRows(noteId);
    const payloads = rows.map((r) => this.releasePayload(r));
    const content = payloads[0]?.content ?? draft;
    return fillReleasePlaceholders(
      content,
      rows.map((r, i) => this.releaseInfo(r, payloads[i]))
    );
  }

  /** Turns release versioning on or off (only the owner). Turning it off keeps the releases for later. */
  setVersioning(userId: string, noteId: string, enabled: boolean): SyncedNote {
    const events: NoteChangeEvent[] = [];
    const note = transaction(this.db, () => {
      const row = this.manageableRow(userId, noteId);
      if (this.versioningOn(noteId) !== enabled) {
        const now = Date.now();
        this.db
          .prepare('INSERT INTO note_versioning (note_id, enabled, updated_at) VALUES (?, ?, ?) ON CONFLICT(note_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at')
          .run(noteId, enabled ? 1 : 0, now);
        events.push(this.touch(row));
      }
      const fresh = this.getRow(noteId)!;
      return this.syncedFor(fresh, userId, fresh.owner_id === userId ? 'owner' : 'write');
    });
    for (const e of events) this.onChange(e);
    return note;
  }

  /**
   * Releases the note's current text as the next version (only the owner, with versioning on). `baseVersion`
   * is the note version the client saw: a release never freezes a text its author has not seen.
   */
  release(userId: string, noteId: string, opts: { bump: ReleaseBump; note?: unknown; baseVersion: number }): NoteReleaseInfo {
    const events: NoteChangeEvent[] = [];
    const info = transaction(this.db, () => {
      const row = this.manageableRow(userId, noteId);
      if (!this.versioningOn(noteId)) throw new VersioningOff();
      if (row.version !== opts.baseVersion) throw new ReleaseConflict();
      const latest = this.releaseRows(noteId)[0];
      const version = parseSemVer(nextVersion(latest ? formatSemVer(latest) : null, opts.bump))!;
      const { path, content } = this.payload(row);
      const user = this.db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined;
      const payload: ReleasePayload = { path, content, note: cleanReleaseNote(opts.note), releasedBy: user?.username ?? '' };
      const id = randomToken(12);
      const now = Date.now();
      this.db
        .prepare('INSERT INTO note_releases (id, note_id, major, minor, patch, released_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, noteId, version.major, version.minor, version.patch, now, this.cipher.encryptJson(payload, `note_release:${id}`));
      events.push({ ...this.touch(row), actorId: userId, action: 'released', version: formatSemVer(version) });
      return { version: formatSemVer(version), releasedAt: now, releasedBy: payload.releasedBy, note: payload.note };
    });
    for (const e of events) this.onChange(e);
    return info;
  }

  /** A new seq without a new version: every device pulls the note's release state again; exports follow */
  private touch(row: NoteRow): NoteChangeEvent {
    this.db.prepare('UPDATE notes SET seq = ? WHERE id = ?').run(this.nextSeq(), row.id);
    const p = this.payload(row);
    return { noteId: row.id, ownerId: row.owner_id, audience: this.audience(row), path: p.path, previousPath: p.path, content: this.published(row.id, p.content), deleted: false };
  }

  /** Releases of a note, newest first; anybody who can see the note may list them */
  releases(userId: string, noteId: string): NoteReleaseInfo[] {
    this.readableRow(userId, noteId);
    return this.releaseRows(noteId).map((r) => this.releaseInfo(r));
  }

  /** One released version with its frozen text */
  releaseOf(userId: string, noteId: string, version: string): NoteRelease {
    this.readableRow(userId, noteId);
    const v = parseSemVer(version);
    const r = v && (this.db.prepare('SELECT * FROM note_releases WHERE note_id = ? AND major = ? AND minor = ? AND patch = ?').get(noteId, v.major, v.minor, v.patch) as ReleaseRow | undefined);
    if (!r) throw new Error('not found');
    const p = this.releasePayload(r);
    return { ...this.releaseInfo(r, p), path: p.path, content: p.content };
  }

  private getRow(id: string): NoteRow | undefined {
    return this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined;
  }

  accessOf(userId: string, row: NoteRow): NoteAccess | null {
    if (row.owner_id === userId) return 'owner';
    const role = this.groupRole(row.owner_id, userId);
    if (role) return canWriteInGroup(role) ? 'write' : 'read';
    const share = this.db.prepare('SELECT can_write FROM shares WHERE note_id = ? AND user_id = ?').get(row.id, userId) as
      | { can_write: number }
      | undefined;
    return share ? (share.can_write ? 'write' : 'read') : null;
  }

  private audience(row: NoteRow): string[] {
    const shared = this.db.prepare('SELECT user_id FROM shares WHERE note_id = ?').all(row.id) as { user_id: string }[];
    const members = this.db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(row.owner_id) as { user_id: string }[];
    return [row.owner_id, ...shared.map((s) => s.user_id), ...members.map((m) => m.user_id)];
  }

  /** Path of a live note as its owner's space has it (in a group: inside the group), null otherwise */
  pathOf(noteId: string): string | null {
    const row = ID_PATTERN.test(noteId) ? this.getRow(noteId) : undefined;
    return row && !row.deleted ? this.payload(row).path : null;
  }

  /** The user owns the note or writes in the group that owns it (may rename, delete it and moderate its comments) */
  manages(userId: string, noteId: string): boolean {
    const row = ID_PATTERN.test(noteId) ? this.getRow(noteId) : undefined;
    return !!row && !row.deleted && this.canManage(row, userId);
  }

  /** The person who owns the note, or for a group note its owners and editors (who look after it) */
  keepersOf(noteId: string): string[] {
    const row = ID_PATTERN.test(noteId) ? this.getRow(noteId) : undefined;
    if (!row) return [];
    const writers = this.db.prepare("SELECT user_id FROM group_members WHERE group_id = ? AND role IN ('owner', 'editor')").all(row.owner_id) as { user_id: string }[];
    return writers.length ? writers.map((w) => w.user_id) : [row.owner_id];
  }

  /** Everybody who may see the note (owner and shares), or null for an unknown/deleted note; for live presence */
  audienceOf(noteId: string): string[] | null {
    if (!ID_PATTERN.test(noteId)) return null;
    const row = this.getRow(noteId);
    return row && !row.deleted ? this.audience(row) : null;
  }

  /**
   * Changes since `since`. `light` (online mode): notes come as catalog entries without their text (`partial`), only
   * system notes (settings, folders, templates) keep it; the device fetches a note's text with `fetchNotes`.
   */
  pull(userId: string, since: number, opts: { light?: boolean } = {}): PullResponse {
    const res = this.pullAll(userId, since, !!opts.light);
    if (!opts.light) return res;
    return { ...res, notes: res.notes.map((n) => (n.deleted || n.path.startsWith(SYSTEM_PREFIX) ? n : lightEntry(n))) };
  }

  /** Full notes the user may see, by id (deleted, unknown and foreign ones are left out) */
  fetchNotes(userId: string, ids: string[]): SyncedNote[] {
    const out: SyncedNote[] = [];
    for (const id of new Set(ids)) {
      if (typeof id !== 'string' || !ID_PATTERN.test(id)) continue;
      const row = this.getRow(id);
      const access = row && !row.deleted ? this.accessOf(userId, row) : null;
      if (row && access) out.push(this.syncedFor(row, userId, access));
    }
    return out;
  }

  /**
   * Online mode: after a rename every [[Old Title]] in the notes the user may edit points to the new title (the
   * device holds only the texts it opened, so the server rewrites them). Returns how many notes changed.
   */
  relink(userId: string, renamedId: string, oldName: string, newName: string): number {
    if (!oldName || !newName || oldName === newName) return 0;
    const rows = this.db
      .prepare(
        `SELECT * FROM notes WHERE owner_id = ? AND deleted = 0
         UNION SELECT notes.* FROM group_members JOIN notes ON notes.owner_id = group_members.group_id
           WHERE group_members.user_id = ? AND group_members.role IN ('owner', 'editor') AND notes.deleted = 0
         UNION SELECT notes.* FROM shares JOIN notes ON notes.id = shares.note_id WHERE shares.user_id = ? AND shares.can_write = 1 AND notes.deleted = 0`
      )
      .all(userId, userId, userId) as unknown as NoteRow[];
    const changes: PushChange[] = [];
    const now = Date.now();
    for (const row of rows) {
      if (row.id === renamedId) continue;
      const p = this.payload(row);
      if (p.path.startsWith(SYSTEM_PREFIX) || !p.content.includes('[[')) continue;
      const content = renameWikiLinks(p.content, oldName, newName);
      if (content !== p.content) changes.push({ id: row.id, baseVersion: row.version, path: p.path, content, deleted: false, createdAt: row.created_at, updatedAt: now });
    }
    let changed = 0;
    for (let i = 0; i < changes.length; i += 500) changed += this.push(userId, changes.slice(i, i + 500)).filter((r) => r.status === 'ok').length;
    return changed;
  }

  // ------------------------------------------------------------------ online mode: spaces for the server's indexes

  /** Highest seq and number of live notes of a space (a user's or a group's notes): the index refreshes when they move */
  spaceState(ownerId: string): { maxSeq: number; count: number } {
    const r = this.db.prepare('SELECT MAX(seq) AS maxSeq, SUM(deleted = 0) AS count FROM notes WHERE owner_id = ?').get(ownerId) as { maxSeq: number | null; count: number | null };
    return { maxSeq: r.maxSeq ?? 0, count: r.count ?? 0 };
  }

  /** The notes of a space changed after `since` (deleted ones without text), decrypted for the server's index */
  spaceChanges(ownerId: string, since: number): { id: string; path: string; content: string; remoteText?: string; createdAt: number; updatedAt: number; seq: number; deleted: boolean }[] {
    const rows = this.db.prepare('SELECT * FROM notes WHERE owner_id = ? AND seq > ? ORDER BY seq').all(ownerId, since) as unknown as NoteRow[];
    return rows.map((r) => {
      if (r.deleted) return { id: r.id, path: '', content: '', createdAt: r.created_at, updatedAt: r.updated_at, seq: r.seq, deleted: true };
      const p = this.payload(r);
      const remoteText = this.remoteSnapshots?.current(r.id, p.content)?.text;
      return { id: r.id, path: p.path, content: p.content, ...(remoteText ? { remoteText } : {}), createdAt: r.created_at, updatedAt: r.updated_at, seq: r.seq, deleted: false };
    });
  }

  /** Ids of the live notes of a space (notes moved to another space leave it without a new seq here) */
  spaceIds(ownerId: string): string[] {
    return (this.db.prepare('SELECT id FROM notes WHERE owner_id = ? AND deleted = 0').all(ownerId) as { id: string }[]).map((r) => r.id);
  }

  /**
   * The spaces a user sees: the own space, every group they are a member of, and the notes other users share with
   * them (only those ids of the owner's space)
   */
  visibleSpaces(userId: string): { ownerId: string; only?: Set<string> }[] {
    const groups = (this.db.prepare('SELECT group_id FROM group_members WHERE user_id = ?').all(userId) as { group_id: string }[]).map((g) => ({ ownerId: g.group_id }));
    const shared = new Map<string, Set<string>>();
    for (const r of this.db.prepare('SELECT notes.owner_id, notes.id FROM shares JOIN notes ON notes.id = shares.note_id WHERE shares.user_id = ? AND notes.deleted = 0').all(userId) as { owner_id: string; id: string }[]) {
      if (!shared.has(r.owner_id)) shared.set(r.owner_id, new Set());
      shared.get(r.owner_id)!.add(r.id);
    }
    return [{ ownerId: userId }, ...groups, ...[...shared].map(([ownerId, only]) => ({ ownerId, only }))];
  }

  /** The space (owner id) of a live note the user may see, null otherwise */
  spaceOf(userId: string, noteId: string): string | null {
    const row = ID_PATTERN.test(noteId) ? this.getRow(noteId) : undefined;
    return row && !row.deleted && this.accessOf(userId, row) ? row.owner_id : null;
  }

  /**
   * The source of a remote note as the user sees the note (readers of a versioned one: its latest release), with the
   * space and folder its variables come from; null when the user may not see it or it is no remote note.
   */
  remoteSource(userId: string, noteId: string): { source: RemoteSource; ownerId: string; folder: string } | null {
    const row = ID_PATTERN.test(noteId) ? this.getRow(noteId) : undefined;
    const access = row && !row.deleted ? this.accessOf(userId, row) : null;
    if (!row || !access) return null;
    const source = remoteNoteOf(this.syncedFor(row, userId, access).content);
    return source && { source, ownerId: row.owner_id, folder: splitPath(this.payload(row).path).folder };
  }

  /** Paths of catalog entries by note id and seq: a light pull decrypts only notes that changed since the last one */
  private catalogPaths = new Map<string, { seq: number; path: string }>();

  /** A note as a catalog entry (light pull): path, version and access from the cache when the note did not change */
  private catalogEntry(row: NoteRow, access: NoteAccess, owner?: string, ownerAvatar?: string | null): SyncedNote {
    const hit = this.catalogPaths.get(row.id);
    if (!hit || hit.seq !== row.seq || row.deleted) {
      const full = this.toSynced(row, access, owner, ownerAvatar);
      if (!row.deleted && !full.versioning) this.catalogPaths.set(row.id, { seq: row.seq, path: full.path });
      return full;
    }
    return {
      id: row.id,
      path: hit.path,
      content: '',
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deleted: false,
      access,
      ...(owner ? { owner } : {}),
      ...(ownerAvatar ? { ownerAvatar: `/api/avatars/${ownerAvatar}` } : {}),
    };
  }

  private pullAll(userId: string, since: number, light: boolean): PullResponse {
    const synced = light ? this.catalogEntry.bind(this) : this.toSynced.bind(this);
    const cursor = this.currentSeq();
    const own = this.db.prepare('SELECT * FROM notes WHERE owner_id = ? AND seq > ? ORDER BY seq').all(userId, since) as unknown as NoteRow[];
    const shared = this.db
      .prepare(
        `SELECT notes.*, shares.can_write, users.username AS owner_name, users.avatar_id AS owner_avatar, folder_shares.can_delete FROM shares
         JOIN notes ON notes.id = shares.note_id JOIN users ON users.id = notes.owner_id
         LEFT JOIN folder_shares ON folder_shares.id = shares.folder_share_id
         WHERE shares.user_id = ? AND (notes.seq > ? OR shares.seq > ?) AND notes.deleted = 0`
      )
      .all(userId, since, since) as unknown as (NoteRow & { can_write: number; owner_name: string; owner_avatar: string | null; can_delete: number | null })[];
    // Notes of the user's groups (#58): changed ones, or all live ones after joining or a role change
    const grouped = this.db
      .prepare(
        `SELECT notes.*, g.username AS group_name, group_members.role AS group_role FROM group_members
         JOIN notes ON notes.owner_id = group_members.group_id JOIN users g ON g.id = group_members.group_id
         WHERE group_members.user_id = ? AND (notes.seq > ? OR (group_members.seq > ? AND notes.deleted = 0))`
      )
      .all(userId, since, since) as unknown as (NoteRow & { group_name: string; group_role: GroupRole })[];
    const revoked = this.db
      .prepare('SELECT DISTINCT note_id FROM share_revocations WHERE user_id = ? AND seq > ?')
      .all(userId, since) as { note_id: string }[];
    const sentIds = new Set([...shared.map((s) => s.id), ...grouped.map((g) => g.id)]);
    return {
      notes: [
        ...own.map((r) => synced(r, 'owner')),
        ...shared.map((r) => ({ ...synced(r, r.can_write ? 'write' : 'read', r.owner_name, r.owner_avatar), ...(r.can_delete ? { canDelete: true } : {}) })),
        ...grouped.map((r) => {
          const writer = canWriteInGroup(r.group_role);
          return { ...synced(r, writer ? 'write' : 'read', r.group_name), group: r.owner_id, ...(writer ? { canDelete: true } : {}) };
        }),
      ],
      revoked: revoked.map((r) => r.note_id).filter((id) => !sentIds.has(id) && !this.canSee(id, userId)),
      cursor,
      sharedFolders: this.sharedWith(userId),
      groups: this.groupsOf(userId),
    };
  }

  /** Folders other users share with `userId` */
  sharedWith(userId: string): SharedFolder[] {
    const rows = this.db
      .prepare(
        `SELECT folder_shares.*, users.username AS owner_name, users.avatar_id AS owner_avatar FROM folder_shares JOIN users ON users.id = folder_shares.owner_id
         WHERE folder_shares.user_id = ? AND users.banned_at IS NULL`
      )
      .all(userId) as { id: string; can_write: number; can_create: number; can_delete: number; payload: Uint8Array; owner_name: string; owner_avatar: string | null }[];
    return rows
      .map((r) => ({
        owner: r.owner_name,
        ...(r.owner_avatar ? { ownerAvatar: `/api/avatars/${r.owner_avatar}` } : {}),
        folder: this.cipher.decryptJson<{ folder: string }>(r.payload, `folder_share:${r.id}`).folder,
        canWrite: !!r.can_write,
        canCreate: !!r.can_create,
        canDelete: !!r.can_delete,
      }))
      .sort((a, b) => a.owner.localeCompare(b.owner, 'de') || a.folder.localeCompare(b.folder, 'de'));
  }

  /** Owner id when `userId` may create a note at `path` in a folder `ownerName` shares with them */
  private createGrant(userId: string, ownerName: unknown, path: string): string | null {
    if (typeof ownerName !== 'string') return null;
    const owner = this.db.prepare('SELECT id FROM users WHERE username_lower = ? AND banned_at IS NULL').get(ownerName.toLowerCase()) as { id: string } | undefined;
    if (!owner || owner.id === userId) return null;
    const allowed = this.folderSharesOf(owner.id).some((f) => f.userId === userId && f.canCreate && inFolder(path, f.folder));
    return allowed ? owner.id : null;
  }

  /** A recipient may delete a note when the folder share it comes through allows it */
  private canDeleteShared(noteId: string, userId: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM shares JOIN folder_shares ON folder_shares.id = shares.folder_share_id WHERE shares.note_id = ? AND shares.user_id = ? AND folder_shares.can_delete = 1')
      .get(noteId, userId);
  }

  /** The note exists, is not deleted and the user may see it (own, shared or through a group) */
  private canSee(noteId: string, userId: string): boolean {
    const row = this.getRow(noteId);
    return !!row && !row.deleted && !!this.accessOf(userId, row);
  }

  /** `trusted`: the changes come from an automation that already followed (or may skip) the transitions */
  push(userId: string, changes: PushChange[], opts: { trusted?: boolean } = {}): PushResult[] {
    const events: NoteChangeEvent[] = [];
    // Only needed when the caller creates or moves own notes; decrypted once per push
    let cached: FolderShare[] | undefined;
    const folderShares = () => (cached ??= this.folderSharesOf(userId));
    const results = transaction(this.db, () =>
      changes.map((change): PushResult => {
        if (typeof change?.id !== 'string' || !ID_PATTERN.test(change.id)) return { id: String(change?.id), status: 'forbidden' };
        const sent = typeof change.content === 'string' ? change.content : '';
        let content = sent;
        if (Buffer.byteLength(content) > MAX_NOTE_BYTES) return { id: change.id, status: 'forbidden' };
        const now = Date.now();
        const updatedAt = Math.min(Number(change.updatedAt) || now, now);
        const row = this.getRow(change.id);
        if (!row) {
          const path = cleanPath(change.path);
          // In a folder shared with the caller, the note belongs to the folder's owner (and lives in their space)
          let ownerId = userId;
          if (change.group !== undefined) {
            // In a group (#58) the note belongs to the group; owners and editors may create
            if (typeof change.group !== 'string' || change.deleted || !canWriteInGroup(this.groupRole(change.group, userId))) return { id: change.id, status: 'forbidden' };
            ownerId = change.group;
          } else if (change.owner !== undefined) {
            const grant = this.createGrant(userId, change.owner, path);
            if (!grant || change.deleted) return { id: change.id, status: 'forbidden' };
            ownerId = grant;
          }
          let flow: Omit<ReturnType<NoteStore['applyWorkflow']>, 'content'> = {};
          if (!change.deleted) {
            content = this.numberTicket(ownerId, content);
            if (isSchemaPath(path)) this.projectCache.delete(ownerId);
            if (isVariablesPath(path)) this.variableCache.delete(ownerId);
            if (isNoteTypePath(path)) this.typeCache.delete(ownerId);
            const { content: next, ...rest } = this.applyWorkflow(ownerId, change.id, path, null, content, userId, !!opts.trusted);
            content = next;
            flow = rest;
          }
          const seq = this.nextSeq();
          const createdAt = Math.min(Number(change.createdAt) || now, now);
          this.db
            .prepare('INSERT INTO notes (id, owner_id, version, seq, created_at, updated_at, deleted, payload) VALUES (?, ?, 1, ?, ?, ?, ?, ?)')
            .run(change.id, ownerId, seq, createdAt, updatedAt, change.deleted ? 1 : 0, this.cipher.encryptJson({ path, content }, `note:${change.id}`));
          if (!change.deleted) this.recordVersion(change.id, path, content, now);
          const shares = ownerId === userId ? folderShares() : this.folderSharesOf(ownerId);
          const added = change.deleted ? [] : this.applyFolderShares(ownerId, change.id, path, seq, shares);
          const members = ownerId === userId ? [] : (this.db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(ownerId) as { user_id: string }[]).map((m) => m.user_id);
          events.push({ noteId: change.id, ownerId, audience: [...new Set([ownerId, userId, ...added, ...members])], path, previousPath: null, content, deleted: !!change.deleted, actorId: userId, previousContent: '' });
          return { id: change.id, status: 'ok', version: 1, ...(content !== sent ? { content } : {}), ...flow };
        }
        const access = this.accessOf(userId, row);
        if (access !== 'owner' && access !== 'write') return { id: change.id, status: 'forbidden' };
        if (row.version !== change.baseVersion) {
          return { id: change.id, status: 'conflict', server: this.syncedFor(row, userId, access) };
        }
        // Writing group members (#58) manage the group's notes like an owner
        const manager = access === 'owner' || this.canManage(row, userId);
        // A recipient deletes only with the folder share's permission (and an unknown owner is refused)
        if (!manager && change.deleted && !this.canDeleteShared(row.id, userId)) return { id: change.id, status: 'forbidden' };
        const old = this.payload(row);
        // Online mode: a device without the text moves, renames or deletes the note; the text stays as it is
        if (change.keepContent) content = old.content;
        // Only the owner moves or renames a note: it lives in their space. Deleting also needs the folder share's permission
        const path = manager ? cleanPath(change.path) : old.path;
        const deleted = !!change.deleted;
        if (isSchemaPath(path) || isSchemaPath(old.path)) this.projectCache.delete(row.owner_id);
        if (isVariablesPath(path) || isVariablesPath(old.path)) this.variableCache.delete(row.owner_id);
        if (isNoteTypePath(path) || isNoteTypePath(old.path)) this.typeCache.delete(row.owner_id);
        let flow: Omit<ReturnType<NoteStore['applyWorkflow']>, 'content'> = {};
        if (!deleted) {
          content = this.numberTicket(row.owner_id, content);
          const { content: next, ...rest } = this.applyWorkflow(row.owner_id, row.id, path, old.content, content, userId, !!opts.trusted);
          content = next;
          flow = rest;
        }
        const seq = this.nextSeq();
        this.db
          .prepare('UPDATE notes SET version = version + 1, seq = ?, updated_at = ?, deleted = ?, payload = ? WHERE id = ?')
          .run(seq, updatedAt, deleted ? 1 : 0, this.cipher.encryptJson({ path, content: deleted ? '' : content }, `note:${row.id}`), row.id);
        // A deleted note goes to its owner's trash (history kept until it is purged); system notes are gone for good
        if (deleted && !old.path.startsWith(SYSTEM_PREFIX)) this.toTrash(row, userId, old.path, content || old.content, change, now);
        else if (deleted) this.db.prepare('DELETE FROM note_versions WHERE note_id = ?').run(row.id);
        else if (path !== old.path || content !== old.content) this.recordVersion(row.id, path, content, now);
        const audience = this.audience(row);
        if (deleted) this.dropShares(row.id, seq);
        else if (access === 'owner' && path !== old.path) audience.push(...this.applyFolderShares(userId, row.id, path, seq, folderShares()));
        events.push({ noteId: row.id, ownerId: row.owner_id, audience: [...new Set(audience)], path, previousPath: old.path, content: deleted ? content : this.published(row.id, content), deleted, actorId: userId, previousContent: old.content });
        return { id: change.id, status: 'ok', version: row.version + 1, ...(content !== sent && !change.keepContent ? { content } : {}), ...flow };
      })
    );
    for (const e of events) this.onChange(e);
    return results;
  }

  /** Keeps the history: saves close together share one version, the oldest ones fall off */
  private recordVersion(noteId: string, path: string, content: string, now: number): void {
    const payload = (id: string) => this.cipher.encryptJson({ path, content }, `note_version:${id}`);
    const last = this.db.prepare('SELECT id, created_at, saved_at FROM note_versions WHERE note_id = ? ORDER BY saved_at DESC, rowid DESC LIMIT 1').get(noteId) as
      | { id: string; created_at: number; saved_at: number }
      | undefined;
    if (last && now - last.saved_at < VERSION_PAUSE_MS && now - last.created_at < VERSION_MAX_SPAN_MS) {
      this.db.prepare('UPDATE note_versions SET saved_at = ?, payload = ? WHERE id = ?').run(now, payload(last.id), last.id);
      return;
    }
    const id = randomToken(12);
    this.db.prepare('INSERT INTO note_versions (id, note_id, created_at, saved_at, payload) VALUES (?, ?, ?, ?, ?)').run(id, noteId, now, now, payload(id));
    this.db
      .prepare('DELETE FROM note_versions WHERE note_id = ? AND id NOT IN (SELECT id FROM note_versions WHERE note_id = ? ORDER BY saved_at DESC, rowid DESC LIMIT ?)')
      .run(noteId, noteId, MAX_VERSIONS);
  }

  /** Newest first; anybody who can see the note may look at its history */
  versions(userId: string, noteId: string): NoteVersionInfo[] {
    this.readableRow(userId, noteId);
    const rows = this.db.prepare('SELECT * FROM note_versions WHERE note_id = ? ORDER BY saved_at DESC, rowid DESC').all(noteId) as unknown as VersionRow[];
    return rows.map((r) => {
      const v = this.versionOf(r);
      return { id: r.id, savedAt: r.saved_at, path: v.path, size: Buffer.byteLength(v.content) };
    });
  }

  version(userId: string, noteId: string, versionId: string): NoteVersion {
    this.readableRow(userId, noteId);
    const r = this.db.prepare('SELECT * FROM note_versions WHERE id = ? AND note_id = ?').get(versionId, noteId) as VersionRow | undefined;
    if (!r) throw new Error('not found');
    const v = this.versionOf(r);
    return { id: r.id, savedAt: r.saved_at, path: v.path, size: Buffer.byteLength(v.content), content: v.content };
  }

  private versionOf(r: VersionRow): Payload {
    return this.cipher.decryptJson<Payload>(r.payload, `note_version:${r.id}`);
  }

  private readableRow(userId: string, noteId: string): NoteRow {
    const row = this.getRow(noteId);
    if (!row || row.deleted || !this.accessOf(userId, row)) throw new Error('not found');
    return row;
  }

  private dropShares(noteId: string, seq: number): void {
    const users = this.db.prepare('SELECT user_id FROM shares WHERE note_id = ?').all(noteId) as { user_id: string }[];
    for (const u of users) this.db.prepare('INSERT INTO share_revocations (note_id, user_id, seq) VALUES (?, ?, ?)').run(noteId, u.user_id, seq);
    this.db.prepare('DELETE FROM shares WHERE note_id = ?').run(noteId);
    this.db.prepare('DELETE FROM public_links WHERE note_id = ?').run(noteId);
  }

  // ------------------------------------------------------------------ trash

  private toTrash(row: NoteRow, userId: string, path: string, content: string, change: PushChange, now: number): void {
    const batch = typeof change.trashBatch === 'string' && ID_PATTERN.test(change.trashBatch) ? change.trashBatch : null;
    const folder = batch && typeof change.trashFolder === 'string' ? change.trashFolder.slice(0, 400) : null;
    this.db
      .prepare('INSERT OR REPLACE INTO trash (note_id, owner_id, deleted_at, deleted_by, batch, payload) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.id, row.owner_id, now, userId === row.owner_id ? null : userId, batch, this.cipher.encryptJson({ path, content, folder } satisfies TrashPayload, `trash:${row.id}`));
  }

  private trashPayload(r: TrashRow): TrashPayload {
    return this.cipher.decryptJson<TrashPayload>(r.payload, `trash:${r.note_id}`);
  }

  /** Owners whose trash the user manages: themselves and the groups they write in (#58) */
  private trashOwners(userId: string): string[] {
    const groups = this.db.prepare("SELECT group_id FROM group_members WHERE user_id = ? AND role IN ('owner', 'editor')").all(userId) as { group_id: string }[];
    return [userId, ...groups.map((g) => g.group_id)];
  }

  private trashRow(userId: string, noteId: string): TrashRow | undefined {
    const t = this.db.prepare('SELECT * FROM trash WHERE note_id = ?').get(noteId) as TrashRow | undefined;
    return t && this.trashOwners(userId).includes(t.owner_id) ? t : undefined;
  }

  /** The owner's deleted notes (and those of the groups they write in), newest first */
  trash(userId: string): TrashEntry[] {
    const owners = this.trashOwners(userId);
    const rows = this.db
      .prepare(
        `SELECT trash.*, users.username AS deleted_by_name, g.username AS group_name FROM trash LEFT JOIN users ON users.id = trash.deleted_by
         LEFT JOIN users g ON g.id = trash.owner_id AND g.is_group = 1
         WHERE trash.owner_id IN (${owners.map(() => '?').join(', ')}) ORDER BY deleted_at DESC`
      )
      .all(...owners) as unknown as (TrashRow & { deleted_by_name: string | null; group_name: string | null })[];
    return rows.map((r) => {
      const p = this.trashPayload(r);
      return {
        id: r.note_id,
        path: p.path,
        deletedAt: r.deleted_at,
        deletedBy: r.deleted_by ? (r.deleted_by_name ?? '?') : null,
        batch: r.batch,
        folder: p.folder,
        size: Buffer.byteLength(p.content),
        ...(r.group_name !== null ? { group: r.group_name } : {}),
      };
    });
  }

  /** Paths of the owner's notes that are not deleted */
  private livePaths(userId: string): Set<string> {
    const rows = this.db.prepare('SELECT * FROM notes WHERE owner_id = ? AND deleted = 0').all(userId) as unknown as NoteRow[];
    return new Set(rows.map((r) => this.payload(r).path));
  }

  /**
   * Puts trashed notes back (only their owner may): each takes a new `seq`, so every device pulls it.
   * `path` moves a single note elsewhere; without it a taken path throws `TrashPathTaken` (single
   * note) or gets a free name next to it (`rename`, used for a whole folder).
   */
  restore(userId: string, noteIds: string[], opts: { path?: unknown; rename?: boolean } = {}): { id: string; path: string }[] {
    // Projects may appear or move with these notes
    this.projectCache.clear();
    this.variableCache.clear();
    this.typeCache.clear();
    const events: NoteChangeEvent[] = [];
    const restored = transaction(this.db, () => {
      // Paths per owner: a group's trash (#58) restores into the group's space
      const takenOf = new Map<string, Set<string>>();
      let cached: FolderShare[] | undefined;
      const out: { id: string; path: string }[] = [];
      for (const noteId of noteIds) {
        const t = this.trashRow(userId, noteId);
        const row = t && this.getRow(noteId);
        if (!t || !row || !row.deleted) throw new Error('not found');
        let taken = takenOf.get(t.owner_id);
        if (!taken) takenOf.set(t.owner_id, (taken = this.livePaths(t.owner_id)));
        const p = this.trashPayload(t);
        let path = opts.path !== undefined && noteIds.length === 1 ? cleanPath(opts.path) : p.path;
        if (taken.has(path)) {
          if (!opts.rename) throw new TrashPathTaken(freePath(path, taken));
          path = freePath(path, taken);
        }
        taken.add(path);
        const now = Date.now();
        const seq = this.nextSeq();
        this.db
          .prepare('UPDATE notes SET version = version + 1, seq = ?, updated_at = ?, deleted = 0, payload = ? WHERE id = ?')
          .run(seq, now, this.cipher.encryptJson({ path, content: p.content }, `note:${noteId}`), noteId);
        this.db.prepare('DELETE FROM trash WHERE note_id = ?').run(noteId);
        this.recordVersion(noteId, path, p.content, now);
        const added = t.owner_id === userId ? this.applyFolderShares(userId, noteId, path, seq, (cached ??= this.folderSharesOf(userId))) : [];
        events.push({ noteId, ownerId: t.owner_id, audience: [...new Set([userId, ...added, ...this.audience(row)])], path, previousPath: null, content: this.published(noteId, p.content), deleted: false, actorId: userId, action: 'restored' });
        out.push({ id: noteId, path });
      }
      return out;
    });
    for (const e of events) this.onChange(e);
    return restored;
  }

  /** Ids of the owner's trashed notes deleted together (one folder deletion) */
  trashBatch(userId: string, batch: string): string[] {
    const owners = this.trashOwners(userId);
    const rows = this.db.prepare('SELECT note_id, owner_id FROM trash WHERE batch = ?').all(batch) as { note_id: string; owner_id: string }[];
    return rows.filter((r) => owners.includes(r.owner_id)).map((r) => r.note_id);
  }

  /**
   * Deletes trashed notes for good: their content and history. The tombstone stays for sync. `ids` null
   * empties the whole trash. Returns the purged contents (to find attachments nothing uses any more).
   */
  purge(userId: string, ids: string[] | null): string[] {
    return this.purgeEntries(userId, ids).map((e) => e.content);
  }

  /** Like `purge`, with the owner of each purged note (the user or one of their groups, #58) */
  purgeEntries(userId: string, ids: string[] | null): { ownerId: string; content: string }[] {
    return transaction(this.db, () => {
      const owners = this.trashOwners(userId);
      const rows = (
        ids === null
          ? owners.flatMap((o) => this.db.prepare('SELECT * FROM trash WHERE owner_id = ?').all(o))
          : ids.map((id) => this.trashRow(userId, id)).filter(Boolean)
      ) as unknown as TrashRow[];
      return rows.map((r) => ({ ownerId: r.owner_id, content: this.purgeRow(r) }));
    });
  }

  private purgeRow(r: TrashRow): string {
    const content = this.trashPayload(r).content;
    this.db.prepare('DELETE FROM trash WHERE note_id = ?').run(r.note_id);
    this.db.prepare('DELETE FROM note_versions WHERE note_id = ?').run(r.note_id);
    this.db.prepare('DELETE FROM note_releases WHERE note_id = ?').run(r.note_id);
    this.db.prepare('DELETE FROM note_versioning WHERE note_id = ?').run(r.note_id);
    // Comments (#68) go with the note
    this.db.prepare('DELETE FROM comment_threads WHERE note_id = ?').run(r.note_id);
    return content;
  }

  /** Purges every trashed note deleted before `before`; returns the purged contents per owner */
  purgeOlderThan(before: number): Map<string, string[]> {
    return transaction(this.db, () => {
      const rows = this.db.prepare('SELECT * FROM trash WHERE deleted_at < ?').all(before) as unknown as TrashRow[];
      const out = new Map<string, string[]>();
      for (const r of rows) {
        let list = out.get(r.owner_id);
        if (!list) out.set(r.owner_id, (list = []));
        list.push(this.purgeRow(r));
      }
      return out;
    });
  }

  /** Contents of the owner's trashed notes (their attachments are still in use) */
  trashedContents(userId: string): string[] {
    const rows = this.db.prepare('SELECT * FROM trash WHERE owner_id = ?').all(userId) as unknown as TrashRow[];
    return rows.map((r) => this.trashPayload(r).content);
  }

  // ------------------------------------------------------------------ sharing

  private ownedRow(userId: string, noteId: string): NoteRow {
    const row = this.getRow(noteId);
    if (!row || row.owner_id !== userId || row.deleted) throw new Error('not found');
    return row;
  }

  /** An own note, or one of a group the user writes in (#58) */
  private manageableRow(userId: string, noteId: string): NoteRow {
    const row = this.getRow(noteId);
    if (!row || row.deleted || !this.canManage(row, userId)) throw new Error('not found');
    return row;
  }

  shares(userId: string, noteId: string): NoteShares {
    this.ownedRow(userId, noteId);
    const users = this.db
      .prepare(
        'SELECT users.username, users.avatar_id, shares.can_write, shares.folder_share_id FROM shares JOIN users ON users.id = shares.user_id WHERE note_id = ? ORDER BY users.username_lower'
      )
      .all(noteId) as { username: string; avatar_id: string | null; can_write: number; folder_share_id: string | null }[];
    const folders = new Map(this.folderSharesOf(userId).map((f) => [f.id, f.folder]));
    const link = this.db.prepare('SELECT token FROM public_links WHERE note_id = ?').get(noteId) as { token: string } | undefined;
    return {
      users: users.map((u): NoteShare => {
        const viaFolder = u.folder_share_id ? folders.get(u.folder_share_id) : undefined;
        return {
          username: u.username,
          ...(u.avatar_id ? { avatarUrl: `/api/avatars/${u.avatar_id}` } : {}),
          canWrite: !!u.can_write,
          ...(viaFolder ? { viaFolder } : {}),
        };
      }),
      publicToken: link?.token ?? null,
    };
  }

  share(userId: string, noteId: string, targetUserId: string, canWrite: boolean): string[] {
    const row = this.ownedRow(userId, noteId);
    if (targetUserId === userId) throw new Error('self');
    const seq = this.nextSeq();
    this.db
      .prepare(
        'INSERT INTO shares (note_id, user_id, can_write, seq) VALUES (?, ?, ?, ?) ON CONFLICT(note_id, user_id) DO UPDATE SET can_write = excluded.can_write, seq = excluded.seq, folder_share_id = NULL'
      )
      .run(noteId, targetUserId, canWrite ? 1 : 0, seq);
    return this.audience(row);
  }

  /** Removes a direct share; a share through a shared folder stays (it is managed on the folder) */
  unshare(userId: string, noteId: string, targetUserId: string): void {
    const row = this.ownedRow(userId, noteId);
    transaction(this.db, () => {
      const seq = this.nextSeq();
      if (this.db.prepare('DELETE FROM shares WHERE note_id = ? AND user_id = ? AND folder_share_id IS NULL').run(noteId, targetUserId).changes > 0) {
        this.db.prepare('INSERT INTO share_revocations (note_id, user_id, seq) VALUES (?, ?, ?)').run(noteId, targetUserId, seq);
        // The folder may still share it (the recipient pulls it again with this seq)
        this.applyFolderShares(userId, noteId, this.payload(row).path, seq, this.folderSharesOf(userId));
      }
    });
  }

  // ------------------------------------------------------------------ folder shares

  private folderSharesOf(ownerId: string): FolderShare[] {
    const rows = this.db.prepare('SELECT id, user_id, can_write, can_create, can_delete, payload FROM folder_shares WHERE owner_id = ?').all(ownerId) as {
      id: string;
      user_id: string;
      can_write: number;
      can_create: number;
      can_delete: number;
      payload: Uint8Array;
    }[];
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      canWrite: !!r.can_write,
      canCreate: !!r.can_create,
      canDelete: !!r.can_delete,
      folder: this.cipher.decryptJson<{ folder: string }>(r.payload, `folder_share:${r.id}`).folder,
    }));
  }

  /**
   * Brings the folder-derived shares of one note in line with its path: it is shared with everybody a containing folder is
   * shared with, and with nobody else through a folder. Direct shares stay untouched. Returns the users whose access changed.
   */
  private applyFolderShares(ownerId: string, noteId: string, path: string, seq: number, list: FolderShare[]): string[] {
    const wanted = new Map<string, FolderShare>();
    for (const f of list) {
      if (f.userId === ownerId || !inFolder(path, f.folder)) continue;
      const prev = wanted.get(f.userId);
      if (!prev || rank(f) > rank(prev)) wanted.set(f.userId, f);
    }
    const current = this.db.prepare('SELECT user_id, can_write, folder_share_id FROM shares WHERE note_id = ?').all(noteId) as {
      user_id: string;
      can_write: number;
      folder_share_id: string | null;
    }[];
    const changed: string[] = [];
    for (const cur of current) {
      if (!cur.folder_share_id || wanted.has(cur.user_id)) continue;
      this.db.prepare('DELETE FROM shares WHERE note_id = ? AND user_id = ?').run(noteId, cur.user_id);
      this.db.prepare('INSERT INTO share_revocations (note_id, user_id, seq) VALUES (?, ?, ?)').run(noteId, cur.user_id, seq);
      changed.push(cur.user_id);
    }
    for (const [user, f] of wanted) {
      const cur = current.find((c) => c.user_id === user);
      if (!cur) {
        this.db.prepare('INSERT INTO shares (note_id, user_id, can_write, seq, folder_share_id) VALUES (?, ?, ?, ?, ?)').run(noteId, user, f.canWrite ? 1 : 0, seq, f.id);
        changed.push(user);
      } else if (cur.folder_share_id && (cur.folder_share_id !== f.id || !!cur.can_write !== f.canWrite)) {
        this.db.prepare('UPDATE shares SET can_write = ?, seq = ?, folder_share_id = ? WHERE note_id = ? AND user_id = ?').run(f.canWrite ? 1 : 0, seq, f.id, noteId, user);
        changed.push(user);
      }
    }
    return changed;
  }

  /** Re-applies all folder shares of the owner to all of their live notes; returns the users whose access changed */
  private applyAllFolderShares(ownerId: string, seq: number): string[] {
    const list = this.folderSharesOf(ownerId);
    const rows = this.db.prepare('SELECT * FROM notes WHERE owner_id = ? AND deleted = 0').all(ownerId) as unknown as NoteRow[];
    const changed = new Set<string>();
    for (const r of rows) for (const u of this.applyFolderShares(ownerId, r.id, this.payload(r).path, seq, list)) changed.add(u);
    return [...changed];
  }

  /** Who the folder is shared with, and who sees it through a parent folder */
  folderShares(ownerId: string, folder: string): FolderShares {
    const clean = cleanPath(folder);
    const infos = new Map<string, { username: string; avatar_id: string | null }>();
    const infoOf = (id: string) => {
      if (!infos.has(id)) {
        infos.set(id, this.db.prepare('SELECT username, avatar_id FROM users WHERE id = ?').get(id) as { username: string; avatar_id: string | null });
      }
      return infos.get(id)!;
    };
    const list = this.folderSharesOf(ownerId);
    const sort = (a: NoteShare, b: NoteShare) => a.username.localeCompare(b.username, 'de');
    return {
      users: list
        .filter((f) => f.folder === clean)
        .map((f) => {
          const u = infoOf(f.userId);
          return {
            username: u.username,
            ...(u.avatar_id ? { avatarUrl: `/api/avatars/${u.avatar_id}` } : {}),
            canWrite: f.canWrite,
            canCreate: f.canCreate,
            canDelete: f.canDelete,
          };
        })
        .sort(sort),
      inherited: list
        .filter((f) => clean.startsWith(`${f.folder}/`))
        .map((f) => {
          const u = infoOf(f.userId);
          return {
            username: u.username,
            ...(u.avatar_id ? { avatarUrl: `/api/avatars/${u.avatar_id}` } : {}),
            canWrite: f.canWrite,
            canCreate: f.canCreate,
            canDelete: f.canDelete,
            viaFolder: f.folder,
          };
        })
        .sort(sort),
    };
  }

  /** Shares the folder (with subfolders, including notes added later) with another user; returns who should pull */
  shareFolder(ownerId: string, folder: string, targetUserId: string, permissions: Partial<FolderPermissions>): string[] {
    const clean = cleanPath(folder);
    if (targetUserId === ownerId) throw new Error('self');
    const p = normalizePermissions(permissions);
    const flags = [p.canWrite ? 1 : 0, p.canCreate ? 1 : 0, p.canDelete ? 1 : 0];
    return transaction(this.db, () => {
      const seq = this.nextSeq();
      const existing = this.folderSharesOf(ownerId).find((f) => f.folder === clean && f.userId === targetUserId);
      if (existing) {
        this.db.prepare('UPDATE folder_shares SET can_write = ?, can_create = ?, can_delete = ? WHERE id = ?').run(...flags, existing.id);
        // The recipient pulls the notes again and learns the new delete permission
        this.db.prepare('UPDATE shares SET seq = ? WHERE folder_share_id = ?').run(seq, existing.id);
      } else {
        const id = randomToken(12);
        this.db
          .prepare('INSERT INTO folder_shares (id, owner_id, user_id, can_write, can_create, can_delete, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, ownerId, targetUserId, ...flags, this.cipher.encryptJson({ folder: clean }, `folder_share:${id}`), Date.now());
      }
      return [ownerId, targetUserId, ...this.applyAllFolderShares(ownerId, seq)];
    });
  }

  /** Stops sharing the folder with the user; notes shared directly or through another folder stay shared */
  unshareFolder(ownerId: string, folder: string, targetUserId: string): string[] {
    const clean = cleanPath(folder);
    return transaction(this.db, () => {
      const existing = this.folderSharesOf(ownerId).find((f) => f.folder === clean && f.userId === targetUserId);
      if (!existing) return [];
      const seq = this.nextSeq();
      // Re-apply without the share first, so every note it covered gets a revocation (or moves to another folder share)
      const rest = this.folderSharesOf(ownerId).filter((f) => f.id !== existing.id);
      const rows = this.db
        .prepare('SELECT notes.* FROM shares JOIN notes ON notes.id = shares.note_id WHERE shares.folder_share_id = ?')
        .all(existing.id) as unknown as NoteRow[];
      for (const r of rows) this.applyFolderShares(ownerId, r.id, this.payload(r).path, seq, rest);
      this.db.prepare('DELETE FROM folder_shares WHERE id = ?').run(existing.id);
      return [ownerId, targetUserId];
    });
  }

  /** A folder was renamed or moved: its shares (and those of its subfolders) follow */
  renameFolderShares(ownerId: string, from: string, to: string): string[] {
    const source = cleanPath(from);
    const target = cleanPath(to);
    return transaction(this.db, () => {
      let moved = false;
      for (const f of this.folderSharesOf(ownerId)) {
        if (f.folder !== source && !f.folder.startsWith(`${source}/`)) continue;
        const folder = target + f.folder.slice(source.length);
        this.db.prepare('UPDATE folder_shares SET payload = ? WHERE id = ?').run(this.cipher.encryptJson({ folder }, `folder_share:${f.id}`), f.id);
        moved = true;
      }
      return moved ? [ownerId, ...this.applyAllFolderShares(ownerId, this.nextSeq())] : [];
    });
  }

  /** The folder was deleted: forget its shares (and those of its subfolders) */
  dropFolderShares(ownerId: string, folder: string): string[] {
    const clean = cleanPath(folder);
    const affected = this.folderSharesOf(ownerId).filter((f) => f.folder === clean || f.folder.startsWith(`${clean}/`));
    return affected.flatMap((f) => this.unshareFolder(ownerId, f.folder, f.userId));
  }

  setPublic(userId: string, noteId: string, enabled: boolean): string | null {
    this.ownedRow(userId, noteId);
    if (!enabled) {
      this.db.prepare('DELETE FROM public_links WHERE note_id = ?').run(noteId);
      return null;
    }
    const existing = this.db.prepare('SELECT token FROM public_links WHERE note_id = ?').get(noteId) as { token: string } | undefined;
    if (existing) return existing.token;
    const token = randomToken(18);
    this.db.prepare('INSERT INTO public_links (token, note_id, created_at) VALUES (?, ?, ?)').run(token, noteId, Date.now());
    return token;
  }

  publicNote(token: string): PublicNote | null {
    const row = this.db
      .prepare(
        'SELECT notes.*, users.username AS owner_name, users.avatar_id AS owner_avatar FROM public_links JOIN notes ON notes.id = public_links.note_id JOIN users ON users.id = notes.owner_id WHERE token = ? AND notes.deleted = 0'
      )
      .get(token) as (NoteRow & { owner_name: string; owner_avatar: string | null }) | undefined;
    if (!row) return null;
    const note = this.guestView(row);
    const embeds = this.publicEmbeds(row.owner_id, row.id, note.content);
    return {
      ...note,
      owner: row.owner_name,
      ...(row.owner_avatar ? { ownerAvatar: `/api/avatars/${row.owner_avatar}` } : {}),
      ...(embeds.length ? { embeds } : {}),
    };
  }

  /** A note as guests see it (public links, folder websites) */
  private guestView(row: NoteRow): Omit<PublicNote, 'owner' | 'ownerAvatar' | 'embeds'> {
    // A versioned note shows its latest release, like to read-only share recipients (#53)
    const synced = this.toSynced(row, 'read');
    // A remote note's source stays inside: guests see a placeholder, and nothing is fetched for them
    const content = publicRemoteContent(synced.content);
    return {
      path: synced.path,
      content,
      updatedAt: synced.releases?.[0]?.releasedAt ?? row.updated_at,
      ...this.publicVariables(row.owner_id, synced.path, content),
      ...this.publicNoteType(row.owner_id, content),
      ...(synced.versioning ? { versioning: true, releases: synced.releases ?? [] } : {}),
      ...(synced.showsRelease ? { showsRelease: synced.showsRelease } : {}),
    };
  }

  /**
   * The notes of a published folder and its subfolders as guests see them (folder websites), paths relative to the
   * folder, without hidden system notes (databases, variables, note types, habits); at most `limit`, by path
   */
  publicFolder(ownerId: string, folder: string, limit: number): { notes: PublicSiteNote[]; truncated: boolean } {
    const clean = cleanPath(folder);
    const rows = this.db.prepare('SELECT * FROM notes WHERE owner_id = ? AND deleted = 0').all(ownerId) as unknown as NoteRow[];
    const inside = rows
      .map((row) => ({ row, path: this.payload(row).path }))
      .filter((r) => inFolder(r.path, clean) && !isHiddenPath(r.path))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const notes = inside.slice(0, limit).map(({ row }) => {
      const view = this.guestView(row);
      // Not the note's own id: nothing on the site names a record of the database
      return { ...view, id: this.cipher.mac(row.id, 'site-note').slice(0, 16), path: view.path.slice(clean.length + 1) };
    });
    return { notes, truncated: inside.length > limit };
  }

  /**
   * Embeds a public note may show: only notes of the same owner that have a public link themselves, so a
   * link never reveals a note its owner did not publish. Embeds inside them are followed down to the depth limit.
   */
  private publicEmbeds(ownerId: string, noteId: string, content: string): PublicEmbed[] {
    if (!embedsOf(content).length) return [];
    const rows = this.db
      .prepare('SELECT notes.*, public_links.token AS public_token FROM public_links JOIN notes ON notes.id = public_links.note_id WHERE notes.owner_id = ? AND notes.deleted = 0')
      .all(ownerId) as unknown as (NoteRow & { public_token: string })[];
    const published = new Map(
      rows.map((r) => {
        const p = this.payload(r);
        return [r.id, { path: p.path, content: publicRemoteContent(this.published(r.id, p.content)), id: r.id, token: r.public_token }];
      })
    );
    const index = new LinkIndex([...published.values()]);
    const out = new Map<string, PublicEmbed>();
    let frontier = [{ id: noteId, content }];
    for (let level = 0; level < MAX_EMBED_DEPTH && frontier.length; level++) {
      const next: { id: string; content: string }[] = [];
      for (const note of frontier) {
        for (const ref of embedsOf(note.content)) {
          const key = ref.target.toLowerCase();
          if (out.has(key)) continue;
          const target = published.get(index.resolve(ref.target) ?? '');
          if (!target) continue;
          out.set(key, { target: key, title: extractMeta(target.path, target.content).title, content: target.content, token: target.token, ...this.publicVariables(ownerId, target.path, target.content) });
          next.push(target);
        }
      }
      frontier = next;
    }
    return [...out.values()];
  }

  /** Bumps share sequence numbers and returns recipient user ids when an owner updates or removes their avatar */
  refreshSharedAvatar(userId: string): string[] {
    return transaction(this.db, () => {
      const recipients = this.db
        .prepare(
          `SELECT DISTINCT user_id FROM (
             SELECT shares.user_id AS user_id FROM shares JOIN notes ON notes.id = shares.note_id WHERE notes.owner_id = ? AND notes.deleted = 0
             UNION
             SELECT user_id FROM folder_shares WHERE owner_id = ?
           )`
        )
        .all(userId, userId) as { user_id: string }[];
      if (!recipients.length) return [];
      const seq = this.nextSeq();
      this.db
        .prepare('UPDATE shares SET seq = ? WHERE note_id IN (SELECT id FROM notes WHERE owner_id = ? AND deleted = 0)')
        .run(seq, userId);
      return recipients.map((r) => r.user_id);
    });
  }

  /** The user's own live notes with ids and versions (MCP access: only the own space, never shared notes) */
  ownedNotes(userId: string): SyncedNote[] {
    const rows = this.db.prepare('SELECT * FROM notes WHERE owner_id = ? AND deleted = 0').all(userId) as unknown as NoteRow[];
    return rows.map((r) => this.toSynced(r, 'owner'));
  }

  /**
   * Live notes of the groups the user is a member of (#58), as the user sees them: `group` and the group's name
   * as `owner`; readers get `read` access (and the latest release of versioned notes), owners and editors `write`
   */
  groupNotes(userId: string): SyncedNote[] {
    const rows = this.db
      .prepare(
        `SELECT notes.*, g.username AS group_name, group_members.role AS group_role FROM group_members
         JOIN notes ON notes.owner_id = group_members.group_id JOIN users g ON g.id = group_members.group_id
         WHERE group_members.user_id = ? AND notes.deleted = 0`
      )
      .all(userId) as unknown as (NoteRow & { group_name: string; group_role: GroupRole })[];
    return rows.map((r) => {
      const writer = canWriteInGroup(r.group_role);
      return { ...this.toSynced(r, writer ? 'write' : 'read', r.group_name), group: r.owner_id, ...(writer ? { canDelete: true } : {}) };
    });
  }

  /** The user's own live notes as exports show them: versioned notes as their latest release, placeholders filled (#53) */
  publishedNotes(userId: string): SyncedNote[] {
    return this.ownedNotes(userId).map((n) => ({ ...n, content: this.published(n.id, n.content) }));
  }

  /** All live notes of a user (for the export mirror; versioned notes as their latest release) */
  allOf(userId: string): { path: string; content: string }[] {
    const rows = this.db.prepare('SELECT * FROM notes WHERE owner_id = ? AND deleted = 0').all(userId) as unknown as NoteRow[];
    return rows.map((r) => {
      const p = this.payload(r);
      return { path: p.path, content: this.published(r.id, p.content) };
    });
  }

  // ------------------------------------------------------------------ groups (#58)

  /**
   * Moves own notes into a group the user writes in: the group owns them from now on and every member sees
   * them. Shares and public links of the notes end (their recipients lose access). Links are not rewritten:
   * links between the moved notes keep working, links to notes outside only work for people who see those.
   * Returns the new paths and the moved contents (their attachments may move along).
   */
  moveToGroup(userId: string, groupId: string, req: Partial<GroupMoveRequest>): { moved: { id: string; path: string }[]; contents: string[] } {
    // Projects may appear or move with these notes
    this.projectCache.clear();
    this.variableCache.clear();
    this.typeCache.clear();
    if (!canWriteInGroup(this.groupRole(groupId, userId))) throw new Error('forbidden');
    const ids = Array.isArray(req.noteIds) ? [...new Set(req.noteIds.filter((id): id is string => typeof id === 'string' && ID_PATTERN.test(id)))] : [];
    if (!ids.length || ids.length > 5000) throw new Error('invalid');
    const folder = req.folder === undefined || req.folder === null || req.folder === '' ? undefined : cleanPath(req.folder);
    const target = req.target === undefined || req.target === null || req.target === '' ? '' : cleanPath(req.target);
    const events: NoteChangeEvent[] = [];
    const result = transaction(this.db, () => {
      const taken = this.livePaths(groupId);
      const seq = this.nextSeq();
      const now = Date.now();
      const moved: { id: string; path: string }[] = [];
      const contents: string[] = [];
      for (const id of ids) {
        const row = this.getRow(id);
        if (!row || row.owner_id !== userId || row.deleted) throw new Error('not found');
        const p = this.payload(row);
        if (p.path.startsWith(SYSTEM_PREFIX) || (folder && !inFolder(p.path, folder))) throw new Error('not found');
        const path = freePath(cleanPath(groupMovePath(p.path, target, folder)), taken);
        taken.add(path);
        const before = this.audience(row);
        // Single shares and folder shares lose their effect, public links end
        this.dropShares(id, seq);
        this.db
          .prepare('UPDATE notes SET owner_id = ?, version = version + 1, seq = ?, updated_at = ?, payload = ? WHERE id = ?')
          .run(groupId, seq, now, this.cipher.encryptJson({ path, content: p.content }, `note:${id}`), id);
        if (path !== p.path) this.recordVersion(id, path, p.content, now);
        const after = this.getRow(id)!;
        // Gone from the old owner's space (export mirror), new in the group's
        events.push({ noteId: id, ownerId: userId, audience: [], path: p.path, previousPath: p.path, content: '', deleted: true });
        events.push({ noteId: id, ownerId: groupId, audience: [...new Set([...before, ...this.audience(after)])], path, previousPath: null, content: this.published(id, p.content), deleted: false, actorId: userId });
        moved.push({ id, path });
        contents.push(p.content);
      }
      return { moved, contents };
    });
    for (const e of events) this.onChange(e);
    return result;
  }

  /**
   * Deletes a group with all its notes, their history, releases and trash (only an owner may). Attachments
   * must be removed from the file store before. Returns the former members (they pull the revocations).
   */
  deleteGroup(userId: string, groupId: string): string[] {
    // Projects may appear or move with these notes
    this.projectCache.clear();
    this.variableCache.clear();
    this.typeCache.clear();
    if (this.groupRole(groupId, userId) !== 'owner') throw new Error('forbidden');
    return transaction(this.db, () => {
      const members = (this.db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(groupId) as { user_id: string }[]).map((m) => m.user_id);
      const live = this.db.prepare('SELECT id FROM notes WHERE owner_id = ? AND deleted = 0').all(groupId) as { id: string }[];
      const seq = this.nextSeq();
      const revoke = this.db.prepare('INSERT INTO share_revocations (note_id, user_id, seq) VALUES (?, ?, ?)');
      for (const n of live) for (const m of members) revoke.run(n.id, m, seq);
      // Cascades to the notes (history, releases, trash, links), the memberships and the attachment rows
      this.db.prepare('DELETE FROM users WHERE id = ? AND is_group = 1').run(groupId);
      return members;
    });
  }

  /** Everything the user shares, for the account export (#93): direct note shares, shared folders and public links */
  shareOverview(userId: string): {
    notes: { noteId: string; path: string; username: string; canWrite: boolean }[];
    folders: { folder: string; username: string; canWrite: boolean; canCreate: boolean; canDelete: boolean }[];
    publicLinks: { noteId: string; path: string }[];
  } {
    const paths = new Map(this.ownedNotes(userId).map((n) => [n.id, n.path]));
    const direct = this.db
      .prepare(
        'SELECT shares.note_id, users.username, shares.can_write FROM shares JOIN notes ON notes.id = shares.note_id JOIN users ON users.id = shares.user_id WHERE notes.owner_id = ? AND notes.deleted = 0 AND shares.folder_share_id IS NULL ORDER BY users.username_lower'
      )
      .all(userId) as { note_id: string; username: string; can_write: number }[];
    const names = new Map<string, string>();
    const nameOf = (id: string) => {
      if (!names.has(id)) names.set(id, (this.db.prepare('SELECT username FROM users WHERE id = ?').get(id) as { username: string } | undefined)?.username ?? '');
      return names.get(id)!;
    };
    const links = this.db.prepare('SELECT public_links.note_id FROM public_links JOIN notes ON notes.id = public_links.note_id WHERE notes.owner_id = ? AND notes.deleted = 0').all(userId) as { note_id: string }[];
    return {
      notes: direct.filter((r) => paths.has(r.note_id)).map((r) => ({ noteId: r.note_id, path: paths.get(r.note_id)!, username: r.username, canWrite: !!r.can_write })),
      folders: this.folderSharesOf(userId).map((f) => ({ folder: f.folder, username: nameOf(f.userId), canWrite: f.canWrite, canCreate: f.canCreate, canDelete: f.canDelete })),
      publicLinks: links.filter((l) => paths.has(l.note_id)).map((l) => ({ noteId: l.note_id, path: paths.get(l.note_id)! })),
    };
  }

  /** All saved states of an own note with their content, newest first (account export with history) */
  historyOf(userId: string, noteId: string): { savedAt: number; path: string; content: string }[] {
    this.ownedRow(userId, noteId);
    const rows = this.db.prepare('SELECT * FROM note_versions WHERE note_id = ? ORDER BY saved_at DESC, rowid DESC').all(noteId) as unknown as VersionRow[];
    return rows.map((r) => {
      const v = this.versionOf(r);
      return { savedAt: r.saved_at, path: v.path, content: v.content };
    });
  }

  /** Database notes on the server (#76); reads every note, so callers keep the answer for a while */
  countDatabases(): number {
    let n = 0;
    for (const row of this.db.prepare('SELECT id, payload FROM notes WHERE deleted = 0').iterate() as Iterable<NoteRow>) {
      if (isSchemaPath(this.payload(row).path)) n++;
    }
    return n;
  }

  counts(): { notes: number; shares: number } {
    const n = this.db.prepare('SELECT COUNT(*) AS n FROM notes WHERE deleted = 0').get() as { n: number };
    const s = this.db.prepare('SELECT COUNT(*) AS n FROM shares').get() as { n: number };
    return { notes: n.n, shares: s.n };
  }
}
