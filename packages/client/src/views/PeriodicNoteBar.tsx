import { useEffect, useMemo } from 'react';
import { CalendarDays, CalendarRange, ChevronLeft, ChevronRight, FilePlus2, Settings } from '../lib/icons';
import { isoWeek, isValidDateString, parseDate, periodEnd, periodStart, shiftPeriod, toDateString, type PeriodKind } from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import { folderDisplayName, locale, tl, useLang, type Lang } from '../lib/i18n';
import { isReadOnly, useReadOnly } from '../lib/readOnly';
import { navigate } from '../lib/router';

/** Route of a weekly or monthly note that may not exist yet (#73) */
export const periodRoute = (kind: PeriodKind, date: string) => `/${kind}/${periodStart(kind, date)}`;

/** Opens the note of the period, or its empty page when it does not exist (nothing is created by browsing) */
export function goToPeriod(kind: PeriodKind, date: string) {
  const existing = vault.findPeriodicNote(kind, date);
  navigate(existing ? `/n/${existing.id}` : periodRoute(kind, date));
}

/** Opens this week's or month's note, creating it (Ctrl/⌘+Alt+W, Ctrl/⌘+Alt+M, the weekly review) */
export async function openThisPeriod(kind: PeriodKind): Promise<void> {
  const today = toDateString(new Date());
  if (!vault.periodSettings(kind).enabled || isReadOnly()) {
    goToPeriod(kind, today);
    return;
  }
  const note = await vault.openPeriodicNote(kind, today);
  navigate(`/n/${note.id}`);
}

/** "Week 47 · Nov 16 – 22, 2026" or "November 2026" */
export function periodTitle(kind: PeriodKind, date: string, lang: Lang): string {
  const loc = locale(lang);
  const start = parseDate(periodStart(kind, date));
  if (kind === 'month') return new Intl.DateTimeFormat(loc, { month: 'long', year: 'numeric' }).format(start);
  const end = parseDate(periodEnd(kind, date));
  const range = new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short', year: 'numeric' }).formatRange(start, end);
  return `${tl(lang, 'periodic.weekShort', { n: isoWeek(start) })} · ${range}`;
}

/** Chips that lead from a day or week to the note of its week and month (#73) */
export function PeriodLinks({ date, kinds }: { date: string; kinds: PeriodKind[] }) {
  useVault();
  const lang = useLang();
  const shown = kinds.filter((k) => vault.periodSettings(k).enabled);
  if (!shown.length) return null;
  return (
    <>
      {shown.map((kind) => {
        const exists = !!vault.findPeriodicNote(kind, date);
        const label = kind === 'week' ? tl(lang, 'periodic.weekShort', { n: isoWeek(parseDate(date)) }) : new Intl.DateTimeFormat(locale(lang), { month: 'long' }).format(parseDate(date));
        return (
          <button
            key={kind}
            type="button"
            data-period-link={kind}
            className={`chip h-10 px-3 ${exists ? 'text-primary' : 'text-on-surface-variant'}`}
            title={tl(lang, kind === 'week' ? 'periodic.openWeek' : 'periodic.openMonth')}
            onClick={() => goToPeriod(kind, date)}
          >
            {kind === 'week' ? <CalendarRange size={14} /> : <CalendarDays size={14} />}
            <span className="capitalize">{label}</span>
          </button>
        );
      })}
    </>
  );
}

