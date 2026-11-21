/**
 * The info string of a fenced code block (the text after the opening ```), as Docusaurus, VitePress and Expressive
 * Code write it:
 *
 *   ```ts title="vault.ts" {3-4,7} showLineNumbers
 *
 * - the first bare word is the language (lowercase),
 * - `title="…"` (or `filename=`, `file=`; quotes optional without spaces) names the file shown in the header,
 * - `{1,3-5}` highlights lines (1-based, counted in the code without the fences),
 * - `showLineNumbers` / `lineNumbers` turns line numbers on (`showLineNumbers=10` starts at 10), `noLineNumbers` off,
 * - `collapse` / `noCollapse` overrides folding long blocks.
 *
 * Unknown words are ignored. Note text is untrusted: a plain left-to-right scan, no regexes, bounded output.
 */
export interface CodeInfo {
  lang: string;
  title: string;
  /** Highlighted line ranges [from, to], inclusive, 1-based */
  highlight: [number, number][];
  /** null: follow the setting */
  lineNumbers: boolean | null;
  /** First line number (default 1) */
  lineStart: number;
  /** null: follow the setting */
  collapse: boolean | null;
}

const MAX_RANGES = 64;
const MAX_LINE = 1_000_000;
const MAX_TITLE = 200;

const isSpace = (c: string) => c === ' ' || c === '\t';

function parseRanges(body: string): [number, number][] {
  const out: [number, number][] = [];
  for (const part of body.split(',')) {
    if (out.length >= MAX_RANGES) break;
    const p = part.trim();
    if (!p) continue;
    const dash = p.indexOf('-');
    const a = Number(dash < 0 ? p : p.slice(0, dash));
    const b = dash < 0 ? a : Number(p.slice(dash + 1));
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a) continue;
    out.push([Math.min(a, MAX_LINE), Math.min(b, MAX_LINE)]);
  }
  return out;
}

export function parseCodeInfo(raw: string): CodeInfo {
  const info: CodeInfo = { lang: '', title: '', highlight: [], lineNumbers: null, lineStart: 1, collapse: null };
  const s = raw.length > 1000 ? raw.slice(0, 1000) : raw;
  let i = 0;
  let first = true;
  while (i < s.length) {
    while (i < s.length && isSpace(s[i])) i++;
    if (i >= s.length) break;
    if (s[i] === '{') {
      const end = s.indexOf('}', i + 1);
      const body = end < 0 ? s.slice(i + 1) : s.slice(i + 1, end);
      info.highlight.push(...parseRanges(body).slice(0, MAX_RANGES - info.highlight.length));
      i = end < 0 ? s.length : end + 1;
      first = false;
      continue;
    }
    // A word, possibly key=value with a quoted value
    const start = i;
    while (i < s.length && !isSpace(s[i]) && s[i] !== '=' && s[i] !== '{') i++;
    const key = s.slice(start, i);
    let value: string | null = null;
    if (s[i] === '=') {
      i++;
      const q = s[i];
      if (q === '"' || q === "'") {
        const end = s.indexOf(q, i + 1);
        value = end < 0 ? s.slice(i + 1) : s.slice(i + 1, end);
        i = end < 0 ? s.length : end + 1;
      } else {
        const vStart = i;
        while (i < s.length && !isSpace(s[i])) i++;
        value = s.slice(vStart, i);
      }
    }
    const k = key.toLowerCase();
    if (value !== null) {
      if (k === 'title' || k === 'filename' || k === 'file') info.title = value.trim().slice(0, MAX_TITLE);
      else if (k === 'showlinenumbers' || k === 'linenumbers') {
        const n = Number(value);
        info.lineNumbers = true;
        if (Number.isInteger(n) && n >= 0 && n <= MAX_LINE) info.lineStart = n;
      }
    } else if (k === 'showlinenumbers' || k === 'linenumbers') info.lineNumbers = true;
    else if (k === 'nolinenumbers') info.lineNumbers = false;
    else if (k === 'collapse' || k === 'collapsed') info.collapse = true;
    else if (k === 'nocollapse' || k === 'expanded') info.collapse = false;
    else if (first && key) info.lang = k;
    first = false;
  }
  return info;
}

/** Whether 1-based code line `n` is in one of the highlighted ranges */
export function isHighlightedLine(info: Pick<CodeInfo, 'highlight'>, n: number): boolean {
  for (const [a, b] of info.highlight) if (n >= a && n <= b) return true;
  return false;
}
