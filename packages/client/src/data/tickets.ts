/**
 * Tickets and milestones on the client: which projects exist where tickets are on, their tickets and
 * milestones, and the actions that change them. Own folders follow the user's feature switch; group folders
 * follow the group's switch (owners turn it on for all members), whatever the member's own setting says.
 * The index is rebuilt once per vault change and only parses notes inside project folders (#64).
 */
import {
  MILESTONE_FOLDER,
  RELEASE_NOTES_FOLDER,
  databaseFileName,
  isDatabasePath,
  isMilestoneContent,
  isTicketContent,
  milestoneMeta,
  milestoneProgress,
  milestoneState,
  setMilestoneFields,
  newMilestoneContent,
  newProjectContent,
  newTicketContent,
  parseProject,
  priorityOrder,
  releaseNotesContent,
  setTicketFields,
  splitPath,
  statusCategory,
  subtaskProgress,
  ticketMeta,
  writeProject,
  canWriteInGroup,
  allowedStatuses,
  canHaveParent,
  type TicketKind,
  type TicketHook,
  type TicketHookProvider,
  type MilestoneMeta,
  type MilestoneProgress,
  type MilestoneStatus,
  type Priority,
  type ProjectConfig,
  type StatusCategory,
  type TicketMeta,
} from '@kladde/shared';
import { vault } from './vault';
import type { LocalNote } from './db';
import { compareText, getLang, t } from '../lib/i18n';
import { isReadOnly } from '../lib/readOnly';
import { api } from '../lib/api';

/** Where a note lives: the own space or a group */
export type TicketSpace = { group?: string };

export interface ProjectInfo {
  /** Id of the database note */
  id: string;
  dbNote: LocalNote;
  config: ProjectConfig;
  folder: string;
  group?: string;
  /** Name of the group, '' for own projects */
  spaceName: string;
  canWrite: boolean;
}

export interface TicketInfo {
  note: LocalNote;
  project: ProjectInfo;
  meta: TicketMeta;
  title: string;
  category: StatusCategory;
  progress: { done: number; total: number };
  /** Unfinished tickets that block this one */
  blockedBy: TicketInfo[];
  /** All tickets that block this one, finished ones too (field `blockedBy` here or `blocks` there) */
  blockers: TicketInfo[];
  /** Tickets this one blocks */
  blocking: TicketInfo[];
  /** The ticket this one hangs below (field `parent`, same project) */
  parent: TicketInfo | null;
  /** Tickets below this one, backlog order */
  children: TicketInfo[];
  /** Finished and all tickets below this one, at every level */
  rollup: { done: number; total: number };
  /** Ids of the documentation notes (field `docs` and [[links]] in the text to notes that are no tickets) */
  docIds: string[];
  /** The project asks for documentation, and this started or finished ticket has none */
  docsMissing: boolean;
  milestone: MilestoneInfo | null;
}

export interface MilestoneInfo {
  note: LocalNote;
  project: ProjectInfo;
  meta: MilestoneMeta;
  title: string;
  tickets: TicketInfo[];
  progress: MilestoneProgress;
  /** The status shown: set by hand, otherwise from the tickets */
  state: MilestoneStatus;
  /** Milestones this one waits for (field `blockedBy` here or `blocks` there) */
  blockers: MilestoneInfo[];
  /** Blockers that are neither done nor cancelled */
  blockedBy: MilestoneInfo[];
  /** Milestones that wait for this one */
  blocking: MilestoneInfo[];
  /** Blockers due after this milestone starts: the plan does not fit */
  conflicts: MilestoneInfo[];
}

interface Index {
  projects: ProjectInfo[];
  tickets: TicketInfo[];
  milestones: MilestoneInfo[];
  byNote: Map<string, TicketInfo>;
  milestoneByNote: Map<string, MilestoneInfo>;
  /** Upper-case ticket id → ticket */
  byId: Map<string, TicketInfo>;
}

const spaceKey = (n: { group?: string }) => (n.group ? `g:${n.group}` : 'own');

/** Tickets are on for a space: own notes with the user's feature, group notes with the group's switch */
export function ticketsActiveIn(space: TicketSpace): boolean {
  if (space.group) return !!vault.group(space.group)?.features?.tickets;
  return vault.features().tickets.enabled;
}

/** Tickets are on somewhere (own feature or any group): shows "Projects" in the navigation */
export function ticketsAnywhere(): boolean {
  return vault.features().tickets.enabled || vault.groups.some((g) => g.features?.tickets);
}

