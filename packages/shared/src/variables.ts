/**
 * Variables: a note `_variables-<uuid>.md` in a folder defines variables for the notes of that folder and its
 * subfolders, in its frontmatter:
 *
 *   ---
 *   type: variables
 *   variables:
 *     customer: ACME
 *     repo: "https://git.example.com/{{var:customer}}"
 *   ---
 *
 * Notes use them with `{{var:customer}}` or, with a fallback, `{{var:customer|nobody}}`. The placeholder stays in the
 * text and is filled in whenever the note is shown or exported. The nearest folder wins, up to the root of the space
 * (own notes or one group; never across spaces). A value may use other variables; they are looked up from the note's
 * folder (so overriding `customer` in a subfolder changes `repo` there too), and a value that names itself means the
 * one it overrides.
 *
 * Notes come from other people: values are text, never markup, and expanding them is bounded (depth, steps, length).
 */

import { parseFrontmatter, splitPath } from './markdown.js';
import { codeSpans, findMath } from './math.js';
import { readFrontmatterYaml, setFrontmatterValues, type YamlMap, type YamlValue } from './yaml.js';
import { builtinVariable } from './builtinVariables.js';
import { toDateString } from './tasks.js';

/** The definition note is `_variables-<uuid>.md`, so two devices can create one at the same time; `_variables.md` works too */
export const VARIABLES_PREFIX = '_variables';
const VARIABLES_NAME = /^_variables(?:-[0-9a-f][0-9a-f-]{7,})?\.md$/i;

/** File name for a new definition note; `id` is a random UUID */
export const variablesFileName = (id: string): string => `${VARIABLES_PREFIX}-${id}.md`;

export function isVariablesPath(path: string): boolean {
  const at = path.lastIndexOf('/') + 1;
  return path[at] === '_' && VARIABLES_NAME.test(path.slice(at));
}

const NAME = String.raw`[\p{L}\p{N}_][\p{L}\p{N}\p{M}_.-]{0,63}`;
const NAME_RE = new RegExp(`^${NAME}$`, 'u');
/** `{{var:name}}`, `{{var:name|fallback}}` (in a table cell `\|`); every part is bounded */
const PLACEHOLDER = String.raw`\{\{var:[ ]?(${NAME})[ ]?(?:\\?\|([^{}\n]{0,500}))?\}\}`;
const placeholderRe = () => new RegExp(PLACEHOLDER, 'gu');

/** Longest value that is kept, and the most an expanded value may grow to */
export const MAX_VARIABLE_VALUE = 2000;
/** Variables read from one folder */
export const MAX_FOLDER_VARIABLES = 500;
const MAX_DEPTH = 10;
/** Placeholders expanded for one value, its nested ones included */
const MAX_STEPS = 200;
/** Text all filled-in values of one document may add */
const MAX_TOTAL = 1_000_000;

export const isVariableName = (name: string): boolean => NAME_RE.test(name) && name !== '__proto__';

/** Names are matched without upper and lower case */
export const variableKey = (name: string): string => name.normalize('NFC').toLowerCase();

export const variablePlaceholder = (name: string): string => `{{var:${name}}}`;

/** Quick test before any real work */
export const hasVariables = (text: string): boolean => text.includes('{{var:');

// ------------------------------------------------------------------ definitions

export interface VariableDef {
  name: string;
  /** As written: one line, may contain placeholders */
  value: string;
}

/** The definitions of one space (own notes, or one group): folder ('' is the root) → its own variables */
export type VariableDefinitions = ReadonlyMap<string, readonly VariableDef[]>;

/** One line, bounded */
export const cleanVariableValue = (value: string): string => value.replace(/\s+/g, ' ').trim().slice(0, MAX_VARIABLE_VALUE);

function valueText(v: YamlValue): string | null {
  if (typeof v === 'string') return cleanVariableValue(v);
  // `[a, b]` unquoted in hand-written YAML
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return cleanVariableValue(v.join(', '));
  return null;
}

