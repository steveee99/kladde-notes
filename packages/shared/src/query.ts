/**
 * Tiny query language for ```query blocks, inspired by Dataview:
 *
 *   TABLE title, status, updated
 *   FROM "1 Projekte"          (or FROM #tag: notes with that tag or one nested below it)
 *   WHERE tags contains "arbeit" AND status != "fertig"
 *   SORT updated DESC
 *   LIMIT 20
 *
 * Modes: TABLE <fields> | LIST | TASKS | KANBAN BY <field> [VALUES "a", "b", …].
 * TABLE fields may be aggregates (#77): COUNT, SUM(field), AVG(field), MIN(field), MAX(field); rows show the field's
 * value, a footer row the aggregate. GROUP BY <field> (TABLE and LIST) groups the rows with a header and a count; a TABLE
 * of only the group field and aggregates becomes a summary with one row per group.
 * KANBAN makes one column per value of the status field (default: the distinct values found). All clauses are optional and case-insensitive.
 * Fields: title, path, folder, created, updated, tags, links, due, time (tasks: reminder HH:MM), done, status (tasks: open|doing|blocked|done) and any frontmatter key.
 * Operators: = != < <= > >= contains ~ (substring, case-insensitive). AND binds tighter than OR.
 * `tags contains "area"` also matches nested tags such as `area/health`.
 * Values: "text", numbers, YYYY-MM-DD, today, tomorrow, true/false.
 */

import { isHiddenPath } from './database.js';
import { extractMeta, type NoteMeta } from './markdown.js';
import { NoteMemo } from './noteMemo.js';
import { memoryMeta } from './memory.js';
import { TaskCache, toDateString } from './tasks.js';
import { tagMatches } from './tags.js';

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
  /** KANBAN: frontmatter field that decides the column; TABLE/LIST: the GROUP BY field */
  groupBy: string | null;
  /** KANBAN: column values in display order (empty = the distinct values found) */
  columnValues: string[];
  from: string | null;
  /** FROM #tag: only notes with this tag or one nested below it */
  fromTag: string | null;
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

export type AggregateFn = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface QueryGroup {
  /** The group's value of the GROUP BY field ('' = notes without it) */
  key: string;
  rows: QueryRow[];
  /** Aggregate columns over the group's rows */
  aggregates: Record<string, unknown>;
}

export interface QueryResult {
  query: Query;
  columns: string[];
  rows: QueryRow[];
  /** KANBAN: the lanes; rows without a matching value are left out unless the values were not given */
  lanes?: { value: string; rows: QueryRow[] }[];
  /** GROUP BY: the groups in display order (a note with several values, e.g. tags, is in each of their groups) */
  groups?: QueryGroup[];
  /** TABLE with aggregate columns: the aggregates over all rows (the footer row) */
  totals?: Record<string, unknown>;
  /** Grouped TABLE of only the group field and aggregates: one row per group instead of the notes */
  summary?: boolean;
  /** Online mode: the number of rows before the server cut them to `ONLINE_QUERY_ROWS` (totals count all) */
  total?: number;
}

/** Online mode: rows the server sends at most per query (per group or lane), so a query without LIMIT stays small */
export const ONLINE_QUERY_ROWS = 2000;

