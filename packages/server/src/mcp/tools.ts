import crypto from 'crypto';
import {
  FEATURES_SETTING,
  INBOX_FOLDER,
  dailyDueResolver,
  normalizeFeatures,
  LinkIndex,
  QueryError,
  SYSTEM_PREFIX,
  extractMeta,
  joinPath,
  keepRemoteBody,
  normalizeDueWords,
  parseTasks,
  runQuery,
  semanticSearch,
  remoteNoteOf,
  searchableText,
  remoteOwnText,
  splitPath,
  toDateString,
  toggleTask,
  canWriteInGroup,
  MEMORY_TYPES,
  applyMemoryFields,
  checkMemoryNote,
  guardVerified,
  isMemoryPath,
  isReservedMemoryNote,
  isoNow,
  memoryChangeKind,
  memoryOverview,
  memoryUpkeep,
  replaceMemoryBody,
  stampGenerated,
  memoryRules,
  renameWikiLinks,
  renameTag,
  normalizeTag,
  isValidTag,
  notesByTag,
  normalizeTemplates,
  fillTemplate,
  expandInlineVariables,
  hasInlineVariables,
  templateUsesZettelId,
  zettelId,
  TEMPLATES_SETTING,
  type MemoryProblem,
  type MemoryRule,
  type FeatureSettings,
  type GroupInfo,
  type SyncedNote,
  applyTypeDefaults,
  customTypeOf,
  findNoteType,
  isHiddenPath,
  isSchemaPath,
  isMilestoneContent,
  isTicketContent,
  milestoneMeta,
  milestoneProgress,
  milestoneState,
  newTicketContent,
  checklistOf,
  parseProject,
  PRIORITIES,
  setTicketFields,
  statusCategory,
  ticketMeta,
  allowedStatuses,
  canTransition,
  MILESTONE_FOLDER,
  PARENT_KINDS,
  TICKET_KINDS,
  canHaveParent,
  ticketKindOf,
  type TicketKind,
  type Priority,
  type ProjectConfig,
} from '@kladde/shared';
import { MAX_NOTE_BYTES, NoteStore } from '../NoteStore.js';
import type { FileStore } from '../FileStore.js';
import type { AttachmentTextStore } from '../attachments/AttachmentTextStore.js';
import { attachmentPages, searchAttachments } from '../attachments/search.js';

/** Who calls a tool: tools see the notes this user owns and those of their groups (#58), never other shares */
export interface ToolContext {
  userId: string;
  canWrite: boolean;
  notes: NoteStore;
  /** Attachments (voice notes); tools that need them say so when missing */
  files?: FileStore;
  /** Extracted text of PDF/image attachments (#37); without it the searches only look at notes */
  attachmentTexts?: { texts: AttachmentTextStore; ocr: boolean };
  today?: Date;
  /** Actor id of the connection (its name), stamped into `generated.by` in the AI memory (#94) */
  agent?: string;
}

/** Search deps for attachments, when both the files and their texts are available */
function attachmentDeps(ctx: ToolContext) {
  return ctx.files && ctx.attachmentTexts ? { files: ctx.files, texts: ctx.attachmentTexts.texts, ocr: ctx.attachmentTexts.ocr } : null;
}

/** A tool result that is MCP content as is (audio), instead of JSON text */
export class ToolContent {
  constructor(readonly content: Record<string, unknown>[]) {}
}

/** Wrong input or a refused change: reported to the assistant as a tool error, not a protocol error */
export class ToolError extends Error {}

type JsonSchema = Record<string, unknown>;

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  write: boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): unknown;
}

// ------------------------------------------------------------------ helpers

/**
 * A note as the tools show it. Group notes (#58) appear below their group's name ("Familie/Projekt/Plan.md");
 * `realPath` is the path inside the group, which saving keeps.
 */
type SpaceNote = SyncedNote & { realPath?: string; groupName?: string };

/** The user's own notes without the hidden settings notes, and the notes of their groups (#58) */
function space(ctx: ToolContext): SpaceNote[] {
  const own = ctx.notes.ownedNotes(ctx.userId).filter((n) => !n.path.startsWith(SYSTEM_PREFIX));
  const grouped = ctx.notes
    .groupNotes(ctx.userId)
    .filter((n) => !n.path.startsWith(SYSTEM_PREFIX))
    .map((n): SpaceNote => ({ ...n, path: `${n.owner}/${n.path}`, realPath: n.path, groupName: n.owner }));
  return [...own, ...grouped];
}

/** The notes to list and search: without the database notes, which hold a folder's settings (read_note still opens them) */
const listed = (ctx: ToolContext): SpaceNote[] => space(ctx).filter((n) => !isHiddenPath(n.path));

/** Write tools refuse notes the user may only read (groups in which they are a reader) */
function writable(note: SpaceNote): SpaceNote {
  if (note.access === 'read') throw new ToolError(`In der Gruppe „${note.groupName ?? note.owner ?? ''}“ darfst du nur lesen.`);
  return note;
}

/** Due date for tasks without one: tasks in a daily note belong to its day (settings note of the client) */
function taskDue(ctx: ToolContext): (path: string) => string | null {
  return taskDueOf(ctx.notes, ctx.userId);
}

/** Same as `taskDue`, for callers outside the MCP (the calendar feed) */
export function taskDueOf(notes: NoteStore, userId: string): (path: string) => string | null {
  return dailyDueResolver(featuresOf(notes, userId).daily);
}

/** A value of the synced settings note of the client (features, templates, …) */
export function settingOf(notes: NoteStore, userId: string, key: string): unknown {
  const settings = notes.ownedNotes(userId).find((n) => n.id === `syssettings-${userId}`);
  try {
    return settings ? (JSON.parse(settings.content) as Record<string, unknown>)[key] : undefined;
  } catch {
    return undefined;
  }
}

/** The feature settings the client keeps in the user's settings note (daily notes, PARA, …) */
export function featuresOf(notes: NoteStore, userId: string): FeatureSettings {
  return normalizeFeatures(settingOf(notes, userId, FEATURES_SETTING));
}

const str = (args: Record<string, unknown>, key: string, required = false): string | undefined => {
  const v = args[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw new ToolError(`Parameter "${key}" fehlt.`);
    return undefined;
  }
  if (typeof v !== 'string') throw new ToolError(`Parameter "${key}" muss Text sein.`);
  return v;
};

const int = (args: Record<string, unknown>, key: string, fallback: number, max: number): number => {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new ToolError(`Parameter "${key}" muss eine ganze Zahl ≥ 0 sein.`);
  return Math.min(n, max);
};

const iso = (ms: number) => new Date(ms).toISOString();

function summary(n: SpaceNote) {
  const meta = extractMeta(n.path, n.content);
  return {
    id: n.id,
    path: n.path,
    title: meta.title,
    folder: meta.folder,
    tags: meta.tags,
    updated: iso(n.updatedAt),
    ...(n.groupName !== undefined ? { group: n.groupName, read_only: n.access === 'read' } : {}),
  };
}

/** By id, by path or by title (resolved like a [[link]]: title, frontmatter id, Zettel id) */
function findNote(notes: SpaceNote[], args: Record<string, unknown>): SpaceNote {
  const id = str(args, 'id');
  const path = str(args, 'path');
  const title = str(args, 'title');
  if (!id && !path && !title) throw new ToolError('Gib "id", "path" oder "title" an.');
  let found: SpaceNote | undefined;
  if (id) found = notes.find((n) => n.id === id);
  else if (path) {
    const p = path.replace(/^\/+/, '').toLowerCase();
    found = notes.find((n) => n.path.toLowerCase() === p || n.path.toLowerCase() === `${p}.md`);
  } else if (title) {
    const resolved = new LinkIndex(notes).resolve(title);
    found = resolved ? notes.find((n) => n.id === resolved) : notes.find((n) => splitPath(n.path).name.toLowerCase() === title.trim().toLowerCase());
  }
  if (!found) throw new ToolError('Notiz nicht gefunden. Suche sie mit search_notes oder list_notes.');
  return found;
}

/** One of the user's groups by name (or id) */
function groupOf(ctx: ToolContext, name: string): GroupInfo {
  const wanted = name.trim().toLowerCase();
  const group = ctx.notes.groupsOf(ctx.userId).find((g) => g.id === name || g.name.toLowerCase() === wanted);
  if (!group) throw new ToolError(`Die Gruppe „${name}“ gibt es nicht (oder du bist kein Mitglied). Die Gruppen stehen in list_notes → groups.`);
  return group;
}

/** A folder inside a group; a leading group name (as in the shown paths) is dropped */
function cleanGroupFolder(folder: string | undefined, groupName: string): string {
  const parts = (folder ?? '')
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p && p !== '.' && p !== '..');
  if (parts[0]?.toLowerCase() === groupName.toLowerCase()) parts.shift();
  const clean = parts.join('/');
  if (clean.startsWith(SYSTEM_PREFIX.slice(0, -1))) throw new ToolError('Dieser Ordner ist für Einstellungen reserviert.');
  return clean;
}

