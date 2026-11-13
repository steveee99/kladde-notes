import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownToLine, CalendarDays, ChevronLeft, ChevronRight, FilePlus2, FileText, ListTodo, Settings } from '../lib/icons';
import {
  createDailyDateExtractor,
  isValidDateString,
  parseDate,
  parseTasks,
  projectTitleOf,
  shiftDateString,
  splitPath,
  toDateString,
} from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import { folderDisplayName, locale, tl, useLang, weekdaysShort } from '../lib/i18n';
import { useReadOnly } from '../lib/readOnly';
import { navigate } from '../lib/router';
import { editorHost } from '../editor/host';

interface PopoverCoords {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
}

function buildCalendarGrid(viewYear: number, viewMonth: number): { dateStr: string; day: number; inMonth: boolean }[] {
  const first = new Date(viewYear, viewMonth, 1);
  const startMonOffset = (first.getDay() + 6) % 7;
  const cursor = new Date(viewYear, viewMonth, 1 - startMonOffset);
  const days: { dateStr: string; day: number; inMonth: boolean }[] = [];
  for (let i = 0; i < 42; i++) {
    days.push({
      dateStr: toDateString(cursor),
      day: cursor.getDate(),
      inMonth: cursor.getMonth() === viewMonth,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

/**
 * Daily note day switcher in `<-- | Datepicker mit Ausgewählt | -->` form with an M3 calendar popover.
 */
export function DailyNoteBar({ date }: { date: string }) {
  const version = useVault();
  const lang = useLang();
  const loc = locale(lang);
  const locked = useReadOnly();
  const { daily } = vault.features();
  const [open, setOpen] = useState(false);
  const selectedObj = parseDate(date);
  const [viewMonth, setViewMonth] = useState(() => ({ year: selectedObj.getFullYear(), month: selectedObj.getMonth() }));
  const [coords, setCoords] = useState<PopoverCoords | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const monthFmt = useMemo(() => new Intl.DateTimeFormat(loc, { month: 'long', year: 'numeric' }), [loc]);
  const triggerFmt = useMemo(() => new Intl.DateTimeFormat(loc, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }), [loc]);
  const longDateFmt = useMemo(() => new Intl.DateTimeFormat(loc, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }), [loc]);
  const shortDateFmt = useMemo(() => new Intl.DateTimeFormat(loc, { day: '2-digit', month: '2-digit', year: 'numeric' }), [loc]);
  const weekdays = weekdaysShort(lang);

  const todayStr = toDateString(new Date());
  const prevDate = shiftDateString(date, -1);
  const nextDate = shiftDateString(date, 1);

  const extractDaily = useMemo(() => createDailyDateExtractor(daily), [daily.folder, daily.format]);

  const existingDailyDates = useMemo(() => {
    const set = new Set<string>();
    for (const n of vault.list()) {
      if (n.access !== 'owner') continue;
      const d = extractDaily(n.path);
      if (d) set.add(d);
    }
    return set;
  }, [extractDaily, version]);

  useEffect(() => {
    const d = parseDate(date);
    setViewMonth({ year: d.getFullYear(), month: d.getMonth() });
  }, [date]);

  const updatePosition = () => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vv = window.visualViewport;
    const vpLeft = vv?.offsetLeft ?? 0;
    const vpTop = vv?.offsetTop ?? 0;
    const vpWidth = vv?.width ?? window.innerWidth;
    const vpHeight = vv?.height ?? window.innerHeight;
    const margin = 8;
    const width = Math.min(308, Math.max(256, vpWidth - margin * 2));
    const left = Math.max(vpLeft + margin, Math.min(rect.left, vpLeft + vpWidth - width - margin));
    const spaceBelow = vpTop + vpHeight - rect.bottom - margin;
    const spaceAbove = rect.top - vpTop - margin;
    const popHeight = 352;
    if (spaceBelow < popHeight && spaceAbove > spaceBelow) {
      setCoords({ bottom: window.innerHeight - rect.top + 8, left, width });
    } else {
      setCoords({ top: rect.bottom + 8, left, width });
    }
  };

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    updatePosition();
    const raf = requestAnimationFrame(updatePosition);
    return () => cancelAnimationFrame(raf);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const anchorRect = triggerRef.current?.getBoundingClientRect();
    const anchorTop = anchorRect?.top ?? 0;
    const anchorLeft = anchorRect?.left ?? 0;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onResize = () => updatePosition();
    const onScroll = (e: Event) => {
      const target = e.target;
      if (target instanceof Node && popoverRef.current?.contains(target)) return;
      if (target === document || target === window || (target instanceof Element && target.contains(triggerRef.current))) {
        const now = triggerRef.current?.getBoundingClientRect();
        if (now && Math.abs(now.top - anchorTop) < 6 && Math.abs(now.left - anchorLeft) < 6) return;
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    window.visualViewport?.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
      window.visualViewport?.removeEventListener('resize', onResize);
    };
  }, [open]);

  const goToDate = (targetDate: string) => {
    setOpen(false);
    const existing = vault.findDailyNote(targetDate);
    if (existing) navigate(`/n/${existing.id}`);
    else navigate(`/daily/${targetDate}`);
  };

  const openToday = async () => {
    setOpen(false);
    if (!locked && daily.enabled) {
      const note = await vault.openDailyNote(todayStr);
      navigate(`/n/${note.id}`);
    } else {
      goToDate(todayStr);
    }
  };

  const stepMonth = (delta: number) => {
    setViewMonth((cur) => {
      const d = new Date(cur.year, cur.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  };

  const grid = useMemo(() => buildCalendarGrid(viewMonth.year, viewMonth.month), [viewMonth.year, viewMonth.month]);
  const prevLabel = tl(lang, 'daily.prevDay', { date: shortDateFmt.format(parseDate(prevDate)) });
  const nextLabel = tl(lang, 'daily.nextDay', { date: shortDateFmt.format(parseDate(nextDate)) });

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 anim-fade-in">
      <div role="group" aria-label={tl(lang, 'daily.navAria')} className="inline-flex max-w-full items-center overflow-hidden rounded-xl border border-outline-variant bg-surface-container-low">
        <button
          type="button"
          onClick={() => goToDate(prevDate)}
          title={prevLabel}
          aria-label={prevLabel}
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface active:scale-95"
        >
          <ChevronLeft size={18} />
        </button>
        <span aria-hidden="true" className="h-5 w-px shrink-0 bg-outline-variant" />
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={tl(lang, 'daily.pickDateAria', { date: longDateFmt.format(selectedObj) })}
          onClick={() => setOpen((v) => !v)}
          className={`inline-flex h-10 min-w-0 items-center gap-2 px-3 text-sm font-medium transition-colors hover:bg-surface-container-high ${open ? 'bg-primary/12 text-primary' : 'text-on-surface'}`}
        >
          <CalendarDays size={16} className="shrink-0 text-primary" />
          <span className="truncate">{triggerFmt.format(selectedObj)}</span>
        </button>
        <span aria-hidden="true" className="h-5 w-px shrink-0 bg-outline-variant" />
        <button
          type="button"
          onClick={() => goToDate(nextDate)}
          title={nextLabel}
          aria-label={nextLabel}
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface active:scale-95"
        >
          <ChevronRight size={18} />
        </button>
      </div>

      {date !== todayStr && (
        <button type="button" onClick={() => void openToday()} className="chip h-10 px-3 text-primary">
          {tl(lang, 'daily.todayChip')}
        </button>
      )}

      {open &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label={tl(lang, 'daily.pickDateDialogAria')}
            data-m3-menu="true"
            style={
              coords
                ? {
                    position: 'fixed',
                    left: `${coords.left}px`,
                    width: `${coords.width}px`,
                    ...(coords.top !== undefined ? { top: `${coords.top}px` } : {}),
                    ...(coords.bottom !== undefined ? { bottom: `${coords.bottom}px` } : {}),
                  }
                : { position: 'fixed', left: '-9999px', top: '-9999px' }
            }
            className={`m3-popover z-[100] p-3 ${coords ? 'anim-m3-menu' : 'opacity-0'}`}
          >
            <div className="mb-2 flex items-center justify-between gap-1">
              <button type="button" className="btn-icon h-9 w-9" aria-label={tl(lang, 'daily.prevMonth')} onClick={() => stepMonth(-1)}>
                <ChevronLeft size={18} />
              </button>
              <span className="text-sm font-medium capitalize">{monthFmt.format(new Date(viewMonth.year, viewMonth.month, 1))}</span>
              <button type="button" className="btn-icon h-9 w-9" aria-label={tl(lang, 'daily.nextMonth')} onClick={() => stepMonth(1)}>
                <ChevronRight size={18} />
              </button>
            </div>
            <div className="mb-1 grid grid-cols-7 text-center text-[11px] font-medium text-on-surface-variant">
              {weekdays.map((w) => (
                <div key={w} className="py-1">
                  {w}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-y-0.5 text-center">
              {grid.map((cell) => {
                const isSelected = cell.dateStr === date;
                const isToday = cell.dateStr === todayStr;
                const hasNote = existingDailyDates.has(cell.dateStr);
                return (
                  <button
                    key={cell.dateStr}
                    type="button"
                    aria-current={isSelected ? 'date' : undefined}
                    onClick={() => goToDate(cell.dateStr)}
                    className={`relative mx-auto flex h-9 w-9 flex-col items-center justify-center rounded-full text-sm transition-colors ${
                      isSelected
                        ? 'bg-primary font-medium text-on-primary'
                        : isToday
                          ? 'border border-primary font-medium text-primary hover:bg-primary/10'
                          : cell.inMonth
                            ? 'text-on-surface hover:bg-surface-container-low'
                            : 'text-on-surface-variant/60 hover:bg-surface-container-low'
                    }`}
                  >
                    <span>{cell.day}</span>
                    {hasNote && <span className={`absolute bottom-1 h-1 w-1 rounded-full ${isSelected ? 'bg-on-primary' : 'bg-primary'}`} />}
                  </button>
                );
              })}
            </div>
            <div className="mt-2 flex items-center justify-between border-t border-outline-variant/60 pt-2">
              <span className="text-[11px] text-on-surface-variant">{tl(lang, 'daily.dotLegend')}</span>
              <button type="button" className="rounded-lg px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/12" onClick={() => void openToday()}>
                {tl(lang, 'daily.todayChip')}
              </button>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

/**
 * Shown on `/daily` or `/daily/:date` when Daily Notes are disabled or the chosen day does not yet have a note.
 */
export function DailyNoteEmptyView({ date }: { date?: string }) {
  useVault();
  const lang = useLang();
  const loc = locale(lang);
  const locked = useReadOnly();
  const features = vault.features();
  const { daily } = features;
  const rc = vault.roleConfig();
  const todayStr = toDateString(new Date());
  const targetDate = date && isValidDateString(date) ? date : todayStr;
  const existing = daily.enabled ? vault.findDailyNote(targetDate) : undefined;
  const longDateFmt = useMemo(() => new Intl.DateTimeFormat(loc, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }), [loc]);

  useEffect(() => {
    if (existing) navigate(`/n/${existing.id}`, true);
  }, [existing?.id]);

  if (!daily.enabled) {
    return (
      <div className="content-container mx-auto px-4 py-6 sm:px-8 sm:py-10">
        <div className="card max-w-lg space-y-4 p-6 anim-fade-up">
          <div className="flex items-center gap-2 text-lg font-medium">
            <CalendarDays size={20} className="shrink-0 text-primary" />
            {tl(lang, 'daily.disabledTitle')}
          </div>
          <p className="text-sm text-on-surface-variant">{tl(lang, 'daily.disabledDesc')}</p>
          <div className="flex flex-wrap gap-2">
            {!locked && (
              <button
                className="btn-primary"
                onClick={async () => {
                  await vault.updateFeatures({ ...features, daily: { ...daily, enabled: true } });
                  const note = await vault.openDailyNote(targetDate);
                  navigate(`/n/${note.id}`, true);
                }}
              >
                <FilePlus2 size={16} /> {tl(lang, 'daily.enableAndOpen')}
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

  if (existing) return null;

  const dayStart = parseDate(targetDate).getTime();
  const dayEnd = parseDate(shiftDateString(targetDate, 1)).getTime();
  const notesOnDay = vault
    .list()
    .filter((n) => n.access === 'owner' && ((n.createdAt >= dayStart && n.createdAt < dayEnd) || (n.updatedAt >= dayStart && n.updatedAt < dayEnd)))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="content-container mx-auto px-4 py-6 sm:px-8 sm:py-10">
      <DailyNoteBar date={targetDate} />
      <div className="card max-w-xl space-y-4 p-6 anim-fade-up">
        <div>
          <p className="text-title-s text-on-surface-variant">
            {tl(lang, 'daily.navLabel')} · {daily.folder ? folderDisplayName(daily.folder, lang) : tl(lang, 'common.topLevelPlain')}
          </p>
          <h1 className="mt-1 text-headline-m capitalize">{longDateFmt.format(parseDate(targetDate))}</h1>
        </div>
        <p className="text-sm text-on-surface-variant">{tl(lang, 'daily.emptyForDay')}</p>
        {!locked && (
          <button
            className="btn-primary"
            onClick={async () => {
              const note = await vault.openDailyNote(targetDate);
              navigate(`/n/${note.id}`, true);
            }}
          >
            <FilePlus2 size={16} /> {tl(lang, 'daily.createBtn')}
          </button>
        )}
      </div>

      {notesOnDay.length > 0 && (
        <section className="mt-6 max-w-xl anim-fade-up">
          <h2 className="mb-2 text-title-s text-on-surface-variant">{tl(lang, 'daily.activityOnDay', { n: notesOnDay.length })}</h2>
          <ul className="card divide-y divide-outline-variant/60 p-1">
            {notesOnDay.map((n) => (
              <li key={n.id}>
                <button className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-surface-container-high/60" onClick={() => navigate(`/n/${n.id}`)}>
                  <FileText size={15} className="shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 truncate font-medium">{projectTitleOf(n.path, n.content, rc)}</span>
                  <span className="max-w-[45%] shrink-0 truncate text-xs text-on-surface-variant">
                    {splitPath(n.path).folder ? folderDisplayName(splitPath(n.path).folder, lang) : tl(lang, 'common.topLevelPlain')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}


const CARRY_OPEN_KEY = 'kladde.carryOverOpen';

/**
 * Open tasks from daily notes before `date`, each with a button that moves it (with its subtasks)
 * into the open daily note. Tasks without their own date then belong to the new day.
 */
export function DailyCarryOver({ noteId, date }: { noteId: string; date: string }) {
  const version = useVault();
  const lang = useLang();
  const loc = locale(lang);
  const locked = useReadOnly();
  const { daily } = vault.features();
  const [open, setOpenState] = useState(() => {
    try {
      return localStorage.getItem(CARRY_OPEN_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const setOpen = (v: boolean) => {
    setOpenState(v);
    try {
      localStorage.setItem(CARRY_OPEN_KEY, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  };
  const extractDaily = useMemo(() => createDailyDateExtractor(daily), [daily.folder, daily.format]);
  const dayFmt = useMemo(() => new Intl.DateTimeFormat(loc, { weekday: 'short', day: '2-digit', month: '2-digit' }), [loc]);

  const tasks = useMemo(() => {
    const out: { noteId: string; line: number; text: string; date: string; due: string | null }[] = [];
    for (const n of vault.list()) {
      if (n.access !== 'owner' || n.id === noteId) continue;
      const d = extractDaily(n.path);
      if (!d || d >= date) continue;
      const lines = n.content.split('\n');
      const depth = (l: string) => /^\s*/.exec(l)![0].length;
      let parent: { line: number; depth: number } | null = null;
      for (const tk of parseTasks(n.content)) {
        // Subtasks of an open task travel with it (takeTaskBlock takes the deeper lines along)
        if (parent && depth(lines[tk.line]) > parent.depth && lines.slice(parent.line + 1, tk.line).every((l) => l.trim() && depth(l) > parent!.depth)) continue;
        if (tk.done) continue;
        parent = { line: tk.line, depth: depth(lines[tk.line]) };
        // Only the task's name: leftover list/checkbox markers ("- [ ]") are left out
        const text = tk.text.replace(/^(?:[-*+]?\s*\[[ xXoOhH]?\]\s*|[-*+]\s+)+/, '').trim() || tk.text;
        out.push({ noteId: n.id, line: tk.line, text, date: d, due: tk.due });
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date) || a.line - b.line);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, extractDaily, date, noteId]);

  if (locked || !tasks.length) return null;

  const isToday = date === toDateString(new Date());
  const carry = (items: { noteId: string; line: number }[]) => {
    editorHost.flush();
    void vault.carryOverTasks(noteId, items);
  };

  return (
    <section className="no-print mb-4 rounded-2xl border border-outline-variant bg-surface-container-low/60 anim-fade-in" aria-label={tl(lang, 'daily.carryTitle', { n: tasks.length })}>
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium text-on-surface"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <ChevronRight size={16} className={`shrink-0 text-on-surface-variant transition-transform duration-150 ${open ? 'rotate-90' : ''}`} />
          <ListTodo size={16} className="shrink-0 text-primary" />
          <span className="truncate sm:hidden">{tl(lang, 'daily.carryTitleShort', { n: tasks.length })}</span>
          <span className="hidden truncate sm:inline">{tl(lang, 'daily.carryTitle', { n: tasks.length })}</span>
        </button>
        {tasks.length > 1 && (
          <button type="button" className="chip shrink-0 text-primary" onClick={() => carry(tasks)}>
            <ArrowDownToLine size={13} /> {tl(lang, 'daily.carryAll')}
          </button>
        )}
      </div>
      {open && (
        <ul className="max-h-64 divide-y divide-outline-variant/60 overflow-y-auto border-t border-outline-variant/60 scrollbar-thin">
          {tasks.map((tk) => (
            <li key={`${tk.noteId}:${tk.line}`} className="flex items-start gap-2 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="break-words leading-snug">{tk.text}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-on-surface-variant">
                  <button
                    type="button"
                    className="tabular-nums hover:text-primary"
                    title={tl(lang, 'daily.carryOpenSource')}
                    onClick={() => navigate(`/n/${tk.noteId}?line=${tk.line + 1}`)}
                  >
                    {dayFmt.format(parseDate(tk.date))}
                  </button>
                  {tk.due && tk.due !== tk.date && <span className="tabular-nums">📅 {tk.due}</span>}
                </div>
              </div>
              <button
                type="button"
                className="btn-ghost shrink-0 px-2 py-1 text-xs text-primary"
                title={tl(lang, isToday ? 'daily.carryToToday' : 'daily.carryToThis')}
                aria-label={`${tl(lang, isToday ? 'daily.carryToToday' : 'daily.carryToThis')}: ${tk.text}`}
                onClick={() => carry([tk])}
              >
                <ArrowDownToLine size={16} />
                <span className="hidden sm:inline">{tl(lang, isToday ? 'daily.carryToToday' : 'daily.carryToThis')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
