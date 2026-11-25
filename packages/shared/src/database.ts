/**
 * Folders as databases (#76): a folder with a `_database-<uuid>.md` note is a database. The note's frontmatter holds the
 * schema (typed properties) and the saved views, so both sync, export and work offline like any note:
 *
 *   ---
 *   type: database
 *   properties:
 *     - name: Status
 *       type: select
 *       options: [todo, doing, done]
 *       default: todo
 *   views:
 *     - name: Board
 *       type: board
 *       group: Status
 *       filter:
 *         - property: Status
 *           op: ne
 *           value: done
 *       sort: Due
 *       desc: false
 *   ---
 *
 * Every other note directly in the folder is a row; its properties are the note's frontmatter keys (matched
 * case-insensitively), written as plain YAML so they stay readable in `query` blocks and other tools.
 */

import { splitPath } from './markdown.js';
import { readFrontmatterYaml, setFrontmatterValues, type YamlMap, type YamlValue } from './yaml.js';
import { safeUrl } from './util.js';
import { isNoteTypePath } from './noteTypePath.js';
import { isVariablesPath } from './variables.js';

/** The schema note is `_database-<uuid>.md` (a name a person is unlikely to type); the plain `_database.md` of the first version still works */
export const DATABASE_PREFIX = '_database';
const DATABASE_NAME = /^_database(?:-[0-9a-f][0-9a-f-]{7,})?\.md$/i;
/** Also its copies: a taken path gets a number ("_database-… 2.md"). Sync conflict copies stay visible, they hold text that would be lost otherwise */
const DATABASE_OR_COPY = /^_database(?:-[0-9a-f][0-9a-f-]{7,})?(?: \d+)*\.md$/i;

/** File name for a new database note; `id` is a random UUID */
export const databaseFileName = (id: string): string => `${DATABASE_PREFIX}-${id}.md`;

