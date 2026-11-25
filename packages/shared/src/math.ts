/**
 * Math formulas (#85): inline `$…$` and display `$$…$$` in Markdown, rendered with KaTeX by the client.
 * Rules as in Pandoc: an opening `$` must be followed by a non-space character, a closing `$` must follow a
 * non-space character and must not be followed by a digit, so prices ("$5 and $10") stay text. `\$` is a
 * plain dollar sign. Nothing in code (fenced blocks, `inline code`) is math.
 */

/** Inline math in a line of text: `$$…$$` (display style) or `$…$`; group 1 is display TeX, group 2 inline TeX */
export const INLINE_MATH_SOURCE = String.raw`(?<![\\$])\$\$(?=\S)([^$\n]*?\S)\$\$(?!\$)|(?<![\\$])\$(?=[^\s$])([^$\n]*?[^\s\\$])\$(?![$\d])`;

export interface MathSpan {
  /** Offsets in the scanned text */
  from: number;
  to: number;
  tex: string;
  /** Display style (`$$`) */
  display: boolean;
  /** A display formula on lines of its own (rendered as a block) */
  block: boolean;
}

/**
 * `inline code` spans of a line: a run of backticks up to the next run of the same length. A linear scan
 * (a backreference regex is polynomial on many backticks, CodeQL ReDoS).
 */
export function codeSpans(line: string): [number, number][] {
  if (!line.includes('`')) return [];
  // Runs of backticks with their start and length
  const runs: [number, number][] = [];
  for (let i = 0; i < line.length; ) {
    if (line[i] !== '`') {
      i++;
      continue;
    }
    const start = i;
    while (i < line.length && line[i] === '`') i++;
    runs.push([start, i - start]);
  }
  const spans: [number, number][] = [];
  // The next unused run of each length after a position: one pass from the end
  const nextOfLength = new Map<number, number[]>();
  runs.forEach(([, len], k) => {
    const list = nextOfLength.get(len);
    if (list) list.push(k);
    else nextOfLength.set(len, [k]);
  });
  const cursor = new Map<number, number>();
  for (let k = 0; k < runs.length; k++) {
    const [start, len] = runs[k];
    const list = nextOfLength.get(len)!;
    let c = cursor.get(len) ?? 0;
    while (c < list.length && list[c] <= k) c++;
    cursor.set(len, c);
    if (c >= list.length) continue;
    const close = list[c];
    spans.push([start, runs[close][0] + len]);
    cursor.set(len, c + 1);
    k = close;
  }
  return spans;
}

/** The inline formulas of one line, outside `inline code` */
export function findInlineMath(line: string, offset = 0): MathSpan[] {
  if (!line.includes('$')) return [];
  const code = codeSpans(line);
  const out: MathSpan[] = [];
  for (const m of line.matchAll(new RegExp(INLINE_MATH_SOURCE, 'g'))) {
    const from = m.index!;
    const to = from + m[0].length;
    if (code.some(([a, b]) => from < b && to > a)) continue;
    const display = m[1] !== undefined;
    out.push({ from: offset + from, to: offset + to, tex: (m[1] ?? m[2]).trim(), display, block: false });
  }
  return out;
}

const FENCE = /^\s*(`{3,}|~{3,})/;
/** A line that opens a display block: `$$` (maybe with TeX after it) */
const BLOCK_OPEN = /^\s{0,3}\$\$(?!\$)/;

/**
 * All formulas of a Markdown text with their offsets: display blocks (`$$` on its own line up to the next line
 * ending in `$$`, or `$$…$$` alone on a line) and inline formulas; fenced code and inline code are skipped.
 * `start` skips a leading part (frontmatter).
 */
export function findMath(text: string, start = 0): MathSpan[] {
  if (!text.includes('$')) return [];
  const out: MathSpan[] = [];
  const lines = text.split('\n');
  let pos = 0;
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineFrom = pos;
    pos += line.length + 1;
    if (lineFrom + line.length < start) continue;
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && /^\s*[`~]+\s*$/.test(line)) fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }
    if (!line.includes('$')) continue;
    const trimmed = line.trim();
    // `$$ … $$` alone on its line
    const single = /^\$\$(?!\$)([\s\S]+?)\$\$$/.exec(trimmed);
    if (single && single[1].trim()) {
      out.push({ from: lineFrom, to: lineFrom + line.length, tex: single[1].trim(), display: true, block: true });
      continue;
    }
    if (BLOCK_OPEN.test(line)) {
      // Up to the next line that ends in `$$`; a blank line or the end means it was no formula
      let end = -1;
      for (let j = i + 1; j < lines.length && j <= i + 500; j++) {
        if (!lines[j].trim()) break;
        if (/\$\$\s*$/.test(lines[j])) {
          end = j;
          break;
        }
      }
      if (end > 0) {
        const body = [trimmed.slice(2), ...lines.slice(i + 1, end), lines[end].replace(/\$\$\s*$/, '')].join('\n').trim();
        let to = pos - 1;
        for (let j = i + 1; j <= end; j++) to += lines[j].length + 1;
        if (body) out.push({ from: lineFrom, to, tex: body, display: true, block: true });
        for (let j = i + 1; j <= end; j++) pos += lines[j].length + 1;
        i = end;
        continue;
      }
    }
    out.push(...findInlineMath(line, lineFrom));
  }
  return out;
}

/** Whether a text contains a formula at all (to load KaTeX only for notes that need it) */
export function hasMath(text: string): boolean {
  return text.includes('$') && findMath(text).length > 0;
}
