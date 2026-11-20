/**
 * Tickets and milestones (opt-in): Jira-like planning on top of folders as databases (#76). Everything stays
 * plain Markdown with frontmatter, so tickets sync, export and work offline like any note:
 *
 *   Projekte/Kladde/_database-<uuid>.md   type: database + `project: { key: KLD, workflow: […], active: […], done: […] }`
 *   Projekte/Kladde/<ticket>.md           type: ticket, id: KLD-118, status, priority, milestone, assignee, …
 *   Projekte/Kladde/Meilensteine/<m>.md   type: milestone, id, start, due, release, goal
 *
 * Ticket numbers are counted by the server per owner (user or group) and project key: a client writes the
 * provisional id `KLD-?` and the server replaces it with the next number when the note arrives (`assignTicketNumber`).
 * `[[KLD-118]]` resolves through the frontmatter `id` like any link (LinkIndex).
 */

import { parseTasks } from './tasks.js';
import { splitPath } from './markdown.js';
import { readFrontmatterYaml, setFrontmatterValues, type YamlMap, type YamlValue } from './yaml.js';
import { DATABASE_PREFIX, linkTarget } from './database.js';

export const TICKET_TYPE = 'ticket';
export const MILESTONE_TYPE = 'milestone';
/** Subfolder of a project that holds its milestones */
export const MILESTONE_FOLDER = 'Meilensteine';
/** Subfolder of a project that holds generated release notes */
export const RELEASE_NOTES_FOLDER = 'Release Notes';

/** Project keys: 2–10 capital letters and digits, starting with a letter */
export const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;
/** A ticket id as written in the frontmatter: `KLD-118`, or `KLD-?` before the server numbered it */
const TICKET_ID_RE = /^([A-Z][A-Z0-9]{1,9})-(\d{1,7}|\?)$/;

export type StatusCategory = 'open' | 'active' | 'done';
export const PRIORITIES = ['high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface ProjectConfig {
  key: string;
  /** Statuses in board order */
  workflow: string[];
  /** Statuses counted as "in progress" (the others before `done` are "open") */
  active: string[];
  /** Statuses counted as finished */
  done: string[];
  /** Ask for documentation before a ticket is finished, and mark finished tickets without any */
  requireDocs: boolean;
}

export interface TicketMeta {
  /** `KLD-118`; `KLD-?` while provisional; null without an id */
  id: string | null;
  key: string | null;
  number: number | null;
  provisional: boolean;
  status: string;
  priority: Priority | null;
  /** Link target of the milestone (`[[v2.14]]` → `v2.14`) */
  milestone: string | null;
  /** Username without `@` */
  assignee: string | null;
  estimate: number | null;
  labels: string[];
  /** Link targets of the documentation pages */
  docs: string[];
  /** Link targets of the tickets this one blocks */
  blocks: string[];
  /** Backlog order (smaller first) */
  rank: number | null;
}

export interface MilestoneMeta {
  id: string | null;
  start: string | null;
  due: string | null;
  release: string | null;
  goal: string;
}

const str = (v: YamlValue | undefined): string => (typeof v === 'string' ? v.trim() : '');
const list = (v: YamlValue | undefined): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : typeof v === 'string' && v.trim() ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const num = (v: YamlValue | undefined): number | null => {
  const s = str(v);
  if (!s) return null;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/** Default workflow for new projects, in the language of the UI */
export function defaultWorkflow(lang: 'de' | 'en' = 'de'): Pick<ProjectConfig, 'workflow' | 'active' | 'done'> {
  return lang === 'en'
    ? { workflow: ['Open', 'In progress', 'Review', 'Done'], active: ['In progress', 'Review'], done: ['Done'] }
    : { workflow: ['Offen', 'In Arbeit', 'Review', 'Erledigt'], active: ['In Arbeit', 'Review'], done: ['Erledigt'] };
}

/** A valid project key from free text ("kladde notes" → "KN"; "kld" → "KLD"), or null */
export function cleanProjectKey(raw: string): string | null {
  const s = raw.trim().toUpperCase();
  if (PROJECT_KEY_RE.test(s)) return s;
  const words = s.split(/[^A-Z0-9]+/).filter(Boolean);
  const guess = (words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? '').slice(0, 3)).replace(/^\d+/, '');
  return PROJECT_KEY_RE.test(guess) ? guess : null;
}

