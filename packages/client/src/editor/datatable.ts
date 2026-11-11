import { getLang, locale, t } from '../lib/i18n';

/** Interactive table (sort by header click, filter field) used for Markdown tables and query results */

export interface DataRow {
  cells: (string | Node)[];
  /** Plain values for sorting and filtering */
  keys: string[];
  /** Raw Markdown per cell, shown in the cell editor */
  raw?: string[];
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
  insertColumn(at: number): void;
  removeColumn(at: number): void;
  addRow(focus?: CellRef): void;
  removeRow(row: number): void;
}

const cellEditors = new WeakMap<HTMLElement, (cell: CellRef) => void>();

/** Opens the cell editor of a table widget built by `dataTable` (keeps focus across rebuilds) */
export function openTableCell(wrap: Element, cell: CellRef): boolean {
  const open = cellEditors.get(wrap as HTMLElement);
  if (!open) return false;
  open(cell);
  return true;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Very small inline Markdown → HTML for table cells (escaped first, so it is safe) */
export function renderInline(text: string): string {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code class="cm-inline-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t, a) => `<span class="cm-wikilink" data-wiki="${t}">${a ?? t}</span>`)
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a class="cm-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
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

export function dataTable(
  headers: string[],
  rows: DataRow[],
  opts: { align?: ('left' | 'center' | 'right' | null)[]; caption?: string; onWiki?: (t: string) => void; edit?: TableEditing } = {}
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = `cm-block-widget wz-table${opts.edit ? ' wz-table-editable' : ''}`;
  const edit = opts.edit;
  const cols = headers.length;
  let sortCol = -1;
  let desc = false;
  let filter = '';

  const bar = document.createElement('div');
  bar.className = 'wz-table-bar';
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = t('editor.tableFilter');
  input.className = 'wz-table-filter';
  const count = document.createElement('span');
  count.className = 'wz-table-count';
  if (opts.caption) {
    const cap = document.createElement('span');
    cap.className = 'wz-table-caption';
    cap.textContent = opts.caption;
    bar.append(cap);
  }
  bar.append(input);
  if (edit) {
    bar.append(
      actionButton('wz-table-action', `+ ${t('editor.tableAddRow')}`, t('editor.tableAddRowTitle'), () => edit.addRow({ row: rows.length, col: 0 })),
      actionButton('wz-table-action', `+ ${t('editor.tableAddColumn')}`, t('editor.tableAddColumnTitle'), () => edit.insertColumn(cols))
    );
  }
  bar.append(count);

  const scroller = document.createElement('div');
  scroller.className = 'wz-table-scroll scrollbar-thin';
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headers.forEach((h, i) => {
    const th = document.createElement('th');
    th.innerHTML = `<span>${renderInline(h)}</span><i class="wz-sort"></i>`;
    if (opts.align?.[i]) th.style.textAlign = opts.align[i]!;
    if (edit) {
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
      draw();
    });
    headRow.append(th);
  });
  if (edit) {
    const corner = document.createElement('th');
    corner.className = 'wz-row-actions';
    headRow.append(corner);
  }
  thead.append(headRow);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);
  scroller.append(table);
  wrap.append(bar, scroller);

  input.addEventListener('input', () => {
    filter = input.value.toLowerCase();
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
    if (td) startEdit({ row: Number(td.dataset.row), col: Number(td.dataset.col) });
  });

  /** Replaces a cell's content with an input; Enter/Tab/blur commit, Escape cancels */
  function startEdit(cell: CellRef) {
    if (!edit) return;
    if (cell.row >= rows.length) {
      edit.addRow(cell);
      return;
    }
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
      if (done) return;
      done = true;
      el.classList.remove('editing');
      if (commit && field.value !== original) {
        edit.setCell(cell, field.value, focus);
        return;
      }
      el.replaceChildren(...saved);
      if (focus) startEdit(focus);
    };
    /** The next/previous cell in reading order; past the last cell a new row is added */
    const step = (back: boolean): CellRef => {
      let { row, col } = cell;
      col += back ? -1 : 1;
      if (col >= cols) {
        col = 0;
        row += 1;
      } else if (col < 0) {
        if (row === -1) return cell;
        col = cols - 1;
        row -= 1;
      }
      return { row, col };
    };
    field.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const below = cell.row + 1;
        finish(true, below < rows.length ? { row: below, col: cell.col } : undefined);
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
    if (!edit) return;
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
    item(t('editor.tableInsertLeft'), () => edit.insertColumn(col));
    item(t('editor.tableInsertRight'), () => edit.insertColumn(col + 1));
    item(t('editor.tableDeleteColumn'), () => edit.removeColumn(col), cols <= 1);
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
      list = list.sort((a, b) => {
        const c = (a.keys[sortCol] ?? '').localeCompare(b.keys[sortCol] ?? '', loc, { numeric: true, sensitivity: 'base' });
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
          if (edit) {
            td.dataset.row = String(index);
            td.dataset.col = String(i);
          }
          if (opts.align?.[i]) td.style.textAlign = opts.align[i]!;
          if (typeof c === 'string') td.innerHTML = renderInline(c);
          else td.append(c);
          tr.append(td);
        });
        if (edit) {
          const td = document.createElement('td');
          td.className = 'wz-row-actions';
          td.append(actionButton('wz-row-delete', '×', t('editor.tableDeleteRow'), () => edit.removeRow(index)));
          tr.append(td);
        }
        return tr;
      })
    );
    count.textContent = filter
      ? t('editor.tableCountFiltered', { shown: list.length, total: rows.length })
      : rows.length === 1
        ? t('editor.tableCountRowSingle')
        : t('editor.tableCountRows', { total: rows.length });
  }
  draw();
  return wrap;
}

export { parseMarkdownTable } from '@kladde/shared';
