/*
 * Comments on text passages (#68): a thread is anchored to the passage it was written on by the quoted text and a
 * little text around it, so it finds the passage again after edits elsewhere (like remote cursors). Comments are
 * not part of the note: they never reach exports or public links.
 */

export interface CommentAnchor {
  /** The commented text */
  quote: string;
  /** Text right before and after it, to tell repeated passages apart */
  prefix: string;
  suffix: string;
  /** Offset of the passage when the thread was written (a hint where to look first) */
  pos: number;
}

export interface NoteComment {
  id: string;
  /** Username; null when the account is gone */
  author: string | null;
  authorAvatar?: string | null;
  text: string;
  at: number;
  editedAt?: number;
}

export interface CommentThread {
  id: string;
  noteId: string;
  anchor: CommentAnchor;
  resolved: boolean;
  resolvedBy?: string | null;
  resolvedAt?: number;
  createdAt: number;
  comments: NoteComment[];
}

export interface CommentThreadList {
  threads: CommentThread[];
}

export const MAX_COMMENT_LENGTH = 4000;
export const MAX_QUOTE_LENGTH = 1000;
const CONTEXT = 32;
/** Occurrences of the quote compared at most (a very short quote in a long note) */
const MAX_CANDIDATES = 2000;

/** The anchor of the passage [from, to) of `doc` */
export function makeAnchor(doc: string, from: number, to: number): CommentAnchor {
  const a = Math.max(0, Math.min(from, to, doc.length));
  const b = Math.min(doc.length, Math.max(from, to), a + MAX_QUOTE_LENGTH);
  return { quote: doc.slice(a, b), prefix: doc.slice(Math.max(0, a - CONTEXT), a), suffix: doc.slice(b, b + CONTEXT), pos: a };
}

/** Characters two strings share at their end */
function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** Characters two strings share at their start */
function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * Where the anchored passage is in `doc` now: the occurrence of the quote whose surroundings match best (nearest
 * to the old position on a tie). When the quote itself was changed, the passage between the old surroundings
 * stands in for it (`exact` false); null when nothing of it is left.
 */
export function resolveAnchor(doc: string, anchor: CommentAnchor): { from: number; to: number; exact: boolean } | null {
  const { quote, prefix, suffix, pos } = anchor;
  if (quote) {
    let best: { from: number; score: number; dist: number } | null = null;
    let count = 0;
    for (let i = doc.indexOf(quote); i >= 0 && count < MAX_CANDIDATES; i = doc.indexOf(quote, i + 1), count++) {
      const score = commonSuffix(doc.slice(Math.max(0, i - prefix.length), i), prefix) + commonPrefix(doc.slice(i + quote.length, i + quote.length + suffix.length), suffix);
      const dist = Math.abs(i - pos);
      if (!best || score > best.score || (score === best.score && dist < best.dist)) best = { from: i, score, dist };
    }
    if (best) return { from: best.from, to: best.from + quote.length, exact: true };
  }
  // The quote was edited: what lies between its old neighbours, if both are still there and close together
  if (prefix.length >= 8 && suffix.length >= 8) {
    let start = -1;
    let bestDist = Infinity;
    let count = 0;
    for (let i = doc.indexOf(prefix); i >= 0 && count < MAX_CANDIDATES; i = doc.indexOf(prefix, i + 1), count++) {
      const dist = Math.abs(i + prefix.length - pos);
      if (dist < bestDist) {
        bestDist = dist;
        start = i + prefix.length;
      }
    }
    if (start >= 0) {
      const end = doc.indexOf(suffix, start);
      if (end >= start && end - start <= Math.max(quote.length * 2, 200)) return { from: start, to: end, exact: false };
    }
  }
  return null;
}
