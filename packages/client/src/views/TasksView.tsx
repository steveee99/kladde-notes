/**
 * The task page (`/tasks`, #45): every task of the vault, including the ones without a due date, as a
 * list grouped by bucket or as a Kanban board. Filters (status, folder, done) and the sort order are
 * remembered per device.
 */
import { useMemo, useState } from 'react';
import { AlignJustify, Check, Kanban, List, ListChecks, Plus } from '../lib/icons';
import { bucketOf, toDateString, type TaskStatus } from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import { BUCKETS, TaskItem, TaskKanban, collectTasks, type TaskRow } from './TaskParts';
import { Dropdown } from './Dropdown';
import { Switch } from './Switch';
import { folderDisplayName, t, useLang } from '../lib/i18n';

type Sort = 'due' | 'note' | 'text';
type StatusFilter = 'all' | Exclude<TaskStatus, 'done'>;

interface TaskPagePrefs {
  layout: 'list' | 'kanban';
  compact: boolean;
  status: StatusFilter;
  /** Folder of the note, `*` for all, `` for the free tasks and top-level notes */
  folder: string;
  sort: Sort;
  showDone: boolean;
}

const PREFS_KEY = 'kladde.tasksPage';
const DEFAULTS: TaskPagePrefs = { layout: 'list', compact: false, status: 'all', folder: '*', sort: 'due', showDone: false };

function readPrefs(): TaskPagePrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<TaskPagePrefs>;
    return {
      layout: raw.layout === 'kanban' ? 'kanban' : 'list',
      compact: raw.compact === true,
      status: raw.status === 'open' || raw.status === 'doing' || raw.status === 'blocked' ? raw.status : 'all',
      folder: typeof raw.folder === 'string' ? raw.folder : '*',
      sort: raw.sort === 'note' || raw.sort === 'text' ? raw.sort : 'due',
      showDone: raw.showDone === true,
    };
  } catch {
    return DEFAULTS;
  }
}

