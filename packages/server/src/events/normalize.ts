import crypto from 'crypto';
import type { IncomingHttpHeaders } from 'http';
import type { GitActor, GitCommit, GitDeploymentStatus, GitEventCore, GitPipelineStatus, GitProject, GitProvider } from '@kladde/plugin-api';

/*
 * Turns a delivery of GitLab or GitHub into one of Kladde's git events (docs/EVENTS.md). Everything is read
 * defensively: unknown or missing fields become empty strings, null or 0, texts are cut to fixed lengths and lists
 * to a few entries, so a large or odd payload never grows the event (or what plugins get) without bounds.
 */

type Obj = Record<string, unknown>;

const header = (h: IncomingHttpHeaders, name: string): string => {
  const v = h[name];
  return (Array.isArray(v) ? v[0] : v) ?? '';
};
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown, max = 300): string => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' ? String(v).slice(0, max) : '');
const long = (v: unknown) => text(v, 4000);
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const int = (v: unknown): number => Math.trunc(num(v) ?? 0);
const time = (v: unknown, fallback: number): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  const ms = typeof v === 'string' ? Date.parse(v.replace(/ UTC$/, 'Z').replace(/^(\d{4}-\d\d-\d\d) /, '$1T')) : NaN;
  return Number.isFinite(ms) ? ms : fallback;
};
const names = (v: unknown, key: string, max = 20): string[] =>
  arr(v)
    .map((x) => (typeof x === 'string' ? x : text(obj(x)[key], 100)))
    .filter(Boolean)
    .slice(0, max)
    .map((s) => s.slice(0, 100));
const firstLine = (s: string) => s.split('\n', 1)[0].slice(0, 300);
const ZERO = /^0+$/;
const branchOf = (ref: string) => (ref.startsWith('refs/heads/') ? ref.slice(11) : ref);
const tagOf = (ref: string) => (ref.startsWith('refs/tags/') ? ref.slice(10) : ref);
const MAX_COMMITS = 20;

const PIPELINE: Record<string, GitPipelineStatus> = {
  created: 'created',
  waiting_for_resource: 'waiting',
  preparing: 'pending',
  pending: 'pending',
  running: 'running',
  success: 'success',
  failed: 'failed',
  canceled: 'canceled',
  canceling: 'canceled',
  skipped: 'skipped',
  manual: 'manual',
  scheduled: 'scheduled',
  // GitHub (workflow runs and jobs: status, then conclusion)
  queued: 'pending',
  requested: 'pending',
  waiting: 'waiting',
  in_progress: 'running',
  completed: 'success',
  failure: 'failed',
  cancelled: 'canceled',
  timed_out: 'failed',
  action_required: 'manual',
  neutral: 'success',
  stale: 'canceled',
  startup_failure: 'failed',
};
const pipelineStatus = (v: unknown): GitPipelineStatus => PIPELINE[text(v, 40)] ?? 'pending';

const DEPLOYMENT: Record<string, GitDeploymentStatus> = {
  created: 'created',
  pending: 'created',
  queued: 'created',
  running: 'running',
  in_progress: 'running',
  success: 'success',
  failed: 'failed',
  failure: 'failed',
  error: 'failed',
  canceled: 'canceled',
  inactive: 'canceled',
};
const deploymentStatus = (v: unknown): GitDeploymentStatus => DEPLOYMENT[text(v, 40)] ?? 'created';

/** The delivery's id: the provider's header, otherwise a hash of the body (the same body counts as the same delivery) */
export function deliveryIdOf(provider: GitProvider, headers: IncomingHttpHeaders, body: Buffer): string {
  const id = header(headers, provider === 'gitlab' ? 'x-gitlab-event-uuid' : 'x-github-delivery').trim();
  return /^[\w-]{8,100}$/.test(id) ? id : `sha256-${crypto.createHash('sha256').update(body).digest('hex').slice(0, 32)}`;
}

