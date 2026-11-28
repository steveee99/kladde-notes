import type { CockpitParamValue, CockpitProblem, CockpitRow, CockpitValue } from '@kladde/shared';
import { RemoteError, type RemoteFetcher } from '../remote/RemoteFetcher.js';
import type { RemoteInstance } from '../remote/RemoteInstances.js';
import type { HttpTransport } from '../confluence/ConfluenceClient.js';
import type { GitlabConnection, JiraConnection } from './CockpitStore.js';

/*
 * The sources of the cockpit (shared/cockpit.ts names their parameters and fields). Each one asks fixed endpoints of
 * GitLab or Jira with the user's own token and turns the answer into generic rows. Only plain, bounded values are
 * taken: no markup, no addresses except the item's own page (which the client passes through `safeUrl`).
 */

export class CockpitError extends Error {
  constructor(
    readonly problem: CockpitProblem,
    detail = ''
  ) {
    super(detail || problem);
  }
}

type Json = Record<string, unknown>;
type Params = Record<string, CockpitParamValue>;

const MAX_TEXT = 300;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const text = (v: unknown, max = MAX_TEXT): string | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  // eslint-disable-next-line no-control-regex
  const s = String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return s ? (s.length > max ? `${s.slice(0, max - 1)}…` : s) : null;
};
const time = (v: unknown): number | null => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const names = (v: unknown, key = 'username'): string[] => (Array.isArray(v) ? v.map((p) => text(obj(p)?.[key], 100)).filter((s): s is string => !!s).slice(0, 12) : []);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((s) => text(s, 80)).filter((s): s is string => !!s).slice(0, 20) : []);
/** Only the page of the item on its own host */
const pageUrl = (v: unknown, origin: string): string | undefined => {
  if (typeof v !== 'string') return undefined;
  try {
    const u = new URL(v);
    return u.origin === origin && (u.protocol === 'https:' || u.protocol === 'http:') ? u.toString() : undefined;
  } catch {
    return undefined;
  }
};

const param = (p: Params, key: string): string => (typeof p[key] === 'string' ? (p[key] as string).trim() : '');
const list = (p: Params, key: string): string[] => (Array.isArray(p[key]) ? (p[key] as string[]) : []);
const enc = encodeURIComponent;
/** Project and group paths as GitLab writes them */
const isPath = (s: string) => /^[A-Za-z0-9_.][A-Za-z0-9_./-]{0,250}$/.test(s) && !s.includes('..') && !s.includes('//');
const JIRA_KEY = /\b([A-Z][A-Z0-9]{1,9}-\d{1,7})\b/;

const SPAN_HOURS: Record<string, number> = { '6h': 6, '24h': 24, '3d': 72, '7d': 168 };

// ------------------------------------------------------------------ GitLab

export interface GitlabAccess {
  fetcher: RemoteFetcher;
  host: RemoteInstance;
  connection: GitlabConnection;
  /** Read past the fetcher's short cache (a refresh, the notification job) */
  fresh?: boolean;
}

function problemOf(err: unknown): CockpitError {
  if (err instanceof CockpitError) return err;
  if (err instanceof RemoteError) {
    const p = err.problem as string;
    if (p === 'no_access' || p === 'not_found' || p === 'upstream_limit') return new CockpitError(p);
    return new CockpitError('unreachable');
  }
  return new CockpitError('unreachable');
}

/** The instance as `RemoteFetcher` reads it, with the user's token instead of the shared one */
const personal = (a: GitlabAccess): RemoteInstance => ({ ...a.host, token: a.connection.token, anonymous: false, allowedPaths: [] });

async function gitlabGet(a: GitlabAccess, path: string, max = 2 * 1024 * 1024, freshMs?: number): Promise<unknown> {
  try {
    return (await a.fetcher.apiJson(personal(a), path, { max, freshMs: freshMs ?? (a.fresh ? 0 : undefined) })).data;
  } catch (err) {
    throw problemOf(err);
  }
}

/** The account a token belongs to (checked when it is saved) */
export async function gitlabWhoAmI(a: GitlabAccess): Promise<{ username: string; userId: number; name: string }> {
  const me = obj(await gitlabGet(a, '/user', 256 * 1024, 0));
  const username = text(me?.username, 100);
  const userId = num(me?.id);
  if (!username || userId === null) throw new CockpitError('no_access');
  return { username, userId, name: text(me?.name, 100) ?? username };
}

