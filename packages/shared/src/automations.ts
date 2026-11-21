/**
 * Runs the automations of a ticket project (#workflow): the server calls `runAutomations` when a pushed ticket
 * was created, changed its status or finished its sub-tasks, and when a webhook reports a merge request. Rules
 * match on the ticket as it is when the event happens; their actions then apply one after another. A status
 * change of an automation follows the transitions unless the automation may skip them (`force`). Automations do
 * not trigger each other within one run, so a run always ends.
 */

import { canTransition, workflowStatus, type Automation, type AutomationTrigger, type MergeRequestInfo, type Transitions } from './workflow.js';
import { PRIORITIES, setTicketFields, ticketMeta } from './tickets.js';

export type TicketEvent =
  | { type: 'ticket_created' }
  | { type: 'status_changed'; from: string; to: string }
  | { type: 'subtasks_done' }
  | { type: 'mr_opened' | 'mr_merged' | 'mr_closed'; mr: MergeRequestInfo };

export interface AutomationProject {
  key: string;
  workflow: string[];
  transitions: Transitions;
  automations: Automation[];
}

export interface AutomationRun {
  content: string;
  /** Automations whose actions ran (at least one changed something or was a comment) */
  applied: { id: string; name: string }[];
  /** Actions that could not run, e.g. a status change the transitions do not allow */
  skipped: { id: string; name: string; reason: 'transition' | 'unknown_status' | 'invalid' }[];
}

export interface AutomationContext {
  /** User name of who caused the event (the pusher, or the creator of the webhook) */
  actor?: string;
  today?: Date;
}

const lower = (s: string) => s.trim().toLowerCase();
const anyOf = (wanted: string[], value: string) => !wanted.length || wanted.some((w) => lower(w) === lower(value));
/** One line, at most 300 characters: values from outside (merge request titles) must not shape the note */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim().slice(0, 300);

/** Whether an automation reacts to an event on a ticket in this state */
export function automationMatches(a: Automation, event: TicketEvent, ticket: { status: string; labels: string[] }): boolean {
  if (!a.enabled || a.trigger !== event.type || !a.actions.length) return false;
  if (event.type === 'status_changed' && (!anyOf(a.from, event.from) || !anyOf(a.to, event.to))) return false;
  if (!anyOf(a.ifStatus, ticket.status)) return false;
  if (a.ifLabels.length && !ticket.labels.some((l) => a.ifLabels.some((w) => lower(w) === lower(l)))) return false;
  return true;
}

/** Fills `{{mr.title}}`, `{{mr.url}}`, `{{status}}`, … in a comment */
export function fillCommentPlaceholders(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-z.]+)\s*\}\}/gi, (m, name: string) => (name.toLowerCase() in vars ? vars[name.toLowerCase()] : m));
}

/** Applies the automations that react to the events; the content unchanged when none does */
export function runAutomations(project: AutomationProject, content: string, events: TicketEvent[], ctx: AutomationContext = {}): AutomationRun {
  const run: AutomationRun = { content, applied: [], skipped: [] };
  if (!project.automations.length || !events.length) return run;
  const before = ticketMeta(content);
  const today = ctx.today ?? new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  for (const event of events) {
    for (const a of project.automations) {
      if (!automationMatches(a, event, before)) continue;
      let did = false;
      for (const action of a.actions) {
        const now = ticketMeta(run.content);
        const skip = (reason: AutomationRun['skipped'][number]['reason']) => run.skipped.push({ id: a.id, name: a.name, reason });
        switch (action.type) {
          case 'set_status': {
            const target = workflowStatus(project.workflow, action.value);
            if (!target) {
              skip('unknown_status');
              break;
            }
            if (lower(target) === lower(now.status)) break;
            if (!a.force && !canTransition(project, now.status, target)) {
              skip('transition');
              break;
            }
            run.content = setTicketFields(run.content, { status: target });
            did = true;
            break;
          }
          case 'set_priority': {
            const p = lower(action.value);
            if (!(PRIORITIES as readonly string[]).includes(p)) {
              skip('invalid');
              break;
            }
            if (now.priority !== p) {
              run.content = setTicketFields(run.content, { priority: p });
              did = true;
            }
            break;
          }
          case 'set_assignee': {
            const name = action.value.trim().replace(/^@/, '');
            const who = name === '{{actor}}' ? (ctx.actor ?? '') : name;
            if ((now.assignee ?? '') !== who) {
              run.content = setTicketFields(run.content, { assignee: who || null });
              did = true;
            }
            break;
          }
          case 'add_label':
          case 'remove_label': {
            const label = action.value.trim();
            if (!label) {
              skip('invalid');
              break;
            }
            const has = now.labels.some((l) => lower(l) === lower(label));
            if (action.type === 'add_label' && !has) {
              run.content = setTicketFields(run.content, { labels: [...now.labels, label] });
              did = true;
            } else if (action.type === 'remove_label' && has) {
              run.content = setTicketFields(run.content, { labels: now.labels.filter((l) => lower(l) !== lower(label)) });
              did = true;
            }
            break;
          }
          case 'comment': {
            const mr = 'mr' in event ? event.mr : null;
            const vars: Record<string, string> = {
              status: now.status,
              from: event.type === 'status_changed' ? event.from : '',
              to: event.type === 'status_changed' ? event.to : '',
              actor: ctx.actor ?? '',
              date,
              ticket: now.id ?? '',
              'mr.title': mr ? oneLine(mr.title) : '',
              'mr.url': mr ? oneLine(mr.url) : '',
              'mr.number': mr?.number != null ? String(mr.number) : '',
              'mr.branch': mr ? oneLine(mr.branch) : '',
              'mr.author': mr ? oneLine(mr.author) : '',
            };
            const text = fillCommentPlaceholders(action.value, vars).trim();
            if (!text) break;
            run.content = `${run.content.trimEnd()}\n\n${text}\n`;
            did = true;
            break;
          }
        }
      }
      if (did) run.applied.push({ id: a.id, name: a.name });
    }
  }
  return run;
}

/** Events of a pushed ticket: created, status changed, all sub-tasks done (compared to the stored text) */
export function ticketEvents(previous: { status: string; progress: { done: number; total: number } } | null, next: { status: string; progress: { done: number; total: number } }): TicketEvent[] {
  if (!previous) return [{ type: 'ticket_created' }];
  const events: TicketEvent[] = [];
  if (lower(previous.status) !== lower(next.status)) events.push({ type: 'status_changed', from: previous.status, to: next.status });
  const wasDone = previous.progress.total > 0 && previous.progress.done === previous.progress.total;
  if (!wasDone && next.progress.total > 0 && next.progress.done === next.progress.total) events.push({ type: 'subtasks_done' });
  return events;
}

/** Triggers that come from a merge request (GitLab) or pull request (GitHub) through a webhook */
export const isGitTrigger = (t: AutomationTrigger) => t === 'mr_opened' || t === 'mr_merged' || t === 'mr_closed';
