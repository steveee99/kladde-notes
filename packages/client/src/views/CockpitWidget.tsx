/**
 * One cockpit widget (dashboard tile or ```cockpit block in a note): asks the server for its rows, shows them as a
 * list, a table, a count or a board, keeps the last rows while offline and explains what is missing (a connection,
 * a variable, access). Values are text only; links go through `safeUrl`.
 */
import { useEffect, useMemo, type ReactNode } from 'react';
import {
  COCKPIT_SOURCES,
  fieldDef,
  highlightOf,
  safeUrl,
  stateLabel,
  stateOf,
  type CockpitFieldType,
  type CockpitResult,
  type CockpitRow,
  type CockpitStateIcon,
  type CockpitStateTone,
  type CockpitTone,
  type CockpitValue,
  type CockpitWidget,
} from '@kladde/shared';
import { runWidget, useResults, widgetState } from '../data/cockpit';
import { AlertTriangle, Ban, BugReport, CheckCircle2, Clock, CloudOff, ExternalLink, GitBranch, Info, Merge, RefreshCw, SwapHoriz, Ticket, Users } from '../lib/icons';
import { compareText, locale, tl, useLang, type Lang } from '../lib/i18n';

const TONE: Record<CockpitTone, string> = {
  amber: 'bg-amber-bg text-amber',
  red: 'bg-red-bg text-red',
  green: 'bg-green-bg text-green',
  accent: 'bg-acc-bg text-acc-hi',
  violet: 'bg-violet-bg text-violet',
};
const ROW_TONE: Record<CockpitTone, string> = {
  amber: 'shadow-[inset_3px_0_0_rgb(var(--amber))]',
  red: 'shadow-[inset_3px_0_0_rgb(var(--red))]',
  green: 'shadow-[inset_3px_0_0_rgb(var(--green))]',
  accent: 'shadow-[inset_3px_0_0_rgb(var(--acc))]',
  violet: 'shadow-[inset_3px_0_0_rgb(var(--violet))]',
};

/** A count tile in the color of its state */
const STATE_TILE: Record<CockpitStateTone, string> = { ...TONE, neutral: 'bg-raised text-soft' };
export const STATE_ICONS: Record<Exclude<CockpitStateIcon, 'none'>, typeof Info> = { check: CheckCircle2, warning: AlertTriangle, error: Ban, clock: Clock, info: Info };

/** States of GitLab and Jira in the colors of the design */
function stateTone(v: string): CockpitTone | null {
  const s = v.toLowerCase();
  if (/^(failed|canceled|cancelled|conflict|broken_status|blocked_status|ci_still_running_failed)$/.test(s)) return 'red';
  if (/^(success|merged|mergeable|done|closed|erledigt)$/.test(s)) return 'green';
  if (/^(running|pending|active|in progress|in arbeit|ci_still_running|checking)$/.test(s)) return 'accent';
  if (/^(not_approved|draft_status|discussions_not_resolved|need_rebase|requested_changes|review|in review)$/.test(s)) return 'amber';
  return null;
}

export function relativeTime(ms: number, lang: Lang, now = Date.now()): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  const fmt = new Intl.RelativeTimeFormat(locale(lang), { numeric: 'auto', style: 'short' });
  if (abs < 3_600_000) return fmt.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return fmt.format(Math.round(diff / 3_600_000), 'hour');
  if (abs < 30 * 86_400_000) return fmt.format(Math.round(diff / 86_400_000), 'day');
  return new Date(ms).toLocaleDateString(locale(lang), { dateStyle: 'medium' });
}

function duration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** One value as the field's type shows it */
export function FieldValue({ type, value, lang }: { type: CockpitFieldType; value: CockpitValue | undefined; lang: Lang }) {
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) return <span className="text-faint">–</span>;
  switch (type) {
    case 'date':
      return typeof value === 'number' ? (
        <time className="whitespace-nowrap font-mono text-caption text-muted" dateTime={new Date(value).toISOString()} title={new Date(value).toLocaleString(locale(lang))}>
          {relativeTime(value, lang)}
        </time>
      ) : (
        <span>{String(value)}</span>
      );
    case 'duration':
      return <span className="font-mono text-caption text-muted">{typeof value === 'number' ? duration(value) : String(value)}</span>;
    case 'bool':
      return value === true ? <span className="text-soft">{tl(lang, 'cockpit.yes')}</span> : <span className="text-faint">{tl(lang, 'cockpit.no')}</span>;
    case 'key':
      return <span className="whitespace-nowrap font-mono text-caption text-acc-hi">{String(value)}</span>;
    case 'number':
      return <span className="font-mono text-caption">{String(value)}</span>;
    case 'state': {
      const tone = stateTone(String(value));
      return <span className={`pill whitespace-nowrap ${tone ? TONE[tone] : 'bg-raised text-soft'}`}>{String(value).replace(/_/g, ' ')}</span>;
    }
    case 'labels':
      return (
        <span className="inline-flex flex-wrap gap-1">
          {(Array.isArray(value) ? value : [String(value)]).map((l) => (
            <span key={l} className="pill bg-raised text-soft">
              {l}
            </span>
          ))}
        </span>
      );
    default:
      return <span>{Array.isArray(value) ? value.join(', ') : String(value)}</span>;
  }
}

