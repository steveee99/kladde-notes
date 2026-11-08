import { AlertTriangle, Briefcase, CalendarCheck, Check, Inbox, Lightbulb, Target, Unlink } from 'lucide-react';
import { buildReview, splitPath } from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import { navigate } from '../lib/router';

export const REVIEW_KEY = 'lastReview';
const WEEK = 7 * 86_400_000;

export function reviewDue(): boolean {
  const last = vault.setting<number>(REVIEW_KEY);
  return !last || last < Date.now() - WEEK;
}

function Section({ icon: Icon, title, count, ok, children }: { icon: typeof Inbox; title: string; count: number; ok: string; children?: React.ReactNode }) {
  return (
    <section className="card p-5 anim-fade-up">
      <h2 className="mb-2 flex items-center gap-2 font-semibold">
        <Icon size={18} className={count ? 'text-warn' : 'text-ok'} /> {title}
        <span className={`ml-auto chip ${count ? 'text-warn' : 'text-ok'}`}>{count || <Check size={12} />}</span>
      </h2>
      {count ? children : <p className="text-sm text-muted">{ok}</p>}
    </section>
  );
}

function NoteLinks({ ids }: { ids: string[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {ids.map((id) => {
        const n = vault.get(id);
        return n ? (
          <li key={id}>
            <button className="chip px-2.5 py-1 hover:text-accent" onClick={() => navigate(`/n/${id}`)}>
              {splitPath(n.path).name}
            </button>
          </li>
        ) : null;
      })}
    </ul>
  );
}

/** Weekly review (GTD/PARA style): empty the inbox, give every project a next step, look after areas and Zettel */
export function ReviewView() {
  useVault();
  const r = buildReview(vault.list().filter((n) => n.access === 'owner'));
  const last = vault.setting<number>(REVIEW_KEY);
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-6 sm:px-8 sm:py-10">
      <div className="anim-fade-up">
        <h1 className="text-2xl font-bold tracking-tight">Wochenrückblick</h1>
        <p className="mt-1 text-muted">{last ? `Zuletzt am ${new Date(last).toLocaleDateString('de-DE', { dateStyle: 'full' })}.` : 'Noch nie gemacht – ein guter Moment.'}</p>
      </div>

      <Section icon={Inbox} title="Inbox leeren" count={r.inbox.length} ok="Die Inbox ist leer.">
        <button className="btn-primary" onClick={() => navigate('/inbox')}>
          {r.inbox.length} Einträge einsortieren
        </button>
      </Section>

      <Section icon={AlertTriangle} title="Überfällige Aufgaben" count={r.overdueTasks} ok="Nichts überfällig.">
        <button className="btn-ghost border border-line" onClick={() => navigate('/')}>
          Zu den Aufgaben
        </button>
      </Section>

      <Section icon={Briefcase} title="Projekte ohne nächsten Schritt" count={r.projectsWithoutNextStep.length} ok="Jedes aktive Projekt hat eine offene Aufgabe.">
        <p className="mb-2 text-sm text-muted">Was ist jeweils der nächste konkrete Schritt? Oder ist das Projekt fertig oder pausiert?</p>
        <NoteLinks ids={r.projectsWithoutNextStep.map((p) => p.id)} />
      </Section>

      <Section icon={Target} title="Bereiche, die länger ruhen" count={r.staleAreas.length} ok="Alle Bereiche wurden in den letzten 30 Tagen angefasst.">
        <ul className="flex flex-wrap gap-1.5">
          {r.staleAreas.map((a) => (
            <li key={a.name} className="chip px-2.5 py-1">
              {a.name} · seit {new Date(a.updatedAt).toLocaleDateString('de-DE')}
            </li>
          ))}
        </ul>
      </Section>

      <Section icon={Lightbulb} title="Flüchtige Zettel älter als eine Woche" count={r.oldFleeting.length} ok="Keine liegengebliebenen Einfälle.">
        <p className="mb-2 text-sm text-muted">Ausarbeiten (Typ „dauerhaft“) oder löschen.</p>
        <NoteLinks ids={r.oldFleeting} />
      </Section>

      <Section icon={Unlink} title="Zettel ohne Verbindung" count={r.orphanZettel.length} ok="Alle Zettel sind vernetzt.">
        <NoteLinks ids={r.orphanZettel} />
      </Section>

      <button
        className="btn-primary w-full py-3"
        onClick={() => {
          void vault.setSetting(REVIEW_KEY, Date.now());
          navigate('/');
        }}
      >
        <CalendarCheck size={18} /> Rückblick abschließen
      </button>
    </div>
  );
}