/** Own notes and group notes; notes shared by other users have no projects */
const inSpace = (n: LocalNote) => !!n.group || n.access === 'owner';

let cache: { version: number; features: boolean; groups: string; index: Index } | null = null;
const metaMemo = new Map<string, { content: string; meta: TicketMeta; progress: { done: number; total: number } }>();

function build(): Index {
  const notes = vault.list().filter(inSpace);
  const projects: ProjectInfo[] = [];
  const projectAt = new Map<string, ProjectInfo>();
  for (const n of notes) {
    if (!isDatabasePath(n.path) || !ticketsActiveIn(n)) continue;
    const config = parseProject(n.content);
    if (!config) continue;
    const folder = splitPath(n.path).folder;
    const key = `${spaceKey(n)}|${folder}`;
    if (projectAt.has(key)) continue;
    const group = n.group ? vault.group(n.group) : undefined;
    const p: ProjectInfo = {
      id: n.id,
      dbNote: n,
      config,
      folder,
      ...(n.group ? { group: n.group } : {}),
      spaceName: group?.name ?? '',
      canWrite: n.group ? canWriteInGroup(group?.role) : n.access === 'owner',
    };
    projects.push(p);
    projectAt.set(key, p);
  }
  const tickets: TicketInfo[] = [];
  const milestones: MilestoneInfo[] = [];
  if (projects.length) {
    for (const n of notes) {
      const folder = splitPath(n.path).folder;
      const sk = spaceKey(n);
      const project = projectAt.get(`${sk}|${folder}`);
      if (project && isTicketContent(n.content)) {
        let memo = metaMemo.get(n.id);
        if (!memo || memo.content !== n.content) {
          memo = { content: n.content, meta: ticketMeta(n.content), progress: subtaskProgress(n.content) };
          metaMemo.set(n.id, memo);
        }
        tickets.push({
          note: n,
          project,
          meta: memo.meta,
          title: splitPath(n.path).name,
          category: statusCategory(project.config, memo.meta.status),
          progress: memo.progress,
          blockedBy: [],
          blockers: [],
          blocking: [],
          parent: null,
          children: [],
          rollup: { done: 0, total: 0 },
          docIds: [],
          docsMissing: false,
          milestone: null,
        });
        continue;
      }
      if (folder.endsWith(`/${MILESTONE_FOLDER}`)) {
        const owner = projectAt.get(`${sk}|${folder.slice(0, -MILESTONE_FOLDER.length - 1)}`);
        if (owner && isMilestoneContent(n.content)) {
          milestones.push({
            note: n,
            project: owner,
            meta: milestoneMeta(n.content),
            title: splitPath(n.path).name,
            tickets: [],
            progress: milestoneProgress({ start: null, due: null }, []),
            state: 'planned',
            blockers: [],
            blockedBy: [],
            blocking: [],
            conflicts: [],
          });
        }
      }
    }
  }
  const byNote = new Map(tickets.map((tk) => [tk.note.id, tk]));
  const byId = new Map<string, TicketInfo>();
  for (const tk of tickets) if (tk.meta.id && !tk.meta.provisional && !byId.has(tk.meta.id.toUpperCase())) byId.set(tk.meta.id.toUpperCase(), tk);
  const links = tickets.length ? vault.links() : null;
  const today = new Date();
  // Ticket in the same project by id or title (a [[link]] target)
  const ticketIn = (project: ProjectInfo, target: string): TicketInfo | undefined => {
    const up = target.trim().toUpperCase();
    const direct = byId.get(up);
    if (direct?.project === project) return direct;
    const id = links?.resolve(target);
    const found = id ? byNote.get(id) : undefined;
    return found?.project === project ? found : undefined;
  };
  // Milestone in the same project by title, id or a link that resolves to it
  const milestoneIn = (project: ProjectInfo, target: string): MilestoneInfo | undefined => {
    const low = target.trim().toLowerCase();
    const id = links?.resolve(target);
    return milestones.find((m) => m.project === project && (m.title.toLowerCase() === low || m.meta.id?.toLowerCase() === low || m.note.id === id));
  };
  // One "blocks" relation, whichever note wrote it (both sides may)
  const relate = (blocker: TicketInfo, blocked: TicketInfo) => {
    if (blocker.blocking.includes(blocked)) return;
    blocker.blocking.push(blocked);
    blocked.blockers.push(blocker);
    if (blocker.category !== 'done') blocked.blockedBy.push(blocker);
  };
  for (const tk of tickets) {
    if (tk.meta.milestone) {
      tk.milestone = milestoneIn(tk.project, tk.meta.milestone) ?? null;
      tk.milestone?.tickets.push(tk);
    }
    if (tk.meta.parent) {
      const parent = ticketIn(tk.project, tk.meta.parent);
      if (parent && parent !== tk) {
        tk.parent = parent;
        parent.children.push(tk);
      }
    }
    for (const b of tk.meta.blocks) {
      const blocked = ticketIn(tk.project, b);
      if (blocked && blocked !== tk) relate(tk, blocked);
    }
    for (const b of tk.meta.blockedBy) {
      const blocker = ticketIn(tk.project, b);
      if (blocker && blocker !== tk) relate(blocker, tk);
    }
    const docs = new Set<string>();
    for (const d of tk.meta.docs) {
      const id = links!.resolve(d);
      if (id && id !== tk.note.id) docs.add(id);
    }
    for (const id of links!.outgoing(tk.note.id)) {
      if (byNote.has(id) || id === tk.project.dbNote.id) continue;
      const target = vault.get(id);
      if (target && !isMilestoneContent(target.content)) docs.add(id);
    }
    tk.docIds = [...docs];
    tk.docsMissing = tk.project.config.requireDocs && tk.category === 'done' && docs.size === 0;
  }
  // Hierarchy: children in backlog order and the progress over all levels (a loop in `parent` counts each ticket once)
  const rollupOf = (tk: TicketInfo, seen: Set<TicketInfo>): void => {
    for (const c of tk.children) {
      if (seen.has(c)) continue;
      seen.add(c);
      rollupOf(c, seen);
    }
  };
  for (const tk of tickets) {
    if (!tk.children.length) continue;
    tk.children.sort(byRank);
    const seen = new Set<TicketInfo>([tk]);
    rollupOf(tk, seen);
    seen.delete(tk);
    tk.rollup = { done: [...seen].filter((x) => x.category === 'done').length, total: seen.size };
  }
  for (const m of milestones) {
    m.progress = milestoneProgress(m.meta, m.tickets.map((tk) => ({ category: tk.category, estimate: tk.meta.estimate })), today);
    m.state = milestoneState(m.meta.status, m.tickets);
  }
  const relateMilestones = (blocker: MilestoneInfo, blocked: MilestoneInfo) => {
    if (blocker === blocked || blocker.blocking.includes(blocked)) return;
    blocker.blocking.push(blocked);
    blocked.blockers.push(blocker);
  };
  for (const m of milestones) {
    for (const b of m.meta.blocks) {
      const other = milestoneIn(m.project, b);
      if (other) relateMilestones(m, other);
    }
    for (const b of m.meta.blockedBy) {
      const other = milestoneIn(m.project, b);
      if (other) relateMilestones(other, m);
    }
  }
  for (const m of milestones) {
    m.blockedBy = m.blockers.filter((b) => b.state !== 'done' && b.state !== 'cancelled');
    const begins = m.meta.start ?? m.meta.due;
    m.conflicts = begins ? m.blockedBy.filter((b) => !!b.meta.due && b.meta.due > begins) : [];
  }
  const lang = getLang();
  projects.sort((a, b) => compareText(a.spaceName, b.spaceName, lang) || compareText(a.folder, b.folder, lang));
  milestones.sort((a, b) => (a.meta.due ?? a.meta.start ?? '9999').localeCompare(b.meta.due ?? b.meta.start ?? '9999') || compareText(a.title, b.title, lang));
  return { projects, tickets, milestones, byNote, milestoneByNote: new Map(milestones.map((m) => [m.note.id, m])), byId };
}

