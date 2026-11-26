/**
 * Development cockpit (opt-in feature `cockpit`): dashboards of live widgets that read GitLab and Jira with each
 * user's own access.
 *
 * Everything is modelled generically:
 * - a **source** (`COCKPIT_SOURCES`) names a provider, the parameters it takes and the fields its rows carry;
 * - a **widget** is plain data: a source with parameters, filters, a sort order, a view (list, table, count, board),
 *   the fields it shows, highlight rules and whether new rows notify;
 * - a **dashboard** is a hidden note `_dashboard-<uuid>.md` (frontmatter `type: dashboard`) at the top of a space,
 *   its widgets as JSON in a ```` ```cockpit-dashboard ```` block. It syncs like any note; the data never does.
 *
 * Rows are generic too (`CockpitRow`): an id, an optional address and values by field key. The server fetches them,
 * `applyWidget` filters, sorts and cuts them the same way on the server (and for notifications).
 *
 * Widgets travel between colleagues as JSON (`shareWidget`/`shareDashboard`, read back by `readShared`). They never
 * hold a token: parameters may use `{{var:name|fallback}}` (filled from the dashboard's variables or the note's
 * variables and properties, `{{this.key}}`) and `{{me}}` (the connected account, filled on the server).
 */
import { parseFrontmatter } from './markdown.js';
import { parseYaml, type YamlValue } from './yaml.js';

// ------------------------------------------------------------------ notes

export const DASHBOARD_TYPE = 'dashboard';
const DASHBOARD_NAME = /^_dashboard(?:-[0-9a-f][0-9a-f-]{7,})?\.md$/i;
/** Info string of the block that holds a dashboard in its note */
export const DASHBOARD_BLOCK = 'cockpit-dashboard';
/** Info string of a widget inside an ordinary note */
export const COCKPIT_BLOCK = 'cockpit';

/** File name for a new dashboard note; `id` is a random UUID */
export const dashboardFileName = (id: string): string => `_dashboard-${id}.md`;

export function isDashboardPath(path: string): boolean {
  const at = path.lastIndexOf('/') + 1;
  return path[at] === '_' && DASHBOARD_NAME.test(path.slice(at));
}

// ------------------------------------------------------------------ model

export type CockpitProvider = 'gitlab' | 'jira';
export type CockpitSourceKind = 'gitlab.mrs' | 'gitlab.jobs' | 'jira.issues';
export type CockpitValue = string | number | boolean | null | string[];
export type CockpitParamValue = string | number | boolean | string[];

/** One row of a source, the same shape for every source */
export interface CockpitRow {
  /** Stable across reads (notifications compare them) */
  id: string;
  /** Where a click leads (always passed through `safeUrl` before it reaches `href`) */
  url?: string;
  values: Record<string, CockpitValue>;
}

export type CockpitFieldType = 'text' | 'key' | 'number' | 'date' | 'duration' | 'person' | 'state' | 'labels' | 'bool';
export type Localized = { de: string; en: string };

export interface CockpitFieldDef {
  key: string;
  label: Localized;
  type: CockpitFieldType;
}

export type CockpitParamType = 'text' | 'enum' | 'bool' | 'number' | 'list';

export interface CockpitParamDef {
  key: string;
  label: Localized;
  type: CockpitParamType;
  options?: { value: string; label: Localized }[];
  default?: CockpitParamValue;
  placeholder?: string;
  hint?: Localized;
  min?: number;
  max?: number;
}

export interface CockpitSourceDef {
  kind: CockpitSourceKind;
  provider: CockpitProvider;
  label: Localized;
  description: Localized;
  params: CockpitParamDef[];
  fields: CockpitFieldDef[];
  /** Shown by a new widget */
  defaultFields: string[];
  /** The field a row's title comes from in lists and boards */
  titleField: string;
}

export type CockpitFilterOp = 'eq' | 'ne' | 'contains' | 'not_contains' | 'matches' | 'gt' | 'lt' | 'older_than' | 'newer_than' | 'empty' | 'not_empty';
export const COCKPIT_FILTER_OPS: CockpitFilterOp[] = ['eq', 'ne', 'contains', 'not_contains', 'matches', 'gt', 'lt', 'older_than', 'newer_than', 'empty', 'not_empty'];

export interface CockpitFilter {
  field: string;
  op: CockpitFilterOp;
  /** Text, number, or a span like `24h`/`3d`/`2w` for `older_than`/`newer_than` */
  value: string;
}

