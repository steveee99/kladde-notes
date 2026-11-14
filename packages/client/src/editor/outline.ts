/**
 * Editor side of the outline panel (#30): live headings from the editor text, the section in view,
 * folding sections from outside the editor and moving a section as one undoable change.
 */
import { useEffect, useState } from 'react';
import { EditorView, ViewUpdate } from '@codemirror/view';
import { codeFolding, foldable, foldedRanges, foldEffect, unfoldEffect } from '@codemirror/language';
import { activeHeadingIndex, extractHeadings, moveSectionChanges, type NoteHeading } from '@kladde/shared';

const subscribers = new WeakMap<EditorView, Set<(u: ViewUpdate) => void>>();

/** Folding (no gutter: sections are folded from the outline) and the hook the outline listens on */
export const outlineSupport = [
  codeFolding({ placeholderDOM: (_view, onclick) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'cm-foldPlaceholder';
    el.textContent = '…';
    el.setAttribute('aria-label', 'Unfold');
    el.onclick = onclick;
    return el;
  } }),
  EditorView.updateListener.of((u) => subscribers.get(u.view)?.forEach((fn) => fn(u))),
];

function subscribe(view: EditorView, fn: (u: ViewUpdate) => void): () => void {
  let set = subscribers.get(view);
  if (!set) subscribers.set(view, (set = new Set()));
  set.add(fn);
  return () => set.delete(fn);
}

export interface Outline {
  headings: NoteHeading[];
  /** Index of the heading whose section is at the top of the view (-1: none) */
  active: number;
  /** `from` of every folded heading */
  folded: Set<number>;
}

function foldedHeadings(view: EditorView, headings: NoteHeading[]): Set<number> {
  const out = new Set<number>();
  const ranges = foldedRanges(view.state);
  for (const h of headings) {
    const line = view.state.doc.lineAt(h.from);
    let hit = false;
    ranges.between(line.to, line.to, (from) => {
      if (from === line.to) hit = true;
    });
    if (hit) out.add(h.from);
  }
  return out;
}

/** The element the note scrolls in (the page itself when no ancestor scrolls) */
function scrollParent(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if ((overflowY === 'auto' || overflowY === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return document.scrollingElement as HTMLElement;
}

/**
 * The position at the top of the visible part of the editor. A heading counts as reached a little below
 * the top of the scroll area, where a jump from the outline puts it (`yMargin` in NoteView's jump).
 */
function topPos(view: EditorView): number {
  const container = scrollParent(view.dom);
  const areaTop = container === document.scrollingElement ? 0 : container.getBoundingClientRect().top;
  const y = Math.max(view.documentTop, areaTop + 80) + 4;
  return view.lineBlockAtHeight(y - view.documentTop).from;
}

/** Headings of the editor text, kept up to date while typing and on changes from elsewhere */
export function useOutline(view: EditorView | null, fallback: string): Outline {
  const [outline, setOutline] = useState<Outline>(() => ({ headings: extractHeadings(fallback), active: -1, folded: new Set() }));

  useEffect(() => {
    if (!view) {
      setOutline({ headings: extractHeadings(fallback), active: -1, folded: new Set() });
      return;
    }
    let frame = 0;
    let headings = extractHeadings(view.state.doc.toString());
    const compute = (docChanged: boolean) => {
      if (docChanged) headings = extractHeadings(view.state.doc.toString());
      // Scrolled to the very bottom: the last heading counts as current even if it never reaches the top
      const scroller = scrollParent(view.dom);
      const atEnd = scroller.scrollHeight > scroller.clientHeight && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
      const active = atEnd && headings.length ? activeHeadingIndex(headings, view.state.doc.length) : activeHeadingIndex(headings, topPos(view));
      const folded = foldedHeadings(view, headings);
      setOutline((prev) =>
        prev.headings === headings && prev.active === active && sameSet(prev.folded, folded) ? prev : { headings, active, folded }
      );
    };
    let pendingDoc = true;
    const schedule = (docChanged = false) => {
      pendingDoc ||= docChanged;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const d = pendingDoc;
        pendingDoc = false;
        compute(d);
      });
    };
    schedule(true);
    const unsubscribe = subscribe(view, (u) => {
      const foldChanged = u.transactions.some((tr) => tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect)));
      if (u.docChanged || u.viewportChanged || u.geometryChanged || foldChanged) schedule(u.docChanged);
    });
    const onScroll = () => schedule();
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      unsubscribe();
      document.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onScroll);
    };
    // `fallback` only matters without an editor (PDF or drawing shown instead)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, view ? '' : fallback]);

  return outline;
}

function sameSet(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** True when the heading at `from` has a section to fold */
export function canFold(view: EditorView, from: number): boolean {
  if (from > view.state.doc.length) return false;
  const line = view.state.doc.lineAt(from);
  return foldable(view.state, line.from, line.to) !== null;
}

/** Folds or unfolds the section below the heading at `from` */
export function toggleSectionFold(view: EditorView, from: number): void {
  const line = view.state.doc.lineAt(Math.min(from, view.state.doc.length));
  const existing: { from: number; to: number }[] = [];
  foldedRanges(view.state).between(line.to, line.to, (a, b) => {
    if (a === line.to) existing.push({ from: a, to: b });
  });
  if (existing.length) {
    view.dispatch({ effects: existing.map((r) => unfoldEffect.of(r)) });
    return;
  }
  const range = foldable(view.state, line.from, line.to);
  if (range) view.dispatch({ effects: foldEffect.of(range) });
}

/** Folds every section (`fold`) or opens them all */
export function setAllSectionsFolded(view: EditorView, headings: NoteHeading[], fold: boolean): void {
  if (!fold) {
    const effects: ReturnType<typeof unfoldEffect.of>[] = [];
    foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
      effects.push(unfoldEffect.of({ from, to }));
    });
    if (effects.length) view.dispatch({ effects });
    return;
  }
  // Only the outermost sections: a folded parent hides its children anyway, and nested folds would overlap
  const effects: ReturnType<typeof foldEffect.of>[] = [];
  let coveredTo = -1;
  for (const h of headings) {
    if (h.from < coveredTo) continue;
    const line = view.state.doc.lineAt(h.from);
    const range = foldable(view.state, line.from, line.to);
    if (!range) continue;
    effects.push(foldEffect.of(range));
    coveredTo = range.to;
  }
  if (effects.length) view.dispatch({ effects });
}

/** Moves the section of heading `index` in front of heading `before` (null: to the end) as one undoable change */
export function moveSection(view: EditorView, index: number, before: number | null): boolean {
  const content = view.state.doc.toString();
  const headings = extractHeadings(content);
  const changes = moveSectionChanges(content, headings, index, before);
  if (!changes) return false;
  const target = before === null ? content.length : headings[before].from;
  const moved = view.state.changes(changes);
  // The cursor goes to the moved heading (at the end, after the line break that may come in front of it)
  const pos = moved.mapPos(target, -1) + (before === null && !content.endsWith('\n') ? 1 : 0);
  view.dispatch({ changes: moved, selection: { anchor: Math.min(pos, moved.newLength) }, userEvent: 'move.section', scrollIntoView: true });
  return true;
}