/** Cuts a result to `max` rows (per group and lane) for sending it; `total` keeps the number of rows found */
export function capQueryResult(result: QueryResult, max = ONLINE_QUERY_ROWS): QueryResult {
  const over = result.rows.length > max || result.groups?.some((g) => g.rows.length > max) || result.lanes?.some((l) => l.rows.length > max);
  if (!over) return result;
  return {
    ...result,
    total: result.rows.length,
    rows: result.rows.slice(0, max),
    groups: result.groups?.map((g) => ({ ...g, rows: g.rows.slice(0, max) })),
    lanes: result.lanes?.map((l) => ({ ...l, rows: l.rows.slice(0, max) })),
  };
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

const AGGREGATE = /^(count|sum|avg|min|max)(?:\(([^()]*)\))?$/;

/** The aggregate a TABLE column stands for (`sum(hours)` → sum of hours), null for a plain field */
export function parseAggregate(column: string): { fn: AggregateFn; field: string | null } | null {
  const m = AGGREGATE.exec(column.toLowerCase());
  if (!m) return null;
  const field = m[2]?.trim() || null;
  const fn = m[1] as AggregateFn;
  if (fn !== 'count' && !field) return null;
  return { fn, field: fn === 'count' ? null : field };
}

export function parseQuery(src: string): Query {
  const tokens = tokenize(src.replace(/\n/g, ' '));
  let i = 0;
  const peek = () => tokens[i]?.toLowerCase();
  const next = () => tokens[i++];
  /** A clause starts here: FROM, WHERE, SORT, LIMIT or GROUP BY (a field may still be called `group`) */
  const atClause = () => KEYWORDS.has(peek()!) || (peek() === 'group' && tokens[i + 1]?.toLowerCase() === 'by');
  const q: Query = { mode: 'list', fields: [], groupBy: null, columnValues: [], from: null, fromTag: null, where: [], sort: null, limit: null };

  const mode = peek();
  if (mode === 'table' || mode === 'list' || mode === 'tasks' || mode === 'kanban') {
    q.mode = mode;
    next();
  }
  if (q.mode === 'table') {
    while (i < tokens.length && !atClause()) {
      let t = next();
      if (t === ',') continue;
      // `SUM(hours)` is one token; `SUM( hours )` or `SUM (hours)` are put back together
      if (/^(count|sum|avg|min|max)$/i.test(t) && tokens[i]?.startsWith('(')) t += next();
      if (/^(count|sum|avg|min|max)\(/i.test(t)) {
        // Looks at the last token, not at the growing text (quadratic on long input)
        for (let last = t; !last.endsWith(')') && i < tokens.length && tokens[i] !== ','; ) t += last = next();
        const agg = parseAggregate(t);
        if (!agg) throw new QueryError(`Ungültige Aggregation "${t}", z. B. COUNT, SUM(stunden), AVG(bewertung)`);
        q.fields.push(agg.field ? `${agg.fn}(${agg.field})` : agg.fn);
        continue;
      }
      q.fields.push(unquote(t).toLowerCase());
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
    if (kw === 'group' && peek() === 'by') {
      next();
      if (q.mode !== 'table' && q.mode !== 'list') throw new QueryError('GROUP BY gibt es für TABLE und LIST');
      const t = next();
      if (!t || KEYWORDS.has(t.toLowerCase())) throw new QueryError('GROUP BY braucht ein Feld, z. B. GROUP BY status');
      q.groupBy = unquote(t).toLowerCase();
    } else if (kw === 'values' && q.mode === 'kanban') {
      while (i < tokens.length && !atClause()) {
        const t = next();
        if (t !== ',') q.columnValues.push(unquote(t));
      }
    } else if (kw === 'from') {
      const t = next();
      if (!t) throw new QueryError('FROM braucht einen Ordner, z. B. FROM "1 Projekte"');
      if (t.startsWith('#') && t.length > 1) q.fromTag = t.slice(1).toLowerCase();
      else q.from = unquote(t).replace(/\/$/, '');
    } else if (kw === 'where') {
      let group: Condition[] = [];
      while (i < tokens.length && !atClause()) {
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
  return collator.compare(String(a ?? ''), String(b ?? ''));
}

/** One collator for all comparisons: localeCompare with options builds a new one per call (#64) */
const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

function matches(values: Record<string, unknown>, c: Condition, today: Date): boolean {
  let actual = values[c.field];
  const expected = resolveValue(c.value, today);
  if (typeof actual === 'number' && /^\d{4}-\d{2}-\d{2}$/.test(expected) && /^(created|updated)$/.test(c.field)) {
    actual = toDateString(new Date(actual));
  }
  if (c.op === 'contains') {
    if (Array.isArray(actual) && c.field === 'tags') return actual.some((x) => tagMatches(String(x), expected));
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

/**
 * OKF metadata of notes in the AI memory (#94) as query fields: trust, stale, generated_by, generated_at,
 * verified_by; only for notes whose frontmatter has a `type` (the flat parser cannot read the nested fields)
 */
function memoryFields(content: string, flat: Record<string, string>, today: Date): Record<string, unknown> {
  if (!flat.type) return {};
  const m = memoryMeta(content, '', today.getTime());
  return {
    trust: m.trust,
    stale: m.stale,
    generated_by: m.generated?.by ?? '',
    generated_at: m.generated?.at ?? '',
    verified_by: m.verified.map((v) => v.by),
  };
}

export interface QueryOptions {
  /** Due date of tasks that name none (daily notes: the note's date) */
  defaultDue?: (path: string) => string | null;
}

/** Parsed notes and tasks of earlier queries: query blocks run again after every change, mostly over unchanged notes (#64) */
const metaMemo = new NoteMemo<NoteMeta>((n) => extractMeta(n.path, n.content));
const taskCache = new TaskCache();

export function runQuery(src: string | Query, notes: QueryNote[], today = new Date(), opts: QueryOptions = {}): QueryResult {
  const query = typeof src === 'string' ? parseQuery(src) : src;
  let rows: QueryRow[] = [];
  for (const note of notes) {
    // Database and variables notes hold a folder's settings
    if (isHiddenPath(note.path)) continue;
    if (query.from !== null && !(note.path.startsWith(`${query.from}/`) || query.from === '')) continue;
    const meta = metaMemo.get(note);
    if (query.fromTag !== null && !meta.tags.some((tag) => tagMatches(tag, query.fromTag!))) continue;
    const base: Record<string, unknown> = {
      ...meta.frontmatter,
      title: meta.title,
      path: note.path,
      folder: meta.folder,
      tags: meta.tags,
      links: meta.links,
      created: note.createdAt,
      updated: note.updatedAt,
      ...memoryFields(note.content, meta.frontmatter, today),
    };
    if (query.mode === 'tasks') {
      for (const t of taskCache.tasksOf(note, today, opts.defaultDue?.(note.path) ?? null)) {
        rows.push({
          noteId: note.id,
          path: note.path,
          line: t.line,
          values: { ...base, note: meta.title, text: t.text, due: t.due ?? '', time: t.time ?? '', done: t.done, status: t.status, repeat: t.repeat ?? '' },
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
  const aggregates = query.mode === 'table' ? columns.flatMap((c) => { const a = parseAggregate(c); return a ? [[c, a] as const] : []; }) : [];
  // Rows show the aggregated field's own value in an aggregate column (COUNT stays empty)
  for (const [col, a] of aggregates) {
    if (a.field) for (const r of rows) r.values[col] = r.values[a.field];
  }
  const aggregate = (list: QueryRow[]) => Object.fromEntries(aggregates.map(([col, a]) => [col, aggregateOf(a.fn, a.field, list)]));
  const result: QueryResult = { query, columns, rows };
  if (aggregates.length) result.totals = aggregate(rows);
  if (query.groupBy && (query.mode === 'table' || query.mode === 'list')) {
    const field = query.groupBy;
    const byKey = new Map<string, QueryRow[]>();
    for (const r of rows) {
      for (const key of groupKeys(r.values[field], field)) {
        const list = byKey.get(key);
        if (list) {
          if (list[list.length - 1] !== r) list.push(r);
        } else byKey.set(key, [r]);
      }
    }
    const desc = query.sort?.field === field && query.sort.desc;
    const keys = [...byKey.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : desc ? -compare(a, b) : compare(a, b)));
    result.groups = keys.map((key) => ({ key, rows: byKey.get(key)!, aggregates: aggregate(byKey.get(key)!) }));
    result.summary = query.mode === 'table' && aggregates.length > 0 && columns.every((c) => c === field || parseAggregate(c));
    // A summary always shows which group a row is
    if (result.summary && !columns.includes(field)) result.columns = [field, ...columns];
  }
  return result;
}

/** The groups a value belongs to: one per list entry (tags), dates of created/updated by day */
function groupKeys(v: unknown, field: string): string[] {
  if (Array.isArray(v)) {
    const keys = [...new Set(v.map((x) => String(x ?? '').trim()).filter(Boolean))];
    return keys.length ? keys : [''];
  }
  if (typeof v === 'number' && (field === 'created' || field === 'updated')) return [toDateString(new Date(v))];
  if (typeof v === 'boolean') return [String(v)];
  return [String(v ?? '').trim()];
}

/** Sums keep their digits (0.1 + 0.2 stays 0.3), averages show two decimals */
const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

function aggregateOf(fn: AggregateFn, field: string | null, rows: QueryRow[]): unknown {
  if (fn === 'count') return rows.length;
  const values = rows.map((r) => r.values[field!]).flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v) => v !== undefined && v !== null && v !== '');
  if (fn === 'min' || fn === 'max') {
    if (!values.length) return '';
    return values.reduce((best, v) => ((fn === 'min' ? compare(v, best) < 0 : compare(v, best) > 0) ? v : best));
  }
  const nums = values.map((v) => (typeof v === 'number' ? v : Number(String(v).replace(',', '.')))).filter((n) => Number.isFinite(n));
  if (!nums.length) return '';
  const sum = nums.reduce((a, b) => a + b, 0);
  return fn === 'sum' ? round(sum, 6) : round(sum / nums.length, 2);
}

/** Display text for a cell */
export function formatValue(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'number' && v > 1e11) return new Date(v).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  if (typeof v === 'boolean') return v ? '✓' : '';
  return String(v);
}
