import { EditorView, WidgetType } from '@codemirror/view';
import { formatValue, parseDate, toDateString, toggleTask } from '@kladde/shared';
import { dataTable, parseMarkdownTable, stripInline } from './datatable';
import { editorHost } from './host';

/** Moves the cursor into a block so it shows its source (the "✎" button of block widgets) */
function editButton(view: EditorView, pos: () => number): HTMLElement {
  const b = document.createElement('button');
  b.className = 'wz-edit';
  b.title = 'Bearbeiten';
  b.textContent = '✎';
  b.addEventListener('mousedown', (e) => {
    e.preventDefault();
    view.dispatch({ selection: { anchor: pos() } });
    view.focus();
  });
  return b;
}

abstract class BlockWidget extends WidgetType {
  constructor(readonly src: string) {
    super();
  }
  ignoreEvent() {
    return true;
  }
  protected frame(view: EditorView, inner: HTMLElement): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'wz-block';
    wrap.append(inner);
    if (view.state.facet(EditorView.editable)) {
      wrap.append(editButton(view, () => view.posAtDOM(wrap)));
    }
    return wrap;
  }
}

export class TableWidget extends BlockWidget {
  eq(other: TableWidget) {
    return other.src === this.src;
  }
  toDOM(view: EditorView) {
    const t = parseMarkdownTable(this.src);
    if (!t) return document.createElement('div');
    return this.frame(
      view,
      dataTable(
        t.headers,
        t.rows.map((r) => ({ cells: r, keys: r.map(stripInline) })),
        { align: t.align, onWiki: (w) => editorHost.openWiki(w) }
      )
    );
  }
}

export class QueryWidget extends BlockWidget {
  constructor(
    src: string,
    readonly stamp: number
  ) {
    super(src);
  }
  eq(other: QueryWidget) {
    return other.src === this.src && other.stamp === this.stamp;
  }
  toDOM(view: EditorView) {
    const result = editorHost.runQuery(this.src);
    if ('error' in result) {
      const err = document.createElement('div');
      err.className = 'cm-block-widget wz-query-error';
      err.textContent = `Abfrage-Fehler: ${result.error}`;
      return this.frame(view, err);
    }
    const isTasks = result.query.mode === 'tasks';
    const rows = result.rows.map((row) => {
      const cells: (string | Node)[] = result.columns.map((col, i) => {
        const v = row.values[col];
        if (i === 0) {
          const wrap = document.createElement('span');
          if (isTasks) {
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.className = 'cm-checkbox';
            box.checked = !!row.values.done;
            box.addEventListener('change', () => editorHost.toggleTask(row.noteId, row.line!));
            wrap.append(box);
          }
          const a = document.createElement('a');
          a.className = 'cm-link';
          a.textContent = formatValue(v) || '(ohne Titel)';
          a.addEventListener('click', (e) => {
            e.preventDefault();
            editorHost.openNote(row.noteId);
          });
          wrap.append(a);
          return wrap;
        }
        return formatValue(v);
      });
      return { cells, keys: result.columns.map((c) => (typeof row.values[c] === 'number' ? String(row.values[c]).padStart(15, '0') : formatValue(row.values[c]))) };
    });
    const label = { title: 'Titel', updated: 'Geändert', created: 'Erstellt', folder: 'Ordner', tags: 'Tags', text: 'Aufgabe', due: 'Fällig', note: 'Notiz' } as Record<string, string>;
    return this.frame(view, dataTable(result.columns.map((c) => label[c] ?? c), rows, { caption: `⚡ ${result.query.mode.toUpperCase()}` }));
  }
}

export class GalleryWidget extends BlockWidget {
  eq(other: GalleryWidget) {
    return other.src === this.src;
  }
  toDOM(view: EditorView) {
    const grid = document.createElement('div');
    grid.className = 'cm-block-widget wz-gallery';
    const urls = [...this.src.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)|^(https?:\/\/\S+|\/api\/files\/\S+)$/gm)].map((m) => m[1] ?? m[2]);
    for (const url of urls) {
      const img = document.createElement('img');
      img.src = url;
      img.loading = 'lazy';
      img.addEventListener('click', () => openLightbox(url));
      grid.append(img);
    }
    return this.frame(view, grid);
  }
}

export function openLightbox(url: string) {
  const box = document.createElement('div');
  box.className = 'wz-lightbox anim-fade-in';
  const img = document.createElement('img');
  img.src = url;
  img.className = 'anim-pop';
  box.append(img);
  box.addEventListener('click', () => box.remove());
  document.body.append(box);
}

