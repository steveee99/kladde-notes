/**
 * Guided processes (`/processes`, part of the feature `cockpit`): the runs and models of the user's spaces, a run
 * (`/processes/run/:id`) with its current stage, the way so far and ahead, its variables, the suggested branches of
 * its repositories and a summary of everything that came together, and a model (`/processes/model/:id`) as a graph
 * with its versions. Steps are checked live through the cockpit's queries (data/processes.ts, shared/process.ts).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  activeNode,
  advanceRun,
  catchUpSteps,
  changedSteps,
  closeRun,
  conditionText,
  fillQuery,
  assignedNames,
  loopBody,
  modelVariables,
  parseScript,
  SCRIPT_FUNCTIONS,
  fillRunVars,
  markSeen,
  modelFor,
  moveToStage,
  newBranchUrl,
  newMergeRequestUrl,
  normalizeProcess,
  processProblems,
  passedStages,
  pickOption,
  predictStages,
  ProcessMoveError,
  resolveStage,
  runVars,
  safeUrl,
  setStep,
  stageOf,
  startRun,
  suggestBranch,
  type CockpitResult,
  type CockpitRow,
  type CockpitWidget,
  type ProcessAction,
  type ProcessModel,
  type ProcessRun,
  type ProcessRunNode,
  type ProcessStage,
  type ProcessStep,
} from '@kladde/shared';
import { api } from '../lib/api';
import { ScriptEditor } from './ScriptEditor';
import { useVault, vault } from '../data/vault';
import { refreshConnections, useConnections, useResults, widgetState } from '../data/cockpit';
import { createModel, createRun, deleteProcessNote, ensureExampleProcesses, loadProcesses, modelsOfSpace, queryWidget, runWidget, saveModel, saveRun, useProcesses, type ModelRef, type RunRef } from '../data/processes';
import { ArrowLeft, ArrowRight, Bell, Check, Copy, ExternalLink, FilePlus2, GitBranch, KeyRound, Merge, Pencil, Plus, RefreshCw, Repeat, Route, ScrollText, Trash2, Undo2 } from '../lib/icons';
import { copyText } from '../lib/clipboard';
import { locale, tl, useLang, type I18nKey, type Lang } from '../lib/i18n';
import { navigate } from '../lib/router';
import { isReadOnly, useReadOnly } from '../lib/readOnly';
import { showToast } from '../lib/toast';
import { PageBody, PageHeader } from './PageHeader';
import { Sheet } from './Dialogs';
import { MenuButton, type MenuAction } from './ContextMenu';
import { CockpitConnectionsView } from './CockpitConnections';
import { problemText } from './CockpitWidget';

type Key = I18nKey extends infer K ? (K extends `proc.${infer R}` ? R : never) : never;
const T = (lang: Lang, key: Key, vars?: Record<string, string | number>) => tl(lang, `proc.${key}` as I18nKey, vars);
const fail = (err: unknown, lang: Lang) => showToast(err instanceof ProcessMoveError ? T(lang, `error.${err.problem}` as Key) : (err as Error).message, 'danger');
const by = () => ({ by: vault.actorName || '', now: Date.now() });

function when(ts: number, lang: Lang): string {
  return ts ? new Intl.DateTimeFormat(locale(lang), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(ts)) : '';
}

/** A link from a run or a source, only when it is a safe web address */
function SafeLink({ href, children, className = '' }: { href: string; children: ReactNode; className?: string }) {
  const url = safeUrl(href);
  if (!url || url.startsWith('#') || url.startsWith('/')) return <span className={className}>{children}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={`text-acc hover:underline ${className}`}>
      {children}
    </a>
  );
}

const SOURCE_LABEL: Record<string, string> = { jira: 'Jira', confluence: 'Confluence', gitlab: 'GitLab', kladde: 'Kladde', web: 'Web' };

// ------------------------------------------------------------------ live step state

type LiveState = 'ok' | 'open' | 'wait' | 'problem';
interface RepoLive {
  repo: string;
  state: LiveState;
  text: string;
  url?: string;
}
interface Live {
  state: LiveState;
  text?: string;
  repos?: RepoLive[];
}

function answer(w: CockpitWidget): { rows: CockpitRow[] } | { problem: Extract<CockpitResult, { problem: string }> } | null {
  const s = widgetState(w, {});
  const r = s.result && 'rows' in s.result ? s.result : (s.lastRows ?? s.result);
  if (!r) return null;
  return 'problem' in r ? { problem: r } : { rows: r.rows };
}

function branchWidget(repo: string, branch: string): CockpitWidget {
  return queryWidget({ source: 'gitlab.branches', params: { project: repo, search: branch }, filters: [{ field: 'name', op: 'eq', value: branch }] });
}

function mrWidget(repo: string, branch: string, target: string): CockpitWidget {
  return queryWidget({ source: 'gitlab.mrs', params: { scope: 'all', project: repo, state: 'all' }, filters: [{ field: 'branch', op: 'eq', value: branch }, { field: 'target', op: 'eq', value: target }] });
}

/** The widgets a step asks (one per repository for branches and merge requests) */
function widgetsOf(step: ProcessStep, run: ProcessRun, vars: Record<string, string>): { repo?: string; widget: CockpitWidget }[] | { missing: string[] } {
  if (step.kind === 'check' && step.query) {
    const { query, missing } = fillQuery(step.query, vars);
    return missing.length ? { missing } : [{ widget: queryWidget(query) }];
  }
  if (step.kind === 'branch' || step.kind === 'mr') {
    const missing = [!run.repos.length && 'repos', !run.branch && 'branch', step.kind === 'mr' && !run.target && 'target'].filter((x): x is string => !!x);
    if (missing.length) return { missing };
    return run.repos.map((repo) => ({ repo, widget: step.kind === 'branch' ? branchWidget(repo, run.branch) : mrWidget(repo, run.branch, run.target) }));
  }
  return [];
}

function liveOf(step: ProcessStep, node: ProcessRunNode, run: ProcessRun, vars: Record<string, string>, lang: Lang): Live {
  if (step.kind === 'task') return { state: node.done.includes(step.id) ? 'ok' : 'open' };
  if (step.kind === 'link') return { state: node.vars[step.var] ? 'ok' : 'open' };
  const ws = widgetsOf(step, run, vars);
  if ('missing' in ws) return { state: 'problem', text: T(lang, 'needs', { names: ws.missing.join(', ') }) };
  if (step.kind === 'check') {
    const a = answer(ws[0].widget);
    if (!a) return { state: 'wait' };
    if ('problem' in a) return { state: 'problem', text: problemText(a.problem, lang) };
    const n = a.rows.length;
    const ok = step.expect === 'none' ? n === 0 : n > 0;
    return { state: ok ? 'ok' : 'open', text: T(lang, step.expect === 'none' ? (n ? 'checkFound' : 'checkNone') : n ? 'checkFound' : 'checkNoneYet', { n }) };
  }
  const repos: RepoLive[] = ws.map(({ repo, widget }) => {
    const a = answer(widget);
    if (!a) return { repo: repo!, state: 'wait', text: T(lang, 'checking') };
    if ('problem' in a) return { repo: repo!, state: 'problem', text: problemText(a.problem, lang) };
    const row = a.rows[0];
    if (step.kind === 'branch') return row ? { repo: repo!, state: 'ok', text: T(lang, 'branchExists'), url: row.url } : { repo: repo!, state: 'open', text: T(lang, 'branchMissing') };
    if (!row) return { repo: repo!, state: 'open', text: T(lang, 'mrMissing') };
    const st = String(row.values.state ?? '');
    const ok = step.mrState === 'merged' ? st === 'merged' : st === 'opened' || st === 'merged';
    return { repo: repo!, state: ok ? 'ok' : 'open', text: `${row.values.iid ?? ''} · ${T(lang, st === 'merged' ? 'mrMerged' : st === 'opened' ? 'mrOpened' : 'mrClosed')}`, url: row.url };
  });
  const state: LiveState = repos.some((r) => r.state === 'problem') ? 'problem' : repos.some((r) => r.state === 'wait') ? 'wait' : repos.every((r) => r.state === 'ok') ? 'ok' : 'open';
  return { state, repos };
}

/** Asks the sources of the given steps (again with `fresh`) */
function askSteps(steps: ProcessStep[], run: ProcessRun, vars: Record<string, string>, fresh = false): void {
  for (const s of steps) {
    const ws = widgetsOf(s, run, vars);
    if ('missing' in ws) continue;
    for (const { widget } of ws) void runWidget(widget, {}, fresh);
  }
}

// ------------------------------------------------------------------ small parts

function StatusIcon({ state }: { state: LiveState }) {
  if (state === 'ok')
    return (
      <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full bg-acc text-on-acc" aria-hidden>
        <Check size={14} />
      </span>
    );
  return <span className={`h-[22px] w-[22px] shrink-0 rounded-full border-[1.5px] ${state === 'wait' ? 'animate-spin border-dashed border-amber' : state === 'problem' ? 'border-red' : 'border-line2'}`} aria-hidden />;
}

function Chip({ tone = 'muted', children }: { tone?: 'muted' | 'ok' | 'amber' | 'red' | 'violet' | 'acc'; children: ReactNode }) {
  const cls = { muted: 'bg-raised text-muted', ok: 'bg-green-bg text-green', amber: 'bg-amber-bg text-amber-hi', red: 'bg-red-bg text-red', violet: 'bg-violet-bg text-violet', acc: 'bg-acc-bg text-acc-hi' }[tone];
  return <span className={`pill whitespace-nowrap ${cls}`}>{children}</span>;
}

const Mono = ({ children, className = '' }: { children: ReactNode; className?: string }) => <span className={`font-mono text-[11.5px] tabular-nums ${className}`}>{children}</span>;

function VarName({ name, sub }: { name: string; sub?: boolean }) {
  return <Mono className={`whitespace-nowrap rounded px-1.5 ${sub ? 'bg-violet-bg text-violet' : 'bg-acc-bg text-acc-hi'}`}>{`${sub ? 'sub' : 'run'}.${name}`}</Mono>;
}

const STEP_KIND: Record<ProcessStep['kind'], Key> = { task: 'kind.task', link: 'kind.link', check: 'kind.check', branch: 'kind.branch', mr: 'kind.mr' };

// ------------------------------------------------------------------ a step

