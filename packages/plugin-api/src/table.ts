/**
 * GFM tables as data, for plugins that keep a table in a note or in the text of their editor block: read it with
 * `parseMarkdownTable`, write it back with `formatMarkdownTable`. Kladde reads and writes note tables the same way
 * (`\|` is a pipe inside a cell). Since plugin API 1.2.
 */

export type MarkdownTableAlign = 'left' | 'center' | 'right' | null;

export interface MarkdownTable {
  headers: string[];
  /** One entry per column */
  align: MarkdownTableAlign[];
  /** Every row has as many cells as there are headers */
  rows: string[][];
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** The first GFM table in `text` (lines before it are skipped, it ends at the first line without a pipe); null if there is none */
export function parseMarkdownTable(text: string): MarkdownTable | null {
  const lines = text.split('\n');
  const start = lines.findIndex((l, i) => l.includes('|') && DELIMITER.test(lines[i + 1] ?? ''));
  if (start < 0) return null;
  const headers = splitRow(lines[start]);
  const align = splitRow(lines[start + 1]).map((c): MarkdownTableAlign => (/^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : /^:-+$/.test(c) ? 'left' : null));
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.trim() || !line.includes('|')) break;
    const cells = splitRow(line);
    rows.push(headers.map((_, i) => cells[i] ?? ''));
  }
  return { headers, align: headers.map((_, i) => align[i] ?? null), rows };
}

/** A cell as Markdown: one line, pipes escaped */
function cellText(value: unknown): string {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .trim()
    .replace(/(?<!\\)\|/g, '\\|');
}

function delimiter(align: MarkdownTableAlign, width: number): string {
  if (align === 'center') return `:${'-'.repeat(width - 2)}:`;
  if (align === 'right') return `${'-'.repeat(width - 1)}:`;
  if (align === 'left') return `:${'-'.repeat(width - 1)}`;
  return '-'.repeat(width);
}

/** The table as Markdown with columns padded to equal width; missing cells are empty, extra cells are dropped */
export function formatMarkdownTable(table: { headers: string[]; align?: MarkdownTableAlign[]; rows: unknown[][] }): string {
  const cols = Math.max(1, table.headers.length);
  const header = Array.from({ length: cols }, (_, i) => cellText(table.headers[i]));
  const body = table.rows.map((r) => Array.from({ length: cols }, (_, i) => cellText(r[i])));
  const widths = header.map((h, i) => Math.max(3, h.length, ...body.map((r) => r[i].length)));
  const line = (cells: string[]) => `| ${cells.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;
  const delim = `| ${widths.map((w, i) => delimiter(table.align?.[i] ?? null, w)).join(' | ')} |`;
  return [line(header), delim, ...body.map(line)].join('\n');
}
