import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { openDatabase } from '../src/db';
import { DataCipher } from '../src/crypto';
import { ServerSettings } from '../src/ServerSettings';
import { RemoteInstances } from '../src/remote/RemoteInstances';
import { RemoteFetcher } from '../src/remote/RemoteFetcher';
import { GitlabCards, plainDescription } from '../src/remote/GitlabCards';

const TOKEN = 'glpat-card-token';
const seen: string[] = [];

/** Answers like GitLab's API for the endpoints cards use */
const upstream = http.createServer((req, res) => {
  seen.push(req.url!);
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body));
  if (req.headers['private-token'] !== TOKEN) return json(401, { message: 'no' });
  const url = new URL(req.url!, 'http://x');
  const p = url.pathname.replace(/^\/api\/v4/, '');
  if (p === '/projects/team%2Fapp/merge_requests/12')
    return json(200, {
      title: 'Faster sync <script>alert(1)</script>',
      state: 'opened',
      draft: true,
      description: '## Why\n\nBecause **speed** matters. [Docs](https://evil.example.com)\n\n```js\nsecret()\n```',
      author: { name: 'Anna', username: 'anna', avatar_url: 'https://evil.example.com/a.png' },
      reviewers: [{ name: 'Ben', username: 'ben' }],
      labels: ['perf', 'sync'],
      source_branch: 'feat/sync',
      target_branch: 'main',
      head_pipeline: { status: 'success' },
      user_notes_count: 3,
      changes_count: '7',
      web_url: 'https://evil.example.com/phish',
      created_at: '2026-11-20T10:00:00Z',
    });
  if (p === '/projects/team%2Fapp/issues/4') return json(200, { title: 'Crash', state: 'closed', labels: ['bug'], task_completion_status: { count: 3, completed_count: 2 }, due_date: '2026-12-01' });
  if (p === '/projects/team%2Fapp') return json(200, { name: 'App', path_with_namespace: 'team/app', default_branch: 'main', star_count: 5, forks_count: 1, visibility: 'internal', topics: ['notes'] });
  if (p === '/projects/team%2Fapp/languages') return json(200, { TypeScript: 80.55, CSS: 12, Shell: 0 });
  if (p === '/projects/team%2Fsub') return json(404, { message: '404 Project Not Found' });
  if (p === '/groups/team%2Fsub') return json(200, { name: 'Sub', full_path: 'team/sub', description: 'The **sub** group' });
  if (p === '/groups/team%2Fsub/projects') return json(200, [{}], { 'X-Total': '14' });
  if (p === '/groups/team%2Fsub/subgroups') return json(200, [], { 'X-Total': '2' });
  if (p === '/projects/team%2Fapp/milestones' && url.searchParams.get('iids[]') === '3') return json(200, [{ id: 77, title: 'v2', state: 'active', due_date: '2026-12-24' }]);
  if (p === '/projects/team%2Fapp/issues' && url.searchParams.get('milestone_id') === '77') return json(200, [], { 'X-Total': url.searchParams.get('state') === 'opened' ? '4' : '6' });
  return json(404, { message: '404 upstream text' });
});

let cards: GitlabCards;
let base = '';

beforeAll(async () => {
  upstream.listen(0, '127.0.0.1');
  await new Promise((r) => upstream.once('listening', r));
  base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const db = openDatabase(':memory:');
  const instances = new RemoteInstances({ REMOTE_GITLAB_URL: base, REMOTE_GITLAB_TOKEN: TOKEN, REMOTE_ALLOWED_PATHS: 'team' }, new ServerSettings(db), new DataCipher(crypto.randomBytes(32)));
  cards = new GitlabCards(instances, new RemoteFetcher(instances, { timeoutMs: 1000 }));
});
afterAll(() => upstream.close());

describe('GitLab preview cards', () => {
  it('show a merge request with plain fields only', async () => {
    const r = await cards.card(`${base}/team/app/-/merge_requests/12`);
    expect(r.state).toBe('ok');
    if (r.state !== 'ok') return;
    expect(r.card).toMatchObject({
      kind: 'merge_request',
      reference: 'team/app!12',
      tone: 'draft',
      draft: true,
      sourceBranch: 'feat/sync',
      targetBranch: 'main',
      pipeline: 'success',
      comments: 3,
      changes: '7',
      labels: ['perf', 'sync'],
      author: { name: 'Anna', username: 'anna' },
      reviewers: [{ name: 'Ben', username: 'ben' }],
      url: `${base}/team/app/-/merge_requests/12`,
    });
    // The title stays text; addresses from the answer never reach the card
    expect(r.card.title).toBe('Faster sync <script>alert(1)</script>');
    expect(JSON.stringify(r.card)).not.toContain('evil.example.com');
    expect(r.card.description).toBe('Why Because speed matters. Docs');
  });

  it('show issues, milestones, projects and groups', async () => {
    const issue = await cards.card(`${base}/team/app/-/issues/4`);
    expect(issue).toMatchObject({ state: 'ok', card: { kind: 'issue', tone: 'closed', tasksDone: 2, tasksTotal: 3, due: '2026-12-01' } });
    const milestone = await cards.card(`${base}/team/app/-/milestones/3`);
    expect(milestone).toMatchObject({ state: 'ok', card: { kind: 'milestone', title: 'v2', tone: 'open', openIssues: 4, tasksDone: 6, tasksTotal: 10 } });
    const project = await cards.card(`${base}/team/app`);
    expect(project).toMatchObject({ state: 'ok', card: { kind: 'project', title: 'App', ref: 'main', stars: 5, languages: [{ name: 'TypeScript', percent: 80.6 }, { name: 'CSS', percent: 12 }] } });
    // Not a project: the same path as a group
    const group = await cards.card(`${base}/team/sub`);
    expect(group).toMatchObject({ state: 'ok', card: { kind: 'group', title: 'Sub', projects: 14, subgroups: 2, description: 'The sub group', url: `${base}/groups/team/sub` } });
  });

  it('refuse other hosts, paths outside the allowed ones and unknown things', async () => {
    const before = seen.length;
    expect(await cards.card('https://gitlab.com/team/app/-/issues/1')).toEqual({ state: 'unsupported' });
    expect(await cards.card(`${base}/other/app/-/issues/1`)).toEqual({ state: 'not_allowed' });
    expect(seen.length).toBe(before);
    expect(await cards.card(`${base}/team/app/-/issues/999`)).toEqual({ state: 'not_found' });
  });

  it('reduce descriptions to their first plain words', () => {
    expect(plainDescription('- [x] done\n> quote\n<img src=x onerror=alert(1)> ![i](x.png) text')).toBe('done quote text');
    expect(plainDescription(42)).toBeUndefined();
  });
});