function StepRow({ step, node, run, vars, models, canEdit, onRun, nested }: {
  step: ProcessStep;
  node: ProcessRunNode;
  run: ProcessRun;
  vars: Record<string, string>;
  models: Map<string, ProcessModel>;
  canEdit: boolean;
  onRun: (next: ProcessRun) => void;
  nested: boolean;
}) {
  const lang = useLang();
  useResults();
  const live = liveOf(step, node, run, vars, lang);
  const [draft, setDraft] = useState('');
  const { connections } = useConnections();
  const gitlabUrl = connections?.gitlab?.url ?? '';
  const set = (done: boolean, value?: string) => onRun(setStep(run, models, step.id, { done, value }));
  const isNew = step.since > node.started;
  let body: ReactNode;
  if (step.kind === 'task') {
    body = (
      <label className="mt-2 flex items-center gap-2.5 text-body-m text-body">
        <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--acc))]" checked={live.state === 'ok'} disabled={!canEdit} onChange={(e) => set(e.target.checked)} data-process-task={step.id} />
        {T(lang, 'taskDone')}
      </label>
    );
  } else if (step.kind === 'link') {
    const value = node.vars[step.var];
    const create = step.createUrl ? safeUrl(fillRunVars(step.createUrl, vars)) : null;
    body = value ? (
      <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-line bg-bg px-2.5 py-2">
        <SafeLink href={value} className="min-w-0 flex-1 break-all text-body-m">
          {value}
        </SafeLink>
        <Chip>{SOURCE_LABEL[step.source]}</Chip>
        {canEdit && (
          <button type="button" className="btn-text !h-7 !px-2" onClick={() => (setDraft(value), set(false))}>
            {T(lang, 'change')}
          </button>
        )}
      </div>
    ) : canEdit ? (
      <form
        className="mt-2 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!safeUrl(draft.trim())) return showToast(T(lang, 'linkInvalid'), 'danger');
          set(true, draft.trim());
          setDraft('');
        }}
      >
        {create && (
          <a className="btn-outlined !h-8" href={create} target="_blank" rel="noopener noreferrer">
            {T(lang, 'createIn', { source: SOURCE_LABEL[step.source] })} <ExternalLink size={14} />
          </a>
        )}
        <input className="input !h-8 min-w-[12rem] flex-1 font-mono text-[12px]" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={T(lang, 'linkPlaceholder', { source: SOURCE_LABEL[step.source] })} aria-label={T(lang, 'linkFor', { label: step.label })} data-process-link={step.id} />
        <button type="submit" className="btn-tonal !h-8" disabled={!draft.trim()}>
          {T(lang, 'link')}
        </button>
      </form>
    ) : (
      <p className="mt-1 text-body-s text-faint">{T(lang, 'notSet')}</p>
    );
    body = (
      <>
        {body}
        <p className="mt-1.5 text-body-s text-faint">
          {T(lang, 'savesIn')} <VarName name={step.var} sub={nested} />
        </p>
      </>
    );
  } else if (step.kind === 'check') {
    body = (
      <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-line bg-bg px-2.5 py-2">
        <Chip tone={live.state === 'ok' ? 'ok' : live.state === 'wait' ? 'amber' : live.state === 'problem' ? 'red' : 'muted'}>{T(lang, `live.${live.state}` as Key)}</Chip>
        <span className="min-w-0 flex-1 text-body-s text-muted">{live.text}</span>
        <Chip>{step.query?.source.startsWith('jira') ? 'Jira' : 'GitLab'} · live</Chip>
      </div>
    );
  } else {
    body = (
      <ul className="mt-2 divide-y divide-line rounded-md border border-line bg-bg">
        {live.repos?.map((r) => (
          <li key={r.repo} className="flex flex-wrap items-center gap-2 px-2.5 py-1.5">
            <Mono className="min-w-0 flex-1 break-all text-soft">{r.repo}</Mono>
            {r.url ? (
              <SafeLink href={r.url} className="text-body-s">
                {r.text}
              </SafeLink>
            ) : (
              <span className={`text-body-s ${r.state === 'problem' ? 'text-red' : 'text-muted'}`}>{r.text}</span>
            )}
            {r.state === 'open' && gitlabUrl && (
              <a
                className="btn-text !h-7 !px-2"
                href={safeUrl(step.kind === 'branch' ? newBranchUrl(gitlabUrl, r.repo, run.branch, run.target || 'main') : newMergeRequestUrl(gitlabUrl, r.repo, run.branch, run.target)) ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
              >
                {T(lang, step.kind === 'branch' ? 'createBranch' : 'openMr')} <ExternalLink size={13} />
              </a>
            )}
          </li>
        ))}
        {!live.repos && <li className="px-2.5 py-1.5 text-body-s text-red">{live.text}</li>}
      </ul>
    );
  }
  return (
    <li className="grid grid-cols-[22px_minmax(0,1fr)] gap-3 border-b border-line px-4 py-3.5 last:border-b-0" data-process-step={step.id} data-state={live.state}>
      <StatusIcon state={live.state} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-label-l ${live.state === 'ok' ? 'text-soft' : 'text-strong'}`}>{step.label}</span>
          <Chip>{T(lang, STEP_KIND[step.kind])}</Chip>
          {isNew && <Chip tone="amber">{T(lang, 'newIn', { v: step.since })}</Chip>}
        </div>
        {step.hint && <p className="mt-0.5 text-body-s text-muted">{step.hint}</p>}
        {body}
      </div>
    </li>
  );
}

// ------------------------------------------------------------------ the way (stepper across the top)

interface WayEntry {
  key: string;
  kind: 'done' | 'cur' | 'future' | 'skip' | 'open';
  stage?: ProcessStage;
  title: string;
  /** A short line below the title: the pick, why it is skipped, the end of a sub-workflow */
  note?: string;
  /** Inside a sub-workflow */
  sub: boolean;
  /** The first entry of a sub-workflow names it */
  subStart?: string;
}

/** The way of a run as one line: stages done, the current one (with a running sub-workflow inline) and the ones ahead */
function wayEntries(run: ProcessRun, models: Map<string, ProcessModel>, lang: Lang): WayEntry[] {
  const out: WayEntry[] = [];
  const walk = (node: ProcessRunNode, sub: boolean, prefix: string) => {
    const m = modelFor(node, models);
    if (!m) return;
    const startAt = out.length;
    node.hist.forEach((h, i) => {
      const st = stageOf(m, h.stage);
      const cond = st?.when ? conditionText(st.when, lang) : '';
      const note = h.skipped
        ? T(lang, 'skippedBecause', { cond })
        : h.pick
          ? (st?.options.find((o) => o.value === h.pick)?.label ?? h.pick)
          : h.subEnd
            ? T(lang, 'subEnded', { end: h.subEnd })
            : h.back
              ? `↩ ${T(lang, 'wentBack')}`
              : h.forced
                ? T(lang, 'forced')
                : h.round
                  ? `↻ ${T(lang, 'round', { n: h.round })}`
                  : h.rounds !== undefined
                    ? T(lang, 'loopDone', { n: h.rounds })
                    : undefined;
      out.push({ key: `${prefix}h${i}`, kind: h.skipped ? 'skip' : 'done', stage: st, title: st?.title ?? h.stage, note, sub });
    });
    if (node.state === 'running') {
      const st = stageOf(m, node.stage);
      out.push({ key: `${prefix}cur`, kind: 'cur', stage: st, title: st?.title ?? node.stage, sub });
      if (node.child && st?.kind === 'sub') walk(node.child, true, `${prefix}c`);
      predictStages(m, node, runVars(run, node)).forEach((p, i) => {
        if ('open' in p) out.push({ key: `${prefix}p${i}`, kind: 'open', title: T(lang, p.open === 'choice' ? 'dependsOnChoice' : 'dependsOnSub'), sub });
        else {
          const ps = stageOf(m, p.id);
          const cond = ps?.when ? conditionText(ps.when, lang) : '';
          out.push({ key: `${prefix}p${i}`, kind: p.skipped ? 'skip' : 'future', stage: ps, title: ps?.title ?? p.id, note: p.skipped ? T(lang, 'skippedBecause', { cond }) : p.maybe ? T(lang, 'onlyIf', { cond }) : p.loop ? `↻ ${T(lang, 'nextRound')}` : undefined, sub });
        }
      });
    }
    if (sub && out[startAt]) out[startAt].subStart = m.title;
  };
  walk(run, false, '');
  return out;
}

function Stepper({ run, models }: { run: ProcessRun; models: Map<string, ProcessModel> }) {
  const lang = useLang();
  const entries = wayEntries(run, models, lang);
  return (
    <nav aria-label={T(lang, 'way')} className="-mx-1 overflow-x-auto pb-1" data-process-way>
      <ol className="flex min-w-max items-start px-1">
        {entries.map((e, i) => {
          const shape = e.stage?.kind === 'choice' ? 'rounded-[4px] rotate-45 scale-[.82]' : e.stage?.kind === 'loop' ? 'rounded-[6px]' : 'rounded-full';
          const dot = {
            done: 'border-acc-line bg-acc-bg text-acc-hi',
            cur: 'border-acc bg-acc text-on-acc',
            future: 'border-line2 bg-bg text-muted',
            skip: 'border-dashed border-line2 bg-bg text-faint',
            open: 'border-dashed border-line2 bg-bg text-faint',
          }[e.kind];
          const next = entries[i + 1];
          const line = next ? (e.kind === 'done' && (next.kind === 'done' || next.kind === 'cur') ? 'border-acc-line' : 'border-dashed border-line2') : '';
          return (
            <li key={e.key} className="relative w-[8.5rem] shrink-0 pr-2" data-track={e.kind} aria-current={e.kind === 'cur' ? 'step' : undefined}>
              {e.sub && <span className={`absolute -bottom-1 left-0 right-0 border-b-2 border-violet/50 ${e.subStart ? 'left-1' : ''}`} aria-hidden />}
              <div className="flex items-center">
                <span
                  className={`relative z-[1] grid h-5 w-5 shrink-0 place-items-center border-[1.5px] text-[10px] ${shape} ${dot} ${e.stage?.kind === 'sub' ? 'outline outline-[1.5px] outline-offset-2 outline-violet/60' : ''}`}
                  aria-hidden
                >
                  <span className={e.stage?.kind === 'choice' ? '-rotate-45' : ''}>{e.kind === 'done' ? '✓' : e.kind === 'skip' ? '–' : e.kind === 'cur' ? '•' : e.kind === 'open' ? '…' : ''}</span>
                </span>
                {next && <span className={`mx-1.5 h-0 flex-1 border-t-[1.5px] ${line}`} aria-hidden />}
              </div>
              {e.subStart && <span className="mt-1 block truncate text-[11px] text-violet">↳ {e.subStart}</span>}
              <span
                className={`mt-1 block text-label-m leading-4 ${e.kind === 'skip' ? 'font-normal text-faint line-through' : e.kind === 'future' || e.kind === 'open' ? 'font-normal text-muted' : e.kind === 'cur' ? 'text-strong' : 'text-text'}`}
              >
                {e.title}
              </span>
              {e.note && <span className="mt-0.5 block text-[11px] leading-4 text-faint">{e.note}</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** The history with times and people, newest first; a running sub-workflow's steps are listed with it */
function HistoryList({ run, models }: { run: ProcessRun; models: Map<string, ProcessModel> }) {
  const lang = useLang();
  const rows: { at: number; by: string; title: string; note: string; sub: string }[] = [];
  const collect = (node: ProcessRunNode, sub: string) => {
    const m = modelFor(node, models);
    if (!m) return;
    let child = 0;
    for (const h of node.hist) {
      if (h.skipped) continue;
      const st = stageOf(m, h.stage);
      const pick = h.pick ? (st?.options.find((o) => o.value === h.pick)?.label ?? h.pick) : '';
      const note = [pick && `→ ${pick}`, h.subEnd && T(lang, 'subEnded', { end: h.subEnd }), h.back && `↩ ${T(lang, 'wentBack')}`, h.forced && T(lang, 'forced'), h.round && `↻ ${T(lang, 'round', { n: h.round })}`, h.rounds !== undefined && T(lang, 'loopDone', { n: h.rounds })].filter(Boolean).join(' · ');
      rows.push({ at: h.at, by: h.by, title: st?.title ?? h.stage, note, sub });
      if (h.subEnd && node.children[child]) collect(node.children[child++], modelFor(node.children[child - 1], models)?.title ?? '');
    }
    if (node.child) collect(node.child, modelFor(node.child, models)?.title ?? '');
  };
  collect(run, '');
  if (!rows.length) return null;
  rows.sort((a, b) => b.at - a.at);
  return (
    <section aria-labelledby="proc-history" className="pt-2">
      <h3 id="proc-history" className="mb-2 font-display text-[17px] text-strong">
        {T(lang, 'history')}
      </h3>
      <ul className="divide-y divide-line border-y border-line text-body-m">
        {rows.map((r, i) => (
          <li key={i} className="grid grid-cols-[7rem_minmax(0,1fr)_auto] items-baseline gap-3 py-1.5 phone:grid-cols-[minmax(0,1fr)_auto]">
            <Mono className="text-muted phone:col-span-2">{when(r.at, lang)}</Mono>
            <span className="min-w-0">
              {r.sub && <span className="mr-1.5 text-body-s text-violet">↳ {r.sub}</span>}
              {r.title}
              {r.note && <span className="ml-1.5 text-body-s text-muted">{r.note}</span>}
            </span>
            <span className="text-body-s text-muted">{r.by}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------------ the current stage

function StageCard({ run, node, model, models, canEdit, onRun, nested }: {
  run: ProcessRun;
  node: ProcessRunNode;
  model: ProcessModel;
  models: Map<string, ProcessModel>;
  canEdit: boolean;
  onRun: (next: ProcessRun) => void;
  nested: boolean;
}) {
  const lang = useLang();
  useResults();
  const vars = runVars(run, node);
  const st = stageOf(model, node.stage);
  const [target, setTarget] = useState('');
  useEffect(() => {
    if (st) askSteps(st.steps, run, vars);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st?.id, run.branch, run.target, run.repos.join(','), JSON.stringify(vars)]);
  if (!st) {
    return (
      <section className="card p-4" data-process-missing-stage>
        <h2 className="text-title-m">{T(lang, 'stageGone', { id: node.stage })}</h2>
        <p className="mt-1 text-body-m text-muted">{T(lang, 'stageGoneHint')}</p>
        {canEdit && (
          <div className="mt-3 flex flex-wrap gap-2">
            <select className="input !h-9 w-auto" value={target} onChange={(e) => setTarget(e.target.value)} aria-label={T(lang, 'stage')}>
              <option value="">{T(lang, 'pickStage')}</option>
              {model.stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
            <button type="button" className="btn-primary" disabled={!target} onClick={() => (target ? onRun(moveToStage(run, models, target, by())) : undefined)}>
              {T(lang, 'continueHere')}
            </button>
          </div>
        )}
      </section>
    );
  }
  const num = passedStages(node).size + 1;
  const go = (move: Parameters<typeof advanceRun>[2]) => {
    try {
      onRun(advanceRun(run, models, move, by()));
    } catch (err) {
      fail(err, lang);
    }
  };
  const lives = st.steps.map((s) => ({ s, live: liveOf(s, node, run, vars, lang) }));
  const open = lives.filter((x) => x.live.state !== 'ok').length;
  const passing = lives.filter((x) => x.live.state === 'ok' && (x.s.kind === 'check' || x.s.kind === 'branch' || x.s.kind === 'mr')).map((x) => x.s.id);
  const backs = st.next.filter((t) => t.back);
  const catchUp = catchUpSteps(model, node);
  let gate: ReactNode = null;
  if (st.kind === 'choice') {
    const picked = node.vars[st.var];
    const opt = st.options.find((o) => o.value === picked);
    const landing = opt ? resolveStage(model, { ...vars, [st.var]: opt.value }, opt.to) : null;
    gate = (
      <>
        <div className="grid gap-2.5 p-4 sm:grid-cols-[repeat(auto-fit,minmax(170px,1fr))]">
          {st.options.map((o) => {
            const land = resolveStage(model, { ...vars, [st.var]: o.value }, o.to);
            return (
              <button
                key={o.value}
                type="button"
                className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left ${picked === o.value ? 'border-acc-line bg-acc-bg' : 'border-line2 bg-bg hover:border-edge'}`}
                aria-pressed={picked === o.value}
                disabled={!canEdit}
                onClick={() => onRun(pickOption(run, models, o.value))}
                data-process-option={o.value}
              >
                <span className="text-title-s text-strong">{o.label}</span>
                {o.hint && <span className="text-body-s text-muted">{o.hint}</span>}
                <Mono className="text-acc">
                  → {stageOf(model, land.to)?.title ?? land.to}
                  {land.skipped.length ? ` · ${T(lang, 'skipCount', { n: land.skipped.length })}` : ''}
                </Mono>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2.5 rounded-b-lg border-t border-line bg-bar px-4 py-3">
          <span className={`mr-auto text-body-s ${opt ? 'text-green' : 'text-muted'}`}>
            {opt ? T(lang, 'choiceSaves', { var: `${nested ? 'sub' : 'run'}.${st.var}`, value: opt.value }) : T(lang, 'pickOne')}
            {landing?.skipped.length ? ` · ${T(lang, 'thenSkipped', { names: landing.skipped.map((s) => stageOf(model, s)?.title ?? s).join(', ') })}` : ''}
          </span>
          {canEdit && (
            <button type="button" className="btn-primary" disabled={!opt} onClick={() => go({})} data-process-next>
              {T(lang, 'goTo', { stage: landing ? (stageOf(model, landing.to)?.title ?? landing.to) : '…' })} <ArrowRight size={15} />
            </button>
          )}
        </div>
      </>
    );
  } else if (st.kind === 'end') {
    const blocked = catchUp.length > 0;
    gate = (
      <div className="flex flex-wrap items-center gap-2.5 rounded-b-lg border-t border-line bg-bar px-4 py-3">
        <span className={`mr-auto text-body-s ${blocked ? 'text-amber' : 'text-green'}`}>{blocked ? T(lang, 'catchUpFirst', { n: catchUp.length }) : T(lang, 'closeHint', { v: model.version })}</span>
        {canEdit && (
          <button type="button" className="btn-primary" disabled={blocked} onClick={() => {
            try {
              onRun(closeRun(run, models, by()));
            } catch (err) {
              fail(err, lang);
            }
          }} data-process-close>
            {T(lang, 'close')}
          </button>
        )}
      </div>
    );
  } else if (st.kind === 'steps') {
    const fwd = st.next.find((t) => !t.back);
    const landing = fwd ? resolveStage(model, vars, fwd.to) : null;
    const landStage = landing && stageOf(model, landing.to);
    gate = (
      <div className="flex flex-wrap items-center gap-2.5 rounded-b-lg border-t border-line bg-bar px-4 py-3">
        <span className={`mr-auto text-body-s ${open ? 'text-muted' : 'text-green'}`}>
          {open ? T(lang, 'openSteps', { n: open, of: st.steps.length }) : T(lang, 'allDone')}
          {landing?.skipped.length ? ` · ${T(lang, 'thenSkipped', { names: landing.skipped.map((s) => stageOf(model, s)?.title ?? s).join(', ') })}` : ''}
        </span>
        {canEdit && (
          <>
            <button type="button" className="btn-icon" title={T(lang, 'refresh')} aria-label={T(lang, 'refresh')} onClick={() => askSteps(st.steps, run, vars, true)}>
              <RefreshCw size={16} />
            </button>
            {backs.map((b) => (
              <button key={b.to} type="button" className="btn-outlined" onClick={() => go({ back: b.to })} data-process-back={b.to}>
                <Undo2 size={15} /> {b.label || T(lang, 'backTo', { stage: stageOf(model, b.to)?.title ?? b.to })}
              </button>
            ))}
            {open > 0 && landStage && (
              <button type="button" className="btn-text" title={T(lang, 'forceHint')} onClick={() => go({ forced: true, passing })} data-process-force>
                {T(lang, 'force')}
              </button>
            )}
            {landStage && (
              <button type="button" className="btn-primary" disabled={open > 0} onClick={() => go({ passing })} data-process-next>
                {nested && landStage.kind === 'end' ? T(lang, 'finishSub', { end: landStage.title }) : T(lang, 'goTo', { stage: landStage.title })} <ArrowRight size={15} />
              </button>
            )}
          </>
        )}
      </div>
    );
  }
  return (
    <section className={`rounded-lg border bg-panel ${nested ? 'border-violet/50' : 'border-line'}`} aria-label={T(lang, 'currentStage')} data-process-stage={st.id}>
      {nested && (
        <div className="flex flex-wrap items-center gap-2 rounded-t-lg border-b border-line bg-violet-bg px-4 py-2 text-body-s text-violet">
          <Route size={15} />
          <span>{T(lang, 'subHeader', { name: model.title })}</span>
          <Mono className="text-muted">v{model.version}</Mono>
        </div>
      )}
      <div className="flex flex-wrap items-start gap-3 border-b border-line px-4 py-4">
        <Mono className={`mt-1 rounded border px-1.5 ${nested ? 'border-violet/50 text-violet' : 'border-acc-line text-acc'}`}>{num}</Mono>
        <div className="min-w-[12rem] flex-1">
          <h2 className="font-display text-[20px] leading-7 text-strong">{st.title}</h2>
          {st.description && <p className="mt-1 max-w-[64ch] text-body-m text-muted">{st.description}</p>}
        </div>
        {st.when && <Chip tone="amber">{T(lang, 'appliesBecause', { cond: conditionText(st.when, lang) })}</Chip>}
        {st.onExit && (
          <span title={st.onExit}>
            <Chip>
              <ScrollText size={12} className="mr-1 inline" />
              {T(lang, 'onExit')}
            </Chip>
          </span>
        )}
      </div>
      {st.kind === 'steps' && (
        <ul>
          {st.steps.map((s) => (
            <StepRow key={s.id} step={s} node={node} run={run} vars={vars} models={models} canEdit={canEdit} onRun={onRun} nested={nested} />
          ))}
        </ul>
      )}
      {st.kind === 'sub' && <p className="px-4 py-3 text-body-m text-red">{T(lang, 'error.no_model')}</p>}
      {gate}
    </section>
  );
}

