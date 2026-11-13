import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlignJustify, Briefcase, Check, CalendarCheck, CalendarClock, CalendarDays, Inbox as InboxIcon, Kanban, List, ListChecks, Plus, Repeat, X } from '../lib/icons';
import { INBOX_FOLDER, TASK_STATUSES, Task, TaskBucket, TaskStatus, bucketOf, parseTasks, projectTitleOf, roleOfPath, shortcutDate, projectsOf, splitPath, toDateString } from '@kladde/shared';
import { openDialog } from '../lib/dialogs';
import { reviewDue } from './Review';
import { useVault, vault } from '../data/vault';
import { navigate } from '../lib/router';
import { useReadOnly } from '../lib/readOnly';
import { formatDue, openStatusMenu } from '../editor/widgets';
import { NoteCollection, ViewSwitch } from './NoteList';
import { Dropdown } from './Dropdown';
import { ActivityHeatmap } from './ActivityHeatmap';
import { locale, t, useLang, type I18nKey } from '../lib/i18n';
import { useInboxZero } from '../lib/prefs';

interface TaskRow extends Task {
  noteId: string;
  noteTitle: string;
}

const BUCKETS: { id: TaskBucket; labelKey: I18nKey; tone: string }[] = [
  { id: 'overdue', labelKey: 'home.bucketOverdue', tone: 'text-error' },
  { id: 'today', labelKey: 'home.bucketToday', tone: 'text-tertiary' },
  { id: 'upcoming', labelKey: 'home.bucketNext', tone: 'text-primary' },
  { id: 'someday', labelKey: 'home.taskNoDate', tone: 'text-on-surface-variant' },
];

const REPEATS: { value: string; labelKey: I18nKey }[] = [
  { value: '', labelKey: 'home.taskRepeatReset' },
  { value: 'täglich', labelKey: 'home.taskRepeatDaily' },
  { value: 'wöchentlich', labelKey: 'home.taskRepeatWeekly' },
  { value: 'monatlich', labelKey: 'home.taskRepeatMonthly' },
  { value: 'jährlich', labelKey: 'home.taskRepeatYearly' },
];

/**
 * Small button next to a task: due date shortcuts, date picker and repeat rule.
 * Rendered in a portal with fixed viewport coordinates so CSS animations / transforms on
 * parent list items never trap the popover behind sibling tasks.
 */
