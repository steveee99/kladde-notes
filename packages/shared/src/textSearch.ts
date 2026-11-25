/**
 * The search of the search overlay (Ctrl/⌘+K): every term must appear in the title, path or text; title matches come
 * first, then the most recently edited. Shared, so the server answers it the same way in online mode.
 */
import { excerpt } from './markdown.js';

export const MAX_SEARCH_RESULTS = 60;

/** Lower-cased words of the query */
export function searchTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** Notes whose title, path or text contain every term; title matches first, then the most recently edited */
export function searchNotes<N extends { path: string; content: string; updatedAt: number }>(
  notes: Iterable<N>,
  terms: string[],
  titleOf: (n: N) => string,
  max = MAX_SEARCH_RESULTS,
  textOf: (n: N) => string = (n) => n.content
): N[] {
  if (!terms.length) return [];
  const hits: { note: N; inTitle: boolean }[] = [];
  for (const note of notes) {
    const title = titleOf(note).toLowerCase();
    const hay = `${title}\n${note.path.toLowerCase()}\n${textOf(note).toLowerCase()}`;
    if (terms.every((term) => hay.includes(term))) hits.push({ note, inTitle: terms.every((term) => title.includes(term)) });
  }
  hits.sort((a, b) => (a.inTitle === b.inTitle ? b.note.updatedAt - a.note.updatedAt : a.inTitle ? -1 : 1));
  return hits.slice(0, max).map((h) => h.note);
}

/** The text around the first match (plain text without markup), or the start of the note */
export function searchSnippet(content: string, terms: string[]): string {
  const plain = excerpt(content, 4000);
  const lower = plain.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at <= 40) return plain.slice(0, 160);
  const start = plain.lastIndexOf(' ', at - 30);
  return `… ${plain.slice(start < 0 ? at - 30 : start + 1, at + 130)}`;
}
