/**
 * Embeds (transclusion): a line `![[Note]]`, `![[Note#Heading]]` or `![[Note#^block-id]]` shows the
 * referenced note or part of it read-only inside the current note. The target is resolved like any
 * [[link]] (through `LinkIndex`), so embeds count as links and are rewritten when the note is renamed.
 */
import { cleanHeadingText, extractHeadings, parseFrontmatter } from './markdown.js';
import { sectionEnd } from './outline.js';

/** Embeds inside embeds are shown down to this depth; deeper ones only as a link */
export const MAX_EMBED_DEPTH = 3;

export interface EmbedRef {
  /** Link target as written (title, Zettel id, frontmatter id) */
  target: string;
  /** `#Heading` (the last part of `#A#B`), without the `#` */
  heading: string | null;
  /** `#^block-id`, without `#^` */
  block: string | null;
  alias: string | null;
}

/** A line that is only an embed */
const EMBED_LINE = /^\s*!\[\[([^\]|#\n]+)((?:#[^\]|\n]*)?)((?:\|[^\]\n]*)?)\]\]\s*$/;

/** Attachments (`![[photo.png]]`, Obsidian style) are not note embeds */
const FILE_EXT = /\.(?!md$)[a-z0-9]{1,5}$/i;

export function parseEmbed(target: string, fragment = '', alias = ''): EmbedRef | null {
  const t = target.trim();
  if (!t || FILE_EXT.test(t)) return null;
  const frag = fragment.replace(/^#/, '');
  const last = frag.split('#').pop()!.trim();
  const block = last.startsWith('^') ? last.slice(1).trim() || null : null;
  return {
    target: t.replace(/\.md$/i, ''),
    heading: !block && last ? last : null,
    block,
    alias: alias.replace(/^\|/, '').trim() || null,
  };
}

/** The embed on a line that holds nothing else, or null */
export function parseEmbedLine(line: string): EmbedRef | null {
  const m = EMBED_LINE.exec(line);
  return m ? parseEmbed(m[1], m[2], m[3]) : null;
}

export interface EmbedSection {
  text: string;
  /** 0-based line in the source note where `text` starts (task lines map back with it) */
  startLine: number;
}

const BLOCK_ID = (id: string) => new RegExp(`(?:^|\\s)\\^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
const depth = (s: string) => /^\s*/.exec(s)![0].replace(/\t/g, '    ').length;

/** Removes `^block-id` markers at line ends (the line count stays the same) */
export function stripBlockIds(text: string): string {
  return text.replace(/[ \t]+\^[\w-]+[ \t]*$/gm, '').replace(/^\^[\w-]+[ \t]*$/gm, '');
}

function trimLines(lines: string[], start: number): EmbedSection {
  let from = 0;
  let to = lines.length;
  while (from < to && !lines[from].trim()) from++;
  while (to > from && !lines[to - 1].trim()) to--;
  return { text: lines.slice(from, to).join('\n'), startLine: start + from };
}

/** The part of `content` an embed shows; null if the heading or block does not exist (any more) */
export function embedSection(content: string, ref: Pick<EmbedRef, 'heading' | 'block'>): EmbedSection | null {
  const lines = content.split('\n');
  if (ref.block) {
    const re = BLOCK_ID(ref.block);
    const at = lines.findIndex((l) => re.test(l));
    if (at < 0) return null;
    // "^id" alone on a line names the block above it (tables, quotes)
    if (/^\^[\w-]+\s*$/.test(lines[at].trim())) {
      let from = at - 1;
      while (from >= 0 && !lines[from].trim()) from--;
      if (from < 0) return null;
      let start = from;
      while (start > 0 && lines[start - 1].trim()) start--;
      return trimLines(lines.slice(start, from + 1), start);
    }
    if (LIST_ITEM.test(lines[at])) {
      const base = depth(lines[at]);
      let end = at + 1;
      while (end < lines.length && lines[end].trim() && depth(lines[end]) > base) end++;
      return trimLines(lines.slice(at, end), at);
    }
    let start = at;
    while (start > 0 && lines[start - 1].trim() && !/^#{1,6}\s/.test(lines[start - 1])) start--;
    let end = at + 1;
    while (end < lines.length && lines[end].trim() && !/^#{1,6}\s/.test(lines[end])) end++;
    return trimLines(lines.slice(start, end), start);
  }
  if (ref.heading) {
    const headings = extractHeadings(content);
    const wanted = cleanHeadingText(ref.heading).toLowerCase();
    const index = headings.findIndex((h) => h.text.toLowerCase() === wanted);
    if (index < 0) return null;
    const from = headings[index].from;
    const to = sectionEnd(headings, index, content.length);
    return trimLines(content.slice(from, to).split('\n'), headings[index].line - 1);
  }
  // The whole note without its frontmatter
  const { body } = parseFrontmatter(content);
  const skipped = content.length - body.length;
  const startLine = skipped ? content.slice(0, skipped).split('\n').length - 1 : 0;
  return trimLines(body.split('\n'), startLine);
}

/** Every embed line of a note (outside fenced code), for resolving them ahead (public links) */
export function embedsOf(content: string): EmbedRef[] {
  const out: EmbedRef[] = [];
  let fence = false;
  for (const line of content.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const ref = parseEmbedLine(line);
    if (ref) out.push(ref);
  }
  return out;
}