/** Fills `{{me}}` with the connected account */
const me = (s: string, username: string) => s.replace(/\{\{\s*me\s*\}\}/g, username);

export async function gitlabMergeRequests(a: GitlabAccess, p: Params): Promise<CockpitRow[]> {
  const origin = new URL(a.host.url).origin;
  const project = me(param(p, 'project'), a.connection.username);
  const group = me(param(p, 'group'), a.connection.username);
  if ((project && !isPath(project)) || (group && !isPath(group))) throw new CockpitError('invalid', 'path');
  const base = project ? `/projects/${enc(project)}/merge_requests` : group ? `/groups/${enc(group)}/merge_requests` : '/merge_requests';
  const q = new URLSearchParams({ per_page: '100', order_by: 'updated_at', sort: 'desc' });
  const state = param(p, 'state') || 'opened';
  if (state !== 'all') q.set('state', state);
  const scope = param(p, 'scope') || 'authored';
  if (!project && !group) q.set('scope', 'all');
  if (scope === 'authored') q.set('author_id', String(a.connection.userId));
  else if (scope === 'review_requested') q.set('reviewer_id', String(a.connection.userId));
  else if (scope === 'assigned') q.set('assignee_id', String(a.connection.userId));
  const draft = param(p, 'draft');
  if (draft === 'yes' || draft === 'no') q.set('wip', draft);
  const labels = list(p, 'labels').map((l) => me(l, a.connection.username));
  if (labels.length) q.set('labels', labels.join(','));
  const search = me(param(p, 'search'), a.connection.username);
  if (search) q.set('search', search.slice(0, 200));
  const data = await gitlabGet(a, `${base}?${q.toString().replace(/\+/g, '%20')}`);
  if (!Array.isArray(data)) throw new CockpitError('unreachable');
  return data.slice(0, 100).flatMap((raw): CockpitRow[] => {
    const mr = obj(raw);
    const iid = num(mr?.iid);
    const projectId = num(mr?.project_id);
    if (!mr || iid === null || projectId === null) return [];
    const ref = text(obj(mr.references)?.full, 300) ?? '';
    const title = text(mr.title) ?? '';
    const branch = text(mr.source_branch, 200);
    const values: Record<string, CockpitValue> = {
      iid: `!${iid}`,
      title,
      project: ref.includes('!') ? ref.slice(0, ref.lastIndexOf('!')) : null,
      author: text(obj(mr.author)?.username, 100),
      assignees: names(mr.assignees),
      reviewers: names(mr.reviewers),
      state: text(mr.state, 40),
      status: text(mr.detailed_merge_status, 60) ?? text(mr.merge_status, 60),
      draft: mr.draft === true || mr.work_in_progress === true,
      conflicts: mr.has_conflicts === true,
      labels: strings(mr.labels),
      branch,
      target: text(mr.target_branch, 200),
      jira: JIRA_KEY.exec(`${title} ${branch ?? ''}`)?.[1] ?? null,
      comments: num(mr.user_notes_count),
      created: time(mr.created_at),
      updated: time(mr.updated_at),
    };
    return [{ id: `mr:${projectId}!${iid}`, url: pageUrl(mr.web_url, origin), values }];
  });
}

/** The branches of one repository (GitLab's own search on the name, at most 100) */
export async function gitlabBranches(a: GitlabAccess, p: Params): Promise<CockpitRow[]> {
  const origin = new URL(a.host.url).origin;
  const project = me(param(p, 'project'), a.connection.username);
  if (!project) throw new CockpitError('invalid', 'project');
  if (!isPath(project)) throw new CockpitError('invalid', 'path');
  const q = new URLSearchParams({ per_page: '100' });
  const search = me(param(p, 'search'), a.connection.username);
  if (search) q.set('search', search.slice(0, 200));
  const data = await gitlabGet(a, `/projects/${enc(project)}/repository/branches?${q.toString().replace(/\+/g, '%20')}`);
  if (!Array.isArray(data)) throw new CockpitError('unreachable');
  return data.slice(0, 100).flatMap((raw): CockpitRow[] => {
    const b = obj(raw);
    const name = text(b?.name, 250);
    if (!b || !name) return [];
    const commit = obj(b.commit);
    return [
      {
        id: `branch:${project}:${name}`,
        url: pageUrl(b.web_url, origin),
        values: {
          name,
          default: b.default === true,
          protected: b.protected === true,
          merged: b.merged === true,
          commit: text(commit?.title),
          author: text(commit?.author_name, 100),
          updated: time(commit?.committed_date ?? commit?.created_at),
        },
      },
    ];
  });
}

