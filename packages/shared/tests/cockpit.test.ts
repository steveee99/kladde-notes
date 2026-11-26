import { describe, expect, it } from 'vitest';
import {
  applyWidget,
  blankWidget,
  defaultDashboard,
  highlightOf,
  isDashboardPath,
  isHiddenPath,
  matchFilter,
  normalizeFeatures,
  normalizeWidget,
  parseCockpitBlock,
  parseDashboardNote,
  parseSpan,
  readShared,
  resolveParams,
  serializeDashboard,
  shareDashboard,
  shareWidget,
  widgetVariables,
  type CockpitRow,
} from '../src/index';

const NOW = Date.UTC(2026, 10, 26, 12);
const row = (id: string, values: CockpitRow['values']): CockpitRow => ({ id, values });

describe('cockpit model', () => {
  it('is an opt-in feature', () => {
    expect(normalizeFeatures({}).cockpit.enabled).toBe(false);
    expect(normalizeFeatures({ cockpit: { enabled: true } }).cockpit.enabled).toBe(true);
  });

  it('hides dashboard notes', () => {
    expect(isDashboardPath('_dashboard-0f9c3a2e-1111-4222-8333-444455556666.md')).toBe(true);
    expect(isDashboardPath('Team/_dashboard-0f9c3a2e-1111.md')).toBe(true);
    expect(isDashboardPath('dashboard.md')).toBe(false);
    expect(isHiddenPath('_dashboard-0f9c3a2e-1111.md')).toBe(true);
  });

  it('normalizes untrusted widgets', () => {
    expect(normalizeWidget({ source: { kind: 'shell.exec' } })).toBeNull();
    const w = normalizeWidget({
      title: 'x'.repeat(500),
      source: { kind: 'gitlab.mrs', params: { scope: 'nope', labels: 'a, b', evil: 'drop me', project: 'team/api' } },
      fields: ['title', 'token', 'title'],
      filters: [{ field: 'title', op: 'contains', value: 'fix' }, { field: 'secret', op: 'eq', value: '1' }],
      limit: 9999,
      view: 'kanban',
      width: 2,
    })!;
    expect(w.title).toHaveLength(120);
    expect(w.source.params).toEqual({ scope: 'authored', state: 'opened', draft: 'any', labels: ['a', 'b'], project: 'team/api' });
    expect(w.fields).toEqual(['title']);
    expect(w.filters).toEqual([{ field: 'title', op: 'contains', value: 'fix' }]);
    expect(w.limit).toBe(100);
    expect(w.view).toBe('list');
    expect(w.width).toBe(2);
  });

  it('round-trips a dashboard through its note', () => {
    const d = defaultDashboard('de');
    expect(d.widgets.length).toBeGreaterThanOrEqual(5);
    expect(d.widgets.some((w) => w.source.kind === 'gitlab.jobs' && w.notify)).toBe(true);
    const note = serializeDashboard(d);
    expect(note.startsWith('---\ntype: dashboard\n---')).toBe(true);
    expect(parseDashboardNote(note)).toEqual(d);
    expect(parseDashboardNote('# Just a note')).toBeNull();
    expect(parseDashboardNote('---\ntype: habits\n---\n```cockpit-dashboard\n{}\n```')).toBeNull();
  });

  it('shares widgets and dashboards without ids or variable values', () => {
    const d = { ...defaultDashboard('en'), vars: { repo: 'secret/project' } };
    const shared = readShared(shareDashboard(d));
    expect(shared?.kind).toBe('dashboard');
    if (shared?.kind !== 'dashboard') return;
    expect(shared.dashboard.vars).toEqual({ repo: '' });
    expect(shared.dashboard.widgets.map((w) => w.id)).not.toEqual(d.widgets.map((w) => w.id));
    expect(shared.dashboard.widgets.map((w) => w.title)).toEqual(d.widgets.map((w) => w.title));

    const w = d.widgets[0];
    const json = shareWidget(w);
    expect(json).not.toContain(w.id);
    const back = readShared(json);
    expect(back?.kind === 'widgets' && back.widgets[0].source).toEqual(w.source);
    // A fenced paste and a list work too
    expect(readShared('```json\n' + json + '\n```')?.kind).toBe('widgets');
    const two = readShared(JSON.stringify([JSON.parse(json), JSON.parse(json)]));
    expect(two?.kind === 'widgets' && two.widgets.length).toBe(2);
    expect(readShared('hello')).toBeNull();
  });

  it('reads the short YAML form of a block', () => {
    const w = parseCockpitBlock('source: gitlab.mrs\ntitle: Zum Ticket\nproject: {{this.repo}}\nsearch: {{this.jira}}\nscope: all\nfields: [iid, title, status]\nsort: -updated')!;
    expect(w.title).toBe('Zum Ticket');
    expect(w.source).toEqual({ kind: 'gitlab.mrs', params: { scope: 'all', project: '{{this.repo}}', state: 'opened', draft: 'any', search: '{{this.jira}}' } });
    expect(w.fields).toEqual(['iid', 'title', 'status']);
    expect(w.sort).toEqual({ field: 'updated', dir: 'desc' });
    expect(widgetVariables(w).sort()).toEqual(['this.jira', 'this.repo']);
    expect(parseCockpitBlock('source: nope')).toBeNull();
    expect(parseCockpitBlock(JSON.stringify(blankWidget('jira.issues')))?.source.kind).toBe('jira.issues');
  });

  it('fills variables and reports missing ones', () => {
    const { params, missing } = resolveParams({ project: '{{var:repo}}', group: '{{var:team|platform}}', labels: ['{{this.area}}', 'x'], search: '{{me}}' }, { 'this.area': 'billing' });
    expect(params).toEqual({ project: '', group: 'platform', labels: ['billing', 'x'], search: '{{me}}' });
    expect(missing).toEqual(['repo']);
  });

  it('filters, sorts, cuts and highlights rows generically', () => {
    const rows = [
      row('a', { name: 'deploy-prod', ref: 'main', finished: NOW - 2 * 3_600_000, labels: ['ops'] }),
      row('b', { name: 'unit-tests', ref: 'feature/x', finished: NOW - 30 * 3_600_000, labels: [] }),
      row('c', { name: 'deploy-stage', ref: 'main', finished: NOW - 5 * 3_600_000, labels: ['ops', 'stage'] }),
    ];
    const res = applyWidget(rows, { filters: [{ field: 'name', op: 'contains', value: 'DEPLOY' }], sort: { field: 'finished', dir: 'desc' }, limit: 1 }, NOW);
    expect(res).toEqual({ rows: [rows[0]], total: 2 });
    expect(matchFilter(rows[1], { field: 'finished', op: 'older_than', value: '1d' }, NOW)).toBe(true);
    expect(matchFilter(rows[0], { field: 'finished', op: 'newer_than', value: '3h' }, NOW)).toBe(true);
    expect(matchFilter(rows[2], { field: 'labels', op: 'eq', value: 'stage' }, NOW)).toBe(true);
    expect(matchFilter(rows[1], { field: 'labels', op: 'empty', value: '' }, NOW)).toBe(true);
    expect(matchFilter(rows[0], { field: 'ref', op: 'matches', value: '^(main|master)$' }, NOW)).toBe(true);
    // Patterns that could backtrack for long are refused (built at run time: the literal alone is no regex here)
    const nested = ['(a', '+)', '+$'].join('');
    expect(matchFilter(rows[0], { field: 'ref', op: 'matches', value: nested }, NOW)).toBe(false);
    expect(highlightOf(rows[0], { highlight: [{ when: { field: 'ref', op: 'eq', value: 'main' }, tone: 'red' }] }, NOW)).toBe('red');
    expect(highlightOf(rows[1], { highlight: [{ when: { field: 'ref', op: 'eq', value: 'main' }, tone: 'red' }] }, NOW)).toBeNull();
  });

  it('reads time spans', () => {
    expect(parseSpan('24h')).toBe(86_400_000);
    expect(parseSpan('3d')).toBe(3 * 86_400_000);
    expect(parseSpan('2w')).toBe(14 * 86_400_000);
    expect(parseSpan('90m')).toBe(90 * 60_000);
    expect(parseSpan('soon')).toBeNull();
  });
});
