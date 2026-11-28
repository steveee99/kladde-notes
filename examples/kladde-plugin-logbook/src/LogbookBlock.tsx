import { useEffect, useState } from 'react';
import { useKladde, type PluginBlockProps } from '@kladde/plugin-api/client';
import { entryColumns, MOOD_ICON, saveCell } from './entries.js';
import type { Entry } from './server.js';

export interface BlockSettings {
  limit: number;
  mood: Entry['mood'];
  /** `edit: yes`: cells can be edited in the note (only while the note can be edited) */
  edit: boolean;
}

/** `limit: 5`, `mood: good` and `edit: yes` lines of the block; unknown lines are ignored */
export function parseBlock(source: string): BlockSettings {
  let limit = 5;
  let mood: Entry['mood'] = null;
  let edit = false;
  for (const line of source.split('\n')) {
    const m = /^\s*(limit|mood|edit)\s*:\s*(\S+)\s*$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === 'limit' && Number(m[2]) > 0) limit = Math.min(50, Math.floor(Number(m[2])));
    if (key === 'mood' && m[2] in MOOD_ICON) mood = m[2] as Entry['mood'];
    if (key === 'edit') edit = /^(yes|ja|true|1)$/i.test(m[2]);
  }
  return { limit, mood, edit };
}

/** The settings as block text (the way `parseBlock` reads them) */
export function blockSource({ limit, mood, edit }: BlockSettings): string {
  return [`limit: ${limit}`, mood ? `mood: ${mood}` : '', edit ? 'edit: yes' : ''].filter(Boolean).join('\n');
}

/**
 * ```logbook in a note: the latest entries in Kladde's table (`limit: 5`, optionally only one `mood:`), read-only
 * unless the block says `edit: yes` and the note can be edited. "Show more" writes a higher limit back into the
 * block through `setSource`, so the note remembers it.
 */
export function LogbookBlock({ source, setSource }: PluginBlockProps) {
  const host = useKladde();
  const { Table } = host.ui;
  const settings = parseBlock(source);
  const { limit, mood, edit } = settings;
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    host.api<Entry[]>('/entries').then(
      (list) => alive && setEntries(list),
      (err: Error) => alive && setError(err.message)
    );
    return () => {
      alive = false;
    };
  }, [host]);

  const shown = (entries ?? []).filter((e) => !mood || e.mood === mood);
  const change = async (id: string, key: string, value: string) => {
    const entry = await saveCell(host, id, key, value);
    setEntries((list) => (list ?? []).map((e) => (e.id === id ? entry : e)));
  };

  return (
    <div className="card p-3 text-body-m" data-logbook-block>
      <div className="mb-2 flex items-center gap-2">
        <span className="font-medium text-strong">{host.t({ de: 'Logbuch', en: 'Logbook' })}</span>
        <button type="button" className="btn-text ml-auto h-7 px-2 text-caption" onClick={() => host.navigate(host.href())}>
          {host.t({ de: 'Öffnen', en: 'Open' })}
        </button>
      </div>
      {error ? (
        <p className="text-red">{error}</p>
      ) : !entries ? (
        <p className="text-muted">…</p>
      ) : (
        <Table
          columns={entryColumns(host)}
          rows={shown.slice(0, limit)}
          rowKey="id"
          filter={false}
          empty={{ de: 'Noch keine Einträge.', en: 'No entries yet.' }}
          editable={edit && !!setSource}
          onCellChange={change}
        />
      )}
      {setSource && shown.length > limit && (
        <button type="button" className="btn-text mt-2 h-7 px-2 text-caption" onClick={() => setSource(blockSource({ ...settings, limit: limit + 5 }))}>
          {host.t({ de: 'Mehr zeigen', en: 'Show more' })}
        </button>
      )}
    </div>
  );
}
