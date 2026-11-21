import { useMemo, useState } from 'react';
import { PRIORITIES, cleanProjectKey, rankBetween, roadmapOffset, roadmapWeeks, splitPath, type Priority } from '@kladde/shared';
import { vault, useVault } from '../data/vault';
import {
  assignees,
  byRank,
  createMilestone,
  createProject,
  createTicket,
  milestonesOf,
  projects as allProjects,
  ticketsOf,
  updateTicket,
  allowedStatusesOf,
  canMoveTo,
  type MilestoneInfo,
  type ProjectInfo,
  type TicketInfo,
  type TicketSpace,
} from '../data/tickets';
import { useReadOnly } from '../lib/readOnly';
import { navigate } from '../lib/router';
import { compareText, locale, t, useLang, type I18nKey } from '../lib/i18n';
import { AlertTriangle, Ban, DragIndicator, FileText, Flag, Kanban, Plus, PriorityHigh, PriorityLow, PriorityMedium, Settings, TableRows, Ticket, ViewTimeline } from '../lib/icons';
import { Sheet } from './Dialogs';
import { Dropdown, type DropdownOption } from './Dropdown';
import { Avatar } from './Avatar';
import { Switch } from './Switch';
import { ProjectSettingsDialog } from './ProjectSettings';

type Tab = 'board' | 'backlog' | 'roadmap';
const DRAG = 'application/x-kladde-ticket';

export const priorityLabel = (p: Priority | null) => (p ? t(`tickets.priority.${p}` as I18nKey) : t('tickets.priority.none'));

/** Priority as an icon in its color (high: error, medium: warn, low: outline) */
export function PriorityIcon({ p, size = 16 }: { p: Priority | null; size?: number }) {
  if (!p) return null;
  const Icon = p === 'high' ? PriorityHigh : p === 'low' ? PriorityLow : PriorityMedium;
  return (
    <span className={p === 'high' ? 'text-red' : p === 'medium' ? 'text-amber' : 'text-faint'} title={priorityLabel(p)} aria-label={priorityLabel(p)} role="img">
      <Icon size={size} />
    </span>
  );
}

/** Colors of a status category: open neutral, active in the accent, done green */
export const categoryClass = (c: TicketInfo['category']) => (c === 'done' ? 'bg-green-bg text-green' : c === 'active' ? 'bg-acc-bg text-acc-hi' : 'bg-raised text-soft');

export function StatusBadge({ tk }: { tk: TicketInfo }) {
  return (
    <span className={`pill whitespace-nowrap font-medium ${tk.blockedBy.length && tk.category !== 'done' ? 'bg-red-bg text-red' : categoryClass(tk.category)}`}>
      {tk.blockedBy.length && tk.category !== 'done' ? t('tickets.blocked') : tk.meta.status || t('tickets.noStatus')}
    </span>
  );
}

const ticketLabel = (tk: TicketInfo) => tk.meta.id ?? `${tk.project.config.key}-?`;

