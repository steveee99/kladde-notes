import { useState } from 'react';
import { MILESTONE_STATUSES, PARENT_KINDS, PRIORITIES, childKindsOf, type MilestoneStatus, type Priority, type TicketKind } from '@kladde/shared';
import { vault, useVault } from '../data/vault';
import { addBlock, allowedStatusesOf, ancestorsOf, assignees, byRank, parentCandidates, createReleaseNotes, milestoneOfNote, milestonesOf, removeBlock, setMilestoneStatus, ticketOfNote, ticketsOf, updateTicket, type MilestoneInfo, type TicketInfo } from '../data/tickets';
import { navigate } from '../lib/router';
import { t, useLang } from '../lib/i18n';
import { AccountTree, AlertTriangle, Ban, CheckCircle2, ChevronRight, Clock, FileText, Flag, NewReleases, Person, Plus, Tags, Ticket, X } from '../lib/icons';
import { NoteSearchField } from './NoteSearchField';
import { Dropdown } from './Dropdown';
import { KindIcon, MilestoneBanner, MilestoneStatusBadge, NewTicketSheet, PriorityIcon, StatusBadge, formatDay, kindLabel, kindOptions, milestoneStatusLabel, priorityLabel } from './ProjectView';

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

type Relatable = TicketInfo | MilestoneInfo;
const isTicket = (x: Relatable): x is TicketInfo => 'category' in x;
const finished = (x: Relatable) => (isTicket(x) ? x.category === 'done' : x.state === 'done' || x.state === 'cancelled');
const refLabel = (x: Relatable) => (isTicket(x) ? (x.meta.id ?? `${x.project.config.key}-?`) : x.title);

/**
 * "Blocked by" and "Blocks" of a ticket or milestone, each with a picker. A new relation is written on this note
 * (`blockedBy` or `blocks`); removing it clears it on both notes.
 */
function Relations<T extends Relatable>({ self, blockers, blocking, candidates, canEdit, title }: { self: T; blockers: T[]; blocking: T[]; candidates: T[]; canEdit: boolean; title: string }) {
  const free = candidates.filter((c) => c !== self && !blockers.includes(c) && !blocking.includes(c));
  const option = (c: T) => ({ value: c.note.id, label: isTicket(c) ? `${refLabel(c)} · ${c.title}` : c.title });
  const pick = (side: 'blocks' | 'blockedBy') => (id: string) => {
    const other = free.find((c) => c.note.id === id);
    if (other) void (side === 'blocks' ? addBlock(self, other, 'blocks') : addBlock(other, self, 'blockedBy'));
  };
  const row = (x: T, kind: 'by' | 'blocks') => (
    <LinkRow
      key={`${kind}-${x.note.id}`}
      title={t(kind === 'by' ? 'tickets.blockedByOne' : 'tickets.blocksOne', { ticket: refLabel(x) })}
      sub={[isTicket(x) ? x.title : '', finished(x) ? t('tickets.relationDone') : ''].filter(Boolean).join(' · ') || undefined}
      Icon={Ban}
      tone={kind === 'by' && !finished(x) ? 'text-red' : finished(x) ? 'text-faint' : ''}
      onOpen={() => navigate(`/n/${x.note.id}`)}
      onRemove={canEdit ? () => void (kind === 'by' ? removeBlock(x, self) : removeBlock(self, x)) : undefined}
    />
  );
  return (
    <div data-relations>
      <h3 className="mb-1.5 flex items-center gap-1.5 text-label-m font-semibold text-muted">
        <Ban size={14} /> {title}
      </h3>
      <ul className="space-y-1">
        {blockers.map((b) => row(b, 'by'))}
        {blocking.map((b) => row(b, 'blocks'))}
        {!blockers.length && !blocking.length && <li className="px-1 text-body-s text-muted">{t('tickets.noRelations')}</li>}
      </ul>
      {canEdit && free.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <Dropdown variant="chip" aria-label={t('tickets.addBlockedBy')} placeholder={t('tickets.addBlockedBy')} leadingIcon={<Plus size={14} />} value="" options={free.map(option)} onChange={pick('blockedBy')} />
          <Dropdown variant="chip" aria-label={t('tickets.addBlocks')} placeholder={t('tickets.addBlocks')} leadingIcon={<Plus size={14} />} value="" options={free.map(option)} onChange={pick('blocks')} />
        </div>
      )}
    </div>
  );
}

