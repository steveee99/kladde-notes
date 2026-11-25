import {
  gitlabPathAllowed,
  gitlabTone,
  parseGitlabUrl,
  type GitlabCard,
  type GitlabCardKind,
  type GitlabCardResponse,
  type GitlabPerson,
  type GitlabResource,
} from '@kladde/shared';
import { RemoteError, type RemoteFetcher } from './RemoteFetcher.js';
import type { RemoteInstance, RemoteInstances } from './RemoteInstances.js';

/**
 * Preview cards of GitLab links (shared/gitlabCard.ts). The address is checked against the configured instances and
 * their allowed paths before anything is asked; requests go to fixed API endpoints of the instance (through
 * `RemoteFetcher`, which never leaves its API root). Only plain fields are taken from the answers and bounded, so a
 * card never carries markup, addresses from GitLab or more than a few hundred characters per field.
 */

type Json = Record<string, unknown>;

const enc = encodeURIComponent;
const MAX_TEXT = 300;
const MAX_LIST = 12;

const text = (v: unknown, max = MAX_TEXT): string | undefined => {
  if (typeof v !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return s ? (s.length > max ? `${s.slice(0, max - 1)}…` : s) : undefined;
};
const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);
const time = (v: unknown): number | undefined => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : undefined;
};
const date = (v: unknown): string | undefined => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const person = (v: unknown): GitlabPerson | undefined => {
  const o = obj(v);
  const username = text(o?.username, 100);
  return o && username ? { name: text(o.name, 100) ?? username, username } : undefined;
};
const people = (v: unknown): GitlabPerson[] | undefined => {
  const list = Array.isArray(v) ? v.map(person).filter((p): p is GitlabPerson => !!p).slice(0, MAX_LIST) : [];
  return list.length ? list : undefined;
};
const strings = (v: unknown, max = MAX_LIST): string[] | undefined => {
  const list = Array.isArray(v) ? v.map((x) => text(typeof x === 'string' ? x : obj(x)?.name, 80)).filter((s): s is string => !!s).slice(0, max) : [];
  return list.length ? list : undefined;
};

/** The first lines of a Markdown description as plain text */
export function plainDescription(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const plain = v
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]{1,200}>/g, ' ')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ');
  return text(plain, 280);
}

/** Drops empty fields, so the answer stays small */
function compact(card: GitlabCard): GitlabCard {
  return Object.fromEntries(Object.entries(card).filter(([, v]) => v !== undefined && v !== null && v !== '')) as unknown as GitlabCard;
}

export class GitlabCards {
  constructor(
    private readonly instances: RemoteInstances,
    private readonly fetcher: RemoteFetcher
  ) {}

  /** The card of an address; problems are answered as states, never with what GitLab said */
  async card(url: string, fresh = false): Promise<GitlabCardResponse> {
    const active = this.instances.active().filter((i) => i.kind === 'gitlab');
    const resource = parseGitlabUrl(url, active);
    if (!resource) return { state: active.length ? 'unsupported' : 'host_not_configured' };
    const instance = active.find((i) => i.url === resource.host)!;
    if (!gitlabPathAllowed(resource.path, instance.allowedPaths)) return { state: 'not_allowed' };
    try {
      return { state: 'ok', card: compact(await this.load(instance, resource, fresh)), fetchedAt: Date.now() };
    } catch (err) {
      if (err instanceof RemoteError) return { state: err.problem };
      throw err;
    }
  }

  /** `fresh`: asked for again, not taken from the fetcher's minute-long cache */
  private api(fresh: boolean, instance: RemoteInstance, path: string) {
    return this.fetcher.apiJson(instance, path, fresh ? { freshMs: 0 } : {});
  }

  /** The web address of the card: built from the instance and checked parts, never taken from the answer */
  private web(instance: RemoteInstance, r: GitlabResource, kind: GitlabCardKind): string {
    const base = `${instance.url}/${r.path.split('/').map(enc).join('/')}`;
    switch (kind) {
      case 'merge_request':
        return `${base}/-/merge_requests/${r.id}`;
      case 'issue':
        return `${base}/-/issues/${r.id}`;
      case 'pipeline':
        return `${base}/-/pipelines/${r.id}`;
      case 'commit':
        return `${base}/-/commit/${r.id}`;
      case 'milestone':
        return `${base}/-/milestones/${r.id}`;
      case 'release':
        return `${base}/-/releases/${enc(r.id!)}`;
      case 'group':
        return `${instance.url}/groups/${r.path.split('/').map(enc).join('/')}`;
      default:
        return base;
    }
  }

