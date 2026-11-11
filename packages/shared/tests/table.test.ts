import { describe, expect, it } from 'vitest';
import {
  insertTableColumn,
  insertTableRow,
  parseMarkdownTable,
  removeTableColumn,
  removeTableRow,
  serializeMarkdownTable,
  setTableCell,
} from '../src/table';

const SRC = ['| Name | Menge |', '| :--- | ---: |', '| Mehl | 500 g |', '| Milch | 1 l |'].join('\n');

describe('markdown tables', () => {
  it('parses headers, alignment and rows', () => {
    expect(parseMarkdownTable(SRC)).toEqual({
      headers: ['Name', 'Menge'],
      align: ['left', 'right'],
      rows: [
        ['Mehl', '500 g'],
        ['Milch', '1 l'],
      ],
    });
    expect(parseMarkdownTable('| nur eine Zeile |')).toBeNull();
  });

  it('serializes with padded columns and keeps alignment', () => {
    const t = parseMarkdownTable(SRC)!;
    expect(serializeMarkdownTable(t)).toBe(['| Name  | Menge |', '| :---- | ----: |', '| Mehl  | 500 g |', '| Milch | 1 l   |'].join('\n'));
    expect(parseMarkdownTable(serializeMarkdownTable(t))).toEqual(t);
  });

  it('escapes pipes and line breaks in cells and round-trips them', () => {
    const t = setTableCell(parseMarkdownTable(SRC)!, 0, 0, 'A | B\nC');
    const md = serializeMarkdownTable(t);
    expect(md).toContain('A \\| B C');
    expect(parseMarkdownTable(md)!.rows[0][0]).toBe('A | B C');
  });

  it('edits header and body cells', () => {
    const t = parseMarkdownTable(SRC)!;
    expect(setTableCell(t, -1, 1, 'Anzahl').headers).toEqual(['Name', 'Anzahl']);
    expect(setTableCell(t, 1, 1, '2 l').rows[1]).toEqual(['Milch', '2 l']);
    expect(t.rows[1][1]).toBe('1 l');
  });

  it('inserts and removes columns', () => {
    const t = parseMarkdownTable(SRC)!;
    const added = insertTableColumn(t, 1, 'Neu');
    expect(added.headers).toEqual(['Name', 'Neu', 'Menge']);
    expect(added.align).toEqual(['left', null, 'right']);
    expect(added.rows[0]).toEqual(['Mehl', '', '500 g']);
    const removed = removeTableColumn(added, 0);
    expect(removed.headers).toEqual(['Neu', 'Menge']);
    expect(removed.rows[1]).toEqual(['', '1 l']);
    const single = removeTableColumn(removeTableColumn(removed, 0), 0);
    expect(single.headers).toEqual(['Menge']);
  });

  it('inserts and removes rows', () => {
    const t = parseMarkdownTable(SRC)!;
    expect(insertTableRow(t).rows).toHaveLength(3);
    expect(insertTableRow(t, 0).rows[0]).toEqual(['', '']);
    expect(removeTableRow(t, 0).rows).toEqual([['Milch', '1 l']]);
  });
});
