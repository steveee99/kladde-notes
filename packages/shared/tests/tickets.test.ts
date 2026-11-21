import { describe, expect, it } from 'vitest';
import {
  assignTicketNumber,
  canHaveParent,
  childKindsOf,
  cleanProjectKey,
  isMilestoneContent,
  isTicketContent,
  milestoneMeta,
  milestoneProgress,
  newMilestoneContent,
  newProjectContent,
  newTicketContent,
  numberedTicketId,
  parseDatabase,
  parseProject,
  rankBetween,
  releaseNotesContent,
  roadmapOffset,
  roadmapWeeks,
  setTicketFields,
  statusCategory,
  subtaskProgress,
  ticketIdPattern,
  ticketKindOf,
  ticketMeta,
  writeProject,
} from '../src/index.js';

describe('projects', () => {
  it('creates a database note that is a project with board and backlog', () => {
    const content = newProjectContent('KLD');
    const project = parseProject(content)!;
    expect(project).toEqual({ key: 'KLD', workflow: ['Offen', 'In Arbeit', 'Review', 'Erledigt'], active: ['In Arbeit', 'Review'], done: ['Erledigt'], requireDocs: false, transitions: null, automations: [] });
    const db = parseDatabase(content)!;
    expect(db.properties.map((p) => p.name)).toEqual(['kind', 'parent', 'status', 'priority', 'milestone', 'assignee', 'estimate', 'labels']);
    expect(db.views.map((v) => v.type)).toEqual(['board', 'table']);
    expect(db.views[0].group).toBe('status');
  });

  it('needs a valid key and keeps statuses of the categories inside the workflow', () => {
    expect(parseProject('---\ntype: database\n---\n')).toBeNull();
    expect(parseProject('---\ntype: database\nproject:\n  key: kl\n---\n')!.key).toBe('KL');
    expect(parseProject('---\ntype: database\nproject:\n  key: 1X\n---\n')).toBeNull();
    const p = parseProject('---\ntype: database\nproject:\n  key: AB\n  workflow: [Neu, Läuft, Fertig]\n  active: [Läuft, Fertig, Gibtsnicht]\n  done: [Fertig]\n  requireDocs: true\n---\n')!;
    expect(p.active).toEqual(['Läuft']);
    expect(p.done).toEqual(['Fertig']);
    expect(p.requireDocs).toBe(true);
    // Without `done` the last status finishes a ticket
    expect(parseProject('---\ntype: database\nproject:\n  key: AB\n  workflow: [A, B]\n---\n')!.done).toEqual(['B']);
  });

  it('writes project settings back without touching the schema', () => {
    const content = newProjectContent('KLD', 'en');
    const next = writeProject(content, { ...parseProject(content)!, key: 'NEW', requireDocs: true });
    expect(parseProject(next)).toMatchObject({ key: 'NEW', requireDocs: true, done: ['Done'] });
    expect(parseDatabase(next)!.properties).toHaveLength(8);
  });

  it('suggests keys from names', () => {
    expect(cleanProjectKey('kld')).toBe('KLD');
    expect(cleanProjectKey('Kladde Notes')).toBe('KN');
    expect(cleanProjectKey('Gamma')).toBe('GAMMA');
    expect(cleanProjectKey('Projekt Gamma 2')).toBe('PG2');
    expect(cleanProjectKey('!')).toBeNull();
  });

  it('sorts statuses into categories', () => {
    const p = parseProject(newProjectContent('KLD'))!;
    expect(statusCategory(p, 'offen')).toBe('open');
    expect(statusCategory(p, 'In Arbeit')).toBe('active');
    expect(statusCategory(p, 'erledigt')).toBe('done');
    expect(statusCategory(p, 'Unbekannt')).toBe('open');
  });
});