  private async load(instance: RemoteInstance, r: GitlabResource, fresh: boolean): Promise<GitlabCard> {
    const project = `/projects/${enc(r.path)}`;
    switch (r.kind) {
      case 'merge_request': {
        const { data } = await this.api(fresh, instance, `${project}/merge_requests/${r.id}`);
        const mr = obj(data) ?? {};
        const pipeline = obj(mr.head_pipeline) ?? obj(mr.pipeline);
        const draft = mr.draft === true || mr.work_in_progress === true;
        return {
          kind: 'merge_request',
          url: this.web(instance, r, 'merge_request'),
          title: text(mr.title) ?? `!${r.id}`,
          reference: `${r.path}!${r.id}`,
          state: text(mr.state, 30),
          tone: gitlabTone('merge_request', text(mr.state, 30), draft),
          draft,
          description: plainDescription(mr.description),
          author: person(mr.author),
          assignees: people(mr.assignees),
          reviewers: people(mr.reviewers),
          labels: strings(mr.labels),
          milestone: text(obj(mr.milestone)?.title, 100),
          sourceBranch: text(mr.source_branch, 120),
          targetBranch: text(mr.target_branch, 120),
          pipeline: text(pipeline?.status, 30),
          conflicts: mr.has_conflicts === true || undefined,
          comments: count(mr.user_notes_count),
          upvotes: count(mr.upvotes),
          changes: text(mr.changes_count, 10),
          created: time(mr.created_at),
          updated: time(mr.updated_at),
          merged: time(mr.merged_at),
          closed: time(mr.closed_at),
        };
      }
      case 'issue': {
        const { data } = await this.api(fresh, instance, `${project}/issues/${r.id}`);
        const issue = obj(data) ?? {};
        const tasks = obj(issue.task_completion_status);
        return {
          kind: 'issue',
          url: this.web(instance, r, 'issue'),
          title: text(issue.title) ?? `#${r.id}`,
          reference: `${r.path}#${r.id}`,
          state: text(issue.state, 30),
          tone: gitlabTone('issue', text(issue.state, 30)),
          description: plainDescription(issue.description),
          author: person(issue.author),
          assignees: people(issue.assignees),
          labels: strings(issue.labels),
          milestone: text(obj(issue.milestone)?.title, 100),
          comments: count(issue.user_notes_count),
          upvotes: count(issue.upvotes),
          tasksDone: count(tasks?.completed_count),
          tasksTotal: count(tasks?.count) || undefined,
          due: date(issue.due_date),
          created: time(issue.created_at),
          updated: time(issue.updated_at),
          closed: time(issue.closed_at),
        };
      }
      case 'pipeline': {
        const { data } = await this.api(fresh, instance, `${project}/pipelines/${r.id}`);
        const p = obj(data) ?? {};
        return {
          kind: 'pipeline',
          url: this.web(instance, r, 'pipeline'),
          title: text(p.name, 200) ?? `#${r.id}`,
          reference: `${r.path} · #${r.id}`,
          state: text(p.status, 30),
          tone: gitlabTone('pipeline', text(p.status, 30)),
          ref: text(p.ref, 120),
          author: person(p.user),
          duration: count(p.duration),
          created: time(p.created_at),
          updated: time(p.finished_at) ?? time(p.updated_at),
        };
      }
      case 'commit': {
        const { data } = await this.api(fresh, instance, `${project}/repository/commits/${r.id}?stats=true`);
        const c = obj(data) ?? {};
        const stats = obj(c.stats);
        const pipeline = obj(c.last_pipeline);
        const name = text(c.author_name, 100);
        return {
          kind: 'commit',
          url: this.web(instance, r, 'commit'),
          title: text(c.title) ?? r.id!,
          reference: `${r.path}@${text(c.short_id, 12) ?? r.id!.slice(0, 8)}`,
          description: plainDescription(typeof c.message === 'string' ? c.message.split('\n').slice(1).join('\n') : undefined),
          author: name ? { name, username: '' } : undefined,
          pipeline: text(pipeline?.status, 30),
          tone: pipeline ? gitlabTone('pipeline', text(pipeline.status, 30)) : 'neutral',
          additions: count(stats?.additions),
          deletions: count(stats?.deletions),
          created: time(c.authored_date) ?? time(c.created_at),
        };
      }
      case 'milestone': {
        const { data } = await this.api(fresh, instance, `${project}/milestones?iids[]=${r.id}`);
        const m = obj(Array.isArray(data) ? data[0] : null);
        if (!m) throw new RemoteError('not_found');
        const id = count(m.id);
        // Progress: open and closed issues of the milestone (best effort, one request each)
        let openIssues: number | undefined;
        let closedIssues: number | undefined;
        if (id !== undefined) {
          const [open, closed] = await Promise.all(
            (['opened', 'closed'] as const).map((state) =>
              this.api(fresh, instance, `${project}/issues?milestone_id=${id}&state=${state}&per_page=1`).then(
                (x) => x.total ?? undefined,
                () => undefined
              )
            )
          );
          openIssues = open;
          closedIssues = closed;
        }
        return {
          kind: 'milestone',
          url: this.web(instance, r, 'milestone'),
          title: text(m.title) ?? `%${r.id}`,
          reference: `${r.path}%${r.id}`,
          state: text(m.state, 30),
          tone: gitlabTone('milestone', text(m.state, 30)),
          description: plainDescription(m.description),
          start: date(m.start_date),
          due: date(m.due_date),
          openIssues,
          tasksDone: closedIssues,
          tasksTotal: openIssues !== undefined && closedIssues !== undefined ? openIssues + closedIssues || undefined : undefined,
          updated: time(m.updated_at),
        };
      }
      case 'release': {
        const { data } = await this.api(fresh, instance, `${project}/releases/${enc(r.id!)}`);
        const rel = obj(data) ?? {};
        return {
          kind: 'release',
          url: this.web(instance, r, 'release'),
          title: text(rel.name) ?? r.id!,
          reference: `${r.path} · ${r.id}`,
          ref: text(rel.tag_name, 120) ?? r.id!,
          description: plainDescription(rel.description),
          author: person(rel.author),
          created: time(rel.released_at) ?? time(rel.created_at),
          tone: 'neutral',
        };
      }
      case 'group':
        return this.group(instance, r, fresh);
      case 'project':
        return this.project(instance, r, fresh);
      case 'path':
        // A path without `/-/`: a project if there is one, otherwise a group
        try {
          return await this.project(instance, r, fresh);
        } catch (err) {
          if (err instanceof RemoteError && err.problem === 'not_found') return this.group(instance, r, fresh);
          throw err;
        }
    }
  }

