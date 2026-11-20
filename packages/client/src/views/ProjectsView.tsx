import { useState } from 'react';
import { useVault } from '../data/vault';
import { currentMilestone, MilestoneBanner, NewTicketSheet, PriorityIcon, StatusBadge, projectName } from './ProjectView';
import { milestonesOf, myTickets, projects, ticketsAnywhere, ticketsOf, type TicketInfo } from '../data/tickets';
import { navigate } from '../lib/router';
import { t, useLang } from '../lib/i18n';
import { useReadOnly } from '../lib/readOnly';
import { ChevronRight, FolderKanban, Plus, Ticket, Users } from '../lib/icons';
import { PageBody, PageHeader, Panel } from './PageHeader';

const segments = ['active', 'open'] as const;

/** `/projects`: the projects where tickets are on, the user's tickets and a quick "new ticket" */
export function ProjectsView() {
  useVault();
  useLang();
  const readOnly = useReadOnly();
  const [adding, setAdding] = useState(false);
  const [segment, setSegment] = useState<(typeof segments)[number]>('active');
  const list = projects();
  const mine = myTickets();
  const counts = { active: mine.filter((tk) => tk.category === 'active').length, open: mine.filter((tk) => tk.category === 'open').length };
  const shown: TicketInfo[] = mine.filter((tk) => tk.category === segment);
  const canAdd = !readOnly && list.some((p) => p.canWrite);
  const open = (folder: string, group?: string) => navigate(group ? `/g/${encodeURIComponent(group)}/${encodeURIComponent(folder)}` : `/f/${encodeURIComponent(folder)}`);

  const openTotal = list.reduce((n, p) => n + ticketsOf(p).filter((tk) => tk.category !== 'done').length, 0);

  return (
    <div data-projects-page>
      <PageHeader
        title={t('tickets.projectsTitle')}
        subtitle={ticketsAnywhere() ? t(list.length === 1 ? 'tickets.projectsSubtitleOne' : 'tickets.projectsSubtitle', { projects: list.length, open: openTotal }) : undefined}
        actions={
          canAdd && (
            <button className="btn-primary" onClick={() => setAdding(true)} data-new-ticket>
              <Plus size={16} /> {t('tickets.newTicket')}
            </button>
          )
        }
      />
      <PageBody className="space-y-8">
        {!ticketsAnywhere() ? (
          <div className="empty-sheet">
            <p className="empty-title">{t('tickets.featureOff')}</p>
          </div>
        ) : (
          <>
            <Panel
              labelId="my-tickets"
              label={t('tickets.myTickets')}
              aside={
                <div className="segmented !h-7" role="tablist" aria-label={t('tickets.myTickets')}>
                  {segments.map((s) => (
                    <button key={s} role="tab" aria-selected={segment === s} onClick={() => setSegment(s)}>
                      {t(s === 'active' ? 'tickets.catActive' : 'tickets.catOpen')} <span className="font-mono">{counts[s]}</span>
                    </button>
                  ))}
                </div>
              }
            >
              {shown.length === 0 ? (
                <div className="empty-sheet !py-8">
                  <p className="empty-title">{t('tickets.myTicketsEmpty')}</p>
                </div>
              ) : (
                <ul className="divide-y divide-line border-b border-line" data-my-tickets>
                  {shown.map((tk) => (
                    <li key={tk.note.id}>
                      <button className="flex w-full min-w-0 items-center gap-3 px-3.5 py-2 text-left outline-none hover:bg-raised/60 focus-visible:bg-raised" onClick={() => navigate(`/n/${tk.note.id}`)}>
                        <span className="w-16 shrink-0 font-mono text-label-m text-muted">{tk.meta.id ?? `${tk.project.config.key}-?`}</span>
                        <PriorityIcon p={tk.meta.priority} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-body-m text-text">{tk.title}</span>
                          {tk.progress.total > 0 && (
                            <span className="mt-1 block h-1 max-w-48 overflow-hidden rounded-full bg-line">
                              <span className="block h-full bg-acc" style={{ width: `${Math.round((tk.progress.done / tk.progress.total) * 100)}%` }} />
                            </span>
                          )}
                        </span>
                        {tk.milestone && <span className="pill hidden bg-raised text-soft sm:inline-flex">{tk.milestone.title}</span>}
                        <StatusBadge tk={tk} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel labelId="projects-list" label={t('tickets.projectsList')}>
              {list.length === 0 ? (
                <div className="empty-sheet !py-8">
                  <p className="empty-title">{t('tickets.noProjects')}</p>
                  <p className="mt-1">{t('tickets.howToProject')}</p>
                </div>
              ) : (
                <ul className="divide-y divide-line border-b border-line">
                  {list.map((p) => {
                    const tickets = ticketsOf(p);
                    const openCount = tickets.filter((tk) => tk.category !== 'done').length;
                    const current = currentMilestone(milestonesOf(p));
                    return (
                      <li key={p.id} className="space-y-2 px-3.5 py-2.5">
                        <button className="flex w-full items-center gap-3 text-left outline-none focus-visible:underline" onClick={() => open(p.folder, p.group)} data-project-link={p.config.key}>
                          {p.group ? <Users size={18} className="shrink-0 text-muted" /> : <FolderKanban size={18} className="shrink-0 text-muted" />}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-title-s text-strong">{projectName(p)}</span>
                            <span className="block font-mono text-[11.5px] text-muted">{t('tickets.openOfTotal', { open: openCount, total: tickets.length })}</span>
                          </span>
                          <span className="inline-flex h-6 items-center gap-1 rounded-md border border-line2 bg-raised px-1.5 font-mono text-label-m text-strong">
                            <Ticket size={13} /> {p.config.key}
                          </span>
                          <ChevronRight size={16} className="shrink-0 text-muted" />
                        </button>
                        {current && <MilestoneBanner m={current} />}
                      </li>
                    );
                  })}
                </ul>
              )}
              {list.length > 0 && <p className="mt-3 px-3.5 text-body-s text-muted">{t('tickets.howToProject')}</p>}
            </Panel>
          </>
        )}
      </PageBody>
      {adding && <NewTicketSheet onClose={() => setAdding(false)} />}
    </div>
  );
}