/** The event name the provider gives a delivery (`Push Hook`, `pull_request`), for the delivery list */
export function deliveryKindOf(provider: GitProvider, headers: IncomingHttpHeaders): string {
  return header(headers, provider === 'gitlab' ? 'x-gitlab-event' : 'x-github-event').slice(0, 60);
}

/** A delivery as Kladde's event, or null for events Kladde does not know (pings, member changes, …) */
export function normalizeDelivery(provider: GitProvider, headers: IncomingHttpHeaders, payload: unknown, body: Buffer, now = Date.now()): GitEventCore | null {
  const id = deliveryIdOf(provider, headers, body);
  const event = provider === 'gitlab' ? gitlab(header(headers, 'x-gitlab-event'), obj(payload), now) : github(header(headers, 'x-github-event'), obj(payload), now);
  return event ? ({ ...event, id, provider } as GitEventCore) : null;
}

type Draft = { [K in GitEventCore['type']]: Omit<Extract<GitEventCore, { type: K }>, 'id' | 'provider'> }[GitEventCore['type']];

// ------------------------------------------------------------------ GitLab

function gitlabProject(body: Obj): GitProject {
  const p = obj(body.project);
  const repo = obj(body.repository);
  return {
    path: text(p.path_with_namespace, 300),
    name: text(p.name ?? repo.name, 200),
    url: text(p.web_url ?? repo.homepage, 500),
    defaultBranch: text(p.default_branch, 200),
  };
}

function gitlabActor(body: Obj): GitActor | null {
  const u = obj(body.user);
  const username = text(u.username ?? body.user_username, 100);
  if (!username) return null;
  return { username, name: text(u.name ?? body.user_name, 200) || username };
}

function gitlabCommits(v: unknown): GitCommit[] {
  return arr(v)
    .slice(-MAX_COMMITS)
    .map((c) => {
      const o = obj(c);
      const message = long(o.message);
      return { sha: text(o.id, 64), title: firstLine(text(o.title) || message), message, url: text(o.url, 500), author: text(obj(o.author).name, 200), at: time(o.timestamp, 0) };
    });
}

const MR_ACTION: Record<string, 'opened' | 'reopened' | 'updated' | 'merged' | 'closed' | 'approved' | 'unapproved'> = {
  open: 'opened',
  reopen: 'reopened',
  update: 'updated',
  merge: 'merged',
  close: 'closed',
  approved: 'approved',
  approval: 'approved',
  unapproved: 'unapproved',
  unapproval: 'unapproved',
};

