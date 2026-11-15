import { useMemo, useState } from 'react';
import { AlignJustify, ArrowRight, Briefcase, Check, CalendarCheck, CalendarDays, Inbox as InboxIcon, Kanban, List, ListChecks, Plus } from '../lib/icons';
import { INBOX_FOLDER, Task, bucketOf, projectsOf, splitPath, toDateString } from '@kladde/shared';
import { openDialog } from '../lib/dialogs';
import { reviewDue } from './Review';
import { useVault, vault } from '../data/vault';
import { navigate } from '../lib/router';
import { useReadOnly } from '../lib/readOnly';
import { formatDue } from '../editor/widgets';
import { NoteCollection, ViewSwitch } from './NoteList';
import { ActivityHeatmap } from './ActivityHeatmap';
import { BUCKETS, TaskItem, TaskKanban, collectTasks } from './TaskParts';
import { locale, t, useLang } from '../lib/i18n';
import { useInboxZero } from '../lib/prefs';

export function HomeView() {
  const version = useVault();
  const lang = useLang();
  const inboxZero = useInboxZero();
  const locked = useReadOnly();
  const [input, setInput] = useState('');
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
   * Tasks with a due date (#45): open ones plus the ones finished today or yesterday (for the board's
   * "done" column). Tasks without a date live on the task page.
   */
  const allTasks = useMemo(() => {
    const since = new Date();
    since.setDate(since.getDate() - 1);
    const recent = toDateString(since);
    const keep = (tk: Task) => !!tk.due && (!tk.done || (!!tk.doneDate && tk.doneDate >= recent));
    return collectTasks(version).filter(keep);
  }, [version]);
  const tasks = useMemo(() => allTasks.filter((tk) => !tk.done), [allTasks]);
  const undated = useMemo(() => collectTasks(version).filter((tk) => !tk.done && !tk.due).length, [version]);

  const own = notes.filter((n) => n.access === 'owner');
  const features = vault.features();
  const dailyNote = features.daily.enabled ? vault.findDailyNote() : undefined;
  const showDailyBtn = features.daily.enabled && (!locked || !!dailyNote);
  const projects = features.para.enabled
    ? projectsOf(own, new Date(), roleConfig).sort((a, b) => (a.status === b.status ? b.updatedAt - a.updatedAt : a.status === 'aktiv' ? -1 : 1))
    : [];
  const todayStr = toDateString(new Date());
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
            <button type="button" className="btn-text" onClick={() => navigate('/tasks')} title={t('tasks.allTitle')}>
              <span className="max-sm:hidden">{t('tasks.allBtn')}</span> <ArrowRight size={18} />
            </button>
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
            {undated > 0 && (
              <button type="button" className="btn-text" onClick={() => navigate('/tasks')}>
                {t('tasks.undatedLink', { n: undated })} <ArrowRight size={18} />
              </button>
            )}
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
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {p.openTasks ? (
                        <span className="chip">{t('home.projectOpenTasks', { n: p.openTasks })}</span>
                      ) : (
                        <span className="chip text-warn">{t('home.projectNoNextStep')}</span>
                      )}
                      {p.nextDue && (
                        // A chip like its neighbours: the bare `.cm-due` pill stretched to the 32 dp row and left its text at the top
                        <span className={`chip ${p.nextDue < todayStr ? 'text-error' : p.nextDue === todayStr ? 'text-warn' : ''}`}>
                          <CalendarDays size={18} className="shrink-0" />
                          {formatDue(p.nextDue)}
                        </span>
                      )}
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
