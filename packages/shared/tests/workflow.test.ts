import { describe, expect, it } from 'vitest';
import {
  allowedStatuses,
  canTransition,
  newProjectContent,
  newTicketContent,
  parseProject,
  presetTransitions,
  renameWorkflowStatus,
  runAutomations,
  setTicketFields,
  ticketEvents,
  ticketIdsInMergeRequest,
  ticketMeta,
  writeProject,
  type Automation,
  type ProjectConfig,
} from '../src/index.js';

const base = (): ProjectConfig => parseProject(newProjectContent('KLD'))!;
const rule = (a: Partial<Automation>): Automation => ({ id: 'r1', name: 'Regel', enabled: true, trigger: 'mr_merged', from: [], to: [], ifStatus: [], ifLabels: [], force: false, actions: [], ...a });
const mr = { provider: 'gitlab' as const, title: 'KLD-7: Login', url: 'https://git.example/mr/3', number: 3, branch: 'feature/kld-7-login', author: 'anna', description: '' };

describe('transitions', () => {
  it('allows everything without transitions, and only listed changes with them', () => {
    const p = base();
    expect(canTransition(p, 'Offen', 'Erledigt')).toBe(true);
    const linear = { ...p, transitions: presetTransitions('linear', p.workflow) };
    expect(canTransition(linear, 'Offen', 'In Arbeit')).toBe(true);
    expect(canTransition(linear, 'in arbeit', 'offen')).toBe(true);
    expect(canTransition(linear, 'Offen', 'Erledigt')).toBe(false);
    // Unknown statuses (typing in the frontmatter) are not checked; the same status always works
    expect(canTransition(linear, 'Offe', 'Erledigt')).toBe(true);
    expect(canTransition(linear, 'Review', 'Review')).toBe(true);
    expect(allowedStatuses(linear, 'Review')).toEqual(['In Arbeit', 'Review', 'Erledigt']);
    const forward = { ...p, transitions: presetTransitions('forward', p.workflow) };
    expect(allowedStatuses(forward, 'Erledigt')).toEqual(['Erledigt']);
    expect(presetTransitions('free', p.workflow)).toBeNull();
  });

  it('round-trips transitions and automations through the frontmatter', () => {
    const content = newProjectContent('KLD');
    const p = base();
    const automations: Automation[] = [
      rule({ id: 'm1', name: 'Merge', ifStatus: ['In Arbeit', 'Review'], force: true, actions: [{ type: 'set_status', value: 'Erledigt' }, { type: 'comment', value: 'Gemergt: {{mr.url}}\nDanke' }] }),
      rule({ id: 's1', name: '', trigger: 'status_changed', enabled: false, from: ['Offen'], to: ['In Arbeit'], ifLabels: ['bug'], actions: [{ type: 'set_assignee', value: '{{actor}}' }] }),
    ];
    const next = writeProject(content, { ...p, transitions: presetTransitions('linear', p.workflow), automations });
    const back = parseProject(next)!;
    expect(back.transitions).toEqual(presetTransitions('linear', p.workflow));
    expect(back.automations).toEqual(automations);
    // The rest of the database note stays
    expect(next).toContain('views:');
    // Clearing them removes the keys again
    expect(writeProject(next, { ...back, transitions: null, automations: [] })).not.toMatch(/transitions|automations/);
  });

  it('ignores unknown statuses, triggers and actions', () => {
    const p = parseProject(
      '---\ntype: database\nproject:\n  key: AB\n  workflow: [A, B]\n  transitions:\n    - from: a\n      to: [b, X, A]\n    - from: X\n      to: [A]\n  automations:\n    - on: whatever\n      actions:\n        - set_status: B\n    - on: ticket_created\n      actions:\n        - explode: now\n        - add_label: neu\n---\n'
    )!;
    expect(p.transitions).toEqual({ A: ['B'], B: [] });
    expect(p.automations).toHaveLength(1);
    expect(p.automations[0]).toMatchObject({ id: 'a1', trigger: 'ticket_created', enabled: true, actions: [{ type: 'add_label', value: 'neu' }] });
  });

  it('renames a status in transitions and automations', () => {
    const p = base();
    const r = renameWorkflowStatus(presetTransitions('forward', p.workflow), [rule({ ifStatus: ['Review'], actions: [{ type: 'set_status', value: 'Review' }] })], 'Review', 'Prüfung');
    expect(r.transitions!['In Arbeit']).toEqual(['Prüfung']);
    expect(r.transitions!['Prüfung']).toEqual(['Erledigt']);
    expect(r.automations[0]).toMatchObject({ ifStatus: ['Prüfung'], actions: [{ value: 'Prüfung' }] });
  });
});