export type CockpitTone = 'amber' | 'red' | 'green' | 'accent' | 'violet';
export const COCKPIT_TONES: CockpitTone[] = ['amber', 'red', 'green', 'accent', 'violet'];

export interface CockpitHighlight {
  when: CockpitFilter;
  tone: CockpitTone;
}

export type CockpitView = 'list' | 'table' | 'count' | 'board';
export const COCKPIT_VIEWS: CockpitView[] = ['list', 'table', 'count', 'board'];

export interface CockpitWidget {
  id: string;
  title: string;
  source: { kind: CockpitSourceKind; params: Record<string, CockpitParamValue> };
  filters: CockpitFilter[];
  sort?: { field: string; dir: 'asc' | 'desc' };
  limit: number;
  view: CockpitView;
  fields: string[];
  /** Board: the field whose values become the columns */
  groupBy?: string;
  highlight: CockpitHighlight[];
  /** New rows (after the filters) become a notification (and a push to the devices) */
  notify: boolean;
  /** Columns of the dashboard grid it takes */
  width: 1 | 2;
}

export interface CockpitDashboard {
  title: string;
  /** Minutes between automatic refreshes while the dashboard is open */
  refreshMinutes: number;
  /** Values for `{{var:name}}` in the widgets' parameters */
  vars: Record<string, string>;
  widgets: CockpitWidget[];
}

export const COCKPIT_LIMIT = { default: 20, max: 100 };
export const COCKPIT_MAX_WIDGETS = 30;
const MAX_FILTERS = 12;
const MAX_TEXT = 500;

// ------------------------------------------------------------------ sources

const L = (de: string, en: string): Localized => ({ de, en });

const MR_FIELDS: CockpitFieldDef[] = [
  { key: 'iid', label: L('MR', 'MR'), type: 'key' },
  { key: 'title', label: L('Titel', 'Title'), type: 'text' },
  { key: 'project', label: L('Projekt', 'Project'), type: 'text' },
  { key: 'author', label: L('Autor', 'Author'), type: 'person' },
  { key: 'assignees', label: L('Zugewiesen', 'Assignees'), type: 'labels' },
  { key: 'reviewers', label: L('Reviewer', 'Reviewers'), type: 'labels' },
  { key: 'state', label: L('Zustand', 'State'), type: 'state' },
  { key: 'status', label: L('Merge-Status', 'Merge status'), type: 'state' },
  { key: 'draft', label: L('Draft', 'Draft'), type: 'bool' },
  { key: 'conflicts', label: L('Konflikte', 'Conflicts'), type: 'bool' },
  { key: 'labels', label: L('Labels', 'Labels'), type: 'labels' },
  { key: 'branch', label: L('Branch', 'Branch'), type: 'text' },
  { key: 'target', label: L('Ziel-Branch', 'Target branch'), type: 'text' },
  { key: 'jira', label: L('Jira', 'Jira'), type: 'key' },
  { key: 'comments', label: L('Kommentare', 'Comments'), type: 'number' },
  { key: 'created', label: L('Erstellt', 'Created'), type: 'date' },
  { key: 'updated', label: L('Aktualisiert', 'Updated'), type: 'date' },
];

const JOB_FIELDS: CockpitFieldDef[] = [
  { key: 'name', label: L('Job', 'Job'), type: 'text' },
  { key: 'stage', label: L('Stage', 'Stage'), type: 'text' },
  { key: 'project', label: L('Projekt', 'Project'), type: 'text' },
  { key: 'ref', label: L('Branch', 'Branch'), type: 'text' },
  { key: 'status', label: L('Status', 'Status'), type: 'state' },
  { key: 'reason', label: L('Grund', 'Reason'), type: 'text' },
  { key: 'user', label: L('Ausgelöst von', 'Triggered by'), type: 'person' },
  { key: 'commit', label: L('Commit', 'Commit'), type: 'text' },
  { key: 'pipeline', label: L('Pipeline', 'Pipeline'), type: 'key' },
  { key: 'allowFailure', label: L('Darf fehlschlagen', 'Allowed to fail'), type: 'bool' },
  { key: 'duration', label: L('Dauer', 'Duration'), type: 'duration' },
  { key: 'finished', label: L('Beendet', 'Finished'), type: 'date' },
];