// ------------------------------------------------------------------ banners

function ChangeBanner({ run, models, canEdit, onRun }: { run: ProcessRun; models: Map<string, ProcessModel>; canEdit: boolean; onRun: (r: ProcessRun) => void }) {
  const lang = useLang();
  const rows: ReactNode[] = [];
  for (let n: ProcessRunNode | undefined = run; n; n = n.child) {
    const m = models.get(n.model);
    if (!m || n.state !== 'running') continue;
    const passed = passedStages(n);
    const skipped = new Set(n.hist.filter((h) => h.skipped).map((h) => h.stage));
    for (const { stage, step } of changedSteps(m, n)) {
      const effect = skipped.has(stage.id) ? 'effSkipped' : stage.id === n.stage ? 'effNow' : passed.has(stage.id) ? (step.retro ? 'effCatchUp' : 'effNotRetro') : 'effLater';
      rows.push(
        <li key={`${m.key}/${stage.id}/${step.id}`} className="flex flex-wrap items-baseline gap-2">
          <Mono className="text-muted">v{step.since}</Mono>
          <span>
            {T(lang, 'newStep', { label: step.label, stage: stage.title })}
            {n !== run ? ` (${m.title})` : ''}
          </span>
          <span className="text-body-s text-muted">· {T(lang, effect as Key)}</span>
        </li>
      );
    }
  }
  if (!rows.length) return null;
  const m = models.get(run.model);
  return (
    <div className="mb-3.5 rounded-lg border border-amber/40 bg-amber-bg px-4 py-3" role="status" data-process-changed>
      <div className="flex flex-wrap items-baseline gap-2.5">
        <b className="text-label-l text-amber-hi">{T(lang, 'modelChanged', { name: m?.title ?? run.model })}</b>
        <Mono className="text-muted">
          v{run.seen} → v{m?.version}
        </Mono>
        <span className="text-body-s text-muted">{T(lang, 'followsLive')}</span>
      </div>
      <ul className="mt-2 space-y-1 text-body-m">{rows}</ul>
      {canEdit && (
        <button type="button" className="btn-outlined mt-2.5 !h-8" onClick={() => onRun(markSeen(run, models))}>
          {T(lang, 'understood')}
        </button>
      )}
    </div>
  );
}

function FrozenBanner({ run, models }: { run: ProcessRun; models: Map<string, ProcessModel> }) {
  const lang = useLang();
  const live = models.get(run.model);
  const snap = run.snapshot;
  const later = live && snap && live.version > snap.version;
  return (
    <div className="mb-3.5 rounded-lg border border-violet/40 bg-violet-bg px-4 py-3" data-process-frozen>
      <div className="flex flex-wrap items-baseline gap-2.5">
        <b className="text-label-l text-violet">{T(lang, 'closedAt', { at: when(run.closedAt ?? 0, lang) })}</b>
        <Mono className="text-muted">{T(lang, 'frozenOn', { name: snap?.title ?? run.model, v: snap?.version ?? '?' })}</Mono>
      </div>
      <p className="mt-1.5 text-body-s text-muted">{later ? T(lang, 'frozenLater', { v: live.version }) : T(lang, 'frozenHint')}</p>
    </div>
  );
}

// ------------------------------------------------------------------ right column