function TaskMeta({ task, className = '' }: { task: TaskRow; className?: string }) {
  useLang();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const updatePos = useCallback(() => {
    const btn = triggerRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const popW = popoverRef.current?.offsetWidth || 256;
    const popH = popoverRef.current?.offsetHeight || 196;
    const gap = 6;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(8, Math.min(rect.right - popW, vw - popW - 8));
    const fitsBelow = rect.bottom + gap + popH <= vh - 8;
    const top = fitsBelow || rect.top < popH + gap + 8
      ? Math.max(8, Math.min(rect.bottom + gap, vh - popH - 8))
      : rect.top - gap - popH;
    setPos({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    updatePos();
  }, [open, updatePos]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (
        (target && (triggerRef.current?.contains(target) || popoverRef.current?.contains(target))) ||
        target?.closest('[data-m3-menu]')
      ) {
        return;
      }
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onScroll = (e: Event) => {
      const target = e.target;
      if (target instanceof Element && target.closest('[data-m3-menu]')) return;
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r || r.bottom <= 0 || r.top >= window.innerHeight) setOpen(false);
      else updatePos();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', updatePos);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', updatePos);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, updatePos]);

  const set = (meta: { due?: string | null; repeat?: string | null }) => void vault.setTaskMeta(task.noteId, task.line, meta);
  const shortcuts = [
    [t('home.taskToday'), 'today'],
    [t('home.taskTomorrow'), 'tomorrow'],
    [t('home.taskNextMonday'), 'nextWeek'],
  ] as const;

  return (
    <div className={`edit-only relative shrink-0 ${className}`} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <button
        ref={triggerRef}
        type="button"
        className={`rounded-full p-1.5 transition-colors ${open ? 'bg-primary/15 text-primary' : 'text-on-surface-variant hover:bg-surface-container-high hover:text-primary'}`}
        title={t('home.taskDateAndRepeatAria')}
        aria-label={t('home.taskDateAndRepeatAria')}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <CalendarClock size={15} />
      </button>
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
            className="card fixed z-[90] w-64 max-w-[calc(100vw-1rem)] space-y-2.5 rounded-2xl border border-outline-variant/70 bg-surface-container-high p-3 shadow-soft anim-fade-in"
          >
            <div className="flex flex-wrap gap-1.5">
              {shortcuts.map(([label, kind]) => (
                <button
                  key={kind}
                  type="button"
                  className="chip"
                  onClick={() => {
                    set({ due: shortcutDate(kind) });
                    setOpen(false);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <input
                type="date"
                className="min-w-0 flex-1 rounded-xl border border-outline-variant bg-surface-container-low px-2.5 py-1.5 text-sm text-on-surface outline-none focus:border-primary"
                value={task.due ?? ''}
                onChange={(e) => set({ due: e.target.value || null })}
              />
              {task.due && (
                <button
                  type="button"
                  className="rounded-full p-1.5 text-on-surface-variant hover:bg-surface-container-low hover:text-error"
                  title={t('home.taskDateReset')}
                  aria-label={t('home.taskDateReset')}
                  onClick={() => set({ due: null })}
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <Dropdown
              value={task.repeat ?? ''}
              aria-label={t('home.taskRepeatLabel')}
              className="w-full"
              onChange={(val) => set({ repeat: val || null })}
              options={[
                ...REPEATS.map((r) => ({ value: r.value, label: t(r.labelKey) })),
                ...(task.repeat && !REPEATS.some((r) => r.value === task.repeat) ? [{ value: task.repeat, label: task.repeat }] : []),
              ]}
            />
          </div>,
          document.body
        )}
    </div>
  );
}

const STATUS_TONE: Record<TaskStatus, string> = { open: 'text-on-surface-variant', doing: 'text-primary', blocked: 'text-warn', done: 'text-ok' };

/** "In Arbeit" / "Blockiert" next to a task in the list (open tasks need no label) */
function StatusChip({ status }: { status: TaskStatus }) {
  if (status !== 'doing' && status !== 'blocked') return null;
  return <span className={`chip shrink-0 px-2 py-0 text-[11px] ${STATUS_TONE[status]}`}>{t(`task.status.${status}`)}</span>;
}

/** Opens the status picker for a task below `anchor` */
function pickStatus(anchor: HTMLElement, task: TaskRow, lang: ReturnType<typeof useLang>) {
  openStatusMenu(anchor, task.status, lang, (status) => void vault.setTaskStatus(task.noteId, task.line, status));
}

function TaskItem({ task, compact }: { task: TaskRow; compact: boolean }) {
  const lang = useLang();
  const [leaving, setLeaving] = useState(false);
  const locked = useReadOnly();
  const bucket = bucketOf(task);
  // Without a second line (note, date, status) the row is centered instead of aligned to the first line
  const hasMeta = task.status === 'doing' || task.status === 'blocked' || !!task.due || !!task.repeat || !!task.noteTitle;
  const top = !compact && hasMeta;
  return (
    <li
      title={task.noteTitle ? t('home.taskDoubleClickHint') : undefined}
      onDoubleClick={(e) => {
        if (!task.noteTitle || (e.target as HTMLElement).closest('input,button,select')) return;
        navigate(`/n/${task.noteId}?line=${task.line + 1}`);
      }}
      className={`group flex gap-4 rounded-[var(--shape-xs)] bg-surface-container-low px-4 transition-all duration-300 first:rounded-t-2xl last:rounded-b-2xl hover:bg-surface-container ${compact ? 'py-2' : 'py-3'} ${top ? 'items-start' : 'items-center'} ${leaving ? 'translate-x-4 opacity-0' : ''}`}
    >
      <input
        type="checkbox"
        className={`cm-checkbox shrink-0 ${top ? 'mt-0.5' : ''}`}
        data-status={leaving ? 'done' : task.status}
        title={t(`task.status.${task.status}`)}
        checked={leaving}
        disabled={locked}
        onContextMenu={(e) => {
          if (locked) return;
          e.preventDefault();
          pickStatus(e.currentTarget, task, lang);
        }}
        onChange={() => {
          setLeaving(true);
          setTimeout(() => void vault.toggleTask(task.noteId, task.line), 280);
        }}
      />
      {compact ? (
        <>
          <span className="min-w-0 flex-1 truncate text-sm">{task.text || t('home.taskEmpty')}</span>
          <StatusChip status={task.status} />
          {task.repeat && <Repeat size={11} className="shrink-0 text-on-surface-variant" />}
          {task.due && <span className={`cm-due shrink-0 ${bucket === 'overdue' ? 'overdue' : bucket === 'today' ? 'today' : ''}`}>{formatDue(task.due)}</span>}
          <button className="hidden max-w-[30%] shrink-0 truncate text-xs text-on-surface-variant hover:text-primary sm:block" onClick={() => navigate(`/n/${task.noteId}`)}>
            {task.noteTitle}
          </button>
        </>
      ) : (
        <div className="min-w-0 flex-1">
          <div className="break-words text-[15px] leading-snug">{task.text || t('home.taskEmpty')}</div>
          {hasMeta && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <StatusChip status={task.status} />
              {task.due && (
                <span className={`cm-due ${bucket === 'overdue' ? 'overdue' : bucket === 'today' ? 'today' : ''}`}>
                  <CalendarClock size={11} className="mr-1 inline" />
                  {formatDue(task.due)}
                </span>
              )}
              {task.repeat && (
                <span className="cm-due">
                  <Repeat size={11} className="mr-1 inline" />
                  {task.repeat}
                </span>
              )}
              {task.noteTitle && (
                <button className="max-w-full truncate text-xs text-on-surface-variant hover:text-primary" onClick={() => navigate(`/n/${task.noteId}`)}>
                  {task.noteTitle}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {/* The 27px button is taller than a line of text: pull it up so it centers on the first line */}
      <TaskMeta task={task} className={compact ? '' : '-my-1'} />
    </li>
  );
}

const DRAG_MIME = 'application/x-kladde-task';

/**
 * Tasks as a board with one column per status. Dragging a card into another column (or picking a
 * status with the button on the card, which also works on touch screens) rewrites its checkbox.
 */
function TaskKanban({ tasks }: { tasks: TaskRow[] }) {
  const lang = useLang();
  const locked = useReadOnly();
  const [over, setOver] = useState<TaskStatus | null>(null);
  const dragged = useRef<TaskRow | null>(null);
  const move = (task: TaskRow, status: TaskStatus) => {
    if (task.status !== status) void vault.setTaskStatus(task.noteId, task.line, status);
  };
  return (
    <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 scrollbar-thin sm:mx-0 sm:px-0 lg:grid lg:snap-none lg:grid-cols-4 lg:overflow-visible">
      {TASK_STATUSES.map((status) => {
        const list = tasks.filter((tk) => tk.status === status);
        return (
          <div
            key={status}
            data-testid={`kanban-${status}`}
            className={`flex w-[78vw] max-w-[18rem] shrink-0 snap-start flex-col gap-2 rounded-2xl border p-2 transition-colors sm:w-64 lg:w-auto lg:max-w-none ${
              over === status ? 'border-primary bg-primary/10' : 'border-outline-variant/70 bg-surface-container'
            }`}
            onDragOver={(e) => {
              if (locked || !e.dataTransfer.types.includes(DRAG_MIME)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (over !== status) setOver(status);
            }}
            onDragLeave={(e) => {
              if (!(e.currentTarget as Node).contains(e.relatedTarget as Node | null)) setOver(null);
            }}
            onDrop={(e) => {
              setOver(null);
              const task = dragged.current;
              dragged.current = null;
              if (locked || !task) return;
              e.preventDefault();
              move(task, status);
            }}
          >
            <h3
              className={`flex items-center gap-2 px-2 pt-1 text-title-s ${STATUS_TONE[status]}`}
              title={status === 'done' ? t('home.kanbanDoneHint') : undefined}
            >
              <span className="cm-checkbox !m-0" data-status={status} />
              {t(`task.status.${status}`)} <span className="text-on-surface-variant">· {list.length}</span>
            </h3>
            {list.map((tk) => {
              const bucket = bucketOf(tk);
              const hasMeta = (!!tk.due && tk.status !== 'done') || !!tk.repeat || !!tk.noteTitle;
              return (
                <div
                  key={`${tk.noteId}:${tk.line}:${tk.text}`}
                  draggable={!locked}
                  onDragStart={(e) => {
                    dragged.current = tk;
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData(DRAG_MIME, `${tk.noteId}:${tk.line}`);
                    e.dataTransfer.setData('text/plain', tk.text);
                  }}
                  onDragEnd={() => {
                    dragged.current = null;
                    setOver(null);
                  }}
                  onDoubleClick={(e) => {
                    if (!tk.noteTitle || (e.target as HTMLElement).closest('input,button,select')) return;
                    navigate(`/n/${tk.noteId}?line=${tk.line + 1}`);
                  }}
                  title={tk.noteTitle ? t('home.taskDoubleClickHint') : undefined}
                  className={`card board-card flex gap-2 p-2.5 ${hasMeta ? 'items-start' : 'items-center'} transition-all ${locked ? '' : 'cursor-grab active:cursor-grabbing'}`}
                >
                  <button
                    type="button"
                    className={`flex shrink-0 rounded-md disabled:cursor-default ${hasMeta ? 'mt-0.5' : ''}`}
                    disabled={locked}
                    aria-label={t('home.taskStatusAria')}
                    title={t('home.taskStatusAria')}
                    onClick={(e) => pickStatus(e.currentTarget, tk, lang)}
                  >
                    <span className="cm-checkbox !m-0" data-status={tk.status} />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className={`break-words text-sm leading-snug ${tk.status === 'done' ? 'text-on-surface-variant line-through' : ''}`}>{tk.text || t('home.taskEmpty')}</div>
                    {hasMeta && (
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {tk.due && tk.status !== 'done' && (
                          <span className={`cm-due ${bucket === 'overdue' ? 'overdue' : bucket === 'today' ? 'today' : ''}`}>{formatDue(tk.due)}</span>
                        )}
                        {tk.repeat && <Repeat size={11} className="text-on-surface-variant" />}
                        {tk.noteTitle && (
                          <button className="max-w-full truncate text-xs text-on-surface-variant hover:text-primary" onClick={() => navigate(`/n/${tk.noteId}`)}>
                            {tk.noteTitle}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  {tk.status !== 'done' && <TaskMeta task={tk} className="-my-1" />}
                </div>
              );
            })}
            {!list.length && <p className="rounded-xl border border-dashed border-outline-variant/70 px-2 py-5 text-center text-xs text-on-surface-variant">{t('home.kanbanEmpty')}</p>}
          </div>
        );
      })}
    </div>
  );
}

export function HomeView() {
  const version = useVault();
  const lang = useLang();
  const inboxZero = useInboxZero();
  const locked = useReadOnly();
  const [input, setInput] = useState('');
  const [showSomeday, setShowSomeday] = useState(false);
  const [compact, setCompactState] = useState(() => {
    try {
      return localStorage.getItem('kladde.tasksCompact') === '1';
    } catch {
      return false;
    }
  });
  const setCompact = (v: boolean) => {
    setCompactState(v);
    try {
      localStorage.setItem('kladde.tasksCompact', v ? '1' : '0');
    } catch {
      /* ignore */
    }
  };
  const [layout, setLayoutState] = useState<'list' | 'kanban'>(() => {
    try {
      return localStorage.getItem('kladde.tasksLayout') === 'kanban' ? 'kanban' : 'list';
    } catch {
      return 'list';
    }
  });
  const setLayout = (v: 'list' | 'kanban') => {
    setLayoutState(v);
    try {
      localStorage.setItem('kladde.tasksLayout', v);
    } catch {
      /* ignore */
    }
  };
  const notes = vault.list();
  const roleConfig = vault.roleConfig();

  /**
   * Open tasks plus the ones finished today or yesterday (for the board's "done" column).
   * Notes in the PARA archive are left out.
   */
  const allTasks = useMemo(() => {
    const out: TaskRow[] = [];
    const dueOf = vault.taskDueResolver();
    const free = vault.freeTasksNote();
    const since = new Date();
    since.setDate(since.getDate() - 1);
    const recent = toDateString(since);
    const keep = (tk: Task) => !tk.done || (!!tk.doneDate && tk.doneDate >= recent);
    if (free) for (const tk of parseTasks(free.content)) if (keep(tk)) out.push({ ...tk, noteId: free.id, noteTitle: '' });
    for (const n of notes) {
      if (roleOfPath(n.path, roleConfig) === 'archive') continue;
      for (const tk of parseTasks(n.content, undefined, n.access === 'owner' ? dueOf(n.path) : null)) if (keep(tk)) out.push({ ...tk, noteId: n.id, noteTitle: projectTitleOf(n.path, n.content, roleConfig) });
    }
    return out.sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  const tasks = useMemo(() => allTasks.filter((tk) => !tk.done), [allTasks]);

  const own = notes.filter((n) => n.access === 'owner');
  const features = vault.features();
  const dailyNote = features.daily.enabled ? vault.findDailyNote() : undefined;
  const showDailyBtn = features.daily.enabled && (!locked || !!dailyNote);
  const projects = features.para.enabled
    ? projectsOf(own, new Date(), roleConfig).sort((a, b) => (a.status === b.status ? b.updatedAt - a.updatedAt : a.status === 'aktiv' ? -1 : 1))
    : [];
  const inboxCount = own.filter((n) => splitPath(n.path).folder === INBOX_FOLDER).length;
  const recent = [...notes].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
  const hour = new Date().getHours();
  const greeting = hour < 11 ? t('home.greetingMorning') : hour < 18 ? t('home.greetingDay') : t('home.greetingEvening');
  const openCount = tasks.filter((tk) => bucketOf(tk) === 'overdue' || bucketOf(tk) === 'today').length;
  const openCountText = openCount === 0 ? t('home.allDoneToday') : openCount === 1 ? t('home.openTodaySingle') : t('home.openTodayPlural', { n: openCount });
  const inboxChipText = inboxCount === 1 ? t('home.inboxSingle') : t('home.inboxPlural', { n: inboxCount });

  return (
    <div className="content-container mx-auto px-4 py-6 sm:px-8 sm:py-10">
      <header className="mb-6 anim-fade-up">
        <p className="text-title-m text-on-surface-variant">{new Date().toLocaleDateString(locale(lang), { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        <h1 className="mt-1 text-display-s sm:text-display-m">{greeting} 👋</h1>
        <p className="mt-3 text-title-l">{openCountText}</p>
        <p className="mt-1 text-body-l text-on-surface-variant">{t(features.para.enabled ? 'home.subtitle' : 'home.subtitleNoPara')}</p>
      </header>

      {(showDailyBtn || (inboxZero && inboxCount > 0) || reviewDue()) && (
        <div className="mb-6 flex flex-wrap gap-2.5 anim-fade-up">
          {showDailyBtn && (
            <button
              type="button"
              className="btn-outlined"
              onClick={() => void vault.openDailyNote().then((n) => navigate(`/n/${n.id}`))}
            >
              <CalendarDays size={18} /> {t('daily.todayBtn')}
            </button>
          )}
          {inboxZero && inboxCount > 0 && (
            <button className="chip text-on-surface" onClick={() => navigate('/inbox')}>
              <InboxIcon size={18} className="text-warn" /> {inboxChipText}
            </button>
          )}
          {reviewDue() && (
            <button className="chip text-on-surface" onClick={() => navigate('/review')}>
              <CalendarCheck size={18} className="text-primary" /> {t('home.reviewDueChip')}
            </button>
          )}
        </div>
      )}

      <hr className="my-7 border-0 border-t border-outline-variant/80" />

      <section aria-labelledby="home-tasks-heading">
        <div className="mb-3 flex items-center justify-between px-1 anim-fade-up">
          <h2 id="home-tasks-heading" className="text-title-m">
            {t('home.tasksTitle')}
          </h2>
          <div className="flex items-center gap-1">
            {tasks.length > 0 && layout === 'list' && (
              <button
                className="btn-icon"
                aria-pressed={compact}
                onClick={() => setCompact(!compact)}
                title={compact ? t('home.viewNormalTitle') : t('home.viewCompactTitle')}
                aria-label={compact ? t('home.viewNormal') : t('home.viewCompact')}
              >
                {compact ? <List size={24} /> : <AlignJustify size={24} />}
              </button>
            )}
            <div role="group" aria-label={t('home.layoutAria')} className="segmented">
              {(
                [
                  ['list', ListChecks, 'home.layoutList'],
                  ['kanban', Kanban, 'home.layoutKanban'],
                ] as const
              ).map(([id, Icon, key]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={layout === id}
                  title={t(key)}
                  onClick={() => setLayout(id)}
                  aria-label={t(key)}
                >
                  {layout === id ? <Check size={18} /> : <Icon size={18} />} <span className="max-sm:hidden">{t(key)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <form
          className="edit-only mb-6 flex min-h-14 items-center gap-3 rounded-t-[var(--shape-xs)] border-b border-on-surface-variant bg-surface-container-highest py-1 pl-3 pr-2 transition-colors focus-within:border-primary focus-within:shadow-[inset_0_-1px_0_rgb(var(--primary))] anim-fade-up"
          onSubmit={(e) => {
            e.preventDefault();
            if (!input.trim()) return;
            void vault.addFreeTask(input.trim());
            setInput('');
          }}
        >
          <Plus size={24} className="shrink-0 text-on-surface-variant" />
          <input
            className="min-w-0 flex-1 bg-transparent py-2 text-body-l outline-none placeholder:text-on-surface-variant"
            placeholder={t('home.taskInputPlaceholder')}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button className="btn-tonal max-sm:!px-4" disabled={!input.trim()}>
            {t('home.addBtn')}
          </button>
        </form>

        {layout === 'kanban' ? (
          <TaskKanban tasks={allTasks} />
        ) : (
          <div className={compact ? 'space-y-3' : 'space-y-5'}>
            {BUCKETS.map((b) => {
              const list = tasks.filter((tk) => bucketOf(tk) === b.id);
              if (!list.length) return null;
              if (b.id === 'someday' && !showSomeday) {
                return (
                  <button key={b.id} className="btn-ghost text-sm" onClick={() => setShowSomeday(true)}>
                    {t('home.showSomedayBtn', { n: list.length })}
                  </button>
                );
              }
              return (
                <div key={b.id} className="anim-fade-up">
                  <h3 className={`mb-2 px-4 text-title-s ${b.tone}`}>
                    {t(b.labelKey)} <span className="text-on-surface-variant">· {list.length}</span>
                  </h3>
                  <ul className="stagger flex flex-col gap-0.5">
                    {list.map((tk) => (
                      <TaskItem key={`${tk.noteId}:${tk.line}:${tk.text}`} task={tk} compact={compact} />
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {features.para.enabled && (
        <>
          <hr className="my-8 border-0 border-t border-outline-variant/80" />

          <section aria-labelledby="home-projects-heading" className="anim-fade-up">
            <div className="mb-4 flex flex-wrap items-center gap-3 px-1">
              <h2 id="home-projects-heading" className="min-w-0 flex-1 text-title-m">
                {t('home.projectsTitle')}
              </h2>
              <button
                className="edit-only btn-tonal ml-auto"
                onClick={() => openDialog({ kind: 'note', folder: features.para.folders.projects })}
              >
                <Plus size={18} /> {t('home.addProject')}
              </button>
            </div>
            {projects.length === 0 ? (
              <p className="px-1 text-sm text-on-surface-variant">{t('home.noProjectsYet')}</p>
            ) : (
              <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2">
                {projects.map((p) => (
                  <button key={p.id} onClick={() => navigate(`/n/${p.id}`)} className="card min-w-0 p-4 text-left transition-all duration-200 hover:bg-surface-container">
                    <div className="flex items-center gap-2">
                      <Briefcase size={15} className="shrink-0 text-primary" />
                      <span className="truncate font-medium">{p.title}</span>
                      {p.status === 'pausiert' && <span className="chip text-warn">{t('home.statusPaused')}</span>}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                      {p.openTasks ? (
                        <span className="chip">{t('home.projectOpenTasks', { n: p.openTasks })}</span>
                      ) : (
                        <span className="chip text-warn">{t('home.projectNoNextStep')}</span>
                      )}
                      {p.nextDue && <span className="cm-due">📅 {formatDue(p.nextDue)}</span>}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      <hr className="my-8 border-0 border-t border-outline-variant/80" />

      <section aria-labelledby="home-recent-heading">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 px-1">
          <h2 id="home-recent-heading" className="text-title-s text-on-surface-variant">
            {t('home.recentTitle')}
          </h2>
          <ViewSwitch />
        </div>
        <NoteCollection notes={recent} cols="sm:grid-cols-2" />
      </section>

      {features.heatmap.enabled && (
        <>
          <hr className="my-8 border-0 border-t border-outline-variant/80" />
          <ActivityHeatmap embedded />
        </>
      )}
    </div>
  );
}