function Progress({ done, total, className = '' }: { done: number; total: number; className?: string }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className={`h-1 overflow-hidden rounded-full bg-line ${className}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={t('tickets.progressLabel', { done, total })}>
      <div className="h-full rounded-full bg-acc" style={{ width: `${pct}%` }} />
    </div>
  );
}

function DocsBadge({ tk }: { tk: TicketInfo }) {
  if (tk.docsMissing)
    return (
      <span className="inline-flex items-center gap-0.5 text-label-m text-amber" title={t('tickets.docsMissing')}>
        <AlertTriangle size={14} /> {t('tickets.docsShort')}
      </span>
    );
  if (!tk.docIds.length) return null;
  return (
    <span className="inline-flex items-center gap-0.5 text-label-m text-acc" title={t('tickets.docsCount', { n: tk.docIds.length })}>
      <FileText size={14} /> {tk.docIds.length}
    </span>
  );
}

/** A ticket on the board */
function TicketCard({ tk, canEdit }: { tk: TicketInfo; canEdit: boolean }) {
  const blocked = tk.blockedBy.length > 0 && tk.category !== 'done';
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={canEdit}
      onDragStart={(e) => e.dataTransfer.setData(DRAG, tk.note.id)}
      onClick={() => navigate(`/n/${tk.note.id}`)}
      onKeyDown={(e) => e.key === 'Enter' && navigate(`/n/${tk.note.id}`)}
      className={`wz-card space-y-2 outline-none focus-visible:ring-2 focus-visible:ring-acc ${tk.category === 'done' ? 'opacity-75' : ''} ${blocked ? '!border-dashed !border-error' : ''}`}
      data-ticket={tk.meta.id ?? ''}
      data-ticket-note={tk.note.id}
    >
      <div className="flex items-start gap-1.5 font-medium leading-snug text-text">
        {blocked && <Ban size={16} className="mt-0.5 shrink-0 text-red" />}
        <span className="min-w-0 break-words">{tk.title}</span>
      </div>
      {tk.progress.total > 0 && <Progress done={tk.progress.done} total={tk.progress.total} />}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-label-m text-muted">{ticketLabel(tk)}</span>
        <PriorityIcon p={tk.meta.priority} />
        {tk.meta.labels[0] && <span className="pill bg-raised text-soft">{tk.meta.labels[0]}</span>}
        <span className="flex-1" />
        <DocsBadge tk={tk} />
        {tk.meta.assignee && <Avatar name={tk.meta.assignee} size="xs" />}
      </div>
      {blocked && <div className="text-label-m text-red">{t('tickets.blockedBy', { list: tk.blockedBy.map(ticketLabel).join(', ') })}</div>}
    </div>
  );
}

function BoardTab({ project, tickets, canEdit }: { project: ProjectInfo; tickets: TicketInfo[]; canEdit: boolean }) {
  const [over, setOver] = useState<string | null>(null);
  // The dragged ticket: lanes the workflow does not allow for it take no drop
  const [dragging, setDragging] = useState<TicketInfo | null>(null);
  const [allDone, setAllDone] = useState(false);
  const statuses = [...project.config.workflow];
  for (const tk of tickets) if (tk.meta.status && !statuses.some((s) => s.toLowerCase() === tk.meta.status.toLowerCase())) statuses.push(tk.meta.status);
  const lanes = statuses.map((s) => ({ status: s, rows: tickets.filter((tk) => tk.meta.status.toLowerCase() === s.toLowerCase()).sort(byRank) }));
  const noStatus = tickets.filter((tk) => !tk.meta.status);
  if (noStatus.length) lanes[0].rows.push(...noStatus);
  const doneSet = new Set(project.config.done.map((d) => d.toLowerCase()));
  return (
    <div
      className="wz-kanban scrollbar-thin anim-fade-up"
      data-project-board
      onDragStartCapture={(e) => {
        const id = (e.target as HTMLElement).closest<HTMLElement>('[data-ticket-note]')?.dataset.ticketNote;
        setDragging(tickets.find((x) => x.note.id === id) ?? null);
      }}
      onDragEndCapture={() => setDragging(null)}
    >
      {lanes.map((lane) => {
        const done = doneSet.has(lane.status.toLowerCase());
        const shown = done && !allDone ? lane.rows.slice(0, 5) : lane.rows;
        const closed = !!dragging && !canMoveTo(dragging, lane.status);
        return (
          <section
            key={lane.status}
            aria-label={lane.status}
            className={`wz-lane min-w-[14rem] ${over === lane.status ? 'over' : ''} ${closed ? 'closed' : ''}`}
            title={closed ? t('workflow.laneClosed', { from: dragging!.meta.status, to: lane.status }) : undefined}
            onDragOver={(e) => {
              if (!canEdit || closed || !e.dataTransfer.types.includes(DRAG)) return;
              e.preventDefault();
              setOver(lane.status);
            }}
            onDragLeave={() => setOver((o) => (o === lane.status ? null : o))}
            onDrop={(e) => {
              setOver(null);
              const tk = tickets.find((x) => x.note.id === e.dataTransfer.getData(DRAG));
              setDragging(null);
              if (!tk || !canEdit || !canMoveTo(tk, lane.status)) return;
              e.preventDefault();
              if (tk.meta.status !== lane.status) void updateTicket(tk, { status: lane.status });
            }}
            data-lane={lane.status}
          >
            <div className="wz-lane-head">
              {lane.status}
              <span>{lane.rows.length}</span>
            </div>
            {shown.map((tk) => (
              <TicketCard key={tk.note.id} tk={tk} canEdit={canEdit} />
            ))}
            {shown.length < lane.rows.length && (
              <button className="btn-text !justify-start" onClick={() => setAllDone(true)}>
                {t('tickets.moreDone', { n: lane.rows.length - shown.length })}
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}

function BacklogTab({ tickets, milestones, canEdit }: { tickets: TicketInfo[]; milestones: MilestoneInfo[]; canEdit: boolean }) {
  const [showDone, setShowDone] = useState(false);
  const [overGroup, setOverGroup] = useState<string | null>(null);
  const shown = tickets.filter((tk) => showDone || tk.category !== 'done');
  const groups: { key: string; title: string; milestone: MilestoneInfo | null; rows: TicketInfo[] }[] = [
    ...milestones.filter((m) => m.progress.done < m.progress.total || showDone || !m.progress.total).map((m) => ({ key: m.note.id, title: m.title, milestone: m, rows: shown.filter((tk) => tk.milestone === m).sort(byRank) })),
    { key: '', title: t('tickets.noMilestone'), milestone: null, rows: shown.filter((tk) => !tk.milestone).sort(byRank) },
  ];
  const statusOptionsOf = (tk: TicketInfo): DropdownOption[] => allowedStatusesOf(tk).map((s) => ({ value: s, label: s }));
  const points = (rows: TicketInfo[]) => rows.reduce((s, tk) => s + (tk.meta.estimate ?? 0), 0);

  /** Drops a ticket before `target` (or at the end of the group) and moves it into the group's milestone */
  const drop = (id: string, group: (typeof groups)[number], target: TicketInfo | null) => {
    const tk = tickets.find((x) => x.note.id === id);
    if (!tk || !canEdit || tk === target) return;
    const rows = group.rows.filter((r) => r !== tk);
    const at = target ? rows.indexOf(target) : rows.length;
    const before = at > 0 ? rows[at - 1].meta.rank : null;
    const after = at < rows.length ? rows[at].meta.rank : null;
    const rank = rankBetween(before ?? (at > 0 ? 0 : null), after);
    void updateTicket(tk, { rank: Math.round(rank * 1000) / 1000, milestone: group.milestone ? (group.milestone.meta.id ?? group.milestone.title) : null });
  };

  return (
    <div className="anim-fade-up" data-project-backlog>
      <label className="mb-2 flex items-center justify-end gap-3 text-label-l text-muted">
        {t('tickets.showDone')}
        <Switch id="backlog-show-done" checked={showDone} label={t('tickets.showDone')} onChange={setShowDone} />
      </label>
      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[44rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line text-left text-label-l text-muted">
              <th className="w-8" />
              <th className="px-2 py-2 font-medium">{t('tickets.colTicket')}</th>
              <th className="px-2 py-2 font-medium">{t('tickets.colTitle')}</th>
              <th className="px-2 py-2 font-medium">{t('tickets.colStatus')}</th>
              <th className="px-2 py-2 font-medium">{t('tickets.colPriority')}</th>
              <th className="px-2 py-2 font-medium">{t('tickets.colAssignee')}</th>
              <th className="px-2 py-2 font-medium">{t('tickets.colDocs')}</th>
              <th className="px-2 py-2 text-right font-medium">{t('tickets.colPoints')}</th>
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.key || 'none'}>
              <tr
                className={`bg-panel ${overGroup === g.key ? 'outline outline-2 -outline-offset-2 outline-acc' : ''}`}
                onDragOver={(e) => {
                  if (!canEdit || !e.dataTransfer.types.includes(DRAG)) return;
                  e.preventDefault();
                  setOverGroup(g.key);
                }}
                onDragLeave={() => setOverGroup((o) => (o === g.key ? null : o))}
                onDrop={(e) => {
                  setOverGroup(null);
                  e.preventDefault();
                  drop(e.dataTransfer.getData(DRAG), g, null);
                }}
              >
                <td colSpan={7} className="px-3 py-2 font-medium">
                  <span className="inline-flex items-center gap-1.5">
                    <Flag size={16} className="text-acc" />
                    {g.milestone ? (
                      <button className="hover:underline" onClick={() => navigate(`/n/${g.milestone!.note.id}`)}>
                        {g.title}
                      </button>
                    ) : (
                      g.title
                    )}
                    {g.milestone?.meta.due && <span className="font-normal text-muted">· {t('tickets.dueOn', { date: formatDay(g.milestone.meta.due) })}</span>}
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-medium tabular-nums">{points(g.rows) || ''}</td>
              </tr>
              {g.rows.map((tk) => (
                <tr
                  key={tk.note.id}
                  className="border-b border-line"
                  draggable={canEdit}
                  onDragStart={(e) => e.dataTransfer.setData(DRAG, tk.note.id)}
                  onDragOver={(e) => canEdit && e.dataTransfer.types.includes(DRAG) && e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    drop(e.dataTransfer.getData(DRAG), g, tk);
                  }}
                  data-backlog-row={tk.meta.id ?? ''}
                >
                  <td className="pl-2 text-faint">{canEdit && <DragIndicator size={16} className="cursor-grab" />}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 font-mono text-label-m text-muted">{ticketLabel(tk)}</td>
                  <td className="px-2 py-1.5">
                    <button className="text-left font-medium hover:underline" onClick={() => navigate(`/n/${tk.note.id}`)}>
                      {tk.title}
                    </button>
                    {tk.meta.provisional && <span className="pill ml-2 bg-raised text-soft">{t('tickets.notSynced')}</span>}
                  </td>
                  <td className="px-2 py-1">
                    {canEdit ? (
                      <Dropdown variant="ghost" className="!min-h-0 !py-1" aria-label={t('tickets.statusOf', { ticket: tk.title })} value={tk.meta.status} options={statusOptionsOf(tk)} onChange={(s) => void updateTicket(tk, { status: s })} />
                    ) : (
                      <StatusBadge tk={tk} />
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    <PriorityIcon p={tk.meta.priority} />
                  </td>
                  <td className="px-2 py-1.5">{tk.meta.assignee && <span className="inline-flex items-center gap-1.5"><Avatar name={tk.meta.assignee} size="xs" /> {tk.meta.assignee}</span>}</td>
                  <td className="px-2 py-1.5">
                    <DocsBadge tk={tk} />
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{tk.meta.estimate ?? '–'}</td>
                </tr>
              ))}
              {g.rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-3 text-center text-muted">
                    {t('tickets.groupEmpty')}
                  </td>
                </tr>
              )}
            </tbody>
          ))}
        </table>
      </div>
    </div>
  );
}

export const formatDay = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(locale(), { day: 'numeric', month: 'short' });

function RoadmapTab({ milestones, tickets, onNewMilestone, canEdit }: { milestones: MilestoneInfo[]; tickets: TicketInfo[]; onNewMilestone: () => void; canEdit: boolean }) {
  const today = new Date();
  const { start, weeks } = roadmapWeeks(milestones.map((m) => m.meta), today);
  const nowAt = roadmapOffset(today, start, weeks.length);
  const without = tickets.filter((tk) => !tk.milestone && tk.category !== 'done').length;
  const nowWeek = Math.min(weeks.length - 1, Math.floor(nowAt * weeks.length));
  return (
    <div className="anim-fade-up" data-project-roadmap>
      {milestones.length === 0 ? (
        <div className="py-10 text-center text-muted">
          <p className="mb-3">{t('tickets.roadmapEmpty')}</p>
          {canEdit && (
            <button className="btn-tonal" onClick={onNewMilestone}>
              <Flag size={16} /> {t('tickets.newMilestone')}
            </button>
          )}
        </div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <div className="grid min-w-[44rem]" style={{ gridTemplateColumns: '13rem minmax(0,1fr)' }}>
            <div className="border-b border-line px-3 py-2 text-label-m text-muted">{t('tickets.milestone')}</div>
            <div className="grid border-b border-line text-label-m text-muted" style={{ gridTemplateColumns: `repeat(${weeks.length}, minmax(0,1fr))` }}>
              {weeks.map((w, i) => (
                <span key={i} className={`border-l border-line px-1.5 py-2 tabular-nums ${i === nowWeek ? 'font-medium text-acc' : ''}`}>
                  {t('tickets.week', { n: w.week })}
                </span>
              ))}
            </div>
            {milestones.map((m) => {
              const from = roadmapOffset(m.meta.start ?? m.meta.due ?? today, start, weeks.length);
              const to = m.meta.due ? roadmapOffset(m.meta.due, start, weeks.length) + 1 / (weeks.length * 7) : Math.min(1, from + 1 / weeks.length);
              const finished = m.progress.total > 0 && m.progress.done === m.progress.total;
              const tone = finished ? 'border border-green/40 bg-green-bg text-green' : m.progress.done || m.tickets.some((tk) => tk.category === 'active') ? 'border border-acc-line bg-acc-bg text-acc-hi' : 'border border-line2 bg-raised text-text';
              return (
                <div key={m.note.id} className="contents">
                  <div className="flex min-h-[4.25rem] flex-col justify-center border-b border-line px-3 py-2">
                    <button className="truncate text-left font-medium hover:underline" onClick={() => navigate(`/n/${m.note.id}`)}>
                      {m.title}
                    </button>
                    <span className="text-label-m text-muted">
                      {t('tickets.doneOf', { done: m.progress.done, total: m.progress.total })}
                      {m.progress.atRisk && (
                        <span className="ml-1.5 inline-flex items-center gap-0.5 text-amber">
                          <AlertTriangle size={12} /> {t('tickets.atRisk')}
                        </span>
                      )}
                    </span>
                  </div>
                  <div
                    className="relative min-h-[4.25rem] border-b border-line"
                    style={{ backgroundImage: 'linear-gradient(to right, rgb(var(--outline-variant) / 0.55) 1px, transparent 1px)', backgroundSize: `${100 / weeks.length}% 100%` }}
                  >
                    <div className="absolute inset-y-0 z-[1] w-0.5 bg-acc" style={{ left: `${nowAt * 100}%` }} aria-hidden />
                    <button
                      className={`absolute top-3 flex h-10 flex-col justify-center overflow-hidden rounded-lg px-2.5 text-left text-label-m ${tone}`}
                      style={{ left: `${from * 100}%`, width: `max(2.5rem, ${(to - from) * 100}%)` }}
                      onClick={() => navigate(`/n/${m.note.id}`)}
                      title={`${m.title}${m.meta.start ? ` · ${formatDay(m.meta.start)}` : ''}${m.meta.due ? ` – ${formatDay(m.meta.due)}` : ''}`}
                    >
                      <span className="truncate">
                        {m.meta.release ? `${m.meta.release} · ` : ''}
                        {Math.round(m.progress.ratio * 100)} %
                      </span>
                      <span className="mt-1 block h-1 overflow-hidden rounded-full bg-text/15">
                        <span className={`block h-full ${finished ? 'bg-green' : 'bg-acc'}`} style={{ width: `${Math.round(m.progress.ratio * 100)}%` }} />
                      </span>
                    </button>
                    {m.meta.due && m.meta.release && (
                      <span className="absolute top-[1.6rem] h-3.5 w-3.5 rotate-45 rounded-sm bg-warn" style={{ left: `calc(${roadmapOffset(m.meta.due, start, weeks.length) * 100}% + ${100 / (weeks.length * 7)}% - 7px)` }} title={t('tickets.releaseOn', { release: m.meta.release, date: formatDay(m.meta.due) })} />
                    )}
                  </div>
                </div>
              );
            })}
            <div className="flex flex-col justify-center px-3 py-2">
              <span className="font-medium">{t('tickets.noMilestone')}</span>
              <span className="text-label-m text-muted">{t('tickets.openCount', { n: without })}</span>
            </div>
            <div className="flex items-center px-3 text-label-l text-muted">{t('tickets.roadmapHint')}</div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Today as YYYY-MM-DD */
const isoToday = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** A new ticket; without `project` the sheet asks for one (the "Projects" page) */
export function NewTicketSheet({ project: fixed, onClose, milestone: presetMilestone }: { project?: ProjectInfo; onClose: () => void; milestone?: string }) {
  useVault();
  const writable = allProjects().filter((p) => p.canWrite);
  const [projectId, setProjectId] = useState(fixed?.id ?? writable[0]?.id ?? '');
  const project = fixed ?? writable.find((p) => p.id === projectId);
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState<Priority>('medium');
  const [milestone, setMilestone] = useState(presetMilestone ?? '');
  const [assignee, setAssignee] = useState(vault.actorName);
  const [doc, setDoc] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!project) {
    return (
      <Sheet title={t('tickets.newTicket')} onClose={onClose}>
        <p className="pb-6 text-muted">{t('tickets.noWritableProject')}</p>
      </Sheet>
    );
  }
  const milestones = milestonesOf(project);
  const save = async () => {
    if (busy || !title.trim()) return;
    setBusy(true);
    setError('');
    try {
      const m = milestones.find((x) => x.note.id === milestone);
      const note = await createTicket(project, {
        title,
        status: status || undefined,
        priority,
        milestone: m ? (m.meta.id ?? m.title) : null,
        assignee: assignee || null,
        docs: doc.trim() ? [doc.trim()] : [],
      });
      onClose();
      navigate(`/n/${note.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Sheet title={t('tickets.newTicket')} onClose={onClose}>
      <form
        className="space-y-3 pb-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="flex items-center gap-2 text-label-l text-muted">
          <span className="font-mono">{project.config.key}-?</span>
          {!navigator.onLine && <span className="chip">{t('tickets.offlineNumber')}</span>}
        </div>
        {!fixed && writable.length > 1 && (
          <Dropdown aria-label={t('tickets.project')} value={projectId} options={writable.map((p) => ({ value: p.id, label: projectName(p) }))} onChange={setProjectId} />
        )}
        <input className="input" autoFocus aria-label={t('tickets.colTitle')} placeholder={t('tickets.titlePlaceholder')} value={title} onChange={(e) => setTitle(e.target.value)} data-new-ticket-title />
        <div className="grid grid-cols-2 gap-2">
          <Dropdown aria-label={t('tickets.colStatus')} value={status || project.config.workflow[0]} options={project.config.workflow.map((s) => ({ value: s, label: s }))} onChange={setStatus} />
          <Dropdown aria-label={t('tickets.colPriority')} value={priority} options={PRIORITIES.map((p) => ({ value: p, label: priorityLabel(p) }))} onChange={(v) => setPriority(v as Priority)} />
          <Dropdown aria-label={t('tickets.milestone')} value={milestone} options={[{ value: '', label: t('tickets.noMilestone') }, ...milestones.map((m) => ({ value: m.note.id, label: m.title }))]} onChange={setMilestone} />
          <Dropdown aria-label={t('tickets.colAssignee')} value={assignee} options={[{ value: '', label: t('tickets.unassigned') }, ...assignees(project).map((a) => ({ value: a, label: a }))]} onChange={setAssignee} />
        </div>
        <input className="input" list="ticket-doc-targets" aria-label={t('tickets.docLink')} placeholder={t('tickets.docLinkPlaceholder')} value={doc} onChange={(e) => setDoc(e.target.value)} />
        <DocTargets />
        <p className="text-body-s text-muted">{t('tickets.numberHint')}</p>
        {error && <p className="text-sm text-red">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-text" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn-primary" disabled={busy || !title.trim()}>
            {t('tickets.create')}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

/** Titles of notes for the documentation field */
export function DocTargets() {
  const titles = useMemo(() => [...new Set(vault.list().filter((n) => !n.path.startsWith('.')).map((n) => splitPath(n.path).name))].sort((a, b) => compareText(a, b)), []);
  return (
    <datalist id="ticket-doc-targets">
      {titles.map((n) => (
        <option key={n} value={n} />
      ))}
    </datalist>
  );
}

export const projectName = (p: ProjectInfo) => `${p.spaceName ? `${p.spaceName} / ` : ''}${p.folder.split('/').pop() || p.folder} (${p.config.key})`;

function MilestoneSheet({ project, onClose }: { project: ProjectInfo; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [id, setId] = useState('');
  const [start, setStart] = useState(isoToday());
  const [due, setDue] = useState('');
  const [release, setRelease] = useState('');
  const [goal, setGoal] = useState('');
  const [error, setError] = useState('');
  const save = async () => {
    if (!title.trim()) return;
    try {
      const note = await createMilestone(project, { title, id, start: start || null, due: due || null, release, goal });
      onClose();
      navigate(`/n/${note.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Sheet title={t('tickets.newMilestone')} onClose={onClose}>
      <form
        className="space-y-3 pb-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input className="input" autoFocus aria-label={t('tickets.milestoneTitle')} placeholder={t('tickets.milestoneTitlePlaceholder')} value={title} onChange={(e) => setTitle(e.target.value)} />
        <div className="grid grid-cols-2 gap-2">
          <label className="text-label-l text-muted">
            {t('tickets.start')}
            <input type="date" className="input mt-1" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="text-label-l text-muted">
            {t('tickets.due')}
            <input type="date" className="input mt-1" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
          <input className="input" aria-label={t('tickets.milestoneId')} placeholder={t('tickets.milestoneIdPlaceholder')} value={id} onChange={(e) => setId(e.target.value)} />
          <input className="input" aria-label={t('tickets.release')} placeholder={t('tickets.releasePlaceholder')} value={release} onChange={(e) => setRelease(e.target.value)} />
        </div>
        <input className="input" aria-label={t('tickets.goal')} placeholder={t('tickets.goalPlaceholder')} value={goal} onChange={(e) => setGoal(e.target.value)} />
        {error && <p className="text-sm text-red">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-text" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn-primary" disabled={!title.trim()}>
            {t('tickets.create')}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

/** "Make project": turns the folder into a project with a key (suggested from the folder's name) */
export function MakeProjectSheet({ space, folder, onClose }: { space: TicketSpace; folder: string; onClose: () => void }) {
  const [key, setKey] = useState(() => cleanProjectKey(folder.split('/').pop()?.replace(/^\d+\s*/, '') ?? '') ?? '');
  const [requireDocs, setRequireDocs] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    const clean = cleanProjectKey(key);
    if (!clean) return setError(t('tickets.keyInvalid'));
    try {
      await createProject(space, folder, clean, requireDocs);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Sheet title={t('tickets.makeProject')} onClose={onClose}>
      <form
        className="space-y-3 pb-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="text-body-m text-muted">{t('tickets.makeProjectIntro')}</p>
        <label className="block text-label-l text-muted">
          {t('tickets.key')}
          <input className="input mt-1 font-mono uppercase" autoFocus value={key} maxLength={10} onChange={(e) => setKey(e.target.value)} data-project-key />
          <span className="mt-1 block text-body-s">{t('tickets.keyHint')}</span>
        </label>
        <label className="flex items-center justify-between gap-3 text-body-l">
          {t('tickets.requireDocs')}
          <Switch id="new-project-require-docs" checked={requireDocs} label={t('tickets.requireDocs')} onChange={setRequireDocs} />
        </label>
        {error && <p className="text-sm text-red">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-text" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn-primary" disabled={!key.trim()}>
            {t('tickets.makeProjectBtn')}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

/** The milestone that matters now: the first unfinished one by due date */
export function currentMilestone(milestones: MilestoneInfo[]): MilestoneInfo | null {
  return milestones.find((m) => !m.progress.total || m.progress.done < m.progress.total) ?? null;
}

export function MilestoneBanner({ m }: { m: MilestoneInfo }) {
  const days = m.progress.daysLeft;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-line bg-panel px-3.5 py-2" data-milestone-banner>
      <Flag size={18} className="text-acc" />
      <button className="font-medium hover:underline" onClick={() => navigate(`/n/${m.note.id}`)}>
        {m.title}
      </button>
      <span className="text-body-m text-muted">
        {m.meta.start && m.meta.due ? `${formatDay(m.meta.start)} – ${formatDay(m.meta.due)}` : m.meta.due ? t('tickets.dueOn', { date: formatDay(m.meta.due) }) : ''}
        {days !== null && ` · ${days >= 0 ? t('tickets.daysLeft', { n: days }) : t('tickets.overdueDays', { n: -days })}`}
      </span>
      <Progress done={m.progress.done} total={m.progress.total} className="w-32 sm:w-44" />
      <span className="tabular-nums text-body-m">{t('tickets.doneOf', { done: m.progress.done, total: m.progress.total })}</span>
      {m.progress.atRisk && (
        <span className="inline-flex items-center gap-1 text-label-l text-amber">
          <AlertTriangle size={14} /> {t('tickets.atRisk')}
        </span>
      )}
    </div>
  );
}

/** A folder that is a project: board, backlog and roadmap over its tickets */
export function ProjectView({ project }: { project: ProjectInfo }) {
  useVault();
  useLang();
  const readOnly = useReadOnly();
  const canEdit = project.canWrite && !readOnly;
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return (localStorage.getItem(`kladde_project_tab_${project.id}`) as Tab) || 'board';
    } catch {
      return 'board';
    }
  });
  const [milestoneFilter, setMilestoneFilter] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [labelFilter, setLabelFilter] = useState('');
  const [sheet, setSheet] = useState<'ticket' | 'milestone' | 'settings' | null>(null);
  const all = ticketsOf(project);
  const milestones = milestonesOf(project);
  const current = currentMilestone(milestones);
  const labels = [...new Set(all.flatMap((tk) => tk.meta.labels))].sort((a, b) => compareText(a, b));
  const people = [...new Set(all.map((tk) => tk.meta.assignee).filter((a): a is string => !!a))].sort((a, b) => compareText(a, b));
  const tickets = all.filter(
    (tk) =>
      (!milestoneFilter || (milestoneFilter === '-' ? !tk.milestone : tk.milestone?.note.id === milestoneFilter)) &&
      (!assigneeFilter || (assigneeFilter === '-' ? !tk.meta.assignee : tk.meta.assignee?.toLowerCase() === assigneeFilter.toLowerCase())) &&
      (!labelFilter || tk.meta.labels.includes(labelFilter))
  );
  const choose = (next: Tab) => {
    setTab(next);
    try {
      localStorage.setItem(`kladde_project_tab_${project.id}`, next);
    } catch {
      // per-device convenience only
    }
  };
  const tabs: { id: Tab; label: string; Icon: typeof Kanban }[] = [
    { id: 'board', label: t('tickets.board'), Icon: Kanban },
    { id: 'backlog', label: t('tickets.backlog'), Icon: TableRows },
    { id: 'roadmap', label: t('tickets.roadmap'), Icon: ViewTimeline },
  ];
  return (
    <section className="mb-6 space-y-3" aria-label={t('tickets.projectLabel', { key: project.config.key })} data-project={project.config.key}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line2 bg-raised px-2 font-mono text-label-m text-strong">
          <Ticket size={16} /> {project.config.key}
        </span>
        <div className="segmented" role="tablist" aria-label={t('tickets.views')}>
          {tabs.map(({ id, label, Icon }) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => choose(id)} data-project-tab={id}>
              <Icon size={16} /> <span className="phone:hidden">{label}</span>
            </button>
          ))}
        </div>
        <span className="flex-1" />
        {canEdit && (
          <>
            <button className="btn-icon" onClick={() => setSheet('settings')} title={t('tickets.projectSettings')} aria-label={t('tickets.projectSettings')}>
              <Settings size={18} />
            </button>
            <button className="btn-text" onClick={() => setSheet('milestone')}>
              <Flag size={16} /> <span className="phone:hidden">{t('tickets.milestone')}</span>
            </button>
            <button className="btn-primary" onClick={() => setSheet('ticket')} data-new-ticket>
              <Plus size={16} /> {t('tickets.ticket')}
            </button>
          </>
        )}
      </div>
      {current && tab !== 'roadmap' && <MilestoneBanner m={current} />}
      {tab !== 'roadmap' && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Dropdown
            variant="chip"
            aria-label={t('tickets.milestone')}
            leadingIcon={<Flag size={14} />}
            value={milestoneFilter}
            options={[{ value: '', label: t('tickets.allMilestones') }, ...milestones.map((m) => ({ value: m.note.id, label: m.title })), { value: '-', label: t('tickets.noMilestone') }]}
            onChange={setMilestoneFilter}
          />
          <Dropdown
            variant="chip"
            aria-label={t('tickets.colAssignee')}
            value={assigneeFilter}
            options={[{ value: '', label: t('tickets.everyone') }, ...(vault.actorName ? [{ value: vault.actorName, label: t('tickets.me') }] : []), ...people.filter((p) => p !== vault.actorName).map((p) => ({ value: p, label: p })), { value: '-', label: t('tickets.unassigned') }]}
            onChange={setAssigneeFilter}
          />
          {labels.length > 0 && <Dropdown variant="chip" aria-label={t('tickets.labels')} value={labelFilter} options={[{ value: '', label: t('tickets.allLabels') }, ...labels.map((l) => ({ value: l, label: l }))]} onChange={setLabelFilter} />}
        </div>
      )}
      {all.length === 0 && tab !== 'roadmap' ? (
        <div className="empty-sheet"><p className="empty-title">{t('tickets.empty')}</p></div>
      ) : tab === 'board' ? (
        <BoardTab project={project} tickets={tickets} canEdit={canEdit} />
      ) : tab === 'backlog' ? (
        <BacklogTab tickets={tickets} milestones={milestones} canEdit={canEdit} />
      ) : (
        <RoadmapTab milestones={milestones} tickets={all} onNewMilestone={() => setSheet('milestone')} canEdit={canEdit} />
      )}
      {sheet === 'ticket' && <NewTicketSheet project={project} onClose={() => setSheet(null)} milestone={milestoneFilter && milestoneFilter !== '-' ? milestoneFilter : current?.note.id} />}
      {sheet === 'milestone' && <MilestoneSheet project={project} onClose={() => setSheet(null)} />}
      {sheet === 'settings' && <ProjectSettingsDialog project={project} onClose={() => setSheet(null)} />}
    </section>
  );
}