/** Ordering inside a bucket */
function compare(sort: Sort): (a: TaskRow, b: TaskRow) => number {
  if (sort === 'note') return (a, b) => a.noteTitle.localeCompare(b.noteTitle) || a.line - b.line;
  if (sort === 'text') return (a, b) => a.text.localeCompare(b.text);
  return (a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.noteTitle.localeCompare(b.noteTitle) || a.line - b.line;
}

export function TasksView() {
  const version = useVault();
  const lang = useLang();
  const [prefs, setPrefsState] = useState(readPrefs);
  const [input, setInput] = useState('');
  const setPrefs = (patch: Partial<TaskPagePrefs>) =>
    setPrefsState((p) => {
      const next = { ...p, ...patch };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });

  const all = collectTasks(version);
  const folders = useMemo(() => [...new Set(all.map((tk) => tk.folder))].sort((a, b) => a.localeCompare(b)), [all]);
  // A remembered folder that no longer has tasks falls back to "all folders"
  const folder = prefs.folder === '*' || folders.includes(prefs.folder) ? prefs.folder : '*';

  const filtered = useMemo(() => {
    const since = new Date();
    since.setDate(since.getDate() - 1);
    const recent = toDateString(since);
    return all
      .filter((tk) => folder === '*' || tk.folder === folder)
      .filter((tk) => (tk.done ? prefs.showDone || (prefs.layout === 'kanban' && !!tk.doneDate && tk.doneDate >= recent) : prefs.status === 'all' || tk.status === prefs.status))
      .sort(compare(prefs.sort));
  }, [all, folder, prefs.showDone, prefs.status, prefs.sort, prefs.layout]);
  const open = filtered.filter((tk) => !tk.done);
  const done = filtered.filter((tk) => tk.done);
  const openTotal = all.filter((tk) => !tk.done).length;

  const folderLabel = (f: string) => (f ? folderDisplayName(f, lang) : t('tasks.folderTop'));

  return (
    <div className="content-container mx-auto px-4 py-6 sm:px-8 sm:py-10">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3 anim-fade-up">
        <div className="min-w-0">
          <h1 className="text-headline-m">{t('tasks.title')}</h1>
          <p className="mt-1 text-body-l text-on-surface-variant">{openTotal === 1 ? t('tasks.openSingle') : t('tasks.openPlural', { n: openTotal })}</p>
        </div>
        <div className="flex items-center gap-1">
          {prefs.layout === 'list' && (
            <button
              className="btn-icon"
              aria-pressed={prefs.compact}
              onClick={() => setPrefs({ compact: !prefs.compact })}
              title={prefs.compact ? t('home.viewNormalTitle') : t('home.viewCompactTitle')}
              aria-label={prefs.compact ? t('home.viewNormal') : t('home.viewCompact')}
            >
              {prefs.compact ? <List size={24} /> : <AlignJustify size={24} />}
            </button>
          )}
          <div role="group" aria-label={t('home.layoutAria')} className="segmented">
            {(
              [
                ['list', ListChecks, 'home.layoutList'],
                ['kanban', Kanban, 'home.layoutKanban'],
              ] as const
            ).map(([id, Icon, key]) => (
              <button key={id} type="button" aria-pressed={prefs.layout === id} title={t(key)} aria-label={t(key)} onClick={() => setPrefs({ layout: id })}>
                {prefs.layout === id ? <Check size={18} /> : <Icon size={18} />} <span className="max-sm:hidden">{t(key)}</span>
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-2 anim-fade-up">
        {prefs.layout === 'list' && (
          <Dropdown
            variant="chip"
            value={prefs.status}
            aria-label={t('tasks.filterStatus')}
            onChange={(v) => setPrefs({ status: v as StatusFilter })}
            options={[
              { value: 'all', label: t('tasks.statusAll') },
              { value: 'open', label: t('task.status.open') },
              { value: 'doing', label: t('task.status.doing') },
              { value: 'blocked', label: t('task.status.blocked') },
            ]}
          />
        )}
        <Dropdown
          variant="chip"
          value={folder}
          aria-label={t('tasks.filterFolder')}
          onChange={(v) => setPrefs({ folder: v })}
          options={[{ value: '*', label: t('tasks.folderAll') }, ...folders.map((f) => ({ value: f, label: folderLabel(f) }))]}
        />
        <Dropdown
          variant="chip"
          value={prefs.sort}
          aria-label={t('tasks.sortLabel')}
          onChange={(v) => setPrefs({ sort: v as Sort })}
          options={[
            { value: 'due', label: t('tasks.sortDue') },
            { value: 'note', label: t('tasks.sortNote') },
            { value: 'text', label: t('tasks.sortText') },
          ]}
        />
        <label className="ml-auto flex items-center gap-3 text-body-m text-on-surface-variant">
          {t('tasks.showDone')}
          <Switch checked={prefs.showDone} label={t('tasks.showDone')} onChange={(v) => setPrefs({ showDone: v })} />
        </label>
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

      {prefs.layout === 'kanban' ? (
        <TaskKanban tasks={filtered} />
      ) : filtered.length === 0 ? (
        <p className="py-10 text-center text-body-l text-on-surface-variant">{all.length ? t('tasks.emptyFiltered') : t('tasks.empty')}</p>
      ) : (
        <div className={prefs.compact ? 'space-y-3' : 'space-y-5'}>
          {BUCKETS.map((b) => {
            const list = open.filter((tk) => bucketOf(tk) === b.id);
            if (!list.length) return null;
            return (
              <div key={b.id} className="anim-fade-up">
                <h2 className={`mb-2 px-4 text-title-s ${b.tone}`}>
                  {t(b.labelKey)} <span className="text-on-surface-variant">· {list.length}</span>
                </h2>
                <ul className="stagger flex flex-col gap-0.5">
                  {list.map((tk) => (
                    <TaskItem key={`${tk.noteId}:${tk.line}:${tk.text}`} task={tk} compact={prefs.compact} />
                  ))}
                </ul>
              </div>
            );
          })}
          {done.length > 0 && (
            <div className="anim-fade-up">
              <h2 className="mb-2 px-4 text-title-s text-ok">
                {t('task.status.done')} <span className="text-on-surface-variant">· {done.length}</span>
              </h2>
              <ul className="flex flex-col gap-0.5">
                {done.map((tk) => (
                  <TaskItem key={`${tk.noteId}:${tk.line}:${tk.text}`} task={tk} compact={prefs.compact} />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
