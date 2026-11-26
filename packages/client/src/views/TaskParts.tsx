/**
 * Building blocks for task lists (#45): the rows, the Kanban board and the date/repeat popover, shared by
 * the home page and the task page (`/tasks`). `collectTasks` gathers the tasks of the vault once per
 * vault version.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Ban, CalendarClock, ListChecks, Plus, Repeat, X } from '../lib/icons';
import { NoteMemo, TASK_STATUSES, type OnlineTaskNote, Task, TaskBucket, TaskStatus, bucketOf, linkTasks, parseTasks, withDependencies, projectTitleOf, roleOfPath, shortcutDate, splitPath } from '@kladde/shared';
import { vault } from '../data/vault';
import { onlineTasks, taskOfTuple } from '../data/onlineTasks';
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
  { id: 'overdue', labelKey: 'home.bucketOverdue', tone: 'text-red' },
  { id: 'today', labelKey: 'home.bucketToday', tone: 'text-amber' },
  { id: 'upcoming', labelKey: 'home.bucketNext', tone: 'text-violet' },
  { id: 'someday', labelKey: 'home.taskNoDate', tone: 'text-muted' },
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
/** Progress of the subtasks ("2 / 5") and whether the task waits for another one (#75) */
export function TaskLinks({ task }: { task: Task }) {
  return (
    <>
      {task.waiting && (
        <span className="chip shrink-0 border-amber/40 px-2 py-0 text-[11px] text-amber" data-task-waiting="" title={t('tasks.waitingTitle', { ids: (task.after ?? []).join(', ') })}>
          <Ban size={11} /> {t('tasks.waiting')}
        </span>
      )}
      {task.subtasks && (
        <span
          className={`chip shrink-0 px-2 py-0 font-mono text-[11px] ${task.subtasks.done === task.subtasks.total ? 'text-green' : 'text-soft'}`}
          data-task-progress=""
          title={t('tasks.subtasksTitle', { done: task.subtasks.done, total: task.subtasks.total })}
        >
          <ListChecks size={11} /> {task.subtasks.done}/{task.subtasks.total}
        </span>
      )}
    </>
  );
}

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
  const hasMeta = task.status === 'doing' || task.status === 'blocked' || !!task.due || !!task.repeat || !!task.noteTitle || !!task.subtasks || !!task.waiting;
  const top = !compact && hasMeta;
  return (
    <li
      title={task.noteTitle ? t('home.taskDoubleClickHint') : undefined}
      onDoubleClick={(e) => {
        if (!task.noteTitle || (e.target as HTMLElement).closest('input,button,select')) return;
        navigate(`/n/${task.noteId}?line=${task.line + 1}`);
      }}
      className={`group flex gap-3 border-b border-line px-3.5 transition-all duration-300 last:border-b-0 hover:bg-raised/60 ${compact ? 'py-1.5' : 'py-2'} ${top ? 'items-start' : 'items-center'} ${leaving ? 'translate-x-4 opacity-0' : ''}`}
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
          <TaskLinks task={task} />
          {task.repeat && <Repeat size={11} className="shrink-0 text-on-surface-variant" />}
          {task.due && <span className={`cm-due shrink-0 ${bucket === 'overdue' ? 'overdue' : bucket === 'today' ? 'today' : ''}`}>{formatDue(task.due)}</span>}
          <button className="hidden max-w-[30%] shrink-0 truncate text-xs text-on-surface-variant hover:text-primary sm:block" onClick={() => navigate(`/n/${task.noteId}`)}>
            {task.noteTitle}
          </button>
        </>
      ) : (
        <div className="min-w-0 flex-1">
          <div className={`break-words text-body-m text-body ${task.done ? '!text-faint line-through' : ''}`}>{task.text || t('home.taskEmpty')}</div>
          {hasMeta && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <StatusChip status={task.status} />
              <TaskLinks task={task} />
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
export function TaskRows({ tasks, compact, className = 'stagger flex flex-col overflow-hidden rounded-lg border border-line bg-panel' }: { tasks: TaskRow[]; compact: boolean; className?: string }) {
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
              const hasMeta = (!!tk.due && tk.status !== 'done') || !!tk.repeat || !!tk.noteTitle || !!tk.subtasks || !!tk.waiting;
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
                        <TaskLinks task={tk} />
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


const rowMemo = new NoteMemo<TaskRow[]>();
const EMPTY: TaskRow[] = [];
/** Online mode: rows of a note from the server, kept while its answer, path and the day's settings stay the same */
const remoteRows = new WeakMap<OnlineTaskNote, { key: string; rows: TaskRow[] }>();

/** The task rows per note, once per vault version and day (shared by the sorted list and the badge count) */
let rowsCache: { version: number; day: string; rows: TaskRow[][] } | null = null;

/** Online mode: the rows from the server, kept until a path, the server's answer or the day's settings change */
let remoteCache: { key: string; rows: TaskRow[][] } | null = null;

function remoteTaskRows(prefix: string, dueOf: (path: string) => string | null, roleConfig: ReturnType<typeof vault.roleConfig>): TaskRow[][] {
  const key = `${vault.getPathStamp()}|${onlineTasks.stamp}|${prefix}`;
  if (remoteCache?.key === key) return remoteCache.rows;
  const rows: TaskRow[][] = [];
  for (const remote of onlineTasks.notes.values()) {
    const n = vault.get(remote.id);
    // Notes whose text is on the device are parsed there (with the edits not yet on the server)
    if (!n?.partial) continue;
    const defaultDue = n.access === 'owner' ? dueOf(n.path) : null;
    const noteKey = `${prefix}${defaultDue ?? ''}|${n.path}`;
    let hit = remoteRows.get(remote);
    if (hit?.key !== noteKey) {
      const noteTitle = remote.title ?? projectTitleOf(n.path, '', roleConfig);
      const folder = splitPath(n.path).folder;
      const list = roleOfPath(n.path, roleConfig) === 'archive' ? EMPTY : linkTasks(remote.tasks.map((tk) => ({ ...taskOfTuple(tk, defaultDue), noteId: n.id, noteTitle, folder })));
      hit = { key: noteKey, rows: list };
      remoteRows.set(remote, hit);
    }
    if (hit.rows.length) rows.push(hit.rows);
  }
  remoteCache = { key, rows };
  return rows;
}

function taskRowsByNote(version: number): TaskRow[][] {
  const day = new Date().toDateString();
  if (rowsCache && rowsCache.version === version && rowsCache.day === day) return rowsCache.rows;
  const rows: TaskRow[][] = [];
  const dueOf = vault.taskDueResolver();
  const roleConfig = vault.roleConfig();
  const free = vault.freeTasksNote();
  if (free) rows.push(parseTasks(free.content).map((tk) => ({ ...tk, noteId: free.id, noteTitle: '', folder: '' })));
  // Rows per note are kept until the note, the day, its default due date or the folder roles change (#64)
  const prefix = `${day}|${JSON.stringify(roleConfig)}|`;
  if (vault.online) {
    onlineTasks.want();
    for (const noteRows of remoteTaskRows(prefix, dueOf, roleConfig)) rows.push(noteRows);
  }
  for (const n of vault.list()) {
    // Online mode: a catalog entry has no text; its tasks come from the server's index (above)
    if (n.partial) continue;
    const defaultDue = n.access === 'owner' ? dueOf(n.path) : null;
    const noteRows = rowMemo.get(n, defaultDue ? prefix + defaultDue : prefix, () => {
      if (roleOfPath(n.path, roleConfig) === 'archive') return EMPTY;
      const tasks = parseTasks(n.content, undefined, defaultDue);
      if (!tasks.length) return EMPTY;
      const noteTitle = projectTitleOf(n.path, n.content, roleConfig);
      const folder = splitPath(n.path).folder;
      return tasks.map((tk) => ({ ...tk, noteId: n.id, noteTitle, folder }));
    });
    if (noteRows.length) rows.push(noteRows);
  }
  rowsCache = { version, day, rows };
  return rows;
}

let cache: { rows: TaskRow[][]; tasks: TaskRow[] } | null = null;

/**
 * Every task of the vault (open and done) with its note, sorted by due date. Notes in the PARA archive
 * are left out. Cached per vault version and day, so the pages share one parse.
 */
export function collectTasks(version: number): TaskRow[] {
  const rows = taskRowsByNote(version);
  // A new vault version mostly keeps every note's rows: then the sorted list stays too
  if (cache && (cache.rows === rows || (cache.rows.length === rows.length && cache.rows.every((r, i) => r === rows[i])))) {
    cache.rows = rows;
    return cache.tasks;
  }
  const collected: TaskRow[] = [];
  for (const noteRows of rows) for (const row of noteRows) collected.push(row);
  // Dependencies across notes (#75): a task waits while one it names is open in any note
  const out = withDependencies(collected).slice();
  // ISO dates sort as plain strings; localeCompare costs seconds with 100,000s of tasks
  out.sort((a, b) => {
    const x = a.due ?? '9999';
    const y = b.due ?? '9999';
    return x < y ? -1 : x > y ? 1 : 0;
  });
  cache = { rows, tasks: out };
  return out;
}

/** Urgent tasks per note's rows: the badge counts again only the notes that changed */
const urgentOf = new WeakMap<TaskRow[], { day: string; count: number }>();

/** Open tasks that are overdue or due today (navigation badge, home header) */
export function urgentTaskCount(version: number): number {
  const day = new Date().toDateString();
  let total = 0;
  for (const noteRows of taskRowsByNote(version)) {
    let hit = urgentOf.get(noteRows);
    if (hit?.day !== day) {
      let count = 0;
      for (const tk of noteRows) {
        if (tk.done) continue;
        const b = bucketOf(tk);
        if (b === 'overdue' || b === 'today') count++;
      }
      hit = { day, count };
      urgentOf.set(noteRows, hit);
    }
    total += hit.count;
  }
  return total;
}

/** One line to add a task (`due:`/`every:` understood), as the first row of a task card */
export function TaskQuickAdd() {
  useLang();
  const [input, setInput] = useState('');
  return (
    <form
      className="edit-only flex items-center gap-2.5 border-b border-line px-3.5 py-1.5 focus-within:bg-raised/50"
      onSubmit={(e) => {
        e.preventDefault();
        if (!input.trim()) return;
        void vault.addFreeTask(input.trim());
        setInput('');
      }}
    >
      <Plus size={16} className="shrink-0 text-muted" />
      <input
        className="min-w-0 flex-1 bg-transparent py-1.5 text-body-m outline-none placeholder:text-muted"
        placeholder={t('home.taskInputPlaceholder')}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        aria-label={t('home.taskInputPlaceholder')}
      />
      {input.trim() && <button className="btn-tonal !h-7">{t('home.addBtn')}</button>}
    </form>
  );
}

/** Tasks grouped by due date inside a card: a colored caption per group (overdue, today, next, no date) */
export function TaskBuckets({ tasks, compact, done = [] }: { tasks: TaskRow[]; compact: boolean; done?: TaskRow[] }) {
  useLang();
  return (
    <>
      {BUCKETS.map((b) => {
        const list = tasks.filter((tk) => bucketOf(tk) === b.id);
        if (!list.length) return null;
        return (
          <div key={b.id} className="anim-fade-up">
            <h3 className={`flex items-center gap-2 px-3.5 pb-1 pt-3 text-label-m font-semibold ${b.tone}`}>
              {t(b.labelKey)} <span key={list.length} className="num-tick font-mono text-muted">{list.length}</span>
            </h3>
            <TaskRows tasks={list} compact={compact} className="stagger flex flex-col border-y border-line" />
          </div>
        );
      })}
      {done.length > 0 && (
        <div className="anim-fade-up">
          <h3 className="flex items-center gap-2 px-3.5 pb-1 pt-3 text-label-m font-semibold text-green">
            {t('task.status.done')} <span className="font-mono text-muted">{done.length}</span>
          </h3>
          <TaskRows tasks={done} compact={compact} className="flex flex-col border-y border-line" />
        </div>
      )}
    </>
  );
}
