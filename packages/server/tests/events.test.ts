import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import type { IncomingHttpHeaders } from 'http';
import { defineServerPlugin, type GitEvent, type GitEventCore } from '@kladde/plugin-api/server';
import { newProjectContent, newTicketContent, parseProject, ticketMeta, writeProject, type EventSource, type EventSourceCreated } from '@kladde/shared';
import { createKladdeApp } from '../src/app';
import { openDatabase } from '../src/db';
import { GroupStore } from '../src/GroupStore';
import { EventBus, type BusMessage } from '../src/events/EventBus';
import { matchesProjects, normalizeDelivery } from '../src/events/normalize';
import type { InstalledServerPlugin } from '../src/plugins/types';

const gl = (event: string, payload: object, extra: IncomingHttpHeaders = {}) => normalizeDelivery('gitlab', { 'x-gitlab-event': event, ...extra }, payload, Buffer.from(JSON.stringify(payload)), 1_000);
const gh = (event: string, payload: object) => normalizeDelivery('github', { 'x-github-event': event, 'x-github-delivery': 'd-12345678' }, payload, Buffer.from(JSON.stringify(payload)), 1_000);
const project = { path_with_namespace: 'team/app', name: 'App', web_url: 'https://git.example/team/app', default_branch: 'main' };
const user = { username: 'dev', name: 'Dev Eloper' };