/** A path's parent (`team/backend/api` → `team/backend`), null at the top */
const parentPath = (path: string | null): string | null => (path && path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null);

/** The repositories of a group (with its subgroups unless switched off), or the ones the user is a member of */
export async function gitlabProjects(a: GitlabAccess, p: Params): Promise<CockpitRow[]> {
  const origin = new URL(a.host.url).origin;
  const group = me(param(p, 'group'), a.connection.username);
  if (group && !isPath(group)) throw new CockpitError('invalid', 'path');
  const q = new URLSearchParams({ order_by: 'last_activity_at', sort: 'desc', per_page: '100' });
  if (group) q.set('include_subgroups', p.subgroups === false ? 'false' : 'true');
  else q.set('membership', 'true');
  const archived = param(p, 'archived') || 'no';
  if (archived === 'no') q.set('archived', 'false');
  else if (archived === 'yes') q.set('archived', 'true');
  const search = me(param(p, 'search'), a.connection.username);
  if (search) q.set('search', search.slice(0, 200));
  const data = await gitlabGet(a, `${group ? `/groups/${enc(group)}/projects` : '/projects'}?${q.toString().replace(/\+/g, '%20')}`, 4 * 1024 * 1024);
  if (!Array.isArray(data)) throw new CockpitError('unreachable');
  return data.slice(0, 100).flatMap((raw): CockpitRow[] => {
    const pr = obj(raw);
    const id = num(pr?.id);
    if (!pr || id === null) return [];
    const path = text(pr.path_with_namespace, 250);
    return [
      {
        id: `project:${id}`,
        url: pageUrl(pr.web_url, origin),
        values: {
          name: text(pr.name, 200),
          path,
          namespace: text(obj(pr.namespace)?.full_path, 250) ?? parentPath(path),
          description: text(pr.description),
          visibility: text(pr.visibility, 20),
          defaultBranch: text(pr.default_branch, 200),
          topics: strings(pr.topics ?? pr.tag_list),
          archived: pr.archived === true,
          stars: num(pr.star_count),
          forks: num(pr.forks_count),
          openIssues: num(pr.open_issues_count),
          activity: time(pr.last_activity_at),
          created: time(pr.created_at),
        },
      },
    ];
  });
}

/** The subgroups of a group (direct ones or all levels), or the groups the user is a member of */
export async function gitlabGroups(a: GitlabAccess, p: Params): Promise<CockpitRow[]> {
  const origin = new URL(a.host.url).origin;
  const group = me(param(p, 'group'), a.connection.username);
  if (group && !isPath(group)) throw new CockpitError('invalid', 'path');
  const q = new URLSearchParams({ order_by: 'name', sort: 'asc', per_page: '100' });
  if (!group) q.set('min_access_level', '10');
  const search = me(param(p, 'search'), a.connection.username);
  if (search) q.set('search', search.slice(0, 200));
  const base = group ? `/groups/${enc(group)}/${p.descendants === true ? 'descendant_groups' : 'subgroups'}` : '/groups';
  const data = await gitlabGet(a, `${base}?${q.toString().replace(/\+/g, '%20')}`);
  if (!Array.isArray(data)) throw new CockpitError('unreachable');
  return data.slice(0, 100).flatMap((raw): CockpitRow[] => {
    const g = obj(raw);
    const id = num(g?.id);
    if (!g || id === null) return [];
    const path = text(g.full_path, 250);
    return [
      {
        id: `group:${id}`,
        url: pageUrl(g.web_url, origin),
        values: {
          name: text(g.name, 200),
          path,
          parent: parentPath(path),
          description: text(g.description),
          visibility: text(g.visibility, 20),
          created: time(g.created_at),
        },
      },
    ];
  });
}