function BranchPanel({ run, canEdit, onRun }: { run: ProcessRun; canEdit: boolean; onRun: (r: ProcessRun) => void }) {
  const lang = useLang();
  useResults();
  const { connections } = useConnections();
  const gitlabUrl = connections?.gitlab?.url ?? '';
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(run.branch);
  useEffect(() => {
    if (run.branch) for (const repo of run.repos) void runWidget(branchWidget(repo, run.branch), {});
  }, [run.branch, run.repos.join(',')]);
  const command = `git fetch origin && git switch -c ${run.branch} origin/${run.target || 'main'}`;
  return (
    <section className="space-y-2" data-process-branches>
      <p className="text-label-m text-muted">{T(lang, 'branches')}</p>
      <div className="rounded-md border border-line bg-bg p-2.5">
        <div className="flex items-center gap-2">
          <GitBranch size={15} className="text-muted" />
          {editing ? (
            <form
              className="flex min-w-0 flex-1 gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                onRun({ ...run, branch: name.trim() || run.branch });
                setEditing(false);
              }}
            >
              <input className="input !h-7 min-w-0 flex-1 font-mono text-[12px]" value={name} onChange={(e) => setName(e.target.value)} aria-label={T(lang, 'branch')} autoFocus />
              <button type="submit" className="btn-tonal !h-7 !px-2">
                {T(lang, 'save')}
              </button>
            </form>
          ) : (
            <>
              <Mono className="min-w-0 flex-1 break-all text-text">{run.branch || '–'}</Mono>
              {canEdit && run.state === 'running' && (
                <button type="button" className="btn-icon !h-7 !w-7" onClick={() => (setName(run.branch), setEditing(true))} title={T(lang, 'editBranch')} aria-label={T(lang, 'editBranch')}>
                  <Pencil size={14} />
                </button>
              )}
              <button type="button" className="btn-icon !h-7 !w-7" onClick={() => void copyText(run.branch).then(() => showToast(T(lang, 'copied')))} title={T(lang, 'copyBranch')} aria-label={T(lang, 'copyBranch')}>
                <Copy size={14} />
              </button>
            </>
          )}
        </div>
        <p className="mt-1 text-body-s text-muted">{T(lang, 'fromTarget', { target: run.target || '–' })}</p>
      </div>
      <ul className="divide-y divide-line">
        {run.repos.map((repo) => {
          const a = run.branch ? answer(branchWidget(repo, run.branch)) : null;
          const exists = a && 'rows' in a ? a.rows.length > 0 : null;
          const create = gitlabUrl && run.branch ? safeUrl(newBranchUrl(gitlabUrl, repo, run.branch, run.target || 'main')) : null;
          const mr = gitlabUrl && run.branch && run.target ? safeUrl(newMergeRequestUrl(gitlabUrl, repo, run.branch, run.target)) : null;
          return (
            <li key={repo} className="flex flex-wrap items-center gap-1.5 py-1.5" data-process-repo={repo}>
              <Mono className="min-w-0 flex-1 break-all text-soft">{repo}</Mono>
              {exists === true ? <Chip tone="ok">{T(lang, 'branchExists')}</Chip> : exists === false ? <Chip>{T(lang, 'branchMissing')}</Chip> : a && 'problem' in a ? <Chip tone="red">{T(lang, 'live.problem')}</Chip> : null}
              {exists === false && create && (
                <a className="btn-text !h-7 !px-2" href={create} target="_blank" rel="noopener noreferrer">
                  {T(lang, 'createBranch')} <ExternalLink size={13} />
                </a>
              )}
              {exists === true && mr && run.state === 'running' && (
                <a className="btn-text !h-7 !px-2" href={mr} target="_blank" rel="noopener noreferrer">
                  <Merge size={13} /> MR
                </a>
              )}
            </li>
          );
        })}
      </ul>
      {run.branch && (
        <button type="button" className="w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-left font-mono text-[11px] text-muted hover:border-line2" onClick={() => void copyText(command).then(() => showToast(T(lang, 'copied')))} title={T(lang, 'copyCommand')}>
          {command}
        </button>
      )}
      {!connections?.gitlab && <p className="text-body-s text-faint">{T(lang, 'gitlabHint')}</p>}
    </section>
  );
}

