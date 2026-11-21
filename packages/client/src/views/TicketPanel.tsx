import { useState } from 'react';
import { PRIORITIES, type Priority } from '@kladde/shared';
import { vault, useVault } from '../data/vault';
import { assignees, byRank, createReleaseNotes, milestoneOfNote, milestonesOf, ticketOfNote, ticketsOf, updateTicket, type MilestoneInfo, type TicketInfo } from '../data/tickets';
import { navigate } from '../lib/router';
import { t, useLang } from '../lib/i18n';
import { AddLink, AlertTriangle, Ban, CheckCircle2, Clock, FileText, Flag, NewReleases, Person, Plus, Tags, Ticket, X } from '../lib/icons';
import { Dropdown } from './Dropdown';
import { DocTargets, MilestoneBanner, NewTicketSheet, PriorityIcon, StatusBadge, formatDay, priorityLabel } from './ProjectView';

const label = 'flex items-center gap-1.5 text-label-l text-muted';

/** One linked note in the side lists: opens it; writers can remove the link */
function LinkRow({ title, sub, Icon, onOpen, onRemove, tone = '' }: { title: string; sub?: string; Icon: typeof FileText; onOpen?: () => void; onRemove?: () => void; tone?: string }) {
  return (
    <li className="flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5">
      <Icon size={16} className={`shrink-0 ${tone || 'text-muted'}`} />
      <button className="min-w-0 flex-1 text-left disabled:cursor-default" disabled={!onOpen} onClick={onOpen}>
        <span className="block truncate font-medium">{title}</span>
        {sub && <span className="block truncate text-label-m text-muted">{sub}</span>}
      </button>
      {onRemove && (
        <button className="btn-icon !h-8 !w-8 shrink-0" onClick={onRemove} aria-label={t('tickets.removeLink', { title })} title={t('tickets.removeLink', { title })}>
          <X size={16} />
        </button>
      )}
    </li>
  );
}