const ISSUE_FIELDS: CockpitFieldDef[] = [
  { key: 'key', label: L('Key', 'Key'), type: 'key' },
  { key: 'title', label: L('Titel', 'Summary'), type: 'text' },
  { key: 'status', label: L('Status', 'Status'), type: 'state' },
  { key: 'category', label: L('Kategorie', 'Category'), type: 'state' },
  { key: 'type', label: L('Typ', 'Type'), type: 'text' },
  { key: 'priority', label: L('Priorität', 'Priority'), type: 'text' },
  { key: 'assignee', label: L('Bearbeiter', 'Assignee'), type: 'person' },
  { key: 'reporter', label: L('Melder', 'Reporter'), type: 'person' },
  { key: 'project', label: L('Projekt', 'Project'), type: 'text' },
  { key: 'parent', label: L('Übergeordnet', 'Parent'), type: 'key' },
  { key: 'labels', label: L('Labels', 'Labels'), type: 'labels' },
  { key: 'due', label: L('Fällig', 'Due'), type: 'date' },
  { key: 'created', label: L('Erstellt', 'Created'), type: 'date' },
  { key: 'updated', label: L('Aktualisiert', 'Updated'), type: 'date' },
];

export const COCKPIT_SOURCES: Record<CockpitSourceKind, CockpitSourceDef> = {
  'gitlab.mrs': {
    kind: 'gitlab.mrs',
    provider: 'gitlab',
    label: L('GitLab · Merge Requests', 'GitLab · merge requests'),
    description: L('Merge Requests von dir, für dich oder in Projekten und Gruppen', 'Merge requests by you, for you, or in projects and groups'),
    params: [
      {
        key: 'scope',
        label: L('Welche', 'Which'),
        type: 'enum',
        default: 'authored',
        options: [
          { value: 'authored', label: L('Von mir', 'By me') },
          { value: 'review_requested', label: L('Review von mir', 'My review') },
          { value: 'assigned', label: L('Mir zugewiesen', 'Assigned to me') },
          { value: 'all', label: L('Alle', 'All') },
        ],
      },
      { key: 'project', label: L('Projekt', 'Project'), type: 'text', placeholder: 'gruppe/projekt' },
      { key: 'group', label: L('Gruppe', 'Group'), type: 'text', placeholder: 'gruppe', hint: L('Ohne Projekt und Gruppe: alle, die du sehen kannst', 'Without project and group: all you can see') },
      {
        key: 'state',
        label: L('Zustand', 'State'),
        type: 'enum',
        default: 'opened',
        options: [
          { value: 'opened', label: L('Offen', 'Open') },
          { value: 'merged', label: L('Gemergt', 'Merged') },
          { value: 'closed', label: L('Geschlossen', 'Closed') },
          { value: 'all', label: L('Alle', 'All') },
        ],
      },
      {
        key: 'draft',
        label: L('Drafts', 'Drafts'),
        type: 'enum',
        default: 'any',
        options: [
          { value: 'any', label: L('Egal', 'Any') },
          { value: 'no', label: L('Keine Drafts', 'No drafts') },
          { value: 'yes', label: L('Nur Drafts', 'Only drafts') },
        ],
      },
      { key: 'labels', label: L('Labels', 'Labels'), type: 'list', placeholder: 'backend, review' },
      { key: 'search', label: L('Suche in Titel und Beschreibung', 'Search title and description'), type: 'text' },
    ],
    fields: MR_FIELDS,
    defaultFields: ['iid', 'title', 'project', 'author', 'updated'],
    titleField: 'title',
  },
  'gitlab.jobs': {
    kind: 'gitlab.jobs',
    provider: 'gitlab',
    label: L('GitLab · Fehlgeschlagene CI-Jobs', 'GitLab · failed CI jobs'),
    description: L('Jobs, deren letzter Lauf fehlgeschlagen ist, über alle Repositories', 'Jobs whose latest run failed, across all repositories'),
    params: [
      { key: 'group', label: L('Gruppe', 'Group'), type: 'text', placeholder: 'gruppe', hint: L('Leer: deine zuletzt aktiven Projekte', 'Empty: your recently active projects') },
      { key: 'projects', label: L('Nur diese Projekte', 'Only these projects'), type: 'list', placeholder: 'gruppe/api, gruppe/web' },
      { key: 'name', label: L('Job-Name enthält', 'Job name contains'), type: 'text', placeholder: 'deploy' },
      { key: 'ref', label: L('Branch', 'Branch'), type: 'text', placeholder: 'main' },
      {
        key: 'since',
        label: L('Zeitraum', 'Period'),
        type: 'enum',
        default: '24h',
        options: [
          { value: '6h', label: L('6 Stunden', '6 hours') },
          { value: '24h', label: L('24 Stunden', '24 hours') },
          { value: '3d', label: L('3 Tage', '3 days') },
          { value: '7d', label: L('7 Tage', '7 days') },
        ],
      },
      { key: 'latestOnly', label: L('Nur wenn der letzte Lauf rot ist', 'Only when the latest run is red'), type: 'bool', default: true },
      { key: 'allowFailure', label: L('Auch Jobs, die fehlschlagen dürfen', 'Include jobs allowed to fail'), type: 'bool', default: false },
      { key: 'maxProjects', label: L('Höchstens Projekte', 'At most projects'), type: 'number', default: 20, min: 1, max: 50 },
    ],
    fields: JOB_FIELDS,
    defaultFields: ['project', 'name', 'stage', 'ref', 'finished'],
    titleField: 'name',
  },
  'jira.issues': {
    kind: 'jira.issues',
    provider: 'jira',
    label: L('Jira · Tickets (JQL)', 'Jira · issues (JQL)'),
    description: L('Beliebige Jira-Abfrage in JQL', 'Any Jira query in JQL'),
    params: [
      {
        key: 'jql',
        label: L('JQL', 'JQL'),
        type: 'text',
        default: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
        placeholder: 'project = PAY AND sprint in openSprints()',
      },
    ],
    fields: ISSUE_FIELDS,
    defaultFields: ['key', 'title', 'status', 'assignee', 'updated'],
    titleField: 'title',
  },
};