function index(): Index {
  const version = vault.getVersion();
  const features = vault.features().tickets.enabled;
  const groups = vault.groups.map((g) => `${g.id}:${g.features?.tickets ? 1 : 0}:${g.role}`).join(',');
  if (!cache || cache.version !== version || cache.features !== features || cache.groups !== groups) cache = { version, features, groups, index: build() };
  return cache.index;
}

export const projects = (): ProjectInfo[] => index().projects;
export const ticketsOf = (project: ProjectInfo): TicketInfo[] => index().tickets.filter((tk) => tk.project === project);
export const milestonesOf = (project: ProjectInfo): MilestoneInfo[] => index().milestones.filter((m) => m.project === project);
export const ticketOfNote = (noteId: string): TicketInfo | undefined => index().byNote.get(noteId);
export const milestoneOfNote = (noteId: string): MilestoneInfo | undefined => index().milestoneByNote.get(noteId);
export const ticketById = (id: string): TicketInfo | undefined => index().byId.get(id.toUpperCase());
/** Keys of the projects where tickets are on, for the chips in the editor */
export const projectKeys = (): string[] => [...new Set(index().projects.map((p) => p.config.key))];

/** The project shown for a folder of a space */
export function projectAt(space: TicketSpace, folder: string): ProjectInfo | undefined {
  return index().projects.find((p) => (p.group ?? '') === (space.group ?? '') && p.folder === folder);
}

