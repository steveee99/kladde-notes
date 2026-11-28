import { useKladde, type PluginInspectorProps } from '@kladde/plugin-api/client';
import { MOOD_ICON, MOOD_LABEL, moodOfNote } from './entries.js';

/** Inspector tab next to a logbook note: its mood and the other logbook notes (plugin API 1.3) */
export function LogbookInspector({ note }: PluginInspectorProps) {
  const host = useKladde();
  host.useNotesVersion();
  const mood = moodOfNote(note.content);
  const others = host.notes
    .list({ type: 'plugin:logbook:entry' })
    .filter((n) => n.id !== note.id)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 10);

  return (
    <div className="flex flex-col gap-4 px-2">
      <section>
        <h3 className="mb-1 text-title-s text-muted">{host.t({ de: 'Stimmung', en: 'Mood' })}</h3>
        <p className="text-body-m text-text">{mood ? `${MOOD_ICON[mood]} ${host.t(MOOD_LABEL[mood])}` : host.t({ de: 'Keine angegeben', en: 'None given' })}</p>
      </section>
      <section>
        <h3 className="mb-1 text-title-s text-muted">{host.t({ de: 'Weitere Logbuch-Notizen', en: 'Other logbook notes' })}</h3>
        {others.length === 0 ? (
          <p className="text-body-m text-muted">{host.t({ de: 'Noch keine.', en: 'None yet.' })}</p>
        ) : (
          <ul className="flex flex-col">
            {others.map((n) => (
              <li key={n.id}>
                <button type="button" className="w-full rounded-md px-2 py-1.5 text-left text-body-m hover:bg-line" onClick={() => host.openNote(n.id)}>
                  {n.title}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <button type="button" className="btn-text self-start" onClick={() => host.navigate(host.href())}>
        {host.t({ de: 'Logbuch öffnen', en: 'Open the logbook' })}
      </button>
    </div>
  );
}
