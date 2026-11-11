/**
 * Three-way merge (like `git merge-file`, without markers) for notes edited on several devices or by several
 * people at once: both sides' changes against their common base are applied. Changes in different lines merge
 * line by line; changes in the same line (a Markdown paragraph is one line) are retried word by word.
 */

/** One replaced range of the base: `base[start..end)` becomes `lines` */
interface Hunk {
  start: number;
  end: number;
  items: string[];
  side: 0 | 1;
}

/** Above this many table cells a hunk is taken as fully replaced instead of computing an LCS */
const MAX_CELLS = 4_000_000;

/** Hunks that turn `a` into `b` (common prefix/suffix trimmed, LCS in the middle) */
function hunks(a: string[], b: string[], side: 0 | 1): Hunk[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0 || n * m > MAX_CELLS) return [{ start, end: endA, items: b.slice(start, endB), side }];
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[start + i] === b[start + j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const out: Hunk[] = [];
  let cur: Hunk | null = null;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) {
      cur = null;
      i++;
      j++;
      continue;
    }
    if (!cur) out.push((cur = { start: start + i, end: start + i, items: [], side }));
    if (j < m && (i === n || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) {
      cur.items.push(b[start + j]);
      j++;
    } else {
      cur.end++;
      i++;
    }
  }
  return out;
}

/** The side's version of `base[from..to)` with the given hunks (all inside the range) applied */
function applyHunks(base: string[], from: number, to: number, list: Hunk[]): string[] {
  const out: string[] = [];
  let pos = from;
  for (const h of list) {
    out.push(...base.slice(pos, h.start), ...h.items);
    pos = h.end;
  }
  out.push(...base.slice(pos, to));
  return out;
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

interface SeqMerge {
  items: string[];
  conflicts: number;
}

type Resolve = (base: string[], ours: string[], theirs: string[]) => SeqMerge;

function mergeSeq(base: string[], ours: string[], theirs: string[], resolve: Resolve): SeqMerge {
  const all = [...hunks(base, ours, 0), ...hunks(base, theirs, 1)].sort((x, y) => x.start - y.start || x.end - y.end);
  const items: string[] = [];
  let conflicts = 0;
  let pos = 0;
  let k = 0;
  while (k < all.length) {
    // A group: hunks whose base ranges overlap (or insert at the same spot)
    const group = [all[k]];
    let end = all[k].end;
    k++;
    while (k < all.length) {
      const next = all[k];
      // Overlapping ranges, or both sides inserting/changing at the same spot
      if (next.start < end || next.start === group[0].start) {
        group.push(next);
        end = Math.max(end, next.end);
        k++;
      } else break;
    }
    const start = group[0].start;
    items.push(...base.slice(pos, start));
    const mine = group.filter((h) => h.side === 0);
    const other = group.filter((h) => h.side === 1);
    if (!other.length) items.push(...applyHunks(base, start, end, mine));
    else if (!mine.length) items.push(...applyHunks(base, start, end, other));
    else {
      const a = applyHunks(base, start, end, mine);
      const b = applyHunks(base, start, end, other);
      if (same(a, b)) items.push(...a);
      else {
        const r = resolve(base.slice(start, end), a, b);
        items.push(...r.items);
        conflicts += r.conflicts;
      }
    }
    pos = end;
  }
  items.push(...base.slice(pos));
  return { items, conflicts };
}

/** Words, runs of whitespace and single other characters (the tokens rejoin to the exact text) */
const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;
const tokens = (s: string) => s.match(TOKEN) ?? [];

/** Both sides changed the same words: keep both (ours first) so no text is lost */
const keepBoth: Resolve = (_base, ours, theirs) => ({ items: [...ours, ...theirs], conflicts: 1 });

const wordLevel: Resolve = (base, ours, theirs) => {
  const r = mergeSeq(tokens(base.join('\n')), tokens(ours.join('\n')), tokens(theirs.join('\n')), (b, o, t) =>
    // Overlapping word edits: both versions side by side, separated so they stay readable
    keepBoth(b, o, [...(o.length && t.length ? [' '] : []), ...t])
  );
  return { items: [r.items.join('')], conflicts: r.conflicts };
};

export interface MergeResult {
  /** The merged text; where both sides changed the same words, both versions are kept (ours first) */
  text: string;
  /** False when such overlapping changes were found */
  clean: boolean;
}

/** Merges the changes `ours` and `theirs` made to `base` */
export function merge3(base: string, ours: string, theirs: string): MergeResult {
  if (ours === theirs || theirs === base) return { text: ours, clean: true };
  if (ours === base) return { text: theirs, clean: true };
  const r = mergeSeq(base.split('\n'), ours.split('\n'), theirs.split('\n'), wordLevel);
  return { text: r.items.join('\n'), clean: r.conflicts === 0 };
}

/** A minimal set of replacements turning `a` into `b` (line hunks, trimmed to the changed characters) */
export function textChanges(a: string, b: string): { from: number; to: number; insert: string }[] {
  if (a === b) return [];
  // Every line keeps its newline (both texts get a final one), so line ranges are exact character ranges
  const withNl = (s: string) => (s + '\n').split('\n').slice(0, -1).map((l) => `${l}\n`);
  const linesA = withNl(a);
  const offsets: number[] = [0];
  for (const l of linesA) offsets.push(offsets[offsets.length - 1] + l.length);
  const ext = `${a}\n`;
  return hunks(linesA, withNl(b), 0).map((h) => {
    let from = offsets[h.start];
    let to = offsets[h.end];
    let insert = h.items.join('');
    let p = 0;
    while (p < insert.length && from + p < to && ext[from + p] === insert[p]) p++;
    let s = 0;
    while (s < insert.length - p && to - s > from + p && ext[to - 1 - s] === insert[insert.length - 1 - s]) s++;
    from += p;
    to -= s;
    insert = insert.slice(p, insert.length - s);
    // The change reaches the added final newline: express it on the real text
    if (to > a.length) {
      if (insert) {
        insert = insert.slice(0, -1);
        if (from > a.length) {
          from = a.length;
          insert = `\n${insert}`;
        }
      } else from = Math.max(0, from - 1);
      to = a.length;
    }
    return { from, to, insert };
  });
}