/** Tickets that document their work in this note (field `docs` or a [[link]] in their text) */
export function ticketsDocumentedIn(noteId: string): TicketInfo[] {
  return index().tickets.filter((tk) => tk.docIds.includes(noteId));
}

/** Unfinished tickets assigned to the user, most urgent first */
export function myTickets(): TicketInfo[] {
  const me = vault.actorName?.toLowerCase();
  if (!me) return [];
  return index()
    .tickets.filter((tk) => tk.meta.assignee?.toLowerCase() === me && tk.category !== 'done')
    .sort(byUrgency);
}

/** Backlog order: rank, then priority, then ticket number */
export function byRank(a: TicketInfo, b: TicketInfo): number {
  const ra = a.meta.rank ?? Number.MAX_SAFE_INTEGER;
  const rb = b.meta.rank ?? Number.MAX_SAFE_INTEGER;
  return ra - rb || priorityOrder(a.meta.priority) - priorityOrder(b.meta.priority) || (a.meta.number ?? Infinity) - (b.meta.number ?? Infinity);
}

/** Active before open, then priority, then the milestone's due date */
export function byUrgency(a: TicketInfo, b: TicketInfo): number {
  const cat = (c: StatusCategory) => (c === 'active' ? 0 : c === 'open' ? 1 : 2);
  return cat(a.category) - cat(b.category) || priorityOrder(a.meta.priority) - priorityOrder(b.meta.priority) || (a.milestone?.meta.due ?? '9999').localeCompare(b.milestone?.meta.due ?? '9999');
}

/** People a ticket can be assigned to: the group's members, or the user and the people the note is shared with */
export function assignees(project: ProjectInfo, noteId?: string): string[] {
  const names = new Set<string>();
  if (vault.actorName) names.add(vault.actorName);
  for (const p of vault.peopleOf(noteId ?? project.dbNote.id)) names.add(p.username);
  for (const tk of ticketsOf(project)) if (tk.meta.assignee) names.add(tk.meta.assignee);
  return [...names].sort((a, b) => compareText(a, b));
}

// ------------------------------------------------------------------ actions

function guard() {
  if (isReadOnly()) throw new Error(t('vault.readOnlyError'));
}

async function createIn(space: TicketSpace, folder: string, title: string, content: string): Promise<LocalNote> {
  return space.group ? vault.createInGroup(space.group, folder, title, content) : vault.create(folder, title, content);
}

/** Turns a folder into a project: a database note with the project settings */
export async function createProject(space: TicketSpace, folder: string, key: string, requireDocs = false): Promise<LocalNote> {
  guard();
  return createIn(space, folder, databaseFileName(crypto.randomUUID()).replace(/\.md$/, ''), newProjectContent(key, getLang(), requireDocs));
}

/**
 * Saves the project settings (key, workflow, transitions, automations, documentation rule); the status options of
 * the board follow. `renamed` (old → new status) moves the project's tickets to the new names as well.
 */
export async function saveProject(project: ProjectInfo, config: ProjectConfig, renamed: Record<string, string> = {}): Promise<void> {
  guard();
  let content = writeProject(project.dbNote.content, config);
  // The status property of the database offers the workflow
  content = content.replace(/(- name: status\n\s+type: select\n\s+options: )\[[^\]\n]*\]/i, (_m, head: string) => `${head}[${config.workflow.map((s) => (/[,[\]"':#]/.test(s) ? JSON.stringify(s) : s)).join(', ')}]`);
  await vault.update(project.dbNote.id, { content });
  const renames = new Map(Object.entries(renamed).filter(([from, to]) => from !== to).map(([from, to]) => [from.toLowerCase(), to]));
  if (!renames.size) return;
  const changes: { id: string; content: string }[] = [];
  for (const tk of ticketsOf(project)) {
    const to = renames.get(tk.meta.status.toLowerCase());
    const note = to ? vault.get(tk.note.id) : undefined;
    if (to && note) changes.push({ id: note.id, content: setTicketFields(note.content, { status: to }) });
  }
  await vault.updateContents(changes);
}

