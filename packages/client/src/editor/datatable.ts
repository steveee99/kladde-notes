import type { VariableScope } from '@kladde/shared';
import { getLang, locale, t } from '../lib/i18n';
import { setMaskedHtml } from './variables';

/** Interactive table (sort by header click, filter field) used for Markdown tables and query results */

export interface DataRow {
  cells: (string | Node)[];
  /** Plain values for sorting and filtering */
  keys: string[];
  /** Raw Markdown per cell, shown in the cell editor */
  raw?: string[];
  /** Sort values per cell when they differ from `keys` (numbers sort as numbers) */
  sort?: (string | number | null)[];
}

/** A cell address in the source table; `row` -1 is the header row */
export interface CellRef {
  row: number;
  col: number;
}

/**
 * Editing of a Markdown table in the live preview. Every call rewrites the table in the document, so the
 * widget is rebuilt; `focus` names the cell whose editor opens again afterwards (Tab/Enter navigation).
 */
export interface TableEditing {
  setCell(cell: CellRef, value: string, focus?: CellRef): void;
  /** Without it the columns are fixed: no renaming, no column menu, no "+ column" (plugin tables) */
  insertColumn?(at: number): void;
  removeColumn?(at: number): void;
  /** Without it there is no "+ row", and Tab past the last cell stops there */
  addRow?(focus?: CellRef): void;
  /** Without it rows have no delete button */
  removeRow?(row: number): void;
  /** Whether a body cell opens an editor (default: all) */
  canEdit?(cell: CellRef): boolean;
}

const cellEditors = new WeakMap<HTMLElement, (cell: CellRef) => void>();
const disposed = new WeakSet<Element>();

/** Marks a table that is about to be replaced: an open cell editor then commits nothing when it loses focus */
export function disposeTable(wrap: Element): void {
  disposed.add(wrap);
}