export class CodeHeaderWidget extends WidgetType {
  constructor(
    readonly lang: string,
    readonly code: string
  ) {
    super();
  }
  eq(other: CodeHeaderWidget) {
    return other.lang === this.lang && other.code === this.code;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-code-header';
    const lang = document.createElement('span');
    lang.textContent = this.lang || 'code';
    const copy = document.createElement('button');
    copy.textContent = 'Kopieren';
    copy.addEventListener('mousedown', (e) => {
      e.preventDefault();
      void navigator.clipboard?.writeText(this.code).then(() => {
        copy.textContent = 'Kopiert ✓';
        setTimeout(() => (copy.textContent = 'Kopieren'), 1200);
      });
    });
    el.append(lang, copy);
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

export class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly line: number
  ) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.line === this.line;
  }
  toDOM(view: EditorView) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-checkbox';
    box.checked = this.checked;
    box.disabled = !view.state.facet(EditorView.editable);
    box.addEventListener('mousedown', (e) => e.preventDefault());
    box.addEventListener('click', (e) => {
      e.preventDefault();
      toggleLine(view, this.line);
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

/** Ticks a task with the shared logic (repeating tasks get their next occurrence) as one minimal change */
export function toggleLine(view: EditorView, lineIndex: number) {
  const doc = view.state.doc;
  const oldLines = doc.toString().split('\n');
  const newLines = toggleTask(doc.toString(), lineIndex).split('\n');
  const added = newLines.length - oldLines.length;
  const line = doc.line(lineIndex + 1);
  view.dispatch({ changes: { from: line.from, to: line.to, insert: newLines.slice(lineIndex, lineIndex + 1 + added).join('\n') } });
}

export class LinkWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly url: string
  ) {
    super();
  }
  eq(o: LinkWidget) {
    return o.text === this.text && o.url === this.url;
  }
  toDOM() {
    const a = document.createElement('a');
    a.className = 'cm-link';
    a.textContent = stripInline(this.text) || this.url;
    a.href = this.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.addEventListener('mousedown', (e) => e.preventDefault());
    return a;
  }
  ignoreEvent() {
    return true;
  }
}

export class WikiWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly alias: string | null
  ) {
    super();
  }
  eq(o: WikiWidget) {
    return o.target === this.target && o.alias === this.alias;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = `cm-wikilink${editorHost.wikiExists(this.target) ? '' : ' cm-missing'}`;
    s.textContent = this.alias ?? this.target;
    s.title = this.target;
    s.addEventListener('mousedown', (e) => {
      e.preventDefault();
      editorHost.openWiki(this.target);
    });
    return s;
  }
  ignoreEvent() {
    return true;
  }
}

export class ImageWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly alt: string
  ) {
    super();
  }
  eq(o: ImageWidget) {
    return o.url === this.url;
  }
  toDOM() {
    if (/\.pdf($|\?)/i.test(this.url) || /\.pdf$/i.test(this.alt)) {
      const wrap = document.createElement('div');
      wrap.className = 'cm-block-widget';
      const obj = document.createElement('iframe');
      obj.className = 'cm-pdf';
      obj.src = this.url;
      obj.title = this.alt || 'PDF';
      const link = document.createElement('a');
      link.href = this.url;
      link.target = '_blank';
      link.className = 'cm-link text-sm';
      link.textContent = `📄 ${this.alt || 'PDF öffnen'}`;
      wrap.append(link, obj);
      return wrap;
    }
    const img = document.createElement('img');
    img.className = 'cm-img';
    img.src = this.url;
    img.alt = this.alt;
    img.loading = 'lazy';
    img.addEventListener('click', () => openLightbox(this.url));
    return img;
  }
  ignoreEvent() {
    return true;
  }
}

export class DueWidget extends WidgetType {
  constructor(
    readonly date: string,
    readonly kind: 'due' | 'repeat'
  ) {
    super();
  }
  eq(o: DueWidget) {
    return o.date === this.date && o.kind === this.kind;
  }
  toDOM() {
    const s = document.createElement('span');
    if (this.kind === 'repeat') {
      s.className = 'cm-due';
      s.textContent = `🔁 ${this.date}`;
      return s;
    }
    const today = toDateString(new Date());
    s.className = `cm-due${this.date < today ? ' overdue' : this.date === today ? ' today' : ''}`;
    s.textContent = `📅 ${formatDue(this.date)}`;
    return s;
  }
}

export function formatDue(date: string): string {
  const d = parseDate(date);
  const today = parseDate(toDateString(new Date()));
  const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  if (diff === 0) return 'Heute';
  if (diff === 1) return 'Morgen';
  if (diff === -1) return 'Gestern';
  if (diff > 1 && diff < 7) return d.toLocaleDateString('de-DE', { weekday: 'long' });
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}

export class SimpleWidget extends WidgetType {
  constructor(readonly kind: 'hr' | 'bullet') {
    super();
  }
  eq(o: SimpleWidget) {
    return o.kind === this.kind;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = this.kind === 'hr' ? 'cm-hr' : 'cm-bullet';
    if (this.kind === 'bullet') s.textContent = '•';
    return s;
  }
}