function gitlab(kind: string, body: Obj, now: number): Draft | null {
  const objectKind = text(body.object_kind, 40);
  const project = gitlabProject(body);
  const actor = gitlabActor(body);
  const a = obj(body.object_attributes);
  const base = { project, actor };

  if (kind === 'Merge Request Hook' || objectKind === 'merge_request') {
    const action = MR_ACTION[text(a.action, 40)];
    if (!action) return null;
    const state = text(a.state, 20);
    return {
      ...base,
      type: 'git.merge_request',
      action,
      at: time(a.updated_at, now),
      mergeRequest: {
        number: int(a.iid),
        title: text(a.title, 500),
        description: long(a.description),
        url: text(a.url, 500),
        state: state === 'merged' || action === 'merged' ? 'merged' : state === 'closed' || action === 'closed' ? 'closed' : 'open',
        draft: a.draft === true || a.work_in_progress === true,
        sourceBranch: text(a.source_branch),
        targetBranch: text(a.target_branch),
        sha: text(obj(a.last_commit).id, 64),
        author: text(obj(body.user).username, 100),
        labels: names(body.labels ?? a.labels, 'title'),
        assignees: names(body.assignees, 'username'),
        reviewers: names(body.reviewers, 'username'),
      },
    };
  }

  if (kind === 'Push Hook' || objectKind === 'push') {
    const ref = text(body.ref);
    const before = text(body.before, 64);
    const after = text(body.after, 64);
    return {
      ...base,
      type: 'git.push',
      action: ZERO.test(before) ? 'created' : ZERO.test(after) ? 'deleted' : 'pushed',
      at: now,
      push: { ref, branch: branchOf(ref), before, after, commits: gitlabCommits(body.commits), commitCount: int(body.total_commits_count) || arr(body.commits).length },
    };
  }

  if (kind === 'Tag Push Hook' || objectKind === 'tag_push') {
    const ref = text(body.ref);
    const after = text(body.after, 64);
    return { ...base, type: 'git.tag', action: ZERO.test(after) ? 'deleted' : 'created', at: now, tag: { name: tagOf(ref), ref, sha: after || text(body.checkout_sha, 64), message: long(body.message) } };
  }

  if (kind === 'Pipeline Hook' || objectKind === 'pipeline') {
    const status = pipelineStatus(a.status);
    const mr = obj(body.merge_request);
    return {
      ...base,
      type: 'git.pipeline',
      action: status,
      at: time(a.finished_at ?? a.created_at, now),
      pipeline: {
        id: int(a.id),
        status,
        ref: text(a.ref),
        sha: text(a.sha, 64),
        url: text(a.url, 500) || (project.url && a.id ? `${project.url}/-/pipelines/${int(a.id)}` : ''),
        source: text(a.source, 60),
        mergeRequest: num(mr.iid),
        durationSeconds: num(a.duration),
        name: text(a.name, 200),
      },
    };
  }

  if (kind === 'Job Hook' || objectKind === 'build') {
    const status = pipelineStatus(body.build_status);
    const repo = obj(body.repository);
    const url = text(repo.homepage, 500);
    return {
      // Older GitLab versions send no `project`, only `project_name` ("Group / Project") and `repository`
      project: { path: project.path || text(body.project_name, 300).replace(/ \/ /g, '/'), name: project.name || text(repo.name, 200), url: project.url || url, defaultBranch: project.defaultBranch },
      actor,
      type: 'git.job',
      action: status,
      at: time(body.build_finished_at ?? body.build_started_at ?? body.build_created_at, now),
      job: {
        id: int(body.build_id),
        name: text(body.build_name, 200),
        stage: text(body.build_stage, 100),
        status,
        ref: text(body.ref),
        sha: text(body.sha, 64),
        url: url && body.build_id ? `${url}/-/jobs/${int(body.build_id)}` : '',
        pipelineId: num(body.pipeline_id),
        allowFailure: body.build_allow_failure === true,
        durationSeconds: num(body.build_duration),
        failureReason: text(body.build_failure_reason, 100),
      },
    };
  }

  if (kind === 'Note Hook' || kind === 'Confidential Note Hook' || objectKind === 'note') {
    const type = text(a.noteable_type, 40);
    const on = type === 'MergeRequest' ? 'merge_request' : type === 'Issue' ? 'issue' : type === 'Commit' ? 'commit' : type === 'Snippet' ? 'snippet' : null;
    if (!on) return null;
    const target = obj(on === 'merge_request' ? body.merge_request : on === 'issue' ? body.issue : on === 'snippet' ? body.snippet : {});
    return {
      ...base,
      type: 'git.comment',
      // Newer GitLab versions also report edits (`action: update`)
      action: text(a.action, 20) === 'update' ? 'edited' : 'created',
      at: time(a.updated_at ?? a.created_at, now),
      comment: {
        id: int(a.id),
        body: long(a.note),
        url: text(a.url, 500),
        on,
        number: on === 'merge_request' || on === 'issue' ? num(target.iid) : null,
        title: text(target.title, 500),
        sha: on === 'commit' ? text(obj(body.commit).id ?? a.commit_id, 64) : '',
      },
    };
  }

  if (kind === 'Issue Hook' || kind === 'Confidential Issue Hook' || objectKind === 'issue') {
    const raw = text(a.action, 40);
    const action = raw === 'open' ? 'opened' : raw === 'reopen' ? 'reopened' : raw === 'close' ? 'closed' : raw === 'update' ? 'updated' : null;
    if (!action) return null;
    return {
      ...base,
      type: 'git.issue',
      action,
      at: time(a.updated_at, now),
      issue: {
        number: int(a.iid),
        title: text(a.title, 500),
        description: long(a.description),
        url: text(a.url, 500),
        state: text(a.state, 20) === 'closed' ? 'closed' : 'open',
        author: actor && raw === 'open' ? actor.username : '',
        labels: names(body.labels ?? a.labels, 'title'),
        assignees: names(body.assignees, 'username'),
        confidential: a.confidential === true || kind === 'Confidential Issue Hook',
      },
    };
  }

  if (kind === 'Release Hook' || objectKind === 'release') {
    const raw = text(body.action, 40);
    const action = raw === 'create' ? 'created' : raw === 'update' ? 'updated' : raw === 'delete' ? 'deleted' : null;
    if (!action) return null;
    return { ...base, type: 'git.release', action, at: time(body.released_at ?? body.created_at, now), release: { tag: text(body.tag), name: text(body.name, 300), description: long(body.description), url: text(body.url, 500) } };
  }

  if (kind === 'Deployment Hook' || objectKind === 'deployment') {
    const status = deploymentStatus(body.status);
    return {
      ...base,
      type: 'git.deployment',
      action: status,
      at: time(body.status_changed_at, now),
      deployment: { id: int(body.deployment_id), environment: text(body.environment, 200), status, ref: text(body.ref), sha: text(body.short_sha ?? body.commit_sha, 64), url: text(body.deployable_url ?? body.environment_external_url, 500) },
    };
  }

  if (kind === 'Wiki Page Hook' || objectKind === 'wiki_page') {
    const raw = text(a.action, 40);
    const action = raw === 'create' ? 'created' : raw === 'update' ? 'updated' : raw === 'delete' ? 'deleted' : null;
    if (!action) return null;
    return { ...base, type: 'git.wiki', action, at: now, wiki: { title: text(a.title, 300), slug: text(a.slug, 300), url: text(a.url, 500) } };
  }

  return null;
}

