/**
 * Tiny query language for ```query blocks, inspired by Dataview:
 *
 *   TABLE title, status, updated
 *   FROM "1 Projekte"
 *   WHERE tags contains "arbeit" AND status != "fertig"
 *   SORT updated DESC
 *   LIMIT 20
 *
 * Modes: TABLE <fields> | LIST | TASKS | KANBAN BY <field> [VALUES "a", "b", …].
 * KANBAN makes one column per value of the status field (default: the distinct values found). All clauses are optional and case-insensitive.
 * Fields: title, path, folder, created, updated, tags, links, due, done, status (tasks: open|doing|blocked|done) and any frontmatter key.
 * Operators: = != < <= > >= contains ~ (substring, case-insensitive). AND binds tighter than OR.
 * Values: "text", numbers, YYYY-MM-DD, today, tomorrow, true/false.
 */

import { extractMeta } from './markdown.js';
import { parseTasks, toDateString } from './tasks.js';

export type QueryMode = 'table' | 'list' | 'tasks' | 'kanban';
type Op = '=' | '!=' | '<' | '<=' | '>' | '>=' | 'contains' | '~';

interface Condition {
  field: string;
  op: Op;
  value: string;
}

export interface Query {
  mode: QueryMode;
  fields: string[];
  /** KANBAN: frontmatter field that decides the column */
  groupBy: string | null;
  /** KANBAN: column values in display order (empty = the distinct values found) */
  columnValues: string[];
  from: string | null;
  /** OR of AND groups */
  where: Condition[][];
  sort: { field: string; desc: boolean } | null;
  limit: number | null;
}

