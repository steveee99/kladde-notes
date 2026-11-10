import { AlertTriangle, Briefcase, CalendarCheck, Check, Inbox, Lightbulb, Target, Unlink } from 'lucide-react';
import { buildReview, splitPath } from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import { locale, tl, useLang } from '../lib/i18n';
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
            <button className="chip px-3 py-1 hover:text-accent" onClick={() => navigate(`/n/${id}`)}>
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
  const lang = useLang();
  const loc = locale(lang);
  const r = buildReview(vault.list().filter((n) => n.access === 'owner'));
  const last = vault.setting<number>(REVIEW_KEY);
  return (
    <div className="content-container space-y-4 px-4 py-6 sm:px-8 sm:py-10">
      <div className="anim-fade-up">
        <h1 className="text-2xl font-bold tracking-tight">{tl(lang, 'review.title')}</h1>
        <p className="mt-1 text-muted">
          {last ? tl(lang, 'review.lastDone', { date: new Date(last).toLocaleDateString(loc, { dateStyle: 'full' }) }) : tl(lang, 'review.neverDone')}
        </p>
      </div>

      <Section icon={Inbox} title={tl(lang, 'review.inboxTitle')} count={r.inbox.length} ok={tl(lang, 'review.inboxOk')}>
        <button className="btn-primary rounded-full px-4" onClick={() => navigate('/inbox')}>
          {tl(lang, 'review.inboxAction', { n: r.inbox.length })}
        </button>
      </Section>

      <Section icon={AlertTriangle} title={tl(lang, 'review.overdueTitle')} count={r.overdueTasks} ok={tl(lang, 'review.overdueOk')}>
        <button className="btn-ghost rounded-full border border-line px-4" onClick={() => navigate('/')}>
          {tl(lang, 'review.overdueAction')}
        </button>
      </Section>

      <Section icon={Briefcase} title={tl(lang, 'review.projectsTitle')} count={r.projectsWithoutNextStep.length} ok={tl(lang, 'review.projectsOk')}>
        <p className="mb-2 text-sm text-muted">{tl(lang, 'review.projectsHint')}</p>
        <NoteLinks ids={r.projectsWithoutNextStep.map((p) => p.id)} />
      </Section>

      <Section icon={Target} title={tl(lang, 'review.areasTitle')} count={r.staleAreas.length} ok={tl(lang, 'review.areasOk')}>
        <ul className="flex flex-wrap gap-1.5">
          {r.staleAreas.map((a) => (
            <li key={a.name} className="chip px-3 py-1">
              {a.name} · {tl(lang, 'review.areasSince', { date: new Date(a.updatedAt).toLocaleDateString(loc) })}
            </li>
          ))}
        </ul>
      </Section>

      <Section icon={Lightbulb} title={tl(lang, 'review.fleetingTitle')} count={r.oldFleeting.length} ok={tl(lang, 'review.fleetingOk')}>
        <p className="mb-2 text-sm text-muted">{tl(lang, 'review.fleetingHint')}</p>
        <NoteLinks ids={r.oldFleeting} />
      </Section>

      <Section icon={Unlink} title={tl(lang, 'review.orphansTitle')} count={r.orphanZettel.length} ok={tl(lang, 'review.orphansOk')}>
        <NoteLinks ids={r.orphanZettel} />
      </Section>

      <button
        className="btn-primary w-full rounded-full py-3"
        onClick={() => {
          void vault.setSetting(REVIEW_KEY, Date.now());
          navigate('/');
        }}
      >
        <CalendarCheck size={18} /> {tl(lang, 'review.finishBtn')}
      </button>
    </div>
  );
}
