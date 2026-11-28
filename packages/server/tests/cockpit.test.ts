import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { normalizeFeatures, serializeDashboard, type CockpitConnections, type CockpitDashboard, type CockpitResult, type CockpitWidget } from '@kladde/shared';
import { DataCipher } from '../src/crypto';
import { openDatabase } from '../src/db';
import { NoteStore } from '../src/NoteStore';
import { UserStore } from '../src/UserStore';
import { NotificationStore, notificationPush, type Delivery } from '../src/NotificationStore';
import { AuditLog } from '../src/security/AuditLog';
import { ServerSettings } from '../src/ServerSettings';
import { RemoteInstances } from '../src/remote/RemoteInstances';
import { RemoteFetcher } from '../src/remote/RemoteFetcher';
import type { HttpRequest, HttpResponse } from '../src/confluence/ConfluenceClient';
import { CockpitStore } from '../src/cockpit/CockpitStore';
import { CockpitService, cockpitHosts, normalizeJiraUrl } from '../src/cockpit/CockpitService';
import { CockpitWatch } from '../src/cockpit/CockpitWatch';
import { cockpitRouter } from '../src/cockpit/router';

const SHARED_TOKEN = 'glpat-shared-admin-token';
const ANNA_TOKEN = 'glpat-anna-personal';
const HOUR = 3_600_000;
const seen: string[] = [];

/** Jobs of each project, newest first (as GitLab lists them) */
const jobs: Record<string, unknown[]> = {};
function setJobs(now: number) {
  jobs['1'] = [
    { id: 105, name: 'deploy', stage: 'deploy', ref: 'main', status: 'failed', failure_reason: 'script_failure', finished_at: new Date(now - 1 * HOUR).toISOString(), web_url: `${base}/team/api/-/jobs/105`, user: { username: 'ben' }, pipeline: { id: 900 }, commit: { title: 'Ship it' }, duration: 61.4 },
    { id: 104, name: 'unit', stage: 'test', ref: 'main', status: 'success', finished_at: new Date(now - 2 * HOUR).toISOString() },
    { id: 103, name: 'unit', stage: 'test', ref: 'main', status: 'failed', finished_at: new Date(now - 3 * HOUR).toISOString() },
    { id: 102, name: 'lint', stage: 'test', ref: 'main', status: 'failed', allow_failure: true, finished_at: new Date(now - 3 * HOUR).toISOString() },
    { id: 101, name: 'deploy', stage: 'deploy', ref: 'main', status: 'failed', finished_at: new Date(now - 50 * HOUR).toISOString() },
  ];
  jobs['2'] = [{ id: 201, name: 'e2e', stage: 'test', ref: 'feature/x', status: 'failed', finished_at: new Date(now - 4 * HOUR).toISOString(), web_url: 'https://evil.example.com/phish' }];
}

