/**
 * Calendar view (#72): month, week and agenda of the tasks by due date (with their reminder time), the daily notes
 * and notes with a date property. Dragging a task to another day changes its due date (a normal edit of its line,
 * synced like any other); a click on a day opens or creates its daily note. Filters like the task page.
 */
import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, Check, ChevronLeft, ChevronRight, FileText } from '../lib/icons';
import {
  calendarDays,
  calendarEntries,
  createDailyDateExtractor,
  DATE_FIELDS,
  extractMeta,
  NoteMemo,
  parseDate,
  projectTitleOf,
  shiftCalendar,
  TASK_LINE,
  toDateString,
  type CalendarEntry,
  type CalendarMode,
} from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import { folderDisplayName, locale, tl, useLang, weekdaysShort, type Lang } from '../lib/i18n';
import { isReadOnly, useReadOnly } from '../lib/readOnly';
import { navigate } from '../lib/router';
import { collectTasks, TaskMeta, type TaskRow } from './TaskParts';
import { Dropdown } from './Dropdown';
import { Switch } from './Switch';

type Status = 'all' | 'open' | 'doing' | 'blocked';

interface CalendarPrefs {
  mode: CalendarMode;
  status: Status;
  /** Folder of the note, `*` for all */
  folder: string;
  /** Tag, `*` for all */
  tag: string;
  showDone: boolean;
  /** Notes with a `date:` or `deadline:` property */
  showNotes: boolean;
}

const PREFS_KEY = 'kladde.calendarView';
const DEFAULTS: CalendarPrefs = { mode: 'month', status: 'all', folder: '*', tag: '*', showDone: false, showNotes: true };
const TASK_DRAG = 'application/x-kladde-task';

function readPrefs(): CalendarPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<CalendarPrefs>;
    return {
      mode: raw.mode === 'week' || raw.mode === 'agenda' ? raw.mode : 'month',
      status: raw.status === 'open' || raw.status === 'doing' || raw.status === 'blocked' ? raw.status : 'all',
      folder: typeof raw.folder === 'string' ? raw.folder : '*',
      tag: typeof raw.tag === 'string' ? raw.tag : '*',
      showDone: raw.showDone === true,
      showNotes: raw.showNotes !== false,
    };
  } catch {
    return DEFAULTS;
  }
}

/** Tags of a note, parsed again only when it changes (#64) */
const tagMemo = new NoteMemo<string[]>((n) => extractMeta(n.path, n.content).tags);
/** Tags of the note itself, without the ones written in its tasks: those belong to their task only */
const ownTagMemo = new NoteMemo<string[]>((n) => extractMeta(n.path, n.content.split('\n').filter((l) => !TASK_LINE.test(l)).join('\n')).tags);

const usePhone = () => {
  const query = '(max-width: 639.98px)';
  const [phone, setPhone] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(query);
    const on = () => setPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
};

/** Opens the day's daily note, creating it while daily notes are on (read-only: its page) */
async function openDay(date: string) {
  const { daily } = vault.features();
  const existing = vault.findDailyNote(date);
  if (existing) navigate(`/n/${existing.id}`);
  else if (daily.enabled && !isReadOnly()) navigate(`/n/${(await vault.openDailyNote(date)).id}`);
  else navigate(`/daily/${date}`);
}

function title(mode: CalendarMode, days: string[], lang: Lang): string {
  const loc = locale(lang);
  if (mode === 'month') return new Intl.DateTimeFormat(loc, { month: 'long', year: 'numeric' }).format(parseDate(days[15]));
  return new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short', year: 'numeric' }).formatRange(parseDate(days[0]), parseDate(days[days.length - 1]));
}