describe('normalising GitLab deliveries', () => {
  it('merge requests with their action, branches, labels and the actor', () => {
    const e = gl(
      'Merge Request Hook',
      { object_kind: 'merge_request', user, project, labels: [{ title: 'bug' }], reviewers: [{ username: 'rev' }], object_attributes: { action: 'merge', iid: 7, title: 'KLD-1 Login', source_branch: 'feature/kld-1', target_branch: 'main', state: 'merged', url: 'https://git.example/mr/7', description: 'x'.repeat(10_000), last_commit: { id: 'abc' } } },
      { 'x-gitlab-event-uuid': 'uuid-1234-5678' }
    );
    expect(e).toMatchObject({
      id: 'uuid-1234-5678',
      type: 'git.merge_request',
      action: 'merged',
      provider: 'gitlab',
      project: { path: 'team/app', name: 'App', url: 'https://git.example/team/app', defaultBranch: 'main' },
      actor: { username: 'dev', name: 'Dev Eloper' },
      mergeRequest: { number: 7, state: 'merged', sourceBranch: 'feature/kld-1', targetBranch: 'main', sha: 'abc', labels: ['bug'], reviewers: ['rev'] },
    });
    // Texts are bounded
    expect((e as Extract<GitEventCore, { type: 'git.merge_request' }>).mergeRequest.description.length).toBe(4000);
    expect(gl('Merge Request Hook', { object_attributes: { action: 'approval' }, project })).toMatchObject({ action: 'approved' });
    expect(gl('Merge Request Hook', { object_attributes: { action: 'unknown' }, project })).toBeNull();
  });

  it('pushes, new and deleted branches, tags', () => {
    const zero = '0'.repeat(40);
    const commits = Array.from({ length: 25 }, (_, i) => ({ id: `c${i}`, message: `Commit ${i}\n\nBody`, url: `u${i}`, author: { name: 'A' }, timestamp: '2026-11-28T10:00:00+01:00' }));
    const push = gl('Push Hook', { object_kind: 'push', ref: 'refs/heads/feature/x', before: 'a1', after: 'b2', total_commits_count: 25, commits, project, user_username: 'dev', user_name: 'Dev' });
    expect(push).toMatchObject({ type: 'git.push', action: 'pushed', actor: { username: 'dev' }, push: { branch: 'feature/x', commitCount: 25 } });
    const p = push as Extract<GitEventCore, { type: 'git.push' }>;
    expect(p.push.commits).toHaveLength(20);
    expect(p.push.commits[0]).toMatchObject({ sha: 'c5', title: 'Commit 5', at: Date.parse('2026-11-28T09:00:00Z') });
    expect(gl('Push Hook', { ref: 'refs/heads/new', before: zero, after: 'b2', project })).toMatchObject({ action: 'created' });
    expect(gl('Push Hook', { ref: 'refs/heads/old', before: 'a1', after: zero, project })).toMatchObject({ action: 'deleted' });
    expect(gl('Tag Push Hook', { ref: 'refs/tags/v1.2.0', before: zero, after: 'abc', message: 'Release', project })).toMatchObject({ type: 'git.tag', action: 'created', tag: { name: 'v1.2.0', sha: 'abc', message: 'Release' } });
  });

  it('pipelines and jobs with their status and links', () => {
    expect(gl('Pipeline Hook', { object_attributes: { id: 42, status: 'failed', ref: 'main', sha: 's', source: 'merge_request_event', duration: 93, finished_at: '2026-11-28 10:00:00 UTC' }, merge_request: { iid: 7 }, project, user })).toMatchObject({
      type: 'git.pipeline',
      action: 'failed',
      at: Date.parse('2026-11-28T10:00:00Z'),
      pipeline: { id: 42, status: 'failed', url: 'https://git.example/team/app/-/pipelines/42', mergeRequest: 7, durationSeconds: 93, source: 'merge_request_event' },
    });
    expect(gl('Pipeline Hook', { object_attributes: { id: 1, status: 'waiting_for_resource' }, project })).toMatchObject({ action: 'waiting' });
    expect(
      gl('Job Hook', { object_kind: 'build', build_id: 9, build_name: 'test', build_stage: 'test', build_status: 'success', build_allow_failure: true, pipeline_id: 42, ref: 'main', sha: 's', project_name: 'team / app', repository: { name: 'App', homepage: 'https://git.example/team/app' } })
    ).toMatchObject({ type: 'git.job', action: 'success', project: { path: 'team/app' }, job: { id: 9, name: 'test', stage: 'test', url: 'https://git.example/team/app/-/jobs/9', pipelineId: 42, allowFailure: true } });
  });

  it('comments, issues, releases, deployments and wiki pages', () => {
    expect(gl('Note Hook', { object_attributes: { id: 3, note: 'LGTM', noteable_type: 'MergeRequest', url: 'n' }, merge_request: { iid: 7, title: 'Login' }, project, user })).toMatchObject({
      type: 'git.comment',
      action: 'created',
      comment: { id: 3, body: 'LGTM', on: 'merge_request', number: 7, title: 'Login' },
    });
    expect(gl('Note Hook', { object_attributes: { noteable_type: 'Commit', commit_id: 'c1' }, commit: { id: 'c1' }, project })).toMatchObject({ comment: { on: 'commit', number: null, sha: 'c1' } });
    expect(gl('Issue Hook', { object_attributes: { action: 'close', iid: 5, title: 'Bug', state: 'closed' }, labels: [{ title: 'p1' }], project, user })).toMatchObject({ type: 'git.issue', action: 'closed', issue: { number: 5, state: 'closed', labels: ['p1'] } });
    expect(gl('Confidential Issue Hook', { object_attributes: { action: 'open', iid: 6 }, project, user })).toMatchObject({ issue: { confidential: true, author: 'dev' } });
    expect(gl('Release Hook', { action: 'create', tag: 'v1.2.0', name: '1.2.0', url: 'r', project })).toMatchObject({ type: 'git.release', action: 'created', release: { tag: 'v1.2.0', name: '1.2.0' } });
    expect(gl('Deployment Hook', { status: 'success', deployment_id: 11, environment: 'production', ref: 'main', short_sha: 'abc', environment_external_url: 'https://app.example', project, user })).toMatchObject({
      type: 'git.deployment',
      action: 'success',
      deployment: { id: 11, environment: 'production', url: 'https://app.example' },
    });
    expect(gl('Wiki Page Hook', { object_attributes: { action: 'update', title: 'Home', slug: 'home', url: 'w' }, project, user })).toMatchObject({ type: 'git.wiki', action: 'updated', wiki: { slug: 'home' } });
  });

  it('leaves events Kladde does not know alone', () => {
    expect(gl('Member Hook', { project })).toBeNull();
    expect(gl('Feature Flag Hook', { project })).toBeNull();
  });

  it('identifies deliveries without an id by their body', () => {
    const a = gl('Push Hook', { ref: 'refs/heads/main', project });
    const b = gl('Push Hook', { ref: 'refs/heads/main', project });
    expect(a!.id).toMatch(/^sha256-/);
    expect(a!.id).toBe(b!.id);
  });
});