function cleanFolder(folder: string | undefined): string {
  const clean = (folder ?? INBOX_FOLDER)
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p && p !== '.' && p !== '..')
    .join('/');
  if (clean.startsWith(SYSTEM_PREFIX.slice(0, -1))) throw new ToolError('Dieser Ordner ist für Einstellungen reserviert.');
  return clean;
}

function uniquePath(notes: SyncedNote[], folder: string, title: string): string {
  let candidate = joinPath(folder, title);
  for (let i = 2; notes.some((n) => n.path === candidate); i++) candidate = joinPath(folder, `${title} ${i}`);
  return candidate;
}

function checkSize(content: string): void {
  if (Buffer.byteLength(content) > MAX_NOTE_BYTES) throw new ToolError('Die Notiz wäre größer als 2 MB.');
}

/** A remote note shows a file from GitLab/GitHub: only its frontmatter (`source`, `ref`) can be written */
function guardRemote(before: string | null, after: string): void {
  const isRemote = !!remoteNoteOf(after);
  const was = before !== null && !!remoteNoteOf(before);
  const ownText = remoteOwnText(after);
  if (was ? isRemote && ownText === remoteOwnText(before) : !isRemote || before !== null || !ownText) return;
  throw new ToolError('Diese Notiz zeigt ein Dokument aus GitLab/GitHub und ist schreibgeschützt: nur „source“ und „ref“ im Frontmatter lassen sich ändern, der Text wird in der Quelle bearbeitet.');
}

/** Saves through the normal sync path: next seq, live ping to the user's devices, export mirror */
function save(ctx: ToolContext, note: SpaceNote, content: string) {
  return saveWithContent(ctx, note, content).saved;
}

/** Saves and also returns the text as stored (the server numbers tickets and runs their automations) */
function saveWithContent(ctx: ToolContext, note: SpaceNote, content: string) {
  writable(note);
  guardRemote(note.content, content);
  const memory = memoryWrite(ctx, note.realPath === undefined && note.access === 'owner' ? note.path : null, note.content, content);
  content = memory.content;
  checkSize(content);
  const [result] = ctx.notes.push(ctx.userId, [
    { id: note.id, baseVersion: note.version, path: note.realPath ?? note.path, content, deleted: false, createdAt: note.createdAt, updatedAt: Date.now() },
  ]);
  if (result.status === 'conflict') throw new ToolError('Die Notiz wurde gerade geändert. Lies sie erneut und versuche es noch einmal.');
  if (result.status !== 'ok') throw new ToolError('Die Notiz konnte nicht gespeichert werden.');
  memory.after();
  const saved = {
    id: note.id,
    path: note.path,
    version: result.version,
    ...(memory.warnings.length ? { warnings: memory.warnings } : {}),
    ...(result.automations ? { automations: result.automations } : {}),
  };
  return { saved, content: result.content ?? content };
}

// ------------------------------------------------------------------ AI memory (#94)

/** The memory folder when the user turned the AI memory on, else null */
function memoryFolder(ctx: ToolContext): string | null {
  const memory = featuresOf(ctx.notes, ctx.userId).memory;
  return memory.enabled ? memory.folder : null;
}

/** The memory folder and its rules for the MCP instructions, resources and prompts; null when off */
export function memoryRulesOf(ctx: ToolContext): { folder: string; rules: MemoryRule[] } | null {
  const folder = memoryFolder(ctx);
  if (!folder) return null;
  const own = ctx.notes.ownedNotes(ctx.userId).filter((n) => !n.path.startsWith(SYSTEM_PREFIX));
  return { folder, rules: memoryRules(own, folder) };
}

const agentOf = (ctx: ToolContext) => ctx.agent || 'agent';
const describeProblems = (problems: MemoryProblem[]) => problems.map((p) => `- ${p.message}`).join('\n');

/** Link check and duplicate titles over the user's own notes, with `path` holding `content` */
function memoryCheckContext(ctx: ToolContext, path: string, content: string) {
  const own = ctx.notes.ownedNotes(ctx.userId).filter((n) => !n.path.startsWith(SYSTEM_PREFIX));
  const notes = [...own.filter((n) => n.path !== path), { id: '\u0000new', path, content }];
  const index = new LinkIndex(notes);
  return { notes, index };
}

/**
 * Checks and stamps a write into the memory: human confirmations stay as they were, `generated` names this
 * connection, errors in the format refuse the write. `after()` updates the index and the log once saved.
 * Writes outside the memory (and to index/log) pass unchanged.
 */
function memoryWrite(ctx: ToolContext, path: string | null, before: string | null, content: string): { content: string; warnings: string[]; after: () => void } {
  const folder = memoryFolder(ctx);
  const none = { content, warnings: [], after: () => undefined };
  if (!folder || path === null || !isMemoryPath(path, folder) || isReservedMemoryNote(path)) return none;
  const agent = agentOf(ctx);
  const guarded = guardVerified(before, content, agent);
  if ('error' in guarded) throw new ToolError(guarded.error);
  const stamped = stampGenerated(guarded.content, agent, isoNow());
  const { index } = memoryCheckContext(ctx, path, stamped);
  const problems = checkMemoryNote(path, stamped, { resolveLink: (t) => !!index.resolve(t) });
  const errors = problems.filter((p) => p.level === 'error');
  if (errors.length) throw new ToolError(`Nicht gespeichert, die Notiz im KI-Gedächtnis „${folder}“ verletzt das Format:\n${describeProblems(errors)}`);
  return {
    content: stamped,
    warnings: problems.map((p) => p.message),
    after: () => upkeep(ctx, folder, path, { kind: memoryChangeKind(before, stamped), actor: agent, date: isoNow().slice(0, 10) }),
  };
}

/** Writes the index and log notes after a change in the memory */
function upkeep(ctx: ToolContext, folder: string, path: string, log: Parameters<typeof memoryUpkeep>[4]): void {
  const own = ctx.notes.ownedNotes(ctx.userId).filter((n) => !n.path.startsWith(SYSTEM_PREFIX));
  const index = new LinkIndex(own);
  const writes = memoryUpkeep(own, folder, path, (t) => index.resolve(t), log);
  const byId = new Map(own.map((n) => [n.id, n]));
  const now = Date.now();
  const changes = writes.map((w) => {
    const old = w.id ? byId.get(w.id) : undefined;
    return old
      ? { id: old.id, baseVersion: old.version, path: old.path, content: w.content, deleted: false, createdAt: old.createdAt, updatedAt: now }
      : { id: crypto.randomBytes(16).toString('hex'), baseVersion: 0, path: w.path, content: w.content, deleted: false, createdAt: now, updatedAt: now };
  });
  if (changes.length) ctx.notes.push(ctx.userId, changes);
}

function snippet(content: string, word: string): string {
  const lower = content.toLowerCase();
  const at = Math.max(0, lower.indexOf(word));
  const start = Math.max(0, at - 60);
  return `${start > 0 ? '…' : ''}${content.slice(start, at + 140).replace(/\s+/g, ' ').trim()}${at + 140 < content.length ? '…' : ''}`;
}

// ------------------------------------------------------------------ organizing (#90)

/** The notes sharing a path space with `note`: the own notes, or the notes of its group (by their path inside it) */
function pathSpace(ctx: ToolContext, note: SpaceNote): SyncedNote[] {
  return note.group
    ? space(ctx)
        .filter((n) => n.group === note.group)
        .map((n) => ({ ...n, path: n.realPath ?? n.path }))
    : ctx.notes.ownedNotes(ctx.userId);
}

/** The index and log of the AI memory are kept by Kladde: they are neither moved, renamed nor deleted */
function guardReserved(ctx: ToolContext, note: SpaceNote): void {
  const folder = memoryFolder(ctx);
  if (folder && note.realPath === undefined && isMemoryPath(note.path, folder) && isReservedMemoryNote(note.path)) {
    throw new ToolError('Index und Log des KI-Gedächtnisses pflegt Kladde selbst.');
  }
}

