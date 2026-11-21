/**
 * Workflows of ticket projects: which status changes are allowed (transitions) and rules that change tickets
 * when something happens (automations). Both live in the `project` block of the project's database note, so they
 * sync, export and work offline like everything else; the project settings edit them without touching YAML:
 *
 *   project:
 *     key: KLD
 *     workflow: [Offen, In Arbeit, Review, Erledigt]
 *     transitions:                 # missing: every change is allowed
 *       - from: Offen
 *         to: [In Arbeit]
 *     automations:
 *       - id: a1b2c3
 *         name: Merge setzt Status
 *         on: mr_merged
 *         status: [In Arbeit, Review]   # only tickets in one of these statuses
 *         force: "true"                 # may skip the transitions
 *         actions:
 *           - set_status: Implementiert
 *           - comment: "Gemergt: {{mr.url}}"
 *
 * The server checks transitions on every push and runs the automations (`automations.ts`); the client only offers
 * allowed statuses. This module has no other ticket logic, so `tickets.ts` can parse it without a cycle.
 */

import type { YamlMap, YamlValue } from './yaml.js';

/** What starts an automation */
export const AUTOMATION_TRIGGERS = ['ticket_created', 'status_changed', 'subtasks_done', 'mr_opened', 'mr_merged', 'mr_closed'] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

/** What an automation does to the ticket */
export const AUTOMATION_ACTIONS = ['set_status', 'set_priority', 'set_assignee', 'add_label', 'remove_label', 'comment'] as const;
export type AutomationActionType = (typeof AUTOMATION_ACTIONS)[number];

export interface AutomationAction {
  type: AutomationActionType;
  /** Status, priority, user name, label or comment text (Markdown with placeholders); '' clears the assignee */
  value: string;
}

export interface Automation {
  /** Short random id, stable across renames */
  id: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  /** `status_changed` only: previous statuses (empty: any) */
  from: string[];
  /** `status_changed` only: new statuses (empty: any) */
  to: string[];
  /** Only tickets in one of these statuses (empty: any) */
  ifStatus: string[];
  /** Only tickets with at least one of these labels (empty: any) */
  ifLabels: string[];
  /** A status change of this automation may skip the transitions */
  force: boolean;
  actions: AutomationAction[];
}

/** Allowed next statuses per status; null allows every change */
export type Transitions = Record<string, string[]> | null;

export type TransitionPreset = 'free' | 'linear' | 'forward';

const str = (v: YamlValue | undefined): string => (typeof v === 'string' ? v.trim() : '');
const list = (v: YamlValue | undefined): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : typeof v === 'string' && v.trim() ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
const isMap = (v: YamlValue | undefined): v is YamlMap => !!v && typeof v === 'object' && !Array.isArray(v);
const truthy = (v: YamlValue | undefined) => /^(true|yes|ja|1)$/i.test(str(v));
const lower = (s: string) => s.trim().toLowerCase();

/** The status of the workflow as it is written there, matched without case; null when it is none of them */
export function workflowStatus(workflow: string[], status: string): string | null {
  const s = lower(status);
  return workflow.find((w) => lower(w) === s) ?? null;
}

/** Statuses of the workflow among `names`, in workflow spelling, without duplicates */
const inWorkflow = (workflow: string[], names: string[]) => [...new Set(names.map((n) => workflowStatus(workflow, n)).filter((n): n is string => !!n))];

/** `transitions` of a project block; null when it has none (every change allowed) */
export function parseTransitions(raw: YamlValue | undefined, workflow: string[]): Transitions {
  if (!Array.isArray(raw)) return null;
  const out: Record<string, string[]> = {};
  for (const s of workflow) out[s] = [];
  for (const item of raw) {
    if (!isMap(item)) continue;
    const from = workflowStatus(workflow, str(item.from));
    if (!from) continue;
    out[from] = inWorkflow(workflow, [...out[from], ...list(item.to)]).filter((s) => s !== from);
  }
  return out;
}

/** YAML of the transitions, one entry per status of the workflow */
export function transitionsValue(transitions: Transitions, workflow: string[]): YamlValue | undefined {
  if (!transitions) return undefined;
  return workflow.map((from) => ({ from, to: inWorkflow(workflow, transitions[from] ?? []).filter((s) => s !== from) }));
}

/** Transitions of a preset: everything, to the neighbours (forward and back), or only to the next status */
export function presetTransitions(preset: TransitionPreset, workflow: string[]): Transitions {
  if (preset === 'free') return null;
  const out: Record<string, string[]> = {};
  workflow.forEach((s, i) => {
    const next = workflow[i + 1];
    const prev = workflow[i - 1];
    out[s] = preset === 'linear' ? [prev, next].filter((x): x is string => !!x) : next ? [next] : [];
  });
  return out;
}

