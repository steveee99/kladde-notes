import { EditorView, WidgetType } from '@codemirror/view';
import { formatValue, parseDate, toDateString, toggleTask } from '@kladde/shared';
import type { QueryResult } from '@kladde/shared';
import { dataTable, parseMarkdownTable, stripInline } from './datatable';
import { editorHost } from './host';
import { DiagramKind, drawDiagram, openDiagram } from './diagram';

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
    readonly stamp: number,
    readonly locked = false
  ) {
    super(src);
  }
  eq(other: QueryWidget) {
    return other.src === this.src && other.stamp === this.stamp && other.locked === this.locked;
  }
  toDOM(view: EditorView) {
    const result = editorHost.runQuery(this.src);
    if ('error' in result) {
      const err = document.createElement('div');
      err.className = 'cm-block-widget wz-query-error';
      err.textContent = `Abfrage-Fehler: ${result.error}`;
      return this.frame(view, err);
    }
    if (result.lanes) return this.frame(view, this.kanban(result, view));
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
            box.disabled = this.locked;
            box.addEventListener('change', () => editorHost.toggleTask(row.noteId, row.line!));
            wrap.append(box);
            // Double click on a task opens the note it comes from, at its line
            wrap.addEventListener('dblclick', (e) => {
              if (e.target === box) return;
              e.preventDefault();
              editorHost.openTask(row.noteId, row.line!);
            });
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

  /** KANBAN: one lane per value of the status field; dragging a card to another lane rewrites the field */
  private kanban(result: QueryResult, view: EditorView): HTMLElement {
    const field = result.query.groupBy!;
    const board = document.createElement('div');
    board.className = 'cm-block-widget wz-kanban scrollbar-thin';
    for (const lane of result.lanes!) {
      const col = document.createElement('div');
      col.className = 'wz-lane';
      const head = document.createElement('div');
      head.className = 'wz-lane-head';
      head.textContent = lane.value || `Ohne ${field}`;
      const n = document.createElement('span');
      n.textContent = String(lane.rows.length);
      head.append(n);
      col.append(head);
      for (const row of lane.rows) {
        const card = document.createElement('div');
        card.className = 'wz-card';
        card.draggable = !this.locked;
        card.textContent = formatValue(row.values.title) || '(ohne Titel)';
        card.addEventListener('click', () => editorHost.openNote(row.noteId));
        card.addEventListener('dragstart', (e) => {
          e.dataTransfer?.setData('application/x-kladde-card', row.noteId);
          card.classList.add('dragging');
        });
        card.addEventListener('dragend', () => card.classList.remove('dragging'));
        col.append(card);
      }
      if (!this.locked) {
        col.addEventListener('dragover', (e) => {
          if (e.dataTransfer?.types.includes('application/x-kladde-card')) {
            e.preventDefault();
            col.classList.add('over');
          }
        });
        col.addEventListener('dragleave', () => col.classList.remove('over'));
        col.addEventListener('drop', (e) => {
          col.classList.remove('over');
          const id = e.dataTransfer?.getData('application/x-kladde-card');
          if (!id) return;
          e.preventDefault();
          if (!lane.rows.some((r) => r.noteId === id)) editorHost.setFrontmatter(id, { [field]: lane.value || null });
        });
      }
      board.append(col);
    }
    if (!result.lanes!.length) board.textContent = 'Keine Notizen.';
    void view;
    return board;
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

/** ```mermaid and ```mindmap blocks; click opens the diagram full screen */
export class DiagramWidget extends BlockWidget {
  constructor(
    readonly kind: DiagramKind,
    src: string
  ) {
    super(src);
  }
  eq(other: DiagramWidget) {
    return other.kind === this.kind && other.src === this.src;
  }
  get estimatedHeight() {
    return 240;
  }
  toDOM(view: EditorView) {
    const box = document.createElement('div');
    box.className = 'cm-block-widget wz-diagram';
    box.addEventListener('click', () => {
      const svg = box.querySelector('svg');
      if (svg) openDiagram(svg.outerHTML);
    });
    drawDiagram(box, this.kind, this.src, () => view.requestMeasure());
    return this.frame(view, box);
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
    readonly line: number,
    readonly locked = false
  ) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.line === this.line && other.locked === this.locked;
  }
  toDOM(view: EditorView) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-checkbox';
    box.checked = this.checked;
    box.disabled = this.locked;
    box.addEventListener('mousedown', (e) => e.preventDefault());
    box.addEventListener('click', (e) => {
      e.preventDefault();
      if (!view.state.readOnly) toggleLine(view, this.line);
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

/** Footnote reference [^1] as a superscript number; hover shows the text, click jumps to the definition */
export class FootnoteRefWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly number: number,
    readonly text: string,
    readonly defPos: number | null
  ) {
    super();
  }
  eq(o: FootnoteRefWidget) {
    return o.label === this.label && o.number === this.number && o.text === this.text && o.defPos === this.defPos;
  }
  toDOM(view: EditorView) {
    const s = document.createElement('sup');
    s.className = `cm-footnote-ref${this.defPos === null ? ' cm-missing' : ''}`;
    s.textContent = String(this.number);
    s.title = this.defPos === null ? `Fußnote „${this.label}“ ist nicht definiert` : this.text;
    s.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (this.defPos === null) return;
      view.dispatch({ effects: EditorView.scrollIntoView(this.defPos, { y: 'center' }) });
    });
    return s;
  }
  ignoreEvent() {
    return true;
  }
}

