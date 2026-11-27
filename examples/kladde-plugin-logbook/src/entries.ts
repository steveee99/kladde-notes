import type { KladdeHost, PluginTableColumn } from '@kladde/plugin-api/client';
import type { Entry } from './server.js';

export const MOOD_LABEL = { good: { de: 'Gut', en: 'Good' }, okay: { de: 'Geht so', en: 'Okay' }, bad: { de: 'Schlecht', en: 'Bad' } } as const;
export const MOOD_ICON = { good: '🙂', okay: '😐', bad: '🙁' } as const;

/** Columns of the entry table (page and note block); the cell editor of `mood` takes good, okay, bad or nothing */
export function entryColumns(host: KladdeHost): PluginTableColumn<Entry>[] {
  return [
    { key: 'at', label: { de: 'Datum', en: 'Date' }, type: 'date', editable: false },
    { key: 'mood', label: { de: 'Stimmung', en: 'Mood' }, format: (_, e) => (e.mood ? `${MOOD_ICON[e.mood]} ${host.t(MOOD_LABEL[e.mood])}` : '') },
    { key: 'text', label: { de: 'Eintrag', en: 'Entry' } },
  ];
}

/** Saves one edited cell of the entry table; the server checks it like a new entry */
export function saveCell(host: KladdeHost, id: string, key: string, value: string): Promise<Entry> {
  return host.api<Entry>(`/entries/${id}`, { method: 'PATCH', json: { [key]: value } });
}