describe('normalising GitHub deliveries', () => {
  const repository = { full_name: 'org/app', name: 'app', html_url: 'https://github.example/org/app', default_branch: 'main' };
  const sender = { login: 'dev' };

  it('pull requests, merges and approvals', () => {
    const pr = { number: 9, title: 'KLD-1', merged: true, state: 'closed', head: { ref: 'feature/x', sha: 'h' }, base: { ref: 'main' }, user: { login: 'dev' }, labels: [{ name: 'bug' }] };
    expect(gh('pull_request', { action: 'closed', pull_request: pr, repository, sender })).toMatchObject({
      id: 'd-12345678',
      type: 'git.merge_request',
      action: 'merged',
      project: { path: 'org/app' },
      mergeRequest: { number: 9, state: 'merged', sourceBranch: 'feature/x', targetBranch: 'main', labels: ['bug'] },
    });
    expect(gh('pull_request', { action: 'synchronize', pull_request: { ...pr, merged: false, state: 'open' }, repository })).toMatchObject({ action: 'updated', mergeRequest: { state: 'open' } });
    expect(gh('pull_request_review', { action: 'submitted', review: { state: 'APPROVED' }, pull_request: pr, repository })).toMatchObject({ action: 'approved' });
    expect(gh('pull_request_review', { action: 'submitted', review: { state: 'commented' }, pull_request: pr, repository })).toBeNull();
  });

  it('pushes, tags, workflow runs and jobs', () => {
    expect(gh('push', { ref: 'refs/heads/main', before: 'a', after: 'b', commits: [{ id: 'c', message: 'Fix\n\nmore' }], repository, sender })).toMatchObject({ type: 'git.push', action: 'pushed', push: { branch: 'main', commitCount: 1, commits: [{ title: 'Fix' }] } });
    expect(gh('push', { ref: 'refs/tags/v2', after: 'b', created: true, repository })).toMatchObject({ type: 'git.tag', action: 'created', tag: { name: 'v2' } });
    expect(
      gh('workflow_run', { workflow_run: { id: 5, name: 'CI', status: 'completed', conclusion: 'failure', head_branch: 'main', event: 'pull_request', run_started_at: '2026-11-28T10:00:00Z', updated_at: '2026-11-28T10:01:30Z', pull_requests: [{ number: 9 }] }, repository })
    ).toMatchObject({ type: 'git.pipeline', action: 'failed', pipeline: { id: 5, name: 'CI', mergeRequest: 9, durationSeconds: 90, source: 'pull_request' } });
    expect(gh('workflow_job', { workflow_job: { id: 6, name: 'test', status: 'in_progress', run_id: 5 }, repository })).toMatchObject({ type: 'git.job', action: 'running', job: { pipelineId: 5 } });
  });

  it('comments on pull requests and issues, releases, deployments, wiki pages', () => {
    expect(gh('issue_comment', { action: 'created', comment: { id: 1, body: 'Hi' }, issue: { number: 9, title: 'PR', pull_request: {} }, repository })).toMatchObject({ type: 'git.comment', comment: { on: 'merge_request', number: 9 } });
    expect(gh('issue_comment', { action: 'edited', comment: { id: 1 }, issue: { number: 3 }, repository })).toMatchObject({ action: 'edited', comment: { on: 'issue' } });
    expect(gh('issues', { action: 'labeled', issue: { number: 3, labels: [{ name: 'x' }] }, repository })).toMatchObject({ type: 'git.issue', action: 'updated' });
    expect(gh('release', { action: 'published', release: { tag_name: 'v2', name: 'Two' }, repository })).toMatchObject({ type: 'git.release', action: 'created' });
    expect(gh('release', { action: 'created', release: { tag_name: 'v2' }, repository })).toBeNull();
    expect(gh('deployment_status', { deployment_status: { state: 'error', environment: 'prod' }, deployment: { id: 4, ref: 'main' }, repository })).toMatchObject({ type: 'git.deployment', action: 'failed', deployment: { environment: 'prod' } });
    expect(gh('gollum', { pages: [{ action: 'created', title: 'Home', page_name: 'Home' }], repository })).toMatchObject({ type: 'git.wiki', action: 'created' });
    expect(gh('ping', { zen: 'hi' })).toBeNull();
  });
});