/** Moves and/or renames a note through the sync path; a new title rewrites [[links]] to it in every note the user may edit */
function relocate(ctx: ToolContext, note: SpaceNote, folder: string, title: string) {
  writable(note);
  guardReserved(ctx, note);
  const current = note.realPath ?? note.path;
  const oldName = splitPath(current).name;
  const target = joinPath(folder, title);
  if (target === current) return { id: note.id, path: note.path, version: note.version, relinked: 0 };
  const taken = pathSpace(ctx, note).filter((n) => n.id !== note.id);
  if (taken.some((n) => n.path.toLowerCase() === target.toLowerCase())) throw new ToolError(`„${target}“ gibt es schon. Wähle einen anderen Titel oder Ordner.`);
  const [result] = ctx.notes.push(ctx.userId, [
    { id: note.id, baseVersion: note.version, path: target, content: note.content, deleted: false, createdAt: note.createdAt, updatedAt: Date.now() },
  ]);
  if (result.status === 'conflict') throw new ToolError('Die Notiz wurde gerade geändert. Versuche es noch einmal.');
  if (result.status !== 'ok') throw new ToolError('Diese Notiz darfst du nicht verschieben oder umbenennen.');
  let relinked = 0;
  if (oldName !== title) {
    for (const n of space(ctx)) {
      if (n.id === note.id || n.access === 'read' || !n.content.includes('[[')) continue;
      const content = renameWikiLinks(n.content, oldName, title);
      if (content === n.content) continue;
      try {
        save(ctx, n, content);
        relinked++;
      } catch {
        // a note changed meanwhile keeps its old link; the move itself stands
      }
    }
  }
  const shown = note.groupName !== undefined ? `${note.groupName}/${target}` : target;
  return { id: note.id, path: shown, version: result.version, relinked };
}

/** Own templates of the user (kept in the synced settings note) */
function templatesOf(ctx: ToolContext) {
  return normalizeTemplates(settingOf(ctx.notes, ctx.userId, TEMPLATES_SETTING));
}

/** Creates a note in the own space or in a group; shared by create_note and create_from_template */
function createNote(ctx: ToolContext, opts: { title: string; content: string; folder?: string; group?: string; defaultFolder?: string }) {
  const group = opts.group !== undefined ? groupOf(ctx, opts.group) : undefined;
  if (group && !canWriteInGroup(group.role)) throw new ToolError(`In der Gruppe „${group.name}“ darfst du nur lesen.`);
  const folder = group ? cleanGroupFolder(opts.folder, group.name) : cleanFolder(opts.folder ?? opts.defaultFolder);
  let content = normalizeDueWords(opts.content, ctx.today ?? new Date());
  // Paths are unique per space: the own notes, or the notes of the group (by their path inside it)
  const taken: SyncedNote[] = group
    ? space(ctx)
        .filter((n) => n.group === group.id)
        .map((n) => ({ ...n, path: n.realPath ?? n.path }))
    : ctx.notes.ownedNotes(ctx.userId);
  guardRemote(null, content);
  const path = uniquePath(taken, folder, opts.title);
  // `!{{…}}` (shared/variables.ts) gets its value once, like in the app
  if (hasInlineVariables(content)) content = expandInlineVariables(content, ctx.notes.variablesOf(group ? group.id : ctx.userId, splitPath(path).folder));
  const memory = memoryWrite(ctx, group ? null : path, null, content);
  content = memory.content;
  checkSize(content);
  const now = Date.now();
  const id = crypto.randomBytes(16).toString('hex');
  const [result] = ctx.notes.push(ctx.userId, [{ id, baseVersion: 0, path, content, deleted: false, createdAt: now, updatedAt: now, ...(group ? { group: group.id } : {}) }]);
  if (result.status !== 'ok') throw new ToolError('Die Notiz konnte nicht angelegt werden.');
  memory.after();
  return {
    id,
    path: group ? `${group.name}/${path}` : path,
    version: result.version,
    ...(group ? { group: group.name } : {}),
    ...(memory.warnings.length ? { warnings: memory.warnings } : {}),
  };
}


// ------------------------------------------------------------------ tickets

interface ToolProject {
  config: ProjectConfig;
  /** Folder as the tools show it (group notes below the group's name) */
  folder: string;
  /** Folder inside its space */
  realFolder: string;
  group?: GroupInfo;
  readOnly: boolean;
}

/** Projects in folders where tickets are on: own ones with the user's feature, group ones when the group switched it on */
function projectsOf(ctx: ToolContext, notes = space(ctx)): ToolProject[] {
  const own = featuresOf(ctx.notes, ctx.userId).tickets.enabled;
  const groups = ctx.notes.groupsOf(ctx.userId);
  const out: ToolProject[] = [];
  for (const n of notes) {
    if (!isSchemaPath(n.path)) continue;
    const config = parseProject(n.content);
    if (!config) continue;
    const group = n.group ? groups.find((g) => g.id === n.group) : undefined;
    if (group ? !group.features?.tickets : !own || n.access !== 'owner') continue;
    out.push({ config, folder: splitPath(n.path).folder, realFolder: splitPath(n.realPath ?? n.path).folder, ...(group ? { group } : {}), readOnly: n.access === 'read' });
  }
  return out;
}

/** A project by its key or folder */
function findProject(projects: ToolProject[], ref: string): ToolProject {
  const r = ref.trim().replace(/\/+$/, '').toLowerCase();
  const found = projects.filter((p) => p.config.key.toLowerCase() === r || p.folder.toLowerCase() === r);
  if (found.length > 1) throw new ToolError(`Mehrere Projekte heißen „${ref}“: gib den Ordner an (${found.map((p) => p.folder).join(', ')}).`);
  if (!found.length) {
    if (!projects.length) throw new ToolError('Es gibt keine Projekte mit Tickets. Tickets müssen eingeschaltet sein (eigene Funktion „Tickets & Meilensteine“, in Gruppen von den Eigentümern).');
    throw new ToolError(`Projekt „${ref}“ nicht gefunden. Projekte: ${projects.map((p) => `${p.config.key} (${p.folder})`).join(', ')}.`);
  }
  return found[0];
}

const ticketsIn = (notes: SpaceNote[], project: ToolProject) => notes.filter((n) => splitPath(n.path).folder === project.folder && isTicketContent(n.content));
const milestonesIn = (notes: SpaceNote[], project: ToolProject) => notes.filter((n) => splitPath(n.path).folder === `${project.folder}/${MILESTONE_FOLDER}` && isMilestoneContent(n.content));

function ticketSummary(n: SpaceNote, project: ToolProject) {
  const m = ticketMeta(n.content);
  return {
    ticket: m.id,
    note_id: n.id,
    title: extractMeta(n.path, n.content).title,
    path: n.path,
    kind: m.kind,
    parent: m.parent,
    status: m.status,
    category: statusCategory(project.config, m.status),
    priority: m.priority,
    milestone: m.milestone,
    assignee: m.assignee,
    estimate: m.estimate,
    labels: m.labels,
    docs: m.docs,
    blocks: m.blocks,
    blockedBy: m.blockedBy,
    version: n.version,
  };
}

/** A ticket by its id (`KLD-118`), note id or title, within the projects where tickets are on */
function findTicket(ctx: ToolContext, ref: string): { note: SpaceNote; project: ToolProject; notes: SpaceNote[] } {
  const notes = space(ctx);
  const projects = projectsOf(ctx, notes);
  const wanted = ref.trim().toLowerCase();
  for (const project of projects) {
    for (const n of ticketsIn(notes, project)) {
      if (n.id === ref || ticketMeta(n.content).id?.toLowerCase() === wanted || extractMeta(n.path, n.content).title.toLowerCase() === wanted) return { note: n, project, notes };
    }
  }
  throw new ToolError(`Ticket „${ref}“ nicht gefunden. Suche es mit list_tickets.`);
}

const strList = (args: Record<string, unknown>, key: string): string[] | undefined => {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new ToolError(`Parameter "${key}" muss eine Liste von Texten sein.`);
  return (v as string[]).map((x) => x.trim()).filter(Boolean);
};

/** A status of the project, matched case-insensitively */
function projectStatus(project: ToolProject, status: string | undefined): string | undefined {
  if (status === undefined) return undefined;
  const found = project.config.workflow.find((s) => s.toLowerCase() === status.trim().toLowerCase());
  if (!found) throw new ToolError(`Unbekannter Status „${status}“. Erlaubt: ${project.config.workflow.join(', ')}.`);
  return found;
}

function priorityArg(args: Record<string, unknown>): Priority | undefined {
  const p = str(args, 'priority');
  if (p === undefined) return undefined;
  if (!(PRIORITIES as readonly string[]).includes(p)) throw new ToolError(`Priorität muss ${PRIORITIES.join(', ')} sein.`);
  return p as Priority;
}

function kindArg(args: Record<string, unknown>): TicketKind | undefined {
  const k = str(args, 'kind');
  if (k === undefined) return undefined;
  if (!(TICKET_KINDS as readonly string[]).includes(k.trim().toLowerCase())) throw new ToolError(`Typ muss ${TICKET_KINDS.join(', ')} sein.`);
  return ticketKindOf(k);
}

