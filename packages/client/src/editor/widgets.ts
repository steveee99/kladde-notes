import { EditorView, WidgetType } from '@codemirror/view';
import {
  PROJECT_STATUSES,
  ZETTEL_TYPES,
  formatValue,
  insertTableColumn,
  insertTableRow,
  parseDate,
  removeTableColumn,
  removeTableRow,
  safeUrl,
  serializeMarkdownTable,
  setFrontmatter,
  setTableCell,
  setTaskStatus,
  TASK_STATUSES,
  toDateString,
  toggleTask,
  type MarkdownTable,
  type NoteHeading,
  type QueryResult,
  type TaskStatus,
} from '@kladde/shared';
import { getLang, locale, tl, type Lang } from '../lib/i18n';
import { dataTable, openTableCell, parseMarkdownTable, stripInline, type CellRef, type TableEditing } from './datatable';
import { editorHost } from './host';
import { embedContext } from './embedContext';
import { DiagramKind, drawDiagram, openDiagram } from './diagram';

/** Moves the cursor into a block so it shows its source (the "✎" button of block widgets) */
export function editButton(view: EditorView, pos: () => number, lang: Lang): HTMLElement {
  const b = document.createElement('button');
  b.className = 'wz-edit';
  b.title = tl(lang, 'common.edit');
  b.textContent = '✎';
  b.addEventListener('mousedown', (e) => {
    e.preventDefault();
    view.dispatch({ selection: { anchor: pos() } });
    view.focus();
  });
  return b;
}

abstract class BlockWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly lang: Lang = getLang()
  ) {
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
      wrap.append(editButton(view, () => view.posAtDOM(wrap), this.lang));
    }
    return wrap;
  }
}

export class TableWidget extends BlockWidget {
  constructor(
    src: string,
    lang: Lang = getLang(),
    readonly canEdit = false
  ) {
    super(src, lang);
  }
  eq(other: TableWidget) {
    return other.src === this.src && other.lang === this.lang && other.canEdit === this.canEdit;
  }
  toDOM(view: EditorView) {
    const t = parseMarkdownTable(this.src);
    if (!t) return document.createElement('div');
    let frame: HTMLElement | null = null;
    /** Rewrites this table in the document; reopens a cell editor in the rebuilt widget when asked */
    const apply = (next: MarkdownTable, focus?: CellRef) => {
      if (!frame) return;
      const from = view.posAtDOM(frame);
      const to = from + this.src.length;
      if (view.state.sliceDoc(from, to) !== this.src) return;
      view.dispatch({ changes: { from, to, insert: serializeMarkdownTable(next) }, userEvent: 'input.table' });
      if (!focus) return;
      requestAnimationFrame(() => {
        for (const el of view.dom.querySelectorAll<HTMLElement>('.wz-block')) {
          const table = el.querySelector('.wz-table-editable');
          if (table && view.posAtDOM(el) === from) {
            openTableCell(table, focus);
            break;
          }
        }
      });
    };
    const edit: TableEditing | undefined =
      this.canEdit && view.state.facet(EditorView.editable) && !view.state.readOnly
        ? {
            setCell: (cell, value, focus) => {
              const next = setTableCell(t, cell.row, cell.col, value);
              apply(focus && focus.row >= next.rows.length ? insertTableRow(next) : next, focus);
            },
            insertColumn: (at) => apply(insertTableColumn(t, at), { row: -1, col: Math.max(0, Math.min(at, t.headers.length)) }),
            removeColumn: (at) => apply(removeTableColumn(t, at)),
            addRow: (focus) => apply(insertTableRow(t), focus ?? { row: t.rows.length, col: 0 }),
            removeRow: (row) => apply(removeTableRow(t, row)),
          }
        : undefined;
    frame = this.frame(
      view,
      dataTable(
        t.headers,
        t.rows.map((r) => ({ cells: r, keys: r.map(stripInline), raw: r })),
        { align: t.align, onWiki: (w) => editorHost.openWiki(w), edit }
      )
    );
    return frame;
  }
}