/** Tickets of the project a ticket of `kind` may hang below (not itself or anything below it) */
export function parentCandidates(project: ProjectInfo, kind: TicketKind, self?: TicketInfo): TicketInfo[] {
  const below = new Set<TicketInfo>();
  const walk = (tk: TicketInfo) => {
    for (const c of tk.children) {
      if (below.has(c)) continue;
      below.add(c);
      walk(c);
    }
  };
  if (self) walk(self);
  return ticketsOf(project)
    .filter((tk) => tk !== self && !below.has(tk) && canHaveParent(kind, tk.meta.kind) && !!tk.meta.id && !tk.meta.provisional)
    .sort((a, b) => (a.category === 'done' ? 1 : 0) - (b.category === 'done' ? 1 : 0) || byRank(a, b));
}

/** The chain of parents from the top down, without the ticket itself */
export function ancestorsOf(tk: TicketInfo): TicketInfo[] {
  const out: TicketInfo[] = [];
  for (let p = tk.parent; p && !out.includes(p) && p !== tk; p = p.parent) out.unshift(p);
  return out;
}

/** Statuses a ticket can move to now (its own first in workflow order); all of them without transitions */
export const allowedStatusesOf = (ticket: TicketInfo): string[] => allowedStatuses(ticket.project.config, ticket.meta.status);

/** Whether the workflow lets the ticket move to `status` */
export const canMoveTo = (ticket: TicketInfo, status: string): boolean => allowedStatusesOf(ticket).some((s) => s.toLowerCase() === status.toLowerCase());

// ------------------------------------------------------------------ webhooks (GitLab / GitHub)

export const listTicketHooks = (project: ProjectInfo) => api<TicketHook[]>(`/ticket-hooks/${encodeURIComponent(project.id)}`);
export const createTicketHook = (project: ProjectInfo, provider: TicketHookProvider, name: string) =>
  api<{ hook: TicketHook; secret: string }>(`/ticket-hooks/${encodeURIComponent(project.id)}`, { method: 'POST', json: { provider, name } });
export const removeTicketHook = (project: ProjectInfo, id: string) => api<TicketHook[]>(`/ticket-hooks/${encodeURIComponent(project.id)}/${encodeURIComponent(id)}`, { method: 'DELETE' });

export interface TicketDraft {
  title: string;
  kind?: TicketKind;
  /** Id of the parent ticket */
  parent?: string | null;
  status?: string;
  priority?: Priority;
  milestone?: string | null;
  assignee?: string | null;
  estimate?: number | null;
  labels?: string[];
  docs?: string[];
  description?: string;
}

/** A new ticket in a project; it carries `KEY-?` until the server numbers it */
export async function createTicket(project: ProjectInfo, draft: TicketDraft): Promise<LocalNote> {
  guard();
  const last = ticketsOf(project).reduce((m, tk) => Math.max(m, tk.meta.rank ?? 0), 0);
  const content = newTicketContent({
    key: project.config.key,
    status: draft.status ?? project.config.workflow[0],
    kind: draft.kind,
    parent: draft.parent,
    priority: draft.priority,
    milestone: draft.milestone,
    assignee: draft.assignee,
    estimate: draft.estimate,
    labels: draft.labels,
    docs: draft.docs,
    description: draft.description,
    rank: last + 1000,
  });
  return createIn(project, project.folder, draft.title.trim() || t('tickets.untitled'), content);
}

/** A new milestone in the project's milestone folder */
export async function createMilestone(project: ProjectInfo, m: { title: string; id?: string; start?: string | null; due?: string | null; release?: string | null; goal?: string }): Promise<LocalNote> {
  guard();
  return createIn(project, `${project.folder}/${MILESTONE_FOLDER}`, m.title.trim() || t('tickets.milestoneUntitled'), newMilestoneContent(m));
}

