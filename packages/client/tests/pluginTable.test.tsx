// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PluginTableProps } from '@kladde/plugin-api/client';
import { PluginTable, tableCell } from '../src/plugins/PluginTable';
import { showToast } from '../src/lib/toast';

vi.mock('../src/lib/toast', () => ({ showToast: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Item {
  id: string;
  name: string;
  amount: number | null;
  due?: string;
}

const columns: PluginTableProps<Item>['columns'] = [
  { key: 'name', label: { de: 'Name', en: 'Name' } },
  { key: 'amount', label: 'Betrag', type: 'number' },
  { key: 'due', label: 'Fällig', type: 'date', editable: false },
];

const items: Item[] = [
  { id: 'a', name: 'Zehn', amount: 10, due: '2026-11-03' },
  { id: 'b', name: '**Neun**', amount: 9 },
  { id: 'c', name: '<img src=x onerror=alert(1)>', amount: 100, due: '2026-01-15' },
];

let root: Root | null = null;
let el: HTMLElement;

function render(props: Partial<PluginTableProps<Item>> = {}) {
  if (!root) {
    el = document.createElement('div');
    document.body.append(el);
    root = createRoot(el);
  }
  act(() => root!.render(<PluginTable columns={columns} rows={items} rowKey="id" {...props} />));
}

const column = (i: number) => [...el.querySelectorAll('tbody tr')].map((tr) => tr.children[i]?.textContent);
const press = (field: HTMLElement, key: string, shiftKey = false) => field.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  el?.remove();
  vi.mocked(showToast).mockClear();
});

describe('tableCell', () => {
  it('formats numbers and dates for the language and sorts them by value', () => {
    expect(tableCell(columns[1], items[0], 'de-DE')).toEqual({ text: '10', key: '10', sort: 10, raw: '10' });
    expect(tableCell(columns[1], { ...items[0], amount: 1234.5 }, 'de-DE').text).toBe('1.234,5');
    expect(tableCell(columns[1], items[0] && { ...items[0], amount: null }, 'de-DE')).toMatchObject({ text: '', sort: null });
    const due = tableCell(columns[2], items[0], 'de-DE');
    expect(due).toMatchObject({ text: '3.11.2026', raw: '2026-11-03' });
    expect(typeof due.sort).toBe('number');
    expect(tableCell({ key: 'name', label: 'N', format: (v) => `→ ${String(v)}` }, items[0], 'de-DE').text).toBe('→ Zehn');
  });
});

describe('ui.Table', () => {
  it('shows the rows like a note table, escaped, and sorts numbers as numbers', () => {
    render({ caption: { de: 'Ausgaben', en: 'Spending' }, footer: ['Summe', '119', ''] });
    expect(el.querySelector('.wz-table-caption')?.textContent).toBe('Ausgaben');
    expect([...el.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['Name', 'Betrag', 'Fällig']);
    expect(el.querySelector('tbody strong')?.textContent).toBe('Neun');
    expect(el.querySelector('tbody img')).toBeNull();
    expect(el.querySelector('tfoot')?.textContent).toBe('Summe119');
    // Read-only: no cell editors, no buttons
    expect(el.querySelector('td[data-row]')).toBeNull();
    expect(el.querySelector('.wz-table-action, .wz-row-delete, .wz-col-menu')).toBeNull();
    act(() => el.querySelectorAll<HTMLElement>('th')[1].click());
    expect(column(1)).toEqual(['9', '10', '100']);
    // Rows without a date sort last
    act(() => el.querySelectorAll<HTMLElement>('th')[2].click());
    expect(column(0)).toEqual(['<img src=x onerror=alert(1)>', 'Zehn', 'Neun']);
  });

  it('keeps sorting and the filter when the rows change, and shows the empty text', () => {
    render();
    act(() => el.querySelectorAll<HTMLElement>('th')[1].click());
    const input = el.querySelector<HTMLInputElement>('.wz-table-filter')!;
    input.value = 'z';
    act(() => input.dispatchEvent(new Event('input')));
    render({ rows: [...items, { id: 'd', name: 'Nachzügler', amount: 1 }] });
    expect(el.querySelector<HTMLInputElement>('.wz-table-filter')!.value).toBe('z');
    expect(column(0)).toEqual(['Nachzügler', 'Zehn']);
    render({ rows: [], empty: 'Nichts da', filter: false });
    expect(el.querySelector('.wz-table-filter')).toBeNull();
    expect(el.querySelector('.wz-table-empty')?.textContent).toBe('Nichts da');
  });

  it('edits only editable columns and keeps the columns fixed', async () => {
    const onCellChange = vi.fn();
    render({ editable: true, onCellChange });
    expect(el.querySelector('.wz-table-editable')).not.toBeNull();
    expect(el.querySelector('td[data-row="0"][data-col="2"]')).toBeNull();
    expect(el.querySelector('th[data-row], .wz-col-menu, .wz-table-action, .wz-row-delete')).toBeNull();
    act(() => el.querySelector<HTMLElement>('td[data-row="1"][data-col="0"]')!.click());
    const field = el.querySelector<HTMLInputElement>('.wz-cell-input')!;
    expect(field.value).toBe('**Neun**');
    field.value = 'Acht';
    // Tab goes to the next editable cell: amount of the same row
    await act(async () => press(field, 'Tab'));
    expect(onCellChange).toHaveBeenCalledWith('b', 'name', 'Acht', items[1]);
    // Meanwhile the typed text; once it is clear that the plugin kept its rows, their value again
    expect(column(0)[1]).toBe('Acht');
    await act(() => new Promise((r) => setTimeout(r, 80)));
    // The plugin did not change its rows: its value is shown again, the editor moved on
    expect(column(0)[1]).toBe('Neun');
    const next = el.querySelector<HTMLInputElement>('.wz-cell-input')!;
    expect(next.closest('td')?.dataset).toMatchObject({ row: '1', col: '1' });
    expect(next.value).toBe('9');
    // Past the last editable cell of the last row without onAddRow: the editor closes
    act(() => press(next, 'Escape'));
    act(() => el.querySelector<HTMLElement>('td[data-row="2"][data-col="1"]')!.click());
    await act(async () => press(el.querySelector<HTMLInputElement>('.wz-cell-input')!, 'Tab'));
    expect(el.querySelector('.wz-cell-input')).toBeNull();
  });

  it('shows the error of a failed save and the old value', async () => {
    render({ editable: true, onCellChange: async () => Promise.reject(new Error('Zu groß')) });
    act(() => el.querySelector<HTMLElement>('td[data-row="0"][data-col="1"]')!.click());
    const field = el.querySelector<HTMLInputElement>('.wz-cell-input')!;
    field.value = '999';
    await act(async () => press(field, 'Enter'));
    expect(showToast).toHaveBeenCalledWith('Zu groß', 'danger');
    expect(column(1)[0]).toBe('10');
  });

  it('keeps an open cell editor while the plugin renders the same rows again', () => {
    render({ editable: true, onCellChange: vi.fn() });
    act(() => el.querySelector<HTMLElement>('td[data-row="0"][data-col="0"]')!.click());
    const field = el.querySelector<HTMLInputElement>('.wz-cell-input')!;
    render({ editable: true, onCellChange: vi.fn(), rows: items.map((i) => ({ ...i })), columns: columns.map((c) => ({ ...c })) });
    expect(field.isConnected).toBe(true);
  });

  it('opens the cell editor again with the typed text when other rows change meanwhile', () => {
    const onCellChange = vi.fn();
    render({ editable: true, onCellChange });
    act(() => el.querySelector<HTMLElement>('td[data-row="2"][data-col="0"]')!.click());
    const field = el.querySelector<HTMLInputElement>('.wz-cell-input')!;
    field.value = 'halb getipp';
    // Another device synced: a row in front of it, the row itself moved down
    render({ editable: true, onCellChange, rows: [{ id: 'z', name: 'Neu von woanders', amount: 1 }, ...items] });
    const again = el.querySelector<HTMLInputElement>('.wz-cell-input')!;
    expect(again).not.toBe(field);
    expect(again.value).toBe('halb getipp');
    expect(again.closest('td')?.dataset).toMatchObject({ row: '3', col: '0' });
    // The replaced editor saved nothing
    expect(onCellChange).not.toHaveBeenCalled();
  });

  it('adds and removes rows through the plugin and opens the new row', async () => {
    let rows = [...items];
    const onAddRow = vi.fn(() => {
      rows = [...rows, { id: 'new', name: '', amount: null }];
      render({ rows, editable: true, onCellChange: vi.fn(), onAddRow, onRemoveRow });
    });
    const onRemoveRow = vi.fn((id: string) => {
      rows = rows.filter((r) => r.id !== id);
      render({ rows, editable: true, onCellChange: vi.fn(), onAddRow, onRemoveRow });
    });
    render({ rows, editable: true, onCellChange: vi.fn(), onAddRow, onRemoveRow });
    await act(async () => el.querySelector<HTMLButtonElement>('.wz-table-action')!.click());
    expect(onAddRow).toHaveBeenCalled();
    expect(el.querySelector('.wz-cell-input')?.closest('td')?.dataset).toMatchObject({ row: '3', col: '0' });
    await act(async () => el.querySelectorAll<HTMLButtonElement>('.wz-row-delete')[0].click());
    expect(onRemoveRow).toHaveBeenCalledWith('a', items[0]);
    expect(column(0)).not.toContain('Zehn');
  });
});
