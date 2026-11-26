import { useMemo, useState } from 'react';
import { AlignJustify, ArrowRight, Briefcase, CalendarCheck, CalendarDays, Kanban, List, ListChecks, Plus } from '../lib/icons';
import { INBOX_FOLDER, Task, bucketOf, isHiddenPath, isoWeek, projectTitleOf, projectsOf, splitPath, toDateString } from '@kladde/shared';
import { openDialog } from '../lib/dialogs';
import { reviewDue } from './Review';
import { useVault, vault } from '../data/vault';
import { navigate } from '../lib/router';
import { useReadOnly } from '../lib/readOnly';
import { formatDue } from '../editor/widgets';
import { PageBody, PageHeader, Panel } from './PageHeader';
import { HabitsToday } from './HabitsToday';
import { habits as loadHabits } from '../data/habits';
import { ActivityHeatmap } from './ActivityHeatmap';
import { FlightGame, minigameBest } from './FlightGame';
import { TaskBuckets, TaskKanban, TaskQuickAdd, collectTasks } from './TaskParts';
import { locale, t, useLang } from '../lib/i18n';
import { useInboxZero } from '../lib/prefs';

export function HomeView() {
  const version = useVault();
  const lang = useLang();
  const inboxZero = useInboxZero();
  const locked = useReadOnly();
  const habitsList = vault.features().habits.enabled ? loadHabits() : [];
  const [best, setBest] = useState(minigameBest);
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

  const own = notes.filter((n) => n.access === 'owner' && !isHiddenPath(n.path));
  const features = vault.features();
  const dailyNote = features.daily.enabled ? vault.findDailyNote() : undefined;
  const showDailyBtn = features.daily.enabled && (!locked || !!dailyNote);
  const projects = features.para.enabled
    ? projectsOf(own, new Date(), roleConfig).sort((a, b) => (a.status === b.status ? b.updatedAt - a.updatedAt : a.status === 'aktiv' ? -1 : 1))
    : [];
  const todayStr = toDateString(new Date());
  const inboxCount = own.filter((n) => splitPath(n.path).folder === INBOX_FOLDER).length;
  // Database notes (`_database-<uuid>.md`) are folder settings, no notes to go back to
  const recent = [...notes].filter((n) => !isHiddenPath(n.path)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
  const openCount = tasks.filter((tk) => bucketOf(tk) === 'overdue' || bucketOf(tk) === 'today').length;
  const openCountText = openCount === 0 ? t('home.allDoneToday') : openCount === 1 ? t('home.openTodaySingle') : t('home.openTodayPlural', { n: openCount });
  const inboxChipText = inboxCount === 1 ? t('home.inboxSingle') : t('home.inboxPlural', { n: inboxCount });

  const inboxNotes = own
    .filter((n) => splitPath(n.path).folder === INBOX_FOLDER)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const dateTitle = new Date().toLocaleDateString(locale(lang), { weekday: 'long', day: 'numeric', month: 'long' });
  const when = (ts: number) =>
    new Date(ts).toDateString() === new Date().toDateString()
      ? new Date(ts).toLocaleTimeString(locale(lang), { hour: '2-digit', minute: '2-digit' })
      : new Date(ts).toLocaleDateString(locale(lang), { day: 'numeric', month: 'short' });

  const layoutSwitch = (
    <>
      {tasks.length > 0 && layout === 'list' && (
        <button
          className="btn-icon h-8 w-8"
          aria-pressed={compact}
          onClick={() => setCompact(!compact)}
          title={compact ? t('home.viewNormalTitle') : t('home.viewCompactTitle')}
          aria-label={compact ? t('home.viewNormal') : t('home.viewCompact')}
        >
          {compact ? <List size={18} /> : <AlignJustify size={18} />}
        </button>
      )}
      <div role="group" aria-label={t('home.layoutAria')} className="segmented !h-7">
        {(
          [
            ['list', ListChecks, 'home.layoutList'],
            ['kanban', Kanban, 'home.layoutKanban'],
          ] as const
        ).map(([id, Icon, key]) => (
          <button key={id} type="button" aria-pressed={layout === id} title={t(key)} onClick={() => setLayout(id)} aria-label={t(key)} className="!px-2">
            <Icon size={16} />
          </button>
        ))}
      </div>
    </>
  );

  return (
    <div>
      <PageHeader
        display
        title={<span className="capitalize">{dateTitle}</span>}
        subtitle={
          <>
            <span className="font-mono text-[12px] text-soft">{t('home.weekShort', { n: isoWeek(new Date()) })}</span> · {openCountText}
          </>
        }
        actions={
          <>
            {reviewDue() && (
              <button className="btn-outlined" onClick={() => navigate('/review')}>
                <CalendarCheck size={16} /> {t('home.reviewDueChip')}
              </button>
            )}
            {showDailyBtn && (
              <button type="button" className="btn-tonal" title={t('daily.todayBtn')} onClick={() => void vault.openDailyNote().then((n) => navigate(`/n/${n.id}`))}>
                <CalendarDays size={16} /> {t('home.dailyOpen')}
              </button>
            )}
          </>
        }
      />
      <PageBody className="grid grid-cols-1 items-start gap-x-8 gap-y-7 pb-24 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <Panel
          labelId="home-tasks-heading"
          label={t('home.tasksTitle')}
          aside={
            <>
              <button type="button" className="btn-text !h-7 !px-2 text-label-m" onClick={() => navigate('/tasks')} title={t('tasks.allTitle')}>
                <span className="hidden sm:inline">{t('tasks.allBtn')}</span> <ArrowRight size={14} />
              </button>
              {layoutSwitch}
            </>
          }
        >
          <TaskQuickAdd />
          {layout === 'kanban' ? (
            <div className="p-3">
              <TaskKanban tasks={allTasks} />
            </div>
          ) : (
            <div className="pb-1">
              <TaskBuckets tasks={tasks} compact={compact} />
              {tasks.length === 0 && <p className="px-3.5 py-4 text-body-m text-muted">{t('home.allDoneToday')}</p>}
              {undated > 0 && (
                <button type="button" className="btn-text mx-2 my-1.5" onClick={() => navigate('/tasks')}>
                  {t('tasks.undatedLink', { n: undated })} <ArrowRight size={14} />
                </button>
              )}
            </div>
          )}
        </Panel>

        <div className="flex min-w-0 flex-col gap-7">
          {vault.features().habits.enabled && habitsList.length > 0 && (
            <Panel
              labelId="home-habits-heading"
              label={t('habits.title')}
              aside={
                <button type="button" className="btn-text !h-7 !px-2 text-label-m" onClick={() => navigate('/habits')} title={t('habits.open')} aria-label={t('habits.open')}>
                  <span className="hidden sm:inline">{t('habits.open')}</span> <ArrowRight size={14} />
                </button>
              }
            >
              <HabitsToday />
            </Panel>
          )}
          {inboxNotes.length > 0 && (
            <Panel
              labelId="home-inbox-heading"
              label={t('nav.inbox')}
              aside={<span className={`pill ${inboxZero ? 'bg-acc-bg text-acc-hi' : 'bg-raised text-soft'}`}>{inboxChipText}</span>}
            >
              <ul>
                {inboxNotes.slice(0, 4).map((n) => (
                  <li key={n.id} className="flex items-center gap-3 border-b border-line px-3.5 py-2 last:border-b-0">
                    <button type="button" className="min-w-0 flex-1 text-left outline-none focus-visible:underline" onClick={() => navigate(`/n/${n.id}`)}>
                      <span className="block truncate text-body-m text-text">{projectTitleOf(n.path, n.content, roleConfig)}</span>
                      <span className="block font-mono text-[11px] text-muted">{when(n.updatedAt)}</span>
                    </button>
                    <button type="button" className="chip shrink-0" onClick={() => navigate('/inbox')}>
                      {t('home.inboxSortIn')}
                    </button>
                  </li>
                ))}
              </ul>
              {inboxNotes.length > 4 && (
                <button type="button" className="btn-text mx-2 my-1.5" onClick={() => navigate('/inbox')}>
                  {t('home.inboxMore', { n: inboxNotes.length })} <ArrowRight size={14} />
                </button>
              )}
            </Panel>
          )}
          {features.heatmap.enabled && <ActivityHeatmap embedded />}
          {features.minigame.enabled && (
            <Panel labelId="home-minigame-heading" label={t('minigame.title')} aside={best > 0 && <span className="pill bg-raised font-mono text-soft">{t('minigame.bestPill', { n: best })}</span>}>
              <FlightGame onBest={setBest} />
            </Panel>
          )}
        </div>

        {features.para.enabled && (
          <Panel
            labelId="home-projects-heading"
            label={t('home.projectsTitle')}
            className="lg:col-span-2"
            aside={
              <button className="edit-only btn-text !h-7 !px-2 text-label-m" onClick={() => openDialog({ kind: 'note', folder: features.para.folders.projects })}>
                <Plus size={14} /> {t('home.addProject')}
              </button>
            }
          >
            {projects.length === 0 ? (
              <p className="px-3.5 py-4 text-body-m text-muted">{t('home.noProjectsYet')}</p>
            ) : (
              <ul className="stagger grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
                {projects.map((p) => (
                  <li key={p.id} className="border-b border-line sm:odd:border-r xl:border-r xl:[&:nth-child(3n)]:border-r-0">
                    <button onClick={() => navigate(`/n/${p.id}`)} className="state-layer flex w-full min-w-0 flex-col gap-1.5 px-3.5 py-2.5 text-left outline-none focus-visible:bg-raised">
                      <span className="flex min-w-0 items-center gap-2">
                        <Briefcase size={14} className="shrink-0 text-amber" />
                        <span className="truncate text-body-m text-text">{p.title}</span>
                        {p.status === 'pausiert' && <span className="pill bg-amber-bg text-amber-hi">{t('home.statusPaused')}</span>}
                      </span>
                      <span className="flex flex-wrap items-center gap-1.5">
                        {p.openTasks ? (
                          <span className="pill bg-raised text-soft">{t('home.projectOpenTasks', { n: p.openTasks })}</span>
                        ) : (
                          <span className="pill bg-amber-bg text-amber-hi">{t('home.projectNoNextStep')}</span>
                        )}
                        {p.nextDue && (
                          <span className={`pill ${p.nextDue < todayStr ? 'bg-red-bg text-red' : p.nextDue === todayStr ? 'bg-amber-bg text-amber-hi' : 'bg-violet-bg text-violet'}`}>
                            {formatDue(p.nextDue)}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}

        <Panel labelId="home-recent-heading" label={t('home.recentTitle')} className="lg:col-span-2">
          <table className="w-full table-fixed border-collapse text-body-m">
            <tbody>
              {recent.map((n) => {
                const { folder } = splitPath(n.path);
                return (
                  <tr key={n.id} className="cursor-pointer border-b border-line last:border-b-0 hover:bg-raised/60" onClick={() => navigate(`/n/${n.id}`)}>
                    <td className="truncate px-3.5 py-2">
                      <a href={`/n/${n.id}`} onClick={(e) => e.preventDefault()} className="text-text no-underline outline-none focus-visible:underline">
                        {projectTitleOf(n.path, n.content, roleConfig)}
                      </a>
                    </td>
                    <td className="hidden truncate px-3 py-2 text-muted sm:table-cell">{n.group ? vault.groups.find((g) => g.id === n.group)?.name ?? '' : folder.replace(/\//g, ' / ')}</td>
                    <td className="w-28 whitespace-nowrap px-3.5 py-2 text-right font-mono text-[11.5px] text-muted">{when(n.updatedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
      </PageBody>
    </div>
  );
}
