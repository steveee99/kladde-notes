import type { KladdeHost, PluginTableColumn, PluginTone } from '@kladde/plugin-api/client';
import type { Entry } from './server.js';

export const MOOD_LABEL = { good: { de: 'Gut', en: 'Good' }, okay: { de: 'Geht so', en: 'Okay' }, bad: { de: 'Schlecht', en: 'Bad' } } as const;
export const MOOD_ICON = { good: '🙂', okay: '😐', bad: '🙁' } as const;
export const MOOD_TONE = { good: 'green', okay: 'amber', bad: 'red' } as const satisfies Record<keyof typeof MOOD_LABEL, PluginTone>;

/** The mood in a logbook note's frontmatter (`mood: good`) */
export function moodOfNote(content: string): keyof typeof MOOD_LABEL | null {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  const m = frontmatter && /^mood:[ \t]*(good|okay|bad)[ \t]*$/m.exec(frontmatter[1]);
  return m ? (m[1] as keyof typeof MOOD_LABEL) : null;
}

/** Columns of the entry table (page and note block); the cell editor of `mood` takes good, okay, bad or nothing */
export function entryColumns(host: KladdeHost): PluginTableColumn<Entry>[] {
  return [
    { key: 'at', label: { de: 'Datum', en: 'Date' }, type: 'date', editable: false },
    {
      key: 'mood',
      label: { de: 'Stimmung', en: 'Mood' },
      // A colored badge (plugin API 1.3); the cell editor still takes good, okay, bad or nothing
      badge: (_, e) => (e.mood ? { text: `${MOOD_ICON[e.mood]} ${host.t(MOOD_LABEL[e.mood])}`, tone: MOOD_TONE[e.mood] } : null),
    },
    { key: 'text', label: { de: 'Eintrag', en: 'Entry' } },
  ];
}

/** Saves one edited cell of the entry table; the server checks it like a new entry */
export function saveCell(host: KladdeHost, id: string, key: string, value: string): Promise<Entry> {
  return host.api<Entry>(`/entries/${id}`, { method: 'PATCH', json: { [key]: value } });
}