/** Previous/next, "this week"/"this month" and the link to the month above, shown on weekly and monthly notes */
export function PeriodicNoteBar({ kind, date }: { kind: PeriodKind; date: string }) {
  useVault();
  const lang = useLang();
  const today = toDateString(new Date());
  const current = periodStart(kind, today) === periodStart(kind, date);
  const prev = shiftPeriod(kind, date, -1);
  const next = shiftPeriod(kind, date, 1);
  const prevLabel = tl(lang, kind === 'week' ? 'periodic.prevWeek' : 'periodic.prevMonth', { period: periodTitle(kind, prev, lang) });
  const nextLabel = tl(lang, kind === 'week' ? 'periodic.nextWeek' : 'periodic.nextMonth', { period: periodTitle(kind, next, lang) });
  const step = 'inline-flex h-10 w-10 shrink-0 items-center justify-center text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface active:scale-95';
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 anim-fade-in" data-periodic-bar={kind}>
      <div role="group" aria-label={tl(lang, kind === 'week' ? 'periodic.weekNavAria' : 'periodic.monthNavAria')} className="inline-flex max-w-full items-center overflow-hidden rounded-xl border border-outline-variant bg-surface-container-low">
        <button type="button" className={step} title={prevLabel} aria-label={prevLabel} onClick={() => goToPeriod(kind, prev)}>
          <ChevronLeft size={18} />
        </button>
        <span aria-hidden="true" className="h-5 w-px shrink-0 bg-outline-variant" />
        <span className="inline-flex h-10 min-w-0 items-center gap-2 px-3 text-sm font-medium">
          {kind === 'week' ? <CalendarRange size={16} className="shrink-0 text-primary" /> : <CalendarDays size={16} className="shrink-0 text-primary" />}
          <span className="truncate capitalize">{periodTitle(kind, date, lang)}</span>
        </span>
        <span aria-hidden="true" className="h-5 w-px shrink-0 bg-outline-variant" />
        <button type="button" className={step} title={nextLabel} aria-label={nextLabel} onClick={() => goToPeriod(kind, next)}>
          <ChevronRight size={18} />
        </button>
      </div>
      {!current && (
        <button type="button" className="chip h-10 px-3 text-primary" onClick={() => goToPeriod(kind, today)}>
          {tl(lang, kind === 'week' ? 'periodic.thisWeek' : 'periodic.thisMonth')}
        </button>
      )}
      {kind === 'week' && <PeriodLinks date={date} kinds={['month']} />}
    </div>
  );
}

/** `/week/:date` and `/month/:date`: the period has no note yet (or the feature is off) */
export function PeriodicEmptyView({ kind, date }: { kind: PeriodKind; date?: string }) {
  useVault();
  const lang = useLang();
  const locked = useReadOnly();
  const settings = vault.periodSettings(kind);
  const target = periodStart(kind, date && isValidDateString(date) ? date : toDateString(new Date()));
  const existing = settings.enabled ? vault.findPeriodicNote(kind, target) : undefined;
  const title = useMemo(() => periodTitle(kind, target, lang), [kind, target, lang]);
  useEffect(() => {
    if (existing) navigate(`/n/${existing.id}`, true);
  }, [existing?.id]);
  if (existing) return null;
  const create = async () => {
    const note = await vault.openPeriodicNote(kind, target);
    navigate(`/n/${note.id}`, true);
  };
  return (
    <div className="content-container mx-auto px-4 py-6 sm:px-8 sm:py-10">
      {settings.enabled && <PeriodicNoteBar kind={kind} date={target} />}
      <div className="card max-w-xl space-y-4 p-6 anim-fade-up">
        <div>
          <p className="text-title-s text-on-surface-variant">
            {tl(lang, kind === 'week' ? 'periodic.weekLabel' : 'periodic.monthLabel')} ·{' '}
            {settings.folder ? folderDisplayName(settings.folder, lang) : tl(lang, 'common.topLevelPlain')}
          </p>
          <h1 className="mt-1 text-headline-m capitalize">{title}</h1>
        </div>
        <p className="text-sm text-on-surface-variant">
          {tl(lang, settings.enabled ? (kind === 'week' ? 'periodic.emptyWeek' : 'periodic.emptyMonth') : kind === 'week' ? 'periodic.weekOff' : 'periodic.monthOff')}
        </p>
        <div className="flex flex-wrap gap-2">
          {settings.enabled && !locked && (
            <button className="btn-primary" onClick={() => void create()}>
              <FilePlus2 size={16} /> {tl(lang, kind === 'week' ? 'periodic.createWeek' : 'periodic.createMonth')}
            </button>
          )}
          {!settings.enabled && (
            <button className="btn-ghost border border-outline-variant" onClick={() => navigate('/settings')}>
              <Settings size={16} /> {tl(lang, 'daily.openSettings')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