/** The variables of a definition note; null when the note is none (no `type: variables`) */
export function parseVariables(content: string): VariableDef[] | null {
  const fm = readFrontmatterYaml(content);
  if (!fm || typeof fm.data.type !== 'string' || fm.data.type.trim().toLowerCase() !== 'variables') return null;
  const map = fm.data.variables;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  const out: VariableDef[] = [];
  const seen = new Set<string>();
  for (const [name, raw] of Object.entries(map)) {
    if (out.length >= MAX_FOLDER_VARIABLES) break;
    const value = valueText(raw);
    if (value === null || !isVariableName(name) || seen.has(variableKey(name))) continue;
    seen.add(variableKey(name));
    out.push({ name, value });
  }
  return out;
}

/** Writes the variables into a definition note's content, keeping its other frontmatter and body */
export function writeVariables(content: string, defs: readonly VariableDef[]): string {
  const map: YamlMap = {};
  for (const d of defs) if (isVariableName(d.name)) map[d.name] = cleanVariableValue(d.value);
  return setFrontmatterValues(content, { type: 'variables', variables: map });
}

/** Sets one variable (`value` null removes it); the name keeps the spelling it was first written with */
export function setVariable(defs: readonly VariableDef[], name: string, value: string | null): VariableDef[] {
  const key = variableKey(name);
  if (value === null) return defs.filter((d) => variableKey(d.name) !== key);
  if (defs.some((d) => variableKey(d.name) === key)) return defs.map((d) => (variableKey(d.name) === key ? { name: d.name, value: cleanVariableValue(value) } : d));
  return [...defs, { name, value: cleanVariableValue(value) }];
}

/**
 * Collects the definitions of one space from its notes (others are skipped, so any list of the space's notes will do).
 * Several definition notes in one folder count together, the first by path wins.
 */
