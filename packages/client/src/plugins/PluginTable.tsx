import { useEffect, useReducer, useRef } from 'react';
import { localize, type PluginTableColumn, type PluginTableProps } from '@kladde/plugin-api/client';
import { dataTable, disposeTable, openTableCell, stripInline, type CellRef, type DataRow, type TableEditing, type TableView } from '../editor/datatable';
import { editorHost } from '../editor/host';
import { getLang, locale } from '../lib/i18n';
import { showToast } from '../lib/toast';

interface Cell {
  /** Inline Markdown shown in the cell */
  text: string;
  /** Plain text for the filter */
  key: string;
  sort: string | number | null;
  /** Text of the cell editor */
  raw: string;
}

const isoDay = (ms: number) => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** A plugin's value as a table cell: numbers and dates in the interface's language, everything else as text */
export function tableCell<Row>(column: PluginTableColumn<Row>, row: Row, loc: string): Cell {
  const value = (row as Record<string, unknown>)[column.key];
  const plain = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  let text = plain;
  let sort: string | number | null = plain || null;
  let raw = plain;
  if (column.type === 'number') {
    const n = typeof value === 'number' ? value : plain.trim() ? Number(plain) : NaN;
    if (Number.isFinite(n)) {
      text = n.toLocaleString(loc);
      sort = n;
    }
  } else if (column.type === 'date') {
    const ms = typeof value === 'number' ? value : plain ? Date.parse(plain) : NaN;
    if (Number.isFinite(ms)) {
      text = new Date(ms).toLocaleDateString(loc);
      sort = ms;
      raw = isoDay(ms);
    }
  }
  if (column.format) text = column.format(value, row);
  const key = stripInline(text);
  return { text, key, sort: column.type === 'number' || column.type === 'date' ? sort : key.toLowerCase() || null, raw };
}

/**
 * `ui.Table` of the plugin API: Kladde's table of notes (`dataTable`) in a React component. The table is built as
 * DOM and rebuilt when rows or columns change; sorting, the filter and an open cell editor survive the rebuild.
 */
export function PluginTable<Row extends object>(props: PluginTableProps<Row>) {
  const box = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const view = useRef<TableView>({ sort: -1, desc: false, filter: '' });
  /** A cell editor to open again after the next rebuild (row by id, or by index for a row still to come) */
  const pending = useRef<{ id?: string; index: number; col: number } | null>(null);
  const [nonce, rebuild] = useReducer((n: number) => n + 1, 0);
  /** Row ids of the table on screen, to find an open cell editor's row again */
  const builtIds = useRef<string[]>([]);
  const lang = getLang();
  const { columns, rows, rowKey, editable, caption, filter, footer, empty, onCellChange, onAddRow, onRemoveRow } = props;

  // What the table shows, as one string: plugins often compute new arrays on every render (notes, sync), and
  // rebuilding then would close an open cell editor
  const loc = locale(lang);
  const ids = rows.map((row) => String(typeof rowKey === 'function' ? rowKey(row) : (row as Record<string, unknown>)[rowKey]));
  const cells = rows.map((row) => columns.map((c) => tableCell(c, row, loc)));
  const shown = JSON.stringify([
    ids,
    cells,
    columns.map((c) => [c.key, localize(c.label, lang), c.align, c.type, c.editable]),
    caption === undefined ? null : localize(caption, lang),
    empty === undefined ? null : localize(empty, lang),
    footer ?? null,
    filter !== false,
    !!(editable && onCellChange),
    !!onAddRow,
    !!onRemoveRow,
  ]);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const data: DataRow[] = cells.map((r) => ({ cells: r.map((c) => c.text), keys: r.map((c) => c.key), sort: r.map((c) => c.sort), raw: r.map((c) => c.raw) }));
    const call = () => latest.current;

    /** Runs a plugin callback; on an error its message, and the table as the plugin's rows say */
    const run = async (callback: () => void | Promise<void>) => {
      const before = shownRef.current;
      try {
        await callback();
      } catch (err) {
        showToast(err instanceof Error && err.message ? err.message : String(err), 'danger');
        pending.current = null;
        rebuild();
        return;
      }
      // Nothing changed: show the plugin's rows again instead of the typed text (after React rendered what the
      // callback set)
      setTimeout(() => shownRef.current === before && rebuild(), 50);
    };
    const remember = (focus?: CellRef) => {
      pending.current = focus ? { id: ids[focus.row], index: focus.row, col: focus.col } : null;
    };
    const firstEditable = () => Math.max(0, columns.findIndex((c) => c.editable !== false));
    const addRow = onAddRow ? () => call().onAddRow?.() : undefined;
    const edit: TableEditing | undefined =
      editable && onCellChange
        ? {
            canEdit: (cell) => columns[cell.col]?.editable !== false,
            setCell: (cell, value, focus) => {
              const row = rows[cell.row];
              if (!row) return;
              const add = !!(focus && focus.row >= rows.length && addRow);
              remember(add ? { row: rows.length, col: firstEditable() } : focus);
              void run(async () => {
                await call().onCellChange?.(ids[cell.row], columns[cell.col].key, value, row);
                if (add) await addRow?.();
              });
            },
            addRow: addRow
              ? () => {
                  remember({ row: rows.length, col: firstEditable() });
                  void run(addRow);
                }
              : undefined,
            removeRow: onRemoveRow ? (index) => void run(() => call().onRemoveRow?.(ids[index], rows[index])) : undefined,
          }
        : undefined;

    const active = document.activeElement;
    const filterHadFocus = !!active && el.contains(active) && active.classList.contains('wz-table-filter');
    // A cell editor the user is typing in opens again in the new table, with the typed text
    const typing = active instanceof HTMLInputElement && el.contains(active) && active.classList.contains('wz-cell-input') ? active : null;
    const typingCell = typing?.closest<HTMLElement>('td[data-row]');
    const typed = typing && typingCell ? { id: builtIds.current[Number(typingCell.dataset.row)], col: Number(typingCell.dataset.col), value: typing.value, start: typing.selectionStart, end: typing.selectionEnd } : null;
    for (const old of el.children) disposeTable(old);
    const table = dataTable(
      columns.map((c) => localize(c.label, lang)),
      data,
      {
        align: columns.map((c) => c.align ?? (c.type === 'number' ? 'right' : null)),
        caption: caption === undefined ? undefined : localize(caption, lang),
        filter,
        footer,
        empty: empty === undefined ? undefined : localize(empty, lang),
        onWiki: (title) => editorHost.openWiki(title),
        edit,
        view: view.current,
      }
    );
    el.replaceChildren(table);
    builtIds.current = ids;
    if (filterHadFocus) table.querySelector<HTMLInputElement>('.wz-table-filter')?.focus();

    const next = pending.current;
    pending.current = null;
    if (typed && ids.includes(typed.id)) {
      openTableCell(table, { row: ids.indexOf(typed.id), col: typed.col });
      const field = table.querySelector<HTMLInputElement>('.wz-cell-input');
      if (field) {
        field.value = typed.value;
        field.setSelectionRange(typed.start, typed.end);
      }
    } else if (next) {
      // A new row appears at the end; an existing one is found by its id wherever it went
      const index = next.id !== undefined && ids.includes(next.id) ? ids.indexOf(next.id) : next.index;
      if (index < rows.length) openTableCell(table, { row: index, col: next.col });
    }
  }, [shown, nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={box} data-plugin-table="" />;
}