/** Header of a ticket: its fields as controls, documentation, relations and sub-task progress */
function TicketHeader({ tk, readOnly }: { tk: TicketInfo; readOnly: boolean }) {
  const canEdit = tk.project.canWrite && !readOnly && tk.note.access !== 'read';
  const [doc, setDoc] = useState('');
  const [label_, setLabel] = useState('');
  const milestones = milestonesOf(tk.project);
  const others = ticketsOf(tk.project).filter((x) => x !== tk && !tk.blocking.includes(x)).sort(byRank);
  const links = vault.links();
  const docNotes = tk.docIds.map((id) => vault.get(id)).filter((n): n is NonNullable<typeof n> => !!n);
  const unresolved = tk.meta.docs.filter((d) => !links.resolve(d));
  const pinned = new Set(tk.meta.docs.map((d) => links.resolve(d)).filter(Boolean));
  const set = (fields: Parameters<typeof updateTicket>[1]) => void updateTicket(tk, fields);
  const addDoc = () => {
    const v = doc.trim();
    if (!v || tk.meta.docs.some((d) => d.toLowerCase() === v.toLowerCase())) return setDoc('');
    set({ docs: [...tk.meta.docs, v] });
    setDoc('');
  };
  const addLabel = () => {
    const v = label_.trim();
    if (v && !tk.meta.labels.includes(v)) set({ labels: [...tk.meta.labels, v] });
    setLabel('');
  };
  const field = (title: string, Icon: typeof Flag, control: React.ReactNode) => (
    <>
      <dt className={label}>
        <Icon size={16} /> {title}
      </dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1.5">{control}</dd>
    </>
  );
  return (
    <section className="no-print mb-3 space-y-3 rounded-lg border border-line bg-panel p-3 anim-fade-in" aria-label={t('tickets.ticketLabel', { ticket: tk.meta.id ?? '' })} data-ticket-panel>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line2 bg-raised px-2 font-mono text-label-m text-strong" data-ticket-id>
          <Ticket size={16} /> {tk.meta.id ?? `${tk.project.config.key}-?`}
        </span>
        {tk.meta.provisional && <span className="chip">{t('tickets.notSynced')}</span>}
        <StatusBadge tk={tk} />
        <button className="text-label-l text-acc hover:underline" onClick={() => navigate(tk.project.group ? `/g/${encodeURIComponent(tk.project.group)}/${encodeURIComponent(tk.project.folder)}` : `/f/${encodeURIComponent(tk.project.folder)}`)}>
          {t('tickets.toProject', { key: tk.project.config.key })}
        </button>
        {tk.progress.total > 0 && (
          <span className="ml-auto text-label-l text-muted">{t('tickets.subtasks', { done: tk.progress.done, total: tk.progress.total })}</span>
        )}
      </div>
      <dl className="grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] items-center gap-x-3 gap-y-2 rounded-md border border-line bg-bg px-3 py-2.5 text-body-m">
        {field(
          t('tickets.colStatus'),
          CheckCircle2,
          canEdit ? (
            <Dropdown variant="chip" aria-label={t('tickets.colStatus')} value={tk.meta.status} options={tk.project.config.workflow.map((s) => ({ value: s, label: s }))} onChange={(s) => set({ status: s })} />
          ) : (
            <StatusBadge tk={tk} />
          )
        )}
        {field(
          t('tickets.milestone'),
          Flag,
          canEdit ? (
            <Dropdown
              variant="chip"
              aria-label={t('tickets.milestone')}
              value={tk.milestone?.note.id ?? ''}
              options={[{ value: '', label: t('tickets.noMilestone') }, ...milestones.map((m) => ({ value: m.note.id, label: m.title }))]}
              onChange={(id) => {
                const m = milestones.find((x) => x.note.id === id);
                set({ milestone: m ? (m.meta.id ?? m.title) : null });
              }}
            />
          ) : tk.milestone ? (
            <button className="hover:underline" onClick={() => navigate(`/n/${tk.milestone!.note.id}`)}>
              {tk.milestone.title}
            </button>
          ) : (
            <span className="text-muted">{tk.meta.milestone ?? t('tickets.noMilestone')}</span>
          )
        )}
        {field(
          t('tickets.colAssignee'),
          Person,
          canEdit ? (
            <Dropdown variant="chip" aria-label={t('tickets.colAssignee')} value={tk.meta.assignee ?? ''} options={[{ value: '', label: t('tickets.unassigned') }, ...assignees(tk.project, tk.note.id).map((a) => ({ value: a, label: a }))]} onChange={(a) => set({ assignee: a || null })} />
          ) : (
            <span>{tk.meta.assignee ?? t('tickets.unassigned')}</span>
          )
        )}
        {field(
          t('tickets.colPriority'),
          AlertTriangle,
          canEdit ? (
            <Dropdown variant="chip" aria-label={t('tickets.colPriority')} leadingIcon={<PriorityIcon p={tk.meta.priority} />} value={tk.meta.priority ?? ''} options={[{ value: '', label: t('tickets.priority.none') }, ...PRIORITIES.map((p) => ({ value: p, label: priorityLabel(p) }))]} onChange={(p) => set({ priority: (p as Priority) || null })} />
          ) : (
            <span className="inline-flex items-center gap-1">
              <PriorityIcon p={tk.meta.priority} /> {priorityLabel(tk.meta.priority)}
            </span>
          )
        )}
        {field(
          t('tickets.estimate'),
          Clock,
          canEdit ? (
            <input
              key={tk.meta.estimate ?? ''}
              type="number"
              min={0}
              step="any"
              className="input !min-h-0 !w-24 !py-1"
              aria-label={t('tickets.estimate')}
              defaultValue={tk.meta.estimate ?? ''}
              onBlur={(e) => {
                const v = e.target.value === '' ? null : Number(e.target.value);
                if (v !== tk.meta.estimate && (v === null || Number.isFinite(v))) set({ estimate: v });
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <span>{tk.meta.estimate ?? '–'}</span>
          )
        )}
        {field(
          t('tickets.labels'),
          Tags,
          <>
            {tk.meta.labels.map((l) => (
              <span key={l} className="inline-flex items-center gap-0.5 pill bg-raised text-soft">
                {l}
                {canEdit && (
                  <button aria-label={t('tickets.removeLabel', { label: l })} onClick={() => set({ labels: tk.meta.labels.filter((x) => x !== l) })}>
                    <X size={12} />
                  </button>
                )}
              </span>
            ))}
            {canEdit && (
              <input
                className="input !min-h-0 !w-28 !py-0.5 text-label-m"
                aria-label={t('tickets.addLabel')}
                placeholder={t('tickets.addLabel')}
                value={label_}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addLabel()}
                onBlur={addLabel}
              />
            )}
          </>
        )}
      </dl>
      {tk.progress.total > 0 && (
        <div className="h-1 overflow-hidden rounded-full bg-line" aria-hidden>
          <div className="h-full bg-acc" style={{ width: `${Math.round((tk.progress.done / tk.progress.total) * 100)}%` }} />
        </div>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <h3 className="mb-1.5 flex items-center gap-1.5 text-label-m font-semibold text-muted">
            <FileText size={14} /> {t('tickets.docs', { n: docNotes.length })}
          </h3>
          {tk.docsMissing && (
            <p className="mb-2 flex items-start gap-1.5 rounded-md bg-amber-bg px-2.5 py-2 text-body-s text-amber-hi">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {t('tickets.docsMissing')}
            </p>
          )}
          <ul className="space-y-1">
            {docNotes.map((n) => (
              <LinkRow
                key={n.id}
                title={vault.links().notes.get(n.id)?.title ?? n.path}
                sub={pinned.has(n.id) ? t('tickets.docPinned') : t('tickets.docLinked')}
                Icon={FileText}
                onOpen={() => navigate(`/n/${n.id}`)}
                onRemove={canEdit && pinned.has(n.id) ? () => set({ docs: tk.meta.docs.filter((d) => links.resolve(d) !== n.id) }) : undefined}
              />
            ))}
            {unresolved.map((d) => (
              <LinkRow key={d} title={d} sub={t('tickets.docMissingNote')} Icon={FileText} tone="text-amber" onRemove={canEdit ? () => set({ docs: tk.meta.docs.filter((x) => x !== d) }) : undefined} />
            ))}
          </ul>
          {canEdit && (
            <div className="mt-1.5 flex gap-1.5">
              <input
                className="input !min-h-0 min-w-0 flex-1 !py-1.5"
                list="ticket-doc-targets"
                aria-label={t('tickets.docLink')}
                placeholder={t('tickets.docLinkPlaceholder')}
                value={doc}
                onChange={(e) => setDoc(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addDoc()}
              />
              <button className="btn-tonal shrink-0" onClick={addDoc} disabled={!doc.trim()} aria-label={t('tickets.docAdd')} title={t('tickets.docAdd')}>
                <AddLink size={16} />
              </button>
              <DocTargets />
            </div>
          )}
        </div>
        <div>
          <h3 className="mb-1.5 flex items-center gap-1.5 text-label-m font-semibold text-muted">
            <Ban size={14} /> {t('tickets.relations')}
          </h3>
          <ul className="space-y-1">
            {tk.blockedBy.map((b) => (
              <LinkRow key={b.note.id} title={t('tickets.blockedByOne', { ticket: b.meta.id ?? b.title })} sub={b.title} Icon={Ban} tone="text-red" onOpen={() => navigate(`/n/${b.note.id}`)} />
            ))}
            {tk.blocking.map((b) => (
              <LinkRow
                key={b.note.id}
                title={t('tickets.blocksOne', { ticket: b.meta.id ?? b.title })}
                sub={b.title}
                Icon={Ban}
                onOpen={() => navigate(`/n/${b.note.id}`)}
                onRemove={canEdit ? () => set({ blocks: tk.meta.blocks.filter((x) => x.toUpperCase() !== (b.meta.id ?? '').toUpperCase() && x.toLowerCase() !== b.title.toLowerCase()) }) : undefined}
              />
            ))}
            {!tk.blockedBy.length && !tk.blocking.length && <li className="px-1 text-body-s text-muted">{t('tickets.noRelations')}</li>}
          </ul>
          {canEdit && others.length > 0 && (
            <div className="mt-1.5">
              <Dropdown
                variant="chip"
                aria-label={t('tickets.addBlocks')}
                placeholder={t('tickets.addBlocks')}
                leadingIcon={<Plus size={14} />}
                value=""
                options={others.filter((o) => o.meta.id && !o.meta.provisional).map((o) => ({ value: o.meta.id!, label: `${o.meta.id} · ${o.title}` }))}
                onChange={(id) => set({ blocks: [...tk.meta.blocks, id] })}
              />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** Header of a milestone: time frame, progress, its tickets, release notes */
function MilestoneHeader({ m, readOnly }: { m: MilestoneInfo; readOnly: boolean }) {
  const canEdit = m.project.canWrite && !readOnly && m.note.access !== 'read';
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const groups: { title: string; rows: TicketInfo[] }[] = [
    { title: t('tickets.catActive'), rows: m.tickets.filter((tk) => tk.category === 'active') },
    { title: t('tickets.catOpen'), rows: m.tickets.filter((tk) => tk.category === 'open') },
    { title: t('tickets.catDone'), rows: m.tickets.filter((tk) => tk.category === 'done') },
  ].map((g) => ({ ...g, rows: g.rows.sort(byRank) }));
  const date = (key: 'start' | 'due', value: string | null) => (
    <label className="text-label-l text-muted">
      {t(key === 'start' ? 'tickets.start' : 'tickets.due')}
      {canEdit ? (
        <input type="date" className="input mt-1 !min-h-0 !py-1" value={value ?? ''} onChange={(e) => void vault.setFrontmatter(m.note.id, { [key]: e.target.value || null })} />
      ) : (
        <span className="block text-body-m text-text">{value ? formatDay(value) : '–'}</span>
      )}
    </label>
  );
  return (
    <section className="no-print mb-3 space-y-3 rounded-lg border border-line bg-panel p-3 anim-fade-in" aria-label={t('tickets.milestoneLabel', { title: m.title })} data-milestone-panel>
      <MilestoneBanner m={m} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {date('start', m.meta.start)}
        {date('due', m.meta.due)}
        <div className="text-label-l text-muted">
          {t('tickets.release')}
          <span className="block text-body-m text-text">{m.meta.release ?? '–'}</span>
        </div>
        <div className="text-label-l text-muted">
          {t('tickets.points')}
          <span className="block text-body-m tabular-nums text-text">{m.progress.points ? `${m.progress.donePoints} / ${m.progress.points}` : '–'}</span>
        </div>
      </div>
      {m.meta.goal && <p className="text-body-m">{m.meta.goal}</p>}
      <div className="grid gap-3 md:grid-cols-3">
        {groups.map((g) => (
          <div key={g.title}>
            <h3 className="mb-1.5 text-label-m font-semibold text-muted">
              {g.title} · {g.rows.length}
            </h3>
            <ul className="space-y-1">
              {g.rows.map((tk) => (
                <LinkRow key={tk.note.id} title={tk.title} sub={`${tk.meta.id ?? `${tk.project.config.key}-?`} · ${tk.meta.status}${tk.meta.assignee ? ` · ${tk.meta.assignee}` : ''}`} Icon={Ticket} onOpen={() => navigate(`/n/${tk.note.id}`)} />
              ))}
            </ul>
          </div>
        ))}
      </div>
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <button className="btn-tonal" onClick={() => setAdding(true)}>
            <Plus size={16} /> {t('tickets.newTicket')}
          </button>
          <button
            className="btn-text"
            disabled={busy || !m.progress.done}
            title={m.progress.done ? undefined : t('tickets.releaseNotesNone')}
            onClick={async () => {
              setBusy(true);
              try {
                const note = await createReleaseNotes(m);
                navigate(`/n/${note.id}`);
              } catch (err) {
                alert((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
            data-release-notes
          >
            <NewReleases size={16} /> {t('tickets.makeReleaseNotes')}
          </button>
        </div>
      )}
      {adding && <NewTicketSheet project={m.project} milestone={m.note.id} onClose={() => setAdding(false)} />}
    </section>
  );
}

/** Ticket or milestone header above the text, when tickets are on where the note lives */
export function TicketPanel({ noteId, readOnly }: { noteId: string; readOnly: boolean }) {
  useVault();
  useLang();
  const tk = ticketOfNote(noteId);
  if (tk) return <TicketHeader tk={tk} readOnly={readOnly} />;
  const m = milestoneOfNote(noteId);
  if (m) return <MilestoneHeader m={m} readOnly={readOnly} />;
  return null;
}

/** "Tickets" among the links of a note: the tickets that document their work here */
export function TicketBacklinks({ tickets, item }: { tickets: TicketInfo[]; item?: string }) {
  if (!tickets.length) return null;
  const sorted = [...tickets].sort((a, b) => (a.category === 'done' ? 1 : 0) - (b.category === 'done' ? 1 : 0) || byRank(a, b));
  const open = tickets.filter((tk) => tk.category !== 'done').length;
  return (
    <section data-ticket-backlinks>
      <h3 className="section-label mb-2 flex items-center gap-1.5 px-1">
        <Ticket size={16} /> {t('tickets.backlinksTitle', { n: tickets.length, open })}
      </h3>
      <ul className="space-y-1">
        {sorted.map((tk) => (
          <li key={tk.note.id}>
            <button className={item ?? 'state-layer flex w-full items-center gap-2 rounded-md border border-line px-3 py-2 text-left'} onClick={() => navigate(`/n/${tk.note.id}`)}>
              <span className="flex w-full items-center gap-2">
                <span className={`font-mono text-label-m ${tk.category === 'done' ? 'text-muted line-through' : 'text-muted'}`}>{tk.meta.id ?? `${tk.project.config.key}-?`}</span>
                <span className="min-w-0 flex-1 truncate text-body-l text-text">{tk.title}</span>
                <StatusBadge tk={tk} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