export const PROPERTY_TYPES = ['text', 'number', 'date', 'select', 'multiselect', 'checkbox', 'link'] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];
export const VIEW_TYPES = ['table', 'board', 'gallery'] as const;
export type ViewType = (typeof VIEW_TYPES)[number];
export const FILTER_OPS = ['eq', 'ne', 'contains', 'gt', 'lt', 'empty', 'notempty'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export interface DbProperty {
  name: string;
  type: PropertyType;
  /** select / multiselect */
  options: string[];
  /** Prefilled in new notes */
  default: string;
}

export interface DbFilter {
  property: string;
  op: FilterOp;
  value: string;
}

export interface DbView {
  name: string;
  type: ViewType;
  /** table: columns in order (empty = all properties) */
  columns: string[];
  /** board: the select property that decides the column */
  group: string;
  filter: DbFilter[];
  sort: string;
  desc: boolean;
}

export interface Database {
  properties: DbProperty[];
  views: DbView[];
  /** Notes in subfolders are rows too (`subfolders: true`) */
  subfolders: boolean;
}

/** A cell value in its typed form */
export type DbValue = string | number | boolean | string[] | null;

export interface DbNote {
  id: string;
  path: string;
  content: string;
}

export interface DbRow {
  noteId: string;
  path: string;
  /** Folder relative to the database folder (empty for notes directly in it) */
  folder: string;
  title: string;
  values: Record<string, DbValue>;
  /** First image of the note, already safe for `src` (gallery) */
  cover: string | null;
}

/** Whether a note is hidden as a database note: the schema note of a folder, or a numbered copy of one */
export const isDatabasePath = (path: string): boolean => DATABASE_OR_COPY.test(path.slice(path.lastIndexOf('/') + 1));

/** Whether a note can be its folder's schema note; copies of one are hidden (`isDatabasePath`) but never define a database */
export const isSchemaPath = (path: string): boolean => DATABASE_NAME.test(path.slice(path.lastIndexOf('/') + 1));

/** Notes that only hold settings (database schema, variables, custom note types): kept out of lists, the tree, search and the graph */
export const isHiddenPath = (path: string): boolean => isDatabasePath(path) || isVariablesPath(path) || isNoteTypePath(path);

/** The database note of a folder, if there is one */
export function findDatabaseNote<T extends { path: string; content: string }>(folder: string, notes: Iterable<T>): T | null {
  for (const n of notes) if (isSchemaPath(n.path) && splitPath(n.path).folder === folder && parseDatabase(n.content)) return n;
  return null;
}

const str = (v: YamlValue | undefined): string => (typeof v === 'string' ? v : '');
const strList = (v: YamlValue | undefined): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : typeof v === 'string' && v ? [v] : [];
const maps = (v: YamlValue | undefined): YamlMap[] => (Array.isArray(v) ? v.filter((x): x is YamlMap => !!x && typeof x === 'object' && !Array.isArray(x)) : []);

/** Reads a list of typed properties; unnamed and repeated ones are left out */
export function parseProperties(v: YamlValue | undefined): DbProperty[] {
  const properties: DbProperty[] = [];
  for (const p of maps(v)) {
    const name = str(p.name).trim();
    if (!name || properties.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
    const type = str(p.type).toLowerCase() as PropertyType;
    properties.push({ name, type: PROPERTY_TYPES.includes(type) ? type : 'text', options: strList(p.options), default: str(p.default) });
  }
  return properties;
}

/** A typed property as it is stored */
export function propertyYaml(p: DbProperty): YamlMap {
  const o: YamlMap = { name: p.name, type: p.type };
  if (p.options.length) o.options = p.options;
  if (p.default) o.default = p.default;
  return o;
}

/** Parses the schema of a database note; null when the note is not one (no `type: database`) */
export function parseDatabase(content: string): Database | null {
  const fm = readFrontmatterYaml(content);
  if (!fm || str(fm.data.type).toLowerCase() !== 'database') return null;
  const properties = parseProperties(fm.data.properties);
  const views: DbView[] = [];
  for (const v of maps(fm.data.views)) {
    const type = str(v.type).toLowerCase() as ViewType;
    const filter: DbFilter[] = [];
    for (const f of maps(v.filter)) {
      const op = str(f.op).toLowerCase() as FilterOp;
      if (str(f.property) && FILTER_OPS.includes(op)) filter.push({ property: str(f.property), op, value: str(f.value) });
    }
    views.push({
      name: str(v.name).trim() || 'View',
      type: VIEW_TYPES.includes(type) ? type : 'table',
      columns: strList(v.columns),
      group: str(v.group),
      filter,
      sort: str(v.sort),
      desc: str(v.desc).toLowerCase() === 'true',
    });
  }
  if (!views.length) views.push(defaultView());
  return { properties, views, subfolders: str(fm.data.subfolders).toLowerCase() === 'true' };
}

export const defaultView = (name = 'Table'): DbView => ({ name, type: 'table', columns: [], group: '', filter: [], sort: '', desc: false });

/** Writes a schema into a database note's content, keeping its other frontmatter and body */
export function writeDatabase(content: string, db: Database): string {
  const properties = db.properties.map(propertyYaml);
  const views = db.views.map((v) => {
    const o: YamlMap = { name: v.name, type: v.type };
    if (v.columns.length) o.columns = v.columns;
    if (v.type === 'board' && v.group) o.group = v.group;
    if (v.filter.length) o.filter = v.filter.map((f) => ({ property: f.property, op: f.op, value: f.value }));
    if (v.sort) {
      o.sort = v.sort;
      if (v.desc) o.desc = 'true';
    }
    return o;
  });
  return setFrontmatterValues(content, { type: 'database', subfolders: db.subfolders ? 'true' : undefined, properties, views });
}

/** Content of a new database note; `keys` are frontmatter keys found in the folder's notes, made text properties */
export function newDatabaseContent(keys: string[] = []): string {
  const properties: DbProperty[] = keys.map((name) => ({ name, type: 'text', options: [], default: '' }));
  return writeDatabase('', { properties, views: [defaultView()], subfolders: false });
}

/** Frontmatter keys used by the notes of a folder (without the usual `title`, `tags`, `id`, `type`), to seed a schema */
export function inferPropertyKeys(folder: string, notes: Iterable<{ path: string; content: string }>): string[] {
  const seen = new Map<string, string>();
  for (const n of notes) {
    if (splitPath(n.path).folder !== folder || isHiddenPath(n.path)) continue;
    const fm = readFrontmatterYaml(n.content);
    if (!fm) continue;
    for (const k of Object.keys(fm.data)) {
      if (!/^(title|tags|id|type|aliases|created|updated)$/i.test(k) && !seen.has(k.toLowerCase())) seen.set(k.toLowerCase(), k);
    }
  }
  return [...seen.values()];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Reads a raw frontmatter value as the property's type; wrong shapes become null instead of throwing */
export function readValue(type: PropertyType, raw: YamlValue | undefined): DbValue {
  if (raw === undefined) return null;
  const list = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && x !== '') : null;
  const text = typeof raw === 'string' ? raw.trim() : list ? list.join(', ') : '';
  switch (type) {
    case 'multiselect':
      return list ?? (text ? text.split(',').map((s) => s.trim()).filter(Boolean) : []);
    case 'checkbox':
      return /^(true|yes|ja|1|x)$/i.test(text);
    case 'number': {
      if (text === '') return null;
      const n = Number(text.replace(',', '.'));
      return Number.isFinite(n) ? n : null;
    }
    case 'date':
      return ISO_DATE.test(text) ? text : null;
    default:
      return text === '' ? null : text;
  }
}

/** The YAML value to store for a typed cell; undefined removes the key */
export function writeValue(type: PropertyType, v: DbValue): YamlValue | undefined {
  if (v === null || v === '' || (Array.isArray(v) && !v.length)) return type === 'checkbox' ? 'false' : undefined;
  switch (type) {
    case 'multiselect':
      return Array.isArray(v) ? v : [String(v)];
    case 'checkbox':
      return v === true || v === 'true' ? 'true' : 'false';
    case 'number': {
      const n = Number(String(v).replace(',', '.'));
      return Number.isFinite(n) ? String(n) : undefined;
    }
    case 'date':
      return ISO_DATE.test(String(v)) ? String(v) : undefined;
    case 'link': {
      const s = String(v).trim();
      return s && !s.startsWith('[[') ? `[[${s}]]` : s || undefined;
    }
    default:
      return String(v);
  }
}

/** The note title a link value points to (`[[Title]]`, `[[Title|alias]]`) */
export function linkTarget(v: DbValue): string {
  const m = /^\[\[([^\]|#]+)/.exec(String(v ?? ''));
  return m ? m[1].trim() : String(v ?? '').trim();
}

/** Display text of a typed value */
export function formatDbValue(type: PropertyType, v: DbValue): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join(', ');
  if (type === 'checkbox') return v ? '✓' : '';
  if (type === 'link') return linkTarget(v);
  return String(v);
}

function findKey(data: YamlMap, name: string): string | undefined {
  if (name in data) return name;
  const lower = name.toLowerCase();
  return Object.keys(data).find((k) => k.toLowerCase() === lower);
}

const IMAGE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/;

/** The rows of a database: the notes in its folder (and its subfolders if the database includes them), without database notes */
export function databaseRows(db: Database, folder: string, notes: Iterable<DbNote>): DbRow[] {
  const rows: DbRow[] = [];
  for (const n of notes) {
    const { folder: f, name } = splitPath(n.path);
    const inside = f === folder || (db.subfolders && (folder === '' || f.startsWith(`${folder}/`)));
    if (!inside || isHiddenPath(n.path)) continue;
    const fm = readFrontmatterYaml(n.content);
    const data = fm?.data ?? {};
    const values: Record<string, DbValue> = {};
    for (const p of db.properties) {
      const key = findKey(data, p.name);
      values[p.name] = readValue(p.type, key === undefined ? undefined : data[key]);
    }
    const body = fm ? fm.body : n.content;
    const img = IMAGE.exec(body.replace(/```[\s\S]*?(```|$)/g, ''));
    rows.push({ noteId: n.id, path: n.path, folder: f === folder ? '' : f.slice(folder ? folder.length + 1 : 0), title: str(data.title).trim() || name, values, cover: img ? safeUrl(img[1], 'media') : null });
  }
  return rows;
}

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

function isEmpty(v: DbValue | undefined): boolean {
  return v === null || v === undefined || v === '' || v === false || (Array.isArray(v) && !v.length);
}

function matchesFilter(db: Database, row: DbRow, f: DbFilter): boolean {
  const prop = db.properties.find((p) => p.name.toLowerCase() === f.property.toLowerCase());
  const special = f.property.toLowerCase();
  const v = special === 'title' ? row.title : special === 'path' && !prop ? row.folder : prop ? row.values[prop.name] : null;
  const type = prop?.type ?? 'text';
  if (f.op === 'empty') return isEmpty(v);
  if (f.op === 'notempty') return !isEmpty(v);
  const shown = formatDbValue(type, v ?? null).toLowerCase();
  const want = f.value.toLowerCase();
  switch (f.op) {
    case 'eq':
      return Array.isArray(v) ? v.some((x) => x.toLowerCase() === want) : type === 'checkbox' ? (v === true) === /^(true|yes|ja|1)$/.test(want) : shown === want;
    case 'ne':
      return !matchesFilter(db, row, { ...f, op: 'eq' });
    case 'contains':
      return shown.includes(want);
    case 'gt':
    case 'lt': {
      if (isEmpty(v)) return false;
      const a = typeof v === 'number' ? v : shown;
      const b = typeof v === 'number' ? Number(want.replace(',', '.')) : want;
      if (typeof a === 'number' && Number.isNaN(b)) return false;
      const c = typeof a === 'number' ? a - (b as number) : collator.compare(a, String(b));
      return f.op === 'gt' ? c > 0 : c < 0;
    }
  }
}

function compareValues(a: DbValue | undefined, b: DbValue | undefined): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return collator.compare(Array.isArray(a) ? a.join(', ') : String(a ?? ''), Array.isArray(b) ? b.join(', ') : String(b ?? ''));
}

/** Applies a view's filters and sort order; empty values sort last in both directions, ties by title */
export function applyView(db: Database, view: DbView, rows: DbRow[]): DbRow[] {
  const out = rows.filter((r) => view.filter.every((f) => matchesFilter(db, r, f)));
  const sortName = view.sort.toLowerCase();
  const prop = db.properties.find((p) => p.name.toLowerCase() === sortName);
  out.sort((a, b) => {
    if (sortName) {
      const av = prop ? a.values[prop.name] : sortName === 'title' ? a.title : sortName === 'path' ? a.folder : null;
      const bv = prop ? b.values[prop.name] : sortName === 'title' ? b.title : sortName === 'path' ? b.folder : null;
      const ae = isEmpty(av);
      const be = isEmpty(bv);
      if (ae !== be) return ae ? 1 : -1;
      const c = compareValues(av, bv);
      if (c) return view.desc ? -c : c;
    }
    return collator.compare(a.title, b.title);
  });
  return out;
}

/** Board columns: the options of the group property in order, then values found only in notes, then "no value" (empty name) */
export function boardLanes(db: Database, view: DbView, rows: DbRow[]): { value: string; rows: DbRow[] }[] {
  const prop = db.properties.find((p) => p.name.toLowerCase() === view.group.toLowerCase());
  if (!prop) return [];
  const valueOf = (r: DbRow) => {
    const v = r.values[prop.name];
    return Array.isArray(v) ? (v[0] ?? '') : String(v ?? '');
  };
  const names = [...prop.options];
  for (const r of rows) {
    const v = valueOf(r);
    if (v && !names.some((n) => n.toLowerCase() === v.toLowerCase())) names.push(v);
  }
  names.push('');
  return names.map((value) => ({ value, rows: rows.filter((r) => valueOf(r).toLowerCase() === value.toLowerCase()) })).filter((l) => l.value !== '' || l.rows.length);
}

/** Frontmatter and body for a new note in a database: every property is there, filled with its default */
export function newDatabaseNoteContent(db: Database, title: string): string {
  const updates: Record<string, YamlValue | undefined> = {};
  for (const p of db.properties) {
    const v = p.default ? writeValue(p.type, p.type === 'multiselect' ? p.default.split(',').map((s) => s.trim()).filter(Boolean) : p.type === 'checkbox' ? /^(true|yes|ja|1)$/i.test(p.default) : p.default) : undefined;
    updates[p.name] = v ?? (p.type === 'multiselect' ? [] : p.type === 'checkbox' ? 'false' : '');
  }
  return plainScalars(setFrontmatterValues(`# ${title}\n\n`, updates), db.properties);
}

/** Changes one cell: returns the note content with the property written as its type */
export function setCell(content: string, prop: DbProperty, v: DbValue): string {
  const existing = readFrontmatterYaml(content);
  const key = (existing && findKey(existing.data, prop.name)) || prop.name;
  const written = writeValue(prop.type, v);
  return plainScalars(setFrontmatterValues(content, { [key]: written }), [prop]);
}

/** Numbers and checkboxes are written as real YAML scalars (`pages: 12`, `read: true`), not quoted strings, so other tools read them too */
function plainScalars(content: string, props: DbProperty[]): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!m) return content;
  let yaml = m[1];
  for (const p of props) {
    if (p.type !== 'number' && p.type !== 'checkbox') continue;
    const key = p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    yaml = yaml.replace(new RegExp(`^(${key}): "(true|false|-?\\d+(?:\\.\\d+)?)"$`, 'gim'), '$1: $2');
  }
  return `---\n${yaml}\n---${content.slice(m[0].length)}`;
}
