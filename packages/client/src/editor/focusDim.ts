import { RangeSetBuilder, type Extension, type Text } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';

/*
 * Focus mode "dim other paragraphs": every line outside the paragraph with the cursor fades out (CSS in
 * index.css, `.cm-focus-dim`). A paragraph is the run of non-empty lines around the cursor. Only line
 * decorations, so it stays separate from the live preview's StateField. Block widgets (tables, diagrams,
 * embeds …) are not lines and take no line decoration: the plugin sets the class on their DOM itself when
 * they lie in the current paragraph, and CSS keeps a widget bright while something inside it has focus
 * (e.g. a table cell being edited).
 */

const current = Decoration.line({ class: 'cm-focus-current' });
const blank = /^\s*$/;
const markKey = {};

/** First and last line number of the paragraph around `line` (a blank line is its own paragraph) */
export function paragraphAt(doc: Text, line: number): { from: number; to: number } {
  if (blank.test(doc.line(line).text)) return { from: line, to: line };
  let from = line;
  let to = line;
  while (from > 1 && !blank.test(doc.line(from - 1).text)) from--;
  while (to < doc.lines && !blank.test(doc.line(to + 1).text)) to++;
  return { from, to };
}

function build(view: EditorView): DecorationSet {
  const { doc } = view.state;
  const { from, to } = paragraphAt(doc, doc.lineAt(view.state.selection.main.head).number);
  const builder = new RangeSetBuilder<Decoration>();
  // Only lines in the viewport need the class; a long paragraph is not walked in full
  const vpFrom = Math.max(from, doc.lineAt(view.viewport.from).number);
  const vpTo = Math.min(to, doc.lineAt(view.viewport.to).number);
  for (let n = vpFrom; n <= vpTo; n++) {
    const pos = doc.line(n).from;
    builder.add(pos, pos, current);
  }
  return builder.finish();
}

/** Marks the block widgets that belong to the paragraph with the cursor (mutations inside widgets are ignored by CodeMirror) */
function markBlocks(view: EditorView): void {
  const { doc } = view.state;
  const { from, to } = paragraphAt(doc, doc.lineAt(view.state.selection.main.head).number);
  const start = doc.line(from).from;
  const end = doc.line(to).to;
  for (const el of Array.from(view.contentDOM.children)) {
    if (!(el instanceof HTMLElement) || el.classList.contains('cm-line')) continue;
    let pos: number;
    try {
      pos = view.posAtDOM(el);
    } catch {
      continue;
    }
    el.classList.toggle('cm-focus-current', pos >= start && pos <= end);
  }
}

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
      view.requestMeasure({ read: () => null, write: (_m, v) => markBlocks(v) });
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = build(u.view);
      // Widgets are (re)drawn with the update: mark them once the DOM is in place
      u.view.requestMeasure({ key: markKey, read: () => null, write: (_m, v) => markBlocks(v) });
    }
  },
  { decorations: (p) => p.decorations }
);

export const focusDim: Extension = [plugin, EditorView.editorAttributes.of({ class: 'cm-focus-dim' })];
