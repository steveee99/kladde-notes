import { describe, expect, it } from 'vitest';
import { formatMarkdownTable, parseMarkdownTable } from '../src/index';

describe('Markdown tables', () => {
  const text = ['Vorher', '', '| Name | Betrag | Notiz |', '| :--- | -----: | :---: |', '| Miete | 900 | a \\| b |', '| Strom | 80 |', '', 'Danach | kein Teil'].join('\n');

  it('reads the first table, with alignment, escaped pipes and missing cells', () => {
    expect(parseMarkdownTable(text)).toEqual({
      headers: ['Name', 'Betrag', 'Notiz'],
      align: ['left', 'right', 'center'],
      rows: [
        ['Miete', '900', 'a | b'],
        ['Strom', '80', ''],
      ],
    });
    expect(parseMarkdownTable('Kein | Delimiter\nnur Text')).toBeNull();
    expect(parseMarkdownTable('')).toBeNull();
  });

  it('writes padded columns the way Kladde writes note tables, and reads them back', () => {
    const out = formatMarkdownTable({ headers: ['Name', 'Betrag'], align: [null, 'right'], rows: [['Miete', 900], ['a|b\nzwei Zeilen', null]] });
    expect(out).toBe(['| Name             | Betrag |', '| ---------------- | -----: |', '| Miete            | 900    |', '| a\\|b zwei Zeilen |        |'].join('\n'));
    expect(parseMarkdownTable(out)?.rows).toEqual([
      ['Miete', '900'],
      ['a|b zwei Zeilen', ''],
    ]);
  });
});