export class TocWidget extends BlockWidget {
  readonly key: string;
  constructor(
    src: string,
    readonly headings: NoteHeading[],
    lang: Lang = getLang()
  ) {
    super(src, lang);
    this.key = headings.map((h) => `${h.level}:${h.line}:${h.from}:${h.text}`).join('\n');
  }
  eq(other: TocWidget) {
    return other.src === this.src && other.key === this.key && other.lang === this.lang;
  }
  toDOM(view: EditorView) {
    const box = document.createElement('div');
    box.className = 'cm-block-widget wz-toc';

    const head = document.createElement('div');
    head.className = 'wz-toc-head';
    head.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/></svg>';
    const title = document.createElement('span');
    title.textContent = tl(this.lang, 'editor.tocWidgetTitle');
    head.append(title);
    box.append(head);

    if (!this.headings.length) {
      const empty = document.createElement('div');
      empty.className = 'wz-toc-empty';
      empty.textContent = tl(this.lang, 'editor.tocWidgetEmpty');
      box.append(empty);
      return this.frame(view, box);
    }

    const list = document.createElement('div');
    list.className = 'wz-toc-list';
    const minLevel = Math.min(...this.headings.map((h) => h.level));
    for (const h of this.headings) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wz-toc-item';
      const depth = Math.max(0, Math.min(4, h.level - minLevel));
      btn.style.paddingLeft = `${10 + depth * 16}px`;
      btn.title = tl(this.lang, 'note.tocJumpHint', { text: h.text });

      const bullet = document.createElement('span');
      bullet.className = 'text-on-surface-variant text-xs shrink-0';
      bullet.textContent = depth === 0 ? '•' : '◦';

      const textSpan = document.createElement('span');
      textSpan.className = depth === 0 ? 'font-medium truncate' : 'truncate';
      textSpan.textContent = h.text;

      btn.append(bullet, textSpan);
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const pos = Math.min(h.from, view.state.doc.length);
        view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 72 }) });
      });
      list.append(btn);
    }
    box.append(list);
    return this.frame(view, box);
  }
}

export class QueryWidget extends BlockWidget {
  constructor(
    src: string,
    readonly stamp: number,
    readonly locked = false,
    lang: Lang = getLang()
  ) {
    super(src, lang);
  }
  eq(other: QueryWidget) {
    return other.src === this.src && other.stamp === this.stamp && other.locked === this.locked && other.lang === this.lang;
  }
  toDOM(view: EditorView) {
    const result = editorHost.runQuery(this.src);
    if ('error' in result) {
      const err = document.createElement('div');
      err.className = 'cm-block-widget wz-query-error';
      err.textContent = tl(this.lang, 'editor.queryError', { error: result.error });
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
          a.textContent = formatValue(v) || `(${tl(this.lang, 'common.unnamed').toLowerCase()})`;
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
    const label = {
      title: tl(this.lang, 'list.colTitle'),
      updated: tl(this.lang, 'list.colUpdated'),
      created: tl(this.lang, 'list.colCreated'),
      folder: tl(this.lang, 'list.colFolder'),
      tags: tl(this.lang, 'list.colTags'),
      text: tl(this.lang, 'quick.taskBtn'),
      due: this.lang === 'en' ? 'Due' : 'Fällig',
      note: this.lang === 'en' ? 'Note' : 'Notiz',
    } as Record<string, string>;
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
      head.textContent = lane.value || (this.lang === 'en' ? `No ${field}` : `Ohne ${field}`);
      const n = document.createElement('span');
      n.textContent = String(lane.rows.length);
      head.append(n);
      col.append(head);
      for (const row of lane.rows) {
        const card = document.createElement('div');
        card.className = 'wz-card';
        card.draggable = !this.locked;
        card.textContent = formatValue(row.values.title) || `(${tl(this.lang, 'common.unnamed').toLowerCase()})`;
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
    if (!result.lanes!.length) board.textContent = tl(this.lang, 'nav.listEmpty');
    void view;
    return board;
  }
}

export class GalleryWidget extends BlockWidget {
  eq(other: GalleryWidget) {
    return other.src === this.src && other.lang === this.lang;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('div');
    wrap.className = 'cm-block-widget wz-gallery-wrap';
    const grid = document.createElement('div');
    grid.className = 'wz-gallery';
    for (const { url, alt } of blockImages(this.src)) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = alt;
      img.loading = 'lazy';
      img.addEventListener('click', () => openLightbox(url));
      grid.append(img);
    }
    wrap.append(grid);
    return this.frame(view, wrap);
  }
}

/** Images of a ```gallery / ```carousel block: one per line, as ![alt](url) or a bare URL */
function blockImages(src: string): { url: string; alt: string }[] {
  return [...src.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)|^\s*(https?:\/\/\S+|\/api\/files\/\S+)\s*$/gm)]
    .map((m) => ({ url: safeUrl(m[2] ?? m[3], 'media', true), alt: m[1] ?? '' }))
    .filter((i): i is { url: string; alt: string } => i.url !== null);
}