/** Header of a ticket: its fields as controls, documentation, relations and sub-task progress */
function TicketHeader({ tk, readOnly }: { tk: TicketInfo; readOnly: boolean }) {
  const canEdit = tk.project.canWrite && !readOnly && tk.note.access !== 'read';
  const [label_, setLabel] = useState('');
  const [child, setChild] = useState<TicketKind | null>(null);
  const milestones = milestonesOf(tk.project);
  const others = ticketsOf(tk.project).sort(byRank);
  const links = vault.links();
  const docNotes = tk.docIds.map((id) => vault.get(id)).filter((n): n is NonNullable<typeof n> => !!n);
  const unresolved = tk.meta.docs.filter((d) => !links.resolve(d));
  const pinned = new Set(tk.meta.docs.map((d) => links.resolve(d)).filter(Boolean));
  const set = (fields: Parameters<typeof updateTicket>[1]) => void updateTicket(tk, fields);
  const addDoc = (v: string) => {
    if (!v || tk.meta.docs.some((d) => d.toLowerCase() === v.toLowerCase())) return;
    set({ docs: [...tk.meta.docs, v] });
  };
  const parents = parentCandidates(tk.project, tk.meta.kind, tk);
  const ancestors = ancestorsOf(tk);
  const childKinds = childKindsOf(tk.meta.kind);
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
    <section className="ticket-panel no-print mb-3 space-y-3 rounded-lg border border-line bg-panel p-3 anim-fade-in" aria-label={t('tickets.ticketLabel', { ticket: tk.meta.id ?? '' })} data-ticket-panel>
      {ancestors.length > 0 && (
        <nav className="flex min-w-0 flex-wrap items-center gap-1 text-label-l text-muted" aria-label={t('tickets.parent')} data-ticket-ancestors>
          {ancestors.map((a) => (
            <span key={a.note.id} className="inline-flex min-w-0 items-center gap-1">
              <button className="inline-flex min-w-0 items-center gap-1 hover:text-text hover:underline" onClick={() => navigate(`/n/${a.note.id}`)}>
                <KindIcon kind={a.meta.kind} size={14} />
                <span className="font-mono">{a.meta.id ?? `${a.project.config.key}-?`}</span>
                <span className="max-w-[14rem] truncate">{a.title}</span>
              </button>
              <ChevronRight size={14} className="shrink-0 text-faint" />
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line2 bg-raised px-2 font-mono text-label-m text-strong" data-ticket-id>
          <KindIcon kind={tk.meta.kind} /> {tk.meta.id ?? `${tk.project.config.key}-?`}
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
          t('tickets.kind'),
          Ticket,
          canEdit ? (
            <Dropdown
              variant="field"
              className="tp-control"
              aria-label={t('tickets.kind')}
              leadingIcon={<KindIcon kind={tk.meta.kind} />}
              value={tk.meta.kind}
              options={kindOptions()}
              onChange={(k) => {
                const kind = k as TicketKind;
                // A parent that no longer fits the new type is dropped
                set({ kind, ...(tk.parent && !PARENT_KINDS[kind].includes(tk.parent.meta.kind) ? { parent: null } : {}) });
              }}
            />
          ) : (
            <span className="inline-flex items-center gap-1">
              <KindIcon kind={tk.meta.kind} /> {kindLabel(tk.meta.kind)}
            </span>
          )
        )}
        {PARENT_KINDS[tk.meta.kind].length > 0 &&
          field(
            t('tickets.parent'),
            AccountTree,
            <>
              {canEdit ? (
                <Dropdown
                  variant="field"
              className="tp-control"
                  aria-label={t('tickets.parent')}
                  value={tk.parent?.note.id ?? ''}
                  options={[
                    { value: '', label: t('tickets.noParent') },
                    ...(tk.parent && !parents.includes(tk.parent) ? [tk.parent] : []).concat(parents).map((p) => ({ value: p.note.id, label: `${p.meta.id ?? `${p.project.config.key}-?`} · ${p.title}` })),
                  ]}
                  onChange={(id) => {
                    const p = parents.find((x) => x.note.id === id);
                    set({ parent: p?.meta.id ?? null });
                  }}
                />
              ) : tk.parent ? (
                <button className="hover:underline" onClick={() => navigate(`/n/${tk.parent!.note.id}`)}>
                  {tk.parent.meta.id} · {tk.parent.title}
                </button>
              ) : (
                <span className="text-muted">{tk.meta.parent ?? t('tickets.noParent')}</span>
              )}
              {tk.meta.kind === 'subtask' && !tk.parent && <span className="text-label-m text-amber">{t('tickets.parentNeeded')}</span>}
            </>
          )}
        {field(
          t('tickets.colStatus'),
          CheckCircle2,
          canEdit ? (
            <Dropdown variant="field"
              className="tp-control" aria-label={t('tickets.colStatus')} value={tk.meta.status} options={allowedStatusesOf(tk).map((s) => ({ value: s, label: s }))} onChange={(s) => set({ status: s })} />
          ) : (
            <StatusBadge tk={tk} />
          )
        )}
        {field(
          t('tickets.milestone'),
          Flag,
          canEdit ? (
            <Dropdown
              variant="field"
              className="tp-control"
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
            <Dropdown variant="field"
              className="tp-control" aria-label={t('tickets.colAssignee')} value={tk.meta.assignee ?? ''} options={[{ value: '', label: t('tickets.unassigned') }, ...assignees(tk.project, tk.note.id).map((a) => ({ value: a, label: a }))]} onChange={(a) => set({ assignee: a || null })} />
          ) : (
            <span>{tk.meta.assignee ?? t('tickets.unassigned')}</span>
          )
        )}
        {field(
          t('tickets.colPriority'),
          AlertTriangle,
          canEdit ? (
            <Dropdown variant="field"
              className="tp-control" aria-label={t('tickets.colPriority')} leadingIcon={<PriorityIcon p={tk.meta.priority} />} value={tk.meta.priority ?? ''} options={[{ value: '', label: t('tickets.priority.none') }, ...PRIORITIES.map((p) => ({ value: p, label: priorityLabel(p) }))]} onChange={(p) => set({ priority: (p as Priority) || null })} />
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
              className="input tp-control"
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
                className="input tp-control"
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
      <div className="tp-split grid gap-3">
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
          {canEdit && <NoteSearchField className="mt-1.5" label={t('tickets.docAdd')} placeholder={t('tickets.docLinkPlaceholder')} exclude={new Set([tk.note.id, ...docNotes.map((n) => n.id)])} onPick={addDoc} />}
        </div>
        <Relations self={tk} blockers={tk.blockers} blocking={tk.blocking} candidates={others} canEdit={canEdit} title={t('tickets.relations')} />
      </div>
      {(childKinds.length > 0 || tk.children.length > 0) && (
        <div data-ticket-children>
          <h3 className="mb-1.5 flex items-center gap-1.5 text-label-m font-semibold text-muted">
            <AccountTree size={14} /> {t('tickets.children', { done: tk.rollup.done, total: tk.rollup.total })}
          </h3>
          {tk.rollup.total > 0 && (
            <div className="mb-1.5 h-1 overflow-hidden rounded-full bg-line" aria-hidden>
              <div className="h-full bg-acc" style={{ width: `${Math.round((tk.rollup.done / tk.rollup.total) * 100)}%` }} />
            </div>
          )}
          <ul className="space-y-1">
            {tk.children.map((c) => (
              <li key={c.note.id} className="flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5">
                <KindIcon kind={c.meta.kind} />
                <button className="min-w-0 flex-1 text-left" onClick={() => navigate(`/n/${c.note.id}`)}>
                  <span className={`block truncate font-medium ${c.category === 'done' ? 'text-muted line-through' : ''}`}>{c.title}</span>
                  <span className="block truncate text-label-m text-muted">
                    {c.meta.id ?? `${c.project.config.key}-?`}
                    {c.meta.assignee ? ` · ${c.meta.assignee}` : ''}
                    {c.rollup.total ? ` · ${t('tickets.childrenShort', { done: c.rollup.done, total: c.rollup.total })}` : ''}
                  </span>
                </button>
                <StatusBadge tk={c} />
              </li>
            ))}
            {!tk.children.length && <li className="px-1 text-body-s text-muted">{t('tickets.childrenNone')}</li>}
          </ul>
          {canEdit && childKinds.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {childKinds.map((k) => (
                <button key={k} className="btn-text !min-h-0 !py-1" onClick={() => setChild(k)} data-new-child={k}>
                  <Plus size={14} /> {t('tickets.newChild', { kind: kindLabel(k) })}
                </button>
              ))}
            </div>
          )}
          {child && <NewTicketSheet project={tk.project} parent={tk} kind={child} onClose={() => setChild(null)} />}
        </div>
      )}
    </section>
  );
}

/** Header of a milestone: time frame, progress, its tickets, release notes */
function MilestoneHeader({ m, readOnly }: { m: MilestoneInfo; readOnly: boolean }) {
  const canEdit = m.project.canWrite && !readOnly && m.note.access !== 'read';
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const date = (key: 'start' | 'due', value: string | null) => (
    <label className="min-w-0 text-label-l text-muted">
      {t(key === 'start' ? 'tickets.start' : 'tickets.due')}
      {canEdit ? (
        <input type="date" className="input mt-1 block !min-h-0 min-w-0 !py-1" value={value ?? ''} onChange={(e) => void vault.setFrontmatter(m.note.id, { [key]: e.target.value || null })} />
      ) : (
        <span className="block text-body-m text-text">{value ? formatDay(value) : '–'}</span>
      )}
    </label>
  );
  return (
    <section className="ticket-panel no-print mb-3 space-y-3 rounded-lg border border-line bg-panel p-3 anim-fade-in" aria-label={t('tickets.milestoneLabel', { title: m.title })} data-milestone-panel>
      <MilestoneBanner m={m} />
      <div className="flex flex-wrap items-center gap-2">
        <span className={label}>
          <Flag size={16} /> {t('tickets.milestoneStatusTitle')}
        </span>
        {canEdit ? (
          <Dropdown
            variant="chip"
            aria-label={t('tickets.milestoneStatusTitle')}
            value={m.meta.status ?? ''}
            options={[{ value: '', label: t('tickets.milestoneStatusAutoOption', { status: milestoneStatusLabel(m.state) }) }, ...MILESTONE_STATUSES.map((s) => ({ value: s, label: milestoneStatusLabel(s) }))]}
            onChange={(v) => void setMilestoneStatus(m, (v as MilestoneStatus) || null)}
          />
        ) : (
          <MilestoneStatusBadge m={m} />
        )}
        {m.meta.status === 'done' && m.progress.done < m.progress.total && (
          <span className="inline-flex items-center gap-1 text-label-m text-amber" data-milestone-open-left>
            <AlertTriangle size={14} /> {t('tickets.milestoneDoneOpen', { n: m.progress.total - m.progress.done })}
          </span>
        )}
      </div>
      {m.conflicts.length > 0 && (
        <p className="flex items-start gap-1.5 rounded-md bg-red-bg px-2.5 py-2 text-body-s text-red" data-milestone-conflict>
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {t('tickets.milestoneConflict', { list: m.conflicts.map((c) => `${c.title}${c.meta.due ? ` (${formatDay(c.meta.due)})` : ''}`).join(', ') })}
        </p>
      )}
      {/* Columns by the room the note has (tablet with side panels), not by the screen width */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-x-3 gap-y-2">
        {date('start', m.meta.start)}
        {date('due', m.meta.due)}
        <div className="min-w-0 text-label-l text-muted">
          {t('tickets.release')}
          <span className="block text-body-m text-text">{m.meta.release ?? '–'}</span>
        </div>
        <div className="min-w-0 text-label-l text-muted">
          {t('tickets.points')}
          <span className="block text-body-m tabular-nums text-text">{m.progress.points ? `${m.progress.donePoints} / ${m.progress.points}` : '–'}</span>
        </div>
      </div>
      {m.meta.goal && <p className="text-body-m">{m.meta.goal}</p>}
      <Relations self={m} blockers={m.blockers} blocking={m.blocking} candidates={milestonesOf(m.project)} canEdit={canEdit} title={t('tickets.dependencies')} />
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

/** The tickets of a milestone as a block above its text (in the note column, not among the fields) */
export function MilestoneTickets({ noteId }: { noteId: string }) {
  useVault();
  useLang();
  const m = milestoneOfNote(noteId);
  if (!m) return null;
  const groups: { title: string; rows: TicketInfo[] }[] = [
    { title: t('tickets.catActive'), rows: m.tickets.filter((tk) => tk.category === 'active') },
    { title: t('tickets.catOpen'), rows: m.tickets.filter((tk) => tk.category === 'open') },
    { title: t('tickets.catDone'), rows: m.tickets.filter((tk) => tk.category === 'done') },
  ].map((g) => ({ ...g, rows: g.rows.sort(byRank) }));
  return (
    <section className="ticket-panel no-print mb-4 rounded-lg border border-line bg-panel p-3 anim-fade-in" aria-label={t('tickets.milestoneTickets', { n: m.tickets.length })} data-milestone-tickets>
      <h2 className="mb-2 flex items-center gap-1.5 text-label-l font-semibold text-muted">
        <Ticket size={16} /> {t('tickets.milestoneTickets', { n: m.tickets.length })}
      </h2>
      <div className="tp-split3 grid gap-3">
        {groups.map((g) => (
          <div key={g.title}>
            <h3 className="mb-1.5 text-label-m font-semibold text-muted">
              {g.title} · {g.rows.length}
            </h3>
            <ul className="space-y-1">
              {g.rows.map((tk) => (
                <LinkRow key={tk.note.id} title={tk.title} sub={`${kindLabel(tk.meta.kind)} · ${tk.meta.id ?? `${tk.project.config.key}-?`} · ${tk.meta.status}${tk.meta.assignee ? ` · ${tk.meta.assignee}` : ''}`} Icon={Ticket} onOpen={() => navigate(`/n/${tk.note.id}`)} />
              ))}
              {!g.rows.length && <li className="px-1 text-body-s text-muted">–</li>}
            </ul>
          </div>
        ))}
      </div>
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
