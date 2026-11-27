import { useEffect, useState } from 'react';
import { useKladde, type PluginBlockProps } from '@kladde/plugin-api/client';
import type { Entry } from './server.js';

const MOODS = { good: '🙂', okay: '😐', bad: '🙁' } as const;

/** `limit: 5` and `mood: good` lines of the block; unknown lines are ignored */
export function parseBlock(source: string): { limit: number; mood: Entry['mood'] } {
  let limit = 5;
  let mood: Entry['mood'] = null;
  for (const line of source.split('\n')) {
    const m = /^\s*(limit|mood)\s*:\s*(\S+)\s*$/i.exec(line);
    if (!m) continue;
    if (m[1].toLowerCase() === 'limit' && Number(m[2]) > 0) limit = Math.min(50, Math.floor(Number(m[2])));
    if (m[1].toLowerCase() === 'mood' && m[2] in MOODS) mood = m[2] as Entry['mood'];
  }
  return { limit, mood };
}

/**
 * ```logbook in a note: the latest entries (`limit: 5`, optionally only one `mood:`). "Show more" writes a higher
 * limit back into the block through `setSource`, so the note remembers it.
 */
export function LogbookBlock({ source, setSource }: PluginBlockProps) {
  const host = useKladde();
  const { limit, mood } = parseBlock(source);
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
      ) : shown.length === 0 ? (
        <p className="text-muted">{host.t({ de: 'Noch keine Einträge.', en: 'No entries yet.' })}</p>
      ) : (
        <ul className="space-y-1">
          {shown.slice(0, limit).map((e) => (
            <li key={e.id} className="flex gap-2">
              <span aria-hidden>{e.mood ? MOODS[e.mood] : '·'}</span>
              <span className="min-w-0 flex-1 break-words">{e.text}</span>
              <time className="shrink-0 font-mono text-caption text-faint">{new Date(e.at).toLocaleDateString(host.lang)}</time>
            </li>
          ))}
        </ul>
      )}
      {setSource && shown.length > limit && (
        <button type="button" className="btn-text mt-2 h-7 px-2 text-caption" onClick={() => setSource(`limit: ${limit + 5}${mood ? `\nmood: ${mood}` : ''}`)}>
          {host.t({ de: 'Mehr zeigen', en: 'Show more' })}
        </button>
      )}
    </div>
  );
}