/** Label of a footnote definition line "[^1]:" shown as "1." */
export class FootnoteDefWidget extends WidgetType {
  constructor(readonly number: number) {
    super();
  }
  eq(o: FootnoteDefWidget) {
    return o.number === this.number;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-footnote-def-label';
    s.textContent = `${this.number}.`;
    return s;
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

export class AutoLinkWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly original: string,
    readonly from: number,
    readonly to: number
  ) {
    super();
  }

  eq(o: AutoLinkWidget) {
    return o.target === this.target && o.original === this.original && o.from === this.from && o.to === this.to;
  }

  toDOM(view: EditorView) {
    const s = document.createElement('span');
    s.className = 'cm-autolink cm-autolink-widget';
    s.title = `Notiz „${this.target}“ (Klick zum Öffnen)`;

    const text = document.createElement('span');
    text.className = 'cm-autolink-text';
    text.textContent = this.original;
    text.addEventListener('mousedown', (e) => {
      e.preventDefault();
      editorHost.openWiki(this.target);
    });
    s.append(text);

    if (view.state.facet(EditorView.editable)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cm-autolink-btn';
      btn.title = `Als [[${this.target}]] verlinken`;
      btn.setAttribute('aria-label', `Als [[${this.target}]] verlinken`);
      btn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>`;

      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        let from = this.from;
        try {
          const pos = view.posAtDOM(s);
          if (pos >= 0) from = pos;
        } catch {
          // fallback to this.from
        }
        const to = from + this.original.length;
        const link = this.original === this.target ? `[[${this.target}]]` : `[[${this.target}|${this.original}]]`;
        view.dispatch({
          changes: { from, to, insert: link },
          userEvent: 'input',
        });
      });
      s.append(btn);
    }

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

/** Frontmatter as a compact row of properties (shown when the cursor is outside it) */
export class PropertiesWidget extends WidgetType {
  constructor(readonly src: string) {
    super();
  }
  eq(o: PropertiesWidget) {
    return o.src === this.src;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('div');
    wrap.className = 'wz-props';
    for (const line of this.src.split('\n')) {
      const m = /^([^:]+):\s*(.*)$/.exec(line);
      if (!m) continue;
      const item = document.createElement('span');
      item.className = 'wz-prop';
      const k = document.createElement('span');
      k.className = 'wz-prop-key';
      k.textContent = m[1].trim();
      const v = document.createElement('span');
      v.className = 'wz-prop-value';
      v.textContent = m[2].trim() || '—';
      item.append(k, v);
      wrap.append(item);
    }
    if (view.state.facet(EditorView.editable)) {
      wrap.title = 'Eigenschaften bearbeiten';
      wrap.addEventListener('mousedown', (e) => {
        e.preventDefault();
        view.dispatch({ selection: { anchor: 4 } });
        view.focus();
      });
    }
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}
