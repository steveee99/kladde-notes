/**
 * GFM tables as data: parse the Markdown source, edit cells, columns and rows, and write it back.
 * Used by the table widget in the editor's live preview (the Markdown view edits the plain text).
 */
import type { TableAlign } from './export.js';

export interface MarkdownTable {
  headers: string[];
  align: TableAlign[];
  rows: string[][];
}

/** Cells of one table line; `\|` is a literal pipe inside a cell */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

/** Parses a GFM table; null if it is not one */
export function parseMarkdownTable(src: string): MarkdownTable | null {
  const lines = src.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return null;
  const headers = splitRow(lines[0]);
  const align = splitRow(lines[1]).map((c): TableAlign => (/^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : /^:-+$/.test(c) ? 'left' : null));
  const rows = lines.slice(2).map((l) => {
    const cells = splitRow(l);
    return headers.map((_, i) => cells[i] ?? '');
  });
  return { headers, align: headers.map((_, i) => align[i] ?? null), rows };
}

/** A cell as Markdown: one line, pipes escaped */
function cellText(value: string): string {
  return value.replace(/\r?\n/g, ' ').trim().replace(/(?<!\\)\|/g, '\\|');
}

function delimiter(align: TableAlign, width: number): string {
  const w = Math.max(width, 3);
  if (align === 'center') return `:${'-'.repeat(w - 2)}:`;
  if (align === 'right') return `${'-'.repeat(w - 1)}:`;
  if (align === 'left') return `:${'-'.repeat(w - 1)}`;
  return '-'.repeat(w);
}

/** Writes a table back as Markdown with columns padded to equal width */
export function serializeMarkdownTable(table: MarkdownTable): string {
  const cols = Math.max(1, table.headers.length);
  const header = Array.from({ length: cols }, (_, i) => cellText(table.headers[i] ?? ''));
  const body = table.rows.map((r) => Array.from({ length: cols }, (_, i) => cellText(r[i] ?? '')));
  const widths = header.map((h, i) => Math.max(3, h.length, ...body.map((r) => r[i].length)));
  const line = (cells: string[]) => `| ${cells.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;
  const delim = `| ${widths.map((w, i) => delimiter(table.align[i] ?? null, w)).join(' | ')} |`;
  return [line(header), delim, ...body.map(line)].join('\n');
}

const clone = (t: MarkdownTable): MarkdownTable => ({ headers: [...t.headers], align: [...t.align], rows: t.rows.map((r) => [...r]) });

/** Sets one cell; `row` -1 is the header row */
export function setTableCell(table: MarkdownTable, row: number, col: number, value: string): MarkdownTable {
  const next = clone(table);
  if (col < 0 || col >= next.headers.length) return next;
  if (row === -1) next.headers[col] = value;
  else if (row >= 0 && row < next.rows.length) next.rows[row][col] = value;
  return next;
}

/** Inserts an empty column before index `at` (`at` = column count appends) */
export function insertTableColumn(table: MarkdownTable, at: number, header = ''): MarkdownTable {
  const next = clone(table);
  const i = Math.max(0, Math.min(at, next.headers.length));
  next.headers.splice(i, 0, header);
  next.align.splice(i, 0, null);
  for (const r of next.rows) r.splice(i, 0, '');
  return next;
}

/** Removes a column; the last remaining column stays */
export function removeTableColumn(table: MarkdownTable, at: number): MarkdownTable {
  const next = clone(table);
  if (next.headers.length <= 1 || at < 0 || at >= next.headers.length) return next;
  next.headers.splice(at, 1);
  next.align.splice(at, 1);
  for (const r of next.rows) r.splice(at, 1);
  return next;
}

/** Inserts an empty row before index `at` (default: append) */
export function insertTableRow(table: MarkdownTable, at = table.rows.length): MarkdownTable {
  const next = clone(table);
  const i = Math.max(0, Math.min(at, next.rows.length));
  next.rows.splice(i, 0, next.headers.map(() => ''));
  return next;
}

export function removeTableRow(table: MarkdownTable, at: number): MarkdownTable {
  const next = clone(table);
  if (at >= 0 && at < next.rows.length) next.rows.splice(at, 1);
  return next;
}
