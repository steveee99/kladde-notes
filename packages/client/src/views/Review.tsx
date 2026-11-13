import { AlertTriangle, Briefcase, CalendarCheck, Check, Inbox, Lightbulb, Settings, Target, Unlink } from '../lib/icons';
import { buildReview, projectTitleOf } from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import { locale, tl, useLang } from '../lib/i18n';
import { navigate } from '../lib/router';
import { useReadOnly } from '../lib/readOnly';

export const REVIEW_KEY = 'lastReview';
const WEEK = 7 * 86_400_000;

/** Only when the opt-in weekly review is enabled and the last one is more than a week ago */
export function reviewDue(): boolean {
  if (!vault.features().review.enabled) return false;
  const last = vault.setting<number>(REVIEW_KEY);
  return !last || last < Date.now() - WEEK;
}

function Section({ icon: Icon, title, count, ok, children }: { icon: typeof Inbox; title: string; count: number; ok: string; children?: React.ReactNode }) {
  return (
    <section className="card p-5 anim-fade-up">
      <h2 className="mb-2 flex items-center gap-2 font-medium">
        <Icon size={18} className={`shrink-0 ${count ? 'text-warn' : 'text-ok'}`} />
        <span className="min-w-0 flex-1">{title}</span>
        <span className={`chip ml-auto shrink-0 ${count ? 'text-warn' : 'text-ok'}`}>{count || <Check size={12} />}</span>
      </h2>
      {count ? children : <p className="text-sm text-on-surface-variant">{ok}</p>}
    </section>
  );
}

function NoteLinks({ ids }: { ids: string[] }) {
  const rc = vault.roleConfig();
  return (
    <ul className="flex flex-wrap gap-1.5">
      {ids.map((id) => {
        const n = vault.get(id);
        return n ? (
          <li key={id} className="max-w-full">
            <button className="chip max-w-full px-3 py-1" onClick={() => navigate(`/n/${id}`)}>
              <span className="truncate">{projectTitleOf(n.path, n.content, rc)}</span>
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
  const locked = useReadOnly();
  const features = vault.features();
  if (!features.review.enabled) {
    return (
      <div className="content-container mx-auto px-4 py-6 sm:px-8 sm:py-10">
        <div className="card max-w-lg space-y-4 p-6 anim-fade-up">
          <div className="flex items-center gap-2 text-lg font-medium">
            <CalendarCheck size={20} className="shrink-0 text-primary" />
            {tl(lang, 'review.optInTitle')}
          </div>
          <p className="text-sm text-on-surface-variant">{tl(lang, 'review.optInDesc')}</p>
          <div className="flex flex-wrap gap-2">
            {!locked && (
              <button className="btn-primary" onClick={() => void vault.updateFeatures({ ...features, review: { enabled: true } })}>
                {tl(lang, 'review.enableBtn')}
              </button>
            )}
            <button className="btn-ghost border border-outline-variant" onClick={() => navigate('/settings')}>
              <Settings size={16} /> {tl(lang, 'daily.openSettings')}
            </button>
          </div>
        </div>
      </div>
    );
  }
  const r = buildReview(vault.list().filter((n) => n.access === 'owner'), Date.now(), 30, vault.roleConfig());
  const last = vault.setting<number>(REVIEW_KEY);
  return (
    <div className="content-container space-y-4 px-4 py-6 sm:px-8 sm:py-10">
      <div className="anim-fade-up">
        <h1 className="text-headline-m">{tl(lang, 'review.title')}</h1>
        <p className="mt-1 text-on-surface-variant">
          {last ? tl(lang, 'review.lastDone', { date: new Date(last).toLocaleDateString(loc, { dateStyle: 'full' }) }) : tl(lang, 'review.neverDone')}
        </p>
      </div>

      <Section icon={Inbox} title={tl(lang, 'review.inboxTitle')} count={r.inbox.length} ok={tl(lang, 'review.inboxOk')}>
        <button className="btn-primary rounded-full px-4" onClick={() => navigate('/inbox')}>
          {tl(lang, 'review.inboxAction', { n: r.inbox.length })}
        </button>
      </Section>

      <Section icon={AlertTriangle} title={tl(lang, 'review.overdueTitle')} count={r.overdueTasks} ok={tl(lang, 'review.overdueOk')}>
        <button className="btn-ghost rounded-full border border-outline-variant px-4" onClick={() => navigate('/')}>
          {tl(lang, 'review.overdueAction')}
        </button>
      </Section>

      {features.para.enabled && (
        <>
          <Section icon={Briefcase} title={tl(lang, 'review.projectsTitle')} count={r.projectsWithoutNextStep.length} ok={tl(lang, 'review.projectsOk')}>
            <p className="mb-2 text-sm text-on-surface-variant">{tl(lang, 'review.projectsHint')}</p>
            <NoteLinks ids={r.projectsWithoutNextStep.map((p) => p.id)} />
          </Section>

          <Section icon={Target} title={tl(lang, 'review.areasTitle')} count={r.staleAreas.length} ok={tl(lang, 'review.areasOk')}>
            <ul className="flex flex-wrap gap-1.5">
              {r.staleAreas.map((a) => (
                <li key={a.name} className="chip max-w-full px-3 py-1">
                  <span className="truncate">{a.name} · {tl(lang, 'review.areasSince', { date: new Date(a.updatedAt).toLocaleDateString(loc) })}</span>
                </li>
              ))}
            </ul>
          </Section>
        </>
      )}

      {features.zettel.enabled && (
        <>
          <Section icon={Lightbulb} title={tl(lang, 'review.fleetingTitle')} count={r.oldFleeting.length} ok={tl(lang, 'review.fleetingOk')}>
            <p className="mb-2 text-sm text-on-surface-variant">{tl(lang, 'review.fleetingHint')}</p>
            <NoteLinks ids={r.oldFleeting} />
          </Section>

          <Section icon={Unlink} title={tl(lang, 'review.orphansTitle')} count={r.orphanZettel.length} ok={tl(lang, 'review.orphansOk')}>
            <NoteLinks ids={r.orphanZettel} />
          </Section>
        </>
      )}

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
