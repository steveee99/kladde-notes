/**
 * A small YAML subset for frontmatter (#94): nested maps, lists (also of maps), inline lists `[a, b]`, quoted
 * strings and block scalars (`|`, `>`). Scalars stay strings; that is all OKF needs and keeps unknown keys intact.
 * `parseFrontmatter` in markdown.ts stays the flat, fast view; this one is for the nested fields.
 */

export type YamlValue = string | YamlValue[] | { [key: string]: YamlValue };
export type YamlMap = { [key: string]: YamlValue };

interface Line {
  indent: number;
  text: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const isListItem = (text: string) => text === '-' || text.startsWith('- ');

/** `key: value` / `key:`; a key ends at the first ": " (or ":" at the end), so URLs in values stay whole */
const KEY_LINE = /^("[^"]*"|'[^']*'|[^\s"'#\-[{][^:]*|-[^\s:][^:]*):(?:\s(.*))?$/;

function unquote(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

/** Splits `a, "b, c", d` at commas outside quotes */
function splitInline(src: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = '';
  for (const ch of src) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function scalar(raw: string): YamlValue {
  let s = raw.trim();
  if (s.startsWith('[') && s.endsWith(']')) return splitInline(s.slice(1, -1)).map((p) => unquote(p));
  if (s === '{}') return {};
  if (!s.startsWith('"') && !s.startsWith("'")) {
    // An unquoted value ends at " #" (a comment)
    const hash = s.indexOf(' #');
    if (hash >= 0) s = s.slice(0, hash).trimEnd();
  }
  if (s === '~' || s === 'null') return '';
  return unquote(s);
}

/** Parses YAML text (the inside of a frontmatter block). Never throws; see `yamlProblems` for lines it skipped */
export function parseYaml(src: string): YamlMap {
  return parseLines(src).value;
}

/** Lines the parser could not place (shown as "unparsable YAML") */
export function yamlProblems(src: string): number[] {
  return parseLines(src).skipped;
}

function parseLines(src: string): { value: YamlMap; skipped: number[] } {
  const raw = src.split('\n');
  const lines: (Line & { no: number })[] = [];
  raw.forEach((l, no) => {
    const line = l.replace(/\r$/, '');
    if (!line.trim() || /^\s*#/.test(line)) return;
    lines.push({ indent: line.length - line.trimStart().length, text: line.trim(), no });
  });
  const skipped: number[] = [];
  let i = 0;

  const blockScalar = (indent: number, folded: boolean): string => {
    const start = i < lines.length ? lines[i].no : raw.length;
    const parts: string[] = [];
    let base = -1;
    let last = start;
    while (i < lines.length && lines[i].indent > indent) {
      if (base < 0) base = lines[i].indent;
      last = lines[i].no;
      i++;
    }
    // Take the raw lines (blank ones included) so paragraphs survive
    for (let n = start; n <= last && base >= 0; n++) parts.push(raw[n].replace(/\r$/, '').slice(base));
    return folded ? parts.join(' ').replace(/\s+/g, ' ').trim() : parts.join('\n');
  };

  const parseBlock = (): YamlValue => (isListItem(lines[i].text) ? parseList(lines[i].indent) : parseMap(lines[i].indent));

  const parseMap = (indent: number): YamlMap => {
    const out: YamlMap = {};
    while (i < lines.length && lines[i].indent === indent && !isListItem(lines[i].text)) {
      const m = KEY_LINE.exec(lines[i].text);
      if (!m) {
        skipped.push(lines[i].no);
        i++;
        continue;
      }
      const key = unquote(m[1]);
      const rest = (m[2] ?? '').trim();
      i++;
      if (rest === '|' || rest === '|-' || rest === '>' || rest === '>-') out[key] = blockScalar(indent, rest.startsWith('>'));
      else if (rest && !rest.startsWith('#')) out[key] = scalar(rest);
      else if (i < lines.length && (lines[i].indent > indent || (lines[i].indent === indent && isListItem(lines[i].text)))) out[key] = parseBlock();
      else out[key] = '';
    }
    return out;
  };

  const parseList = (indent: number): YamlValue[] => {
    const out: YamlValue[] = [];
    while (i < lines.length && lines[i].indent === indent && isListItem(lines[i].text)) {
      const rest = lines[i].text.slice(1).trimStart();
      if (!rest) {
        i++;
        out.push(i < lines.length && lines[i].indent > indent ? parseBlock() : '');
      } else if (KEY_LINE.test(rest) && !rest.startsWith('[')) {
        // "- key: value" opens a map whose keys line up with "key"
        const childIndent = indent + (lines[i].text.length - rest.length);
        lines[i] = { ...lines[i], indent: childIndent, text: rest };
        out.push(parseMap(childIndent));
      } else {
        out.push(scalar(rest));
        i++;
      }
    }
    return out;
  };

  const value: YamlMap = {};
  while (i < lines.length) {
    const before = i;
    if (isListItem(lines[i].text)) {
      skipped.push(lines[i].no);
      i++;
      continue;
    }
    Object.assign(value, parseMap(lines[i].indent));
    if (i === before) {
      skipped.push(lines[i].no);
      i++;
    }
  }
  return { value, skipped };
}

/** The frontmatter block of a note: its YAML, the parsed map, and the body after it; null without one */
export function readFrontmatterYaml(content: string): { yaml: string; data: YamlMap; body: string } | null {
  const m = FRONTMATTER.exec(content);
  if (!m) return null;
  return { yaml: m[1], data: parseYaml(m[1]), body: content.slice(m[0].length) };
}

const PLAIN = /^[\p{L}\p{N}_./+-][\p{L}\p{N}_ ./@+:()-]*$/u;

function quoteScalar(s: string): string {
  if (s === '') return '""';
  // Plain when it cannot be mistaken for something else: no ": ", " #", leading specials, booleans or null
  if (PLAIN.test(s) && !/: |:$| #/.test(s) && !/^(true|false|null|yes|no|on|off|~)$/i.test(s) && !/^[-+]?(\d[\d_]*)?\.?\d+([eE][-+]?\d+)?$/.test(s) && s.trim() === s) return s;
  return JSON.stringify(s);
}

/** YAML lines for one top-level `key: value` (value nested as needed) */
export function stringifyYamlEntry(key: string, value: YamlValue): string {
  const lines: string[] = [];
  const emit = (k: string | null, v: YamlValue, indent: string, inList: boolean) => {
    const head = k === null ? '' : `${quoteKey(k)}:`;
    if (typeof v === 'string') {
      if (v.includes('\n')) {
        lines.push(`${indent}${head}${head ? ' ' : ''}|`);
        for (const l of v.split('\n')) lines.push(l ? `${indent}  ${l}` : '');
      } else lines.push(`${indent}${head}${head ? ' ' : ''}${quoteScalar(v)}`);
      return;
    }
    if (Array.isArray(v)) {
      if (!v.length) return void lines.push(`${indent}${head} []`);
      if (v.every((x) => typeof x === 'string' && !x.includes('\n')) && (v as string[]).join(', ').length < 80 && k !== null && !inList) {
        return void lines.push(`${indent}${head} [${(v as string[]).map(quoteScalar).join(', ')}]`);
      }
      lines.push(`${indent}${head}`);
      for (const item of v) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const entries = Object.entries(item);
          if (!entries.length) {
            lines.push(`${indent}  - {}`);
            continue;
          }
          const start = lines.length;
          for (const [ik, iv] of entries) emit(ik, iv, `${indent}    `, true);
          lines[start] = `${indent}  - ${lines[start].trimStart()}`;
        } else if (Array.isArray(item)) {
          lines.push(`${indent}  -`);
          const start = lines.length;
          emit(null, item, `${indent}    `, true);
          if (lines.length === start) lines.pop();
        } else lines.push(`${indent}  - ${quoteScalar(item)}`);
      }
      return;
    }
    const entries = Object.entries(v);
    if (!entries.length) return void lines.push(`${indent}${head} {}`);
    lines.push(`${indent}${head}`);
    for (const [ik, iv] of entries) emit(ik, iv, `${indent}  `, false);
  };
  emit(key, value, '', false);
  return lines.join('\n');
}

function quoteKey(k: string): string {
  return /^[A-Za-z0-9_][A-Za-z0-9_ .-]*$/.test(k) ? k : JSON.stringify(k);
}

/** Top-level entries of a frontmatter block as raw line ranges, so one key can change without touching others */
function topLevelEntries(yaml: string): { key: string | null; lines: string[] }[] {
  const out: { key: string | null; lines: string[] }[] = [];
  for (const line of yaml.split('\n')) {
    const top = line.length > 0 && !/^\s/.test(line) && !isListItem(line.trim()) && !line.startsWith('#');
    const m = top ? KEY_LINE.exec(line.trim()) : null;
    if (m) out.push({ key: unquote(m[1]), lines: [line] });
    else if (out.length) out[out.length - 1].lines.push(line);
    else out.push({ key: null, lines: [line] });
  }
  return out;
}

/**
 * Sets (or with `undefined` removes) top-level frontmatter keys. Other keys keep their exact text, unknown ones
 * included. Creates the frontmatter block when the note has none.
 */
export function setFrontmatterValues(content: string, updates: Record<string, YamlValue | undefined>): string {
  const m = FRONTMATTER.exec(content);
  const yaml = m ? m[1] : '';
  const body = m ? content.slice(m[0].length) : content;
  const entries = yaml ? topLevelEntries(yaml) : [];
  for (const [key, value] of Object.entries(updates)) {
    const at = entries.findIndex((e) => e.key === key);
    if (value === undefined) {
      if (at >= 0) entries.splice(at, 1);
      continue;
    }
    const lines = stringifyYamlEntry(key, value).split('\n');
    if (at >= 0) {
      // Keep trailing blank lines/comments that belonged visually to the next entry
      const tail: string[] = [];
      const old = entries[at].lines;
      while (old.length > 1 && (!old[old.length - 1].trim() || old[old.length - 1].trimStart().startsWith('#'))) tail.unshift(old.pop()!);
      entries[at] = { key, lines: [...lines, ...tail] };
    } else entries.push({ key, lines });
  }
  const text = entries.flatMap((e) => e.lines).join('\n').replace(/\n+$/, '');
  if (!text.trim()) return body.replace(/^\n+/, '');
  return `---\n${text}\n---\n${m ? body : body.startsWith('\n') ? body : `\n${body}`}`;
}
