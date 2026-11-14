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
  type SyncedNote,
} from '@kladde/shared';
import { MAX_NOTE_BYTES, NoteStore } from '../NoteStore.js';

/** Who calls a tool: tools only ever see the notes this user owns */
export interface ToolContext {
  userId: string;
  canWrite: boolean;
  notes: NoteStore;
  today?: Date;
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

/** The user's own notes without the hidden settings notes */
function space(ctx: ToolContext): SyncedNote[] {
  return ctx.notes.ownedNotes(ctx.userId).filter((n) => !n.path.startsWith(SYSTEM_PREFIX));
}

/** Due date for tasks without one: tasks in a daily note belong to its day (settings note of the client) */
function taskDue(ctx: ToolContext): (path: string) => string | null {
  return taskDueOf(ctx.notes, ctx.userId);
}

/** Same as `taskDue`, for callers outside the MCP (the calendar feed) */
export function taskDueOf(notes: NoteStore, userId: string): (path: string) => string | null {
  const settings = notes.ownedNotes(userId).find((n) => n.id === `syssettings-${userId}`);
  let raw: unknown;
  try {
    raw = settings ? (JSON.parse(settings.content) as Record<string, unknown>)[FEATURES_SETTING] : undefined;
  } catch {
    raw = undefined;
  }
  return dailyDueResolver(normalizeFeatures(raw).daily);
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

function summary(n: SyncedNote) {
  const meta = extractMeta(n.path, n.content);
  return { id: n.id, path: n.path, title: meta.title, folder: meta.folder, tags: meta.tags, updated: iso(n.updatedAt) };
}

/** By id, by path or by title (resolved like a [[link]]: title, frontmatter id, Zettel id) */
function findNote(notes: SyncedNote[], args: Record<string, unknown>): SyncedNote {
  const id = str(args, 'id');
  const path = str(args, 'path');
  const title = str(args, 'title');
  if (!id && !path && !title) throw new ToolError('Gib "id", "path" oder "title" an.');
  let found: SyncedNote | undefined;
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
function save(ctx: ToolContext, note: SyncedNote, content: string) {
  checkSize(content);
  const [result] = ctx.notes.push(ctx.userId, [
    { id: note.id, baseVersion: note.version, path: note.path, content, deleted: false, createdAt: note.createdAt, updatedAt: Date.now() },
  ]);
  if (result.status === 'conflict') throw new ToolError('Die Notiz wurde gerade geändert. Lies sie erneut und versuche es noch einmal.');
  if (result.status !== 'ok') throw new ToolError('Die Notiz konnte nicht gespeichert werden.');
  return { id: note.id, path: note.path, version: result.version };
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
      'Lists the user\'s own notes (newest first) with id, path, title, folder and tags. Folders follow PARA: "0 Inbox", "1 Projekte", "2 Bereiche", "3 Ressourcen", "4 Archiv", plus "Zettelkasten". Use `folder` to limit to a folder and its subfolders.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Only this folder (with subfolders), e.g. "1 Projekte"' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
      },
    },
    write: false,
    run(args, ctx) {
      const folder = str(args, 'folder')?.replace(/^\/+|\/+$/g, '');
      const limit = int(args, 'limit', 100, 500);
      const all = space(ctx)
        .filter((n) => !folder || n.path.startsWith(`${folder}/`))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const folders = [...new Set(space(ctx).map((n) => splitPath(n.path).folder).filter(Boolean))].sort();
      return { total: all.length, notes: all.slice(0, limit).map(summary), folders };
    },
  },
  {
    name: 'search_notes',
    title: 'Notizen durchsuchen',
    description:
      'Full-text search over titles, paths and contents of the user\'s own notes. All words must occur (case-insensitive). Returns matches with a snippet; read a note with read_note.',
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
      return {
        total: hits.length,
        results: hits.slice(0, limit).map(({ note }) => ({ ...summary(note), snippet: snippet(note.content, words[0]) })),
      };
    },
  },
  {
    name: 'semantic_search',
    title: 'Semantische Suche',
    description:
      'Semantic similarity search over the user\'s own notes. Understands German and English word stems, compound words (e.g. "Reisekosten"), conceptually related topics (e.g. "Urlaub" <-> "Flug", "Wohnung" <-> "Miete"), titles, tags, headings, and [[WikiLink]] graph neighbors. Returns ranked matches with score (0-1), match reasons, snippet and links.',
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
      const hits = semanticSearch(query, space(ctx), { folder, limit, minScore });
      return {
        total: hits.length,
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
      'TASKS WHERE done = false AND due <= today',
      'Fields: title, path, folder, created, updated, tags, links, any frontmatter key; for TASKS also text, due, time, done, note.',
      'Operators: = != < <= > >= contains ~ (substring). AND binds tighter than OR. Values: "text", numbers, YYYY-MM-DD, today, tomorrow, true/false.',
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
      'Creates a new note in the user\'s space (default folder "0 Inbox"). Content is Markdown; link other notes with [[Title]], tasks as "- [ ] text 📅 YYYY-MM-DD". An existing title gets a number appended.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string', description: 'Markdown body' },
        folder: { type: 'string', description: 'e.g. "1 Projekte" or "3 Ressourcen/Rezepte"; default "0 Inbox"' },
      },
      required: ['title'],
    },
    write: true,
    run(args, ctx) {
      const title = str(args, 'title', true)!.trim().slice(0, 200);
      const folder = cleanFolder(str(args, 'folder'));
      const content = normalizeDueWords(str(args, 'content') ?? '', ctx.today ?? new Date());
      checkSize(content);
      const path = uniquePath(space(ctx), folder, title);
      const now = Date.now();
      const id = crypto.randomBytes(16).toString('hex');
      const [result] = ctx.notes.push(ctx.userId, [{ id, baseVersion: 0, path, content, deleted: false, createdAt: now, updatedAt: now }]);
      if (result.status !== 'ok') throw new ToolError('Die Notiz konnte nicht angelegt werden.');
      return { id, path, version: result.version };
    },
  },
  {
    name: 'update_note',
    title: 'Notiz ersetzen',
    description:
      'Replaces the full content of one of the user\'s notes. Pass the `version` you got from read_note: if the note changed since, nothing is written and you must read it again. Title and folder stay the same (rename and move in the app, so links are kept).',
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
];

export const toolsFor = (canWrite: boolean) => TOOLS.filter((t) => canWrite || !t.write);
