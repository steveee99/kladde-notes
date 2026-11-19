import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

/*
 * Comment highlights (#68): the passages that have open comment threads are marked in the note; a click on one
 * opens its thread. The note view resolves the anchors and sends the ranges; edits move them along.
 */

export interface CommentRange {
  from: number;
  to: number;
  threadId: string;
  /** The thread shown in the panel right now */
  active: boolean;
}

export const setCommentRanges = StateEffect.define<CommentRange[]>();

/** Called with the thread id when a highlighted passage is clicked (the open note view sets it) */
let onOpen: ((threadId: string) => void) | null = null;
export function onCommentOpen(fn: ((threadId: string) => void) | null) {
  onOpen = fn;
}

const field = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    let next = set.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setCommentRanges)) continue;
      const len = tr.state.doc.length;
      const ranges = e.value
        .map((r) => ({ ...r, from: Math.max(0, Math.min(r.from, len)), to: Math.max(0, Math.min(r.to, len)) }))
        .filter((r) => r.to > r.from)
        .sort((a, b) => a.from - b.from || a.to - b.to);
      next = Decoration.set(
        ranges.map((r) =>
          Decoration.mark({ class: r.active ? 'cm-comment cm-comment-active' : 'cm-comment', attributes: { 'data-comment-thread': r.threadId } }).range(r.from, r.to)
        ),
        true
      );
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const commentHighlights: Extension = [
  field,
  EditorView.domEventHandlers({
    click(e) {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-comment-thread]') as HTMLElement | null;
      if (!el || !onOpen) return false;
      onOpen(el.dataset.commentThread!);
      return false;
    },
  }),
];