export const COCKPIT_SOURCE_KINDS = Object.keys(COCKPIT_SOURCES) as CockpitSourceKind[];

export const isCockpitSourceKind = (v: unknown): v is CockpitSourceKind => typeof v === 'string' && v in COCKPIT_SOURCES;

export function fieldDef(kind: CockpitSourceKind, key: string): CockpitFieldDef | undefined {
  return COCKPIT_SOURCES[kind].fields.find((f) => f.key === key);
}

// ------------------------------------------------------------------ normalizing

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown, max = MAX_TEXT): string => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
// eslint-disable-next-line no-control-regex
const clean = (v: unknown, max = MAX_TEXT): string => str(v, max).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();

let idCounter = 0;
/** A short id for widgets; random enough to keep pasted widgets apart */
export function newWidgetId(): string {
  idCounter = (idCounter + 1) % 1296;
  return `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${idCounter.toString(36)}`;
}

function normalizeParams(kind: CockpitSourceKind, raw: unknown): Record<string, CockpitParamValue> {
  const input = obj(raw) ?? {};
  const out: Record<string, CockpitParamValue> = {};
  for (const def of COCKPIT_SOURCES[kind].params) {
    const v = input[def.key];
    if (v === undefined || v === null || v === '') {
      if (def.default !== undefined) out[def.key] = def.default;
      continue;
    }
    switch (def.type) {
      case 'enum': {
        const s = clean(v, 100);
        out[def.key] = def.options?.some((o) => o.value === s) ? s : (def.default ?? def.options?.[0]?.value ?? '');
        break;
      }
      case 'bool':
        out[def.key] = v === true || v === 'true' || v === 'yes';
        break;
      case 'number': {
        const n = Math.round(Number(v));
        if (Number.isFinite(n)) out[def.key] = Math.min(def.max ?? 1000, Math.max(def.min ?? 0, n));
        else if (def.default !== undefined) out[def.key] = def.default;
        break;
      }
      case 'list': {
        const list = (Array.isArray(v) ? v : String(v).split(','))
          .map((x) => clean(x, 200))
          .filter(Boolean)
          .slice(0, 30);
        if (list.length) out[def.key] = list;
        break;
      }
      default: {
        const s = clean(v, 1000);
        if (s) out[def.key] = s;
      }
    }
  }
  return out;
}

function normalizeFilter(kind: CockpitSourceKind, raw: unknown): CockpitFilter | null {
  const f = obj(raw);
  if (!f) return null;
  const field = clean(f.field, 60);
  const op = f.op as CockpitFilterOp;
  if (!fieldDef(kind, field) || !COCKPIT_FILTER_OPS.includes(op)) return null;
  return { field, op, value: clean(f.value, 300) };
}