/** Opens the cell editor of a table widget built by `dataTable` (keeps focus across rebuilds) */
export function openTableCell(wrap: Element, cell: CellRef): boolean {
  const open = cellEditors.get(wrap as HTMLElement);
  if (!open) return false;
  open(cell);
  return true;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Very small inline Markdown → HTML for table cells (escaped first, so it is safe); `plain` leaves [[links]] as text */
export function renderInline(text: string, plain = false): string {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code class="cm-inline-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (all, t, a) => (plain ? all : `<span class="cm-wikilink" data-wiki="${t}">${a ?? t}</span>`))
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a class="cm-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function setInline(el: HTMLElement, text: string, variables?: VariableScope | null, plain = false): void {
  if (variables) setMaskedHtml(el, text, variables, renderInline);
  else el.innerHTML = renderInline(text, plain);
}

export function stripInline(text: string): string {
  return text.replace(/[*_`~]|\[\[|\]\]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
}

function actionButton(className: string, label: string, title: string, run: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = label;
  b.title = title;
  b.setAttribute('aria-label', title);
  // Keep the editor selection where it is
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    run();
  });
  return b;
}

export interface TableView {
  /** Column index, -1 unsorted */
  sort: number;
  desc: boolean;
  filter: string;
}

export function dataTable(
  headers: string[],
  rows: DataRow[],
  opts: {
    align?: ('left' | 'center' | 'right' | null)[];
    caption?: string;
    onWiki?: (t: string) => void;
    edit?: TableEditing;
    /** A summary row below the body (query aggregates, #77); it is not sorted or filtered */
    footer?: string[];
    /** Fills `{{var:name}}` in the cells */
    variables?: VariableScope | null;
    /** Text from outside the vault: [[links]] stay text */
    plain?: boolean;
    /** The filter field (default on) */
    filter?: boolean;
    /** Shown in the body while there are no rows */
    empty?: string;
    /** Sort column and filter, read at the start and kept up to date, so a rebuilt table keeps them */
    view?: TableView;
  } = {}
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = `cm-block-widget wz-table${opts.edit ? ' wz-table-editable' : ''}`;
  const edit = opts.edit;
  const cols = headers.length;
  const columnsEditable = !!(edit?.insertColumn && edit.removeColumn);
  const cellEditable = (cell: CellRef) => !!edit && (cell.row === -1 ? columnsEditable : (edit.canEdit?.(cell) ?? true));
  const view = opts.view;
  let sortCol = view && view.sort < cols ? view.sort : -1;
  let desc = view?.desc ?? false;
  let filter = opts.filter === false ? '' : (view?.filter.toLowerCase() ?? '');
  const remember = () => {
    if (!view) return;
    view.sort = sortCol;
    view.desc = desc;
    view.filter = input.value;
  };

  const bar = document.createElement('div');
  bar.className = 'wz-table-bar';
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = t('editor.tableFilter');
  input.className = 'wz-table-filter';
  input.setAttribute('aria-label', t('editor.tableFilter'));
  if (view?.filter && opts.filter !== false) input.value = view.filter;
  const count = document.createElement('span');
  count.className = 'wz-table-count';
  if (opts.caption) {
    const cap = document.createElement('span');
    cap.className = 'wz-table-caption';
    cap.textContent = opts.caption;
    bar.append(cap);
  }
  if (opts.filter !== false) bar.append(input);
  else count.style.marginLeft = 'auto';
  if (edit?.addRow) {
    const addRow = edit.addRow;
    bar.append(actionButton('wz-table-action', `+ ${t('editor.tableAddRow')}`, t('editor.tableAddRowTitle'), () => addRow({ row: rows.length, col: 0 })));
  }
  if (edit?.insertColumn && columnsEditable) {
    const insertColumn = edit.insertColumn;
    bar.append(actionButton('wz-table-action', `+ ${t('editor.tableAddColumn')}`, t('editor.tableAddColumnTitle'), () => insertColumn(cols)));
  }
  bar.append(count);

  const scroller = document.createElement('div');
  scroller.className = 'wz-table-scroll scrollbar-thin';
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headers.forEach((h, i) => {
    const th = document.createElement('th');
    th.innerHTML = '<span></span><i class="wz-sort"></i>';
    setInline(th.firstElementChild as HTMLElement, h, opts.variables, opts.plain);
    if (opts.align?.[i]) th.style.textAlign = opts.align[i]!;
    if (columnsEditable) {
      th.dataset.row = '-1';
      th.dataset.col = String(i);
      th.title = t('editor.tableHeaderHint');
      th.append(actionButton('wz-col-menu', '⋮', t('editor.tableColumnMenu'), () => openColumnMenu(th, i)));
      th.addEventListener('dblclick', (e) => {
        e.preventDefault();
        startEdit({ row: -1, col: i });
      });
    }
    th.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.wz-cell-input')) return;
      if (sortCol === i) desc = !desc;
      else {
        sortCol = i;
        desc = false;
      }
      remember();
      draw();
    });
    headRow.append(th);
  });
  if (edit?.removeRow) {
    const corner = document.createElement('th');
    corner.className = 'wz-row-actions';
    headRow.append(corner);
  }
  thead.append(headRow);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);
  if (opts.footer) table.append(footerOf(opts.footer));
  scroller.append(table);
  wrap.append(bar, scroller);

  input.addEventListener('input', () => {
    filter = input.value.toLowerCase();
    remember();
    draw();
  });
  wrap.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const wiki = target.closest('[data-wiki]') as HTMLElement | null;
    if (wiki && opts.onWiki) {
      e.preventDefault();
      opts.onWiki(wiki.dataset.wiki!);
      return;
    }
    // Live preview: a click into a body cell edits it (links and buttons keep working)
    if (!edit || target.closest('a, button, .wz-cell-input')) return;
    const td = target.closest('td[data-row]') as HTMLElement | null;
    if (td) {
      const cell = { row: Number(td.dataset.row), col: Number(td.dataset.col) };
      if (cellEditable(cell)) startEdit(cell);
    }
  });

  /** Replaces a cell's content with an input; Enter/Tab/blur commit, Escape cancels */
  function startEdit(cell: CellRef) {
    if (!edit) return;
    if (cell.row >= rows.length) {
      edit.addRow?.(cell);
      return;
    }
    if (!cellEditable(cell)) return;
    const el = wrap.querySelector<HTMLElement>(`[data-row="${cell.row}"][data-col="${cell.col}"]`);
    if (!el || el.querySelector('.wz-cell-input')) return;
    const original = cell.row === -1 ? headers[cell.col] : (rows[cell.row]?.raw?.[cell.col] ?? rows[cell.row]?.keys[cell.col] ?? '');
    const field = document.createElement('input');
    field.type = 'text';
    field.className = 'wz-cell-input';
    field.value = original;
    field.setAttribute('aria-label', cell.row === -1 ? t('editor.tableEditHeader') : t('editor.tableEditCell'));
    const saved = Array.from(el.childNodes);
    el.replaceChildren(field);
    el.classList.add('editing');
    let done = false;
    const finish = (commit: boolean, focus?: CellRef) => {
      if (done || disposed.has(wrap)) return;
      done = true;
      el.classList.remove('editing');
      if (commit && field.value !== original) {
        edit.setCell(cell, field.value, focus);
        // Still here (the owner saves later, e.g. a plugin over the network): show the new text meanwhile
        if (field.isConnected && cell.row >= 0) setInline(el, field.value, opts.variables, opts.plain);
        return;
      }
      el.replaceChildren(...saved);
      if (focus) startEdit(focus);
    };
    /** The next/previous cell in reading order; past the last cell a new row is added */
    const step = (back: boolean): CellRef | undefined => {
      let { row, col } = cell;
      for (let guard = 0; guard <= (rows.length + 2) * cols; guard++) {
        col += back ? -1 : 1;
        if (col >= cols) {
          col = 0;
          row += 1;
        } else if (col < 0) {
          if (row <= (columnsEditable ? -1 : 0)) return undefined;
          col = cols - 1;
          row -= 1;
        }
        if (row >= rows.length) return edit.addRow ? { row, col: 0 } : undefined;
        if (cellEditable({ row, col })) return { row, col };
      }
      return undefined;
    };
    field.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const below = cell.row + 1;
        finish(true, below < rows.length && cellEditable({ row: below, col: cell.col }) ? { row: below, col: cell.col } : undefined);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        finish(true, step(e.shiftKey));
      }
    });
    field.addEventListener('blur', () => finish(true));
    field.addEventListener('click', (e) => e.stopPropagation());
    field.focus();
    field.select();
  }
  cellEditors.set(wrap, startEdit);

  function openColumnMenu(anchor: HTMLElement, col: number) {
    if (!edit?.insertColumn || !edit.removeColumn) return;
    const { insertColumn, removeColumn } = edit;
    document.querySelector('.wz-col-popup')?.remove();
    const popup = document.createElement('div');
    popup.className = 'wz-col-popup';
    popup.setAttribute('role', 'menu');
    const item = (label: string, run: () => void, disabled = false) => {
      const b = actionButton('', label, label, () => {
        close();
        run();
      });
      b.setAttribute('role', 'menuitem');
      b.disabled = disabled;
      popup.append(b);
    };
    item(t('editor.tableRenameColumn'), () => startEdit({ row: -1, col }));
    item(t('editor.tableInsertLeft'), () => insertColumn(col));
    item(t('editor.tableInsertRight'), () => insertColumn(col + 1));
    item(t('editor.tableDeleteColumn'), () => removeColumn(col), cols <= 1);
    const r = anchor.getBoundingClientRect();
    popup.style.top = `${r.bottom + 4}px`;
    popup.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 216))}px`;
    document.body.append(popup);
    const onDown = (e: MouseEvent) => {
      if (!popup.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    function close() {
      popup.remove();
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', close, true);
    }
    setTimeout(() => {
      document.addEventListener('mousedown', onDown, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('scroll', close, true);
    });
  }

  function draw() {
    let list = filter ? rows.filter((r) => r.keys.some((k) => k.toLowerCase().includes(filter))) : rows.slice();
    if (sortCol >= 0) {
      const loc = locale(getLang());
      const valueOf = (r: DataRow) => (r.sort ? r.sort[sortCol] : r.keys[sortCol]) ?? '';
      list = list.sort((a, b) => {
        const x = valueOf(a);
        const y = valueOf(b);
        // Numbers before text; empty cells last in both directions
        if (x === '' || y === '') return x === y ? 0 : x === '' ? 1 : -1;
        const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), loc, { numeric: true, sensitivity: 'base' });
        return desc ? -c : c;
      });
    }
    headRow.querySelectorAll('th').forEach((th, i) => {
      th.classList.toggle('sorted', i === sortCol);
      th.classList.toggle('desc', i === sortCol && desc);
    });
    tbody.replaceChildren(
      ...list.map((r) => {
        const index = rows.indexOf(r);
        const tr = document.createElement('tr');
        r.cells.forEach((c, i) => {
          const td = document.createElement('td');
          if (edit && cellEditable({ row: index, col: i })) {
            td.dataset.row = String(index);
            td.dataset.col = String(i);
          }
          if (opts.align?.[i]) td.style.textAlign = opts.align[i]!;
          if (typeof c === 'string') setInline(td, c, opts.variables, opts.plain);
          else td.append(c);
          tr.append(td);
        });
        if (edit?.removeRow) {
          const removeRow = edit.removeRow;
          const td = document.createElement('td');
          td.className = 'wz-row-actions';
          td.append(actionButton('wz-row-delete', '×', t('editor.tableDeleteRow'), () => removeRow(index)));
          tr.append(td);
        }
        return tr;
      })
    );
    if (!list.length && opts.empty && !filter) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.className = 'wz-table-empty';
      td.colSpan = cols + (edit?.removeRow ? 1 : 0);
      td.textContent = opts.empty;
      tr.append(td);
      tbody.append(tr);
    }
    count.textContent = filter
      ? t('editor.tableCountFiltered', { shown: list.length, total: rows.length })
      : rows.length === 1
        ? t('editor.tableCountRowSingle')
        : t('editor.tableCountRows', { total: rows.length });
  }
  draw();
  return wrap;
}

function footerOf(cells: string[]): HTMLTableSectionElement {
  const tfoot = document.createElement('tfoot');
  const tr = document.createElement('tr');
  for (const c of cells) {
    const td = document.createElement('td');
    td.textContent = c;
    tr.append(td);
  }
  tfoot.append(tr);
  return tfoot;
}

export interface TableGroup {
  label: string;
  rows: DataRow[];
  /** Aggregates of the group, shown below its rows */
  footer?: string[];
}

/**
 * Read-only table in groups (query GROUP BY, #77): each group is a `tbody` with a header row (label and count), its
 * rows and optionally its aggregates; `footer` sums up all rows
 */
export function groupedTable(headers: string[], groups: TableGroup[], opts: { caption?: string; footer?: string[]; total: number }): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'cm-block-widget wz-table wz-table-grouped';
  const bar = document.createElement('div');
  bar.className = 'wz-table-bar';
  if (opts.caption) {
    const cap = document.createElement('span');
    cap.className = 'wz-table-caption';
    cap.textContent = opts.caption;
    bar.append(cap);
  }
  const count = document.createElement('span');
  count.className = 'wz-table-count';
  count.style.marginLeft = 'auto';
  count.textContent = opts.total === 1 ? t('editor.tableCountRowSingle') : t('editor.tableCountRows', { total: opts.total });
  bar.append(count);
  const scroller = document.createElement('div');
  scroller.className = 'wz-table-scroll scrollbar-thin';
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const h of headers) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.innerHTML = `<span>${renderInline(h)}</span>`;
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);
  for (const g of groups) {
    const tbody = document.createElement('tbody');
    const head = document.createElement('tr');
    head.className = 'wz-group-head';
    const th = document.createElement('th');
    th.scope = 'rowgroup';
    th.colSpan = headers.length;
    const label = document.createElement('span');
    label.textContent = g.label;
    const n = document.createElement('span');
    n.className = 'wz-group-count';
    n.textContent = String(g.rows.length);
    th.append(label, n);
    head.append(th);
    tbody.append(head);
    for (const r of g.rows) {
      const tr = document.createElement('tr');
      for (const c of r.cells) {
        const td = document.createElement('td');
        if (typeof c === 'string') td.innerHTML = renderInline(c);
        else td.append(c);
        tr.append(td);
      }
      tbody.append(tr);
    }
    if (g.footer) {
      const tr = document.createElement('tr');
      tr.className = 'wz-group-foot';
      for (const c of g.footer) {
        const td = document.createElement('td');
        td.textContent = c;
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(tbody);
  }
  if (opts.footer) table.append(footerOf(opts.footer));
  scroller.append(table);
  wrap.append(bar, scroller);
  return wrap;
}

export { parseMarkdownTable } from '@kladde/shared';
