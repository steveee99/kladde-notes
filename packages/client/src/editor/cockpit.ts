import { EditorView, WidgetType } from '@codemirror/view';
import { tl, type Lang } from '../lib/i18n';
import { editorHost } from './host';
import { variablesFacet } from './variables';
import { editButton } from './widgets';

/**
 * A ```cockpit block (development cockpit) rendered as a live widget. The editor only makes the frame; the app mounts
 * the widget into it (`editorHost.mountCockpit`, React) with the note's variables and properties, and unmounts it when
 * the block is redrawn or leaves the view.
 */
/** The unmount of each mounted block, by its element (CodeMirror may destroy a DOM through an equal, newer widget) */
const mounted = new WeakMap<HTMLElement, () => void>();

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
    const mount = editorHost.mountCockpit;
    if (mount) mounted.set(wrap, mount(host, this.src, view.state.doc.toString(), view.state.facet(variablesFacet)));
    else {
      host.className = 'cm-block-widget wz-query-error';
      host.textContent = tl(this.lang, 'cockpit.blockOff');
    }
    if (view.state.facet(EditorView.editable)) wrap.append(editButton(view, () => view.posAtDOM(wrap), this.lang));
    return wrap;
  }

  destroy(dom: HTMLElement) {
    mounted.get(dom)?.();
    mounted.delete(dom);
  }
}