export function variableDefinitions(notes: Iterable<{ path: string; content: string }>): VariableDefinitions {
  const found = [...notes].filter((n) => isVariablesPath(n.path)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const out = new Map<string, VariableDef[]>();
  for (const n of found) {
    const defs = parseVariables(n.content);
    if (!defs?.length) continue;
    const folder = splitPath(n.path).folder;
    const list = out.get(folder) ?? [];
    const keys = new Set(list.map((d) => variableKey(d.name)));
    out.set(folder, [...list, ...defs.filter((d) => !keys.has(variableKey(d.name)))]);
  }
  return out;
}

// ------------------------------------------------------------------ scope

/** A variable as a folder sees it */
export interface VariableEntry extends VariableDef {
  /** Folder that defines it ('' is the root of the space) */
  folder: string;
  /** The variable of the same name further up that this one overrides */
  outer: VariableEntry | null;
  /** A built-in date variable (builtinVariables.ts): defined nowhere, its value follows the day */
  builtin?: true;
}

/** The built-in variable of a name as an entry, its value for `now` */
function builtinEntry(name: string, now: Date): VariableEntry | null {
  const b = builtinVariable(name);
  return b ? { name: b.name, value: b.value(now), folder: '', outer: null, builtin: true } : null;
}

export type VariableStatus =
  | 'ok'
  /** Not defined here, the placeholder's fallback is shown */
  | 'fallback'
  /** Not defined here, or its value names one that is not */
  | 'unknown'
  /** The value leads back to itself */
  | 'cycle'
  /** Too deep or too long */
  | 'limit';

export interface ResolvedVariable {
  name: string;
  status: VariableStatus;
  /** What to show. For 'unknown', 'cycle' and 'limit' it contains the placeholder that could not be filled in */
  text: string;
  /** Where the value comes from; null when it is not defined */
  entry: VariableEntry | null;
}

export interface VariableScope {
  folder: string;
  /** Every variable visible here, sorted by name */
  list(): VariableEntry[];
  get(name: string): VariableEntry | undefined;
  resolve(name: string, fallback?: string): ResolvedVariable;
}

class FolderScope implements VariableScope {
  private memo = new Map<string, Omit<ResolvedVariable, 'name'>>();
  /** The day the memo was filled on: built-in date variables change at midnight */
  private memoDay = '';
  private now = new Date();
  private sorted: VariableEntry[] | null = null;

  constructor(
    readonly folder: string,
    private readonly entries: ReadonlyMap<string, VariableEntry>,
    /** Values are final text (already expanded elsewhere) */
    private readonly literal = false
  ) {}

  list(): VariableEntry[] {
    this.sorted ??= [...this.entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, e]) => e);
    return this.sorted;
  }

  get(name: string): VariableEntry | undefined {
    return this.entries.get(variableKey(name));
  }

  resolve(name: string, fallback?: string): ResolvedVariable {
    const key = variableKey(name);
    this.now = new Date();
    const day = toDateString(this.now);
    if (day !== this.memoDay) {
      this.memo.clear();
      this.memoDay = day;
    }
    const entry = this.entries.get(key) ?? builtinEntry(name, this.now);
    if (!entry) {
      if (fallback === undefined) return { name, status: 'unknown', text: variablePlaceholder(name), entry: null };
      return { name, status: 'fallback', text: fallback.trim(), entry: null };
    }
    let r = this.memo.get(key);
    if (!r) {
      r = this.literal ? { status: 'ok', text: entry.value, entry } : this.expandTop(key, entry);
      this.memo.set(key, r);
    }
    return { name, ...r };
  }

  private expandTop(key: string, entry: VariableEntry): Omit<ResolvedVariable, 'name'> {
    const state = { steps: 0, status: 'ok' as VariableStatus };
    const text = this.expand(entry, new Map([[key, entry]]), 0, state);
    if (state.status === 'cycle' || state.status === 'limit') return { status: state.status, text: variablePlaceholder(entry.name), entry };
    return { status: state.status, text, entry };
  }

  /** `active`: the variables being expanded, with the entry used for each */
  private expand(entry: VariableEntry, active: Map<string, VariableEntry>, depth: number, state: { steps: number; status: VariableStatus }): string {
    if (!hasVariables(entry.value)) return entry.value;
    let out = '';
    let pos = 0;
    for (const p of findPlaceholders(entry.value)) {
      out += entry.value.slice(pos, p.from);
      pos = p.to;
      if (++state.steps > MAX_STEPS || depth >= MAX_DEPTH) {
        state.status = 'limit';
        return '';
      }
      const key = variableKey(p.name);
      const open = active.get(key);
      // A value that names itself means the one it overrides; without one it is a cycle
      const target = open ? (open.outer ?? (open.builtin ? null : builtinEntry(p.name, this.now))) : (this.entries.get(key) ?? builtinEntry(p.name, this.now));
      if (target) {
        active.set(key, target);
        out += this.expand(target, active, depth + 1, state);
        if (open) active.set(key, open);
        else active.delete(key);
        if (state.status === 'cycle' || state.status === 'limit') return '';
      } else if (p.fallback !== undefined) out += p.fallback.trim();
      else if (open) {
        state.status = 'cycle';
        return '';
      } else {
        state.status = 'unknown';
        out += variablePlaceholder(p.name);
      }
      if (out.length > MAX_VARIABLE_VALUE) {
        state.status = 'limit';
        return '';
      }
    }
    out += entry.value.slice(pos);
    if (out.length > MAX_VARIABLE_VALUE) state.status = 'limit';
    return out;
  }
}

/** The variables a note in `folder` sees: its folder's own and those of the folders above, the nearest winning */
export function variableScope(folder: string, definitions: VariableDefinitions): VariableScope {
  const entries = new Map<string, VariableEntry>();
  if (definitions.size) {
    const parts = folder ? folder.split('/') : [];
    for (let i = 0; i <= parts.length; i++) {
      const at = parts.slice(0, i).join('/');
      for (const d of definitions.get(at) ?? []) {
        const key = variableKey(d.name);
        entries.set(key, { ...d, folder: at, outer: entries.get(key) ?? null });
      }
    }
  }
  return new FolderScope(folder, entries);
}

/** A scope of finished values (public links: the server sends only the values the note uses) */
export function fixedVariableScope(values: Readonly<Record<string, string>>): VariableScope {
  return new FolderScope('', new Map(Object.entries(values).map(([name, value]) => [variableKey(name), { name, value, folder: '', outer: null }])), true);
}

export const EMPTY_VARIABLE_SCOPE: VariableScope = variableScope('', new Map());

// ------------------------------------------------------------------ placeholders in text

export interface VariablePlaceholder {
  from: number;
  to: number;
  name: string;
  fallback?: string;
}