/** The id of the parent ticket in the same project, checked against the type hierarchy; null removes the parent */
function parentArg(ctx: ToolContext, project: ToolProject, kind: TicketKind, ref: string | undefined, self?: string): string | null {
  if (!ref?.trim()) return null;
  if (!PARENT_KINDS[kind].length) throw new ToolError(`Ein ${kind} hat kein übergeordnetes Ticket.`);
  const found = findTicket(ctx, ref);
  if (found.project.folder !== project.folder) throw new ToolError('Das übergeordnete Ticket muss im selben Projekt liegen.');
  const meta = ticketMeta(found.note.content);
  if (found.note.id === self) throw new ToolError('Ein Ticket kann nicht unter sich selbst hängen.');
  if (!meta.id || meta.provisional) throw new ToolError('Das übergeordnete Ticket hat noch keine Nummer.');
  if (!canHaveParent(kind, meta.kind)) throw new ToolError(`Ein ${kind} kann nicht unter einem ${meta.kind} hängen. Erlaubt: ${PARENT_KINDS[kind].join(', ')}.`);
  return meta.id;
}

const ticketFieldsSchema: Record<string, JsonSchema> = {
  kind: { type: 'string', enum: [...TICKET_KINDS], description: 'Ticket type: epic (large goal) > feature (user-visible capability) > task or bug > subtask. Default task' },
  parent: { type: 'string', description: 'Id of the parent ticket (e.g. KLD-12): a feature below an epic, a task or bug below a feature or epic, a subtask below a task, bug or feature. Empty string removes it' },
  status: { type: 'string', description: 'A status of the project workflow (see list_projects)' },
  priority: { type: 'string', enum: [...PRIORITIES] },
  milestone: { type: 'string', description: 'Title or id of a milestone of the project' },
  assignee: { type: 'string', description: 'Username (without @); empty string removes it' },
  estimate: { type: 'number', description: 'Story points' },
  labels: { type: 'array', items: { type: 'string' } },
  docs: { type: 'array', items: { type: 'string' }, description: 'Titles of documentation notes ([[links]] without brackets)' },
};

// ------------------------------------------------------------------ tools

const noteRef: JsonSchema = {
  id: { type: 'string', description: 'Id der Notiz (aus list_notes/search_notes)' },
  path: { type: 'string', description: 'Pfad, z. B. "1 Projekte/Umzug.md"' },
  title: { type: 'string', description: 'Titel; wird wie ein [[Link]] aufgelöst (auch Zettel-ID)' },
};

