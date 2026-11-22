/**
 * The task page (`/tasks`, #45): every task of the vault, including the ones without a due date, as a
 * list grouped by bucket or as a Kanban board. Filters (status, folder, done) and the sort order are
 * remembered per device.
 */
import { useMemo, useState } from 'react';
import { AlignJustify, AtSign, Kanban, List, ListChecks } from '../lib/icons';
import { mentionsUser, toDateString, type TaskStatus } from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import { TaskBuckets, TaskKanban, TaskQuickAdd, collectTasks, type TaskRow } from './TaskParts';
import { PageBody, PageHeader } from './PageHeader';
import { Dropdown } from './Dropdown';
import { Switch } from './Switch';
import { compareText, folderDisplayName, t, useLang } from '../lib/i18n';

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
  /** Only tasks that mention the user (`@username`, #69) */
  mine: boolean;
}

const PREFS_KEY = 'kladde.tasksPage';
const DEFAULTS: TaskPagePrefs = { layout: 'list', compact: false, status: 'all', folder: '*', sort: 'due', showDone: false, mine: false };

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
      mine: raw.mine === true,
    };
  } catch {
    return DEFAULTS;
  }
}

/** Ordering inside a bucket */
function compare(sort: Sort): (a: TaskRow, b: TaskRow) => number {
  if (sort === 'note') return (a, b) => compareText(a.noteTitle, b.noteTitle) || a.line - b.line;
  if (sort === 'text') return (a, b) => compareText(a.text, b.text);
  return (a, b) => {
    const x = a.due ?? '9999';
    const y = b.due ?? '9999';
    return x < y ? -1 : x > y ? 1 : compareText(a.noteTitle, b.noteTitle) || a.line - b.line;
  };
}

export function TasksView() {
  const version = useVault();
  const lang = useLang();
  const [prefs, setPrefsState] = useState(readPrefs);
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
  const folders = useMemo(() => [...new Set(all.map((tk) => tk.folder))].sort(compareText), [all]);
  // A remembered folder that no longer has tasks falls back to "all folders"
  const folder = prefs.folder === '*' || folders.includes(prefs.folder) ? prefs.folder : '*';

  const filtered = useMemo(() => {
    const since = new Date();
    since.setDate(since.getDate() - 1);
    const recent = toDateString(since);
    const me = prefs.mine && vault.features().mentions.enabled ? vault.actorName : '';
    return all
      .filter((tk) => folder === '*' || tk.folder === folder)
      .filter((tk) => !me || mentionsUser(tk.text, me))
      .filter((tk) => (tk.done ? prefs.showDone || (prefs.layout === 'kanban' && !!tk.doneDate && tk.doneDate >= recent) : prefs.status === 'all' || tk.status === prefs.status))
      .sort(compare(prefs.sort));
  }, [all, folder, prefs.showDone, prefs.status, prefs.sort, prefs.layout, prefs.mine]);
  const open = filtered.filter((tk) => !tk.done);
  const done = filtered.filter((tk) => tk.done);
  const openTotal = all.filter((tk) => !tk.done).length;

  const folderLabel = (f: string) => (f ? folderDisplayName(f, lang) : t('tasks.folderTop'));

  return (
    <div>
      <PageHeader
        title={t('tasks.title')}
        subtitle={openTotal === 1 ? t('tasks.openSingle') : t('tasks.openPlural', { n: openTotal })}
        actions={
        <div className="flex items-center gap-1">
          {prefs.layout === 'list' && (
            <button
              className="btn-icon h-8 w-8"
              aria-pressed={prefs.compact}
              onClick={() => setPrefs({ compact: !prefs.compact })}
              title={prefs.compact ? t('home.viewNormalTitle') : t('home.viewCompactTitle')}
              aria-label={prefs.compact ? t('home.viewNormal') : t('home.viewCompact')}
            >
              {prefs.compact ? <List size={18} /> : <AlignJustify size={18} />}
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
                <Icon size={16} /> <span className="hidden sm:inline">{t(key)}</span>
              </button>
            ))}
          </div>
        </div>
        }
      >
      <div className="mt-3 flex flex-wrap items-center gap-2">
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
        {vault.features().mentions.enabled && !vault.standalone && (
          <button type="button" className="chip" aria-pressed={prefs.mine} onClick={() => setPrefs({ mine: !prefs.mine })} data-assigned-to-me>
            <AtSign size={14} /> {t('tasks.assignedToMe')}
          </button>
        )}
        <label className="ml-auto flex items-center gap-2 text-body-m text-muted">
          {t('tasks.showDone')}
          <Switch checked={prefs.showDone} label={t('tasks.showDone')} onChange={(v) => setPrefs({ showDone: v })} />
        </label>
      </div>
      </PageHeader>
      <PageBody>

      {prefs.layout === 'kanban' ? (
        <TaskKanban tasks={filtered} />
      ) : (
        <div className="card overflow-hidden pb-1">
          <TaskQuickAdd />
          {filtered.length === 0 ? (
            <div className="empty-sheet"><p className="empty-title">{all.length ? t('tasks.emptyFiltered') : t('tasks.empty')}</p></div>
          ) : (
            <TaskBuckets tasks={open} done={done} compact={prefs.compact} />
          )}
        </div>
      )}
      </PageBody>
    </div>
  );
}