/** Changes ticket fields. Finishing a ticket without documentation asks first when the project wants it */
export async function updateTicket(ticket: TicketInfo, fields: Parameters<typeof setTicketFields>[1]): Promise<boolean> {
  if (fields.status !== undefined && fields.status !== null) {
    // The server would undo it anyway; the menus only offer allowed statuses
    if (!canMoveTo(ticket, String(fields.status))) {
      alert(t('workflow.notAllowed', { from: ticket.meta.status, to: String(fields.status) }));
      return false;
    }
    const next = statusCategory(ticket.project.config, String(fields.status));
    const docs = fields.docs !== undefined ? (fields.docs as string[]).length : ticket.docIds.length;
    if (next === 'done' && ticket.category !== 'done' && ticket.project.config.requireDocs && !docs && !confirm(t('tickets.docsRequiredConfirm', { ticket: ticket.meta.id ?? ticket.title }))) return false;
  }
  const note = vault.get(ticket.note.id);
  if (!note) return false;
  await vault.update(note.id, { content: setTicketFields(note.content, fields) });
  return true;
}

/** Sets a milestone's status by hand; null lets it follow the tickets again */
export async function setMilestoneStatus(m: MilestoneInfo, status: MilestoneStatus | null): Promise<void> {
  guard();
  const note = vault.get(m.note.id);
  if (note) await vault.update(note.id, { content: setMilestoneFields(note.content, { status }) });
}

/** How a ticket or milestone is written in another one's `blocks`/`blockedBy` */
const refOf = (x: TicketInfo | MilestoneInfo): string => ('category' in x ? (x.meta.id && !x.meta.provisional ? x.meta.id : x.title) : (x.meta.id ?? x.title));
/** Whether a written target means this ticket or milestone */
function refersTo(target: string, x: TicketInfo | MilestoneInfo): boolean {
  const low = target.trim().toLowerCase();
  if (low === x.title.toLowerCase() || (!!x.meta.id && low === x.meta.id.toLowerCase())) return true;
  return vault.links().resolve(target) === x.note.id;
}

/**
 * Adds "`blocker` blocks `blocked`" (tickets or milestones of one project). It is written on the note being edited:
 * `side` 'blocks' adds to the blocker's `blocks`, 'blockedBy' to the blocked one's `blockedBy`.
 */
export async function addBlock<T extends TicketInfo | MilestoneInfo>(blocker: T, blocked: T, side: 'blocks' | 'blockedBy'): Promise<void> {
  guard();
  const owner = side === 'blocks' ? blocker : blocked;
  const other = side === 'blocks' ? blocked : blocker;
  const note = vault.get(owner.note.id);
  if (!note) return;
  const current = owner.meta[side];
  if (current.some((x) => refersTo(x, other))) return;
  const next = [...current, refOf(other)];
  await vault.update(note.id, { content: 'category' in owner ? setTicketFields(note.content, { [side]: next }) : setMilestoneFields(note.content, { [side]: next }) });
}

/** Removes "`blocker` blocks `blocked`" from both notes, wherever it was written */
export async function removeBlock<T extends TicketInfo | MilestoneInfo>(blocker: T, blocked: T): Promise<void> {
  guard();
  const changes: { id: string; content: string }[] = [];
  for (const [owner, side, other] of [
    [blocker, 'blocks', blocked],
    [blocked, 'blockedBy', blocker],
  ] as const) {
    const note = vault.get(owner.note.id);
    const list = owner.meta[side];
    if (!note || note.access === 'read' || !list.some((x) => refersTo(x, other))) continue;
    const next = list.filter((x) => !refersTo(x, other));
    changes.push({ id: note.id, content: 'category' in owner ? setTicketFields(note.content, { [side]: next }) : setMilestoneFields(note.content, { [side]: next }) });
  }
  if (changes.length) await vault.updateContents(changes);
}

/** Release notes of a milestone as a new note in the project's "Release Notes" folder */
export async function createReleaseNotes(m: MilestoneInfo): Promise<LocalNote> {
  guard();
  const done = m.tickets.filter((tk) => tk.category === 'done').sort(byRank);
  const content = releaseNotesContent(
    { title: m.title, release: m.meta.release, goal: m.meta.goal },
    done.map((tk) => ({ id: tk.meta.id && !tk.meta.provisional ? tk.meta.id : null, title: tk.title, labels: tk.meta.labels })),
    getLang()
  );
  const name = m.meta.release ? `${t('tickets.releaseNotes')} ${m.meta.release}` : `${t('tickets.releaseNotes')} ${m.title}`;
  return createIn(m.project, `${m.project.folder}/${RELEASE_NOTES_FOLDER}`, name, content);
}