describe('project paths of a webhook', () => {
  it('takes exact paths and everything below a group path', () => {
    expect(matchesProjects('team/app', [])).toBe(true);
    expect(matchesProjects('team/app', ['team'])).toBe(true);
    expect(matchesProjects('Team/App', ['team/app/'])).toBe(true);
    expect(matchesProjects('teamwork/app', ['team'])).toBe(false);
  });
});

describe('the event bus', () => {
  const message = (n: number): BusMessage => ({ event: { ...gl('Push Hook', { ref: `refs/heads/b${n}`, project })! }, owner: { kind: 'user', id: 'u', name: 'u' }, source: { id: 's', createdBy: 'u' } });

  it('keeps a failing subscriber away from the others and keeps the order per subscriber', async () => {
    const errors: string[] = [];
    const bus = new EventBus((name) => errors.push(name));
    const seen: string[] = [];
    bus.subscribe({ name: 'broken', handle: () => { throw new Error('boom'); } });
    bus.subscribe({
      name: 'slow',
      handle: async (m) => {
        await new Promise((r) => setTimeout(r, m.event.type === 'git.push' && (m.event as Extract<GitEventCore, { type: 'git.push' }>).push.branch === 'b1' ? 20 : 0));
        seen.push((m.event as Extract<GitEventCore, { type: 'git.push' }>).push.branch);
        return 'done';
      },
    });
    bus.subscribe({ name: 'other type', types: ['git.pipeline'], handle: () => void seen.push('never') });
    const [first, second] = await Promise.all([bus.publish(message(1)), bus.publish(message(2))]);
    expect(seen).toEqual(['b1', 'b2']);
    expect(first).toEqual([{ name: 'broken', ok: false, error: 'boom' }, { name: 'slow', ok: true, summary: 'done' }]);
    expect(second.map((o) => o.ok)).toEqual([false, true]);
    expect(errors).toEqual(['broken', 'broken']);
  });
});

// ------------------------------------------------------------------ in a running Kladde

const received: GitEvent[] = [];
let failNext = false;
const watcher = defineServerPlugin({
  id: 'watcher',
  rawPayload: ['git.pipeline'],
  events: {
    'git.merge_request': (event) => {
      if (failNext) {
        failNext = false;
        throw new Error('plugin broke');
      }
      received.push(event);
    },
    'git.pipeline': (event) => void received.push(event),
  },
});
const installed: InstalledServerPlugin = { name: 'kladde-plugin-watcher', id: 'watcher', version: '1.0.0', api: '^1.4.0', defaultEnabled: false, plugin: watcher };

