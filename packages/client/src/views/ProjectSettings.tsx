/**
 * Project settings in a dialog that uses the whole window: key and documentation rule, the statuses with their
 * categories, which status may follow which (a matrix, with presets), the automations (when … then …) and the
 * webhooks of GitLab/GitHub that feed them. Everything except the webhooks is one draft saved into the project's
 * database note (`project` block, see shared/workflow.ts), so nobody has to write YAML.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AUTOMATION_ACTIONS,
  AUTOMATION_TRIGGERS,
  MAX_CHECKLIST_ITEM,
  MAX_CHECKLIST_ITEMS,
  PARENT_KINDS,
  PRIORITIES,
  TICKET_KINDS,
  cleanChecklistItem,
  cleanProjectKey,
  isGitTrigger,
  newAutomationId,
  renameWorkflowStatus,
  statusCategory,
  type Automation,
  type AutomationAction,
  type AutomationActionType,
  type AutomationTrigger,
  type ProjectConfig,
  type StatusCategory,
  type TicketHook,
  type TicketChecklists,
  type TicketHookProvider,
  type TicketKind,
} from '@kladde/shared';
import { vault } from '../data/vault';
import { navigate } from '../lib/router';
import { createTicketHook, listTicketHooks, removeTicketHook, saveProject, ticketsOf, type ProjectInfo } from '../data/tickets';
import { copyText } from '../lib/clipboard';
import { useModal } from '../lib/modal';
import { locale, t, type I18nKey } from '../lib/i18n';
import { AlertTriangle, ArrowDown, ArrowRight, ArrowUp, Check, CheckSquare, Copy, Info, ListChecks, Loader2, Plus, Route, Settings, Trash2, Webhook, X, Zap } from '../lib/icons';
import { Dropdown } from './Dropdown';
import { Switch } from './Switch';
import { KindIcon, kindLabel } from './TicketKind';

type Section = 'general' | 'statuses' | 'types' | 'transitions' | 'automations' | 'git';

interface StatusRow {
  key: string;
  name: string;
  /** Name when the dialog opened; null for new statuses (renames move the tickets along) */
  orig: string | null;
  cat: StatusCategory;
}

interface Draft {
  key: string;
  requireDocs: boolean;
  rows: StatusRow[];
  /** Transitions are enforced */
  restricted: boolean;
  /** Allowed next statuses by row key (kept while the switch is off, so turning it on again keeps the choice) */
  transitions: Record<string, string[]>;
  automations: Automation[];
  /** Checklist template per ticket type, items as typed */
  checklists: Record<TicketKind, string[]>;
}

let rowCounter = 0;
const rowKey = () => `s${++rowCounter}`;
const lower = (s: string) => s.trim().toLowerCase();

function draftOf(c: ProjectConfig): Draft {
  const rows = c.workflow.map((name) => ({ key: rowKey(), name, orig: name, cat: statusCategory(c, name) }));
  const keyOf = (name: string) => rows.find((r) => lower(r.name) === lower(name))?.key;
  const transitions: Record<string, string[]> = {};
  rows.forEach((r, i) => {
    transitions[r.key] = c.transitions
      ? (c.transitions[r.name] ?? []).map(keyOf).filter((k): k is string => !!k)
      : [rows[i - 1]?.key, rows[i + 1]?.key].filter((k): k is string => !!k);
  });
  const checklists = Object.fromEntries(TICKET_KINDS.map((k) => [k, [...(c.checklists?.[k] ?? [])]])) as Record<TicketKind, string[]>;
  return { key: c.key, requireDocs: c.requireDocs, rows, restricted: !!c.transitions, transitions, automations: c.automations, checklists };
}

/** The config to save and the renamed statuses, or an error message */
function configOf(d: Draft): { config: ProjectConfig; renamed: Record<string, string> } | { error: string } {
  const key = cleanProjectKey(d.key);
  if (!key) return { error: t('tickets.keyInvalid') };
  const names = d.rows.map((r) => r.name.trim());
  if (names.some((n) => !n)) return { error: t('workflow.statusEmpty') };
  if (new Set(names.map(lower)).size !== names.length) return { error: t('workflow.statusDuplicate') };
  if (names.length < 2) return { error: t('tickets.workflowTooShort') };
  const done = d.rows.filter((r) => r.cat === 'done').map((r) => r.name.trim());
  if (!done.length) return { error: t('workflow.needsDone') };
  const nameOf = new Map(d.rows.map((r) => [r.key, r.name.trim()]));
  const transitions = d.restricted ? Object.fromEntries(d.rows.map((r) => [r.name.trim(), (d.transitions[r.key] ?? []).map((k) => nameOf.get(k)).filter((n): n is string => !!n)])) : null;
  const renamed: Record<string, string> = {};
  for (const r of d.rows) if (r.orig && r.orig !== r.name.trim()) renamed[r.orig] = r.name.trim();
  return {
    config: { key, workflow: names, active: d.rows.filter((r) => r.cat === 'active').map((r) => r.name.trim()), done, requireDocs: d.requireDocs, transitions, automations: d.automations, checklists: cleanChecklists(d.checklists) },
    renamed,
  };
}

function cleanChecklists(c: Record<TicketKind, string[]>): TicketChecklists {
  const out: TicketChecklists = {};
  for (const k of TICKET_KINDS) {
    const items = c[k].map(cleanChecklistItem).filter(Boolean);
    if (items.length) out[k] = items;
  }
  return out;
}

const formatDateTime = (ms: number) => new Date(ms).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
const triggerLabel = (tr: AutomationTrigger) => t(`workflow.trigger.${tr}` as I18nKey);
const actionLabel = (a: AutomationActionType) => t(`workflow.action.${a}` as I18nKey);

/** One sentence for a rule: "When a merge request is merged · status In progress → status Implemented" */
function ruleSummary(a: Automation): string {
  const when = [triggerLabel(a.trigger)];
  if (a.trigger === 'status_changed' && a.from.length) when.push(t('workflow.summaryFrom', { list: a.from.join(', ') }));
  if (a.trigger === 'status_changed' && a.to.length) when.push(t('workflow.summaryTo', { list: a.to.join(', ') }));
  if (a.ifStatus.length) when.push(t('workflow.summaryIf', { list: a.ifStatus.join(', ') }));
  const then = a.actions.map((x) => (x.type === 'comment' ? actionLabel(x.type) : `${actionLabel(x.type)}: ${x.value === '{{actor}}' ? t('workflow.actor') : x.value || '–'}`));
  return `${when.join(' · ')} → ${then.join(', ') || t('workflow.noActions')}`;
}