/** A widget from untrusted JSON (a paste, a note, a request); null when it is not one */
export function normalizeWidget(raw: unknown): CockpitWidget | null {
  const w = obj(raw);
  const source = obj(w?.source);
  if (!w || !source || !isCockpitSourceKind(source.kind)) return null;
  const kind = source.kind;
  const def = COCKPIT_SOURCES[kind];
  const known = (k: unknown): k is string => typeof k === 'string' && !!fieldDef(kind, k);
  const fields = Array.isArray(w.fields) ? [...new Set(w.fields.filter(known))].slice(0, 12) : [];
  const sort = obj(w.sort);
  const view = COCKPIT_VIEWS.includes(w.view as CockpitView) ? (w.view as CockpitView) : 'list';
  const limit = Math.round(Number(w.limit));
  const highlight = (Array.isArray(w.highlight) ? w.highlight : [])
    .map((h): CockpitHighlight | null => {
      const o = obj(h);
      const when = normalizeFilter(kind, o?.when);
      return when ? { when, tone: COCKPIT_TONES.includes(o!.tone as CockpitTone) ? (o!.tone as CockpitTone) : 'amber' } : null;
    })
    .filter((h): h is CockpitHighlight => !!h)
    .slice(0, MAX_FILTERS);
  return {
    id: /^[A-Za-z0-9_-]{1,40}$/.test(str(w.id)) ? str(w.id) : newWidgetId(),
    title: clean(w.title, 120) || def.label.de,
    source: { kind, params: normalizeParams(kind, source.params) },
    filters: (Array.isArray(w.filters) ? w.filters : [])
      .map((f) => normalizeFilter(kind, f))
      .filter((f): f is CockpitFilter => !!f)
      .slice(0, MAX_FILTERS),
    ...(sort && known(sort.field) ? { sort: { field: sort.field as string, dir: sort.dir === 'asc' ? ('asc' as const) : ('desc' as const) } } : {}),
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(COCKPIT_LIMIT.max, limit) : COCKPIT_LIMIT.default,
    view,
    fields: fields.length ? fields : [...def.defaultFields],
    ...(known(w.groupBy) ? { groupBy: w.groupBy as string } : {}),
    highlight,
    notify: w.notify === true,
    width: w.width === 2 ? 2 : 1,
  };
}

export function normalizeDashboard(raw: unknown): CockpitDashboard {
  const d = obj(raw) ?? {};
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(d.vars) ?? {}).slice(0, 50)) {
    if (/^[\p{L}\p{N}_.-]{1,60}$/u.test(k)) vars[k] = clean(v, 300);
  }
  const refresh = Math.round(Number(d.refreshMinutes));
  const seen = new Set<string>();
  const widgets = (Array.isArray(d.widgets) ? d.widgets : [])
    .map(normalizeWidget)
    .filter((w): w is CockpitWidget => !!w)
    .map((w) => (seen.has(w.id) ? { ...w, id: newWidgetId() } : (seen.add(w.id), w)))
    .slice(0, COCKPIT_MAX_WIDGETS);
  return {
    title: clean(d.title, 120) || 'Dashboard',
    refreshMinutes: Number.isFinite(refresh) && refresh >= 0 ? Math.min(120, refresh) : 5,
    vars,
    widgets,
  };
}

/** A new widget of a source with its defaults */
export function blankWidget(kind: CockpitSourceKind, lang: 'de' | 'en' = 'de'): CockpitWidget {
  const def = COCKPIT_SOURCES[kind];
  return normalizeWidget({ title: def.label[lang], source: { kind, params: {} }, fields: def.defaultFields })!;
}

// ------------------------------------------------------------------ dashboard note

const BLOCK_RE = new RegExp(`^(\`{3,}|~{3,})[ \\t]*${DASHBOARD_BLOCK}[ \\t]*\\n([\\s\\S]*?)\\n\\1[ \\t]*$`, 'm');

/** The dashboard a note holds; null when the note is no dashboard or its block is unreadable */
export function parseDashboardNote(content: string): CockpitDashboard | null {
  const { data, body } = parseFrontmatter(content);
  if (data.type && data.type !== DASHBOARD_TYPE) return null;
  const m = BLOCK_RE.exec(body);
  if (!m) return null;
  try {
    return normalizeDashboard(JSON.parse(m[2]));
  } catch {
    return null;
  }
}

export function serializeDashboard(d: CockpitDashboard): string {
  const json = JSON.stringify(normalizeDashboard(d), null, 2);
  return `---\ntype: ${DASHBOARD_TYPE}\n---\n\n\`\`\`${DASHBOARD_BLOCK}\n${json}\n\`\`\`\n`;
}

// ------------------------------------------------------------------ sharing

export const SHARE_WIDGET = 'cockpit-widget';
export const SHARE_DASHBOARD = 'cockpit-dashboard';