describe('automations', () => {
  const ticket = (status: string, labels: string[] = []) => newTicketContent({ key: 'KLD', status, labels }).replace('KLD-?', 'KLD-7');

  it('sets the status when a merge request is merged, only for matching tickets', () => {
    const p = { ...base(), automations: [rule({ ifStatus: ['In Arbeit', 'Review'], actions: [{ type: 'set_status', value: 'Erledigt' }, { type: 'comment', value: 'Gemergt von {{mr.author}}: {{mr.url}}' }] })] };
    const run = runAutomations(p, ticket('Review'), [{ type: 'mr_merged', mr }]);
    expect(ticketMeta(run.content).status).toBe('Erledigt');
    expect(run.content.trimEnd().endsWith('Gemergt von anna: https://git.example/mr/3')).toBe(true);
    expect(run.applied).toEqual([{ id: 'r1', name: 'Regel' }]);
    // Another status, another event or a switched off rule: nothing happens
    expect(runAutomations(p, ticket('Offen'), [{ type: 'mr_merged', mr }]).applied).toEqual([]);
    expect(runAutomations(p, ticket('Review'), [{ type: 'mr_opened', mr }]).applied).toEqual([]);
    expect(runAutomations({ ...p, automations: [{ ...p.automations[0], enabled: false }] }, ticket('Review'), [{ type: 'mr_merged', mr }]).applied).toEqual([]);
  });

  it('follows the transitions unless the rule may skip them', () => {
    const p = { ...base(), transitions: presetTransitions('forward', base().workflow) };
    const set = rule({ actions: [{ type: 'set_status', value: 'Erledigt' }] });
    const blocked = runAutomations({ ...p, automations: [set] }, ticket('In Arbeit'), [{ type: 'mr_merged', mr }]);
    expect(ticketMeta(blocked.content).status).toBe('In Arbeit');
    expect(blocked.skipped).toEqual([{ id: 'r1', name: 'Regel', reason: 'transition' }]);
    const forced = runAutomations({ ...p, automations: [{ ...set, force: true }] }, ticket('In Arbeit'), [{ type: 'mr_merged', mr }]);
    expect(ticketMeta(forced.content).status).toBe('Erledigt');
  });

  it('reacts to status changes with from/to filters, labels and the actor', () => {
    const p = {
      ...base(),
      automations: [
        rule({ trigger: 'status_changed', from: ['Offen'], to: ['In Arbeit'], actions: [{ type: 'set_assignee', value: '{{actor}}' }, { type: 'add_label', value: 'läuft' }] }),
        rule({ id: 'r2', trigger: 'status_changed', to: ['Erledigt'], ifLabels: ['bug'], actions: [{ type: 'set_priority', value: 'low' }, { type: 'remove_label', value: 'Bug' }] }),
      ],
    };
    const started = runAutomations(p, ticket('In Arbeit'), [{ type: 'status_changed', from: 'Offen', to: 'In Arbeit' }], { actor: 'ben' });
    expect(ticketMeta(started.content)).toMatchObject({ assignee: 'ben', labels: ['läuft'] });
    const done = runAutomations(p, ticket('Erledigt', ['bug', 'ui']), [{ type: 'status_changed', from: 'Review', to: 'Erledigt' }]);
    expect(ticketMeta(done.content)).toMatchObject({ priority: 'low', labels: ['ui'] });
    expect(runAutomations(p, ticket('Erledigt', ['ui']), [{ type: 'status_changed', from: 'Review', to: 'Erledigt' }]).applied).toEqual([]);
  });

  it('keeps merge request text on one line in comments', () => {
    const p = { ...base(), automations: [rule({ actions: [{ type: 'comment', value: '{{mr.title}}' }] })] };
    const run = runAutomations(p, ticket('Review'), [{ type: 'mr_merged', mr: { ...mr, title: 'a\n---\nb' } }]);
    expect(run.content.trimEnd().split('\n').pop()).toBe('a --- b');
  });

  it('derives events from the stored and the pushed ticket', () => {
    const progress = (done: number, total: number) => ({ done, total });
    expect(ticketEvents(null, { status: 'Offen', progress: progress(0, 0) })).toEqual([{ type: 'ticket_created' }]);
    expect(ticketEvents({ status: 'Offen', progress: progress(1, 2) }, { status: 'offen', progress: progress(2, 2) })).toEqual([{ type: 'subtasks_done' }]);
    expect(ticketEvents({ status: 'Offen', progress: progress(2, 2) }, { status: 'Review', progress: progress(2, 2) })).toEqual([{ type: 'status_changed', from: 'Offen', to: 'Review' }]);
    expect(setTicketFields(ticket('Offen'), {})).toBe(ticket('Offen'));
  });

  it('finds ticket ids in merge requests', () => {
    expect(ticketIdsInMergeRequest({ title: 'Fix KLD-12 and kld-3', branch: 'feature/KLD-40-login', description: 'Closes KLD-12, XKLD-9, KLD-77a' }, 'KLD')).toEqual(['KLD-12', 'KLD-3', 'KLD-40']);
  });
});