/** Whether a ticket may go from one status to another. Statuses outside the workflow are not checked. */
export function canTransition(project: { workflow: string[]; transitions: Transitions }, from: string, to: string): boolean {
  if (!project.transitions) return true;
  const f = workflowStatus(project.workflow, from);
  const t = workflowStatus(project.workflow, to);
  if (!f || !t || f === t) return true;
  return (project.transitions[f] ?? []).includes(t);
}

/** Statuses a ticket in `from` can be set to (its own status first) */
export function allowedStatuses(project: { workflow: string[]; transitions: Transitions }, from: string): string[] {
  return project.workflow.filter((s) => lower(s) === lower(from) || canTransition(project, from, s));
}

/** A new random automation id */
export function newAutomationId(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const isTrigger = (s: string): s is AutomationTrigger => (AUTOMATION_TRIGGERS as readonly string[]).includes(s);
const isAction = (s: string): s is AutomationActionType => (AUTOMATION_ACTIONS as readonly string[]).includes(s);

/** `automations` of a project block; unknown triggers and actions are left out */
export function parseAutomations(raw: YamlValue | undefined): Automation[] {
  if (!Array.isArray(raw)) return [];
  const out: Automation[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isMap(item)) continue;
    const trigger = str(item.on);
    if (!isTrigger(trigger)) continue;
    const actions: AutomationAction[] = [];
    if (Array.isArray(item.actions)) {
      for (const a of item.actions) {
        if (!isMap(a)) continue;
        const [type, value] = Object.entries(a)[0] ?? [];
        if (type && isAction(type) && typeof value === 'string') actions.push({ type, value: type === 'comment' ? value : value.trim() });
      }
    }
    let id = str(item.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
    if (!id || seen.has(id)) id = `a${out.length + 1}`;
    seen.add(id);
    out.push({
      id,
      name: str(item.name),
      enabled: str(item.enabled) === '' || truthy(item.enabled),
      trigger,
      from: list(item.from),
      to: list(item.to),
      ifStatus: list(item.status),
      ifLabels: list(item.labels),
      force: truthy(item.force),
      actions,
    });
  }
  return out;
}

/** YAML of the automations; empty fields are left out */
export function automationsValue(automations: Automation[]): YamlValue | undefined {
  if (!automations.length) return undefined;
  return automations.map((a) => {
    const m: YamlMap = { id: a.id };
    if (a.name.trim()) m.name = a.name.trim();
    m.on = a.trigger;
    if (!a.enabled) m.enabled = 'false';
    if (a.trigger === 'status_changed' && a.from.length) m.from = a.from;
    if (a.trigger === 'status_changed' && a.to.length) m.to = a.to;
    if (a.ifStatus.length) m.status = a.ifStatus;
    if (a.ifLabels.length) m.labels = a.ifLabels;
    if (a.force) m.force = 'true';
    m.actions = a.actions.map((x) => ({ [x.type]: x.value }));
    return m;
  });
}

/** Renames a status everywhere in transitions and automations (the project settings rename statuses) */
export function renameWorkflowStatus(transitions: Transitions, automations: Automation[], from: string, to: string): { transitions: Transitions; automations: Automation[] } {
  const swap = (s: string) => (lower(s) === lower(from) ? to : s);
  const next = transitions ? Object.fromEntries(Object.entries(transitions).map(([k, v]) => [swap(k), v.map(swap)])) : null;
  return {
    transitions: next,
    automations: automations.map((a) => ({
      ...a,
      from: a.from.map(swap),
      to: a.to.map(swap),
      ifStatus: a.ifStatus.map(swap),
      actions: a.actions.map((x) => (x.type === 'set_status' ? { ...x, value: swap(x.value) } : x)),
    })),
  };
}

/** A merge request (GitLab) or pull request (GitHub) as automations see it */
export interface MergeRequestInfo {
  provider: 'gitlab' | 'github';
  title: string;
  url: string;
  number: number | null;
  branch: string;
  author: string;
  description: string;
}

/** Ticket ids of a project key named in a merge request: title, branch (`feature/kld-12-x`) and description */
export function ticketIdsInMergeRequest(mr: Pick<MergeRequestInfo, 'title' | 'branch' | 'description'>, key: string): string[] {
  const re = new RegExp(`(?<![A-Za-z0-9])${key}-(\\d{1,7})(?![0-9A-Za-z])`, 'gi');
  const ids = new Set<string>();
  for (const text of [mr.title, mr.branch, mr.description]) for (const m of (text ?? '').matchAll(re)) ids.add(`${key}-${Number(m[1])}`);
  return [...ids];
}
