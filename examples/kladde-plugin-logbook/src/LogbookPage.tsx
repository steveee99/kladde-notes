import { useEffect, useRef, useState } from 'react';
import { PluginRequestError, useKladde, type PluginPageProps } from '@kladde/plugin-api/client';
import type { Entry } from './server.js';

const MOOD_LABEL = { good: { de: 'Gut', en: 'Good' }, okay: { de: 'Geht so', en: 'Okay' }, bad: { de: 'Schlecht', en: 'Bad' } } as const;

/** The logbook: write an entry, see the latest ones, turn one into a note */
export function LogbookPage({ path }: PluginPageProps) {
  const host = useKladde();
  const { PageHeader, PageBody, Panel } = host.ui;
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [text, setText] = useState('');
  const [mood, setMood] = useState<Entry['mood']>(null);
  const [error, setError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  // Re-renders when notes change, so the list of logbook notes below stays current
  host.useNotesVersion();
  const notes = host.notes.list({ type: 'plugin:logbook:entry' });

  useEffect(() => {
    host.api<Entry[]>('/entries').then(setEntries, (err) => setError(String(err.message ?? err)));
    if (path === '/new') input.current?.focus();
  }, [host, path]);

  const add = async () => {
    setError('');
    try {
      const entry = await host.api<Entry>('/entries', { method: 'POST', json: { text, mood } });
      setEntries((list) => [entry, ...(list ?? [])]);
      setText('');
      setMood(null);
    } catch (err) {
      setError(err instanceof PluginRequestError ? err.message : String(err));
    }
  };

  const toNote = async (id: string) => {
    const { noteId } = await host.api<{ noteId: string }>(`/entries/${id}/note`, { method: 'POST', json: {} });
    host.toast(host.t({ de: 'Als Notiz gespeichert', en: 'Saved as a note' }));
    host.openNote(noteId);
  };

  const remove = async (id: string) => {
    await host.api(`/entries/${id}`, { method: 'DELETE' });
    setEntries((list) => (list ?? []).filter((e) => e.id !== id));
  };

  return (
    <>
      <PageHeader title={host.t({ de: 'Logbuch', en: 'Logbook' })} subtitle={host.t({ de: 'Ein Beispiel-Plugin: eigene, verschlüsselte Tabellen in Kladde', en: 'An example plugin: own, encrypted tables in Kladde' })} />
      <PageBody>
        <Panel label={host.t({ de: 'Neuer Eintrag', en: 'New entry' })}>
          <div className="flex flex-col gap-3 p-4">
            <label className="sr-only" htmlFor="logbook-text">
              {host.t({ de: 'Text', en: 'Text' })}
            </label>
            <textarea id="logbook-text" ref={input} className="input min-h-24" value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} />
            <div className="segmented self-start" role="group" aria-label={host.t({ de: 'Stimmung', en: 'Mood' })}>
              {(Object.keys(MOOD_LABEL) as (keyof typeof MOOD_LABEL)[]).map((m) => (
                <button key={m} type="button" aria-pressed={mood === m} className={mood === m ? 'bg-acc-bg text-acc-hi' : ''} onClick={() => setMood(mood === m ? null : m)}>
                  {host.t(MOOD_LABEL[m])}
                </button>
              ))}
            </div>
            {error && (
              <p className="text-body-m text-red" role="alert">
                {error}
              </p>
            )}
            <button type="button" className="btn-primary self-end" disabled={!text.trim()} onClick={() => void add()}>
              {host.t({ de: 'Speichern', en: 'Save' })}
            </button>
          </div>
        </Panel>

        <Panel className="mt-6" label={host.t({ de: 'Einträge', en: 'Entries' })}>
          {entries === null ? (
            <p className="p-4 text-body-m text-muted">…</p>
          ) : entries.length === 0 ? (
            <p className="p-4 text-body-m text-muted">{host.t({ de: 'Noch keine Einträge.', en: 'No entries yet.' })}</p>
          ) : (
            <ul className="divide-y divide-line">
              {entries.map((e) => (
                <li key={e.id} className="flex flex-wrap items-start gap-3 p-4" data-entry={e.id}>
                  <div className="min-w-0 flex-1">
                    <p className="whitespace-pre-wrap text-body-m text-body">{e.text}</p>
                    <p className="mt-1 font-mono text-caption text-muted">
                      {new Date(e.at).toLocaleString(host.lang)}
                      {e.mood ? ` · ${host.t(MOOD_LABEL[e.mood])}` : ''}
                    </p>
                  </div>
                  <button type="button" className="btn-text" onClick={() => void toNote(e.id)}>
                    {host.t({ de: 'Als Notiz', en: 'As a note' })}
                  </button>
                  <button type="button" className="btn-text text-red" onClick={() => void remove(e.id)}>
                    {host.t({ de: 'Löschen', en: 'Delete' })}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {notes.length > 0 && (
          <Panel className="mt-6" label={host.t({ de: 'Logbuch-Notizen', en: 'Logbook notes' })}>
            <ul className="divide-y divide-line">
              {notes.map((n) => (
                <li key={n.id}>
                  <button type="button" className="w-full p-4 text-left text-body-m hover:bg-line" onClick={() => host.openNote(n.id)}>
                    {n.title}
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </PageBody>
    </>
  );
}