const SourceIcon = ({ w, size = 16 }: { w: CockpitWidget; size?: number }) => {
  const kind = w.source.kind;
  const Icon = kind === 'gitlab.jobs' ? BugReport : kind === 'jira.issues' ? Ticket : kind === 'gitlab.projects' ? GitBranch : kind === 'gitlab.groups' ? Users : kind === 'gitlab.compare' ? SwapHoriz : Merge;
  return <Icon size={size} />;
};

function RowLink({ row, children, className = '' }: { row: CockpitRow; children: ReactNode; className?: string }) {
  const href = row.url ? safeUrl(row.url) : '';
  if (!href) return <span className={className}>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`hover:underline ${className}`}>
      {children}
    </a>
  );
}

function ListView({ w, rows, lang }: { w: CockpitWidget; rows: CockpitRow[]; lang: Lang }) {
  const titleField = COCKPIT_SOURCES[w.source.kind].titleField;
  const rest = w.fields.filter((f) => f !== titleField);
  return (
    <ul className="divide-y divide-line" data-cockpit-rows>
      {rows.map((r) => {
        const tone = highlightOf(r, w);
        return (
          <li key={r.id} className={`flex items-start gap-3 px-3.5 py-2.5 ${tone ? ROW_TONE[tone] : ''}`} data-tone={tone ?? undefined}>
            <div className="min-w-0 flex-1">
              <RowLink row={r} className="block truncate text-body-m text-text">
                {String(r.values[titleField] ?? r.id)}
              </RowLink>
              {rest.length > 0 && (
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-body-s text-muted">
                  {rest.map((f) => {
                    const def = fieldDef(w.source.kind, f);
                    return def ? <FieldValue key={f} type={def.type} value={r.values[f]} lang={lang} /> : null;
                  })}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function TableView({ w, rows, lang }: { w: CockpitWidget; rows: CockpitRow[]; lang: Lang }) {
  const titleField = COCKPIT_SOURCES[w.source.kind].titleField;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-body-s" data-cockpit-rows>
        <thead>
          <tr className="text-left text-caption text-muted">
            {w.fields.map((f) => (
              <th key={f} scope="col" className="px-3.5 py-2 font-medium">
                {fieldDef(w.source.kind, f)?.label[lang] ?? f}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const tone = highlightOf(r, w);
            return (
              <tr key={r.id} className={`border-t border-line ${tone ? ROW_TONE[tone] : ''}`} data-tone={tone ?? undefined}>
                {w.fields.map((f) => {
                  const def = fieldDef(w.source.kind, f);
                  const cell = def ? <FieldValue type={def.type} value={r.values[f]} lang={lang} /> : null;
                  return (
                    <td key={f} className="px-3.5 py-2 align-top text-body">
                      {f === titleField || (f === w.fields[0] && def?.type === 'key') ? <RowLink row={r}>{cell}</RowLink> : cell}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BoardView({ w, rows, lang }: { w: CockpitWidget; rows: CockpitRow[]; lang: Lang }) {
  const titleField = COCKPIT_SOURCES[w.source.kind].titleField;
  const group = w.groupBy ?? 'status';
  const lanes = useMemo(() => {
    const map = new Map<string, CockpitRow[]>();
    for (const r of rows) {
      const v = r.values[group];
      const key = Array.isArray(v) ? (v[0] ?? '') : v === null || v === undefined ? '' : String(v);
      const lane = map.get(key);
      if (lane) lane.push(r);
      else map.set(key, [r]);
    }
    return [...map].sort(([a], [b]) => compareText(a, b, lang));
  }, [rows, group, lang]);
  const rest = w.fields.filter((f) => f !== titleField);
  return (
    <div className="flex gap-3 overflow-x-auto p-3" data-cockpit-rows>
      {lanes.map(([lane, items]) => (
        <div key={lane} className="flex w-60 shrink-0 flex-col gap-2">
          <div className="flex items-center gap-1.5 text-caption text-muted">
            <span className="truncate">{lane || tl(lang, 'cockpit.noValue')}</span>
            <span className="font-mono">{items.length}</span>
          </div>
          {items.map((r) => {
            const tone = highlightOf(r, w);
            return (
              <div key={r.id} className={`rounded-md border border-line bg-raised px-2.5 py-2 ${tone ? ROW_TONE[tone] : ''}`}>
                <RowLink row={r} className="block text-body-s text-text">
                  {String(r.values[titleField] ?? r.id)}
                </RowLink>
                {rest.length > 0 && (
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted">
                    {rest.map((f) => {
                      const def = fieldDef(w.source.kind, f);
                      return def ? <FieldValue key={f} type={def.type} value={r.values[f]} lang={lang} /> : null;
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** What a problem means for the user, and what to do */
function problemText(result: Extract<CockpitResult, { problem: string }>, lang: Lang): string {
  const provider = result.provider === 'jira' ? 'Jira' : 'GitLab';
  switch (result.problem) {
    case 'not_connected':
      return tl(lang, 'cockpit.problem.notConnected', { provider });
    case 'missing_var':
      return tl(lang, 'cockpit.problem.missingVar', { names: (result.missing ?? []).join(', ') });
    case 'no_access':
      return tl(lang, 'cockpit.problem.noAccess', { provider });
    case 'not_found':
      return tl(lang, 'cockpit.problem.notFound');
    case 'upstream_limit':
    case 'busy':
      return tl(lang, 'cockpit.problem.busy');
    case 'invalid':
      return result.detail && result.detail !== 'invalid' ? tl(lang, 'cockpit.problem.invalidDetail', { detail: result.detail }) : tl(lang, 'cockpit.problem.invalid');
    case 'offline':
      return tl(lang, 'cockpit.problem.offline');
    default:
      return tl(lang, 'cockpit.problem.unreachable', { provider });
  }
}

export interface WidgetCardProps {
  widget: CockpitWidget;
  vars: Record<string, string>;
  /** Minutes between automatic refreshes; 0 never */
  refreshMinutes?: number;
  /** Header actions (menu) of the dashboard */
  actions?: ReactNode;
  /** Opens the connection settings (a problem offers it) */
  onConnect?: () => void;
  /** Lets the user fill in a missing variable */
  onSetVar?: (name: string) => void;
  /** In a note: a slimmer frame */
  embedded?: boolean;
  className?: string;
}

/** A widget with its header, its rows and its state */
export function WidgetCard({ widget: w, vars, refreshMinutes = 0, actions, onConnect, onSetVar, embedded, className = '' }: WidgetCardProps) {
  const lang = useLang();
  useResults();
  const state = widgetState(w, vars);
  const key = JSON.stringify([w.source, w.filters, w.sort, w.limit, vars]);

  useEffect(() => {
    if (!state.result || 'problem' in state.result) void runWidget(w, vars);
    if (!refreshMinutes) return;
    const timer = window.setInterval(() => document.visibilityState === 'visible' && void runWidget(w, vars), refreshMinutes * 60_000);
    const online = () => void runWidget(w, vars);
    window.addEventListener('online', online);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', online);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refreshMinutes]);

  const result = state.result;
  const shown = result && 'rows' in result ? result : state.lastRows && 'rows' in state.lastRows ? state.lastRows : null;
  const problem = result && 'problem' in result ? result : null;
  const count = shown ? shown.total : null;

  let body: ReactNode;
  if (shown && w.view === 'count') {
    const st = stateOf(shown.total, w.states);
    const label = st ? stateLabel(st, shown.total) : '';
    const Icon = st && st.icon !== 'none' ? STATE_ICONS[st.icon] : null;
    body = st ? (
      <div className={`flex flex-1 items-center gap-2.5 rounded-b-lg px-3.5 py-3 ${STATE_TILE[st.tone]}`} data-cockpit-state={st.tone} data-cockpit-count={shown.total}>
        {Icon && <Icon size={26} className="shrink-0" />}
        <span className="min-w-0 flex-1 text-title-m">{label || <span className="font-mono text-[30px] leading-10">{shown.total}</span>}</span>
        {label && !st.label.includes('{{') && <span className="font-mono text-body-m opacity-80">{shown.total}</span>}
      </div>
    ) : (
      <div className="px-3.5 pb-3 pt-1">
        <span className="font-mono text-[30px] leading-10 text-strong" data-cockpit-count={shown.total}>
          {shown.total}
        </span>
      </div>
    );
  } else if (shown && shown.rows.length === 0) {
    body = <p className="px-3.5 py-4 text-body-s text-muted">{tl(lang, 'cockpit.empty')}</p>;
  } else if (shown) {
    body = w.view === 'table' ? <TableView w={w} rows={shown.rows} lang={lang} /> : w.view === 'board' ? <BoardView w={w} rows={shown.rows} lang={lang} /> : <ListView w={w} rows={shown.rows} lang={lang} />;
  } else if (!problem) {
    body = (
      <div className="px-3.5 py-4" role="status">
        <span className="sr-only">{tl(lang, 'cockpit.loading')}</span>
        <div className="h-1 overflow-hidden rounded-full bg-line">
          <div className="load-bar-run h-full w-1/3 rounded-full bg-acc" />
        </div>
      </div>
    );
  }

  const problemBox = problem && (problem.problem !== 'offline' || !shown) && (
    <div className={`flex flex-wrap items-center gap-2 px-3.5 py-3 text-body-s ${problem.problem === 'offline' ? 'text-muted' : 'text-amber'}`} role="status" data-cockpit-problem={problem.problem}>
      {problem.problem === 'offline' ? <CloudOff size={16} /> : <AlertTriangle size={16} />}
      <span className="min-w-0 flex-1">{problemText(problem, lang)}</span>
      {problem.problem === 'not_connected' && onConnect && (
        <button type="button" className="btn-text" onClick={onConnect}>
          {tl(lang, 'cockpit.connect')}
        </button>
      )}
      {problem.problem === 'missing_var' &&
        onSetVar &&
        (problem.missing ?? []).filter((n) => !n.startsWith('this.')).map((n) => (
          <button key={n} type="button" className="btn-text" onClick={() => onSetVar(n)}>
            {tl(lang, 'cockpit.setVar', { name: n })}
          </button>
        ))}
    </div>
  );

  const offline = problem?.problem === 'offline' && shown;
  return (
    <section
      className={`flex min-w-0 flex-col rounded-lg border bg-panel ${embedded ? 'border-acc-line' : 'border-line'} ${className}`}
      aria-label={w.title}
      data-cockpit-widget={w.id}
      aria-busy={state.loading}
    >
      <div className="flex items-center gap-2 border-b border-line px-3.5 py-2">
        <span className="text-muted">
          <SourceIcon w={w} />
        </span>
        <h2 className="min-w-0 flex-1 truncate text-title-s text-text">{w.title}</h2>
        {count !== null && w.view !== 'count' && <span className="font-mono text-caption text-muted">{count > (shown?.rows.length ?? 0) ? `${shown?.rows.length}/${count}` : count}</span>}
        {offline ? (
          <span className="pill bg-amber-bg text-amber">{tl(lang, 'cockpit.offlineSince', { time: state.at ? new Date(state.at).toLocaleTimeString(locale(lang), { timeStyle: 'short' }) : '–' })}</span>
        ) : (
          state.at && (
            <span className="hidden font-mono text-caption text-faint sm:inline" title={tl(lang, 'cockpit.fetchedAt')}>
              {new Date(state.at).toLocaleTimeString(locale(lang), { timeStyle: 'short' })}
            </span>
          )
        )}
        {shown && 'partial' in shown && shown.partial && (
          <span className="text-amber" title={tl(lang, 'cockpit.partial')}>
            <AlertTriangle size={14} />
          </span>
        )}
        <button
          type="button"
          className="btn-icon h-7 w-7"
          onClick={() => void runWidget(w, vars, true)}
          title={tl(lang, 'cockpit.refresh')}
          aria-label={tl(lang, 'cockpit.refreshOf', { title: w.title })}
          disabled={state.loading}
        >
          <RefreshCw size={15} className={state.loading ? 'animate-spin' : ''} />
        </button>
        {actions}
      </div>
      {problemBox}
      {body}
      {embedded && (
        <div className="flex items-center gap-1.5 border-t border-line px-3.5 py-1.5 text-caption text-faint">
          <ExternalLink size={12} />
          <span className="truncate">{COCKPIT_SOURCES[w.source.kind].label[lang]}</span>
        </div>
      )}
    </section>
  );
}