const stripId = <T extends { id: string }>(w: T): Omit<T, 'id'> => {
  const { id: _id, ...rest } = w;
  return rest;
};

/** A widget as JSON for a colleague (no id, no tokens: a widget never holds one) */
export function shareWidget(w: CockpitWidget): string {
  return JSON.stringify({ kladde: SHARE_WIDGET, v: 1, ...stripId(w) }, null, 2);
}

/** A whole dashboard as JSON; its variables travel with empty values so the colleague fills in their own */
export function shareDashboard(d: CockpitDashboard): string {
  const vars = Object.fromEntries(Object.keys(d.vars).map((k) => [k, '']));
  return JSON.stringify({ kladde: SHARE_DASHBOARD, v: 1, title: d.title, refreshMinutes: d.refreshMinutes, vars, widgets: d.widgets.map(stripId) }, null, 2);
}

export type SharedCockpit = { kind: 'widgets'; widgets: CockpitWidget[] } | { kind: 'dashboard'; dashboard: CockpitDashboard };

/**
 * What a paste holds: a shared widget, a list of them, a dashboard, or a ```cockpit block. Every widget gets a new id.
 * Null when it is none of these.
 */
export function readShared(text: string): SharedCockpit | null {
  const src = text.trim().replace(/^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/, '$2');
  let data: unknown;
  try {
    data = JSON.parse(src);
  } catch {
    const block = parseCockpitBlock(src);
    return block ? { kind: 'widgets', widgets: [{ ...block, id: newWidgetId() }] } : null;
  }
  const o = obj(data);
  if (o && (o.kladde === SHARE_DASHBOARD || (Array.isArray(o.widgets) && !o.source))) {
    const dashboard = normalizeDashboard(o);
    return { kind: 'dashboard', dashboard: { ...dashboard, widgets: dashboard.widgets.map((w) => ({ ...w, id: newWidgetId() })) } };
  }
  const list = (Array.isArray(data) ? data : [data])
    .map(normalizeWidget)
    .filter((w): w is CockpitWidget => !!w)
    .map((w) => ({ ...w, id: newWidgetId() }));
  return list.length ? { kind: 'widgets', widgets: list.slice(0, COCKPIT_MAX_WIDGETS) } : null;
}

// ------------------------------------------------------------------ blocks in notes

const WIDGET_KEYS = new Set(['title', 'source', 'kind', 'view', 'fields', 'limit', 'sort', 'groupBy', 'filters', 'highlight', 'width', 'notify', 'params']);

