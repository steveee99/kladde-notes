/**
 * Building blocks for task lists (#45): the rows, the Kanban board and the date/repeat popover, shared by
 * the home page and the task page (`/tasks`). `collectTasks` gathers the tasks of the vault once per
 * vault version.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarClock, Repeat, X } from '../lib/icons';
import { NoteMemo, TASK_STATUSES, Task, TaskBucket, TaskStatus, bucketOf, parseTasks, projectTitleOf, roleOfPath, shortcutDate, splitPath } from '@kladde/shared';
import { vault } from '../data/vault';
import { navigate } from '../lib/router';
import { useReadOnly } from '../lib/readOnly';
import { formatDue, openStatusMenu } from '../editor/widgets';
import { Dropdown } from './Dropdown';
import { t, useLang, type I18nKey } from '../lib/i18n';

export interface TaskRow extends Task {
  noteId: string;
  noteTitle: string;
  /** Folder of the note (empty for the free tasks and top-level notes) */
  folder: string;
}

export const BUCKETS: { id: TaskBucket; labelKey: I18nKey; tone: string }[] = [
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
export function TaskMeta({ task, className = '' }: { task: TaskRow; className?: string }) {
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

export const STATUS_TONE: Record<TaskStatus, string> = { open: 'text-on-surface-variant', doing: 'text-primary', blocked: 'text-warn', done: 'text-ok' };

/** "In Arbeit" / "Blockiert" next to a task in the list (open tasks need no label) */
export function StatusChip({ status }: { status: TaskStatus }) {
  if (status !== 'doing' && status !== 'blocked') return null;
  return <span className={`chip shrink-0 px-2 py-0 text-[11px] ${STATUS_TONE[status]}`}>{t(`task.status.${status}`)}</span>;
}

/** Opens the status picker for a task below `anchor` */
export function pickStatus(anchor: HTMLElement, task: TaskRow, lang: ReturnType<typeof useLang>) {
  openStatusMenu(anchor, task.status, lang, (status) => void vault.setTaskStatus(task.noteId, task.line, status));
}

export function TaskItem({ task, compact }: { task: TaskRow; compact: boolean }) {
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
        data-status={leaving ? (task.done ? 'open' : 'done') : task.status}
        title={t(`task.status.${task.status}`)}
        // The task is the checkbox's name; the status is in the title and the checked state
        aria-label={task.text || t('home.taskEmpty')}
        checked={task.done !== leaving}
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
          <span className={`min-w-0 flex-1 truncate text-sm ${task.done ? 'text-on-surface-variant line-through' : ''}`}>{task.text || t('home.taskEmpty')}</span>
          <StatusChip status={task.status} />
          {task.repeat && <Repeat size={11} className="shrink-0 text-on-surface-variant" />}
          {task.due && <span className={`cm-due shrink-0 ${bucket === 'overdue' ? 'overdue' : bucket === 'today' ? 'today' : ''}`}>{formatDue(task.due)}</span>}
          <button className="hidden max-w-[30%] shrink-0 truncate text-xs text-on-surface-variant hover:text-primary sm:block" onClick={() => navigate(`/n/${task.noteId}`)}>
            {task.noteTitle}
          </button>
        </>
      ) : (
        <div className="min-w-0 flex-1">
          <div className={`break-words text-[15px] leading-snug ${task.done ? 'text-on-surface-variant line-through' : ''}`}>{task.text || t('home.taskEmpty')}</div>
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

/** How many rows a task list or Kanban column shows before "Show more": long lists would build thousands of rows (#64) */
export const TASK_PAGE = 100;

/** "Show n more" below a list that shows only its first rows */
export function ShowMore({ hidden, onMore }: { hidden: number; onMore: () => void }) {
  if (hidden <= 0) return null;
  return (
    <button type="button" className="btn-text mt-1 self-start" onClick={onMore}>
      {t('tasks.showMore', { n: Math.min(hidden, TASK_PAGE * 5) })}
    </button>
  );
}

/** A list of task rows that renders the first `TASK_PAGE` and more on request */
export function TaskRows({ tasks, compact, className = 'stagger flex flex-col gap-0.5' }: { tasks: TaskRow[]; compact: boolean; className?: string }) {
  const [shown, setShown] = useState(TASK_PAGE);
  return (
    <>
      <ul className={className}>
        {tasks.slice(0, shown).map((tk) => (
          <TaskItem key={`${tk.noteId}:${tk.line}:${tk.text}`} task={tk} compact={compact} />
        ))}
      </ul>
      <ShowMore hidden={tasks.length - shown} onMore={() => setShown((n) => n + TASK_PAGE * 5)} />
    </>
  );
}

/**
 * Tasks as a board with one column per status. Dragging a card into another column (or picking a
 * status with the button on the card, which also works on touch screens) rewrites its checkbox.
 */
export function TaskKanban({ tasks }: { tasks: TaskRow[] }) {
  const lang = useLang();
  const locked = useReadOnly();
  const [over, setOver] = useState<TaskStatus | null>(null);
  const [shown, setShown] = useState<Partial<Record<TaskStatus, number>>>({});
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
            {list.slice(0, shown[status] ?? TASK_PAGE).map((tk) => {
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
                    aria-label={`${t('home.taskStatusAria')} (${t(`task.status.${tk.status}`)}): ${tk.text || t('home.taskEmpty')}`}
                    aria-haspopup="menu"
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
            <ShowMore hidden={list.length - (shown[status] ?? TASK_PAGE)} onMore={() => setShown((m) => ({ ...m, [status]: (m[status] ?? TASK_PAGE) + TASK_PAGE * 5 }))} />
            {!list.length && <p className="rounded-xl border border-dashed border-outline-variant/70 px-2 py-5 text-center text-xs text-on-surface-variant">{t('home.kanbanEmpty')}</p>}
          </div>
        );
      })}
    </div>
  );
}


let cache: { version: number; day: string; tasks: TaskRow[] } | null = null;
const rowMemo = new NoteMemo<TaskRow[]>();

/**
 * Every task of the vault (open and done) with its note, sorted by due date. Notes in the PARA archive
 * are left out. Cached per vault version and day, so the navigation badge and the pages share one parse.
 */
export function collectTasks(version: number): TaskRow[] {
  const day = new Date().toDateString();
  if (cache && cache.version === version && cache.day === day) return cache.tasks;
  const out: TaskRow[] = [];
  const dueOf = vault.taskDueResolver();
  const roleConfig = vault.roleConfig();
  const free = vault.freeTasksNote();
  if (free) for (const tk of parseTasks(free.content)) out.push({ ...tk, noteId: free.id, noteTitle: '', folder: '' });
  // Rows per note are kept until the note, the day, its default due date or the folder roles change (#64)
  const roles = JSON.stringify(roleConfig);
  for (const n of vault.list()) {
    const defaultDue = n.access === 'owner' ? dueOf(n.path) : null;
    const rows = rowMemo.get(n, `${day}|${defaultDue ?? ''}|${roles}`, () => {
      if (roleOfPath(n.path, roleConfig) === 'archive') return [];
      const tasks = parseTasks(n.content, undefined, defaultDue);
      if (!tasks.length) return [];
      const noteTitle = projectTitleOf(n.path, n.content, roleConfig);
      const folder = splitPath(n.path).folder;
      return tasks.map((tk) => ({ ...tk, noteId: n.id, noteTitle, folder }));
    });
    for (const row of rows) out.push(row);
  }
  out.sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'));
  cache = { version, day, tasks: out };
  return out;
}

/** Open tasks that are overdue or due today (navigation badge, home header) */
export function urgentTaskCount(version: number): number {
  return collectTasks(version).filter((tk) => {
    if (tk.done) return false;
    const b = bucketOf(tk);
    return b === 'overdue' || b === 'today';
  }).length;
}