  private async project(instance: RemoteInstance, r: GitlabResource, fresh: boolean): Promise<GitlabCard> {
    const project = `/projects/${enc(r.path)}`;
    const { data } = await this.api(fresh, instance, project);
    const p = obj(data) ?? {};
    const languages = await this.api(fresh, instance, `${project}/languages`).then(
      ({ data: l }) =>
        Object.entries(obj(l) ?? {})
          .filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] > 0)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([name, percent]) => ({ name: name.slice(0, 40), percent: Math.round(percent * 10) / 10 })),
      () => []
    );
    return {
      kind: 'project',
      url: this.web(instance, r, 'project'),
      title: text(p.name, 200) ?? r.path.split('/').pop()!,
      reference: text(p.path_with_namespace, 300) ?? r.path,
      description: plainDescription(p.description),
      ref: text(p.default_branch, 120),
      visibility: text(p.visibility, 20),
      topics: strings(p.topics ?? p.tag_list, 8),
      languages: languages.length ? languages : undefined,
      stars: count(p.star_count),
      forks: count(p.forks_count),
      openIssues: count(p.open_issues_count),
      created: time(p.created_at),
      updated: time(p.last_activity_at),
      tone: p.archived === true ? 'closed' : 'neutral',
      state: p.archived === true ? 'archived' : undefined,
    };
  }

  private async group(instance: RemoteInstance, r: GitlabResource, fresh: boolean): Promise<GitlabCard> {
    const group = `/groups/${enc(r.path)}`;
    const { data } = await this.api(fresh, instance, `${group}?with_projects=false`);
    const g = obj(data) ?? {};
    const totalOf = (path: string) =>
      this.api(fresh, instance, path).then(
        (x) => x.total ?? undefined,
        () => undefined
      );
    const [projects, subgroups] = await Promise.all([totalOf(`${group}/projects?per_page=1&include_subgroups=true&simple=true`), totalOf(`${group}/subgroups?per_page=1`)]);
    return {
      kind: 'group',
      url: this.web(instance, r, 'group'),
      title: text(g.name, 200) ?? r.path.split('/').pop()!,
      reference: text(g.full_path, 300) ?? r.path,
      description: plainDescription(g.description),
      visibility: text(g.visibility, 20),
      projects,
      subgroups,
      created: time(g.created_at),
      tone: 'neutral',
    };
  }
}