export function ProjectSettingsDialog({ project, onClose, initialSection = 'general' }: { project: ProjectInfo; onClose: () => void; initialSection?: Section }) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [section, setSection] = useState<Section>(initialSection);
  const [initial] = useState(() => draftOf(project.config));
  const [draft, setDraft] = useState<Draft>(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initial), [draft, initial]);
  const close = () => {
    if (dirty && !confirm(t('workflow.discard'))) return;
    onClose();
  };
  useModal(panel, close);
  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));
  // Tickets per status (lower case): renaming moves them along, removing a used status asks first
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const tk of ticketsOf(project)) m.set(lower(tk.meta.status), (m.get(lower(tk.meta.status)) ?? 0) + 1);
    return m;
  }, [project]);

  const save = async () => {
    const result = configOf(draft);
    if ('error' in result) return setError(result.error);
    setBusy(true);
    try {
      await saveProject(project, result.config, result.renamed);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sections: { id: Section; label: string; Icon: typeof Settings; badge?: number }[] = [
    { id: 'general', label: t('workflow.secGeneral'), Icon: Settings },
    { id: 'statuses', label: t('workflow.secStatuses'), Icon: Check, badge: draft.rows.length },
    { id: 'types', label: t('tickets.secTypes'), Icon: ListChecks, badge: TICKET_KINDS.reduce((n, k) => n + (draft.checklists[k].some((i) => i.trim()) ? 1 : 0), 0) || undefined },
    { id: 'transitions', label: t('workflow.secTransitions'), Icon: Route },
    { id: 'automations', label: t('workflow.secAutomations'), Icon: Zap, badge: draft.automations.length || undefined },
    { id: 'git', label: t('workflow.secGit'), Icon: Webhook },
  ];

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center sm:p-4 lg:p-6">
      <div className="fixed inset-0 bg-scrim/[0.32] anim-fade-in" onClick={close} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-project-settings
        className="relative flex h-full w-full max-w-[1600px] flex-col overflow-hidden bg-panel shadow-elevation-3 outline-none anim-sheet sm:rounded-xl sm:border sm:border-line2"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3 sm:px-6">
          <span className="inline-flex h-7 items-center rounded-md border border-line2 bg-raised px-2 font-mono text-label-m text-strong">{project.config.key}</span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-headline-s">
              {t('tickets.projectSettings')}
            </h2>
            <p className="truncate text-caption text-muted">{project.spaceName ? `${project.spaceName} · ${project.folder}` : project.folder}</p>
          </div>
          <button className="btn-icon shrink-0" onClick={close} title={t('common.close')} aria-label={t('common.close')}>
            <X size={20} />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav aria-label={t('tickets.projectSettings')} className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-2 py-2 scrollbar-thin sm:w-56 sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r sm:px-3 sm:py-4">
            {sections.map(({ id, label, Icon, badge }) => (
              <button
                key={id}
                type="button"
                aria-current={section === id ? 'page' : undefined}
                onClick={() => setSection(id)}
                data-section={id}
                className={`state-layer flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-left text-body-m outline-none focus-visible:ring-2 focus-visible:ring-acc ${section === id ? 'bg-line text-strong' : 'text-soft'}`}
              >
                <Icon size={18} className={section === id ? 'text-acc' : 'text-muted'} />
                <span className="flex-1 whitespace-nowrap">{label}</span>
                {badge !== undefined && <span className="font-mono text-caption text-muted">{badge}</span>}
              </button>
            ))}
          </nav>

          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-8 sm:py-6" data-section-body={section}>
            {section === 'general' && <GeneralSection draft={draft} patch={patch} />}
            {section === 'statuses' && <StatusSection draft={draft} setDraft={setDraft} counts={counts} />}
            {section === 'types' && <TypesSection project={project} draft={draft} patch={patch} />}
            {section === 'transitions' && <TransitionSection draft={draft} patch={patch} />}
            {section === 'automations' && <AutomationSection draft={draft} patch={patch} onGit={() => setSection('git')} />}
            {section === 'git' && <GitSection project={project} draft={draft} onAutomations={() => setSection('automations')} />}
          </div>
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3 safe-bottom [--pad-bottom:0.75rem] sm:px-6">
          {error ? (
            <p className="mr-auto flex items-center gap-1.5 text-body-s text-red" role="alert">
              <AlertTriangle size={16} /> {error}
            </p>
          ) : (
            <p className="mr-auto hidden text-caption text-muted sm:block">{dirty ? t('workflow.unsaved') : t('workflow.saved')}</p>
          )}
          <button className="btn-text" onClick={close}>
            {t('common.cancel')}
          </button>
          <button className="btn-primary" disabled={busy || !dirty} onClick={() => void save()} data-save-project>
            {busy && <Loader2 size={16} className="animate-spin" />} {t('common.save')}
          </button>
        </footer>
      </div>
    </div>,
    document.body
  );
}