function VarsPanel({ run, models }: { run: ProcessRun; models: Map<string, ProcessModel> }) {
  const lang = useLang();
  const list = (node: ProcessRunNode, sub: boolean) => {
    const m = modelFor(node, models);
    const labels = new Map<string, string>();
    for (const st of m?.stages ?? []) {
      for (const s of st.steps) if (s.kind === 'link') labels.set(s.var, s.label);
      if (st.kind === 'choice') labels.set(st.var, st.title);
    }
    const names = [...new Set([...labels.keys(), ...Object.keys(node.vars)])];
    return names.map((k) => {
      const v = node.vars[k];
      const st = m?.stages.find((s) => s.kind === 'choice' && s.var === k);
      const shown = st ? (st.options.find((o) => o.value === v)?.label ?? v) : v;
      return (
        <li key={`${sub}${k}`} className="flex min-w-0 flex-col gap-0.5 border-b border-line py-1.5">
          <div className="flex items-center justify-between gap-2">
            <VarName name={k} sub={sub} />
            <span className="truncate text-right text-body-s text-faint">{labels.get(k) ?? ''}</span>
          </div>
          {v ? st ? <span className="text-body-s text-soft">{shown}</span> : <SafeLink href={v} className="break-all text-body-s">{v}</SafeLink> : <span className="text-body-s italic text-faint">{T(lang, 'notSet')}</span>}
        </li>
      );
    });
  };
  const child = run.child && run.child.state === 'running' ? run.child : null;
  return (
    <section data-process-vars>
      <p className="mb-1 text-label-m text-muted">{T(lang, 'variables')}</p>
      <ul>{list(run, false)}</ul>
      {child && (
        <>
          <p className="mb-1 mt-4 text-label-m text-muted">{T(lang, 'subVariables')}</p>
          <ul>{list(child, true)}</ul>
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ the graph

interface GraphNode {
  id: string;
  x: number;
  y: number;
}

const GW = 150;
const GH = 52;

/** Stages in columns by their distance from the start along the ways forward; ways back are drawn as arcs below */
function layout(m: ProcessModel): { nodes: Map<string, GraphNode>; width: number; height: number } {
  const level = new Map<string, number>([[m.start, 0]]);
  const queue = [m.start];
  // A loop's round comes right after the loop (next to its way out), so its stages sit next to it, not at the end
  const forward = (st: ProcessStage) => [...(st.kind === 'loop' && st.body ? [st.body] : []), ...st.options.map((o) => o.to), ...st.next.filter((t) => !t.back).map((t) => t.to)];
  while (queue.length) {
    const id = queue.shift()!;
    const st = stageOf(m, id);
    if (!st) continue;
    for (const to of forward(st)) {
      if (level.has(to)) continue;
      level.set(to, level.get(id)! + 1);
      queue.push(to);
    }
  }
  let extra = Math.max(0, ...level.values()) + 1;
  for (const st of m.stages) if (!level.has(st.id)) level.set(st.id, extra++);
  const columns = new Map<number, string[]>();
  for (const st of m.stages) {
    const l = level.get(st.id)!;
    columns.set(l, [...(columns.get(l) ?? []), st.id]);
  }
  const rows = Math.max(...[...columns.values()].map((c) => c.length));
  const height = rows * (GH + 34) + 110;
  const nodes = new Map<string, GraphNode>();
  for (const [l, ids] of columns) {
    const top = (height - 70 - ids.length * (GH + 34)) / 2 + 30;
    ids.forEach((id, i) => nodes.set(id, { id, x: 20 + l * (GW + 40), y: top + i * (GH + 34) }));
  }
  return { nodes, width: 40 + columns.size * (GW + 40), height };
}

function ProcessGraph({ model, node, vars, selected, onSelect }: { model: ProcessModel; node?: ProcessRunNode; vars?: Record<string, string>; selected: string; onSelect: (id: string) => void }) {
  const lang = useLang();
  const { nodes, width, height } = useMemo(() => layout(model), [model]);
  const done = node ? passedStages(node) : new Set<string>();
  const skipped = new Set<string>();
  if (node) {
    for (const h of node.hist) if (h.skipped) skipped.add(h.stage);
    if (node.state === 'running') for (const p of predictStages(model, node, vars ?? node.vars)) if ('id' in p && p.skipped) skipped.add(p.id);
  }
  const taken = new Set<string>();
  if (node) {
    const path = node.hist.map((h) => h.stage);
    if (node.state === 'running') path.push(node.stage);
    for (let i = 0; i < path.length - 1; i++) taken.add(`${path[i]}>${path[i + 1]}`);
  }
  const edges: { a: string; b: string; label: string; back: boolean; round?: boolean }[] = [];
  const bodies = new Map(model.stages.filter((st) => st.kind === 'loop').map((st) => [st.id, loopBody(model, st)]));
  for (const st of model.stages) {
    if (st.kind === 'loop' && st.body) edges.push({ a: st.id, b: st.body, label: T(lang, 'legend.loop'), back: false });
    const seen = new Set<string>();
    for (const o of st.options) {
      if (seen.has(o.to)) continue;
      seen.add(o.to);
      const same = st.options.filter((x) => x.to === o.to);
      edges.push({ a: st.id, b: o.to, label: same.length > 1 ? T(lang, 'values', { n: same.length }) : o.label, back: false, round: bodies.get(o.to)?.has(st.id) });
    }
    for (const t of st.next) edges.push({ a: st.id, b: t.to, label: t.back ? t.label : t.end ? t.end : '', back: t.back, round: bodies.get(t.to)?.has(st.id) });
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-panel">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={T(lang, 'graphLabel', { name: model.title })} className="block">
        <defs>
          {[
            ['pa', 'rgb(var(--edge))'],
            ['pb', 'rgb(var(--amber))'],
            ['pt', 'rgb(var(--acc))'],
            ['pr', 'rgb(var(--violet))'],
          ].map(([id, fill]) => (
            <marker key={id} id={id} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0L10 5L0 10z" fill={fill} />
            </marker>
          ))}
        </defs>
        {edges.map((e, i) => {
          const a = nodes.get(e.a);
          const b = nodes.get(e.b);
          if (!a || !b) return null;
          const t = taken.has(`${e.a}>${e.b}`);
          let d: string;
          let lx: number;
          let ly: number;
          if (e.back || e.round || b.x <= a.x) {
            const x1 = a.x + GW / 2;
            const x2 = b.x + GW / 2;
            const y = Math.max(a.y, b.y) + GH;
            const depth = 26 + Math.abs(x1 - x2) / 8;
            d = `M${x1} ${a.y + GH} C ${x1} ${y + depth}, ${x2} ${y + depth}, ${x2} ${b.y + GH + 6}`;
            lx = (x1 + x2) / 2;
            ly = y + depth * 0.75 + 10;
          } else {
            const x1 = a.x + GW;
            const y1 = a.y + GH / 2;
            const x2 = b.x;
            const y2 = b.y + GH / 2;
            const mx = (x1 + x2) / 2;
            d = `M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2 - 6} ${y2}`;
            lx = mx;
            ly = y1 === y2 ? y1 - 7 : (y1 + y2) / 2 - 5;
          }
          const stroke = e.back ? 'stroke-amber' : e.round ? 'stroke-violet' : t ? 'stroke-acc' : 'stroke-edge';
          return (
            <g key={i}>
              <path d={d} fill="none" strokeWidth={t ? 1.8 : 1.4} className={stroke} strokeDasharray={e.back || e.round ? '4 4' : undefined} markerEnd={`url(#${e.back ? 'pb' : e.round ? 'pr' : t ? 'pt' : 'pa'})`} />
              {e.label && (
                <text x={lx} y={ly} textAnchor="middle" className={`font-mono text-[10.5px] ${e.back ? 'fill-amber' : 'fill-muted'}`}>
                  {e.label.length > 24 ? `${e.label.slice(0, 23)}…` : e.label}
                </text>
              )}
            </g>
          );
        })}
        {model.stages.map((st) => {
          const p = nodes.get(st.id)!;
          const cur = node?.state === 'running' && node.stage === st.id;
          const isDone = done.has(st.id) && !cur;
          const sub = st.kind === 'choice' ? T(lang, 'graph.choice', { n: st.options.length }) : st.kind === 'end' ? T(lang, 'graph.end') : st.kind === 'sub' ? T(lang, 'graph.sub', { name: st.process }) : st.kind === 'loop' ? T(lang, 'graph.loop', { n: st.max }) : T(lang, st.steps.length === 1 ? 'graph.oneStep' : 'graph.steps', { n: st.steps.length });
          const rx = st.kind === 'choice' ? 16 : st.kind === 'end' ? 26 : 6;
          const fill = isDone ? 'fill-acc-bg' : st.kind === 'end' ? 'fill-raised' : 'fill-bg';
          const stroke = selected === st.id ? 'stroke-amber' : cur ? 'stroke-acc' : isDone ? 'stroke-acc-line' : 'stroke-line2';
          return (
            <g
              key={st.id}
              role="button"
              tabIndex={0}
              aria-pressed={selected === st.id}
              className={`cursor-pointer ${skipped.has(st.id) ? 'opacity-50' : ''}`}
              onClick={() => onSelect(st.id)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect(st.id))}
              data-graph-stage={st.id}
            >
              {st.kind === 'sub' && <rect x={p.x - 4} y={p.y - 4} width={GW + 8} height={GH + 8} rx={9} fill="none" className="stroke-violet/60" strokeWidth={1.2} />}
              {st.kind === 'loop' && <rect x={p.x - 4} y={p.y - 4} width={GW + 8} height={GH + 8} rx={10} fill="none" className="stroke-violet/60" strokeWidth={1.2} strokeDasharray="4 3" />}
              {(st.onEnter || st.onExit) && (
                <text x={p.x + GW - 10} y={p.y + 16} textAnchor="end" className="fill-muted font-mono text-[10px]">
                  {'</>'}
                  <title>{T(lang, 'script')}</title>
                </text>
              )}
              <rect x={p.x} y={p.y} width={GW} height={GH} rx={rx} className={`${fill} ${stroke}`} strokeWidth={selected === st.id || cur ? 2 : 1.2} strokeDasharray={st.when ? '5 4' : undefined} />
              <text x={p.x + 12} y={p.y + 21} className="fill-text text-[12.5px] font-medium">
                {st.title.length > 19 ? `${st.title.slice(0, 18)}…` : st.title}
              </text>
              <text x={p.x + 12} y={p.y + 38} className={`font-mono text-[10.5px] ${st.kind === 'sub' || st.kind === 'loop' ? 'fill-violet' : 'fill-muted'}`}>
                {sub}
              </text>
              {st.when && (
                <text x={p.x + 4} y={p.y - 7} className="fill-amber font-mono text-[10.5px]">
                  when {conditionText(st.when, lang)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function GraphLegend() {
  const lang = useLang();
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-4 text-body-s text-muted">
      <span className="flex items-center gap-1.5">
        <i className="inline-block w-5 border-t-[1.5px] border-edge" />
        {T(lang, 'legend.way')}
      </span>
      <span className="flex items-center gap-1.5">
        <i className="inline-block w-5 border-t-2 border-acc" />
        {T(lang, 'legend.taken')}
      </span>
      <span className="flex items-center gap-1.5">
        <i className="inline-block w-5 border-t-[1.5px] border-dashed border-amber" />
        {T(lang, 'legend.back')}
      </span>
      <span className="flex items-center gap-1.5">
        <i className="inline-block h-3 w-4 rounded-[3px] border border-dashed border-line2" />
        {T(lang, 'legend.when')}
      </span>
      <span className="flex items-center gap-1.5">
        <i className="inline-block h-3 w-4 rounded-[3px] border border-line2 outline outline-1 outline-offset-2 outline-violet/60" />
        {T(lang, 'legend.sub')}
      </span>
      <span className="flex items-center gap-1.5">
        <i className="inline-block w-5 border-t-[1.5px] border-dashed border-violet" />
        {T(lang, 'legend.loop')}
      </span>
    </div>
  );
}

/** A stage's definition in words: what it holds, when it applies, where it leads */
type ScriptSlot = 'onEnter' | 'onExit';

/**
 * The scripts of a stage on the model page: shown as code, edited in the script editor only after "Add script" or
 * "Edit"; saving writes the model (its version goes up like for any other change)
 */
function StageScripts({ refModel, stage }: { refModel: ModelRef; stage: ProcessStage }) {
  const lang = useLang();
  const [slot, setSlot] = useState<ScriptSlot | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setSlot(null), [stage.id]);
  const slots: ScriptSlot[] = stage.kind === 'end' ? ['onEnter'] : ['onEnter', 'onExit'];
  const empty = slots.filter((k) => !stage[k].trim());
  const open = (k: ScriptSlot, add: boolean) => {
    setSlot(k);
    setAdding(add);
    setDraft(stage[k]);
  };
  const save = async (text: string) => {
    if (!slot) return;
    setBusy(true);
    try {
      const m: ProcessModel = JSON.parse(JSON.stringify(refModel.model));
      const st = m.stages.find((x) => x.id === stage.id);
      if (!st) return;
      st[slot] = text.trim();
      const saved = await saveModel(refModel.noteId, m);
      showToast(saved.version > refModel.model.version ? T(lang, 'savedVersion', { v: saved.version }) : T(lang, 'savedSame'));
      setSlot(null);
    } catch (err) {
      showToast((err as Error).message, 'danger');
    } finally {
      setBusy(false);
    }
  };
  if (slot) {
    const errors = parseScript(draft).errors;
    const others = refModel.model.stages.filter((x) => x.id !== stage.id).flatMap((x) => x.steps);
    const hints = {
      variables: [...new Set([...modelVariables(refModel.model), ...assignedNames(draft)])].sort(),
      steps: [...stage.steps, ...others].map((x) => ({ id: x.id, label: x.label })),
      templates: vault.templates().map((tp) => tp.label),
      people: [...new Set([vault.actorName, ...vault.peopleOf(refModel.noteId).map((p) => p.username)].filter(Boolean))],
      lang,
    };
    const choices = adding ? empty : [slot];
    return (
      <div className="space-y-2 rounded-lg border border-line bg-panel p-3" data-script-editing={slot}>
        <div className="flex flex-wrap items-center gap-2">
          <ScrollText size={15} className="text-muted" />
          {choices.length > 1 ? (
            <div className="segmented" role="radiogroup" aria-label={T(lang, 'scriptWhen')}>
              {choices.map((k) => (
                <button key={k} type="button" role="radio" aria-checked={slot === k} className={slot === k ? 'bg-acc-bg text-acc-hi' : ''} onClick={() => setSlot(k)}>
                  {T(lang, k)}
                </button>
              ))}
            </div>
          ) : (
            <span className="text-label-m text-text">{T(lang, slot)}</span>
          )}
          <span className="ml-auto text-body-s text-faint">{T(lang, 'scriptKeys')}</span>
        </div>
        <ScriptEditor key={`${stage.id}/${adding ? 'new' : slot}`} value={draft} onChange={setDraft} hints={hints} label={T(lang, 'scriptEditorLabel', { stage: stage.title, when: T(lang, slot) })} placeholderText={T(lang, 'scriptPlaceholder')} />
        <p className={`text-body-s ${errors.length ? 'text-red' : 'text-muted'}`} role={errors.length ? 'alert' : undefined} data-script-errors={errors.length}>
          {errors.length ? errors.map((e) => T(lang, 'scriptLineError', { line: e.line, message: e.message })).join(' · ') : T(lang, 'scriptOk')}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          {!adding && stage[slot] && (
            <button type="button" className="btn-text mr-auto text-red" disabled={busy} onClick={() => void save('')} data-script-remove>
              <Trash2 size={15} /> {T(lang, 'removeScript')}
            </button>
          )}
          <button type="button" className="btn-text" disabled={busy} onClick={() => setSlot(null)}>
            {T(lang, 'cancel')}
          </button>
          <button type="button" className="btn-primary" disabled={busy || errors.length > 0 || !draft.trim()} onClick={() => void save(draft)} data-script-save>
            {T(lang, 'save')}
          </button>
        </div>
      </div>
    );
  }
  return (
    <>
      {slots.map((k) =>
        stage[k] ? (
          <div key={k}>
            <div className="mb-1 flex items-center gap-2">
              <p className="text-body-s text-muted">{T(lang, k)}</p>
              <button type="button" className="btn-text ml-auto !h-7 !px-2" onClick={() => open(k, false)} data-script-edit={k}>
                <Pencil size={13} /> {T(lang, 'editScript')}
              </button>
            </div>
            <pre className="overflow-x-auto rounded-md border border-line bg-bg px-2.5 py-2 font-mono text-[11.5px] leading-5 text-soft" data-stage-script={k}>
              {stage[k]}
            </pre>
          </div>
        ) : null
      )}
      {empty.length > 0 && (
        <button type="button" className="btn-outlined !h-8" onClick={() => open(empty[0], true)} data-script-add>
          <Plus size={15} /> {T(lang, 'addScript')}
        </button>
      )}
    </>
  );
}

function StageDetails({ model, stageId, edit }: { model: ProcessModel; stageId: string; edit?: ModelRef }) {
  const lang = useLang();
  const st = stageOf(model, stageId);
  if (!st) return null;
  const title = (id: string) => stageOf(model, id)?.title ?? id;
  return (
    <div className="card space-y-2.5 p-4" data-stage-details={st.id}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-display text-[17px] text-strong">{st.title}</h3>
        <Mono className="text-faint">{st.id}</Mono>
        {st.when && <Chip tone="amber">when {conditionText(st.when, lang)}</Chip>}
      </div>
      {st.description && <p className="text-body-m text-muted">{st.description}</p>}
      {st.kind === 'steps' && (
        <ul className="space-y-1">
          {st.steps.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 text-body-m">
              <Chip>{T(lang, STEP_KIND[s.kind])}</Chip>
              <span className="text-text">{s.label}</span>
              {s.kind === 'link' && <VarName name={s.var} />}
              {s.since > 1 && <Mono className="text-amber">v{s.since}</Mono>}
              {s.retro && <Chip tone="amber">{T(lang, 'retro')}</Chip>}
            </li>
          ))}
        </ul>
      )}
      {st.kind === 'choice' && (
        <ul className="space-y-1 text-body-m">
          <li className="text-muted">
            {T(lang, 'savesIn')} <VarName name={st.var} />
          </li>
          {st.options.map((o) => (
            <li key={o.value}>
              <b className="font-medium text-text">{o.label}</b> → {title(o.to)}
            </li>
          ))}
        </ul>
      )}
      {st.kind === 'sub' && <p className="text-body-m text-violet">{T(lang, 'subCalls', { name: st.process })}</p>}
      {st.kind === 'loop' && (
        <ul className="space-y-1 text-body-m text-violet">
          <li>
            <Repeat size={14} className="mr-1 inline" />
            {T(lang, 'loopInfo', { body: title(st.body), var: `run.${st.var}`, max: st.max })}
          </li>
          {st.until && <li>{T(lang, 'loopUntil', { cond: conditionText(st.until, lang) })}</li>}
          {st.over && <li>{T(lang, 'loopOver', { var: `run.${st.over}`, item: `run.${st.var}_item` })}</li>}
        </ul>
      )}
      {edit && <StageScripts refModel={edit} stage={st} />}
      {(['onEnter', 'onExit'] as const).map((k) =>
        !edit && st[k] ? (
          <div key={k}>
            <p className="mb-1 text-body-s text-muted">{T(lang, k)}</p>
            <pre className="overflow-x-auto rounded-md border border-line bg-bg px-2.5 py-2 font-mono text-[11.5px] leading-5 text-soft" data-stage-script={k}>
              {st[k]}
            </pre>
          </div>
        ) : null
      )}
      {st.next.length > 0 && (
        <p className="text-body-s text-muted">
          {T(lang, 'leadsTo')} {st.next.map((t) => `${t.back ? '↩ ' : ''}${title(t.to)}${t.end ? ` (${t.end})` : ''}`).join(', ')}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ summary

function Summary({ run, models }: { run: ProcessRun; models: Map<string, ProcessModel> }) {
  const lang = useLang();
  const section = (node: ProcessRunNode, nested: boolean): ReactNode => {
    const m = modelFor(node, models);
    if (!m) return null;
    const links = m.stages.flatMap((st) => st.steps.filter((s) => s.kind === 'link').map((s) => ({ st, s })));
    const passed = passedStages(node);
    const ahead = new Set(node.state === 'running' ? [node.stage, ...predictStages(m, node, runVars(run, node)).flatMap((p) => ('id' in p && !p.skipped ? [p.id] : []))] : []);
    const shown = links.filter(({ st, s }) => node.vars[s.var] || passed.has(st.id) || ahead.has(st.id));
    const decisions = m.stages.filter((st) => st.kind === 'choice' && node.vars[st.var]);
    return (
      <>
        <div className="grid gap-3 sm:grid-cols-2">
          {shown.map(({ st, s }) => {
            const v = node.vars[s.var];
            return (
              <div key={s.id} className={`flex min-w-0 flex-col gap-1.5 rounded-lg border p-3 ${v ? 'border-line bg-panel' : 'border-dashed border-line'}`} data-summary-link={s.var}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <VarName name={s.var} sub={nested} />
                  <Chip>{SOURCE_LABEL[s.source]}</Chip>
                </div>
                <span className={v ? 'text-label-l text-strong' : 'text-body-m text-faint'}>{v ? s.label.replace(/ verlinken$| \(.*\)$/i, '') : T(lang, 'comesIn', { stage: st.title })}</span>
                {v && (
                  <SafeLink href={v} className="break-all font-mono text-[11.5px]">
                    {v}
                  </SafeLink>
                )}
              </div>
            );
          })}
        </div>
        {decisions.length > 0 && (
          <dl className="mt-4 grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-4 gap-y-1 text-body-m">
            {decisions.map((st) => (
              <div key={st.id} className="contents">
                <dt className="text-muted">{st.title}</dt>
                <dd>{st.options.find((o) => o.value === node.vars[st.var])?.label ?? node.vars[st.var]}</dd>
              </div>
            ))}
          </dl>
        )}
        {node.children.map((c, i) => (
          <div key={i} className="mt-5 border-l-2 border-violet/50 pl-4">
            <h3 className="font-display text-[17px] text-strong">{T(lang, 'fromSub', { name: modelFor(c, models)?.title ?? c.model })}</h3>
            <p className="mb-2 text-body-s text-muted">{T(lang, 'subEndedFrozen', { end: c.end ?? '', v: c.snapshot?.version ?? '?' })}</p>
            {section(c, true)}
          </div>
        ))}
        {node.child && node.child.state === 'running' && (
          <div className="mt-5 border-l-2 border-violet/50 pl-4">
            <h3 className="font-display text-[17px] text-strong">{T(lang, 'fromSub', { name: modelFor(node.child, models)?.title ?? node.child.model })}</h3>
            {section(node.child, true)}
          </div>
        )}
      </>
    );
  };
  return (
    <div className="max-w-[820px]" data-process-summary>
      <dl className="mb-5 grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5 border-y border-line py-3 text-body-m">
        <dt className="text-muted">{T(lang, 'ticket')}</dt>
        <dd className="font-mono">{run.ticket || '–'}</dd>
        <dt className="text-muted">{T(lang, 'target')}</dt>
        <dd className="font-mono">{run.target || '–'}</dd>
        <dt className="text-muted">{T(lang, 'branch')}</dt>
        <dd className="break-all font-mono">{run.branch || '–'}</dd>
        <dt className="text-muted">{T(lang, 'repos')}</dt>
        <dd className="break-all font-mono">{run.repos.join(', ') || '–'}</dd>
      </dl>
      <h2 className="mb-3 font-display text-[20px] text-strong">{T(lang, 'collected')}</h2>
      {section(run, false)}
    </div>
  );
}

// ------------------------------------------------------------------ start dialog

function StartRunSheet({ models, initial, onClose }: { models: ModelRef[]; initial?: string; onClose: () => void }) {
  const lang = useLang();
  useResults();
  const { connections } = useConnections();
  const [modelId, setModelId] = useState(initial ?? models[0]?.noteId ?? '');
  const ref = models.find((m) => m.noteId === modelId);
  const [title, setTitle] = useState('');
  const [ticket, setTicket] = useState('');
  const [repos, setRepos] = useState<string[]>([]);
  const [repoText, setRepoText] = useState('');
  const [target, setTarget] = useState('');
  const [branch, setBranch] = useState('');
  const [branchTouched, setBranchTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const connected = !!connections?.gitlab;
  const projectsWidget = useMemo(() => queryWidget({ source: 'gitlab.projects', params: { search: repoText.trim() }, filters: [] }, 30), [repoText]);
  const branchesWidget = useMemo(() => (repos[0] ? queryWidget({ source: 'gitlab.branches', params: { project: repos[0] }, filters: [] }) : null), [repos[0]]);
  useEffect(() => void refreshConnections(), []);
  useEffect(() => {
    if (!connected) return;
    const t = setTimeout(() => void runWidget(projectsWidget, {}), 250);
    return () => clearTimeout(t);
  }, [connected, projectsWidget]);
  useEffect(() => {
    if (connected && branchesWidget) void runWidget(branchesWidget, {});
  }, [connected, branchesWidget]);
  const projects = connected ? answer(projectsWidget) : null;
  const projectRows = projects && 'rows' in projects ? projects.rows : [];
  const branches = branchesWidget && connected ? answer(branchesWidget) : null;
  const branchRows = branches && 'rows' in branches ? branches.rows : [];
  // The default branch of the first repository is the suggested target
  useEffect(() => {
    if (target || !branchRows.length) return;
    const def = branchRows.find((r) => r.values.default === true);
    if (def) setTarget(String(def.values.name));
  }, [branchRows, target]);
  const suggested = ref ? suggestBranch(ref.model, { ticket, title: title || ref.model.title }) : '';
  const shownBranch = branchTouched ? branch : suggested;
  const addRepo = (r: string) => {
    const clean = r.trim().replace(/^\/+|\/+$/g, '');
    if (clean && /^[A-Za-z0-9_.][A-Za-z0-9_./-]*$/.test(clean) && !repos.includes(clean)) setRepos([...repos, clean]);
    setRepoText('');
  };
  // A repository still in the field counts as added (phone keyboards do not always send Enter)
  const pendingRepo = repoText.trim().replace(/^\/+|\/+$/g, '');
  const pendingOk = !!pendingRepo && /^[A-Za-z0-9_.][A-Za-z0-9_./-]*$/.test(pendingRepo);
  const allRepos = pendingOk && !repos.includes(pendingRepo) ? [...repos, pendingRepo] : repos;
  const submit = async () => {
    if (!ref) return;
    setBusy(true);
    try {
      const all = modelsOfSpace(ref.group);
      const run = startRun(ref.model, all, { title: title || ref.model.title, ticket, target, repos: allRepos, branch: shownBranch }, by());
      const id = await createRun(run, ref.group);
      onClose();
      navigate(`/processes/run/${encodeURIComponent(id)}`);
    } catch (err) {
      fail(err, lang);
      setBusy(false);
    }
  };
  const missing = [...(allRepos.length ? [] : [T(lang, 'missingRepos')]), ...(target.trim() ? [] : [T(lang, 'missingTarget')])];
  const ready = !!ref && missing.length === 0;
  return (
    <Sheet title={T(lang, 'startTitle')} onClose={onClose}>
      <form
        className="space-y-4 pb-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void submit();
        }}
        data-process-start
      >
        <label className="block">
          <span className="text-label-m text-muted">{T(lang, 'model')}</span>
          <select className="input mt-1 w-full" value={modelId} onChange={(e) => setModelId(e.target.value)}>
            {models.map((m) => (
              <option key={m.noteId} value={m.noteId}>
                {m.model.title}
              </option>
            ))}
          </select>
        </label>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
          <label className="block min-w-0">
            <span className="text-label-m text-muted">{T(lang, 'runTitle')}</span>
            <input className="input mt-1 w-full" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={T(lang, 'runTitlePlaceholder')} data-process-title />
          </label>
          <label className="block min-w-0">
            <span className="text-label-m text-muted">{T(lang, 'ticket')}</span>
            <input className="input mt-1 w-full font-mono" value={ticket} onChange={(e) => setTicket(e.target.value.toUpperCase())} placeholder="SHOP-412" data-process-ticket />
          </label>
        </div>
        <fieldset className="min-w-0">
          <legend className="text-label-m text-muted">{T(lang, 'reposLabel')}</legend>
          {repos.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {repos.map((r) => (
                <button key={r} type="button" className="chip bg-acc-bg font-mono text-[12px] text-acc-hi" onClick={() => setRepos(repos.filter((x) => x !== r))} title={T(lang, 'removeRepo')} data-picked-repo={r}>
                  {r} ×
                </button>
              ))}
            </div>
          )}
          <div className="mt-1.5 flex gap-1.5">
            <input
              className="input min-w-0 flex-1 font-mono text-[12px]"
              value={repoText}
              onChange={(e) => setRepoText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && repoText.trim()) {
                  e.preventDefault();
                  addRepo(repoText);
                }
              }}
              placeholder={T(lang, 'repoPlaceholder')}
              aria-label={T(lang, 'reposLabel')}
              enterKeyHint="done"
              autoCapitalize="off"
              autoCorrect="off"
              data-process-repo-input
            />
            <button type="button" className="btn-tonal shrink-0" disabled={!pendingOk} onClick={() => addRepo(repoText)} data-process-repo-add>
              <Plus size={15} /> {T(lang, 'addRepo')}
            </button>
          </div>
          {connected && projectRows.length > 0 && (
            <ul className="mt-1 max-h-40 divide-y divide-line overflow-y-auto rounded-md border border-line">
              {projectRows
                .filter((r) => !repos.includes(String(r.values.path)))
                .slice(0, 12)
                .map((r) => (
                  <li key={r.id}>
                    <button type="button" className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-line" onClick={() => addRepo(String(r.values.path))}>
                      <Plus size={14} className="text-muted" />
                      <Mono className="min-w-0 flex-1 truncate text-text">{String(r.values.path)}</Mono>
                      {r.values.defaultBranch && <Mono className="text-faint">{String(r.values.defaultBranch)}</Mono>}
                    </button>
                  </li>
                ))}
            </ul>
          )}
          {!connected && <p className="mt-1 text-body-s text-faint">{T(lang, 'repoManual')}</p>}
        </fieldset>
        <label className="block">
          <span className="text-label-m text-muted">{T(lang, 'targetLabel')}</span>
          <input className="input mt-1 w-full font-mono text-[12px]" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="main" list="process-target-branches" data-process-target />
          <datalist id="process-target-branches">
            {branchRows.map((r) => (
              <option key={r.id} value={String(r.values.name)} />
            ))}
          </datalist>
          {repos[0] && branchRows.length > 0 && <span className="mt-1 block text-body-s text-faint">{T(lang, 'targetFrom', { repo: repos[0], n: branchRows.length })}</span>}
        </label>
        <label className="block">
          <span className="text-label-m text-muted">{T(lang, 'branchLabel')}</span>
          <div className="mt-1 flex gap-1.5">
            <input
              className="input min-w-0 flex-1 font-mono text-[12px]"
              value={shownBranch}
              onChange={(e) => {
                setBranch(e.target.value);
                setBranchTouched(true);
              }}
              data-process-branch
            />
            {branchTouched && (
              <button type="button" className="btn-outlined" onClick={() => setBranchTouched(false)}>
                {T(lang, 'suggestion')}
              </button>
            )}
          </div>
          <span className="mt-1 block text-body-s text-faint">{T(lang, 'branchHint', { pattern: ref?.model.branchPattern ?? '' })}</span>
        </label>
        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          {missing.length > 0 && (
            <span className="mr-auto text-body-s text-muted" data-process-start-missing>
              {missing.join(' · ')}
            </span>
          )}
          <button type="button" className="btn-text" onClick={onClose}>
            {T(lang, 'cancel')}
          </button>
          <button type="submit" className="btn-primary" disabled={!ready || busy} data-process-start-submit>
            {T(lang, 'start')}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

// ------------------------------------------------------------------ model editing

function ModelEditorSheet({ ref_, onClose }: { ref_: ModelRef; onClose: () => void }) {
  const lang = useLang();
  const [text, setText] = useState(() => JSON.stringify(ref_.model, null, 2));
  const [error, setError] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const save = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setError(T(lang, 'jsonInvalid', { detail: (err as Error).message }));
      return;
    }
    const m = normalizeProcess(parsed);
    if (!m) return setError(T(lang, 'modelInvalid'));
    // The same check as for assistants (MCP process_save): what would be dropped is shown once before saving
    const found = processProblems(parsed, new Set([...modelsOfSpace(ref_.group).keys(), m.key]));
    if (found.length && found.join('\n') !== problems.join('\n')) {
      setProblems(found);
      return;
    }
    try {
      const saved = await saveModel(ref_.noteId, m);
      showToast(saved.version > ref_.model.version ? T(lang, 'savedVersion', { v: saved.version }) : T(lang, 'savedSame'));
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Sheet title={T(lang, 'editModel')} onClose={onClose}>
      <p className="mb-2 text-body-s text-muted">{T(lang, 'editHint')}</p>
      <details className="mb-2 rounded-md border border-line bg-bg px-3 py-2 text-body-s text-muted" data-process-script-help>
        <summary className="cursor-pointer text-label-m text-text">
          {T(lang, 'script')} · {T(lang, 'legend.loop')}
        </summary>
        <p className="mt-2">{T(lang, 'scriptHelp')}</p>
        <ul className="mt-1 space-y-0.5">
          {SCRIPT_FUNCTIONS.map((f) => (
            <li key={f.name}>
              <Mono className="text-soft">
                {f.name}
                {f.args}
              </Mono>{' '}
              – {lang === 'de' ? f.de : f.en}
            </li>
          ))}
        </ul>
        <p className="mt-1.5">{T(lang, 'scriptHelpMore')}</p>
        <p className="mt-1.5">{T(lang, 'loopHelp')}</p>
      </details>
      <textarea className="input h-[55vh] w-full resize-y font-mono text-[11.5px] leading-5" value={text} onChange={(e) => (setText(e.target.value), setError(''), setProblems([]))} spellCheck={false} aria-label={T(lang, 'editModel')} data-process-json />
      {error && <p className="mt-2 text-body-s text-red">{error}</p>}
      {problems.length > 0 && (
        <div className="mt-2 rounded-md border border-amber/40 bg-amber-bg px-3 py-2 text-body-s text-amber-hi" role="alert" data-process-problems>
          <p>{T(lang, 'problemsHint')}</p>
          <ul className="mt-1 list-disc pl-4">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex justify-end gap-2 py-3">
        <button type="button" className="btn-text" onClick={onClose}>
          {T(lang, 'cancel')}
        </button>
        <button type="button" className="btn-primary" onClick={() => void save()} data-process-json-save>
          {problems.length ? T(lang, 'saveAnyway') : T(lang, 'save')}
        </button>
      </div>
    </Sheet>
  );
}

const blankModel = (lang: Lang): ProcessModel =>
  normalizeProcess({
    title: T(lang, 'newModelTitle'),
    stages: [
      { id: 'start', title: T(lang, 'newModelStart'), steps: [{ id: 's1', kind: 'task', label: T(lang, 'newModelTask') }], next: [{ to: 'ende' }] },
      { id: 'ende', kind: 'end', title: T(lang, 'newModelEnd'), end: 'fertig' },
    ],
  })!;

// ------------------------------------------------------------------ pages

function ConnectionsSheet({ onClose }: { onClose: () => void }) {
  const lang = useLang();
  return (
    <Sheet title={tl(lang, 'cockpit.connections')} onClose={onClose}>
      <CockpitConnectionsView />
    </Sheet>
  );
}

function RunRow({ r, models }: { r: RunRef; models: Map<string, ProcessModel> }) {
  const node = activeNode(r.run);
  const m = modelFor(node, models);
  const st = m && stageOf(m, node.stage);
  return (
    <li>
      <button type="button" className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5 text-left hover:bg-line/60" onClick={() => navigate(`/processes/run/${encodeURIComponent(r.noteId)}`)} data-run-row={r.noteId}>
        <span className={`h-2 w-2 shrink-0 rounded-full ${r.run.state === 'done' ? 'bg-faint' : node !== r.run ? 'bg-violet' : 'bg-acc'}`} aria-hidden />
        {r.run.ticket && <Mono className="text-muted">{r.run.ticket}</Mono>}
        <span className="min-w-0 flex-1 truncate text-label-l text-text">{r.run.title}</span>
        <span className="text-body-s text-muted">{models.get(r.run.model)?.title ?? r.run.snapshot?.title ?? r.run.model}</span>
        {r.run.state === 'done' ? <Chip tone="violet">v{r.run.snapshot?.version}</Chip> : <Chip tone={node !== r.run ? 'violet' : 'acc'}>{st?.title ?? node.stage}</Chip>}
      </button>
    </li>
  );
}

function Overview({ models, runs }: { models: ModelRef[]; runs: RunRef[] }) {
  const lang = useLang();
  const readOnly = useReadOnly();
  const [start, setStart] = useState<string | null>(null);
  const running = runs.filter((r) => r.run.state === 'running').sort((a, b) => b.updatedAt - a.updatedAt);
  const finished = runs.filter((r) => r.run.state === 'done').sort((a, b) => (b.run.closedAt ?? 0) - (a.run.closedAt ?? 0));
  const own = modelsOfSpace(undefined);
  const spaceModels = (r: RunRef) => (r.group ? modelsOfSpace(r.group) : own);
  const newModel = async () => {
    try {
      const id = await createModel(blankModel(lang));
      navigate(`/processes/model/${encodeURIComponent(id)}?edit=1`);
    } catch (err) {
      fail(err, lang);
    }
  };
  return (
    <>
      <PageHeader
        title={T(lang, 'title')}
        subtitle={T(lang, 'subtitle')}
        actions={
          !readOnly && (
            <>
              <button type="button" className="btn-outlined" onClick={() => void newModel()} data-process-new-model>
                <Plus size={16} /> {T(lang, 'newModel')}
              </button>
              <button type="button" className="btn-primary" disabled={!models.length} onClick={() => setStart(models[0]?.noteId ?? '')} data-process-new-run>
                <Plus size={16} /> {T(lang, 'newRun')}
              </button>
            </>
          )
        }
      />
      <PageBody className="grid gap-8 nav:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="min-w-0 space-y-6">
          <section aria-labelledby="proc-running">
            <h2 id="proc-running" className="panel-title border-b border-line px-3.5 pb-2">
              {T(lang, 'running')} <Mono className="text-muted">{running.length}</Mono>
            </h2>
            {running.length ? (
              <ul className="divide-y divide-line">{running.map((r) => <RunRow key={r.noteId} r={r} models={spaceModels(r)} />)}</ul>
            ) : (
              <p className="px-3.5 py-4 text-body-m text-muted">{T(lang, 'noRuns')}</p>
            )}
          </section>
          {finished.length > 0 && (
            <section aria-labelledby="proc-done">
              <h2 id="proc-done" className="panel-title border-b border-line px-3.5 pb-2">
                {T(lang, 'finished')} <Mono className="text-muted">{finished.length}</Mono>
              </h2>
              <ul className="divide-y divide-line">{finished.map((r) => <RunRow key={r.noteId} r={r} models={spaceModels(r)} />)}</ul>
            </section>
          )}
        </div>
        <section aria-labelledby="proc-models" className="min-w-0">
          <h2 id="proc-models" className="panel-title border-b border-line px-3.5 pb-2">
            {T(lang, 'models')}
          </h2>
          <ul className="mt-3 space-y-2.5">
            {models.map((m) => (
              <li key={m.noteId} className="card p-3.5" data-model-card={m.model.key}>
                <button type="button" className="block w-full text-left" onClick={() => navigate(`/processes/model/${encodeURIComponent(m.noteId)}`)}>
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-display text-[17px] text-strong">{m.model.title}</span>
                    <Mono className="text-muted">v{m.model.version}</Mono>
                  </span>
                  {m.model.description && <span className="mt-1 line-clamp-3 block text-body-s text-muted">{m.model.description}</span>}
                  <span className="mt-1.5 block text-body-s text-faint">{T(lang, 'stageCount', { n: m.model.stages.length, prefix: m.model.branchPrefix })}</span>
                </button>
                {!readOnly && m.canEdit && (
                  <button type="button" className="btn-text mt-1 !h-7 !px-0" onClick={() => setStart(m.noteId)}>
                    {T(lang, 'startThis')} <ArrowRight size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      </PageBody>
      {start !== null && <StartRunSheet models={models.filter((m) => m.canEdit)} initial={start} onClose={() => setStart(null)} />}
    </>
  );
}

function RunPage({ refRun }: { refRun: RunRef }) {
  const lang = useLang();
  const readOnly = useReadOnly();
  const [tab, setTab] = useState<'run' | 'model' | 'summary'>('run');
  const [sel, setSel] = useState('');
  const [modelTab, setModelTab] = useState<'main' | 'sub'>('main');
  const [conn, setConn] = useState(false);
  const { connections } = useConnections();
  const run = refRun.run;
  const models = modelsOfSpace(refRun.group);
  const canEdit = refRun.canEdit && !readOnly;
  const save = (next: ProcessRun) => void saveRun(refRun.noteId, next).catch((err) => fail(err, lang));
  const node = activeNode(run);
  const model = modelFor(node, models);
  const rootModel = modelFor(run, models);
  useEffect(() => void refreshConnections(), []);
  const nested = node !== run;
  const remove = async () => {
    await deleteProcessNote(refRun.noteId);
    navigate('/processes');
  };
  const actions: MenuAction[] = [
    { icon: KeyRound, label: tl(lang, 'cockpit.connections'), onSelect: () => setConn(true) },
    ...(canEdit ? [{ icon: Trash2, label: T(lang, 'deleteRun'), danger: true, onSelect: () => void remove() }] : []),
  ];
  const graphNode = modelTab === 'sub' && (run.child ?? run.children.at(-1)) ? (run.child ?? run.children.at(-1))! : run;
  const graphModel = modelFor(graphNode, models);
  const catchUp = rootModel && nested ? catchUpSteps(rootModel, run) : [];
  return (
    <>
      <PageHeader
        title={
          <>
            {run.ticket && <span className="mr-2 font-mono text-[18px] text-muted">{run.ticket}</span>}
            {run.title}
          </>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-1.5">
            {run.state === 'done' ? <Chip tone="violet">{T(lang, 'stateDone')}</Chip> : nested ? <Chip tone="violet">{T(lang, 'stateSub')}</Chip> : <Chip tone="amber">{T(lang, 'stateRunning')}</Chip>}
            <span>{T(lang, 'runMeta', { model: rootModel?.title ?? run.model, v: run.started, at: when(run.createdAt, lang), owner: run.owner || '–' })}</span>
          </span>
        }
        actions={
          <>
            <button type="button" className="btn-text" onClick={() => navigate('/processes')}>
              <ArrowLeft size={16} /> {T(lang, 'allRuns')}
            </button>
            <MenuButton actions={actions} label={T(lang, 'runActions')} />
          </>
        }
      >
        <div className="segmented mt-3 w-max max-w-full overflow-x-auto" role="tablist" aria-label={T(lang, 'view')}>
          {(['run', 'model', 'summary'] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'bg-acc-bg text-acc-hi' : ''} onClick={() => setTab(k)} data-process-tab={k}>
              {T(lang, `tab.${k}` as Key)}
            </button>
          ))}
        </div>
      </PageHeader>
      <PageBody>
        {!rootModel ? (
          <p className="card p-4 text-body-m text-red">{T(lang, 'modelMissing', { key: run.model })}</p>
        ) : tab === 'run' ? (
          <div className="space-y-5">
            <Stepper run={run} models={models} />
            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_19rem]">
              <div className="min-w-0 space-y-3.5">
                {run.state === 'done' ? <FrozenBanner run={run} models={models} /> : <ChangeBanner run={run} models={models} canEdit={canEdit} onRun={save} />}
                {catchUp.length > 0 && <CatchUp items={catchUp} node={run} run={run} models={models} canEdit={canEdit} onRun={save} />}
                {run.state === 'running' && model && (
                  <>
                    {catchUpSteps(model, node).length > 0 && <CatchUp items={catchUpSteps(model, node)} node={node} run={run} models={models} canEdit={canEdit} onRun={save} />}
                    <StageCard run={run} node={node} model={model} models={models} canEdit={canEdit} onRun={save} nested={nested} />
                  </>
                )}
                {run.state === 'running' && !model && <p className="card p-4 text-body-m text-red">{T(lang, 'modelMissing', { key: node.model })}</p>}
                {run.state === 'done' && <Summary run={run} models={models} />}
                <ActionList run={run} noteId={refRun.noteId} models={models} />
                <HistoryList run={run} models={models} />
              </div>
              <aside className="grid min-w-0 content-start gap-6 sm:grid-cols-2 xl:grid-cols-1" aria-label={T(lang, 'details')}>
                <BranchPanel run={run} canEdit={canEdit} onRun={save} />
                <div className="min-w-0 space-y-4">
                  <VarsPanel run={run} models={models} />
                  <p className="border-l-2 border-line2 pl-2.5 text-body-s text-muted">{T(lang, 'sotHint')}</p>
                  {!connections?.gitlab && (
                    <button type="button" className="btn-tonal" onClick={() => setConn(true)}>
                      <KeyRound size={15} /> {tl(lang, 'cockpit.connections')}
                    </button>
                  )}
                </div>
              </aside>
            </div>
          </div>
        ) : tab === 'model' ? (
          <div className="space-y-4">
            {(run.child || run.children.length > 0) && (
              <div className="segmented w-max" role="tablist" aria-label={T(lang, 'model')}>
                <button type="button" role="tab" aria-selected={modelTab === 'main'} className={modelTab === 'main' ? 'bg-acc-bg text-acc-hi' : ''} onClick={() => setModelTab('main')}>
                  {rootModel.title}
                </button>
                <button type="button" role="tab" aria-selected={modelTab === 'sub'} className={modelTab === 'sub' ? 'bg-acc-bg text-acc-hi' : ''} onClick={() => setModelTab('sub')}>
                  {modelFor(run.child ?? run.children.at(-1)!, models)?.title}
                </button>
              </div>
            )}
            {graphModel && (
              <>
                <p className="text-body-m text-muted">{graphNode.snapshot ? T(lang, 'graphFrozen', { v: graphNode.snapshot.version }) : T(lang, 'graphLive', { v: graphModel.version })}</p>
                <ProcessGraph model={graphModel} node={graphNode} vars={runVars(run, graphNode)} selected={sel || graphNode.stage} onSelect={setSel} />
                <GraphLegend />
                <StageDetails model={graphModel} stageId={sel || graphNode.stage} />
              </>
            )}
          </div>
        ) : (
          <Summary run={run} models={models} />
        )}
      </PageBody>
      {conn && <ConnectionsSheet onClose={() => setConn(false)} />}
    </>
  );
}

interface ActionOutcome {
  id: string;
  status: 'done' | 'skipped' | 'failed';
  detail: string;
  noteId?: string;
}

/** What the stage scripts asked for, newest first, with what the server made of it */
function ActionList({ run, noteId, models }: { run: ProcessRun; noteId: string; models: Map<string, ProcessModel> }) {
  const lang = useLang();
  const [outcomes, setOutcomes] = useState<Map<string, ActionOutcome>>(new Map());
  const ids = run.actions.map((a) => a.id).join(',');
  useEffect(() => {
    if (!run.actions.some((a) => a.kind !== 'log')) return;
    let stop = false;
    const load = () =>
      api<{ outcomes: ActionOutcome[] }>(`/process-actions/${encodeURIComponent(noteId)}`)
        .then((r) => !stop && setOutcomes(new Map(r.outcomes.map((o) => [o.id, o]))))
        .catch(() => undefined);
    void load();
    // The server carries new actions out right after the save reached it
    const again = setTimeout(load, 2500);
    return () => {
      stop = true;
      clearTimeout(again);
    };
  }, [noteId, ids]);
  if (!run.actions.length) return null;
  const stageTitle = (a: ProcessAction) => {
    for (const n of [run, ...(run.child ? [run.child] : []), ...run.children]) {
      const st = modelFor(n, models)?.stages.find((s) => s.id === a.stage);
      if (st) return st.title;
    }
    return a.stage;
  };
  const what = (a: ProcessAction) =>
    a.kind === 'notify' ? T(lang, 'act.notify', { to: a.to ?? '' }) : a.kind === 'note' ? (a.template ? T(lang, 'act.noteFrom', { path: a.path ?? '', template: a.template }) : T(lang, 'act.note', { path: a.path ?? '' })) : T(lang, a.error ? 'act.error' : 'act.log');
  return (
    <section aria-labelledby="proc-actions" className="pt-2" data-process-actions>
      <h3 id="proc-actions" className="mb-1 font-display text-[17px] text-strong">
        {T(lang, 'actions')}
      </h3>
      <p className="mb-2 text-body-s text-muted">{T(lang, 'actionsHint')}</p>
      <ul className="divide-y divide-line border-y border-line text-body-m">
        {[...run.actions].reverse().map((a) => {
          const o = outcomes.get(a.id);
          const Icon = a.kind === 'notify' ? Bell : a.kind === 'note' ? FilePlus2 : ScrollText;
          const state = a.kind === 'log' ? null : (o?.status ?? 'pending');
          const tone = state === 'done' ? 'ok' : state === 'failed' ? 'red' : state === 'skipped' ? 'muted' : 'amber';
          return (
            <li key={a.id} className="grid grid-cols-[7rem_minmax(0,1fr)_auto] items-baseline gap-3 py-1.5 phone:grid-cols-[minmax(0,1fr)_auto]" data-process-action={a.kind} data-state={state ?? 'log'}>
              <Mono className="text-muted phone:col-span-2">{when(a.at, lang)}</Mono>
              <span className="min-w-0">
                <Icon size={14} className={`mr-1.5 inline ${a.error ? 'text-red' : 'text-muted'}`} />
                <span className={a.error ? 'text-red' : ''}>{what(a)}</span>
                <span className="ml-1.5 text-body-s text-faint">
                  · {stageTitle(a)} ({T(lang, a.on === 'enter' ? 'onEnter' : 'onExit')})
                </span>
                {a.text && <span className="block break-words text-body-s text-muted">{a.text}</span>}
                {o?.detail && o.status !== 'done' && <span className="block text-body-s text-faint">{o.detail}</span>}
              </span>
              <span className="flex items-center gap-1.5">
                {o?.noteId && (
                  <button type="button" className="btn-text !h-7 !px-2" onClick={() => navigate(`/n/${encodeURIComponent(o.noteId!)}`)}>
                    {T(lang, 'act.open')}
                  </button>
                )}
                {state && <Chip tone={tone}>{T(lang, `act.${state}` as Key)}</Chip>}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CatchUp({ items, node, run, models, canEdit, onRun }: { items: { stage: ProcessStage; step: ProcessStep }[]; node: ProcessRunNode; run: ProcessRun; models: Map<string, ProcessModel>; canEdit: boolean; onRun: (r: ProcessRun) => void }) {
  const lang = useLang();
  const vars = runVars(run, node);
  useEffect(() => askSteps(items.map((i) => i.step), run, vars), [items.map((i) => i.step.id).join(',')]);
  return (
    <section className="rounded-lg border border-amber/40 bg-panel" data-process-catchup>
      <div className="border-b border-line px-4 py-3">
        <h3 className="font-display text-[17px] text-strong">{T(lang, 'catchUpTitle')}</h3>
        <p className="mt-0.5 text-body-s text-muted">{T(lang, 'catchUpHint')}</p>
      </div>
      <ul>
        {items.map(({ stage, step }) => (
          <div key={step.id}>
            <p className="px-4 pt-2.5 text-body-s text-faint">{stage.title}</p>
            <StepRow step={step} node={node} run={run} vars={vars} models={models} canEdit={canEdit} onRun={onRun} nested={node !== run} />
          </div>
        ))}
      </ul>
    </section>
  );
}

function ModelPage({ refModel, runs }: { refModel: ModelRef; runs: RunRef[] }) {
  const lang = useLang();
  const readOnly = useReadOnly();
  const [sel, setSel] = useState(refModel.model.start);
  const [edit, setEdit] = useState(() => new URLSearchParams(location.search).get('edit') === '1');
  const [start, setStart] = useState(false);
  const m = refModel.model;
  const canEdit = refModel.canEdit && !readOnly;
  const using = runs.filter((r) => (r.group ?? '') === (refModel.group ?? ''));
  const live = using.filter((r) => r.run.state === 'running' && (r.run.model === m.key || r.run.child?.model === m.key));
  const frozen = using.filter((r) => r.run.state === 'done' && r.run.model === m.key);
  const steps = m.stages.flatMap((st) => st.steps.map((s) => ({ st, s })));
  const versions = [...new Set(steps.map((x) => x.s.since))].sort((a, b) => b - a);
  const actions: MenuAction[] = canEdit
    ? [
        { icon: Pencil, label: T(lang, 'editModel'), onSelect: () => setEdit(true) },
        { icon: Trash2, label: T(lang, 'deleteModel'), danger: true, onSelect: () => void deleteProcessNote(refModel.noteId).then(() => navigate('/processes')) },
      ]
    : [];
  return (
    <>
      <PageHeader
        title={m.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-1.5">
            <Chip tone="ok">v{m.version}</Chip>
            <span>{m.description}</span>
          </span>
        }
        actions={
          <>
            <button type="button" className="btn-text" onClick={() => navigate('/processes')}>
              <ArrowLeft size={16} /> {T(lang, 'title')}
            </button>
            {canEdit && (
              <button type="button" className="btn-outlined" onClick={() => setEdit(true)} data-process-edit>
                <Pencil size={15} /> {T(lang, 'editModel')}
              </button>
            )}
            {canEdit && (
              <button type="button" className="btn-primary" onClick={() => setStart(true)}>
                <Plus size={16} /> {T(lang, 'newRun')}
              </button>
            )}
            {actions.length > 0 && <MenuButton actions={actions} label={T(lang, 'modelActions')} />}
          </>
        }
      />
      <PageBody className="space-y-4">
        <ProcessGraph model={m} selected={sel} onSelect={setSel} />
        <GraphLegend />
        <div className="grid gap-5 nav:grid-cols-2">
          <StageDetails model={m} stageId={sel} edit={canEdit ? refModel : undefined} />
          <div className="min-w-0 space-y-4">
            <section>
              <h3 className="mb-2 font-display text-[17px] text-strong">{T(lang, 'versions')}</h3>
              <ul className="divide-y divide-line border-y border-line">
                {versions.map((v) => (
                  <li key={v} className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2.5 py-2">
                    <Mono className="text-acc">v{v}</Mono>
                    <span className="text-body-s text-muted">
                      {v === 1
                        ? T(lang, 'firstVersion')
                        : steps
                            .filter((x) => x.s.since === v)
                            .map((x) => `${x.s.label} (${x.st.title})${x.s.retro ? ` · ${T(lang, 'retro')}` : ''}`)
                            .join('; ')}
                    </span>
                  </li>
                ))}
                {m.version > (versions[0] ?? 1) && (
                  <li className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2.5 py-2">
                    <Mono className="text-acc">v{m.version}</Mono>
                    <span className="text-body-s text-muted">{T(lang, 'otherChanges')}</span>
                  </li>
                )}
              </ul>
            </section>
            <section className="space-y-1.5 text-body-m">
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip tone="ok">{T(lang, 'followLive')}</Chip>
                {live.length ? live.map((r) => <button key={r.noteId} type="button" className="chip font-mono text-[12px]" onClick={() => navigate(`/processes/run/${encodeURIComponent(r.noteId)}`)}>{r.run.ticket || r.run.title}</button>) : <span className="text-body-s text-faint">{T(lang, 'none')}</span>}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip tone="violet">{T(lang, 'frozen')}</Chip>
                {frozen.length ? frozen.map((r) => <button key={r.noteId} type="button" className="chip font-mono text-[12px]" onClick={() => navigate(`/processes/run/${encodeURIComponent(r.noteId)}`)}>{`${r.run.ticket || r.run.title} · v${r.run.snapshot?.version}`}</button>) : <span className="text-body-s text-faint">{T(lang, 'none')}</span>}
              </div>
            </section>
            <p className="text-body-s text-muted">
              <GitBranch size={14} className="mr-1 inline" />
              {T(lang, 'branchPatternIs', { pattern: m.branchPattern, prefix: m.branchPrefix })}
            </p>
          </div>
        </div>
      </PageBody>
      {edit && <ModelEditorSheet ref_={refModel} onClose={() => setEdit(false)} />}
      {start && <StartRunSheet models={[refModel]} initial={refModel.noteId} onClose={() => setStart(false)} />}
    </>
  );
}

export function ProcessesView({ path }: { path: string }) {
  const lang = useLang();
  useVault();
  const { models, runs } = useProcesses();
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    void loadProcesses()
      .then(() => (isReadOnly() ? undefined : ensureExampleProcesses(lang)))
      .catch(() => {})
      .finally(() => setLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const runId = /^\/processes\/run\/([^/]+)$/.exec(path)?.[1];
  const modelId = /^\/processes\/model\/([^/]+)$/.exec(path)?.[1];
  if (runId) {
    const r = runs.find((x) => x.noteId === decodeURIComponent(runId));
    if (r) return <RunPage key={r.noteId} refRun={r} />;
  } else if (modelId) {
    const m = models.find((x) => x.noteId === decodeURIComponent(modelId));
    if (m) return <ModelPage key={m.noteId} refModel={m} runs={runs} />;
  } else return <Overview models={models} runs={runs} />;
  return (
    <>
      <PageHeader title={T(lang, 'title')} />
      <PageBody>
        <p className="text-body-m text-muted">{loaded ? T(lang, 'notFound') : T(lang, 'loading')}</p>
      </PageBody>
    </>
  );
}