describe('tickets', () => {
  const ticket = newTicketContent({ key: 'KLD', status: 'Offen', assignee: 'ben', milestone: 'v2.14', labels: ['sync'], docs: ['Sync-Protokoll'], estimate: 3, description: 'Zwei Clients…' });

  it('starts with a provisional id and reads back its fields', () => {
    expect(isTicketContent(ticket)).toBe(true);
    expect(isMilestoneContent(ticket)).toBe(false);
    expect(ticket).toContain('id: "KLD-?"');
    expect(ticket).toContain('assignee: "@ben"');
    expect(ticket).toContain('estimate: 3\n');
    expect(ticket).toMatch(/---\n\nZwei Clients…\n$/);
    const m = ticketMeta(ticket);
    expect(m).toMatchObject({ id: 'KLD-?', key: 'KLD', number: null, provisional: true, status: 'Offen', priority: 'medium', milestone: 'v2.14', assignee: 'ben', estimate: 3, labels: ['sync'], docs: ['Sync-Protokoll'], blocks: [] });
  });

  it('gets its number from the server once', () => {
    let n = 117;
    const numbered = assignTicketNumber(ticket, () => ++n)!;
    expect(ticketMeta(numbered)).toMatchObject({ id: 'KLD-118', number: 118, provisional: false });
    expect(numbered).toContain('\nid: KLD-118\n');
    expect(numbered.replace('id: KLD-118', 'id: "KLD-?"')).toBe(ticket);
    expect(assignTicketNumber(numbered, () => 1)).toBeNull();
    expect(numberedTicketId(numbered)).toEqual({ key: 'KLD', number: 118 });
    // Only tickets, and only the frontmatter
    expect(assignTicketNumber('---\nid: KLD-?\n---\n', () => 1)).toBeNull();
    expect(assignTicketNumber('---\ntype: ticket\n---\nid: KLD-?\n', () => 1)).toBeNull();
    expect(isTicketContent('---\ntitle: x\n---\ntype: ticket\n---\n')).toBe(false);
  });

  it('changes single fields and removes empty ones', () => {
    let c = setTicketFields(ticket, { status: 'In Arbeit', assignee: null, blocks: ['KLD-121'], rank: 1500 });
    const m = ticketMeta(c);
    expect(m.status).toBe('In Arbeit');
    expect(m.assignee).toBeNull();
    expect(m.blocks).toEqual(['KLD-121']);
    expect(m.rank).toBe(1500);
    expect(c).toContain('rank: 1500\n');
    c = setTicketFields(c, { docs: [] });
    expect(ticketMeta(c).docs).toEqual([]);
    expect(c).not.toContain('docs:');
  });

  it('reads German priorities and assignees with or without @', () => {
    expect(ticketMeta('---\ntype: ticket\npriority: hoch\nassignee: "@anna"\n---\n')).toMatchObject({ priority: 'high', assignee: 'anna' });
    expect(ticketMeta('---\ntype: ticket\npriority: x\nassignee: cara\n---\n')).toMatchObject({ priority: null, assignee: 'cara' });
  });

  it('counts sub-tasks', () => {
    expect(subtaskProgress('- [x] a\n- [ ] b\n- [x] c\n')).toEqual({ done: 2, total: 3 });
  });

  it('finds ticket ids of known projects in text', () => {
    const re = ticketIdPattern(['KLD', 'AB', 'bad key'])!;
    const found = [...'Siehe KLD-118, AB-2 und XKLD-3, KLD-12a oder /KLD-4'.matchAll(re)].map((m) => m[0]);
    expect(found).toEqual(['KLD-118', 'AB-2']);
    expect(ticketIdPattern([])).toBeNull();
  });

  it('ranks between neighbours', () => {
    expect(rankBetween(null, null)).toBe(1000);
    expect(rankBetween(null, 1000)).toBe(0);
    expect(rankBetween(1000, null)).toBe(2000);
    expect(rankBetween(1000, 2000)).toBe(1500);
  });
});