/** The project settings of a database note; null when the database is no project */
export function parseProject(dbContent: string): ProjectConfig | null {
  const fm = readFrontmatterYaml(dbContent);
  if (!fm || str(fm.data.type).toLowerCase() !== 'database') return null;
  const raw = fm.data.project;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as YamlMap;
  const key = str(p.key).toUpperCase();
  if (!PROJECT_KEY_RE.test(key)) return null;
  const fallback = defaultWorkflow();
  const workflow = [...new Set(list(p.workflow))];
  const wf = workflow.length ? workflow : fallback.workflow;
  const inWf = (s: string[]) => s.filter((x) => wf.some((w) => w.toLowerCase() === x.toLowerCase()));
  let done = inWf(list(p.done));
  if (!done.length) done = [wf[wf.length - 1]];
  const active = inWf(list(p.active)).filter((a) => !done.some((d) => d.toLowerCase() === a.toLowerCase()));
  return { key, workflow: wf, active, done, requireDocs: /^(true|yes|ja|1)$/i.test(str(p.requireDocs)) };
}

/** Writes the project settings into a database note, keeping everything else */
export function writeProject(dbContent: string, project: ProjectConfig): string {
  const value: YamlMap = { key: project.key, workflow: project.workflow, active: project.active, done: project.done };
  if (project.requireDocs) value.requireDocs = 'true';
  return setFrontmatterValues(dbContent, { project: value });
}

/** Whether a database file (`_database-….md`) is a project, without parsing the whole schema */
export const isProjectDatabase = (path: string, content: string): boolean =>
  splitPath(path).name.startsWith(DATABASE_PREFIX) && parseProject(content) !== null;

/** The category of a status in a project (unknown statuses count as open) */
export function statusCategory(project: Pick<ProjectConfig, 'active' | 'done'>, status: string): StatusCategory {
  const s = status.trim().toLowerCase();
  if (project.done.some((d) => d.toLowerCase() === s)) return 'done';
  if (project.active.some((a) => a.toLowerCase() === s)) return 'active';
  return 'open';
}

/** Content of the database note of a new project: the ticket properties, a board and a backlog view */
export function newProjectContent(key: string, lang: 'de' | 'en' = 'de', requireDocs = false): string {
  const wf = defaultWorkflow(lang);
  const en = lang === 'en';
  const head: Record<string, YamlValue> = {
    type: 'database',
    project: { key, workflow: wf.workflow, active: wf.active, done: wf.done, ...(requireDocs ? { requireDocs: 'true' } : {}) },
    properties: [
      { name: 'status', type: 'select', options: wf.workflow, default: wf.workflow[0] },
      { name: 'priority', type: 'select', options: [...PRIORITIES], default: 'medium' },
      { name: 'milestone', type: 'link' },
      { name: 'assignee', type: 'text' },
      { name: 'estimate', type: 'number' },
      { name: 'labels', type: 'multiselect' },
    ],
    views: [
      { name: 'Board', type: 'board', group: 'status' },
      { name: en ? 'Backlog' : 'Backlog', type: 'table', columns: ['id', 'status', 'priority', 'milestone', 'assignee', 'estimate'], sort: 'rank' },
    ],
  };
  return setFrontmatterValues(en ? '# Project\n' : '# Projekt\n', head);
}

/** The frontmatter block of a note (without the `---` lines), or null */
function frontmatterBlock(content: string): string | null {
  if (!content.startsWith('---')) return null;
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  return m ? m[1] : null;
}

