import { useEffect, useRef, useState } from 'react';
import { PluginRequestError, useKladde, type PluginPageProps } from '@kladde/plugin-api/client';
import { entryColumns, MOOD_LABEL, saveCell } from './entries.js';
import type { Entry } from './server.js';

/** The logbook: write an entry, see the latest ones in a table (editable on request), turn one into a note */
export function LogbookPage({ path }: PluginPageProps) {
  const host = useKladde();
  const { PageHeader, PageBody, Panel, Switch, Table } = host.ui;
  const [editing, setEditing] = useState(false);
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

  const add = async (asNote = false) => {
    setError('');
    try {
      const entry = await host.api<Entry>('/entries', { method: 'POST', json: { text, mood } });
      setEntries((list) => [entry, ...(list ?? [])]);
      setText('');
      setMood(null);
      if (asNote) await toNote(entry.id);
    } catch (err) {
      setError(err instanceof PluginRequestError ? err.message : String(err));
    }
  };

  const toNote = async (id: string) => {
    const { noteId } = await host.api<{ noteId: string }>(`/entries/${id}/note`, { method: 'POST', json: {} });
    host.toast(host.t({ de: 'Als Notiz gespeichert', en: 'Saved as a note' }));
    host.openNote(noteId);
  };

  // Errors thrown here reach the table, which shows the message and the old value again
  const change = async (id: string, key: string, value: string) => {
    const entry = await saveCell(host, id, key, value);
    setEntries((list) => (list ?? []).map((e) => (e.id === id ? entry : e)));
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
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className="btn-outlined" disabled={!text.trim()} onClick={() => void add(true)}>
                {host.t({ de: 'Als Notiz speichern', en: 'Save as a note' })}
              </button>
              <button type="button" className="btn-primary" disabled={!text.trim()} onClick={() => void add()}>
                {host.t({ de: 'Speichern', en: 'Save' })}
              </button>
            </div>
          </div>
        </Panel>

        <Panel
          className="mt-6"
          label={host.t({ de: 'Einträge', en: 'Entries' })}
          aside={
            <label htmlFor="logbook-edit" className="flex items-center gap-2 text-caption text-muted">
              {host.t({ de: 'Bearbeiten', en: 'Edit' })}
              <Switch id="logbook-edit" checked={editing} label={host.t({ de: 'Bearbeiten', en: 'Edit' })} onChange={setEditing} />
            </label>
          }
        >
          {entries === null ? (
            <p className="p-4 text-body-m text-muted">…</p>
          ) : (
            <Table
              columns={entryColumns(host)}
              rows={entries}
              rowKey="id"
              empty={{ de: 'Noch keine Einträge.', en: 'No entries yet.' }}
              editable={editing}
              onCellChange={change}
              onRemoveRow={(id) => remove(id)}
            />
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
