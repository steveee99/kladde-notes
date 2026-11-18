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
  normalizeDueWords,
  parseTasks,
  runQuery,
  semanticSearch,
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
  type MemoryProblem,
  type MemoryRule,
  type FeatureSettings,
  type GroupInfo,
  type SyncedNote,
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

/** The feature settings the client keeps in the user's settings note (daily notes, PARA, …) */
export function featuresOf(notes: NoteStore, userId: string): FeatureSettings {
  const settings = notes.ownedNotes(userId).find((n) => n.id === `syssettings-${userId}`);
  let raw: unknown;
  try {
    raw = settings ? (JSON.parse(settings.content) as Record<string, unknown>)[FEATURES_SETTING] : undefined;
  } catch {
    raw = undefined;
  }
  return normalizeFeatures(raw);
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

/** Saves through the normal sync path: next seq, live ping to the user's devices, export mirror */
function save(ctx: ToolContext, note: SpaceNote, content: string) {
  writable(note);
  const memory = memoryWrite(ctx, note.realPath === undefined && note.access === 'owner' ? note.path : null, note.content, content);
  content = memory.content;
  checkSize(content);
  const [result] = ctx.notes.push(ctx.userId, [
    { id: note.id, baseVersion: note.version, path: note.realPath ?? note.path, content, deleted: false, createdAt: note.createdAt, updatedAt: Date.now() },
  ]);
  if (result.status === 'conflict') throw new ToolError('Die Notiz wurde gerade geändert. Lies sie erneut und versuche es noch einmal.');
  if (result.status !== 'ok') throw new ToolError('Die Notiz konnte nicht gespeichert werden.');
  memory.after();
  return { id: note.id, path: note.path, version: result.version, ...(memory.warnings.length ? { warnings: memory.warnings } : {}) };
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
        .filter((n) => (!folder || n.path.startsWith(`${folder}/`)) && (!group || n.group === group.id))
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
      for (const n of space(ctx)) {
        const title = splitPath(n.path).name.toLowerCase();
        const hay = `${n.path}\n${n.content}`.toLowerCase();
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
        results: hits.slice(0, limit).map(({ note }) => ({ ...summary(note), snippet: snippet(note.content, words[0]) })),
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
      const notes = space(ctx);
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
      return {
        ...summary(note),
        version: note.version,
        created: iso(note.createdAt),
        links: index.outgoing(note.id).map(titleOf),
        backlinks: index.backlinks(note.id).map(titleOf),
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
    ].join('\n'),
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    write: false,
    run(args, ctx) {
      try {
        const result = runQuery(str(args, 'query', true)!, space(ctx), ctx.today ?? new Date(), { defaultDue: taskDue(ctx) });
        const rows = result.rows.slice(0, 500).map((r) => {
          const values = Object.fromEntries(
            Object.entries(r.values).map(([k, v]) => [k, (k === 'created' || k === 'updated') && typeof v === 'number' ? iso(v) : v])
          );
          const fields = result.query.mode === 'table' ? Object.fromEntries(result.columns.map((c) => [c, values[c] ?? null])) : result.query.mode === 'tasks' ? { text: values.text, due: values.due || null, done: values.done, status: values.status, repeat: values.repeat || null } : { title: values.title };
          return { note_id: r.noteId, path: r.path, ...(r.line !== undefined ? { line: r.line } : {}), ...fields };
        });
        return { mode: result.query.mode, total: result.rows.length, rows };
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
      const groupName = str(args, 'group');
      const group = groupName !== undefined ? groupOf(ctx, groupName) : undefined;
      if (group && !canWriteInGroup(group.role)) throw new ToolError(`In der Gruppe „${group.name}“ darfst du nur lesen.`);
      const folder = group ? cleanGroupFolder(str(args, 'folder'), group.name) : cleanFolder(str(args, 'folder'));
      let content = normalizeDueWords(str(args, 'content') ?? '', ctx.today ?? new Date());
      // Paths are unique per space: the own notes, or the notes of the group (by their path inside it)
      const taken: SyncedNote[] = group
        ? space(ctx)
            .filter((n) => n.group === group.id)
            .map((n) => ({ ...n, path: n.realPath ?? n.path }))
        : ctx.notes.ownedNotes(ctx.userId);
      const path = uniquePath(taken, folder, title);
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
    },
  },
  {
    name: 'update_note',
    title: 'Notiz ersetzen',
    description:
      'Replaces the full content of one of the user\'s notes (or of a group note, unless the user only reads in that group). Pass the `version` you got from read_note: if the note changed since, nothing is written and you must read it again. Title and folder stay the same (rename and move in the app, so links are kept).',
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
];

export const toolsFor = (canWrite: boolean) => TOOLS.filter((t) => canWrite || !t.write);
