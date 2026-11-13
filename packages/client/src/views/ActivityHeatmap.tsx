import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Maximize2, Settings } from '../lib/icons';
import { computeHeatmapData, HeatmapCell, HeatmapRange, parseDate } from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import { heatmapWeekdayLabels, locale, tl, useLang } from '../lib/i18n';
import { useReadOnly } from '../lib/readOnly';
import { navigate } from '../lib/router';
import { Dropdown, DropdownOption } from './Dropdown';

const CELL_PX = 12;
const GAP_PX = 3;
const COL_STEP = CELL_PX + GAP_PX;

/**
 * GitHub-style activity heatmap calendar.
 * Day cells only open/create Daily Notes when Daily Notes are active (`features.daily.enabled`).
 */
export function ActivityHeatmap({ embedded = false }: { embedded?: boolean }) {
  const version = useVault();
  const lang = useLang();
  const loc = locale(lang);
  const locked = useReadOnly();
  const { daily } = vault.features();
  const [period, setPeriod] = useState<string>('rolling');
  const [inspectCell, setInspectCell] = useState<HeatmapCell | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const infoDateFmt = useMemo(() => new Intl.DateTimeFormat(loc, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }), [loc]);
  const weekdayLabels = heatmapWeekdayLabels(lang);

  const formatActivityText = useCallback(
    (cell: HeatmapCell): string => {
      const dateLabel = infoDateFmt.format(parseDate(cell.date));
      const countLabel =
        cell.count === 0
          ? tl(lang, 'heatmap.emptyActivity')
          : cell.count === 1
            ? tl(lang, 'heatmap.oneNote')
            : tl(lang, 'heatmap.manyNotes', { n: cell.count });
      return `${dateLabel}: ${countLabel}${cell.hasDaily ? tl(lang, 'heatmap.hasDailySuffix') : ''}`;
    },
    [infoDateFmt, lang]
  );

  const range: HeatmapRange = useMemo(() => {
    if (period.startsWith('year:')) {
      const year = Number(period.slice(5));
      if (Number.isFinite(year)) return { mode: 'year', year };
    }
    return { mode: 'rolling' };
  }, [period]);

  const ownNotes = useMemo(
    () => vault.list().filter((n) => n.access === 'owner'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version]
  );

  const data = useMemo(
    () => computeHeatmapData(ownNotes, daily, range, new Date(), lang),
    [ownNotes, daily.folder, daily.format, range, lang]
  );

  const periodOptions: DropdownOption[] = useMemo(
    () => [
      { value: 'rolling', label: tl(lang, 'heatmap.rolling12m') },
      ...data.availableYears.map((y) => ({ value: `year:${y}`, label: String(y) })),
    ],
    [data.availableYears, lang]
  );

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || range.mode !== 'rolling') return;
    el.scrollLeft = el.scrollWidth;
  }, [range.mode, data.weeks.length]);

  const openDay = async (dateStr: string) => {
    if (!daily.enabled) return;
    if (!locked) {
      const note = await vault.openDailyNote(dateStr);
      navigate(`/n/${note.id}`);
      return;
    }
    const existing = vault.findDailyNote(dateStr);
    if (existing) navigate(`/n/${existing.id}`);
    else navigate(`/daily/${dateStr}`);
  };

  const gridWidth = Math.max(1, data.weeks.length * COL_STEP - GAP_PX);
  const activeBadgeText =
    data.activeDays === 1 ? tl(lang, 'heatmap.activeDaySingle') : tl(lang, 'heatmap.activeDays', { n: data.activeDays });

  return (
    <section className="card p-4 sm:p-5 anim-fade-up" aria-label={tl(lang, 'heatmap.regionAria')}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 basis-40 items-center gap-2">
          <CalendarDays size={18} className="shrink-0 text-ok" />
          <h2 className="truncate font-medium">{tl(lang, 'heatmap.title')}</h2>
          <span className="chip shrink-0">{activeBadgeText}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Dropdown
            variant="chip"
            value={period}
            options={periodOptions}
            onChange={setPeriod}
            aria-label={tl(lang, 'heatmap.periodAria')}
          />
          {embedded && (
            <button
              type="button"
              className="btn-icon h-8 w-8 shrink-0"
              title={tl(lang, 'heatmap.openFullTitle')}
              aria-label={tl(lang, 'heatmap.openFullTitle')}
              onClick={() => navigate('/calendar')}
            >
              <Maximize2 size={15} />
            </button>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="overflow-x-auto pb-1 scrollbar-thin" onMouseLeave={() => setInspectCell(null)}>
        <div className="inline-flex min-w-max items-start gap-2">
          <div className="flex shrink-0 flex-col gap-[3px] pt-[20px] text-[10px] leading-[12px] text-on-surface-variant select-none">
            {weekdayLabels.map((label, i) => (
              <span key={i} className="h-[12px] w-5 text-right">
                {label}
              </span>
            ))}
          </div>

          <div>
            <div className="relative mb-1.5 h-[14px] text-[10px] leading-[14px] text-on-surface-variant select-none" style={{ width: `${gridWidth}px` }}>
              {data.monthLabels.map((m) => (
                <span key={`${m.weekIndex}-${m.label}`} className="absolute top-0 whitespace-nowrap" style={{ left: `${m.weekIndex * COL_STEP}px` }}>
                  {m.label}
                </span>
              ))}
            </div>

            <div className="flex gap-[3px]" role="grid" aria-label={tl(lang, 'heatmap.gridAria')}>
              {data.weeks.map((week, wIdx) => (
                <div key={wIdx} className="flex flex-col gap-[3px]">
                  {week.map((cell) => {
                    if (!cell.inRange) {
                      return <span key={cell.date} className="block h-[12px] w-[12px] shrink-0" aria-hidden="true" />;
                    }
                    const tip = formatActivityText(cell);
                    if (daily.enabled) {
                      return (
                        <button
                          key={cell.date}
                          type="button"
                          data-heatmap-cell="true"
                          data-date={cell.date}
                          data-level={cell.level}
                          data-daily-click="active"
                          title={`${tip} · ${tl(lang, 'heatmap.clickOpensTitle')}`}
                          aria-label={`${tip} · ${tl(lang, 'heatmap.clickOpensAria')}`}
                          onMouseEnter={() => setInspectCell(cell)}
                          onFocus={() => setInspectCell(cell)}
                          onClick={() => void openDay(cell.date)}
                          className="heatmap-cell h-[12px] w-[12px] shrink-0 cursor-pointer hover:ring-2 hover:ring-primary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        />
                      );
                    }
                    return (
                      <div
                        key={cell.date}
                        role="img"
                        data-heatmap-cell="true"
                        data-date={cell.date}
                        data-level={cell.level}
                        data-daily-click="inactive"
                        aria-disabled="true"
                        title={tip}
                        aria-label={tip}
                        onMouseEnter={() => setInspectCell(cell)}
                        onTouchStart={() => setInspectCell(cell)}
                        className="heatmap-cell h-[12px] w-[12px] shrink-0 cursor-default"
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-on-surface-variant">
        <span className="min-w-0 break-words">
          {inspectCell
            ? formatActivityText(inspectCell)
            : daily.enabled
              ? tl(lang, 'heatmap.hintClickActive')
              : tl(lang, 'heatmap.hintClickInactive')}
        </span>
        <div className="flex shrink-0 items-center gap-1 text-[11px] text-on-surface-variant" aria-label={tl(lang, 'heatmap.legendAria')}>
          <span>{tl(lang, 'heatmap.less')}</span>
          {([0, 1, 2, 3, 4] as const).map((lvl) => (
            <span key={lvl} className="heatmap-cell inline-block h-[11px] w-[11px]" data-level={lvl} />
          ))}
          <span>{tl(lang, 'heatmap.more')}</span>
        </div>
      </div>
    </section>
  );
}

/** Dedicated `/calendar` page with opt-in gate when the heatmap feature is disabled. */
export function CalendarView() {
  useVault();
  const lang = useLang();
  const locked = useReadOnly();
  const features = vault.features();
  const { heatmap, daily } = features;

  if (!heatmap.enabled) {
    return (
      <div className="content-container mx-auto px-4 py-6 sm:px-8 sm:py-10">
        <div className="card max-w-lg space-y-4 p-6 anim-fade-up">
          <div className="flex items-center gap-2 text-lg font-medium">
            <CalendarDays size={20} className="shrink-0 text-ok" />
            {tl(lang, 'heatmap.optInTitle')}
          </div>
          <p className="text-sm text-on-surface-variant">{tl(lang, 'heatmap.optInDesc')}</p>
          <div className="flex flex-wrap gap-2">
            {!locked && (
              <button
                className="btn-primary"
                onClick={() => void vault.updateFeatures({ ...features, heatmap: { enabled: true } })}
              >
                {tl(lang, 'heatmap.enableBtn')}
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

  return (
    <div className="content-container mx-auto space-y-5 px-4 py-6 sm:px-8 sm:py-10">
      <header className="anim-fade-up">
        <h1 className="text-headline-m">{tl(lang, 'heatmap.title')}</h1>
        <p className="mt-1 text-sm text-on-surface-variant">
          {daily.enabled ? tl(lang, 'heatmap.subtitleDailyOn') : tl(lang, 'heatmap.subtitleDailyOff')}
        </p>
      </header>

      <ActivityHeatmap />

      {!daily.enabled && (
        <div className="card flex flex-wrap items-center justify-between gap-3 p-4 text-sm anim-fade-up">
          <span className="min-w-0 flex-1 text-on-surface-variant">{tl(lang, 'heatmap.dailyDisabledNotice')}</span>
          <button className="btn-ghost shrink-0 border border-outline-variant" onClick={() => navigate('/settings')}>
            <Settings size={15} /> {tl(lang, 'heatmap.openSettingsBtn')}
          </button>
        </div>
      )}
    </div>
  );
}