/** `type` of a note's frontmatter, lower case ('' without one) */
export function noteType(content: string): string {
  const fm = frontmatterBlock(content);
  const m = fm === null ? null : /^type:[ \t]*["']?([A-Za-z-]+)["']?[ \t]*$/m.exec(fm);
  return m ? m[1].toLowerCase() : '';
}

export const isTicketContent = (content: string): boolean => noteType(content) === TICKET_TYPE;
export const isMilestoneContent = (content: string): boolean => noteType(content) === MILESTONE_TYPE;

/** Splits `KLD-118` / `KLD-?` */
export function parseTicketId(id: string): { key: string; number: number | null } | null {
  const m = TICKET_ID_RE.exec(id.trim());
  if (!m) return null;
  return { key: m[1], number: m[2] === '?' ? null : Number(m[2]) };
}

export const provisionalTicketId = (key: string): string => `${key}-?`;

const priorityOf = (v: string): Priority | null => {
  const s = v.toLowerCase();
  if ((PRIORITIES as readonly string[]).includes(s)) return s as Priority;
  if (/^(hoch|h|1|highest|critical|kritisch)$/.test(s)) return 'high';
  if (/^(mittel|m|2|normal)$/.test(s)) return 'medium';
  if (/^(niedrig|n|l|3|lowest|gering)$/.test(s)) return 'low';
  return null;
};

/** The ticket fields of a note (also for notes without `type: ticket`, which then have empty fields) */
export function ticketMeta(content: string): TicketMeta {
  const fm = readFrontmatterYaml(content);
  const d: YamlMap = fm?.data ?? {};
  const get = (k: string): YamlValue | undefined => d[k] ?? d[Object.keys(d).find((x) => x.toLowerCase() === k) ?? ''];
  const id = str(get('id'));
  const parsed = id ? parseTicketId(id) : null;
  const milestone = str(get('milestone'));
  const assignee = str(get('assignee')).replace(/^@/, '');
  return {
    id: parsed ? id : null,
    key: parsed?.key ?? null,
    number: parsed?.number ?? null,
    provisional: !!parsed && parsed.number === null,
    status: str(get('status')),
    priority: priorityOf(str(get('priority'))),
    milestone: milestone ? linkTarget(milestone) || null : null,
    assignee: assignee || null,
    estimate: num(get('estimate')),
    labels: list(get('labels')),
    docs: list(get('docs')).map((x) => linkTarget(x)).filter(Boolean),
    blocks: list(get('blocks')).map((x) => linkTarget(x)).filter(Boolean),
    rank: num(get('rank')),
  };
}

/** The milestone fields of a note */
export function milestoneMeta(content: string): MilestoneMeta {
  const d: YamlMap = readFrontmatterYaml(content)?.data ?? {};
  const date = (v: YamlValue | undefined) => (ISO_DATE.test(str(v)) ? str(v) : null);
  return { id: str(d.id) || null, start: date(d.start), due: date(d.due), release: str(d.release) || null, goal: str(d.goal) };
}

/** Frontmatter values to write for a ticket field; undefined removes the key */
export function ticketFieldValue(field: 'status' | 'priority' | 'milestone' | 'assignee' | 'estimate' | 'labels' | 'docs' | 'blocks' | 'rank', value: string | number | string[] | null): YamlValue | undefined {
  if (value === null || value === '' || (Array.isArray(value) && !value.length)) return undefined;
  switch (field) {
    case 'milestone':
      return `[[${String(value).replace(/^\[\[|\]\]$/g, '')}]]`;
    case 'assignee':
      return `@${String(value).replace(/^@/, '')}`;
    case 'docs':
    case 'blocks':
      return (value as string[]).map((v) => `[[${v.replace(/^\[\[|\]\]$/g, '')}]]`);
    case 'labels':
      return value as string[];
    default:
      return String(value);
  }
}

/** Sets ticket fields in a note, keeping all other frontmatter */
export function setTicketFields(content: string, fields: Partial<Record<Parameters<typeof ticketFieldValue>[0], string | number | string[] | null>>): string {
  const updates: Record<string, YamlValue | undefined> = {};
  for (const [k, v] of Object.entries(fields)) updates[k] = ticketFieldValue(k as Parameters<typeof ticketFieldValue>[0], v ?? null);
  const out = setFrontmatterValues(content, updates);
  // Numbers as plain YAML scalars, so other tools read them as numbers
  return out.replace(/^(estimate|rank): "(-?\d+(?:\.\d+)?)"$/gm, '$1: $2');
}

export interface NewTicket {
  key: string;
  status: string;
  priority?: Priority;
  milestone?: string | null;
  assignee?: string | null;
  estimate?: number | null;
  labels?: string[];
  docs?: string[];
  description?: string;
  rank?: number | null;
}

/** Content of a new ticket with the provisional id `KEY-?` (the server numbers it) */
export function newTicketContent(t: NewTicket): string {
  const body = t.description?.trim() ? `\n${t.description.trim()}\n` : '\n';
  const base = setFrontmatterValues(body, { type: TICKET_TYPE, id: provisionalTicketId(t.key) });
  return setTicketFields(base, {
    status: t.status,
    priority: t.priority ?? 'medium',
    milestone: t.milestone ?? null,
    assignee: t.assignee ?? null,
    estimate: t.estimate ?? null,
    labels: t.labels ?? [],
    docs: t.docs ?? [],
    rank: t.rank ?? null,
  });
}

/** Content of a new milestone */
export function newMilestoneContent(m: { id?: string; start?: string | null; due?: string | null; release?: string | null; goal?: string }): string {
  const updates: Record<string, YamlValue | undefined> = {
    type: MILESTONE_TYPE,
    id: m.id?.trim() || undefined,
    start: m.start || undefined,
    due: m.due || undefined,
    release: m.release?.trim() || undefined,
    goal: m.goal?.trim() || undefined,
  };
  return setFrontmatterValues('\n', updates);
}

/**
 * Server side: when `content` is a ticket with a provisional id (`KLD-?`), returns it with the next number from
 * `next(key)`; otherwise null. Only the `id:` line of the frontmatter changes.
 */
export function assignTicketNumber(content: string, next: (key: string) => number): string | null {
  const fm = frontmatterBlock(content);
  if (fm === null || !isTicketContent(content)) return null;
  const m = /^(id:[ \t]*)(["']?)([A-Z][A-Z0-9]{1,9})-\?\2([ \t]*)$/m.exec(fm);
  if (!m) return null;
  const n = next(m[3]);
  // The frontmatter starts after the first line ("---\n"); the numbered id needs no quotes
  const at = content.indexOf('\n') + 1 + m.index;
  return `${content.slice(0, at)}${m[1]}${m[3]}-${n}${m[4]}${content.slice(at + m[0].length)}`;
}

/** Server side: the numbered id of a ticket (`{ key: 'KLD', number: 118 }`), to keep counters above imported numbers */
export function numberedTicketId(content: string): { key: string; number: number } | null {
  const fm = frontmatterBlock(content);
  if (fm === null || !isTicketContent(content)) return null;
  const m = /^id:[ \t]*["']?([A-Z][A-Z0-9]{1,9})-(\d{1,7})["']?[ \t]*$/m.exec(fm);
  return m ? { key: m[1], number: Number(m[2]) } : null;
}

/** Done and total sub-tasks (Markdown checkboxes) of a ticket */
export function subtaskProgress(content: string): { done: number; total: number } {
  const tasks = parseTasks(content);
  return { done: tasks.filter((t) => t.done).length, total: tasks.length };
}

/** Ticket ids written in text (`KLD-118`) for the given project keys; callers skip code themselves */
export function ticketIdPattern(keys: Iterable<string>): RegExp | null {
  const clean = [...new Set([...keys].filter((k) => PROJECT_KEY_RE.test(k)))].sort((a, b) => b.length - a.length);
  if (!clean.length) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}_/-])(${clean.join('|')})-(\\d{1,7})(?![\\p{L}\\p{N}_-])`, 'gu');
}

/** Ordering of priorities, highest first */
export const priorityOrder = (p: Priority | null): number => (p === 'high' ? 0 : p === 'medium' ? 1 : p === 'low' ? 2 : 3);

/** A rank between two neighbours for drag and drop in the backlog */
export function rankBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return 1000;
  if (before === null) return (after as number) - 1000;
  if (after === null) return before + 1000;
  return (before + after) / 2;
}

export interface MilestoneProgress {
  total: number;
  done: number;
  points: number;
  donePoints: number;
  /** 0…1 by tickets */
  ratio: number;
  /** Days until due (negative when overdue), null without a due date */
  daysLeft: number | null;
  /** Elapsed time clearly ahead of the progress, or overdue and not finished */
  atRisk: boolean;
}

const dayMs = 86_400_000;
const dayOf = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

/** Progress of a milestone from the categories of its tickets, with a risk hint */
export function milestoneProgress(m: Pick<MilestoneMeta, 'start' | 'due'>, tickets: { category: StatusCategory; estimate: number | null }[], today = new Date()): MilestoneProgress {
  const total = tickets.length;
  const done = tickets.filter((t) => t.category === 'done').length;
  const points = tickets.reduce((s, t) => s + (t.estimate ?? 0), 0);
  const donePoints = tickets.filter((t) => t.category === 'done').reduce((s, t) => s + (t.estimate ?? 0), 0);
  const ratio = total ? done / total : 0;
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const daysLeft = m.due ? Math.round((dayOf(m.due) - now) / dayMs) : null;
  let atRisk = false;
  if (m.due && total && done < total) {
    if (daysLeft !== null && daysLeft < 0) atRisk = true;
    else if (m.start) {
      const span = dayOf(m.due) - dayOf(m.start);
      const elapsed = span > 0 ? Math.min(1, Math.max(0, (now - dayOf(m.start)) / span)) : 1;
      atRisk = elapsed - ratio > 0.25;
    }
  }
  return { total, done, points, donePoints, ratio, daysLeft, atRisk };
}

/** Monday (UTC) of the ISO week of a UTC date and the week number, for the roadmap axis */
function weekOf(date: Date): { monday: Date; week: number } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dow = d.getUTCDay() || 7;
  const monday = new Date(d.getTime() - (dow - 1) * dayMs);
  const thursday = new Date(monday.getTime() + 3 * dayMs);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  return { monday, week: Math.ceil(((thursday.getTime() - yearStart) / dayMs + 1) / 7) };
}

/** Columns of a roadmap (weeks) covering all milestones and today, at least `min` weeks */
export function roadmapWeeks(milestones: Pick<MilestoneMeta, 'start' | 'due'>[], today = new Date(), min = 8): { start: Date; weeks: { monday: Date; week: number }[] } {
  const dates = [new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()))];
  for (const m of milestones) for (const iso of [m.start, m.due]) if (iso) dates.push(new Date(dayOf(iso)));
  const first = weekOf(new Date(Math.min(...dates.map((d) => d.getTime()))));
  const last = Math.max(...dates.map((d) => d.getTime()));
  const weeks: { monday: Date; week: number }[] = [];
  for (let t = first.monday.getTime(); t <= last || weeks.length < min; t += 7 * dayMs) {
    weeks.push(weekOf(new Date(t)));
    if (weeks.length > 104) break;
  }
  return { start: first.monday, weeks };
}

/** Position of a day on a roadmap as a fraction of its width */
export function roadmapOffset(iso: string | Date, start: Date, weeks: number): number {
  const t = typeof iso === 'string' ? dayOf(iso) : Date.UTC(iso.getFullYear(), iso.getMonth(), iso.getDate());
  return Math.max(0, Math.min(1, (t - start.getTime()) / (weeks * 7 * dayMs)));
}

/** Release notes of a milestone: its finished tickets grouped by their first label */
export function releaseNotesContent(
  milestone: { title: string; release: string | null; goal: string },
  tickets: { id: string | null; title: string; labels: string[] }[],
  lang: 'de' | 'en' = 'de',
  today = new Date()
): string {
  const en = lang === 'en';
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const lines = [`${en ? 'Milestone' : 'Meilenstein'}: [[${milestone.title}]] · ${date}`, ''];
  if (milestone.goal) lines.push(`> ${milestone.goal}`, '');
  const groups = new Map<string, typeof tickets>();
  for (const t of tickets) {
    const g = t.labels[0] ?? '';
    groups.set(g, [...(groups.get(g) ?? []), t]);
  }
  const names = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a < b ? -1 : a > b ? 1 : 0));
  for (const g of names) {
    lines.push(`## ${g || (en ? 'Other' : 'Sonstiges')}`, '');
    for (const t of groups.get(g)!) lines.push(`- ${t.title}${t.id ? ` ([[${t.id}]])` : ''}`);
    lines.push('');
  }
  if (!tickets.length) lines.push(en ? '_No finished tickets._' : '_Keine erledigten Tickets._', '');
  return setFrontmatterValues(lines.join('\n'), { type: 'release-notes', ...(milestone.release ? { release: milestone.release } : {}) });
}