export const TOOLS: ToolDef[] = [
  {
    name: 'list_notes',
    title: 'Notizen auflisten',
    description:
      'Lists the user\'s own notes and the notes of their groups (newest first) with id, path, title, folder and tags. Folders follow PARA: "0 Inbox", "1 Projekte", "2 Bereiche", "3 Ressourcen", "4 Archiv", plus "Zettelkasten". Group notes have paths starting with the group name and carry `group` and `read_only`; `groups` lists the groups with the user\'s role. Use `folder` to limit to a folder and its subfolders, `group` to one group.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Only this folder (with subfolders), e.g. "1 Projekte" or "Familie/Urlaub" for a group folder' },
        group: { type: 'string', description: 'Only the notes of this group (name)' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
      },
    },
    write: false,
    run(args, ctx) {
      const folder = str(args, 'folder')?.replace(/^\/+|\/+$/g, '');
      const group = str(args, 'group') !== undefined ? groupOf(ctx, str(args, 'group')!) : undefined;
      const limit = int(args, 'limit', 100, 500);
      const notes = space(ctx);
      const all = notes
        .filter((n) => !isHiddenPath(n.path) && (!folder || n.path.startsWith(`${folder}/`)) && (!group || n.group === group.id))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const folders = [...new Set(notes.map((n) => splitPath(n.path).folder).filter(Boolean))].sort();
      const groups = ctx.notes.groupsOf(ctx.userId).map((g) => ({ name: g.name, role: g.role, read_only: !canWriteInGroup(g.role) }));
      return { total: all.length, notes: all.slice(0, limit).map(summary), folders, ...(groups.length ? { groups } : {}) };
    },
  },
  {
    name: 'search_notes',
    title: 'Notizen durchsuchen',
    description:
      'Full-text search over titles, paths and contents of the user\'s own notes, and over the text of the PDFs and images embedded in them (`attachments`: file name, page number, snippet and the notes that embed the file). All words must occur (case-insensitive). Read a note with read_note.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search words' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      required: ['query'],
    },
    write: false,
    run(args, ctx) {
      const words = str(args, 'query', true)!.toLowerCase().split(/\s+/).filter(Boolean);
      const limit = int(args, 'limit', 20, 100);
      const hits: { note: SyncedNote; score: number }[] = [];
      for (const n of listed(ctx)) {
        const title = splitPath(n.path).name.toLowerCase();
        const hay = `${n.path}\n${searchableText(n)}`.toLowerCase();
        if (!words.every((w) => hay.includes(w))) continue;
        let score = words.every((w) => title.includes(w)) ? 100 : 0;
        for (const w of words) score += Math.min(20, hay.split(w).length - 1);
        hits.push({ note: n, score });
      }
      hits.sort((a, b) => b.score - a.score || b.note.updatedAt - a.note.updatedAt);
      const deps = attachmentDeps(ctx);
      const inFiles = deps ? searchAttachments(deps, space(ctx), words.join(' '), limit).hits : [];
      return {
        total: hits.length,
        results: hits.slice(0, limit).map(({ note }) => ({ ...summary(note), snippet: snippet(searchableText(note), words[0]) })),
        attachments: inFiles.map((h) => ({ file: h.name, file_id: h.fileId, page: h.page, ocr: h.ocr, snippet: h.snippet, notes: h.notes })),
      };
    },
  },
  {
    name: 'semantic_search',
    title: 'Semantische Suche',
    description:
      'Semantic similarity search over the user\'s own notes and the text of the PDFs/images embedded in them (`attachments`, with page number and the embedding notes). Understands German and English word stems, compound words (e.g. "Reisekosten"), conceptually related topics (e.g. "Urlaub" <-> "Flug", "Wohnung" <-> "Miete"), titles, tags, headings, and [[WikiLink]] graph neighbors. Returns ranked matches with score (0-1), match reasons, snippet and links.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language search query, topic, or question' },
        folder: { type: 'string', description: 'Optional: restrict results to this folder and subfolders, e.g. "1 Projekte"' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        min_score: { type: 'number', minimum: 0, maximum: 1, default: 0.05, description: 'Minimum similarity score (0..1)' },
      },
      required: ['query'],
    },
    write: false,
    run(args, ctx) {
      const query = str(args, 'query', true)!;
      const folder = str(args, 'folder')?.replace(/^\/+|\/+$/g, '');
      const limit = Math.max(1, int(args, 'limit', 10, 50));
      let minScore: number | undefined;
      if (args.min_score !== undefined && args.min_score !== null) {
        const n = Number(args.min_score);
        if (!Number.isFinite(n) || n < 0 || n > 1) throw new ToolError('Parameter "min_score" muss zwischen 0 und 1 liegen.');
        minScore = n;
      }
      const notes = listed(ctx);
      // Pages of embedded PDFs/images take part as documents of their own; a hit points to the notes embedding them
      const deps = attachmentDeps(ctx);
      const pages = deps ? attachmentPages(deps, notes).pages.filter((p) => !folder || p.notes.some((n) => n.path.startsWith(`${folder}/`))) : [];
      const pageDocs = new Map(pages.map((p, i) => [`attachment:${i}`, p]));
      const docs = [...notes, ...[...pageDocs].map(([id, p]) => ({ id, path: `${p.name} (S. ${p.page})`, content: p.text }))];
      const all = semanticSearch(query, docs, { limit: Math.min(100, limit * 2), minScore, corpusKey: ctx.userId });
      const hits = all.filter((h) => !pageDocs.has(h.note.id) && (!folder || h.note.path.startsWith(`${folder}/`))).slice(0, limit);
      const fileHits = all.filter((h) => pageDocs.has(h.note.id)).slice(0, limit);
      return {
        total: hits.length,
        attachments: fileHits.map((h) => {
          const p = pageDocs.get(h.note.id)!;
          return { file: p.name, file_id: p.fileId, page: p.page, ocr: p.ocr, score: h.score, snippet: h.snippet, notes: p.notes };
        }),
        results: hits.map((h) => ({
          ...summary(h.note as SyncedNote),
          score: h.score,
          reasons: h.reasons,
          snippet: h.snippet,
          links: h.links,
          backlinks: h.backlinks,
        })),
      };
    },
  },
  {
    name: 'read_note',
    title: 'Notiz lesen',
    description:
      'Reads one of the user\'s notes in full (Markdown with frontmatter) by id, path or title, with its version (needed for update_note), links and backlinks.',
    inputSchema: { type: 'object', properties: noteRef },
    write: false,
    run(args, ctx) {
      const notes = space(ctx);
      const note = findNote(notes, args);
      const index = new LinkIndex(notes);
      const titleOf = (id: string) => index.notes.get(id)?.title ?? id;
      const remote = remoteNoteOf(note.content);
      return {
        ...summary(note),
        version: note.version,
        created: iso(note.createdAt),
        links: index.outgoing(note.id).map(titleOf),
        backlinks: index.backlinks(note.id).map(titleOf),
        ...(remote
          ? {
              remote: {
                ...remote,
                hint: remote.sync
                  ? 'Remote note: shows this document from GitLab/GitHub read-only. With sync: true the server keeps a copy (document, read every few hours); only source, ref and sync can be changed.'
                  : 'Remote note: shows this document from GitLab/GitHub live and read-only. Its text is not stored in Kladde; only source, ref and sync can be changed.',
                ...(note.remoteSnapshot?.text ? { document: note.remoteSnapshot.text, synced: iso(note.remoteSnapshot.fetchedAt) } : {}),
              },
            }
          : {}),
        content: note.content,
      };
    },
  },
  {
    name: 'list_tasks',
    title: 'Aufgaben auflisten',
    description:
      'Lists Markdown tasks ("- [ ] …") from all of the user\'s notes, sorted by due date. Due dates are written "📅 YYYY-MM-DD", repeats "🔁 weekly", reminder times "⏰ 09:00". Use toggle_task to tick one off.',
    inputSchema: {
      type: 'object',
      properties: {
        include_done: { type: 'boolean', default: false },
        due_until: { type: 'string', description: 'Only tasks due on or before this date (YYYY-MM-DD)' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
      },
    },
    write: false,
    run(args, ctx) {
      const includeDone = args.include_done === true;
      const until = str(args, 'due_until');
      if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new ToolError('due_until braucht das Format YYYY-MM-DD.');
      const today = ctx.today ?? new Date();
      const dueOf = taskDue(ctx);
      const tasks = space(ctx).flatMap((n) =>
        parseTasks(n.content, today, dueOf(n.path))
          .filter((t) => (includeDone || !t.done) && (!until || (t.due !== null && t.due <= until)))
          .map((t) => ({ note_id: n.id, note: splitPath(n.path).name, path: n.path, line: t.line, text: t.text, done: t.done, status: t.status, due: t.due, time: t.time, repeat: t.repeat }))
      );
      tasks.sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.path.localeCompare(b.path) || a.line - b.line);
      return { today: toDateString(today), total: tasks.length, tasks: tasks.slice(0, int(args, 'limit', 200, 500)) };
    },
  },
  {
    name: 'query_notes',
    title: 'Abfrage ausführen',
    description: [
      'Runs a query in Kladde\'s query language (like Dataview) over the user\'s notes. Examples:',
      'TABLE title, status, updated FROM "1 Projekte" WHERE status != "fertig" SORT updated DESC LIMIT 20',
      'LIST WHERE tags contains "rezept"',
      'LIST FROM #bereich SORT title',
      'TASKS WHERE done = false AND due <= today',
      'Fields: title, path, folder, created, updated, tags, links, any frontmatter key; for TASKS also text, due, time, done, note.',
      'Operators: = != < <= > >= contains ~ (substring). AND binds tighter than OR. Values: "text", numbers, YYYY-MM-DD, today, tomorrow, true/false.',
      'Tags nest with "/": FROM #area and tags contains "area" also match notes tagged #area/health.',
      'Aggregates in TABLE: COUNT, SUM(field), AVG(field), MIN(field), MAX(field) (returned in totals); GROUP BY <field> for TABLE and LIST returns groups with their count and aggregates, e.g.',
      'TABLE status, COUNT, SUM(hours) FROM "1 Projekte" GROUP BY status',
    ].join('\n'),
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    write: false,
    run(args, ctx) {
      try {
        const result = runQuery(str(args, 'query', true)!, listed(ctx), ctx.today ?? new Date(), { defaultDue: taskDue(ctx) });
        const rows = result.rows.slice(0, 500).map((r) => {
          const values = Object.fromEntries(
            Object.entries(r.values).map(([k, v]) => [k, (k === 'created' || k === 'updated') && typeof v === 'number' ? iso(v) : v])
          );
          const fields = result.query.mode === 'table' ? Object.fromEntries(result.columns.map((c) => [c, values[c] ?? null])) : result.query.mode === 'tasks' ? { text: values.text, due: values.due || null, done: values.done, status: values.status, repeat: values.repeat || null } : { title: values.title };
          return { note_id: r.noteId, path: r.path, ...(r.line !== undefined ? { line: r.line } : {}), ...fields };
        });
        const extra = {
          ...(result.totals ? { totals: result.totals } : {}),
          ...(result.groups
            ? { groups: result.groups.map((g) => ({ key: g.key, count: g.rows.length, ...(result.totals ? { aggregates: g.aggregates } : {}), note_ids: g.rows.map((r) => r.noteId) })) }
            : {}),
        };
        return { mode: result.query.mode, total: result.rows.length, ...extra, rows };
      } catch (err) {
        if (err instanceof QueryError) throw new ToolError(`Abfrage ungültig: ${err.message}`);
        throw err;
      }
    },
  },
  {
    name: 'create_note',
    title: 'Notiz anlegen',
    description:
      'Creates a new note in the user\'s space (default folder "0 Inbox"), or with `group` in that group (owners and editors only; `folder` is then a folder inside the group, default its top level). Content is Markdown; link other notes with [[Title]], tasks as "- [ ] text 📅 YYYY-MM-DD". An existing title gets a number appended.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string', description: 'Markdown body' },
        folder: { type: 'string', description: 'e.g. "1 Projekte" or "3 Ressourcen/Rezepte"; default "0 Inbox" (in a group: its top level)' },
        group: { type: 'string', description: 'Name of a group to create the note in (see list_notes → groups)' },
      },
      required: ['title'],
    },
    write: true,
    run(args, ctx) {
      const title = str(args, 'title', true)!.trim().slice(0, 200);
      return createNote(ctx, { title, content: str(args, 'content') ?? '', folder: str(args, 'folder'), group: str(args, 'group') });
    },
  },
  {
    name: 'update_note',
    title: 'Notiz ersetzen',
    description:
      'Replaces the full content of one of the user\'s notes (or of a group note, unless the user only reads in that group). Pass the `version` you got from read_note: if the note changed since, nothing is written and you must read it again. Title and folder stay the same: use rename_note or move_note for those (they keep links working).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        content: { type: 'string', description: 'New full Markdown content' },
        version: { type: 'integer', description: 'Version from read_note' },
      },
      required: ['id', 'content', 'version'],
    },
    write: true,
    run(args, ctx) {
      const note = findNote(space(ctx), { id: str(args, 'id', true) });
      const version = Number(args.version);
      if (version !== note.version) throw new ToolError(`Die Notiz hat inzwischen Version ${note.version}. Lies sie erneut mit read_note, bevor du sie änderst.`);
      return save(ctx, note, normalizeDueWords(typeof args.content === 'string' ? args.content : '', ctx.today ?? new Date()));
    },
  },
  {
    name: 'append_to_note',
    title: 'An Notiz anhängen',
    description: 'Appends Markdown to the end of one of the user\'s notes (e.g. a new task or a paragraph). List items continue an existing list.',
    inputSchema: {
      type: 'object',
      properties: { ...noteRef, text: { type: 'string', description: 'Markdown to append' } },
      required: ['text'],
    },
    write: true,
    run(args, ctx) {
      const note = findNote(space(ctx), args);
      const text = str(args, 'text', true)!.replace(/^\n+|\s+$/g, '');
      const body = note.content.replace(/\s+$/, '');
      const listItem = /^\s*(?:[-*+]|\d+\.)\s/;
      // A list item right after a list continues it; everything else starts a new paragraph
      const continuesList = listItem.test(text) && listItem.test(body.slice(body.lastIndexOf('\n') + 1));
      const content = body ? `${body}${continuesList ? '\n' : '\n\n'}${text}\n` : `${text}\n`;
      return save(ctx, note, normalizeDueWords(content, ctx.today ?? new Date()));
    },
  },
  {
    name: 'read_voice_note',
    title: 'Sprachnotiz anhören',
    description:
      'Returns a voice recording embedded in one of the user\'s notes as audio, so you can transcribe it. Then add the text with append_to_note (e.g. as a quote below the recording). `index` picks the n-th recording of the note (0 = first).',
    inputSchema: {
      type: 'object',
      properties: { ...noteRef, index: { type: 'integer', minimum: 0, default: 0 } },
    },
    write: false,
    run(args, ctx) {
      if (!ctx.files) throw new ToolError('Anhänge sind über diese Verbindung nicht verfügbar.');
      const note = findNote(space(ctx), args);
      const recordings: { id: string; line: number }[] = [];
      note.content.split('\n').forEach((text, line) => {
        for (const m of text.matchAll(/\/api\/files\/([A-Za-z0-9_-]{22})/g)) {
          // The note is visible to the user, so are its files (also when another group member recorded them)
          const meta = ctx.files!.meta(m[1]);
          if (meta?.mime.startsWith('audio/')) recordings.push({ id: m[1], line });
        }
      });
      if (!recordings.length) throw new ToolError('Diese Notiz enthält keine Sprachaufnahme.');
      const pick = recordings[int(args, 'index', 0, recordings.length - 1)];
      const file = ctx.files.load(pick.id);
      if (!file) throw new ToolError('Die Aufnahme konnte nicht gelesen werden.');
      if (file.data.length > 10 * 1024 * 1024) throw new ToolError('Die Aufnahme ist größer als 10 MB.');
      return new ToolContent([
        { type: 'text', text: JSON.stringify({ note_id: note.id, path: note.path, line: pick.line, name: file.name, mime: file.mime, recordings: recordings.length }) },
        { type: 'audio', data: file.data.toString('base64'), mimeType: file.mime },
      ]);
    },
  },
  {
    name: 'move_note',
    title: 'Notiz verschieben',
    description:
      'Moves a note into another folder (e.g. from "0 Inbox" to "1 Projekte/Umzug"), optionally with a new title. Group notes move inside their group (`folder` is a folder of the group). Links to it keep working; a new title rewrites [[links]] in the other notes. Readers of a group cannot move its notes.',
    inputSchema: {
      type: 'object',
      properties: {
        ...noteRef,
        folder: { type: 'string', description: 'Target folder, e.g. "1 Projekte/Umzug"; "" for the top level' },
        new_title: { type: 'string', description: 'Optional new title' },
      },
      required: ['folder'],
    },
    write: true,
    run(args, ctx) {
      const note = findNote(space(ctx), args);
      const raw = typeof args.folder === 'string' ? args.folder : undefined;
      if (raw === undefined) throw new ToolError('Parameter "folder" fehlt.');
      const folder = note.groupName !== undefined ? cleanGroupFolder(raw, note.groupName) : cleanFolder(raw);
      const title = (str(args, 'new_title') ?? splitPath(note.realPath ?? note.path).name).trim().replace(/\//g, '-').slice(0, 200);
      if (!title) throw new ToolError('Der Titel darf nicht leer sein.');
      return relocate(ctx, note, folder, title);
    },
  },
  {
    name: 'rename_note',
    title: 'Notiz umbenennen',
    description: 'Gives a note a new title (its file name) in the same folder. Every [[Old Title]] link in the notes the user may edit is rewritten to the new title.',
    inputSchema: {
      type: 'object',
      properties: { ...noteRef, new_title: { type: 'string' } },
      required: ['new_title'],
    },
    write: true,
    run(args, ctx) {
      const note = findNote(space(ctx), args);
      const title = str(args, 'new_title', true)!.trim().replace(/\//g, '-').slice(0, 200);
      if (!title) throw new ToolError('Der Titel darf nicht leer sein.');
      return relocate(ctx, note, splitPath(note.realPath ?? note.path).folder, title);
    },
  },
  {
    name: 'delete_note',
    title: 'Notiz löschen',
    description: 'Moves a note into the trash. The user can restore it in the app until the trash is emptied. Readers of a group cannot delete its notes.',
    inputSchema: { type: 'object', properties: noteRef },
    write: true,
    run(args, ctx) {
      const note = writable(findNote(space(ctx), args));
      guardReserved(ctx, note);
      const [result] = ctx.notes.push(ctx.userId, [
        { id: note.id, baseVersion: note.version, path: note.realPath ?? note.path, content: note.content, deleted: true, createdAt: note.createdAt, updatedAt: Date.now() },
      ]);
      if (result.status === 'conflict') throw new ToolError('Die Notiz wurde gerade geändert. Versuche es noch einmal.');
      if (result.status !== 'ok') throw new ToolError('Diese Notiz darfst du nicht löschen.');
      return { id: note.id, path: note.path, trashed: true };
    },
  },
  {
    name: 'list_tags',
    title: 'Tags auflisten',
    description: 'Lists the tags (#tag in the text and `tags:` in the frontmatter) of the user\'s notes and their groups\' notes with note counts, most used first. Tags nest with "/" (#area/health).',
    inputSchema: {
      type: 'object',
      properties: { prefix: { type: 'string', description: 'Only this tag and the tags below it, e.g. "area"' } },
    },
    write: false,
    run(args, ctx) {
      const prefix = str(args, 'prefix') !== undefined ? normalizeTag(str(args, 'prefix')!) : '';
      const tags = [...notesByTag(space(ctx))]
        .filter(([tag]) => !prefix || tag === prefix || tag.startsWith(`${prefix}/`))
        .map(([tag, ids]) => ({ tag, count: ids.length }))
        .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
      return { total: tags.length, tags };
    },
  },
  {
    name: 'rename_tag',
    title: 'Tag umbenennen',
    description: 'Renames a tag (and the tags nested below it) in all of the user\'s own notes, in the text and in the frontmatter. Renaming onto an existing tag merges both.',
    inputSchema: {
      type: 'object',
      properties: { from: { type: 'string', description: 'Current tag, with or without #' }, to: { type: 'string', description: 'New tag' } },
      required: ['from', 'to'],
    },
    write: true,
    run(args, ctx) {
      const from = normalizeTag(str(args, 'from', true)!);
      const to = normalizeTag(str(args, 'to', true)!);
      if (!isValidTag(from) || !isValidTag(to)) throw new ToolError('Tags bestehen aus Buchstaben, Ziffern, _, - und / (nicht nur Ziffern).');
      if (from === to) return { from, to, changed: 0, notes: [] };
      const changed: string[] = [];
      for (const n of space(ctx)) {
        if (n.access !== 'owner' || n.realPath !== undefined) continue;
        const content = keepRemoteBody(n.content, renameTag(n.content, from, to));
        if (content === n.content) continue;
        save(ctx, n, content);
        changed.push(n.path);
      }
      return { from, to, changed: changed.length, notes: changed };
    },
  },
  {
    name: 'list_templates',
    title: 'Vorlagen auflisten',
    description: 'Lists the user\'s note templates (id, name, target folder, content). Placeholders: {{title}}, {{date}}, {{zid}} (Zettel id, also put before the title).',
    inputSchema: { type: 'object', properties: {} },
    write: false,
    run(_args, ctx) {
      return { templates: templatesOf(ctx).map((t) => ({ id: t.id, name: t.label, folder: t.folder || INBOX_FOLDER, content: t.content })) };
    },
  },
  {
    name: 'create_from_template',
    title: 'Notiz aus Vorlage',
    description:
      'Creates a new note from one of the user\'s templates (see list_templates), filling {{title}}, {{date}} and {{zid}}. It goes to the template\'s folder unless `folder` is given; with `group` into that group. `content` is appended below the template text.',
    inputSchema: {
      type: 'object',
      properties: {
        template: { type: 'string', description: 'Template id or name' },
        title: { type: 'string' },
        folder: { type: 'string' },
        group: { type: 'string', description: 'Name of a group to create the note in' },
        content: { type: 'string', description: 'Optional Markdown appended below the template' },
      },
      required: ['template', 'title'],
    },
    write: true,
    run(args, ctx) {
      const wanted = str(args, 'template', true)!.trim();
      const template = templatesOf(ctx).find((t) => t.id === wanted) ?? templatesOf(ctx).find((t) => t.label.toLowerCase() === wanted.toLowerCase());
      if (!template) throw new ToolError(`Die Vorlage „${wanted}“ gibt es nicht. Die Vorlagen stehen in list_templates.`);
      const title = str(args, 'title', true)!.trim().slice(0, 200);
      const zid = zettelId(ctx.today ?? new Date());
      let content = fillTemplate(template.content, { title, zid, date: toDateString(ctx.today ?? new Date()) });
      // A custom note type fills its defaults in: the group's type, else the own one
      const typeName = customTypeOf(content);
      if (typeName !== null) {
        const groupName = str(args, 'group');
        const inGroup = groupName !== undefined ? groupOf(ctx, groupName) : undefined;
        const type = (inGroup && findNoteType(ctx.notes.noteTypesOf(inGroup.id), typeName)) ?? findNoteType(ctx.notes.noteTypesOf(ctx.userId), typeName);
        if (type) content = applyTypeDefaults(content, type, { title, zid, date: toDateString(ctx.today ?? new Date()) });
      }
      const extra = str(args, 'content')?.replace(/^\n+|\s+$/g, '');
      if (extra) content = `${content.replace(/\s+$/, '')}${content.trim() ? '\n\n' : ''}${extra}\n`;
      const name = templateUsesZettelId(template.content) ? `${zid} ${title}` : title;
      return { template: template.label, ...createNote(ctx, { title: name, content, folder: str(args, 'folder'), group: str(args, 'group'), defaultFolder: template.folder || INBOX_FOLDER }) };
    },
  },
  {
    name: 'toggle_task',
    title: 'Aufgabe abhaken',
    description:
      'Ticks (or unticks) the task in a given line of a note, as from list_tasks. A repeating task gets its next occurrence added automatically.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Note id' }, line: { type: 'integer', minimum: 0, description: '0-based line from list_tasks' } },
      required: ['id', 'line'],
    },
    write: true,
    run(args, ctx) {
      const note = findNote(space(ctx), { id: str(args, 'id', true) });
      const line = int(args, 'line', -1, 1_000_000);
      const today = ctx.today ?? new Date();
      const task = parseTasks(note.content, today).find((t) => t.line === line);
      if (!task) throw new ToolError(`In Zeile ${line} steht keine Aufgabe. Hole die Zeilen mit list_tasks.`);
      const saved = save(ctx, note, toggleTask(note.content, line, today));
      return { ...saved, task: task.text, done: !task.done };
    },
  },
  {
    name: 'memory_save',
    title: 'Im KI-Gedächtnis speichern',
    description: [
      'Creates or updates a note in the AI memory, the shared, provider-independent knowledge folder the user turned on (see the instructions).',
      'Use it for lasting knowledge: facts about products and tools (Reference), how to do something (Technique), decisions (Decision), the user\'s preferences (Preference); Rule notes are instructions the user gives to assistants.',
      'Kladde writes the frontmatter (type, title, description, tags, status, stale_after, sources), stamps `generated` with this connection, checks the format and updates `index` and `log`.',
      'A note with this title in `folder` is updated: pass the `version` from read_note, and leave out `content` to keep the text. Cite sources in the text as footnotes [^id].',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title (file name) of the note' },
        type: { type: 'string', description: `Kind of knowledge: ${MEMORY_TYPES.join(', ')} or your own` },
        description: { type: 'string', description: 'One sentence for the index and search' },
        content: { type: 'string', description: 'Markdown body without frontmatter; link notes with [[Title]]' },
        folder: { type: 'string', description: 'Subfolder inside the memory, e.g. "Produkte"; default its top level' },
        tags: { type: 'array', items: { type: 'string' } },
        status: { type: 'string', enum: ['draft', 'stable', 'deprecated'] },
        stale_after: { type: 'string', description: 'Date (YYYY-MM-DD) after which the knowledge should be checked again' },
        resource: { type: 'string', description: 'URL of the thing the note describes' },
        sources: {
          type: 'array',
          items: { type: 'object', properties: { id: { type: 'string' }, resource: { type: 'string' }, title: { type: 'string' } }, required: ['id'] },
        },
        version: { type: 'integer', description: 'Version from read_note when the note exists' },
      },
      required: ['title', 'type'],
    },
    write: true,
    run(args, ctx) {
      const folder = memoryFolder(ctx);
      if (!folder) throw new ToolError('Das KI-Gedächtnis ist nicht eingeschaltet. Der Nutzer schaltet es in Kladde unter Einstellungen → Funktionen ein.');
      const title = str(args, 'title', true)!.trim().slice(0, 200);
      if (/^(index|log)$/i.test(title)) throw new ToolError('„index“ und „log“ pflegt Kladde selbst.');
      const sub = cleanFolder(str(args, 'folder') ?? '');
      const target = sub ? `${folder}/${sub}` : folder;
      const path = joinPath(target, title.replace(/[\\/]/g, '-'));
      const tags = Array.isArray(args.tags) ? args.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim().replace(/^#/, '')).filter(Boolean) : undefined;
      const sources = Array.isArray(args.sources)
        ? args.sources
            .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
            .map((s) => ({ id: String(s.id ?? '').trim(), resource: typeof s.resource === 'string' ? s.resource : undefined, title: typeof s.title === 'string' ? s.title : undefined }))
            .filter((s) => s.id)
        : undefined;
      const fields = {
        type: str(args, 'type', true)!.trim(),
        title,
        description: str(args, 'description'),
        tags,
        status: str(args, 'status'),
        stale_after: str(args, 'stale_after'),
        resource: str(args, 'resource'),
        sources,
      };
      const body = str(args, 'content');
      const existing = ctx.notes.ownedNotes(ctx.userId).find((n) => n.path.toLowerCase() === path.toLowerCase());
      if (existing) {
        if (args.version === undefined || Number(args.version) !== existing.version) {
          throw new ToolError(`„${title}“ gibt es schon (Version ${existing.version}). Lies die Notiz mit read_note und gib ihre version mit, um sie zu ändern.`);
        }
        let content = applyMemoryFields(existing.content, fields);
        if (body !== undefined) content = replaceMemoryBody(content, normalizeDueWords(body, ctx.today ?? new Date()));
        return { ...save(ctx, existing, content), created: false };
      }
      const content = applyMemoryFields(`\n${normalizeDueWords(body ?? '', ctx.today ?? new Date()).replace(/^\n+/, '')}`, fields);
      const memory = memoryWrite(ctx, path, null, content);
      checkSize(memory.content);
      const now = Date.now();
      const id = crypto.randomBytes(16).toString('hex');
      const [result] = ctx.notes.push(ctx.userId, [{ id, baseVersion: 0, path, content: memory.content, deleted: false, createdAt: now, updatedAt: now }]);
      if (result.status !== 'ok') throw new ToolError('Die Notiz konnte nicht angelegt werden.');
      memory.after();
      return { id, path, version: result.version, created: true, ...(memory.warnings.length ? { warnings: memory.warnings } : {}) };
    },
  },
  {
    name: 'memory_check',
    title: 'KI-Gedächtnis prüfen',
    description:
      'Checks every note in the AI memory against its format (frontmatter with `type`, timestamps, description, links, sources) and lists the problems, outdated notes (stale_after passed) and how many notes the user has confirmed. Fix errors with memory_save or update_note.',
    inputSchema: { type: 'object', properties: { only_problems: { type: 'boolean', default: true } } },
    write: false,
    run(args, ctx) {
      const folder = memoryFolder(ctx);
      if (!folder) throw new ToolError('Das KI-Gedächtnis ist nicht eingeschaltet.');
      const own = ctx.notes.ownedNotes(ctx.userId).filter((n) => !n.path.startsWith(SYSTEM_PREFIX));
      const index = new LinkIndex(own);
      const overview = memoryOverview(own, folder, { resolveLink: (t) => !!index.resolve(t), now: (ctx.today ?? new Date()).getTime() });
      const onlyProblems = args.only_problems !== false;
      return {
        folder,
        ...overview,
        notes: overview.notes
          .filter((n) => !onlyProblems || n.problems.length || n.stale)
          .map((n) => ({ ...n, problems: n.problems.map((p) => `${p.level === 'error' ? 'Fehler' : 'Hinweis'}: ${p.message}`) })),
      };
    },
  },
  {
    name: 'list_projects',
    title: 'Projekte auflisten',
    description:
      'Lists the projects with tickets: folders with a ticket key (e.g. KLD), their workflow statuses (in order; `active` and `done` say which count as in progress and finished), `transitions` (which status may follow which; missing means any change is allowed), active `automations` (rules that change tickets by themselves, e.g. when a merge request is merged) and milestones with progress. Only projects where tickets are switched on appear.',
    inputSchema: { type: 'object', properties: {} },
    write: false,
    run(_args, ctx) {
      const notes = space(ctx);
      return projectsOf(ctx, notes).map((p) => {
        const tickets = ticketsIn(notes, p).map((n) => ticketMeta(n.content));
        return {
          key: p.config.key,
          folder: p.folder,
          ...(p.group ? { group: p.group.name, read_only: p.readOnly } : {}),
          workflow: p.config.workflow,
          active: p.config.active,
          done: p.config.done,
          require_docs: p.config.requireDocs,
          // Allowed status changes (missing: every change is allowed) and the rules that change tickets on their own
          ...(p.config.transitions ? { transitions: p.config.transitions } : {}),
          ...(p.config.automations.length
            ? { automations: p.config.automations.filter((a) => a.enabled).map((a) => ({ name: a.name || a.id, on: a.trigger, actions: a.actions.map((x) => `${x.type}${x.value ? `: ${x.value}` : ''}`) })) }
            : {}),
          open_tickets: tickets.filter((t) => statusCategory(p.config, t.status) !== 'done').length,
          milestones: milestonesIn(notes, p).map((m) => {
            const meta = milestoneMeta(m.content);
            const title = extractMeta(m.path, m.content).title;
            const mine = tickets.filter((t) => t.milestone && (t.milestone.toLowerCase() === title.toLowerCase() || t.milestone === meta.id));
            const progress = milestoneProgress(meta, mine.map((t) => ({ category: statusCategory(p.config, t.status), estimate: t.estimate })), ctx.today ?? new Date());
            return { title, id: meta.id, start: meta.start, due: meta.due, release: meta.release, ...progress };
          }),
        };
      });
    },
  },
  {
    name: 'list_tickets',
    title: 'Tickets auflisten',
    description:
      'Lists tickets, optionally of one project (key like "KLD" or its folder), with a status, milestone or assignee. `open_only` leaves out finished tickets. `kind` limits to one ticket type, `parent` to the tickets below one ticket. Each ticket has its id (e.g. KLD-118), its type (`kind`: epic, feature, task, bug, subtask) and `parent`, status and its category (open/active/done), priority, milestone, assignee, estimate, labels and linked documentation.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        status: { type: 'string' },
        milestone: { type: 'string' },
        assignee: { type: 'string', description: 'Username; "me" for the user' },
        kind: { type: 'string', enum: [...TICKET_KINDS] },
        parent: { type: 'string', description: 'Id of a parent ticket (e.g. KLD-12)' },
        open_only: { type: 'boolean', default: false },
      },
    },
    write: false,
    run(args, ctx) {
      const notes = space(ctx);
      const projects = projectsOf(ctx, notes);
      const ref = str(args, 'project');
      const chosen = ref ? [findProject(projects, ref)] : projects;
      const status = str(args, 'status')?.toLowerCase();
      const milestone = str(args, 'milestone')?.toLowerCase();
      let assignee = str(args, 'assignee')?.replace(/^@/, '').toLowerCase();
      if (assignee === 'me') assignee = ctx.notes.usernameOf(ctx.userId)?.toLowerCase();
      const kind = str(args, 'kind')?.toLowerCase();
      const parent = str(args, 'parent')?.toLowerCase();
      return chosen.flatMap((p) =>
        ticketsIn(notes, p)
          .map((n) => ticketSummary(n, p))
          .filter((t) => (!status || t.status.toLowerCase() === status) && (!milestone || t.milestone?.toLowerCase() === milestone) && (!assignee || t.assignee?.toLowerCase() === assignee) && (!kind || t.kind === kind) && (!parent || t.parent?.toLowerCase() === parent) && (args.open_only !== true || t.category !== 'done'))
          .map((t) => ({ ...t, project: p.config.key }))
      );
    },
  },
  {
    name: 'ticket_create',
    title: 'Ticket anlegen',
    description:
      'Creates a ticket in a project (key like "KLD" or its folder), by default a task; `kind` and `parent` build the hierarchy epic > feature > task/bug > subtask. The server gives it the next number (e.g. KLD-119), returned as `ticket`. The description is Markdown; sub-tasks as "- [ ] text". The checklist template of the project for the ticket type is appended as open tasks. Status defaults to the first of the workflow, priority to medium.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, ...ticketFieldsSchema },
      required: ['project', 'title'],
    },
    write: true,
    run(args, ctx) {
      const project = findProject(projectsOf(ctx), str(args, 'project', true)!);
      if (project.readOnly) throw new ToolError(`In der Gruppe „${project.group?.name ?? ''}“ darfst du nur lesen.`);
      const title = str(args, 'title', true)!.trim().slice(0, 200);
      const estimate = args.estimate === undefined || args.estimate === null ? null : Number(args.estimate);
      if (estimate !== null && !Number.isFinite(estimate)) throw new ToolError('Parameter "estimate" muss eine Zahl sein.');
      const kind = kindArg(args) ?? 'task';
      const content = newTicketContent({
        key: project.config.key,
        kind,
        parent: parentArg(ctx, project, kind, str(args, 'parent')),
        status: projectStatus(project, str(args, 'status')) ?? project.config.workflow[0],
        priority: priorityArg(args),
        milestone: str(args, 'milestone') ?? null,
        assignee: str(args, 'assignee')?.replace(/^@/, '') || null,
        estimate,
        labels: strList(args, 'labels'),
        docs: strList(args, 'docs'),
        description: str(args, 'description'),
        checklist: checklistOf(project.config, kind),
      });
      const created = createNote(ctx, { title, content, folder: project.realFolder, ...(project.group ? { group: project.group.name } : {}) });
      const note = space(ctx).find((n) => n.id === created.id);
      return { ...created, ticket: note ? ticketMeta(note.content).id : null };
    },
  },
  {
    name: 'ticket_update',
    title: 'Ticket ändern',
    description:
      'Changes fields of a ticket by its id (e.g. KLD-118): kind, parent, status, priority, milestone, assignee, estimate, labels, docs, blocks (ids of tickets this one blocks), blockedBy (ids of tickets that block this one). Only the given fields change; an empty string or list removes a field. `comment` appends a line to the description. Use update_note to rewrite the description.',
    inputSchema: {
      type: 'object',
      properties: {
        ticket: { type: 'string', description: 'Ticket id like KLD-118 (or the note id)' },
        ...ticketFieldsSchema,
        blocks: { type: 'array', items: { type: 'string' } },
        blockedBy: { type: 'array', items: { type: 'string' } },
        comment: { type: 'string', description: 'Markdown appended to the ticket' },
      },
      required: ['ticket'],
    },
    write: true,
    run(args, ctx) {
      const { note, project } = findTicket(ctx, str(args, 'ticket', true)!);
      const fields: Parameters<typeof setTicketFields>[1] = {};
      if ('status' in args) {
        fields.status = projectStatus(project, str(args, 'status')) ?? null;
        const current = ticketMeta(note.content).status;
        if (fields.status && !canTransition(project.config, current, fields.status)) {
          const allowed = allowedStatuses(project.config, current).filter((s) => s.toLowerCase() !== current.toLowerCase());
          throw new ToolError(`Der Workflow erlaubt nicht „${current}“ → „${fields.status}“. Von „${current}“ geht es nur nach: ${allowed.join(', ') || '(keinem anderen Status)'}.`);
        }
      }
      const current = ticketMeta(note.content);
      const kind = 'kind' in args ? (kindArg(args) ?? 'task') : current.kind;
      if ('kind' in args) fields.kind = kind;
      if ('parent' in args) fields.parent = parentArg(ctx, project, kind, str(args, 'parent'), note.id);
      else if ('kind' in args && current.parent && !PARENT_KINDS[kind].length) fields.parent = null;
      if ('priority' in args) fields.priority = priorityArg(args) ?? null;
      if ('milestone' in args) fields.milestone = str(args, 'milestone') ?? null;
      if ('assignee' in args) fields.assignee = str(args, 'assignee')?.replace(/^@/, '') || null;
      if ('estimate' in args) {
        const e = args.estimate === null || args.estimate === '' ? null : Number(args.estimate);
        if (e !== null && !Number.isFinite(e)) throw new ToolError('Parameter "estimate" muss eine Zahl sein.');
        fields.estimate = e;
      }
      for (const key of ['labels', 'docs', 'blocks', 'blockedBy'] as const) if (key in args) fields[key] = strList(args, key) ?? [];
      let content = setTicketFields(note.content, fields);
      const comment = str(args, 'comment')?.trim();
      if (comment) content = `${content.replace(/\s+$/, '')}\n\n${comment}\n`;
      const { saved, content: stored } = saveWithContent(ctx, note, content);
      return { ...saved, ...ticketSummary({ ...note, content: stored, version: saved.version }, project) };
    },
  },
  {
    name: 'milestone_status',
    title: 'Meilenstein-Stand',
    description:
      'Progress of a milestone by its title or id: its status (`status` set by hand or null, `state` as shown: planned, active, done, cancelled), the milestones it waits for (`blockedBy`) and blocks, finished and open tickets, story points, days left and whether it is at risk (time elapsed clearly ahead of progress, or overdue).',
    inputSchema: { type: 'object', properties: { milestone: { type: 'string' }, project: { type: 'string' } }, required: ['milestone'] },
    write: false,
    run(args, ctx) {
      const notes = space(ctx);
      const projects = projectsOf(ctx, notes);
      const ref = str(args, 'project');
      const wanted = str(args, 'milestone', true)!.trim().toLowerCase();
      for (const p of ref ? [findProject(projects, ref)] : projects) {
        for (const m of milestonesIn(notes, p)) {
          const meta = milestoneMeta(m.content);
          const title = extractMeta(m.path, m.content).title;
          if (title.toLowerCase() !== wanted && meta.id?.toLowerCase() !== wanted) continue;
          const tickets = ticketsIn(notes, p)
            .map((n) => ticketSummary(n, p))
            .filter((t) => t.milestone && (t.milestone.toLowerCase() === title.toLowerCase() || (!!meta.id && t.milestone.toLowerCase() === meta.id.toLowerCase())));
          const progress = milestoneProgress(meta, tickets, ctx.today ?? new Date());
          return { project: p.config.key, title, ...meta, state: milestoneState(meta.status, tickets), ...progress, tickets: tickets.map(({ ticket, title: t, status, category, assignee, estimate }) => ({ ticket, title: t, status, category, assignee, estimate })) };
        }
      }
      throw new ToolError(`Meilenstein „${str(args, 'milestone')}“ nicht gefunden. Die Meilensteine stehen in list_projects.`);
    },
  },
];

export const toolsFor = (canWrite: boolean) => TOOLS.filter((t) => canWrite || !t.write);