const chevron = (d: string) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;

/** ```carousel: Material 3 hero carousel (horizontal, snapping, large item + peek, label from the alt text) */
export class CarouselWidget extends BlockWidget {
  eq(other: CarouselWidget) {
    return other.src === this.src && other.lang === this.lang;
  }
  toDOM(view: EditorView) {
    const box = document.createElement('div');
    box.className = 'cm-block-widget wz-carousel';
    box.setAttribute('role', 'region');
    box.setAttribute('aria-roledescription', 'carousel');
    const track = document.createElement('div');
    track.className = 'wz-carousel-track';
    track.tabIndex = 0;
    for (const { url, alt } of blockImages(this.src)) {
      const item = document.createElement('figure');
      item.className = 'wz-carousel-item';
      const img = document.createElement('img');
      img.src = url;
      img.alt = alt;
      img.loading = 'lazy';
      img.draggable = false;
      // Portrait images stay portrait: the card takes the image's aspect ratio instead of cropping it
      img.addEventListener('load', () => {
        if (img.naturalHeight > img.naturalWidth * 1.05) {
          item.classList.add('is-portrait');
          item.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
        }
      });
      item.append(img);
      if (alt) item.append(Object.assign(document.createElement('figcaption'), { textContent: alt }));
      item.addEventListener('click', () => openLightbox(url));
      track.append(item);
    }
    const nav = (dir: -1 | 1) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `wz-carousel-nav ${dir < 0 ? 'prev' : 'next'}`;
      btn.setAttribute('aria-label', tl(this.lang, dir < 0 ? 'editor.carouselPrev' : 'editor.carouselNext'));
      btn.innerHTML = chevron(dir < 0 ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6');
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => {
        const step = (track.firstElementChild as HTMLElement | null)?.offsetWidth ?? track.clientWidth;
        track.scrollBy({ left: dir * (step + 8), behavior: 'smooth' });
      });
      return btn;
    };
    const prev = nav(-1);
    const next = nav(1);
    const sync = () => {
      prev.disabled = track.scrollLeft <= 2;
      next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 2;
    };
    track.addEventListener('scroll', sync, { passive: true });
    requestAnimationFrame(sync);
    box.append(prev, track, next);
    return this.frame(view, box);
  }
}