describe('ticket kinds', () => {
  it('reads the kind and the parent, tasks by default', () => {
    expect(ticketMeta('---\ntype: ticket\nid: KLD-1\n---\n').kind).toBe('task');
    const m = ticketMeta('---\ntype: ticket\nid: KLD-2\nkind: Epic\nparent: "[[KLD-1]]"\n---\n');
    expect(m.kind).toBe('epic');
    expect(m.parent).toBe('KLD-1');
    expect(ticketKindOf('Story')).toBe('feature');
    expect(ticketKindOf('Unteraufgabe')).toBe('subtask');
    expect(ticketKindOf('sub-task')).toBe('subtask');
    expect(ticketKindOf('Fehler')).toBe('bug');
    expect(ticketKindOf('whatever')).toBe('task');
  });

  it('writes kind and parent into new tickets and changes them', () => {
    const content = newTicketContent({ key: 'KLD', status: 'Offen', kind: 'subtask', parent: 'KLD-7' });
    expect(content).toContain('kind: subtask');
    expect(content).toContain('parent: "[[KLD-7]]"');
    const meta = ticketMeta(setTicketFields(content, { kind: 'bug', parent: null }));
    expect(meta.kind).toBe('bug');
    expect(meta.parent).toBeNull();
    expect(newTicketContent({ key: 'KLD', status: 'Offen' })).toContain('kind: task');
  });

  it('knows which kind may hang below which', () => {
    expect(canHaveParent('feature', 'epic')).toBe(true);
    expect(canHaveParent('subtask', 'task')).toBe(true);
    expect(canHaveParent('epic', 'feature')).toBe(false);
    expect(canHaveParent('task', 'subtask')).toBe(false);
    expect(childKindsOf('epic')).toEqual(['feature', 'task', 'bug']);
    expect(childKindsOf('feature')[0]).toBe('task');
    expect(childKindsOf('subtask')).toEqual([]);
  });
});

describe('milestones', () => {
  it('reads their dates and release', () => {
    const c = newMilestoneContent({ id: 'v2.14', start: '2026-11-23', due: '2026-12-18', release: '2.14.0', goal: 'Tickets-MVP' });
    expect(isMilestoneContent(c)).toBe(true);
    expect(milestoneMeta(c)).toEqual({ id: 'v2.14', start: '2026-11-23', due: '2026-12-18', release: '2.14.0', goal: 'Tickets-MVP' });
    expect(milestoneMeta('---\ntype: milestone\ndue: morgen\n---\n').due).toBeNull();
  });

  it('measures progress and warns when time runs ahead of it', () => {
    const tickets = [
      { category: 'done' as const, estimate: 3 },
      { category: 'active' as const, estimate: 5 },
      { category: 'open' as const, estimate: null },
      { category: 'open' as const, estimate: 2 },
    ];
    const m = { start: '2026-11-01', due: '2026-11-30' };
    const early = milestoneProgress(m, tickets, new Date(2026, 10, 5));
    expect(early).toMatchObject({ total: 4, done: 1, points: 10, donePoints: 3, ratio: 0.25, daysLeft: 25, atRisk: false });
    expect(milestoneProgress(m, tickets, new Date(2026, 10, 25)).atRisk).toBe(true);
    expect(milestoneProgress(m, tickets, new Date(2026, 11, 2))).toMatchObject({ daysLeft: -2, atRisk: true });
    expect(milestoneProgress(m, tickets.map((t) => ({ ...t, category: 'done' as const })), new Date(2026, 11, 2)).atRisk).toBe(false);
  });

  it('lays out weeks for the roadmap', () => {
    const { start, weeks } = roadmapWeeks([{ start: '2026-11-23', due: '2026-12-18' }], new Date(2026, 10, 20));
    expect(start.toISOString().slice(0, 10)).toBe('2026-11-16');
    expect(weeks[0].week).toBe(47);
    expect(weeks.length).toBeGreaterThanOrEqual(8);
    expect(roadmapOffset('2026-11-16', start, weeks.length)).toBe(0);
    expect(roadmapOffset('2026-11-23', start, 8)).toBeCloseTo(1 / 8);
  });

  it('builds release notes from finished tickets', () => {
    const notes = releaseNotesContent({ title: 'v2.14 Tickets', release: '2.14.0', goal: 'MVP' }, [
      { id: 'KLD-118', title: 'Nummern offline', labels: ['sync'] },
      { id: 'KLD-119', title: 'Chips', labels: [] },
    ], 'de', new Date(2026, 11, 18));
    expect(notes).toContain('Meilenstein: [[v2.14 Tickets]] · 2026-12-18');
    expect(notes).toContain('## sync\n\n- Nummern offline ([[KLD-118]])');
    expect(notes).toContain('## Sonstiges\n\n- Chips ([[KLD-119]])');
    expect(notes).toContain('release: 2.14.0');
  });
});
