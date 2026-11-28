import { EditorView, WidgetType } from '@codemirror/view';
import type { Lang } from '../lib/i18n';
import { fencedBlockAt } from './cockpit';
import { editorHost } from './host';
import { noteIdFacet } from './livePreview';
import { editButton } from './widgets';

/**
 * A fenced block of a build-time plugin (```` ```<id> ```` or ```` ```<id>-<name> ````, docs/PLUGINS.md). The editor
 * makes the frame; the app mounts the plugin's component into it (`editorHost.mountPluginBlock`, its own React root)
 * and unmounts it when the block is redrawn or leaves the view. `setSource` replaces the text between the fences.
 */
const mounted = new WeakMap<HTMLElement, () => void>();

export class PluginBlockWidget extends WidgetType {
  constructor(
    readonly info: string,
    readonly src: string,
    readonly lang: Lang,
    readonly height: number
  ) {
    super();
  }

  eq(o: PluginBlockWidget) {
    return o.info === this.info && o.src === this.src && o.lang === this.lang;
  }

  get estimatedHeight() {
    return this.height;
  }

  ignoreEvent() {
    return true;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement('div');
    wrap.className = 'wz-block cm-plugin-block';
    wrap.setAttribute('data-plugin-block', this.info);
    const host = document.createElement('div');
    // Clicks act inside the block; editing the text goes through the edit button
    host.addEventListener('mousedown', (e) => {
      if (!(e.target as HTMLElement).closest('input, textarea, select')) e.stopPropagation();
    });
    wrap.append(host);
    const editable = view.state.facet(EditorView.editable);
    const setSource = (next: string) => {
      const range = fencedBlockAt(view.state.doc, view.posAtDOM(wrap));
      if (!range) return;
      const doc = view.state.doc;
      const first = doc.lineAt(range.from);
      const last = doc.lineAt(range.to);
      // Between the fences; a block without closing fence gets one
      const closed = last.number > first.number && /^\s*(`{3,}|~{3,})\s*$/.test(last.text);
      const body = next.replace(/\n+$/, '');
      const inner = body ? `\n${body}\n` : '\n';
      if (closed) view.dispatch({ changes: { from: first.to, to: last.from, insert: inner }, userEvent: 'input' });
      else view.dispatch({ changes: { from: first.to, to: range.to, insert: `${inner}\`\`\`` }, userEvent: 'input' });
    };
    mounted.set(wrap, editorHost.mountPluginBlock(host, this.info, { source: this.src, noteId: view.state.facet(noteIdFacet), setSource: editable ? setSource : undefined }));
    if (editable) wrap.append(editButton(view, () => view.posAtDOM(wrap), this.lang));
    return wrap;
  }

  destroy(dom: HTMLElement) {
    mounted.get(dom)?.();
    mounted.delete(dom);
  }
}