// ------------------------------------------------------------------ GitHub

function githubProject(body: Obj): GitProject {
  const r = obj(body.repository);
  return { path: text(r.full_name, 300), name: text(r.name, 200), url: text(r.html_url, 500), defaultBranch: text(r.default_branch, 200) };
}

function githubActor(body: Obj): GitActor | null {
  const s = obj(body.sender);
  const username = text(s.login, 100);
  return username ? { username, name: text(s.name, 200) || username } : null;
}

function githubPull(pr: Obj) {
  const merged = pr.merged === true || !!pr.merged_at;
  return {
    number: int(pr.number),
    title: text(pr.title, 500),
    description: long(pr.body),
    url: text(pr.html_url, 500),
    state: merged ? ('merged' as const) : text(pr.state, 20) === 'closed' ? ('closed' as const) : ('open' as const),
    draft: pr.draft === true,
    sourceBranch: text(obj(pr.head).ref),
    targetBranch: text(obj(pr.base).ref),
    sha: text(obj(pr.head).sha, 64),
    author: text(obj(pr.user).login, 100),
    labels: names(pr.labels, 'name'),
    assignees: names(pr.assignees, 'login'),
    reviewers: names(pr.requested_reviewers, 'login'),
  };
}

function github(kind: string, body: Obj, now: number): Draft | null {
  const base = { project: githubProject(body), actor: githubActor(body) };
  const action = text(body.action, 40);

  if (kind === 'pull_request') {
    const pr = obj(body.pull_request);
    const mapped =
      action === 'opened' || action === 'ready_for_review'
        ? 'opened'
        : action === 'reopened'
          ? 'reopened'
          : action === 'closed'
            ? pr.merged === true
              ? 'merged'
              : 'closed'
            : ['edited', 'synchronize', 'labeled', 'unlabeled', 'assigned', 'unassigned', 'review_requested', 'converted_to_draft'].includes(action)
              ? 'updated'
              : null;
    if (!mapped) return null;
    return { ...base, type: 'git.merge_request', action: mapped, at: time(pr.updated_at, now), mergeRequest: githubPull(pr) };
  }

  if (kind === 'pull_request_review') {
    const state = text(obj(body.review).state, 40).toLowerCase();
    const mapped = action === 'submitted' && state === 'approved' ? 'approved' : action === 'dismissed' ? 'unapproved' : null;
    if (!mapped) return null;
    return { ...base, type: 'git.merge_request', action: mapped, at: time(obj(body.review).submitted_at, now), mergeRequest: githubPull(obj(body.pull_request)) };
  }

  if (kind === 'push') {
    const ref = text(body.ref);
    const commits = arr(body.commits);
    if (ref.startsWith('refs/tags/')) {
      const after = text(body.after, 64);
      return { ...base, type: 'git.tag', action: body.deleted === true ? 'deleted' : 'created', at: now, tag: { name: tagOf(ref), ref, sha: body.deleted === true ? '' : after, message: '' } };
    }
    return {
      ...base,
      type: 'git.push',
      action: body.created === true ? 'created' : body.deleted === true ? 'deleted' : 'pushed',
      at: now,
      push: {
        ref,
        branch: branchOf(ref),
        before: text(body.before, 64),
        after: text(body.after, 64),
        commits: commits.slice(-MAX_COMMITS).map((c) => {
          const o = obj(c);
          const message = long(o.message);
          return { sha: text(o.id, 64), title: firstLine(message), message, url: text(o.url, 500), author: text(obj(o.author).name, 200), at: time(o.timestamp, 0) };
        }),
        commitCount: commits.length,
      },
    };
  }

  if (kind === 'workflow_run') {
    const run = obj(body.workflow_run);
    const status = text(run.status, 40) === 'completed' ? pipelineStatus(run.conclusion) : pipelineStatus(run.status);
    const prs = arr(run.pull_requests);
    const started = time(run.run_started_at, 0);
    const ended = text(run.status, 40) === 'completed' ? time(run.updated_at, 0) : 0;
    return {
      ...base,
      type: 'git.pipeline',
      action: status,
      at: time(run.updated_at, now),
      pipeline: {
        id: int(run.id),
        status,
        ref: text(run.head_branch),
        sha: text(run.head_sha, 64),
        url: text(run.html_url, 500),
        source: text(run.event, 60),
        mergeRequest: prs.length ? num(obj(prs[0]).number) : null,
        durationSeconds: started && ended ? Math.round((ended - started) / 1000) : null,
        name: text(run.name, 200),
      },
    };
  }

  if (kind === 'workflow_job') {
    const job = obj(body.workflow_job);
    const status = text(job.status, 40) === 'completed' ? pipelineStatus(job.conclusion) : pipelineStatus(job.status);
    const started = time(job.started_at, 0);
    const ended = time(job.completed_at, 0);
    return {
      ...base,
      type: 'git.job',
      action: status,
      at: time(job.completed_at ?? job.started_at, now),
      job: {
        id: int(job.id),
        name: text(job.name, 200),
        stage: text(job.workflow_name, 100),
        status,
        ref: text(job.head_branch),
        sha: text(job.head_sha, 64),
        url: text(job.html_url, 500),
        pipelineId: num(job.run_id),
        allowFailure: false,
        durationSeconds: started && ended ? Math.round((ended - started) / 1000) : null,
        failureReason: text(job.conclusion, 40) === 'failure' ? 'failure' : '',
      },
    };
  }

  if (kind === 'issue_comment' || kind === 'pull_request_review_comment' || kind === 'commit_comment') {
    const mapped = action === 'created' ? 'created' : action === 'edited' ? 'edited' : action === 'deleted' ? 'deleted' : null;
    if (!mapped) return null;
    const c = obj(body.comment);
    const issue = obj(body.issue);
    const pr = obj(body.pull_request);
    const on = kind === 'commit_comment' ? 'commit' : kind === 'pull_request_review_comment' || issue.pull_request ? 'merge_request' : 'issue';
    const target = kind === 'pull_request_review_comment' ? pr : issue;
    return {
      ...base,
      type: 'git.comment',
      action: mapped,
      at: time(c.updated_at ?? c.created_at, now),
      comment: { id: int(c.id), body: long(c.body), url: text(c.html_url, 500), on, number: on === 'commit' ? null : num(target.number), title: on === 'commit' ? '' : text(target.title, 500), sha: on === 'commit' ? text(c.commit_id, 64) : '' },
    };
  }

  if (kind === 'issues') {
    const mapped = action === 'opened' ? 'opened' : action === 'reopened' ? 'reopened' : action === 'closed' ? 'closed' : ['edited', 'labeled', 'unlabeled', 'assigned', 'unassigned'].includes(action) ? 'updated' : null;
    if (!mapped) return null;
    const i = obj(body.issue);
    return {
      ...base,
      type: 'git.issue',
      action: mapped,
      at: time(i.updated_at, now),
      issue: {
        number: int(i.number),
        title: text(i.title, 500),
        description: long(i.body),
        url: text(i.html_url, 500),
        state: text(i.state, 20) === 'closed' ? 'closed' : 'open',
        author: text(obj(i.user).login, 100),
        labels: names(i.labels, 'name'),
        assignees: names(i.assignees, 'login'),
        confidential: false,
      },
    };
  }

  if (kind === 'release') {
    const mapped = action === 'published' || action === 'created' ? 'created' : action === 'edited' ? 'updated' : action === 'deleted' ? 'deleted' : null;
    // GitHub sends `created` and `published` for one release; only `published` counts (drafts stay quiet)
    if (!mapped || action === 'created') return null;
    const r = obj(body.release);
    return { ...base, type: 'git.release', action: mapped, at: time(r.published_at ?? r.created_at, now), release: { tag: text(r.tag_name), name: text(r.name, 300), description: long(r.body), url: text(r.html_url, 500) } };
  }

  if (kind === 'deployment_status') {
    const s = obj(body.deployment_status);
    const d = obj(body.deployment);
    const status = deploymentStatus(s.state);
    return {
      ...base,
      type: 'git.deployment',
      action: status,
      at: time(s.updated_at ?? s.created_at, now),
      deployment: { id: int(d.id), environment: text(s.environment ?? d.environment, 200), status, ref: text(d.ref), sha: text(d.sha, 64), url: text(s.environment_url ?? s.target_url, 500) },
    };
  }

  if (kind === 'gollum') {
    const page = obj(arr(body.pages)[0]);
    const raw = text(page.action, 20);
    const mapped = raw === 'created' ? 'created' : raw === 'edited' ? 'updated' : null;
    if (!mapped) return null;
    return { ...base, type: 'git.wiki', action: mapped, at: now, wiki: { title: text(page.title, 300), slug: text(page.page_name, 300), url: text(page.html_url, 500) } };
  }

  return null;
}

/** Whether the event's project is one of the source's projects (exact path or anything below a group path) */
export function matchesProjects(path: string, projects: string[]): boolean {
  if (!projects.length) return true;
  const p = path.toLowerCase();
  return projects.some((x) => {
    let q = x.toLowerCase();
    while (q.endsWith('/')) q = q.slice(0, -1);
    return p === q || p.startsWith(`${q}/`);
  });
}
