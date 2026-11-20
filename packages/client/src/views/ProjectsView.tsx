import { useState } from 'react';
import { useVault } from '../data/vault';
import { currentMilestone, MilestoneBanner, NewTicketSheet, PriorityIcon, StatusBadge, projectName } from './ProjectView';
import { milestonesOf, myTickets, projects, ticketsAnywhere, ticketsOf, type TicketInfo } from '../data/tickets';
import { navigate } from '../lib/router';
import { t, useLang } from '../lib/i18n';
import { useReadOnly } from '../lib/readOnly';
import { ChevronRight, FolderKanban, Plus, Ticket, Users } from '../lib/icons';

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

  return (
    <div className="content-container mx-auto px-4 py-6 sm:px-8 sm:py-10" data-projects-page>
      <div className="mb-6 flex flex-wrap items-center gap-2 anim-fade-up">
        <h1 className="flex-1 text-headline-m">{t('tickets.projectsTitle')}</h1>
        {canAdd && (
          <button className="btn-primary" onClick={() => setAdding(true)} data-new-ticket>
            <Plus size={18} /> {t('tickets.newTicket')}
          </button>
        )}
      </div>
      {!ticketsAnywhere() ? (
        <p className="text-on-surface-variant">{t('tickets.featureOff')}</p>
      ) : (
        <div className="space-y-8">
          <section className="anim-fade-up" aria-labelledby="my-tickets">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h2 id="my-tickets" className="flex-1 text-title-l">
                {t('tickets.myTickets')}
              </h2>
              <div className="segmented" role="tablist" aria-label={t('tickets.myTickets')}>
                {segments.map((s) => (
                  <button key={s} role="tab" aria-selected={segment === s} onClick={() => setSegment(s)}>
                    {t(s === 'active' ? 'tickets.catActive' : 'tickets.catOpen')} {counts[s]}
                  </button>
                ))}
              </div>
            </div>
            {shown.length === 0 ? (
              <p className="rounded-2xl bg-surface-container-low px-4 py-6 text-center text-on-surface-variant">{t('tickets.myTicketsEmpty')}</p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2" data-my-tickets>
                {shown.map((tk) => (
                  <li key={tk.note.id}>
                    <button className="wz-card w-full space-y-1.5 text-left" onClick={() => navigate(`/n/${tk.note.id}`)}>
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-label-m text-on-surface-variant">{tk.meta.id ?? `${tk.project.config.key}-?`}</span>
                        <PriorityIcon p={tk.meta.priority} />
                        <span className="flex-1" />
                        {tk.milestone && <span className="rounded bg-surface-container-high px-1.5 text-label-s text-on-surface-variant">{tk.milestone.title}</span>}
                        <StatusBadge tk={tk} />
                      </span>
                      <span className="block font-medium text-on-surface">{tk.title}</span>
                      {tk.progress.total > 0 && (
                        <span className="block h-1 overflow-hidden rounded-full bg-surface-container-highest">
                          <span className="block h-full bg-primary" style={{ width: `${Math.round((tk.progress.done / tk.progress.total) * 100)}%` }} />
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="anim-fade-up" aria-labelledby="projects-list">
            <h2 id="projects-list" className="mb-3 text-title-l">
              {t('tickets.projectsList')}
            </h2>
            {list.length === 0 ? (
              <p className="rounded-2xl bg-surface-container-low px-4 py-6 text-center text-on-surface-variant">{t('tickets.noProjects')}</p>
            ) : (
              <ul className="space-y-3">
                {list.map((p) => {
                  const tickets = ticketsOf(p);
                  const openCount = tickets.filter((tk) => tk.category !== 'done').length;
                  const current = currentMilestone(milestonesOf(p));
                  return (
                    <li key={p.id} className="card space-y-2 p-3">
                      <button className="flex w-full items-center gap-3 text-left" onClick={() => open(p.folder, p.group)} data-project-link={p.config.key}>
                        {p.group ? <Users size={20} className="shrink-0 text-primary" /> : <FolderKanban size={20} className="shrink-0 text-primary" />}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{projectName(p)}</span>
                          <span className="block text-label-m text-on-surface-variant">{t('tickets.openOfTotal', { open: openCount, total: tickets.length })}</span>
                        </span>
                        <span className="inline-flex items-center gap-1 rounded-lg bg-secondary-container px-2 py-0.5 font-mono text-label-m text-on-secondary-container">
                          <Ticket size={14} /> {p.config.key}
                        </span>
                        <ChevronRight size={18} className="shrink-0 text-on-surface-variant" />
                      </button>
                      {current && <MilestoneBanner m={current} />}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="mt-3 text-body-s text-on-surface-variant">{t('tickets.howToProject')}</p>
          </section>
        </div>
      )}
      {adding && <NewTicketSheet onClose={() => setAdding(false)} />}
    </div>
  );
}
