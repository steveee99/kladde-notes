import { extractMeta, mapOutsideCode } from './markdown.js';
import { trimSlashes } from './util.js';

/**
 * Tags: `#tag` in the text and `tags:` in the frontmatter (see `extractMeta`). Tags nest with `/`:
 * `#area/health` is a child of `#area`, and a filter on a parent includes its children.
 */

/** Characters of a tag (as in `extractMeta`) */
const TAG_CHARS = '[\\p{L}\\p{N}_/-]';
const TAG_CHAR = new RegExp(`^${TAG_CHARS}$`, 'u');

/** Normalizes user input to a tag: no leading `#`, no slashes at the ends, lower case */
export function normalizeTag(input: string): string {
  // trimSlashes instead of /^\/+|\/+$/: that regex is polynomial on long runs of slashes (CodeQL ReDoS)
  return trimSlashes(input.trim().replace(/^#+/, '').replace(/\s+/g, '-').replace(/\/{2,}/g, '/')).toLowerCase();
}

/** Whether `tag` may be written as `#tag` (and is found again by `extractMeta`) */
export function isValidTag(tag: string): boolean {
  return new RegExp(`^${TAG_CHARS}+$`, 'u').test(tag) && !/^\d+$/.test(tag) && !/^\/|\/$|\/\//.test(tag);
}

/** `tag` is `filter` or nested below it (`area/health` matches `area`) */
export function tagMatches(tag: string, filter: string): boolean {
  const t = tag.toLowerCase();
  const f = normalizeTag(filter);
  return t === f || t.startsWith(`${f}/`);
}

/** The parents of a tag and the tag itself: `a/b/c` → `a`, `a/b`, `a/b/c` */
export function tagAncestors(tag: string): string[] {
  const parts = tag.split('/');
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

export interface TagNode {
  /** Full tag (`area/health`) */
  tag: string;
  /** Last segment (`health`) */
  name: string;
  /** Notes with exactly this tag */
  count: number;
  /** Notes with this tag or one nested below it */
  total: number;
  children: TagNode[];
}

export interface TagNote {
  id: string;
  path: string;
  content: string;
}

/** Ids of the notes per tag (exact tags only) */
export function notesByTag(notes: TagNote[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const n of notes) {
    for (const tag of extractMeta(n.path, n.content).tags) {
      if (!map.has(tag)) map.set(tag, []);
      map.get(tag)!.push(n.id);
    }
  }
  return map;
}

/** All tags as a tree sorted by name; parents that are never used alone still appear (count 0) */
export function buildTagTree(notes: TagNote[]): TagNode[] {
  const nodes = new Map<string, TagNode>();
  const totals = new Map<string, Set<string>>();
  const node = (tag: string) => {
    let n = nodes.get(tag);
    if (!n) {
      n = { tag, name: tag.split('/').pop()!, count: 0, total: 0, children: [] };
      nodes.set(tag, n);
    }
    return n;
  };
  for (const [tag, ids] of notesByTag(notes)) {
    node(tag).count = ids.length;
    for (const a of tagAncestors(tag)) {
      node(a);
      if (!totals.has(a)) totals.set(a, new Set());
      for (const id of ids) totals.get(a)!.add(id);
    }
  }
  const roots: TagNode[] = [];
  for (const n of nodes.values()) {
    n.total = totals.get(n.tag)?.size ?? 0;
    const i = n.tag.lastIndexOf('/');
    if (i === -1) roots.push(n);
    else node(n.tag.slice(0, i)).children.push(n);
  }
  const sort = (list: TagNode[]) => {
    list.sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }));
    for (const n of list) sort(n.children);
    return list;
  };
  return sort(roots);
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

/** New name of `tag` when `from` (and everything below it) becomes `to`, or null when it is not affected */
function renamed(tag: string, from: string, to: string): string | null {
  const t = tag.toLowerCase();
  if (t === from) return to;
  if (t.startsWith(`${from}/`)) return to + tag.slice(from.length);
  return null;
}

/**
 * Renames a tag in a note: `#from` and nested `#from/child` in the text (outside code) and in the
 * frontmatter `tags:` line. Renaming onto an existing tag merges them; duplicates in `tags:` are dropped.
 * Returns the content unchanged when the tag does not occur.
 */
export function renameTag(content: string, fromTag: string, toTag: string): string {
  const from = normalizeTag(fromTag);
  const to = normalizeTag(toTag);
  if (!from || !to || from === to) return content;
  let head = '';
  let body = content;
  const fm = FRONTMATTER.exec(content);
  if (fm) {
    head = fm[0].replace(/^(tags:)(.*)$/im, (line, key: string, value: string) => {
      const trimmed = value.trim();
      const list = trimmed.startsWith('[') && trimmed.endsWith(']');
      const items = value.replace(/[[\]]/g, '').split(',').map((x) => x.trim()).filter(Boolean);
      let changed = false;
      const seen = new Set<string>();
      const out: string[] = [];
      for (const item of items) {
        const hash = item.startsWith('#') ? '#' : '';
        const next = renamed(item.replace(/^#/, ''), from, to);
        if (next !== null) changed = true;
        const written = hash + (next ?? item.replace(/^#/, ''));
        const dedupe = written.replace(/^#/, '').toLowerCase();
        if (seen.has(dedupe)) {
          changed = true;
          continue;
        }
        seen.add(dedupe);
        out.push(written);
      }
      if (!changed) return line;
      return `${key} ${list ? `[${out.join(', ')}]` : out.join(', ')}`;
    });
    body = content.slice(fm[0].length);
  }
  const re = new RegExp(`(^|\\s)#(${TAG_CHARS}+)`, 'gu');
  body = mapOutsideCode(body, (text) =>
    text.replace(re, (all, pre: string, tag: string) => {
      const next = renamed(tag, from, to);
      return next === null ? all : `${pre}#${next}`;
    })
  );
  return head + body;
}

/**
 * Tag being typed right before the cursor (`#are|`), for autocomplete: the text after `#` and the
 * offset of the `#`. Null when the cursor is not inside a tag (headings `# ` are not tags).
 */
export function tagBeforeCursor(lineBefore: string): { query: string; from: number } | null {
  // A backwards scan instead of a regex anchored at the end, which backtracks on long lines
  let i = lineBefore.length;
  for (;;) {
    // Letters outside the BMP are surrogate pairs: test the pair, not its halves
    const step = i > 1 && /[\uDC00-\uDFFF]/.test(lineBefore[i - 1]) ? 2 : 1;
    if (i - step < 0 || !TAG_CHAR.test(lineBefore.slice(i - step, i))) break;
    i -= step;
  }
  const hash = i - 1;
  if (hash < 0 || lineBefore[hash] !== '#') return null;
  if (hash > 0 && !/\s/.test(lineBefore[hash - 1])) return null;
  return { query: lineBefore.slice(i).toLowerCase(), from: hash };
}