describe('central webhooks', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-events-'));
  const db = openDatabase(':memory:');
  const ctx = createKladdeApp({ db, dataDir, env: { DATA_KEY: crypto.randomBytes(32).toString('base64') }, standalone: false, isProduction: false, publicUrl: null, trustProxy: false, plugins: [installed] });
  const { users, notes } = ctx;
  const groups = new GroupStore(db);
  const anna = users.createUser('anna');
  const ben = users.createUser('ben');
  const cara = users.createUser('cara');
  const cookieOf = (id: string) => `kladde_session=${users.createSession(id)}`;
  const annaCookie = cookieOf(anna.id);
  const benCookie = cookieOf(ben.id);
  let server: Server;
  let base = '';

  const call = (method: string, url: string, body?: unknown, as = annaCookie) =>
    fetch(`${base}${url}`, { method, headers: { Cookie: as, Origin: base, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const create = async (body: object, as = annaCookie) => {
    const res = await call('POST', '/api/event-sources', body, as);
    expect(res.status).toBe(200);
    return (await res.json()) as EventSourceCreated;
  };
  const sources = async (as = annaCookie) => (await (await call('GET', '/api/event-sources', undefined, as)).json()) as EventSource[];
  const switchOn = (userId: string) => {
    const id = `syssettings-${userId}`;
    const now = Date.now();
    notes.push(userId, [{ id, baseVersion: notes.fetchNotes(userId, [id])[0]?.version ?? 0, path: '.kladde/settings.json', content: JSON.stringify({ features: { plugins: { watcher: true } } }), deleted: false, createdAt: now, updatedAt: now }]);
  };
  const mr = (title: string, action = 'merge', path = 'team/app') => ({ object_kind: 'merge_request', user: { username: 'dev' }, project: { path_with_namespace: path }, object_attributes: { action, iid: 4, title, source_branch: 'x', url: 'https://git.example/mr/4', description: '' } });
  const deliver = (url: string, secret: string, payload: object, event = 'Merge Request Hook', uuid: string = crypto.randomUUID()) =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Gitlab-Event': event, 'X-Gitlab-Token': secret, 'X-Gitlab-Event-UUID': uuid }, body: JSON.stringify(payload) });
  const settle = () => new Promise((r) => setTimeout(r, 30));

  beforeAll(async () => {
    server = ctx.app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('stores the secret encrypted, checks it and answers unknown webhooks and wrong secrets alike', async () => {
    const { source, secret } = await create({ provider: 'gitlab', name: 'App', projects: 'team/app, team/lib' });
    expect(source).toMatchObject({ provider: 'gitlab', name: 'App', projects: ['team/app', 'team/lib'], owner: { kind: 'user', name: 'anna' }, createdBy: 'anna', url: `${base}/api/events/hooks/${source.id}` });
    const row = db.prepare('SELECT payload FROM event_sources WHERE id = ?').get(source.id) as { payload: Uint8Array };
    expect(Buffer.from(row.payload).toString('latin1')).not.toContain(secret);
    expect(Buffer.from(row.payload).toString('latin1')).not.toContain('team/app');
    const wrong = await deliver(source.url, 'falsch', mr('x'));
    const unknown = await deliver(`${base}/api/events/hooks/${'x'.repeat(24)}`, secret, mr('x'));
    expect([wrong.status, unknown.status]).toEqual([404, 404]);
    expect(await wrong.json()).toEqual(await unknown.json());
    expect((await sources())[0].deliveries[0]).toMatchObject({ status: 'invalid' });
    // Others neither see nor change it
    expect(await sources(benCookie)).toEqual([]);
    expect((await call('DELETE', `/api/event-sources/${source.id}`, undefined, benCookie)).status).toBe(404);
    expect((await call('POST', '/api/event-sources', { provider: 'bitbucket' })).status).toBe(400);
  });

  it('runs the ticket automations of the owner’s projects, drops repeats and filters projects', async () => {
    const content = newProjectContent('KLD');
    const config = parseProject(content)!;
    const now = Date.now();
    notes.push(anna.id, [
      {
        id: 'db-events-0001',
        baseVersion: 0,
        path: `Proj/_database-${crypto.randomUUID()}.md`,
        content: writeProject(content, { ...config, automations: [{ id: 'r1', name: 'Merge', enabled: true, trigger: 'mr_merged', from: [], to: [], ifStatus: [], ifLabels: [], force: false, actions: [{ type: 'set_status', value: 'Erledigt' }] }] }),
        deleted: false,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const [pushed] = notes.push(anna.id, [{ id: 'tk-events-0001', baseVersion: 0, path: 'Proj/Ticket.md', content: newTicketContent({ key: 'KLD', status: 'In Arbeit' }), deleted: false, createdAt: now, updatedAt: now }]);
    const ticketId = ticketMeta(pushed.status === 'ok' ? pushed.content! : '').id!;
    const { source } = await create({ provider: 'gitlab', projects: ['team'] });
    const secret = (await (await call('POST', `/api/event-sources/${source.id}/rotate`)).json()).secret as string;

    const uuid = crypto.randomUUID();
    const res = await deliver(source.url, secret, mr(`${ticketId} Login`), 'Merge Request Hook', uuid);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, type: 'git.merge_request', action: 'merged' });
    await settle();
    expect(ticketMeta(notes.ownedNotes(anna.id).find((n) => n.id === 'tk-events-0001')!.content).status).toBe('Erledigt');

    // GitLab sends it again: taken once only
    expect((await deliver(source.url, secret, mr(`${ticketId} Login`), 'Merge Request Hook', uuid)).status).toBe(200);
    // Another project than the webhook's paths: not published
    expect((await deliver(source.url, secret, mr(`${ticketId} Login`, 'merge', 'other/app'))).status).toBe(202);
    // Unknown events are answered and listed
    expect((await deliver(source.url, secret, { object_kind: 'member' }, 'Member Hook')).status).toBe(202);
    await settle();
    const listed = (await sources()).find((s) => s.id === source.id)!;
    expect(listed.deliveries.map((d) => d.status)).toEqual(['ignored', 'filtered', 'duplicate', 'accepted']);
    expect(listed.deliveries[3]).toMatchObject({ type: 'git.merge_request', action: 'merged', project: 'team/app', detail: expect.stringContaining(`tickets: ${ticketId}: Merge`) });
  });

  it('delivers to plugins only for people who switched them on, and isolates their errors', async () => {
    const { source, secret } = await create({ provider: 'gitlab' });
    received.length = 0;
    await deliver(source.url, secret, mr('Nothing'));
    await settle();
    expect(received).toEqual([]);
    expect((await sources()).find((s) => s.id === source.id)!.deliveries[0].detail).toContain('plugin:watcher: für niemanden eingeschaltet');

    switchOn(anna.id);
    await deliver(source.url, secret, mr('Login'));
    await deliver(source.url, secret, { object_kind: 'pipeline', object_attributes: { id: 1, status: 'success' }, project: { path_with_namespace: 'team/app' } }, 'Pipeline Hook');
    await settle();
    expect(received.map((e) => e.type)).toEqual(['git.merge_request', 'git.pipeline']);
    expect(received[0]).toMatchObject({ owner: { kind: 'user', id: anna.id, name: 'anna' }, users: [anna.id], mergeRequest: { title: 'Login' } });
    // Raw JSON only for the types the plugin asked for; the webhook's id and secret never
    expect(received[0].raw).toBeUndefined();
    expect(received[1].raw).toMatchObject({ object_kind: 'pipeline' });
    expect(JSON.stringify(received)).not.toContain(source.id);
    expect(JSON.stringify(received)).not.toContain(secret);

    failNext = true;
    await deliver(source.url, secret, mr('Broken'));
    await settle();
    const last = (await sources()).find((s) => s.id === source.id)!.deliveries[0];
    expect(last).toMatchObject({ status: 'failed', detail: 'plugin:watcher: plugin broke' });
    expect(ctx.jobs.list(5)[0]).toMatchObject({ kind: 'event', ok: false, error: 'plugin:watcher: git.merge_request' });
  });

  it('lets group owners create group webhooks whose events reach the members with the plugin on', async () => {
    const group = groups.create(anna.id, 'Team');
    groups.setMember(anna.id, group.id, ben.id, 'editor');
    groups.setMember(anna.id, group.id, cara.id, 'reader');
    switchOn(cara.id);
    expect((await call('POST', '/api/event-sources', { provider: 'gitlab', group: group.id }, benCookie)).status).toBe(403);
    const { source, secret } = await create({ provider: 'gitlab', group: group.id });
    expect(source.owner).toEqual({ kind: 'group', id: group.id, name: 'Team' });
    // Editors do not manage it
    expect((await sources(benCookie)).map((s) => s.id)).not.toContain(source.id);
    received.length = 0;
    await deliver(source.url, secret, mr('Group'));
    await settle();
    expect(received).toHaveLength(1);
    expect(received[0].owner).toEqual({ kind: 'group', id: group.id, name: 'Team' });
    expect(new Set(received[0].users)).toEqual(new Set([anna.id, cara.id]));

    expect(await (await call('DELETE', `/api/event-sources/${source.id}`)).json()).not.toContainEqual(expect.objectContaining({ id: source.id }));
    expect((await deliver(source.url, secret, mr('Gone'))).status).toBe(404);
  });
});