function SectionHead({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-5 max-w-3xl space-y-1">
      <h3 className="panel-title">{title}</h3>
      {children && <p className="text-body-m text-muted">{children}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ general

function GeneralSection({ draft, patch }: { draft: Draft; patch: (p: Partial<Draft>) => void }) {
  return (
    <div className="max-w-2xl space-y-6">
      <SectionHead title={t('workflow.secGeneral')} />
      <label className="block text-label-l text-muted">
        {t('tickets.key')}
        <input className="input mt-1 max-w-xs font-mono uppercase" value={draft.key} maxLength={10} onChange={(e) => patch({ key: e.target.value })} />
        <span className="mt-1 block text-body-s">{t('tickets.keyChangeHint')}</span>
      </label>
      <div className="space-y-1">
        <label className="flex items-center justify-between gap-3 text-body-l">
          {t('tickets.requireDocs')}
          <Switch id="project-require-docs" checked={draft.requireDocs} label={t('tickets.requireDocs')} onChange={(v) => patch({ requireDocs: v })} />
        </label>
        <p className="text-body-s text-muted">{t('tickets.requireDocsHint')}</p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ ticket types

function TypesSection({ project, draft, patch }: { project: ProjectInfo; draft: Draft; patch: (p: Partial<Draft>) => void }) {
  const counts = useMemo(() => {
    const m = new Map<TicketKind, number>();
    for (const tk of ticketsOf(project)) m.set(tk.meta.kind, (m.get(tk.meta.kind) ?? 0) + 1);
    return m;
  }, [project]);
  const set = (kind: TicketKind, items: string[]) => patch({ checklists: { ...draft.checklists, [kind]: items } });
  return (
    <div className="max-w-3xl space-y-4" data-ticket-types>
      <SectionHead title={t('tickets.secTypes')}>{t('tickets.typesIntro')}</SectionHead>
      {TICKET_KINDS.map((kind) => (
        <ChecklistCard key={kind} kind={kind} count={counts.get(kind) ?? 0} items={draft.checklists[kind]} onChange={(items) => set(kind, items)} />
      ))}
    </div>
  );
}

function ChecklistCard({ kind, count, items, onChange }: { kind: TicketKind; count: number; items: string[]; onChange: (items: string[]) => void }) {
  const [next, setNext] = useState('');
  const addRef = useRef<HTMLInputElement>(null);
  const label = kindLabel(kind);
  const parents = PARENT_KINDS[kind];
  const add = () => {
    const item = cleanChecklistItem(next);
    if (!item || items.length >= MAX_CHECKLIST_ITEMS) return;
    onChange([...items, item]);
    setNext('');
    addRef.current?.focus();
  };
  const move = (i: number, by: number) => {
    const list = [...items];
    const [x] = list.splice(i, 1);
    list.splice(i + by, 0, x);
    onChange(list);
  };
  return (
    <section className="card p-4" aria-label={label} data-ticket-kind={kind}>
      <div className="mb-3 flex items-center gap-2.5">
        <KindIcon kind={kind} size={18} />
        <h4 className="text-title-s text-strong">{label}</h4>
        <span className="font-mono text-caption text-muted">{t('tickets.typeCount', { n: count })}</span>
        <span className="ml-auto hidden text-caption text-muted sm:inline">
          {parents.length ? t('tickets.typeBelow', { list: parents.map(kindLabel).join(', ') }) : t('tickets.typeTop')}
        </span>
      </div>
      <p className="mb-2 text-body-s text-muted">{items.length ? t('tickets.checklistHint', { kind: label }) : t('tickets.checklistEmpty', { kind: label })}</p>
      {items.length > 0 && (
        <ul className="mb-2 space-y-1.5">
          {items.map((item, i) => (
            <li key={i} className="flex items-center gap-2" data-checklist-item>
              <CheckSquare size={16} className="shrink-0 text-faint" />
              <input
                className="input min-w-0 flex-1"
                value={item}
                maxLength={MAX_CHECKLIST_ITEM}
                aria-label={t('tickets.checklistItem', { n: i + 1, kind: label })}
                onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
              />
              <button type="button" className="btn-icon h-8 w-8 shrink-0" disabled={i === 0} onClick={() => move(i, -1)} title={t('workflow.moveUp', { name: item })} aria-label={t('workflow.moveUp', { name: item })}>
                <ArrowUp size={16} />
              </button>
              <button type="button" className="btn-icon h-8 w-8 shrink-0" disabled={i === items.length - 1} onClick={() => move(i, 1)} title={t('workflow.moveDown', { name: item })} aria-label={t('workflow.moveDown', { name: item })}>
                <ArrowDown size={16} />
              </button>
              <button type="button" className="btn-icon h-8 w-8 shrink-0" onClick={() => onChange(items.filter((_, j) => j !== i))} title={t('common.delete')} aria-label={`${t('common.delete')}: ${item}`}>
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          ref={addRef}
          className="input min-w-0 flex-1"
          value={next}
          maxLength={MAX_CHECKLIST_ITEM}
          placeholder={t(kind === 'bug' ? 'tickets.checklistPlaceholderBug' : 'tickets.checklistPlaceholder')}
          aria-label={t('tickets.checklistAdd', { kind: label })}
          disabled={items.length >= MAX_CHECKLIST_ITEMS}
          onChange={(e) => setNext(e.target.value)}
        />
        <button type="submit" className="btn-tonal shrink-0" disabled={!cleanChecklistItem(next) || items.length >= MAX_CHECKLIST_ITEMS}>
          <Plus size={16} /> {t('tickets.checklistAddBtn')}
        </button>
      </form>
    </section>
  );
}

// ------------------------------------------------------------------ statuses

const CATEGORIES: StatusCategory[] = ['open', 'active', 'done'];
const categoryLabel = (c: StatusCategory) => t(c === 'open' ? 'tickets.catOpen' : c === 'active' ? 'tickets.catActive' : 'tickets.catDone');

function StatusSection({ draft, setDraft, counts: byStatus }: { draft: Draft; setDraft: React.Dispatch<React.SetStateAction<Draft>>; counts: Map<string, number> }) {
  const rename = (key: string, name: string) =>
    setDraft((d) => {
      const prev = d.rows.find((r) => r.key === key)?.name ?? '';
      const others = d.rows.filter((r) => r.key !== key).map((r) => lower(r.name));
      // Rules name statuses by their text: they follow the rename (not while the old name is another status too)
      const automations = prev.trim() && name.trim() && !others.includes(lower(prev)) ? renameWorkflowStatus(null, d.automations, prev.trim(), name.trim()).automations : d.automations;
      return { ...d, automations, rows: d.rows.map((r) => (r.key === key ? { ...r, name } : r)) };
    });
  const move = (i: number, by: number) =>
    setDraft((d) => {
      const rows = [...d.rows];
      const [row] = rows.splice(i, 1);
      rows.splice(i + by, 0, row);
      return { ...d, rows };
    });
  const remove = (key: string) =>
    setDraft((d) => ({
      ...d,
      rows: d.rows.filter((r) => r.key !== key),
      transitions: Object.fromEntries(Object.entries(d.transitions).filter(([k]) => k !== key).map(([k, v]) => [k, v.filter((x) => x !== key)])),
    }));
  const add = () =>
    setDraft((d) => {
      const key = rowKey();
      const last = d.rows[d.rows.length - 1];
      return { ...d, rows: [...d.rows, { key, name: '', orig: null, cat: 'open' }], transitions: { ...d.transitions, [key]: last ? [last.key] : [] } };
    });
  const counts = (name: string) => (name ? (byStatus.get(lower(name)) ?? 0) : 0);

  return (
    <div className="max-w-3xl">
      <SectionHead title={t('workflow.secStatuses')}>{t('workflow.statusesHint')}</SectionHead>
      <ol className="space-y-2" data-status-list>
        {draft.rows.map((r, i) => (
          <li key={r.key} className="card flex flex-wrap items-center gap-2 p-2 sm:flex-nowrap">
            <span className="w-6 shrink-0 text-center font-mono text-caption text-muted">{i + 1}</span>
            <input
              className="input min-w-0 flex-1 basis-40"
              value={r.name}
              aria-label={t('workflow.statusName', { n: i + 1 })}
              placeholder={t('workflow.statusPlaceholder')}
              autoFocus={!r.name && r.orig === null}
              onChange={(e) => rename(r.key, e.target.value)}
            />
            {r.orig && r.orig !== r.name.trim() && r.name.trim() && <span className="pill bg-amber-bg text-amber" title={t('workflow.renameHint', { from: r.orig, n: counts(r.orig) })}>{t('workflow.renamed', { from: r.orig })}</span>}
            <div className="segmented shrink-0" role="group" aria-label={t('workflow.category')}>
              {CATEGORIES.map((c) => (
                <button key={c} type="button" aria-pressed={r.cat === c} onClick={() => setDraft((d) => ({ ...d, rows: d.rows.map((x) => (x.key === r.key ? { ...x, cat: c } : x)) }))}>
                  {categoryLabel(c)}
                </button>
              ))}
            </div>
            <div className="flex shrink-0 items-center">
              <button className="btn-icon" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('workflow.moveUp', { name: r.name })} title={t('workflow.moveUp', { name: r.name })}>
                <ArrowUp size={18} />
              </button>
              <button className="btn-icon" disabled={i === draft.rows.length - 1} onClick={() => move(i, 1)} aria-label={t('workflow.moveDown', { name: r.name })} title={t('workflow.moveDown', { name: r.name })}>
                <ArrowDown size={18} />
              </button>
              <button
                className="btn-icon text-red"
                disabled={draft.rows.length <= 2}
                onClick={() => {
                  const n = counts(r.orig ?? r.name);
                  if (n && !confirm(t('workflow.removeStatusConfirm', { name: r.name, n }))) return;
                  remove(r.key);
                }}
                aria-label={t('workflow.removeStatus', { name: r.name })}
                title={t('workflow.removeStatus', { name: r.name })}
              >
                <Trash2 size={18} />
              </button>
            </div>
          </li>
        ))}
      </ol>
      <button className="btn-tonal mt-3" onClick={add}>
        <Plus size={18} /> {t('workflow.addStatus')}
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ transitions

function TransitionSection({ draft, patch }: { draft: Draft; patch: (p: Partial<Draft>) => void }) {
  const rows = draft.rows;
  const allowed = (from: string, to: string) => (draft.transitions[from] ?? []).includes(to);
  const toggle = (from: string, to: string) => patch({ transitions: { ...draft.transitions, [from]: allowed(from, to) ? draft.transitions[from].filter((x) => x !== to) : [...(draft.transitions[from] ?? []), to] } });
  const preset = (kind: 'linear' | 'forward' | 'all' | 'none') =>
    patch({
      restricted: true,
      transitions: Object.fromEntries(
        rows.map((r, i) => [
          r.key,
          kind === 'all' ? rows.filter((x) => x.key !== r.key).map((x) => x.key) : kind === 'none' ? [] : [kind === 'linear' ? rows[i - 1]?.key : undefined, rows[i + 1]?.key].filter((k): k is string => !!k),
        ])
      ),
    });
  const name = (r: StatusRow, i: number) => r.name.trim() || t('workflow.statusName', { n: i + 1 });
  const deadEnds = draft.restricted ? rows.filter((r) => r.cat !== 'done' && !(draft.transitions[r.key] ?? []).length) : [];
  const unreachable = draft.restricted ? rows.filter((r, i) => i > 0 && !rows.some((x) => x.key !== r.key && allowed(x.key, r.key))) : [];

  return (
    <div className="space-y-6">
      <SectionHead title={t('workflow.secTransitions')}>{t('workflow.transitionsHint')}</SectionHead>
      <label className="card flex max-w-3xl items-center justify-between gap-4 p-4">
        <span>
          <span className="block text-body-l text-strong">{t('workflow.enforce')}</span>
          <span className="block text-body-s text-muted">{draft.restricted ? t('workflow.enforceOn') : t('workflow.enforceOff')}</span>
        </span>
        <Switch id="workflow-restricted" checked={draft.restricted} label={t('workflow.enforce')} onChange={(v) => patch({ restricted: v })} />
      </label>

      {draft.restricted && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-label-l text-muted">{t('workflow.presets')}</span>
            <button className="chip" onClick={() => preset('forward')} data-preset="forward">
              {t('workflow.presetForward')}
            </button>
            <button className="chip" onClick={() => preset('linear')} data-preset="linear">
              {t('workflow.presetLinear')}
            </button>
            <button className="chip" onClick={() => preset('all')}>
              {t('workflow.presetAll')}
            </button>
            <button className="chip" onClick={() => preset('none')}>
              {t('workflow.presetNone')}
            </button>
          </div>

          <div className="overflow-x-auto scrollbar-thin">
            <table className="border-separate border-spacing-0 text-body-m" data-transition-matrix>
              <caption className="sr-only">{t('workflow.matrixCaption')}</caption>
              <thead>
                <tr>
                  <th scope="col" className="sticky left-0 z-10 bg-panel px-3 py-2 text-left text-caption font-normal text-muted">
                    {t('workflow.fromTo')}
                  </th>
                  {rows.map((r, i) => (
                    <th key={r.key} scope="col" className="min-w-[7rem] border-b border-line px-3 py-2 text-center font-medium text-strong">
                      {name(r, i)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((from, i) => (
                  <tr key={from.key}>
                    <th scope="row" className="sticky left-0 z-10 whitespace-nowrap border-r border-line bg-panel px-3 py-2 text-left font-medium text-strong">
                      {name(from, i)}
                    </th>
                    {rows.map((to, j) => {
                      const self = from.key === to.key;
                      const on = !self && allowed(from.key, to.key);
                      return (
                        <td key={to.key} className={`border-b border-line px-3 py-1.5 text-center ${self ? 'bg-raised/60' : ''}`}>
                          {self ? (
                            <span className="text-faint" aria-hidden>
                              ·
                            </span>
                          ) : (
                            <button
                              type="button"
                              role="checkbox"
                              aria-checked={on}
                              aria-label={t('workflow.cellLabel', { from: name(from, i), to: name(to, j) })}
                              title={t('workflow.cellLabel', { from: name(from, i), to: name(to, j) })}
                              onClick={() => toggle(from.key, to.key)}
                              className={`inline-flex h-8 w-8 items-center justify-center rounded-md border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-acc ${on ? 'border-acc bg-acc text-on-acc' : 'border-line2 text-transparent hover:border-muted'}`}
                            >
                              <Check size={16} />
                            </button>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="max-w-3xl space-y-2">
            <h4 className="section-label">{t('workflow.flow')}</h4>
            <ul className="space-y-1.5">
              {rows.map((r, i) => {
                const next = (draft.transitions[r.key] ?? []).map((k) => rows.findIndex((x) => x.key === k)).filter((j) => j >= 0).sort((a, b) => a - b);
                return (
                  <li key={r.key} className="flex flex-wrap items-center gap-1.5 text-body-m">
                    <span className="pill bg-raised text-strong">{name(r, i)}</span>
                    <ArrowRight size={16} className="text-muted" />
                    {next.length ? next.map((j) => <span key={j} className="pill bg-acc-bg text-acc-hi">{name(rows[j], j)}</span>) : <span className="text-caption text-muted">{r.cat === 'done' ? t('workflow.final') : t('workflow.deadEnd')}</span>}
                  </li>
                );
              })}
            </ul>
          </div>
          {(deadEnds.length > 0 || unreachable.length > 0) && (
            <div className="flex max-w-3xl items-start gap-2 rounded-lg border border-amber/40 bg-amber-bg px-3.5 py-2.5 text-body-s text-amber" role="status">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>
                {deadEnds.length > 0 && t('workflow.deadEndWarn', { list: deadEnds.map((r) => r.name).join(', ') })} {unreachable.length > 0 && t('workflow.unreachableWarn', { list: unreachable.map((r) => r.name).join(', ') })}
              </span>
            </div>
          )}
          <p className="flex max-w-3xl items-start gap-2 text-body-s text-muted">
            <Info size={16} className="mt-0.5 shrink-0" /> {t('workflow.enforceDetails')}
          </p>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ automations

type Template = 'merge' | 'mrOpened' | 'start' | 'subtasks' | 'blank';

function templateRule(kind: Template, d: Draft): Automation {
  const names = d.rows.map((r) => r.name.trim()).filter(Boolean);
  const active = d.rows.filter((r) => r.cat === 'active').map((r) => r.name.trim());
  const firstDone = d.rows.find((r) => r.cat === 'done')?.name.trim() ?? names[names.length - 1] ?? '';
  const named = (re: RegExp) => names.find((n) => re.test(n));
  const review = named(/review|prüf|test/i);
  const implemented = named(/implement|gemerg|merged|umgesetzt/i) ?? firstDone;
  const base: Automation = { id: newAutomationId(), name: '', enabled: true, trigger: 'ticket_created', from: [], to: [], ifStatus: [], ifLabels: [], force: false, actions: [] };
  switch (kind) {
    case 'merge':
      return { ...base, name: t('workflow.tplMergeName'), trigger: 'mr_merged', ifStatus: active, force: true, actions: [{ type: 'set_status', value: implemented }, { type: 'comment', value: t('workflow.tplMergeComment') }] };
    case 'mrOpened':
      return { ...base, name: t('workflow.tplOpenedName'), trigger: 'mr_opened', force: true, actions: [{ type: 'set_status', value: review ?? active[active.length - 1] ?? names[1] ?? '' }] };
    case 'start':
      return { ...base, name: t('workflow.tplStartName'), trigger: 'status_changed', to: active.slice(0, 1), actions: [{ type: 'set_assignee', value: '{{actor}}' }] };
    case 'subtasks':
      return { ...base, name: t('workflow.tplSubtasksName'), trigger: 'subtasks_done', actions: [{ type: 'set_status', value: review ?? firstDone }] };
    default:
      return { ...base, name: t('workflow.newRule'), actions: [{ type: 'add_label', value: '' }] };
  }
}

function AutomationSection({ draft, patch, onGit }: { draft: Draft; patch: (p: Partial<Draft>) => void; onGit: () => void }) {
  const [selected, setSelected] = useState<string | 'new' | null>(() => draft.automations[0]?.id ?? 'new');
  const rule = draft.automations.find((a) => a.id === selected) ?? null;
  const update = (id: string, p: Partial<Automation>) => patch({ automations: draft.automations.map((a) => (a.id === id ? { ...a, ...p } : a)) });
  const add = (kind: Template) => {
    const a = templateRule(kind, draft);
    patch({ automations: [...draft.automations, a] });
    setSelected(a.id);
  };
  const remove = (id: string) => {
    const left = draft.automations.filter((a) => a.id !== id);
    patch({ automations: left });
    setSelected(left[0]?.id ?? 'new');
  };
  const move = (id: string, by: number) => {
    const list = [...draft.automations];
    const i = list.findIndex((a) => a.id === id);
    const [a] = list.splice(i, 1);
    list.splice(Math.max(0, Math.min(list.length, i + by)), 0, a);
    patch({ automations: list });
  };

  return (
    <div>
      <SectionHead title={t('workflow.secAutomations')}>{t('workflow.automationsHint')}</SectionHead>
      <div className="grid gap-6 lg:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
        <div className="space-y-2">
          <ul className="space-y-1.5" data-rule-list>
            {draft.automations.map((a, i) => (
              <li key={a.id}>
                <div className={`flex items-start gap-2 rounded-lg border p-3 ${selected === a.id ? 'border-acc-line bg-acc-bg/40' : 'border-line hover:border-line2'}`}>
                  <button type="button" className="min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-acc" onClick={() => setSelected(a.id)} aria-current={selected === a.id ? 'true' : undefined}>
                    <span className={`block truncate font-medium ${a.enabled ? 'text-strong' : 'text-muted line-through'}`}>{a.name || t('workflow.ruleN', { n: i + 1 })}</span>
                    <span className="mt-0.5 line-clamp-2 block text-caption text-muted">{ruleSummary(a)}</span>
                  </button>
                  <Switch checked={a.enabled} label={t('workflow.ruleEnabled', { name: a.name || t('workflow.ruleN', { n: i + 1 }) })} onChange={(v) => update(a.id, { enabled: v })} />
                </div>
              </li>
            ))}
          </ul>
          <button className={`btn-tonal w-full ${selected === 'new' ? 'ring-2 ring-acc' : ''}`} onClick={() => setSelected('new')}>
            <Plus size={18} /> {t('workflow.addRule')}
          </button>
        </div>

        <div className="min-w-0">
          {selected === 'new' || !rule ? (
            <TemplatePicker onPick={add} />
          ) : (
            <RuleEditor
              key={rule.id}
              rule={rule}
              draft={draft}
              index={draft.automations.indexOf(rule)}
              onChange={(p) => update(rule.id, p)}
              onRemove={() => remove(rule.id)}
              onMove={(by) => move(rule.id, by)}
              onDuplicate={() => {
                const copy = { ...rule, id: newAutomationId(), name: t('workflow.copyOf', { name: rule.name || t('workflow.newRule') }) };
                patch({ automations: [...draft.automations, copy] });
                setSelected(copy.id);
              }}
              onGit={onGit}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function TemplatePicker({ onPick }: { onPick: (kind: Template) => void }) {
  const items: { kind: Template; title: string; text: string; Icon: typeof Zap }[] = [
    { kind: 'merge', title: t('workflow.tplMergeName'), text: t('workflow.tplMergeText'), Icon: Webhook },
    { kind: 'mrOpened', title: t('workflow.tplOpenedName'), text: t('workflow.tplOpenedText'), Icon: Webhook },
    { kind: 'start', title: t('workflow.tplStartName'), text: t('workflow.tplStartText'), Icon: Zap },
    { kind: 'subtasks', title: t('workflow.tplSubtasksName'), text: t('workflow.tplSubtasksText'), Icon: Check },
    { kind: 'blank', title: t('workflow.tplBlankName'), text: t('workflow.tplBlankText'), Icon: Plus },
  ];
  return (
    <div className="space-y-3">
      <h4 className="section-label">{t('workflow.pickTemplate')}</h4>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {items.map(({ kind, title, text, Icon }) => (
          <li key={kind}>
            <button type="button" className="card flex h-full w-full items-start gap-3 p-4 text-left transition-colors hover:border-acc-line focus-visible:ring-2 focus-visible:ring-acc" onClick={() => onPick(kind)} data-template={kind}>
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-acc-bg text-acc-hi">
                <Icon size={18} />
              </span>
              <span className="min-w-0">
                <span className="block font-medium text-strong">{title}</span>
                <span className="mt-0.5 block text-body-s text-muted">{text}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Toggle chips for a set of statuses; none selected means "any" */
function StatusChips({ label, statuses, value, onChange, anyLabel }: { label: string; statuses: string[]; value: string[]; onChange: (v: string[]) => void; anyLabel: string }) {
  const has = (s: string) => value.some((v) => lower(v) === lower(s));
  const unknown = value.filter((v) => !statuses.some((s) => lower(s) === lower(v)));
  return (
    <div role="group" aria-label={label}>
      <div className="mb-1.5 text-label-l text-muted">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {statuses.map((s) => (
          <button key={s} type="button" className={`chip ${has(s) ? 'bg-acc-bg text-acc-hi' : ''}`} aria-pressed={has(s)} onClick={() => onChange(has(s) ? value.filter((v) => lower(v) !== lower(s)) : [...value, s])}>
            {s}
          </button>
        ))}
        {unknown.map((s) => (
          <button key={s} type="button" className="chip bg-amber-bg text-amber" title={t('workflow.unknownStatus')} onClick={() => onChange(value.filter((v) => v !== s))}>
            {s} <X size={14} />
          </button>
        ))}
        {!value.length && <span className="self-center text-caption text-muted">{anyLabel}</span>}
      </div>
    </div>
  );
}

function RuleEditor({
  rule,
  draft,
  index,
  onChange,
  onRemove,
  onMove,
  onDuplicate,
  onGit,
}: {
  rule: Automation;
  draft: Draft;
  index: number;
  onChange: (p: Partial<Automation>) => void;
  onRemove: () => void;
  onMove: (by: number) => void;
  onDuplicate: () => void;
  onGit: () => void;
}) {
  const statuses = draft.rows.map((r) => r.name.trim()).filter(Boolean);
  const setAction = (i: number, p: Partial<AutomationAction>) => onChange({ actions: rule.actions.map((a, j) => (j === i ? { ...a, ...p } : a)) });
  const defaultValue = (type: AutomationActionType) => (type === 'set_status' ? (statuses[0] ?? '') : type === 'set_priority' ? 'medium' : '');
  const hasStatusAction = rule.actions.some((a) => a.type === 'set_status');
  const [labels, setLabels] = useState(rule.ifLabels.join(', '));
  useEffect(() => setLabels(rule.ifLabels.join(', ')), [rule.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="card space-y-6 p-4 sm:p-6" data-rule-editor={rule.id}>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block min-w-0 flex-1 basis-64 text-label-l text-muted">
          {t('workflow.ruleName')}
          <input className="input mt-1" value={rule.name} placeholder={t('workflow.ruleN', { n: index + 1 })} onChange={(e) => onChange({ name: e.target.value })} />
        </label>
        <label className="flex h-10 items-center gap-2 text-body-m">
          <Switch checked={rule.enabled} label={t('workflow.enabled')} onChange={(v) => onChange({ enabled: v })} />
          {t('workflow.enabled')}
        </label>
      </div>

      <p className="rounded-lg bg-raised px-3.5 py-2.5 text-body-m text-soft" aria-live="polite">
        {ruleSummary(rule)}
      </p>

      <fieldset className="space-y-4">
        <legend className="mb-2 text-title-s text-strong">{t('workflow.when')}</legend>
        <div className="max-w-md">
          <Dropdown aria-label={t('workflow.when')} value={rule.trigger} options={AUTOMATION_TRIGGERS.map((tr) => ({ value: tr, label: triggerLabel(tr) }))} onChange={(v) => onChange({ trigger: v as AutomationTrigger })} />
        </div>
        {rule.trigger === 'status_changed' && (
          <div className="grid gap-4 md:grid-cols-2">
            <StatusChips label={t('workflow.fromStatus')} statuses={statuses} value={rule.from} onChange={(from) => onChange({ from })} anyLabel={t('workflow.anyStatus')} />
            <StatusChips label={t('workflow.toStatus')} statuses={statuses} value={rule.to} onChange={(to) => onChange({ to })} anyLabel={t('workflow.anyStatus')} />
          </div>
        )}
        {isGitTrigger(rule.trigger) && (
          <div className="flex items-start gap-2 rounded-lg border border-line px-3.5 py-2.5 text-body-s text-muted">
            <Info size={16} className="mt-0.5 shrink-0 text-acc" />
            <span>
              {t('workflow.gitTriggerHint', { key: cleanProjectKey(draft.key) ?? draft.key })}{' '}
              <button type="button" className="text-acc underline-offset-2 hover:underline" onClick={onGit}>
                {t('workflow.toGit')}
              </button>
            </span>
          </div>
        )}
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="mb-2 text-title-s text-strong">{t('workflow.onlyIf')}</legend>
        <StatusChips label={t('workflow.ifStatus')} statuses={statuses} value={rule.ifStatus} onChange={(ifStatus) => onChange({ ifStatus })} anyLabel={t('workflow.anyStatus')} />
        <label className="block max-w-md text-label-l text-muted">
          {t('workflow.ifLabels')}
          <input
            className="input mt-1"
            value={labels}
            placeholder={t('workflow.ifLabelsPlaceholder')}
            onChange={(e) => {
              setLabels(e.target.value);
              onChange({ ifLabels: [...new Set(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))] });
            }}
          />
        </label>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="mb-2 text-title-s text-strong">{t('workflow.then')}</legend>
        <ol className="space-y-2">
          {rule.actions.map((a, i) => (
            <li key={i} className="flex flex-wrap items-start gap-2 rounded-lg border border-line p-2.5">
              <div className="w-full sm:w-56">
                <Dropdown aria-label={t('workflow.actionN', { n: i + 1 })} value={a.type} options={AUTOMATION_ACTIONS.map((x) => ({ value: x, label: actionLabel(x) }))} onChange={(v) => setAction(i, { type: v as AutomationActionType, value: defaultValue(v as AutomationActionType) })} />
              </div>
              <div className="min-w-0 flex-1 basis-56">
                <ActionValue action={a} statuses={statuses} onChange={(value) => setAction(i, { value })} />
              </div>
              <button className="btn-icon text-red" onClick={() => onChange({ actions: rule.actions.filter((_, j) => j !== i) })} aria-label={t('workflow.removeAction', { n: i + 1 })} title={t('workflow.removeAction', { n: i + 1 })}>
                <Trash2 size={18} />
              </button>
            </li>
          ))}
        </ol>
        {!rule.actions.length && <p className="text-body-s text-amber">{t('workflow.noActionsHint')}</p>}
        <button className="btn-outlined" onClick={() => onChange({ actions: [...rule.actions, { type: 'set_status', value: defaultValue('set_status') }] })}>
          <Plus size={18} /> {t('workflow.addAction')}
        </button>
        {hasStatusAction && draft.restricted && (
          <label className="flex max-w-2xl items-start justify-between gap-4 rounded-lg border border-line p-3.5">
            <span>
              <span className="block text-body-m text-strong">{t('workflow.force')}</span>
              <span className="block text-body-s text-muted">{t('workflow.forceHint')}</span>
            </span>
            <Switch checked={rule.force} label={t('workflow.force')} onChange={(force) => onChange({ force })} />
          </label>
        )}
      </fieldset>

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <button className="btn-text" onClick={() => onMove(-1)} disabled={index === 0}>
          <ArrowUp size={16} /> {t('workflow.earlier')}
        </button>
        <button className="btn-text" onClick={() => onMove(1)} disabled={index === draft.automations.length - 1}>
          <ArrowDown size={16} /> {t('workflow.later')}
        </button>
        <button className="btn-text" onClick={onDuplicate}>
          <Copy size={16} /> {t('workflow.duplicate')}
        </button>
        <span className="flex-1" />
        <button className="btn-outlined text-red" onClick={() => confirm(t('workflow.removeRuleConfirm', { name: rule.name || t('workflow.ruleN', { n: index + 1 }) })) && onRemove()}>
          <Trash2 size={16} /> {t('workflow.removeRule')}
        </button>
      </div>
    </div>
  );
}

function ActionValue({ action, statuses, onChange }: { action: AutomationAction; statuses: string[]; onChange: (v: string) => void }) {
  const label = t('workflow.actionValue', { action: actionLabel(action.type) });
  switch (action.type) {
    case 'set_status': {
      const known = statuses.some((s) => lower(s) === lower(action.value));
      return (
        <>
          <Dropdown aria-label={label} value={known ? (statuses.find((s) => lower(s) === lower(action.value)) ?? '') : ''} placeholder={action.value || t('workflow.pickStatus')} options={statuses.map((s) => ({ value: s, label: s }))} onChange={onChange} />
          {action.value && !known && <p className="mt-1 text-caption text-amber">{t('workflow.unknownStatus')}</p>}
        </>
      );
    }
    case 'set_priority':
      return <Dropdown aria-label={label} value={action.value} options={PRIORITIES.map((p) => ({ value: p, label: t(`tickets.priority.${p}` as I18nKey) }))} onChange={onChange} />;
    case 'set_assignee':
      return (
        <div className="flex flex-wrap items-center gap-2">
          {action.value === '{{actor}}' ? (
            <span className="pill bg-acc-bg text-acc-hi">{t('workflow.actor')}</span>
          ) : (
            <input className="input min-w-0 flex-1" aria-label={label} value={action.value} placeholder={t('workflow.assigneePlaceholder')} onChange={(e) => onChange(e.target.value.replace(/^@/, ''))} />
          )}
          <button type="button" className={`chip ${action.value === '{{actor}}' ? 'bg-acc-bg text-acc-hi' : ''}`} aria-pressed={action.value === '{{actor}}'} onClick={() => onChange(action.value === '{{actor}}' ? '' : '{{actor}}')}>
            {t('workflow.actor')}
          </button>
        </div>
      );
    case 'comment':
      return (
        <>
          <textarea className="input min-h-[5.5rem] font-mono text-body-s" aria-label={label} value={action.value} placeholder={t('workflow.commentPlaceholder')} onChange={(e) => onChange(e.target.value)} />
          <p className="mt-1 text-caption text-muted">{t('workflow.placeholders')}</p>
        </>
      );
    default:
      return <input className="input" aria-label={label} value={action.value} placeholder={t('workflow.labelPlaceholder')} onChange={(e) => onChange(e.target.value)} />;
  }
}

// ------------------------------------------------------------------ git (webhooks)

function CopyField({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <label className="block text-label-l text-muted">
      {label}
      <span className="mt-1 flex gap-2">
        <input className={`input min-w-0 flex-1 font-mono text-body-s ${secret ? 'tracking-tight' : ''}`} readOnly value={value} onFocus={(e) => e.target.select()} />
        <button
          type="button"
          className="btn-outlined shrink-0"
          onClick={() =>
            void copyText(value).then((ok) => {
              if (!ok) return;
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? t('workflow.copied') : t('workflow.copy')}
        </button>
      </span>
    </label>
  );
}

function GitSection({ project, draft, onAutomations }: { project: ProjectInfo; draft: Draft; onAutomations: () => void }) {
  const [hooks, setHooks] = useState<TicketHook[] | null>(null);
  const [provider, setProvider] = useState<TicketHookProvider>('gitlab');
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{ hook: TicketHook; secret: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const gitRules = draft.automations.filter((a) => a.enabled && isGitTrigger(a.trigger));
  const standalone = vault.standalone;

  useEffect(() => {
    if (standalone) return;
    listTicketHooks(project).then(setHooks, (err) => setError((err as Error).message));
  }, [project, standalone]);

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await createTicketHook(project, provider, name);
      setCreated(result);
      setHooks((h) => [...(h ?? []), result.hook]);
      setName('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const steps = (p: TicketHookProvider) => (p === 'gitlab' ? [t('workflow.gitlabStep1'), t('workflow.gitlabStep2'), t('workflow.gitlabStep3')] : [t('workflow.githubStep1'), t('workflow.githubStep2'), t('workflow.githubStep3')]);

  return (
    <div className="space-y-6">
      <SectionHead title={t('workflow.secGit')}>{t('workflow.gitHint', { key: cleanProjectKey(draft.key) ?? draft.key })}</SectionHead>

      {!standalone && (
        <p className="max-w-3xl text-body-s text-muted">
          <a
            href="/settings/webhooks"
            className="text-acc underline-offset-2 hover:underline"
            onClick={(e) => {
              e.preventDefault();
              navigate('/settings/webhooks');
            }}
          >
            {t('workflow.centralHint')}
          </a>
        </p>
      )}

      {!gitRules.length && (
        <div className="flex max-w-3xl items-start gap-2 rounded-lg border border-line px-3.5 py-2.5 text-body-s text-muted">
          <Info size={16} className="mt-0.5 shrink-0 text-acc" />
          <span>
            {t('workflow.noGitRules')}{' '}
            <button type="button" className="text-acc underline-offset-2 hover:underline" onClick={onAutomations}>
              {t('workflow.toAutomations')}
            </button>
          </span>
        </div>
      )}

      {standalone ? (
        <p className="max-w-3xl text-body-m text-muted">{t('workflow.gitStandalone')}</p>
      ) : (
        <div className="grid gap-6 xl:grid-cols-2">
          <section className="space-y-3" aria-label={t('workflow.hooks')}>
            <h4 className="section-label">{t('workflow.hooks')}</h4>
            {hooks === null && !error && (
              <p className="flex items-center gap-2 text-body-s text-muted">
                <Loader2 size={16} className="animate-spin" /> {t('common.loading')}
              </p>
            )}
            {hooks?.length === 0 && <p className="text-body-s text-muted">{t('workflow.noHooks')}</p>}
            <ul className="space-y-2" data-hook-list>
              {hooks?.map((h) => (
                <li key={h.id} className="card space-y-2 p-3.5">
                  <div className="flex items-center gap-2">
                    <span className="pill bg-raised text-strong">{h.provider === 'gitlab' ? 'GitLab' : 'GitHub'}</span>
                    <span className="min-w-0 flex-1 truncate font-medium text-strong">{h.name}</span>
                    <button
                      className="btn-icon text-red"
                      aria-label={t('workflow.removeHook', { name: h.name })}
                      title={t('workflow.removeHook', { name: h.name })}
                      onClick={() => {
                        if (!confirm(t('workflow.removeHookConfirm', { name: h.name }))) return;
                        removeTicketHook(project, h.id).then(setHooks, (err) => setError((err as Error).message));
                        if (created?.hook.id === h.id) setCreated(null);
                      }}
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                  <p className="truncate font-mono text-caption text-muted" title={h.url}>
                    {h.url}
                  </p>
                  <p className="text-caption text-muted">
                    {t('workflow.hookBy', { name: h.createdBy || '–', date: formatDateTime(h.createdAt) })}
                  </p>
                  {h.last ? (
                    <p className={`flex items-start gap-1.5 text-body-s ${h.last.ok ? 'text-green' : 'text-red'}`}>
                      {h.last.ok ? <Check size={16} className="mt-0.5 shrink-0" /> : <AlertTriangle size={16} className="mt-0.5 shrink-0" />}
                      <span>
                        <span className="font-mono text-caption">{formatDateTime(h.last.at)}</span> · {h.last.summary}
                      </span>
                    </p>
                  ) : (
                    <p className="text-caption text-muted">{t('workflow.noDelivery')}</p>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-4" aria-label={t('workflow.newHook')}>
            <h4 className="section-label">{t('workflow.newHook')}</h4>
            {created ? (
              <div className="card space-y-4 border-acc-line p-4" data-hook-created>
                <p className="flex items-start gap-2 text-body-m text-strong">
                  <Check size={18} className="mt-0.5 shrink-0 text-green" /> {t('workflow.hookCreated')}
                </p>
                <CopyField label={t('workflow.hookUrl')} value={created.hook.url} />
                <CopyField label={created.hook.provider === 'gitlab' ? t('workflow.hookTokenGitlab') : t('workflow.hookTokenGithub')} value={created.secret} secret />
                <p className="flex items-start gap-2 text-body-s text-amber">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {t('workflow.secretOnce')}
                </p>
                <ol className="list-decimal space-y-1 pl-5 text-body-s text-soft">
                  {steps(created.hook.provider).map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
                <button className="btn-text" onClick={() => setCreated(null)}>
                  {t('workflow.done')}
                </button>
              </div>
            ) : (
              <div className="card space-y-4 p-4">
                <div className="segmented" role="group" aria-label={t('workflow.provider')}>
                  {(['gitlab', 'github'] as const).map((p) => (
                    <button key={p} type="button" aria-pressed={provider === p} onClick={() => setProvider(p)}>
                      {p === 'gitlab' ? 'GitLab' : 'GitHub'}
                    </button>
                  ))}
                </div>
                <label className="block text-label-l text-muted">
                  {t('workflow.hookName')}
                  <input className="input mt-1" value={name} maxLength={80} placeholder={t('workflow.hookNamePlaceholder')} onChange={(e) => setName(e.target.value)} />
                </label>
                <ol className="list-decimal space-y-1 pl-5 text-body-s text-muted">
                  {steps(provider).map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
                <button className="btn-tonal" disabled={busy || !project.canWrite} onClick={() => void create()} data-create-hook>
                  {busy ? <Loader2 size={16} className="animate-spin" /> : <Webhook size={18} />} {t('workflow.createHook')}
                </button>
              </div>
            )}
          </section>
        </div>
      )}
      {error && <p className="text-body-s text-red">{error}</p>}
    </div>
  );
}