/** ```mermaid and ```mindmap blocks; click opens the diagram full screen */
export class DiagramWidget extends BlockWidget {
  constructor(
    readonly kind: DiagramKind,
    src: string,
    lang: Lang = getLang()
  ) {
    super(src, lang);
  }
  eq(other: DiagramWidget) {
    return other.kind === this.kind && other.src === this.src && other.lang === this.lang;
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
  if (!safeUrl(url, 'media', true)) return;
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
    readonly code: string,
    readonly uiLang: Lang = getLang()
  ) {
    super();
  }
  eq(other: CodeHeaderWidget) {
    return other.lang === this.lang && other.code === this.code && other.uiLang === this.uiLang;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-code-header';
    const lang = document.createElement('span');
    lang.textContent = this.lang || 'code';
    const copy = document.createElement('button');
    copy.textContent = tl(this.uiLang, 'editor.codeCopy');
    copy.addEventListener('mousedown', (e) => {
      e.preventDefault();
      void navigator.clipboard?.writeText(this.code).then(() => {
        copy.textContent = tl(this.uiLang, 'editor.codeCopied');
        setTimeout(() => (copy.textContent = tl(this.uiLang, 'editor.codeCopy')), 1200);
      });
    });
    el.append(lang, copy);
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

/**
 * Task checkbox: [ ] open, [O] in progress, [H] blocked, [x] done. A click finishes the task (or reopens a
 * done one); the context menu (right click / long press) picks any status.
 */
export class CheckboxWidget extends WidgetType {
  constructor(
    readonly status: TaskStatus,
    readonly line: number,
    readonly locked = false,
    readonly lang: Lang = getLang()
  ) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.status === this.status && other.line === this.line && other.locked === this.locked && other.lang === this.lang;
  }
  toDOM(view: EditorView) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-checkbox';
    box.dataset.status = this.status;
    box.checked = this.status === 'done';
    box.disabled = this.locked;
    box.title = tl(this.lang, `task.status.${this.status}`);
    box.addEventListener('mousedown', (e) => e.preventDefault());
    box.addEventListener('click', (e) => {
      e.preventDefault();
      if (!view.state.readOnly) {
        toggleLine(view, this.line);
        return;
      }
      // Inside an embed: the task lives in the embedded note, so the change goes there
      const source = view.state.facet(embedContext).source;
      if (source?.canWrite) editorHost.toggleTask(source.noteId, source.startLine + this.line);
    });
    box.addEventListener('contextmenu', (e) => {
      if (view.state.readOnly) return;
      e.preventDefault();
      openStatusMenu(box, this.status, this.lang, (status) => setLineStatus(view, this.line, status));
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

/** Small menu below `anchor` to pick a task status */
export function openStatusMenu(anchor: HTMLElement, current: TaskStatus, lang: Lang, pick: (status: TaskStatus) => void) {
  document.querySelector('.wz-status-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'wz-status-menu card';
  menu.setAttribute('role', 'menu');
  const close = () => {
    menu.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const outside = (e: Event) => {
    if (!menu.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  for (const status of TASK_STATUSES) {
    const item = document.createElement('button');
    item.type = 'button';
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(status === current));
    const dot = document.createElement('span');
    dot.className = 'cm-checkbox';
    dot.dataset.status = status;
    const label = document.createElement('span');
    label.textContent = tl(lang, `task.status.${status}`);
    item.append(dot, label);
    item.addEventListener('mousedown', (e) => e.preventDefault());
    item.addEventListener('click', () => {
      close();
      if (status !== current) pick(status);
    });
    menu.append(item);
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  menu.style.top = `${r.bottom + 6 + h > window.innerHeight - 8 ? Math.max(8, r.top - 6 - h) : r.bottom + 6}px`;
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', onKey, true);
}

/** Rewrites the status of the task in `lineIndex` as one minimal change */
function setLineStatus(view: EditorView, lineIndex: number, status: TaskStatus) {
  const doc = view.state.doc;
  const oldLines = doc.toString().split('\n');
  const newLines = setTaskStatus(doc.toString(), lineIndex, status).split('\n');
  const added = newLines.length - oldLines.length;
  const line = doc.line(lineIndex + 1);
  view.dispatch({ changes: { from: line.from, to: line.to, insert: newLines.slice(lineIndex, lineIndex + 1 + added).join('\n') } });
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

function externalUrl(url: string): URL | null {
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** "github.com/user/repo" instead of the full URL; long paths are cut by CSS */
function shortUrl(url: URL): string {
  const host = url.hostname.replace(/^www\./, '');
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep it encoded
  }
  return host + path.replace(/\/$/, '');
}

const GLOBE_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
/** Origins whose favicon failed (offline, none): they get the globe right away instead of flickering */
const missingIcons = new Set<string>();

/** The site's own /favicon.ico (no third-party icon service sees the note's links), a globe as fallback */
function siteIcon(url: URL): HTMLElement {
  const box = document.createElement('span');
  box.className = 'cm-link-pill-icon';
  box.setAttribute('aria-hidden', 'true');
  if (missingIcons.has(url.origin)) {
    box.innerHTML = GLOBE_ICON;
    return box;
  }
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.src = `${url.origin}/favicon.ico`;
  img.onerror = () => {
    missingIcons.add(url.origin);
    box.innerHTML = GLOBE_ICON;
  };
  box.append(img);
  return box;
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
    const href = safeUrl(this.url);
    if (!href) {
      // javascript:, data: and other schemes never become a clickable link (stored XSS through shared notes)
      const s = document.createElement('span');
      s.className = 'cm-link cm-link-blocked';
      s.textContent = stripInline(this.text) || this.url;
      s.title = this.url;
      return s;
    }
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.addEventListener('mousedown', (e) => e.preventDefault());
    const external = externalUrl(this.url);
    if (!external) {
      a.className = 'cm-link';
      a.textContent = stripInline(this.text) || this.url;
      return a;
    }
    // External links are pills: site icon + link text (or a short form of the URL)
    a.className = 'cm-link-pill';
    a.title = this.url;
    a.append(siteIcon(external), Object.assign(document.createElement('span'), { className: 'cm-link-pill-text', textContent: stripInline(this.text).trim() || shortUrl(external) }));
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
    readonly defPos: number | null,
    readonly lang: Lang = getLang()
  ) {
    super();
  }
  eq(o: FootnoteRefWidget) {
    return o.label === this.label && o.number === this.number && o.text === this.text && o.defPos === this.defPos && o.lang === this.lang;
  }
  toDOM(view: EditorView) {
    const s = document.createElement('sup');
    s.className = `cm-footnote-ref${this.defPos === null ? ' cm-missing' : ''}`;
    s.textContent = String(this.number);
    s.title = this.defPos === null ? tl(this.lang, 'editor.footnoteMissingTitle', { id: this.label }) : this.text;
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
    readonly to: number,
    readonly lang: Lang = getLang()
  ) {
    super();
  }

  eq(o: AutoLinkWidget) {
    return o.target === this.target && o.original === this.original && o.from === this.from && o.to === this.to && o.lang === this.lang;
  }

  toDOM(view: EditorView) {
    const s = document.createElement('span');
    s.className = 'cm-autolink cm-autolink-widget';
    s.title = this.lang === 'en' ? `Note “${this.target}” (click to open)` : `Notiz „${this.target}“ (Klick zum Öffnen)`;

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
      btn.title = tl(this.lang, 'editor.autolinkTitle', { target: this.target });
      btn.setAttribute('aria-label', tl(this.lang, 'editor.autolinkTitle', { target: this.target }));
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
    readonly alt: string,
    readonly lang: Lang = getLang()
  ) {
    super();
  }
  eq(o: ImageWidget) {
    return o.url === this.url && o.alt === this.alt && o.lang === this.lang;
  }
  toDOM() {
    const isPdf = /\.pdf($|\?)/i.test(this.url) || /\.pdf$/i.test(this.alt);
    // Only http(s) and relative URLs reach src/href: a javascript: URL in an iframe would run in the app's origin
    const src = safeUrl(this.url, 'media', !isPdf);
    if (!src) {
      const s = document.createElement('span');
      s.className = 'cm-link cm-link-blocked';
      s.textContent = this.alt || this.url;
      s.title = this.url;
      return s;
    }
    if (isPdf) {
      const wrap = document.createElement('div');
      wrap.className = 'cm-block-widget';
      const obj = document.createElement('iframe');
      obj.className = 'cm-pdf';
      obj.src = src;
      obj.title = this.alt || 'PDF';
      const link = document.createElement('a');
      link.href = src;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'cm-link text-sm';
      link.textContent = `📄 ${this.alt || (this.lang === 'en' ? 'Open PDF' : 'PDF öffnen')}`;
      wrap.append(link, obj);
      return wrap;
    }
    const img = document.createElement('img');
    img.className = 'cm-img';
    img.src = src;
    img.alt = this.alt;
    img.loading = 'lazy';
    img.addEventListener('click', () => openLightbox(src));
    return img;
  }
  ignoreEvent() {
    return true;
  }
}

export class DueWidget extends WidgetType {
  constructor(
    readonly date: string,
    readonly kind: 'due' | 'repeat' | 'time',
    readonly lang: Lang = getLang()
  ) {
    super();
  }
  eq(o: DueWidget) {
    return o.date === this.date && o.kind === this.kind && o.lang === this.lang;
  }
  toDOM() {
    const s = document.createElement('span');
    if (this.kind === 'repeat' || this.kind === 'time') {
      s.className = 'cm-due';
      s.textContent = `${this.kind === 'repeat' ? '🔁' : '⏰'} ${this.date}`;
      return s;
    }
    const today = toDateString(new Date());
    s.className = `cm-due${this.date < today ? ' overdue' : this.date === today ? ' today' : ''}`;
    s.textContent = `📅 ${formatDue(this.date, this.lang)}`;
    return s;
  }
}

export function formatDue(date: string, lang: Lang = getLang()): string {
  const d = parseDate(date);
  const today = parseDate(toDateString(new Date()));
  const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  if (diff === 0) return tl(lang, 'home.taskToday');
  if (diff === 1) return tl(lang, 'home.taskTomorrow');
  if (diff === -1) return lang === 'en' ? 'Yesterday' : 'Gestern';
  const loc = locale(lang);
  if (diff > 1 && diff < 7) return d.toLocaleDateString(loc, { weekday: 'long' });
  return d.toLocaleDateString(loc, { day: 'numeric', month: 'short', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
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

/** A ligature shown in place of its characters (-> as →); the text itself stays unchanged */
export class LigatureWidget extends WidgetType {
  constructor(readonly char: string) {
    super();
  }
  eq(o: LigatureWidget) {
    return o.char === this.char;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-ligature';
    s.textContent = this.char;
    return s;
  }
}

/** Property whose value input should get focus once the widget is rebuilt (after adding a property) */
let pendingPropFocus: string | null = null;

/** Sets frontmatter properties of the note in `view` (null removes one) as one small change */
export function applyFrontmatter(view: EditorView, updates: Record<string, string | null>, focusKey?: string) {
  const current = view.state.doc.toString();
  const next = setFrontmatter(current, updates);
  if (next === current) return;
  let start = 0;
  while (start < current.length && start < next.length && current[start] === next[start]) start++;
  let endA = current.length;
  let endB = next.length;
  while (endA > start && endB > start && current[endA - 1] === next[endB - 1]) {
    endA--;
    endB--;
  }
  if (focusKey) pendingPropFocus = focusKey;
  view.dispatch({ changes: { from: start, to: endA, insert: next.slice(start, endB) }, userEvent: 'input.frontmatter' });
}

/** Suggested values for well-known keys */
const PROP_SUGGESTIONS: Record<string, string[]> = {
  status: [...PROJECT_STATUSES],
  typ: ZETTEL_TYPES.map((z) => z.id),
};

const PROP_KEY = /^[\p{L}\p{N}_][\p{L}\p{N}_ -]*$/u;

/**
 * Frontmatter as a compact row of properties (shown when the cursor is outside it). In editable notes
 * every simple `key: value` line gets an input, a remove button and there is a button to add one;
 * a click on the empty area opens the raw YAML.
 */
export class PropertiesWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly lang: Lang = getLang(),
    readonly canEdit = false
  ) {
    super();
  }
  eq(o: PropertiesWidget) {
    return o.src === this.src && o.lang === this.lang && o.canEdit === this.canEdit;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('div');
    wrap.className = 'wz-props';
    const editable = this.canEdit && view.state.facet(EditorView.editable) && !view.state.readOnly;
    const lines = this.src.split('\n');
    const stop = (el: HTMLElement) => el.addEventListener('mousedown', (e) => e.stopPropagation());
    let focusTarget: HTMLInputElement | null = null;
    lines.forEach((line, i) => {
      const m = /^([^:\s][^:]*):\s*(.*)$/.exec(line);
      if (!m) return;
      const key = m[1].trim();
      // YAML lists/blocks on the following lines: shown, but only editable as raw text
      const block: string[] = [];
      for (let j = i + 1; j < lines.length && /^\s+\S|^-\s/.test(lines[j]); j++) block.push(lines[j].replace(/^\s*-?\s*/, ''));
      const value = m[2].trim();
      const item = document.createElement('span');
      item.className = 'wz-prop';
      const k = document.createElement('span');
      k.className = 'wz-prop-key';
      k.textContent = key;
      item.append(k);
      if (editable && !block.length) {
        const input = document.createElement('input');
        input.className = 'wz-prop-value wz-prop-input';
        input.value = value;
        input.placeholder = '—';
        input.size = Math.max(4, Math.min(value.length + 1, 40));
        input.setAttribute('aria-label', key);
        input.spellcheck = false;
        const suggestions = PROP_SUGGESTIONS[key.toLowerCase()];
        if (suggestions) {
          const list = document.createElement('datalist');
          list.id = `wz-prop-${key.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`;
          for (const sug of suggestions) list.append(new Option(sug, sug));
          input.setAttribute('list', list.id);
          item.append(list);
        }
        stop(input);
        input.addEventListener('input', () => (input.size = Math.max(4, Math.min(input.value.length + 1, 40))));
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            input.blur();
          } else if (e.key === 'Escape') {
            input.value = value;
            input.blur();
          }
        });
        input.addEventListener('change', () => {
          if (input.value.trim() !== value) applyFrontmatter(view, { [key]: input.value.trim() });
        });
        item.append(input);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'wz-prop-remove';
        remove.textContent = '×';
        remove.title = tl(this.lang, 'editor.propertyRemove', { key });
        remove.setAttribute('aria-label', remove.title);
        remove.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        remove.addEventListener('click', () => applyFrontmatter(view, { [key]: null }));
        item.append(remove);
        if (pendingPropFocus === key) focusTarget = input;
      } else {
        const v = document.createElement('span');
        v.className = 'wz-prop-value';
        v.textContent = (block.length ? block.join(', ') : value) || '—';
        item.append(v);
      }
      wrap.append(item);
    });
    if (editable) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'wz-prop-add';
      add.textContent = `+ ${tl(this.lang, 'editor.propertyAdd')}`;
      add.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      add.addEventListener('click', () => {
        const input = document.createElement('input');
        input.className = 'wz-prop-input wz-prop-new';
        input.placeholder = tl(this.lang, 'editor.propertyName');
        input.setAttribute('aria-label', tl(this.lang, 'editor.propertyName'));
        input.spellcheck = false;
        stop(input);
        const commit = () => {
          const key = input.value.trim().replace(/:+$/, '');
          if (key && PROP_KEY.test(key)) applyFrontmatter(view, { [key]: '' }, key);
          else input.replaceWith(add);
        };
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') input.replaceWith(add);
        });
        input.addEventListener('blur', () => input.isConnected && commit());
        add.replaceWith(input);
        input.focus();
      });
      wrap.append(add);
    }
    if (focusTarget) {
      pendingPropFocus = null;
      const target: HTMLInputElement = focusTarget;
      requestAnimationFrame(() => target.focus());
    }
    if (view.state.facet(EditorView.editable)) {
      wrap.title = tl(this.lang, 'editor.propertiesLabel');
      wrap.addEventListener('mousedown', (e) => {
        if (e.target !== wrap) return;
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