const yamlText = (v: YamlValue | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * A ```cockpit block in a note: the JSON of a widget, or a short YAML form
 *
 *   source: gitlab.mrs
 *   title: Offene MRs zum Ticket
 *   project: {{this.repo}}
 *   search: {{this.jira}}
 *   fields: [iid, title, status]
 *   sort: -updated
 *
 * where every key that is not a widget key is a parameter of the source.
 */
export function parseCockpitBlock(src: string): CockpitWidget | null {
  const text = src.trim();
  if (!text) return null;
  if (text.startsWith('{')) {
    try {
      return normalizeWidget(JSON.parse(text));
    } catch {
      return null;
    }
  }
  let y: Record<string, YamlValue>;
  try {
    y = parseYaml(text);
  } catch {
    return null;
  }
  const kind = yamlText(y.source) ?? yamlText(y.kind);
  if (!isCockpitSourceKind(kind)) return null;
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(y)) if (!WIDGET_KEYS.has(k)) params[k] = v;
  const sortText = yamlText(y.sort)?.trim();
  const list = (v: YamlValue | undefined) => (Array.isArray(v) ? v : typeof v === 'string' ? v.replace(/^\[|\]$/g, '').split(',') : []).map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
  return normalizeWidget({
    title: yamlText(y.title),
    source: { kind, params },
    view: yamlText(y.view),
    fields: list(y.fields),
    limit: yamlText(y.limit),
    groupBy: yamlText(y.groupBy),
    width: yamlText(y.width) === '2' ? 2 : 1,
    ...(sortText ? { sort: { field: sortText.replace(/^[-+]/, ''), dir: sortText.startsWith('-') ? 'desc' : 'asc' } } : {}),
  });
}

// ------------------------------------------------------------------ variables

const VAR_RE = /\{\{\s*(?:var:\s*([\p{L}\p{N}_.-]{1,60})|this\.([\p{L}\p{N}_.-]{1,60}))\s*(?:\|([^}]*))?\}\}/gu;
export const ME_TOKEN = '{{me}}';

/** Names a widget's parameters use (`{{var:x}}` as `x`, `{{this.x}}` as `this.x`) */
export function widgetVariables(w: CockpitWidget): string[] {
  const out = new Set<string>();
  for (const v of Object.values(w.source.params)) {
    for (const s of Array.isArray(v) ? v : [String(v)]) for (const m of s.matchAll(VAR_RE)) out.add(m[1] ?? `this.${m[2]}`);
  }
  return [...out];
}

/**
 * The parameters with `{{var:name|fallback}}` and `{{this.key}}` filled from `vars` (keys `name` and `this.key`).
 * `missing` lists the names without a value or fallback; `{{me}}` stays for the server.
 */
export function resolveParams(params: Record<string, CockpitParamValue>, vars: Record<string, string>): { params: Record<string, CockpitParamValue>; missing: string[] } {
  const missing = new Set<string>();
  const fill = (s: string) =>
    s.replace(VAR_RE, (_all, name: string | undefined, prop: string | undefined, fallback: string | undefined) => {
      const key = name ?? `this.${prop}`;
      const value = vars[key]?.trim();
      if (value) return value;
      if (fallback !== undefined) return fallback.trim();
      missing.add(key);
      return '';
    });
  const out: Record<string, CockpitParamValue> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string') out[k] = fill(v);
    else if (Array.isArray(v)) out[k] = v.map(fill).filter(Boolean);
    else out[k] = v;
  }
  return { params: out, missing: [...missing] };
}

// ------------------------------------------------------------------ filtering

/** `24h`, `3d`, `2w`, `90m` in milliseconds; null when it is no span */
export function parseSpan(s: string): number | null {
  const m = /^\s*(\d{1,5})\s*(m|min|h|d|t|w)\s*$/i.exec(s);
  if (!m) return null;
  const unit = m[2].toLowerCase();
  const per = unit === 'm' || unit === 'min' ? 60_000 : unit === 'h' ? 3_600_000 : unit === 'w' ? 7 * 86_400_000 : 86_400_000;
  return Number(m[1]) * per;
}

const asText = (v: CockpitValue | undefined): string => (v === null || v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v));

function compare(a: CockpitValue | undefined, b: CockpitValue | undefined): number {
  const empty = (v: CockpitValue | undefined) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
  if (empty(a) || empty(b)) return empty(a) === empty(b) ? 0 : empty(a) ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return asText(a).localeCompare(asText(b), undefined, { numeric: true, sensitivity: 'base' });
}

const regexCache = new Map<string, RegExp | null>();
function safeRegex(src: string): RegExp | null {
  if (regexCache.has(src)) return regexCache.get(src)!;
  let re: RegExp | null = null;
  // Short patterns without nested quantifiers: no catastrophic backtracking on text from upstream
  if (src.length <= 100 && !/\([^)]*[+*][^)]*\)[+*{]/.test(src)) {
    try {
      re = new RegExp(src, 'i');
    } catch {
      re = null;
    }
  }
  if (regexCache.size > 200) regexCache.clear();
  regexCache.set(src, re);
  return re;
}

/** Whether a row passes one filter; `now` for the time spans */
export function matchFilter(row: CockpitRow, f: CockpitFilter, now = Date.now()): boolean {
  const v = row.values[f.field];
  const text = asText(v).toLowerCase();
  const want = f.value.trim().toLowerCase();
  switch (f.op) {
    case 'empty':
      return text === '' || v === false;
    case 'not_empty':
      return !(text === '' || v === false);
    case 'eq':
      return Array.isArray(v) ? v.some((x) => x.toLowerCase() === want) : text === want;
    case 'ne':
      return Array.isArray(v) ? !v.some((x) => x.toLowerCase() === want) : text !== want;
    case 'contains':
      return text.includes(want);
    case 'not_contains':
      return !text.includes(want);
    case 'matches': {
      const re = safeRegex(f.value.trim());
      return !!re && re.test(asText(v).slice(0, 2000));
    }
    case 'gt':
    case 'lt': {
      const n = Number(f.value);
      const c = typeof v === 'number' && Number.isFinite(n) ? v - n : compare(v, f.value);
      return f.op === 'gt' ? c > 0 : c < 0;
    }
    case 'older_than':
    case 'newer_than': {
      const span = parseSpan(f.value);
      if (span === null || typeof v !== 'number') return false;
      return f.op === 'older_than' ? now - v > span : now - v <= span;
    }
  }
}

export interface AppliedWidget {
  rows: CockpitRow[];
  /** Rows after the filters, before the limit */
  total: number;
}

/** The filters, the sort order and the limit of a widget on the rows of its source */
export function applyWidget(rows: readonly CockpitRow[], w: Pick<CockpitWidget, 'filters' | 'sort' | 'limit'>, now = Date.now()): AppliedWidget {
  let out = rows.filter((r) => w.filters.every((f) => matchFilter(r, f, now)));
  if (w.sort) {
    const { field, dir } = w.sort;
    out = [...out].sort((a, b) => (dir === 'asc' ? 1 : -1) * compare(a.values[field], b.values[field]) || (a.id < b.id ? -1 : 1));
  }
  return { rows: out.slice(0, w.limit), total: out.length };
}

/** The tone of the first highlight rule a row meets */
export function highlightOf(row: CockpitRow, w: Pick<CockpitWidget, 'highlight'>, now = Date.now()): CockpitTone | null {
  for (const h of w.highlight) if (matchFilter(row, h.when, now)) return h.tone;
  return null;
}

// ------------------------------------------------------------------ results

export type CockpitProblem = 'not_connected' | 'no_access' | 'not_found' | 'unreachable' | 'upstream_limit' | 'invalid' | 'missing_var' | 'busy' | 'offline';

export type CockpitResult =
  | { rows: CockpitRow[]; total: number; fetchedAt: number; partial?: boolean }
  | { problem: CockpitProblem; provider?: CockpitProvider; detail?: string; missing?: string[] };

/** The connections of the signed-in user, without tokens */
export interface CockpitConnections {
  gitlab: { instanceId: string; url: string; username: string; name: string; updatedAt: number } | null;
  jira: { url: string; kind: 'cloud' | 'datacenter'; email: string; accountName: string; updatedAt: number } | null;
  /** GitLab instances the admin configured; personal tokens only work for them */
  instances: { id: string; url: string }[];
}

// ------------------------------------------------------------------ the first dashboard

/** The dashboard made when the feature is switched on: the widgets most people need first */
export function defaultDashboard(lang: 'de' | 'en' = 'de'): CockpitDashboard {
  const de = lang === 'de';
  const raw = {
    title: de ? 'Mein Tag' : 'My day',
    refreshMinutes: 5,
    vars: { repo: '' },
    widgets: [
      {
        title: de ? 'Warte auf Review' : 'Waiting for review',
        source: { kind: 'gitlab.mrs', params: { scope: 'authored', state: 'opened', draft: 'no' } },
        fields: ['iid', 'title', 'project', 'status', 'updated'],
        sort: { field: 'updated', dir: 'asc' },
        highlight: [{ when: { field: 'updated', op: 'older_than', value: '3d' }, tone: 'amber' }],
      },
      {
        title: de ? 'Ich muss reviewen' : 'My reviews',
        source: { kind: 'gitlab.mrs', params: { scope: 'review_requested', state: 'opened', draft: 'no' } },
        fields: ['iid', 'title', 'author', 'project', 'created'],
        sort: { field: 'created', dir: 'asc' },
        highlight: [{ when: { field: 'created', op: 'older_than', value: '24h' }, tone: 'amber' }],
        notify: true,
      },
      {
        title: de ? 'Fehlgeschlagene CI-Jobs' : 'Failed CI jobs',
        source: { kind: 'gitlab.jobs', params: { since: '24h', latestOnly: true } },
        view: 'table',
        fields: ['project', 'name', 'stage', 'ref', 'user', 'finished'],
        sort: { field: 'finished', dir: 'desc' },
        highlight: [{ when: { field: 'ref', op: 'matches', value: '^(main|master)$' }, tone: 'red' }],
        notify: true,
        width: 2,
      },
      {
        title: de ? 'Jira · Meine offenen Tickets' : 'Jira · my open issues',
        source: { kind: 'jira.issues', params: { jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC' } },
        view: 'board',
        groupBy: 'status',
        fields: ['key', 'title', 'priority'],
        width: 2,
      },
      {
        title: de ? 'Beobachtetes Modul' : 'Watched module',
        source: { kind: 'gitlab.mrs', params: { scope: 'all', state: 'opened', project: '{{var:repo}}' } },
        view: 'table',
        fields: ['iid', 'title', 'author', 'jira', 'status', 'updated'],
        sort: { field: 'updated', dir: 'desc' },
        width: 2,
      },
    ],
  };
  return normalizeDashboard(raw);
}