/** Answers like GitLab's API for what the cockpit reads */
const upstream = http.createServer((req, res) => {
  seen.push(`${req.headers['private-token']} ${req.url}`);
  const json = (status: number, body: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  if (req.headers['private-token'] !== ANNA_TOKEN) return json(401, { message: '401 Unauthorized' });
  const url = new URL(req.url!, 'http://x');
  const p = url.pathname.replace(/^\/api\/v4/, '');
  const q = url.searchParams;
  if (p === '/user') return json(200, { id: 7, username: 'anna', name: 'Anna Berg' });
  if (p === '/merge_requests') {
    const mine = { iid: 12, project_id: 1, title: 'PAY-412 Rechnungsnummern <b>pro</b> Mandant', references: { full: 'team/api!12' }, author: { username: 'anna' }, reviewers: [{ username: 'ben' }], state: 'opened', detailed_merge_status: 'not_approved', draft: false, labels: ['billing'], source_branch: 'feature/PAY-412', target_branch: 'main', user_notes_count: 2, created_at: '2026-11-20T10:00:00Z', updated_at: '2026-11-25T10:00:00Z', web_url: `${base}/team/api/-/merge_requests/12` };
    const forMe = { iid: 3, project_id: 2, title: 'Faster pages', references: { full: 'team/web!3' }, author: { username: 'ben' }, state: 'opened', draft: true, labels: [], created_at: '2026-11-24T10:00:00Z', updated_at: '2026-11-26T09:00:00Z', web_url: `${base}/team/web/-/merge_requests/3` };
    if (q.get('scope') !== 'all') return json(400, { message: 'scope' });
    if (q.get('author_id') === '7') return json(200, [mine]);
    if (q.get('reviewer_id') === '7') return json(200, q.get('wip') === 'no' ? [] : [forMe]);
    return json(200, [mine, forMe]);
  }
  if (p === '/projects/team%2Fapi/merge_requests') return json(200, []);
  if (p === '/projects') {
    if (q.get('membership') !== 'true') return json(400, {});
    return json(200, [
      { id: 1, path_with_namespace: 'team/api' },
      { id: 2, path_with_namespace: 'team/web' },
      { id: 3, path_with_namespace: 'team/no-ci' },
    ]);
  }
  if (p === '/groups/team/projects') {
    const all = [
      { id: 1, name: 'API', path_with_namespace: 'team/api', namespace: { full_path: 'team' }, description: 'Billing <i>API</i>', visibility: 'internal', default_branch: 'main', topics: ['billing'], archived: false, star_count: 4, forks_count: 1, open_issues_count: 7, last_activity_at: '2026-11-26T08:00:00Z', created_at: '2024-01-01T00:00:00Z', web_url: `${base}/team/api` },
      { id: 4, name: 'Tools', path_with_namespace: 'team/infra/tools', namespace: { full_path: 'team/infra' }, archived: false, web_url: 'https://evil.example.com/team/infra/tools' },
      { id: 5, name: 'Old', path_with_namespace: 'team/old', archived: true },
    ];
    const archived = q.get('archived');
    const rows = all.filter((r) => (archived === null ? true : String(r.archived) === archived) && (q.get('include_subgroups') === 'true' || !r.path_with_namespace.startsWith('team/infra/')));
    return json(200, q.get('search') ? rows.filter((r) => r.name.toLowerCase().includes(q.get('search')!.toLowerCase())) : rows);
  }
  if (p === '/groups/team/subgroups' || p === '/groups/team/descendant_groups') {
    const direct = [{ id: 20, name: 'Infra', full_path: 'team/infra', description: 'Platform', visibility: 'private', created_at: '2025-03-01T00:00:00Z', web_url: `${base}/groups/team/infra` }];
    return json(200, p.endsWith('descendant_groups') ? [...direct, { id: 21, name: 'K8s', full_path: 'team/infra/k8s', web_url: `${base}/groups/team/infra/k8s` }] : direct);
  }
  if (p === '/projects/team%2Fapi/repository/branches') {
    const all = [
      { name: 'main', default: true, protected: true, merged: false, commit: { title: 'chore: release', author_name: 'Ben', committed_date: '2026-11-20T10:00:00Z' }, web_url: `${base}/team/api/-/tree/main` },
      { name: 'feature/SHOP-1-gutschein', default: false, protected: false, merged: false, commit: { title: 'feat: Gutschein', author_name: 'Anna', committed_date: '2026-11-25T10:00:00Z' }, web_url: 'https://evil.example/x' },
    ];
    return json(200, q.get('search') ? all.filter((b) => b.name.includes(q.get('search')!)) : all);
  }
  if (p === '/groups') return q.get('min_access_level') === '10' ? json(200, [{ id: 10, name: 'Team', full_path: 'team' }]) : json(400, {});
  if (p === '/projects/team%2Fapi/repository/commits') {
    // Release 10.100 has a fix, a picked fix, a fix under the same title, a merge commit and one only it has
    const sha = (n: number) => String(n).repeat(40).slice(0, 40);
    const c = (n: number, title: string, extra: Record<string, unknown> = {}) => ({ id: sha(n), short_id: sha(n).slice(0, 8), title, message: `${title}\n`, author_name: 'Ben', created_at: '2026-11-25T10:00:00Z', parent_ids: [sha(9)], web_url: `${base}/team/api/-/commit/${sha(n)}`, ...extra });
    const range = q.get('ref_name');
    if (range === '10.101..10.100')
      return json(200, [c(1, 'PAY-1 Fix rounding'), c(2, 'Fix login'), c(3, 'Same title fix'), c(4, "Merge branch 'x' into '10.100'", { parent_ids: [sha(1), sha(2)] }), c(5, 'Picked here', { message: `Picked here\n\n(cherry picked from commit ${sha(7)})\n` })]);
    if (range === '10.100..10.101') return json(200, [c(6, 'Fix login (again)', { message: `Fix login\n\n(cherry picked from commit ${sha(2)})\n` }), c(8, 'Same title fix'), c(7, 'Original of the pick')]);
    if (range === '10.101..10.101') return json(200, []);
    return json(404, { message: '404 Commit Not Found' });
  }
  const jm = /^\/projects\/(\d+)\/jobs$/.exec(p);
  if (jm) return jobs[jm[1]] ? json(200, jobs[jm[1]]) : json(403, { message: '403 Forbidden' });
  return json(404, { message: '404 Not Found' });
});

/** Answers like Jira Cloud's REST API v3 */
const jiraRequests: string[] = [];
async function jira(req: HttpRequest): Promise<HttpResponse> {
  const json = (status: number, body: unknown): HttpResponse => ({ status, body: Buffer.from(JSON.stringify(body)) });
  jiraRequests.push(`${req.method} ${req.url.pathname}`);
  if (req.headers.Authorization !== `Basic ${Buffer.from('anna@example.org:atlassian-token-123').toString('base64')}`) return json(401, {});
  if (req.url.pathname === '/rest/api/3/myself') return json(200, { accountId: 'acc-1', displayName: 'Anna Atlassian' });
  if (req.url.pathname === '/rest/api/3/search/jql' && req.method === 'POST') {
    const body = JSON.parse(req.body!.toString('utf8'));
    if (body.jql.includes('broken')) return json(400, { errorMessages: ["Error in the JQL Query: 'broken' is not valid."] });
    return json(200, {
      issues: [
        { key: 'PAY-412', fields: { summary: 'Rechnungsnummern', status: { name: 'In Arbeit', statusCategory: { key: 'indeterminate' } }, issuetype: { name: 'Story' }, assignee: { displayName: 'Anna' }, labels: ['billing'], duedate: '2026-12-01', updated: '2026-11-26T08:00:00.000+0000' } },
        { key: 'PAY-398', fields: { summary: 'Partitionieren', status: { name: 'Review', statusCategory: { key: 'indeterminate' } } } },
        { key: 'bad key', fields: {} },
      ],
    });
  }
  return json(404, {});
}

let base = '';
let server: Server;
let api = '';
const db = openDatabase(':memory:');
const cipher = new DataCipher(crypto.randomBytes(32));
const users = new UserStore(db);
const anna = users.createUser('anna');
const ben = users.createUser('ben');
const annaCookie = `kladde_session=${users.createSession(anna.id)}`;
const benCookie = `kladde_session=${users.createSession(ben.id)}`;
const delivered: Delivery[] = [];
const notifications = new NotificationStore(db, cipher, users, (_u, d) => delivered.push(d));
let watch: CockpitWatch;
let service: CockpitService;
const notes = new NoteStore(db, cipher, (e) => watch?.onNoteChange(e));

async function call<T>(method: string, url: string, body?: unknown, cookie = annaCookie): Promise<{ status: number; data: T }> {
  const res = await fetch(`${api}/api/cockpit${url}`, { method, headers: { cookie, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json()) as T };
}

const widget = (w: Partial<CockpitWidget> & { source: CockpitWidget['source'] }): Partial<CockpitWidget> => ({ title: 'W', filters: [], highlight: [], fields: [], ...w });

beforeAll(async () => {
  upstream.listen(0, '127.0.0.1');
  await new Promise((r) => upstream.once('listening', r));
  base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const instances = new RemoteInstances({ REMOTE_GITLAB_URL: base, REMOTE_GITLAB_TOKEN: SHARED_TOKEN }, new ServerSettings(db), cipher);
  service = new CockpitService(new CockpitStore(db, cipher), {
    gitlabHosts: cockpitHosts(() => instances.gitlabHosts(), {}, null),
    fetcher: new RemoteFetcher(instances, { timeoutMs: 2000 }),
    jiraTransport: jira,
    jiraAllowPrivate: false,
  });
  watch = new CockpitWatch({ service, notifications, isPerson: (id) => !!users.getUser(id), features: () => normalizeFeatures({ cockpit: { enabled: true } }) });
  const app = express();
  app.use('/api', express.json({ limit: '256kb' }));
  app.use('/api/cockpit', cockpitRouter({ users, service, audit: new AuditLog(db) }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setJobs(Date.now());
});

afterAll(() => {
  upstream.close();
  server?.close();
});

describe('cockpit connections', () => {
  it('lists the configured GitLab and starts without connections', async () => {
    const { data } = await call<CockpitConnections>('GET', '/connections');
    expect(data).toEqual({ gitlab: null, jira: null, instances: [{ id: 'env-gitlab', url: base }] });
  });

  it('checks a personal GitLab token and never returns it', async () => {
    expect((await call('PUT', '/connections/gitlab', { instanceId: 'env-gitlab', token: 'glpat-wrong-token' })).status).toBe(502);
    expect((await call('PUT', '/connections/gitlab', { instanceId: 'nope', token: ANNA_TOKEN })).status).toBe(400);
    const { status, data } = await call<CockpitConnections>('PUT', '/connections/gitlab', { instanceId: 'env-gitlab', token: ANNA_TOKEN });
    expect(status).toBe(200);
    expect(data.gitlab).toMatchObject({ instanceId: 'env-gitlab', url: base, username: 'anna', name: 'Anna Berg' });
    expect(JSON.stringify(data)).not.toContain(ANNA_TOKEN);
    // Saving again without a token keeps the stored one
    expect((await call('PUT', '/connections/gitlab', { instanceId: 'env-gitlab', token: '' })).status).toBe(200);
    // Stored encrypted
    const raw = db.prepare('SELECT data FROM cockpit_connections').all() as { data: Uint8Array }[];
    expect(raw.some((r) => Buffer.from(r.data).toString('utf8').includes(ANNA_TOKEN))).toBe(false);
    // Somebody else has none
    expect((await call<CockpitConnections>('GET', '/connections', undefined, benCookie)).data.gitlab).toBeNull();
  });

  it('connects Jira Cloud and normalizes addresses', async () => {
    expect(normalizeJiraUrl('https://firma.atlassian.net/browse/PAY-1', 'cloud', false)).toBe('https://firma.atlassian.net');
    expect(normalizeJiraUrl('https://jira.firma.de/jira/browse/PAY-1', 'datacenter', false)).toBe('https://jira.firma.de/jira');
    expect(() => normalizeJiraUrl('http://jira.firma.de', 'datacenter', false)).toThrow();
    expect(() => normalizeJiraUrl('https://10.0.0.5', 'datacenter', false)).toThrow();
    const { status, data } = await call<CockpitConnections>('PUT', '/connections/jira', { url: 'https://firma.atlassian.net/jira/software/projects/PAY/boards/1', kind: 'cloud', email: 'anna@example.org', token: 'atlassian-token-123' });
    expect(status).toBe(200);
    expect(data.jira).toMatchObject({ url: 'https://firma.atlassian.net', kind: 'cloud', accountName: 'Anna Atlassian' });
  });
});

describe('cockpit queries', () => {
  it('reads merge requests with the personal token only', async () => {
    seen.length = 0;
    const { data } = await call<CockpitResult>('POST', '/query', { widget: widget({ source: { kind: 'gitlab.mrs', params: { scope: 'authored' } } }) });
    expect('rows' in data).toBe(true);
    if (!('rows' in data)) return;
    expect(data.rows).toEqual([
      {
        id: 'mr:1!12',
        url: `${base}/team/api/-/merge_requests/12`,
        values: expect.objectContaining({ iid: '!12', title: 'PAY-412 Rechnungsnummern <b>pro</b> Mandant', project: 'team/api', author: 'anna', reviewers: ['ben'], jira: 'PAY-412', status: 'not_approved', updated: Date.parse('2026-11-25T10:00:00Z') }),
      },
    ]);
    expect(seen.every((s) => s.startsWith(ANNA_TOKEN))).toBe(true);
    expect(seen.some((s) => s.includes('author_id=7'))).toBe(true);
  });

  it('applies the widget filters on the server', async () => {
    const { data } = await call<CockpitResult>('POST', '/query', { widget: widget({ source: { kind: 'gitlab.mrs', params: { scope: 'all' } }, filters: [{ field: 'draft', op: 'eq', value: 'true' }] }) });
    expect('rows' in data && data.rows.map((r) => r.id)).toEqual(['mr:2!3']);
    expect('rows' in data && data.total).toBe(1);
  });

  it('fills variables and reports missing ones', async () => {
    const w = widget({ source: { kind: 'gitlab.mrs', params: { scope: 'all', project: '{{var:repo}}' } } });
    expect((await call<CockpitResult>('POST', '/query', { widget: w })).data).toEqual({ problem: 'missing_var', missing: ['repo'] });
    const { data } = await call<CockpitResult>('POST', '/query', { widget: w, vars: { repo: 'team/api' } });
    expect('rows' in data && data.rows).toEqual([]);
    expect((await call<CockpitResult>('POST', '/query', { widget: w, vars: { repo: '../../admin' } })).data).toMatchObject({ problem: 'invalid' });
  });

  it('finds failed CI jobs across repositories, latest run only', async () => {
    const { data } = await call<CockpitResult>('POST', '/query', { widget: widget({ source: { kind: 'gitlab.jobs', params: { since: '24h' } }, sort: { field: 'finished', dir: 'desc' } }) });
    expect('rows' in data).toBe(true);
    if (!('rows' in data)) return;
    // unit was fixed later, lint may fail, the old deploy is outside the period, no-ci has no access
    expect(data.rows.map((r) => `${r.values.project} ${r.values.name}`)).toEqual(['team/api deploy', 'team/web e2e']);
    expect(data.rows[0]).toMatchObject({ url: `${base}/team/api/-/jobs/105`, values: { ref: 'main', user: 'ben', pipeline: '#900', duration: 61, reason: 'script_failure' } });
    // An address on another host is dropped
    expect(data.rows[1].url).toBeUndefined();
    expect(data.partial).toBe(true);

    const named = await call<CockpitResult>('POST', '/query', { widget: widget({ source: { kind: 'gitlab.jobs', params: { name: 'e2e' } } }) });
    expect('rows' in named.data && named.data.rows.map((r) => r.values.name)).toEqual(['e2e']);
    const allowed = await call<CockpitResult>('POST', '/query', { widget: widget({ source: { kind: 'gitlab.jobs', params: { allowFailure: true, ref: 'main' } } }) });
    expect('rows' in allowed.data && allowed.data.rows.map((r) => r.values.name).sort()).toEqual(['deploy', 'lint']);
  });

  it('lists the repositories of a group or the own ones', async () => {
    const { data } = await call<CockpitResult>('POST', '/query', { widget: widget({ source: { kind: 'gitlab.projects', params: { group: 'team' } } }) });
    expect('rows' in data).toBe(true);
    if (!('rows' in data)) return;
    // Archived ones are hidden by default, subgroups included
    expect(data.rows.map((r) => r.values.path)).toEqual(['team/api', 'team/infra/tools']);
    expect(data.rows[0]).toEqual({
      id: 'project:1',
      url: `${base}/team/api`,
      values: { name: 'API', path: 'team/api', namespace: 'team', description: 'Billing <i>API</i>', visibility: 'internal', defaultBranch: 'main', topics: ['billing'], archived: false, stars: 4, forks: 1, openIssues: 7, activity: Date.parse('2026-11-26T08:00:00Z'), created: Date.parse('2024-01-01T00:00:00Z') },
    });
    // An address on another host is dropped
    expect(data.rows[1].url).toBeUndefined();

    const direct = await call<CockpitResult>('POST', '/query', { widget: widget({ source: { kind: 'gitlab.projects', params: { group: 'team', subgroups: false, archived: 'any' } } }) });
    expect('rows' in direct.data && direct.data.rows.map((r) => r.values.path)).toEqual(['team/api', 'team/old']);
    const searched = await call<CockpitResult>('POST', '/query', { widget: widget({ source: { kind: 'gitlab.projects', params: { group: 'team', search: 'too' } } }) });
    expect('rows' in searched.data && searched.data.rows.map((r) => r.values.name)).toEqual(['Tools']);
    // Without a group: the projects the user is a member of
    const mine = await call<CockpitResult>('POST', '/query', { widget: widget({ source: { kind: 'gitlab.projects', params: {} } }) });
    expect('rows' in mine.data && mine.data.rows.map((r) => r.values.path)).toEqual(['team/api', 'team/web', 'team/no-ci']);
    expect('rows' in mine.data && mine.data.rows[0].values.namespace).toBe('team');
    expect((await call<CockpitResult>('POST', '/query', { widget: widget({ source: { kind: 'gitlab.projects', params: { group: '../x' } } }) })).data).toMatchObject({ problem: 'invalid' });
  });

  it('finds the commits a release branch lacks, counting cherry-picks as contained', async () => {
    const compare = (params: Record<string, unknown>) => call<CockpitResult>('POST', '/query', { widget: widget({ source: { kind: 'gitlab.compare', params: { project: 'team/api', from: '10.100', to: '10.101', ...params } } as CockpitWidget['source'] }) });
    const { data } = await compare({});
    expect('rows' in data).toBe(true);
    if (!('rows' in data)) return;
    expect(data.rows).toEqual([
      { id: `commit:team/api:${'1'.repeat(40)}`, url: `${base}/team/api/-/commit/${'1'.repeat(40)}`, values: { sha: '11111111', title: 'PAY-1 Fix rounding', author: 'Ben', project: 'team/api', jira: 'PAY-1', merge: false, created: Date.parse('2026-11-25T10:00:00Z') } },
    ]);
    // The range's dots reach GitLab encoded
    expect(seen.some((s) => s.includes('ref_name=10%2E101%2E%2E10%2E100'))).toBe(true);
    const strict = await compare({ cherryPicks: 'strict', merges: true });
    expect('rows' in strict.data && strict.data.rows.map((r) => r.values.title)).toEqual(['PAY-1 Fix rounding', 'Fix login', 'Same title fix', "Merge branch 'x' into '10.100'", 'Picked here']);
    const same = await compare({ from: '10.101' });
    expect('rows' in same.data && same.data.total).toBe(0);
    expect((await compare({ to: '' })).data).toMatchObject({ problem: 'invalid' });
    expect((await compare({ to: '10..101' })).data).toMatchObject({ problem: 'invalid' });
    expect((await compare({ to: '-x' })).data).toMatchObject({ problem: 'invalid' });
    expect((await compare({ to: 'nope' })).data).toMatchObject({ problem: 'not_found' });
  });

  it('lists the subgroups of a group or the own groups', async () => {
    const { data } = await call<CockpitResult>('POST', '/query', { widget: widget({ source: { kind: 'gitlab.groups', params: { group: 'team' } } }) });
    expect('rows' in data && data.rows).toEqual([
      { id: 'group:20', url: `${base}/groups/team/infra`, values: { name: 'Infra', path: 'team/infra', parent: 'team', description: 'Platform', visibility: 'private', created: Date.parse('2025-03-01T00:00:00Z') } },
    ]);
    const all = await call<CockpitResult>('POST', '/query', { widget: widget({ source: { kind: 'gitlab.groups', params: { group: 'team', descendants: true } } }) });
    expect('rows' in all.data && all.data.rows.map((r) => `${r.values.parent} > ${r.values.name}`)).toEqual(['team > Infra', 'team/infra > K8s']);
    const mine = await call<CockpitResult>('POST', '/query', { widget: widget({ source: { kind: 'gitlab.groups', params: {} } }) });
    expect('rows' in mine.data && mine.data.rows.map((r) => r.values.path)).toEqual(['team']);
    expect('rows' in mine.data && mine.data.rows[0].values.parent).toBeNull();
  });

  it('lists the branches of a repository and keeps links on the instance', async () => {
    const { data } = await call<CockpitResult>('POST', '/query', { widget: widget({ source: { kind: 'gitlab.branches', params: { project: 'team/api', search: 'SHOP-1' } } }) });
    expect('rows' in data && data.rows).toEqual([
      {
        id: 'branch:team/api:feature/SHOP-1-gutschein',
        values: { name: 'feature/SHOP-1-gutschein', default: false, protected: false, merged: false, commit: 'feat: Gutschein', author: 'Anna', updated: Date.parse('2026-11-25T10:00:00Z') },
      },
    ]);
    const all = await call<CockpitResult>('POST', '/query', { widget: widget({ source: { kind: 'gitlab.branches', params: { project: 'team/api' } } }) });
    expect('rows' in all.data && all.data.rows.map((r) => [r.values.name, r.url])).toEqual([
      ['main', `${base}/team/api/-/tree/main`],
      ['feature/SHOP-1-gutschein', undefined],
    ]);
    expect((await call<CockpitResult>('POST', '/query', { widget: widget({ source: { kind: 'gitlab.branches', params: {} } }) })).data).toMatchObject({ problem: 'invalid' });
  });

  it('reads Jira issues with JQL and passes its errors on', async () => {
    const { data } = await call<CockpitResult>('POST', '/query', { widget: widget({ source: { kind: 'jira.issues', params: { jql: 'assignee = currentUser()' } } }) });
    expect('rows' in data && data.rows.map((r) => r.id)).toEqual(['jira:PAY-412', 'jira:PAY-398']);
    expect('rows' in data && data.rows[0]).toMatchObject({ url: 'https://firma.atlassian.net/browse/PAY-412', values: { category: 'active', type: 'Story', due: Date.parse('2026-12-01T00:00:00Z') } });
    const broken = await call<CockpitResult>('POST', '/query', { widget: widget({ source: { kind: 'jira.issues', params: { jql: 'broken' } } }) });
    expect(broken.data).toMatchObject({ problem: 'invalid', provider: 'jira', detail: expect.stringContaining("'broken' is not valid") });
  });

  it('says when a connection is missing and refuses unknown sources', async () => {
    expect((await call<CockpitResult>('POST', '/query', { widget: widget({ source: { kind: 'gitlab.mrs', params: {} } }) }, benCookie)).data).toEqual({ problem: 'not_connected', provider: 'gitlab' });
    expect((await call('POST', '/query', { widget: { source: { kind: 'shell' } } })).status).toBe(400);
  });

  it('forgets a connection', async () => {
    await call('PUT', '/connections/jira', { url: 'https://firma.atlassian.net', kind: 'cloud', email: 'anna@example.org', token: 'atlassian-token-123' }, benCookie);
    const { data } = await call<CockpitConnections>('DELETE', '/connections/jira', undefined, benCookie);
    expect(data.jira).toBeNull();
  });
});

describe('cockpit notifications', () => {
  const dashboard: Partial<CockpitDashboard> = {
    title: 'Mein Tag',
    vars: {},
    widgets: [{ ...widget({ source: { kind: 'gitlab.jobs', params: { since: '24h' } } }), id: 'ci', title: 'Rote Jobs', notify: true } as CockpitWidget, { ...widget({ source: { kind: 'gitlab.mrs', params: {} } }), id: 'mrs' } as CockpitWidget],
  };
  const noteId = crypto.randomUUID();

  it('registers own dashboards with notifying widgets', () => {
    const [r] = notes.push(anna.id, [{ id: noteId, baseVersion: 0, path: '_dashboard-0f9c3a2e-1111.md', content: serializeDashboard(dashboard as CockpitDashboard), deleted: false, createdAt: 1, updatedAt: Date.now() }]);
    expect(r.status).toBe('ok');
    const w = service.store.watch(noteId);
    expect(w?.userId).toBe(anna.id);
    expect(w?.payload.widgets.map((x) => x.id)).toEqual(['ci']);
  });

  it('notifies about new failures, not about those it already saw', async () => {
    const now = Date.now();
    await watch.check(noteId, now);
    expect(delivered).toHaveLength(0);
    expect(notifications.list(anna.id).items).toHaveLength(0);

    jobs['2'] = [{ id: 202, name: 'build', stage: 'build', ref: 'main', status: 'failed', finished_at: new Date(now - HOUR / 2).toISOString() }, ...jobs['2']];
    await watch.check(noteId, now + 1000);
    const list = notifications.list(anna.id).items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'cockpit', noteId, path: 'Rote Jobs', text: 'build · team/web (main)' });
    expect(delivered[0]).toMatchObject({ kind: 'cockpit', name: 'Rote Jobs', url: `/cockpit/${noteId}`, text: 'build · team/web (main)' });
    expect(notificationPush(delivered[0], 'de', noteId)).toMatchObject({ title: 'Neu in „Rote Jobs“', body: 'build · team/web (main)' });

    // Nothing new: nothing more
    await watch.check(noteId, now + 2000);
    expect(notifications.list(anna.id).items).toHaveLength(1);
    // The next read waits a few minutes
    expect(service.store.due(now + 3000, 10)).not.toContain(noteId);
  });

  it('stops watching when the widget no longer notifies or the note is gone', () => {
    const quiet = { ...dashboard, widgets: dashboard.widgets!.map((w) => ({ ...w, notify: false })) };
    const [r] = notes.push(anna.id, [{ id: noteId, baseVersion: 1, path: '_dashboard-0f9c3a2e-1111.md', content: serializeDashboard(quiet as CockpitDashboard), deleted: false, createdAt: 1, updatedAt: Date.now() }]);
    expect(r.status).toBe('ok');
    expect(service.store.watch(noteId)).toBeNull();
  });
});