/** Every placeholder of a text, wherever it is (no Markdown rules) */
export function findPlaceholders(text: string): VariablePlaceholder[] {
  if (!hasVariables(text)) return [];
  return [...text.matchAll(placeholderRe())].map((m) => ({ from: m.index!, to: m.index! + m[0].length, name: m[1], ...(m[2] !== undefined ? { fallback: m[2] } : {}) }));
}

/** Fills placeholders; the ones that cannot be filled in, and those past the size limit, keep their own text */
function substitute<P extends VariablePlaceholder>(text: string, found: readonly P[], scope: VariableScope, show: (r: ResolvedVariable, p: P) => string): string {
  let out = '';
  let pos = 0;
  let added = 0;
  for (const p of found) {
    out += text.slice(pos, p.from);
    pos = p.to;
    const r = scope.resolve(p.name, p.fallback);
    added += r.text.length;
    out += added > MAX_TOTAL ? text.slice(p.from, p.to) : show(r, p);
  }
  return out + text.slice(pos);
}

/** Plain text with its placeholders filled in (labels, titles, cells; not Markdown: values are not escaped) */
export function resolveVariables(text: string, scope: VariableScope): string {
  return hasVariables(text) ? substitute(text, findPlaceholders(text), scope, (r) => r.text) : text;
}