export interface QueryNote {
  id: string;
  path: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface QueryRow {
  noteId: string;
  path: string;
  /** For TASKS: line of the task */
  line?: number;
  values: Record<string, unknown>;
}

export interface QueryResult {
  query: Query;
  columns: string[];
  rows: QueryRow[];
  /** KANBAN: the lanes; rows without a matching value are left out unless the values were not given */
  lanes?: { value: string; rows: QueryRow[] }[];
}

export class QueryError extends Error {}

const TOKEN = /\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|!=|<=|>=|[=<>~,]|[^\s,=<>!~"']+)/gy;

function tokenize(src: string): string[] {
  const out: string[] = [];
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (TOKEN.lastIndex < src.length && (m = TOKEN.exec(src))) out.push(m[1]);
  return out;
}

const unquote = (t: string) => (/^["']/.test(t) ? t.slice(1, -1).replace(/\\(.)/g, '$1') : t);
const KEYWORDS = new Set(['from', 'where', 'sort', 'limit']);
const KANBAN_END = new Set([...KEYWORDS, 'values']);

export function parseQuery(src: string): Query {
  const tokens = tokenize(src.replace(/\n/g, ' '));
  let i = 0;
  const peek = () => tokens[i]?.toLowerCase();
  const next = () => tokens[i++];
  const q: Query = { mode: 'list', fields: [], groupBy: null, columnValues: [], from: null, where: [], sort: null, limit: null };

  const mode = peek();
  if (mode === 'table' || mode === 'list' || mode === 'tasks' || mode === 'kanban') {
    q.mode = mode;
    next();
  }
  if (q.mode === 'table') {
    while (i < tokens.length && !KEYWORDS.has(peek()!)) {
      const t = next();
      if (t !== ',') q.fields.push(unquote(t).toLowerCase());
    }
    if (!q.fields.length) q.fields = ['title', 'updated'];
  }
  if (q.mode === 'kanban') {
    if (peek() === 'by') next();
    if (i >= tokens.length || KANBAN_END.has(peek()!)) throw new QueryError('KANBAN braucht ein Feld, z. B. KANBAN BY status VALUES "offen", "läuft", "fertig"');
    q.groupBy = unquote(next()).toLowerCase();
  }
  while (i < tokens.length) {
    const kw = next().toLowerCase();
    if (kw === 'values' && q.mode === 'kanban') {
      while (i < tokens.length && !KEYWORDS.has(peek()!)) {
        const t = next();
        if (t !== ',') q.columnValues.push(unquote(t));
      }
    } else if (kw === 'from') {
      const t = next();
      if (!t) throw new QueryError('FROM braucht einen Ordner, z. B. FROM "1 Projekte"');
      q.from = unquote(t).replace(/\/$/, '');
    } else if (kw === 'where') {
      let group: Condition[] = [];
      while (i < tokens.length && !KEYWORDS.has(peek()!)) {
        const field = next();
        const op = next()?.toLowerCase() as Op;
        const value = next();
        if (!['=', '!=', '<', '<=', '>', '>=', 'contains', '~'].includes(op) || value === undefined) {
          throw new QueryError(`Ungültige Bedingung bei "${field}"`);
        }
        group.push({ field: field.toLowerCase(), op, value: unquote(value) });
        const joiner = peek();
        if (joiner === 'and') next();
        else if (joiner === 'or') {
          next();
          q.where.push(group);
          group = [];
        }
      }
      if (group.length) q.where.push(group);
    } else if (kw === 'sort') {
      const field = next();
      if (!field) throw new QueryError('SORT braucht ein Feld');
      const dir = peek();
      if (dir === 'asc' || dir === 'desc') next();
      q.sort = { field: field.toLowerCase(), desc: dir === 'desc' };
    } else if (kw === 'limit') {
      const n = Number(next());
      if (!Number.isFinite(n) || n < 1) throw new QueryError('LIMIT braucht eine Zahl');
      q.limit = Math.floor(n);
    } else {
      throw new QueryError(`Unbekanntes Wort "${kw}"`);
    }
  }
  return q;
}

function resolveValue(v: string, today: Date): string {
  const w = v.toLowerCase();
  if (w === 'today' || w === 'heute') return toDateString(today);
  if (w === 'tomorrow' || w === 'morgen') {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    return toDateString(d);
  }
  return v;
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const na = Number(a);
  const nb = Number(b);
  if (a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb) && typeof a !== 'boolean') return na - nb;
  return String(a ?? '').localeCompare(String(b ?? ''), 'de', { numeric: true, sensitivity: 'base' });
}

function matches(values: Record<string, unknown>, c: Condition, today: Date): boolean {
  let actual = values[c.field];
  const expected = resolveValue(c.value, today);
  if (typeof actual === 'number' && /^\d{4}-\d{2}-\d{2}$/.test(expected) && /^(created|updated)$/.test(c.field)) {
    actual = toDateString(new Date(actual));
  }
  if (c.op === 'contains') {
    if (Array.isArray(actual)) return actual.some((x) => String(x).toLowerCase() === expected.toLowerCase());
    return String(actual ?? '').toLowerCase().includes(expected.toLowerCase());
  }
  if (c.op === '~') return String(Array.isArray(actual) ? actual.join(' ') : actual ?? '').toLowerCase().includes(expected.toLowerCase());
  if (actual === undefined || actual === null || actual === '') return c.op === '!=' ? expected !== '' : expected === '';
  const cmp = compare(typeof actual === 'boolean' ? String(actual) : actual, expected);
  switch (c.op) {
    case '=':
      return cmp === 0;
    case '!=':
      return cmp !== 0;
    case '<':
      return cmp < 0;
    case '<=':
      return cmp <= 0;
    case '>':
      return cmp > 0;
    case '>=':
      return cmp >= 0;
  }
}

export interface QueryOptions {
  /** Due date of tasks that name none (daily notes: the note's date) */
  defaultDue?: (path: string) => string | null;
}

export function runQuery(src: string | Query, notes: QueryNote[], today = new Date(), opts: QueryOptions = {}): QueryResult {
  const query = typeof src === 'string' ? parseQuery(src) : src;
  let rows: QueryRow[] = [];
  for (const note of notes) {
    if (query.from !== null && !(note.path.startsWith(`${query.from}/`) || query.from === '')) continue;
    const meta = extractMeta(note.path, note.content);
    const base: Record<string, unknown> = {
      ...meta.frontmatter,
      title: meta.title,
      path: note.path,
      folder: meta.folder,
      tags: meta.tags,
      links: meta.links,
      created: note.createdAt,
      updated: note.updatedAt,
    };
    if (query.mode === 'tasks') {
      for (const t of parseTasks(note.content, today, opts.defaultDue?.(note.path) ?? null)) {
        rows.push({
          noteId: note.id,
          path: note.path,
          line: t.line,
          values: { ...base, note: meta.title, text: t.text, due: t.due ?? '', done: t.done, status: t.status, repeat: t.repeat ?? '' },
        });
      }
    } else {
      rows.push({ noteId: note.id, path: note.path, values: base });
    }
  }
  if (query.where.length) {
    rows = rows.filter((r) => query.where.some((group) => group.every((c) => matches(r.values, c, today))));
  }
  const sort = query.sort ?? (query.mode === 'tasks' ? { field: 'due', desc: false } : { field: 'updated', desc: true });
  rows.sort((a, b) => {
    const av = a.values[sort.field];
    const bv = b.values[sort.field];
    // Empty values go last whatever the direction
    if ((av ?? '') === '' && (bv ?? '') !== '') return 1;
    if ((bv ?? '') === '' && (av ?? '') !== '') return -1;
    const c = compare(av, bv);
    return sort.desc ? -c : c;
  });
  if (query.limit) rows = rows.slice(0, query.limit);
  if (query.mode === 'kanban') {
    const field = query.groupBy!;
    const valueOf = (r: QueryRow) => String(r.values[field] ?? '').trim();
    const given = query.columnValues.length > 0;
    const names = given ? query.columnValues : [...new Set(rows.map(valueOf))].sort((a, b) => compare(a, b));
    const lanes = names.map((value) => ({ value, rows: rows.filter((r) => valueOf(r).toLowerCase() === value.toLowerCase()) }));
    // Without a given list, notes lacking the field land in a lane with an empty name
    return { query, columns: ['title'], rows, lanes };
  }
  const columns = query.mode === 'table' ? query.fields : query.mode === 'tasks' ? ['text', 'due', 'note'] : ['title'];
  return { query, columns, rows };
}

/** Display text for a cell */
export function formatValue(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'number' && v > 1e11) return new Date(v).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  if (typeof v === 'boolean') return v ? '✓' : '';
  return String(v);
}