/** Branch and tag names as Git allows them (no `..`, no leading dash, no `.lock` at the end) */
const isRef = (s: string) => /^[A-Za-z0-9_][A-Za-z0-9_./+-]{0,199}$/.test(s) && !s.includes('..') && !s.includes('//') && !s.endsWith('.lock') && !s.endsWith('/');
const PICKED = /\(cherry picked from commit ([0-9a-f]{7,40})\)/gi;
/** Titles compared without case, spacing and a trailing "(#123)" or "[skip ci]" */
const sameTitle = (t: string) => t.toLowerCase().replace(/\s*(\(#\d+\)|\[[^\]]*\])\s*$/g, '').replace(/\s+/g, ' ').trim();
const COMMIT_PAGES = 10;

interface Commit {
  sha: string;
  title: string;
  message: string;
  json: Json;
}

/** The commits of a revision range `a..b` (in b, not in a), newest first; `full` false when it has more than fits */
async function commitRange(a: GitlabAccess, project: string, from: string, to: string): Promise<{ commits: Commit[]; full: boolean }> {
  const commits: Commit[] = [];
  // The fetcher refuses ".." in a request; in the query the range's dots are encoded
  const range = `${enc(from)}..${enc(to)}`.replace(/\./g, '%2E');
  for (let page = 1; page <= COMMIT_PAGES; page++) {
    const data = await gitlabGet(a, `/projects/${enc(project)}/repository/commits?ref_name=${range}&per_page=100&page=${page}`, 4 * 1024 * 1024);
    if (!Array.isArray(data)) throw new CockpitError('unreachable');
    for (const raw of data) {
      const c = obj(raw);
      const sha = typeof c?.id === 'string' && /^[0-9a-f]{40,64}$/.test(c.id) ? c.id : null;
      if (!c || !sha) continue;
      commits.push({ sha, title: text(c.title) ?? '', message: typeof c.message === 'string' ? c.message.slice(0, 20_000) : '', json: c });
    }
    if (data.length < 100) return { commits, full: true };
  }
  return { commits, full: false };
}

/**
 * Commits of `from` that `to` lacks (`to..from`). With `cherryPicks: match` (the default) a commit counts as
 * contained when the target has a commit that names it in "(cherry picked from commit …)", that was picked from the
 * same commit, or that has the same title; merge commits only count with `merges`.
 */
export async function gitlabCompare(a: GitlabAccess, p: Params): Promise<{ rows: CockpitRow[]; partial: boolean }> {
  const origin = new URL(a.host.url).origin;
  const project = me(param(p, 'project'), a.connection.username);
  const from = param(p, 'from');
  const to = param(p, 'to');
  if (!project || !from || !to) throw new CockpitError('invalid', 'compare');
  if (!isPath(project) || !isRef(from) || !isRef(to)) throw new CockpitError('invalid', 'path');
  const missing = await commitRange(a, project, to, from);
  let partial = !missing.full;
  let candidates = missing.commits;
  if (p.merges !== true) candidates = candidates.filter((c) => !(Array.isArray(c.json.parent_ids) && c.json.parent_ids.length > 1));
  if (param(p, 'cherryPicks') !== 'strict' && candidates.length) {
    const target = await commitRange(a, project, from, to);
    if (!target.full) partial = true;
    const shas = new Set<string>();
    const titles = new Set<string>();
    for (const c of target.commits) {
      shas.add(c.sha);
      if (sameTitle(c.title)) titles.add(sameTitle(c.title));
      for (const m of c.message.matchAll(PICKED)) shas.add(m[1].toLowerCase());
    }
    const known = (sha: string) => shas.has(sha) || [...shas].some((s) => s.length < 40 && sha.startsWith(s));
    candidates = candidates.filter((c) => {
      if (known(c.sha) || (sameTitle(c.title) && titles.has(sameTitle(c.title)))) return false;
      // Both sides picked the same commit
      for (const m of c.message.matchAll(PICKED)) if (known(m[1].toLowerCase())) return false;
      return true;
    });
  }
  const rows = candidates.map((c): CockpitRow => {
    const short = text(c.json.short_id, 20) ?? c.sha.slice(0, 8);
    return {
      id: `commit:${project}:${c.sha}`,
      url: pageUrl(c.json.web_url, origin),
      values: {
        sha: short,
        title: c.title,
        author: text(c.json.author_name, 100),
        project,
        jira: JIRA_KEY.exec(c.title)?.[1] ?? null,
        merge: Array.isArray(c.json.parent_ids) && c.json.parent_ids.length > 1,
        created: time(c.json.created_at),
      },
    };
  });
  return { rows, partial };
}

/** Runs `fn` over `items` with at most `n` at a time */
async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

/**
 * Failed CI jobs across repositories. GitLab has no endpoint over all projects, so the projects come first (the
 * listed ones, a group's, or the user's recently active ones), then the recent jobs of each. With `latestOnly` a job
 * counts only while its latest run (per project, branch and name) failed, so a fixed job drops out.
 */
export async function gitlabFailedJobs(a: GitlabAccess, p: Params, now = Date.now()): Promise<{ rows: CockpitRow[]; partial: boolean }> {
  const origin = new URL(a.host.url).origin;
  const since = now - (SPAN_HOURS[param(p, 'since')] ?? 24) * 3_600_000;
  const maxProjects = Math.min(50, Math.max(1, Number(p.maxProjects) || 20));
  const wanted = list(p, 'projects').map((s) => me(s, a.connection.username)).filter(isPath).slice(0, maxProjects);
  const group = me(param(p, 'group'), a.connection.username);
  if (group && !isPath(group)) throw new CockpitError('invalid', 'path');

  let projects: { id: string; path: string }[];
  if (wanted.length) projects = wanted.map((path) => ({ id: enc(path), path }));
  else {
    const q = new URLSearchParams({ archived: 'false', order_by: 'last_activity_at', sort: 'desc', per_page: String(maxProjects), simple: 'true', last_activity_after: new Date(since).toISOString() });
    if (group) q.set('include_subgroups', 'true');
    else q.set('membership', 'true');
    const data = await gitlabGet(a, `${group ? `/groups/${enc(group)}/projects` : '/projects'}?${q}`);
    if (!Array.isArray(data)) throw new CockpitError('unreachable');
    projects = data.flatMap((raw) => {
      const pr = obj(raw);
      const id = num(pr?.id);
      const path = text(pr?.path_with_namespace, 250);
      return id !== null && path ? [{ id: String(id), path }] : [];
    });
  }

  const nameFilter = param(p, 'name').toLowerCase();
  const ref = param(p, 'ref');
  const latestOnly = p.latestOnly !== false;
  const withAllowed = p.allowFailure === true;
  let failedProjects = 0;
  const perProject = await pool(projects, 5, async (project) => {
    const q = latestOnly ? 'scope[]=failed&scope[]=success&per_page=100' : 'scope[]=failed&per_page=100';
    let data: unknown;
    try {
      data = await gitlabGet(a, `/projects/${project.id}/jobs?${q}`, 4 * 1024 * 1024);
    } catch (err) {
      // A project without CI or without access to its jobs is left out; the others still show
      failedProjects++;
      if (err instanceof CockpitError && err.problem === 'upstream_limit') throw err;
      return [];
    }
    if (!Array.isArray(data)) return [];
    const latest = new Map<string, Json>();
    for (const raw of data) {
      const job = obj(raw);
      if (!job) continue;
      const finished = time(job.finished_at) ?? time(job.created_at);
      if (finished === null || finished < since) continue;
      const name = text(job.name, 200) ?? '';
      const jobRef = text(job.ref, 200) ?? '';
      if (nameFilter && !name.toLowerCase().includes(nameFilter)) continue;
      if (ref && jobRef !== ref) continue;
      const key = `${jobRef}\n${name}`;
      // The list is newest first: the first job of a key is its latest run
      if (!latest.has(key)) latest.set(key, job);
      else if (!latestOnly && job.status === 'failed') latest.set(`${key}\n${String(job.id)}`, job);
    }
    return [...latest.values()].flatMap((job): CockpitRow[] => {
      if (job.status !== 'failed') return [];
      if (job.allow_failure === true && !withAllowed) return [];
      const id = num(job.id);
      if (id === null) return [];
      const pipeline = num(obj(job.pipeline)?.id);
      return [
        {
          id: `job:${project.path}:${id}`,
          url: pageUrl(job.web_url, origin),
          values: {
            name: text(job.name, 200),
            stage: text(job.stage, 100),
            project: project.path,
            ref: text(job.ref, 200),
            status: 'failed',
            reason: text(job.failure_reason, 100),
            user: text(obj(job.user)?.username, 100),
            commit: text(obj(job.commit)?.title, 200),
            pipeline: pipeline === null ? null : `#${pipeline}`,
            allowFailure: job.allow_failure === true,
            duration: num(job.duration) === null ? null : Math.round(num(job.duration)!),
            finished: time(job.finished_at) ?? time(job.created_at),
          },
        },
      ];
    });
  });
  return { rows: perProject.flat(), partial: failedProjects > 0 && failedProjects < projects.length };
}

// ------------------------------------------------------------------ Jira

const JIRA_FIELDS = ['summary', 'status', 'issuetype', 'priority', 'assignee', 'reporter', 'project', 'parent', 'labels', 'duedate', 'created', 'updated'];
const MAX_JIRA_RESPONSE = 8 * 1024 * 1024;

/** Jira's REST API: v3 with the enhanced search on Cloud, v2 on Data Center/Server */
export class JiraClient {
  private readonly base: string;
  private readonly auth: string;

  constructor(
    private readonly conn: Pick<JiraConnection, 'url' | 'kind' | 'email' | 'token'>,
    private readonly transport: HttpTransport
  ) {
    this.base = conn.url.replace(/\/+$/, '');
    this.auth = conn.kind === 'cloud' ? `Basic ${Buffer.from(`${conn.email}:${conn.token}`).toString('base64')}` : `Bearer ${conn.token}`;
  }

  private get api(): string {
    return `${this.base}/rest/api/${this.conn.kind === 'cloud' ? '3' : '2'}`;
  }

  private async call(method: 'GET' | 'POST', url: string, body?: unknown): Promise<unknown> {
    const res = await this.transport({
      method,
      url: new URL(url),
      headers: { Authorization: this.auth, Accept: 'application/json', 'User-Agent': 'Kladde', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: Buffer.from(JSON.stringify(body)) } : {}),
    }).catch(() => {
      throw new CockpitError('unreachable');
    });
    if (res.status === 401 || res.status === 403) throw new CockpitError('no_access');
    if (res.status === 429) throw new CockpitError('upstream_limit');
    if (res.status === 400) {
      // A JQL error: Jira's message helps fixing the query (plain text, bounded)
      let detail = '';
      try {
        const e = obj(JSON.parse(res.body.toString('utf8')));
        detail = (Array.isArray(e?.errorMessages) ? e!.errorMessages : []).map((m) => text(m, 200)).filter(Boolean).join(' ');
      } catch {
        /* no JSON */
      }
      throw new CockpitError('invalid', detail);
    }
    if (res.status === 404) throw new CockpitError('not_found');
    if (res.status < 200 || res.status >= 300 || res.body.length > MAX_JIRA_RESPONSE) throw new CockpitError('unreachable');
    try {
      return JSON.parse(res.body.toString('utf8'));
    } catch {
      throw new CockpitError('unreachable');
    }
  }

  async myself(): Promise<{ accountName: string; accountId: string }> {
    const me = obj(await this.call('GET', `${this.api}/myself`));
    const accountId = text(me?.accountId, 200) ?? text(me?.name, 200) ?? text(me?.key, 200);
    if (!me || !accountId) throw new CockpitError('no_access');
    return { accountName: text(me.displayName, 200) ?? accountId, accountId };
  }

  async search(jql: string, max = 100): Promise<CockpitRow[]> {
    const body = { jql, maxResults: Math.min(100, max), fields: JIRA_FIELDS };
    const data = obj(await this.call('POST', this.conn.kind === 'cloud' ? `${this.api}/search/jql` : `${this.api}/search`, body));
    const issues = Array.isArray(data?.issues) ? data!.issues : [];
    const origin = new URL(this.base).origin;
    return issues.slice(0, 100).flatMap((raw): CockpitRow[] => {
      const issue = obj(raw);
      const key = text(issue?.key, 40);
      if (!issue || !key || !/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) return [];
      const f = obj(issue.fields) ?? {};
      const status = obj(f.status);
      const cat = text(obj(status?.statusCategory)?.key, 40);
      const due = typeof f.duedate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f.duedate) ? Date.parse(`${f.duedate}T00:00:00Z`) : null;
      return [
        {
          id: `jira:${key}`,
          url: `${origin}${new URL(this.base).pathname.replace(/\/+$/, '')}/browse/${enc(key)}`,
          values: {
            key,
            title: text(f.summary),
            status: text(status?.name, 80),
            category: cat === 'done' ? 'done' : cat === 'indeterminate' ? 'active' : cat === 'new' ? 'open' : cat,
            type: text(obj(f.issuetype)?.name, 80),
            priority: text(obj(f.priority)?.name, 80),
            assignee: text(obj(f.assignee)?.displayName, 100),
            reporter: text(obj(f.reporter)?.displayName, 100),
            project: text(obj(f.project)?.key, 40),
            parent: text(obj(f.parent)?.key, 40),
            labels: strings(f.labels),
            due,
            created: time(f.created),
            updated: time(f.updated),
          },
        },
      ];
    });
  }
}
