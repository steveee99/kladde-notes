/** Writing statistics for the status line under a note: words, characters and reading time */

export interface WritingStats {
  words: number;
  /** Characters including spaces, without line breaks */
  chars: number;
  /** Reading time in whole minutes (at least 1 for a non-empty text) */
  minutes: number;
}

/** Average silent reading speed used for the reading time */
export const WORDS_PER_MINUTE = 200;

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
// A word holds at least one letter or digit; Markdown markers (#, -, >, |, **) do not count
const WORD_RE = /[\p{L}\p{N}]/u;

/**
 * Removes what does not count as prose: the frontmatter at the top and fenced code blocks
 * (``` or ~~~, an unclosed fence runs to the end of the note).
 */
export function proseOf(content: string): string {
  const body = content.replace(FRONTMATTER_RE, '');
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && /^\s{0,3}[`~]+\s*$/.test(line)) fence = null;
      continue;
    }
    if (m) {
      fence = m[1];
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** Number of words in a plain text */
export function countWords(text: string): number {
  let n = 0;
  for (const token of text.split(/\s+/)) if (token && WORD_RE.test(token)) n++;
  return n;
}

/** Statistics of a note: frontmatter and code blocks are not counted */
export function writingStats(content: string): WritingStats {
  const prose = proseOf(content).trim();
  const words = countWords(prose);
  const chars = prose.replace(/\r?\n/g, '').length;
  const minutes = words ? Math.max(1, Math.round(words / WORDS_PER_MINUTE)) : 0;
  return { words, chars, minutes };
}