export function CalendarPlanner() {
  const version = useVault();
  const lang = useLang();
  const loc = locale(lang);
  const locked = useReadOnly();
  const phone = usePhone();
  const [prefs, setPrefsState] = useState(readPrefs);
  const today = toDateString(new Date());
  const [anchor, setAnchor] = useState(today);
  const [selected, setSelected] = useState(today);
  const [over, setOver] = useState<string | null>(null);
  const setPrefs = (patch: Partial<CalendarPrefs>) =>
    setPrefsState((p) => {
      const next = { ...p, ...patch };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });

  const features = vault.features();
  const rc = vault.roleConfig();
  const tasks = collectTasks(version);
  const own = useMemo(() => vault.list().filter((n) => n.access === 'owner'), [version]);
  const folders = useMemo(() => [...new Set([...tasks.map((tk) => tk.folder), ...own.map((n) => (n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : ''))])].filter(Boolean).sort((a, b) => a.localeCompare(b)), [tasks, own]);
  const tags = useMemo(() => [...new Set(own.flatMap((n) => tagMemo.get(n)))].sort((a, b) => a.localeCompare(b)), [own]);
  const folder = prefs.folder === '*' || folders.includes(prefs.folder) ? prefs.folder : '*';
  const tag = prefs.tag === '*' || tags.includes(prefs.tag) ? prefs.tag : '*';
  const dailyDate = useMemo(() => (features.daily.enabled ? createDailyDateExtractor(features.daily) : undefined), [features.daily.enabled, features.daily.folder, features.daily.format]);

  const days = calendarDays(prefs.mode, anchor);
  const from = days[0];
  const to = days[days.length - 1];
  const entries = useMemo(() => {
    const byId = new Map(own.map((n) => [n.id, n]));
    return calendarEntries(
      tasks,
      own.map((n) => ({ id: n.id, path: n.path, content: n.content, title: projectTitleOf(n.path, n.content, rc) })),
      from,
      to,
      {
        dailyDate,
        noteTags: (id) => {
          const n = byId.get(id);
          return n ? ownTagMemo.get(n) : [];
        },
        filter: {
          status: prefs.status,
          folder: folder === '*' ? undefined : folder,
          tag: tag === '*' ? undefined : tag,
          showDone: prefs.showDone,
          dateFields: prefs.showNotes ? DATE_FIELDS : [],
        },
      }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, own, from, to, dailyDate, prefs.status, prefs.showDone, prefs.showNotes, folder, tag]);
  // The agenda starts with what is overdue
  const overdue = useMemo(
    () => (prefs.mode === 'agenda' && from <= today ? tasks.filter((tk) => !tk.done && tk.due && tk.due < today && (folder === '*' || tk.folder === folder || tk.folder.startsWith(`${folder}/`))) : []),
    [prefs.mode, from, today, tasks, folder]
  );

  const move = (date: string, data: string) => {
    try {
      const { noteId, line } = JSON.parse(data) as { noteId: string; line: number };
      if (typeof noteId === 'string' && Number.isInteger(line)) void vault.setTaskMeta(noteId, line, { due: date });
    } catch {
      /* not a task */
    }
  };
  /** Props that make an element a drop target for tasks */
  const dropZone = (date: string) =>
    locked
      ? {}
      : {
          'data-drop-day': date,
          onDragOver: (e: React.DragEvent) => {
            if (!e.dataTransfer.types.includes(TASK_DRAG)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setOver(date);
          },
          onDragLeave: () => setOver((d) => (d === date ? null : d)),
          onDrop: (e: React.DragEvent) => {
            setOver(null);
            const data = e.dataTransfer.getData(TASK_DRAG);
            if (!data) return;
            e.preventDefault();
            move(date, data);
          },
        };

  const longFmt = new Intl.DateTimeFormat(loc, { weekday: 'long', day: 'numeric', month: 'long' });
  const dayLabel = (date: string) => tl(lang, 'planner.openDay', { date: longFmt.format(parseDate(date)) });
  const step = (delta: number) => {
    const next = shiftCalendar(prefs.mode, anchor, delta);
    setAnchor(next);
    setSelected(next);
  };
  const weekdays = weekdaysShort(lang);

  const header = (
    <>
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3 anim-fade-up">
        <h1 className="text-headline-m">{tl(lang, 'planner.title')}</h1>
        <div role="group" aria-label={tl(lang, 'planner.modeAria')} className="segmented">
          {(['month', 'week', 'agenda'] as const).map((m) => (
            <button key={m} type="button" aria-pressed={prefs.mode === m} onClick={() => setPrefs({ mode: m })}>
              {prefs.mode === m && <Check size={18} />} {tl(lang, `planner.mode.${m}`)}
            </button>
          ))}
        </div>
      </header>
      <div className="mb-3 flex flex-wrap items-center gap-2 anim-fade-up">
        <div className="inline-flex items-center overflow-hidden rounded-xl border border-outline-variant bg-surface-container-low">
          <button type="button" className="btn-icon h-10 w-10 rounded-none" aria-label={tl(lang, 'planner.prev')} title={tl(lang, 'planner.prev')} onClick={() => step(-1)}>
            <ChevronLeft size={18} />
          </button>
          <span className="min-w-0 px-2 text-sm font-medium capitalize" aria-live="polite" data-calendar-title>
            {title(prefs.mode, days, lang)}
          </span>
          <button type="button" className="btn-icon h-10 w-10 rounded-none" aria-label={tl(lang, 'planner.next')} title={tl(lang, 'planner.next')} onClick={() => step(1)}>
            <ChevronRight size={18} />
          </button>
        </div>
        {!days.includes(today) && (
          <button
            type="button"
            className="chip h-10 px-3 text-primary"
            onClick={() => {
              setAnchor(today);
              setSelected(today);
            }}
          >
            {tl(lang, 'daily.todayChip')}
          </button>
        )}
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2 anim-fade-up">
        <Dropdown
          variant="chip"
          value={prefs.status}
          aria-label={tl(lang, 'tasks.filterStatus')}
          onChange={(v) => setPrefs({ status: v as Status })}
          options={[
            { value: 'all', label: tl(lang, 'tasks.statusAll') },
            { value: 'open', label: tl(lang, 'task.status.open') },
            { value: 'doing', label: tl(lang, 'task.status.doing') },
            { value: 'blocked', label: tl(lang, 'task.status.blocked') },
          ]}
        />
        <Dropdown
          variant="chip"
          value={folder}
          aria-label={tl(lang, 'tasks.filterFolder')}
          onChange={(v) => setPrefs({ folder: v })}
          options={[{ value: '*', label: tl(lang, 'tasks.folderAll') }, ...folders.map((f) => ({ value: f, label: folderDisplayName(f, lang) }))]}
        />
        {tags.length > 0 && (
          <Dropdown
            variant="chip"
            value={tag}
            aria-label={tl(lang, 'planner.filterTag')}
            onChange={(v) => setPrefs({ tag: v })}
            options={[{ value: '*', label: tl(lang, 'planner.tagAll') }, ...tags.map((x) => ({ value: x, label: `#${x}` }))]}
          />
        )}
        <label className="flex items-center gap-2 text-body-m text-on-surface-variant sm:ml-auto">
          {tl(lang, 'planner.showNotes')}
          <Switch checked={prefs.showNotes} label={tl(lang, 'planner.showNotes')} onChange={(v) => setPrefs({ showNotes: v })} />
        </label>
        <label className="flex items-center gap-2 text-body-m text-on-surface-variant">
          {tl(lang, 'tasks.showDone')}
          <Switch checked={prefs.showDone} label={tl(lang, 'tasks.showDone')} onChange={(v) => setPrefs({ showDone: v })} />
        </label>
      </div>
    </>
  );

  const list = (date: string, opts: { limit?: number; meta?: boolean; wrap?: boolean } = {}) => {
    const all = entries.get(date) ?? [];
    const shown = opts.limit && all.length > opts.limit ? all.slice(0, opts.limit - 1) : all;
    return (
      <ul className="flex min-w-0 flex-col gap-1">
        {shown.map((e) => (
          <li key={entryKey(e)} className="min-w-0">
            <Entry entry={e} locked={locked} lang={lang} meta={opts.meta} wrap={opts.wrap} />
          </li>
        ))}
        {shown.length < all.length && (
          <li>
            <button
              type="button"
              className="w-full rounded-md px-1.5 text-left text-xs font-medium text-primary hover:bg-primary/10"
              onClick={() => {
                setAnchor(date);
                setPrefs({ mode: 'week' });
              }}
            >
              {tl(lang, 'planner.more', { n: all.length - shown.length })}
            </button>
          </li>
        )}
      </ul>
    );
  };

  const dayButton = (date: string, label: string, className: string) => (
    <button type="button" className={className} aria-label={dayLabel(date)} title={dayLabel(date)} aria-current={date === today ? 'date' : undefined} onClick={() => void openDay(date)}>
      {label}
    </button>
  );

  let body: React.ReactNode;
  if (prefs.mode === 'month') {
    const month = parseDate(days[15]).getMonth();
    body = (
      <>
        <div className="overflow-hidden rounded-2xl border border-outline-variant bg-surface-container-low anim-fade-up" data-calendar="month">
          <div className="grid grid-cols-7 border-b border-outline-variant text-center text-xs font-medium text-on-surface-variant" aria-hidden="true">
            {weekdays.map((w) => (
              <div key={w} className="py-2">
                {w}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {days.map((date, i) => {
              const inMonth = parseDate(date).getMonth() === month;
              const count = entries.get(date)?.length ?? 0;
              const isToday = date === today;
              return (
                <div
                  key={date}
                  {...dropZone(date)}
                  className={`min-h-[4.5rem] min-w-0 border-outline-variant/60 p-1 sm:min-h-[7rem] ${i % 7 ? 'border-l' : ''} ${i >= 7 ? 'border-t' : ''} ${inMonth ? '' : 'bg-surface-container-lowest/40'} ${over === date ? 'bg-primary/10 outline outline-2 -outline-offset-2 outline-primary' : ''} ${phone && selected === date ? 'bg-secondary-container/60' : ''}`}
                  onClick={phone ? () => setSelected(date) : undefined}
                >
                  <div className="mb-1 flex items-center justify-between gap-1">
                    {phone ? (
                      <button
                        type="button"
                        aria-pressed={selected === date}
                        aria-label={new Intl.DateTimeFormat(loc, { dateStyle: 'full' }).format(parseDate(date))}
                        className={`flex h-7 w-7 items-center justify-center rounded-full text-xs ${isToday ? 'bg-primary font-medium text-on-primary' : inMonth ? 'text-on-surface' : 'text-on-surface-variant'}`}
                      >
                        {parseDate(date).getDate()}
                      </button>
                    ) : (
                      dayButton(
                        date,
                        String(parseDate(date).getDate()),
                        `flex h-7 min-w-7 items-center justify-center rounded-full px-1.5 text-xs transition-colors ${isToday ? 'bg-primary font-medium text-on-primary' : inMonth ? 'text-on-surface hover:bg-surface-container-high' : 'text-on-surface-variant hover:bg-surface-container-high'}`
                      )
                    )}
                  </div>
                  {phone ? (
                    count > 0 && (
                      <div className="flex flex-wrap justify-center gap-0.5" aria-hidden="true">
                        {(entries.get(date) ?? []).slice(0, 4).map((e) => (
                          <span key={entryKey(e)} className={`h-1.5 w-1.5 rounded-full ${dotTone(e)}`} />
                        ))}
                      </div>
                    )
                  ) : (
                    list(date, { limit: 4 })
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {phone && (
          <section className="mt-4 anim-fade-up" aria-label={longFmt.format(parseDate(selected))}>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-title-s capitalize">{longFmt.format(parseDate(selected))}</h2>
              {dayButton(selected, tl(lang, 'planner.dailyNote'), 'chip h-9 px-3 text-primary')}
            </div>
            {(entries.get(selected)?.length ?? 0) > 0 ? list(selected, { meta: true, wrap: true }) : <p className="text-sm text-on-surface-variant">{tl(lang, 'planner.emptyDay')}</p>}
          </section>
        )}
      </>
    );
  } else if (prefs.mode === 'week') {
    body = (
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-7 anim-fade-up" data-calendar="week">
        {days.map((date, i) => (
          <section
            key={date}
            {...dropZone(date)}
            aria-label={longFmt.format(parseDate(date))}
            className={`min-w-0 rounded-2xl border border-outline-variant bg-surface-container-low p-2 sm:min-h-[16rem] ${over === date ? 'bg-primary/10 outline outline-2 -outline-offset-2 outline-primary' : ''}`}
          >
            {dayButton(
              date,
              `${weekdays[i]} ${new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short' }).format(parseDate(date))}`,
              `mb-2 w-full rounded-lg px-2 py-1 text-left text-sm font-medium transition-colors ${date === today ? 'bg-primary text-on-primary' : 'text-on-surface hover:bg-surface-container-high'}`
            )}
            {list(date, { meta: true, wrap: true })}
          </section>
        ))}
      </div>
    );
  } else {
    const withEntries = days.filter((d) => d === today || entries.has(d));
    body = (
      <div className="space-y-4 anim-fade-up" data-calendar="agenda">
        {overdue.length > 0 && (
          <section aria-label={tl(lang, 'home.bucketOverdue')}>
            <h2 className="mb-2 px-1 text-title-s text-error">
              {tl(lang, 'home.bucketOverdue')} <span className="text-on-surface-variant">· {overdue.length}</span>
            </h2>
            <ul className="card flex flex-col gap-1 p-2">
              {overdue.map((task) => (
                <li key={`${task.noteId}:${task.line}`}>
                  <Entry entry={{ kind: 'task', date: task.due!, time: task.time, task }} locked={locked} lang={lang} meta showDate />
                </li>
              ))}
            </ul>
          </section>
        )}
        {withEntries.map((date) => (
          <section key={date} {...dropZone(date)} aria-label={longFmt.format(parseDate(date))} className={`rounded-2xl ${over === date ? 'bg-primary/10 outline outline-2 outline-primary' : ''}`}>
            {dayButton(date, longFmt.format(parseDate(date)), `mb-2 rounded-lg px-1 text-left text-title-s capitalize hover:text-primary ${date === today ? 'text-primary' : ''}`)}
            <div className="card p-2">{entries.has(date) ? list(date, { meta: true }) : <p className="px-1 text-sm text-on-surface-variant">{tl(lang, 'planner.emptyDay')}</p>}</div>
          </section>
        ))}
        {withEntries.length === 0 && !overdue.length && <p className="py-10 text-center text-body-l text-on-surface-variant">{tl(lang, 'planner.emptyAgenda')}</p>}
      </div>
    );
  }

  return (
    <div data-calendar-view>
      {header}
      {body}
      {!locked && !phone && <p className="mt-3 text-xs text-on-surface-variant anim-fade-up">{tl(lang, 'planner.dragHint')}</p>}
    </div>
  );
}

const entryKey = (e: CalendarEntry) => (e.kind === 'task' ? `t:${e.task.noteId}:${e.task.line}` : `${e.kind}:${e.noteId}:${e.kind === 'note' ? e.field : ''}`);

const dotTone = (e: CalendarEntry) =>
  e.kind === 'daily' ? 'bg-tertiary' : e.kind === 'note' ? 'bg-secondary' : e.task.done ? 'bg-ok' : e.task.status === 'blocked' ? 'bg-error' : 'bg-primary';

function Entry({ entry: e, locked, lang, meta, showDate, wrap }: { entry: CalendarEntry; locked: boolean; lang: Lang; meta?: boolean; showDate?: boolean; wrap?: boolean }) {
  if (e.kind !== 'task') {
    return (
      <button
        type="button"
        data-calendar-entry={e.kind}
        className={`flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-xs transition-colors ${e.kind === 'daily' ? 'bg-tertiary-container text-on-tertiary-container' : 'bg-secondary-container text-on-secondary-container'} hover:brightness-95`}
        title={e.kind === 'note' ? `${e.title} · ${e.field}` : tl(lang, 'planner.dailyNote')}
        onClick={(ev) => {
          ev.stopPropagation();
          navigate(`/n/${e.noteId}`);
        }}
      >
        {e.kind === 'daily' ? <CalendarDays size={12} className="shrink-0" /> : <FileText size={12} className="shrink-0" />}
        <span className="truncate">{e.kind === 'daily' ? tl(lang, 'planner.dailyNote') : e.title}</span>
        {e.kind === 'note' && meta && <span className="ml-auto shrink-0">· {e.field}</span>}
      </button>
    );
  }
  const task = e.task as TaskRow;
  const tone = task.done ? 'text-on-surface-variant line-through' : task.status === 'blocked' ? 'text-error' : task.status === 'doing' ? 'text-tertiary' : 'text-on-surface';
  const drag = {
    draggable: !locked,
    onDragStart: (ev: React.DragEvent) => {
      ev.dataTransfer.setData(TASK_DRAG, JSON.stringify({ noteId: task.noteId, line: task.line }));
      ev.dataTransfer.effectAllowed = 'move';
    },
    onClick: (ev: React.MouseEvent) => ev.stopPropagation(),
  };
  const box = (
    <input type="checkbox" className="cm-checkbox mt-px shrink-0" checked={task.done} disabled={locked} aria-label={task.text} onChange={() => void vault.toggleTask(task.noteId, task.line)} />
  );
  const open = () => navigate(task.noteTitle ? `/n/${task.noteId}?line=${task.line + 1}` : '/tasks');
  const label = (
    <>
      {e.time && <span className="mr-1 tabular-nums text-on-surface-variant">{e.time}</span>}
      {task.text}
    </>
  );
  if (wrap) {
    // Narrow columns (week, the day below the month on phones): the text wraps, the note goes below it
    return (
      <div data-calendar-entry="task" data-task={task.text} {...drag} className={`flex min-w-0 items-start gap-1.5 rounded-lg border border-outline-variant/60 bg-surface p-1.5 text-xs ${locked ? '' : 'cursor-grab active:cursor-grabbing'}`}>
        {box}
        <div className="min-w-0 flex-1">
          <button type="button" className={`block w-full break-words text-left [hyphens:auto] hover:text-primary ${tone}`} onClick={open}>
            {label}
          </button>
          {(task.noteTitle || (meta && !locked)) && (
            <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-on-surface-variant">
              <span className="min-w-0 flex-1 truncate">{task.noteTitle}</span>
              {meta && !locked && <TaskMeta task={task} className="-my-1 shrink-0" />}
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <div
      data-calendar-entry="task"
      data-task={task.text}
      {...drag}
      className={`group flex min-w-0 items-center gap-1.5 rounded-md border border-outline-variant/60 bg-surface px-1.5 py-0.5 text-xs ${locked ? '' : 'cursor-grab active:cursor-grabbing'}`}
    >
      {box}
      <button type="button" className={`min-w-0 flex-1 truncate text-left hover:text-primary ${tone}`} title={task.noteTitle ? `${task.text} · ${task.noteTitle}` : task.text} onClick={open}>
        {label}
      </button>
      {showDate && <span className="shrink-0 tabular-nums text-on-surface-variant">{task.due}</span>}
      {meta && task.noteTitle && <span className="hidden max-w-[40%] shrink-0 truncate text-on-surface-variant sm:inline">{task.noteTitle}</span>}
      {meta && !locked && <TaskMeta task={task} className="shrink-0" />}
    </div>
  );
}
