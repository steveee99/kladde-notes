/**
 * The outline of a note (headings as sections): which section a position is in, where a section ends,
 * and the text changes that move a whole section (with its subsections) somewhere else.
 */
import type { NoteHeading } from './markdown.js';

/** Index of the heading whose section contains `pos` (-1 before the first heading) */
export function activeHeadingIndex(headings: NoteHeading[], pos: number): number {
  let active = -1;
  for (let i = 0; i < headings.length && headings[i].from <= pos; i++) active = i;
  return active;
}

/** End of the section that heading `index` starts: the next heading of the same or a higher level, else the end */
export function sectionEnd(headings: NoteHeading[], index: number, docLength: number): number {
  const level = headings[index].level;
  for (let j = index + 1; j < headings.length; j++) if (headings[j].level <= level) return headings[j].from;
  return docLength;
}

/** Index after the last subsection of heading `index` (the section is `index .. result - 1`) */
export function sectionLastIndex(headings: NoteHeading[], index: number): number {
  const level = headings[index].level;
  let j = index + 1;
  while (j < headings.length && headings[j].level > level) j++;
  return j;
}

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/**
 * Changes (positions in the current text, as CodeMirror takes them in one transaction) that move the
 * section of heading `index` with its subsections in front of heading `before`, or to the end of the
 * note when `before` is null. Null when the move changes nothing or would put the section into itself.
 */
export function moveSectionChanges(content: string, headings: NoteHeading[], index: number, before: number | null): TextChange[] | null {
  if (index < 0 || index >= headings.length) return null;
  const last = sectionLastIndex(headings, index);
  if (before !== null && (before < 0 || before >= headings.length)) return null;
  // Into itself, or to where it already is
  if (before !== null && before >= index && before <= last) return null;
  if (before === null && last === headings.length && sectionEnd(headings, index, content.length) === content.length) return null;

  const from = headings[index].from;
  const to = sectionEnd(headings, index, content.length);
  let text = content.slice(from, to);
  if (!text.endsWith('\n')) text += '\n';

  if (before === null) {
    // At the end (the section is not the last one, see above): the note's last line needs a line break first
    const sep = content.endsWith('\n') ? '' : '\n';
    return [
      { from, to, insert: '' },
      { from: content.length, to: content.length, insert: sep + text.replace(/\n$/, '') + (sep ? '' : '\n') },
    ];
  }

  const at = headings[before].from;
  const changes: TextChange[] = [{ from, to, insert: '' }];
  // The moved section was the last one and had no trailing line break: drop the line break before it instead
  if (to === content.length && !content.endsWith('\n') && from > 0) changes[0] = { from: from - 1, to, insert: '' };
  changes.push({ from: at, to: at, insert: text });
  return changes.sort((a, b) => a.from - b.from);
}

/** Applies changes given in positions of the original text (as `moveSectionChanges` returns them) */
export function applyTextChanges(content: string, changes: TextChange[]): string {
  let out = '';
  let pos = 0;
  for (const c of [...changes].sort((a, b) => a.from - b.from)) {
    out += content.slice(pos, c.from) + c.insert;
    pos = c.to;
  }
  return out + content.slice(pos);
}