/** Characters that would end a URL in Markdown or HTML, encoded; everything else (slashes, `?`, `%20`, …) stays */
export function encodeUrlValue(value: string): string {
  return value.replace(/[\s()<>"'`[\]{}|\\^\p{Cc}]/gu, (c) => (c.charCodeAt(0) < 128 ? `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}` : encodeURIComponent(c)));
}

/**
 * A URL with its placeholders filled in. `complete` is false when one of them has no value: such a URL must not be
 * opened. The result is still untrusted, so it goes through `safeUrl` afterwards.
 */
export function resolveVariableUrl(url: string, scope: VariableScope): { url: string; complete: boolean } {
  if (!hasVariables(url)) return { url, complete: true };
  let complete = true;
  const out = substitute(url, findPlaceholders(url), scope, (r, p) => {
    if (isFilled(r)) return encodeUrlValue(r.text);
    complete = false;
    return url.slice(p.from, p.to);
  });
  return { url: out, complete: complete && !hasVariables(out) };
}

/** The placeholder has a value to show (its own or the fallback) */
export const isFilled = (r: ResolvedVariable): boolean => r.status === 'ok' || r.status === 'fallback';

// ------------------------------------------------------------------ placeholders in Markdown

export interface MarkdownPlaceholder extends VariablePlaceholder {
  /** Inside the destination of a link or image, or a bare URL */
  inUrl: boolean;
}

const FENCE = /^[\s>]*(`{3,}|~{3,})/;
const IN_DESTINATION = /\]\([ \t]*<?[^\s()<>]*$/;
const IN_BARE_URL = /(?:^|[\s(<[])https?:\/\/[^\s<>]*$/i;
const IN_WIKILINK = /\[\[[^[\]]*$/;

/**
 * The placeholders of a Markdown text that are filled in: not those in the frontmatter, in code (blocks and `inline`),
 * in formulas and in `[[links]]` (they name notes).
 */
export function markdownPlaceholders(text: string): MarkdownPlaceholder[] {
  if (!hasVariables(text)) return [];
  const start = text.startsWith('---') ? text.length - parseFrontmatter(text).body.length : 0;
  const math = findMath(text, start);
  const out: MarkdownPlaceholder[] = [];
  let fence: string | null = null;
  let pos = 0;
  let nextMath = 0;
  for (const line of text.split('\n')) {
    const lineFrom = pos;
    pos += line.length + 1;
    if (lineFrom < start) continue;
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.slice(f[0].length).trim() === '') fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }
    if (!hasVariables(line)) continue;
    const code = codeSpans(line);
    let nextCode = 0;
    // What stands before a placeholder on its line, earlier placeholders as one letter (their fallback may hold spaces)
    let before = '';
    let last = 0;
    for (const p of findPlaceholders(line)) {
      before = (before + line.slice(last, p.from)).slice(-600);
      last = p.to;
      const context = before;
      before += 'x';
      while (nextCode < code.length && code[nextCode][1] <= p.from) nextCode++;
      if (nextCode < code.length && code[nextCode][0] < p.to) continue;
      const from = lineFrom + p.from;
      const to = lineFrom + p.to;
      while (nextMath < math.length && math[nextMath].to <= from) nextMath++;
      if (nextMath < math.length && math[nextMath].from < to) continue;
      if (IN_WIKILINK.test(context)) continue;
      out.push({ ...p, from, to, inUrl: IN_DESTINATION.test(context) || IN_BARE_URL.test(context) });
    }
  }
  return out;
}

/** A value that is a whole web address: it stays one, so it becomes a link */
export const isUrlValue = (value: string): boolean => /^https?:\/\/[^\s<>"'`()[\]{}|\\^]+$/i.test(value);

/** Text as Markdown that shows exactly this text */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/[\\`*[\]<>#|~$]|(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])|&(?=[#\w]{1,32};)/gu, (c) => `\\${c}`)
    .replace(/\{\{/g, '\\{\\{')
    .replace(/^([-+=])/, '\\$1')
    .replace(/^(\d{1,9})([.)])/, '$1\\$2');
}

/** Markdown with its placeholders filled in, the values escaped so they stay text (Markdown export) */
export function fillVariables(markdown: string, scope: VariableScope): string {
  return substitute(markdown, markdownPlaceholders(markdown), scope, (r, p) => {
    if (!isFilled(r)) return markdown.slice(p.from, p.to);
    if (p.inUrl) return encodeUrlValue(r.text);
    return isUrlValue(r.text) ? r.text : escapeMarkdown(r.text);
  });
}

const TOKEN_OPEN = '';
const TOKEN_CLOSE = '';
const tokenRe = () => /(\d{1,7})/g;

export interface MaskedText {
  /** The text with a token in place of every value */
  text: string;
  /** The values, by token number */
  values: ResolvedVariable[];
  /** Puts the values into a text made from the masked one */
  fill(text: string): string;
  /** The same for every string of a parsed structure (the structure is changed) */
  fillAll<T>(value: T): T;
}

/** Splits a text made from a masked one into plain pieces and token numbers */
export function splitMasked(text: string): (string | number)[] {
  const out: (string | number)[] = [];
  let pos = 0;
  for (const m of text.matchAll(tokenRe())) {
    if (m.index! > pos) out.push(text.slice(pos, m.index));
    out.push(Number(m[1]));
    pos = m.index! + m[0].length;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

/**
 * Takes the values out of a Markdown text's way while it is parsed, so nothing in them reads as Markdown: each
 * placeholder becomes a token, filled in afterwards. Parts of URLs are put in at once (encoded), so the URL is
 * complete when it is checked.
 */
export function maskVariables(markdown: string, scope: VariableScope): MaskedText {
  const values: ResolvedVariable[] = [];
  let text = markdown;
  if (hasVariables(markdown)) {
    const source = markdown.replace(/[]/g, '');
    text = substitute(source, markdownPlaceholders(source), scope, (r, p) => {
      if (p.inUrl) return isFilled(r) ? encodeUrlValue(r.text) : source.slice(p.from, p.to);
      if (isFilled(r) && isUrlValue(r.text)) return r.text;
      values.push(r);
      return `${TOKEN_OPEN}${values.length - 1}${TOKEN_CLOSE}`;
    });
  }
  const fill = (s: string) => (values.length ? s.replace(tokenRe(), (token, n: string) => values[Number(n)]?.text ?? token) : s);
  const fillAll = <T>(value: T): T => {
    if (!values.length) return value;
    if (typeof value === 'string') return fill(value) as T & string;
    if (Array.isArray(value)) value.forEach((v, i) => (value[i] = fillAll(v)));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) (value as Record<string, unknown>)[k] = fillAll(v);
    return value;
  };
  return { text, values, fill, fillAll };
}

/** The finished values of the variables a note uses (what a public link may know of its folders), by name */
export function usedVariables(markdown: string, scope: VariableScope): Record<string, string> {
  const out = new Map<string, string>();
  let total = 0;
  for (const p of markdownPlaceholders(markdown)) {
    const key = variableKey(p.name);
    if (out.has(key)) continue;
    const r = scope.resolve(p.name);
    if (r.status !== 'ok') continue;
    total += r.text.length;
    if (total > MAX_TOTAL) break;
    out.set(key, r.text);
  }
  return Object.fromEntries(out);
}
