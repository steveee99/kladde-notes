import { EditorView, WidgetType } from '@codemirror/view';
import type { Text } from '@codemirror/state';
import { tl, type Lang } from '../lib/i18n';
import { editorHost } from './host';
import { variablesFacet } from './variables';
import { editButton } from './widgets';

/**
 * A ```cockpit block (development cockpit) rendered as a live widget. The editor only makes the frame; the app mounts
 * the widget into it (`editorHost.mountCockpit`, React) with the note's variables and properties, and unmounts it when
 * the block is redrawn or leaves the view. The widget's settings button opens the cockpit's widget editor
 * (`editorHost.editCockpit`), whose result replaces the block; /cockpit opens the same editor for a new block.
 */
/** The unmount of each mounted block, by its element (CodeMirror may destroy a DOM through an equal, newer widget) */
const mounted = new WeakMap<HTMLElement, () => void>();

/** The fenced block whose opening fence is on the line at `pos`: from the opening line to the end of the closing one */
export function fencedBlockAt(doc: Text, pos: number): { from: number; to: number } | null {
  const first = doc.lineAt(Math.min(pos, doc.length));
  const fence = /^\s*(`{3,}|~{3,})/.exec(first.text)?.[1];
  if (!fence) return null;
  const close = new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`);
  for (let n = first.number + 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (close.test(line.text)) return { from: first.from, to: line.to };
  }
  return { from: first.from, to: doc.length };
}

/** Puts a block on its own lines at `pos` (blank lines around it where text follows or precedes) */
export function insertBlock(view: EditorView, pos: number, block: string) {
  const doc = view.state.doc;
  const line = doc.lineAt(Math.min(pos, doc.length));
  const at = Math.min(pos, doc.length);
  const before = doc.sliceString(line.from, at).trim() ? '\n' : '';
  const after = doc.sliceString(at, line.to).trim() ? '\n' : '';
  const insert = `${before}${block}\n${after}`;
  view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length - after.length }, userEvent: 'input' });
  view.focus();
}

/** /cockpit: the widget editor for a new block at `pos` */
export function newCockpitBlock(view: EditorView, pos: number) {
  editorHost.editCockpit(null, view.state.doc.toString(), view.state.facet(variablesFacet), (block) => insertBlock(view, pos, block));
}

export class CockpitBlockWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly lang: Lang
  ) {
    super();
  }

  eq(o: CockpitBlockWidget) {
    return o.src === this.src && o.lang === this.lang;
  }

  get estimatedHeight() {
    return 180;
  }

  ignoreEvent() {
    return true;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement('div');
    wrap.className = 'wz-block cm-cockpit-block';
    wrap.setAttribute('data-cockpit-block', '');
    const host = document.createElement('div');
    // Clicks act inside the widget (links, refresh); editing goes through the edit button
    host.addEventListener('mousedown', (e) => {
      if (!(e.target as HTMLElement).closest('input, textarea, select')) e.stopPropagation();
    });
    wrap.append(host);
    const editable = view.state.facet(EditorView.editable);
    const configure = () => {
      const range = fencedBlockAt(view.state.doc, view.posAtDOM(wrap));
      if (!range) return;
      const original = view.state.doc.sliceString(range.from, range.to);
      editorHost.editCockpit(this.src, view.state.doc.toString(), view.state.facet(variablesFacet), (block) => {
        // The note may have changed while the dialog was open: the block where it was, else where its text is now
        const doc = view.state.doc;
        const from = doc.sliceString(range.from, range.to) === original ? range.from : doc.toString().indexOf(original);
        if (from < 0) return insertBlock(view, Math.min(range.from, doc.length), block);
        view.dispatch({ changes: { from, to: from + original.length, insert: block }, userEvent: 'input' });
      });
    };
    const mount = editorHost.mountCockpit;
    if (mount) mounted.set(wrap, mount(host, this.src, view.state.doc.toString(), view.state.facet(variablesFacet), editable ? configure : undefined));
    else {
      host.className = 'cm-block-widget wz-query-error';
      host.textContent = tl(this.lang, 'cockpit.blockOff');
    }
    if (editable) wrap.append(editButton(view, () => view.posAtDOM(wrap), this.lang));
    return wrap;
  }

  destroy(dom: HTMLElement) {
    mounted.get(dom)?.();
    mounted.delete(dom);
  }
}
