/**
 * Git events (since plugin API 1.4): what GitLab and GitHub report through Kladde's central webhooks, normalised
 * into one small set of types (docs/EVENTS.md). Types and shapes are part of the plugin API contract: a new type or
 * field is a minor version, a change or removal a major one. Texts are cut to bounded lengths, lists to a few
 * entries; `raw` (the provider's JSON) is only there for plugins that ask for it (`rawPayload`).
 */

export type GitProvider = 'gitlab' | 'github';

/** Every event type Kladde knows, in the order of docs/EVENTS.md */
export const GIT_EVENT_TYPES = [
  'git.merge_request',
  'git.push',
  'git.tag',
  'git.pipeline',
  'git.job',
  'git.comment',
  'git.issue',
  'git.release',
  'git.deployment',
  'git.wiki',
] as const;

export type GitEventType = (typeof GIT_EVENT_TYPES)[number];

/** The repository (GitLab project, GitHub repository) the event belongs to */
export interface GitProject {
  /** Full path: `group/subgroup/project` or `owner/repo` */
  path: string;
  name: string;
  /** Web address */
  url: string;
  defaultBranch: string;
}

/** Who caused the event */
export interface GitActor {
  username: string;
  /** Display name, when the provider sends one (otherwise the username) */
  name: string;
}

/** Whose webhook delivered the event: an account or a group */
export interface GitEventOwner {
  kind: 'user' | 'group';
  id: string;
  name: string;
}

/** A commit as a push lists it */
export interface GitCommit {
  sha: string;
  /** First line of the message */
  title: string;
  message: string;
  url: string;
  author: string;
  at: number;
}

/** Pipeline and job states (GitLab's names; GitHub's are mapped onto them) */
export type GitPipelineStatus = 'created' | 'waiting' | 'pending' | 'running' | 'success' | 'failed' | 'canceled' | 'skipped' | 'manual' | 'scheduled';

export type GitDeploymentStatus = 'created' | 'running' | 'success' | 'failed' | 'canceled';

interface GitEventBase<T extends GitEventType, A extends string> {
  /**
   * The delivery's id (`X-Gitlab-Event-UUID`, `X-GitHub-Delivery`, otherwise a hash of the body). A delivery reaches
   * a handler at most once per source; the same change can still come twice through two sources, so handlers should
   * be idempotent by this id or by the object they change.
   */
  id: string;
  type: T;
  action: A;
  provider: GitProvider;
  project: GitProject;
  actor: GitActor | null;
  /** When the event happened (the provider's time if it sends one), ms since 1970 */
  at: number;
  owner: GitEventOwner;
  /**
   * The accounts this event is for: the owner, or the group's members — in each case only those who switched the
   * plugin on. Use them with `ctx.notes`, `ctx.notify` and friends. Never empty when a plugin gets the event.
   */
  users: string[];
  /** The provider's JSON, only for types the plugin lists in `rawPayload` */
  raw?: unknown;
}

export interface GitMergeRequest {
  /** GitLab `iid`, GitHub pull request number */
  number: number;
  title: string;
  description: string;
  url: string;
  state: 'open' | 'merged' | 'closed';
  draft: boolean;
  sourceBranch: string;
  targetBranch: string;
  /** Last commit of the source branch */
  sha: string;
  author: string;
  labels: string[];
  assignees: string[];
  reviewers: string[];
}

export interface GitMergeRequestEvent extends GitEventBase<'git.merge_request', 'opened' | 'reopened' | 'updated' | 'merged' | 'closed' | 'approved' | 'unapproved'> {
  mergeRequest: GitMergeRequest;
}

export interface GitPushEvent extends GitEventBase<'git.push', 'pushed' | 'created' | 'deleted'> {
  push: {
    /** `refs/heads/main` */
    ref: string;
    branch: string;
    before: string;
    after: string;
    /** The newest commits (at most 20); `commitCount` says how many there were */
    commits: GitCommit[];
    commitCount: number;
  };
}

export interface GitTagEvent extends GitEventBase<'git.tag', 'created' | 'deleted'> {
  tag: { name: string; ref: string; sha: string; message: string };
}

export interface GitPipelineEvent extends GitEventBase<'git.pipeline', GitPipelineStatus> {
  pipeline: {
    id: number;
    status: GitPipelineStatus;
    ref: string;
    sha: string;
    url: string;
    /** `push`, `merge_request_event`, `schedule`, `web`, … */
    source: string;
    /** Number of the merge request the pipeline runs for */
    mergeRequest: number | null;
    durationSeconds: number | null;
    /** GitHub: the workflow's name */
    name: string;
  };
}

export interface GitJobEvent extends GitEventBase<'git.job', GitPipelineStatus> {
  job: {
    id: number;
    name: string;
    stage: string;
    status: GitPipelineStatus;
    ref: string;
    sha: string;
    url: string;
    pipelineId: number | null;
    allowFailure: boolean;
    durationSeconds: number | null;
    failureReason: string;
  };
}

export interface GitCommentEvent extends GitEventBase<'git.comment', 'created' | 'edited' | 'deleted'> {
  comment: {
    id: number;
    body: string;
    url: string;
    /** What was commented on */
    on: 'merge_request' | 'issue' | 'commit' | 'snippet';
    /** Merge request or issue number, otherwise null */
    number: number | null;
    /** Its title (empty for commits) */
    title: string;
    /** Commented commit */
    sha: string;
  };
}

export interface GitIssueEvent extends GitEventBase<'git.issue', 'opened' | 'reopened' | 'updated' | 'closed'> {
  issue: {
    number: number;
    title: string;
    description: string;
    url: string;
    state: 'open' | 'closed';
    author: string;
    labels: string[];
    assignees: string[];
    confidential: boolean;
  };
}

export interface GitReleaseEvent extends GitEventBase<'git.release', 'created' | 'updated' | 'deleted'> {
  release: { tag: string; name: string; description: string; url: string };
}

export interface GitDeploymentEvent extends GitEventBase<'git.deployment', GitDeploymentStatus> {
  deployment: { id: number; environment: string; status: GitDeploymentStatus; ref: string; sha: string; url: string };
}

export interface GitWikiEvent extends GitEventBase<'git.wiki', 'created' | 'updated' | 'deleted'> {
  wiki: { title: string; slug: string; url: string };
}

export type GitEvent =
  | GitMergeRequestEvent
  | GitPushEvent
  | GitTagEvent
  | GitPipelineEvent
  | GitJobEvent
  | GitCommentEvent
  | GitIssueEvent
  | GitReleaseEvent
  | GitDeploymentEvent
  | GitWikiEvent;

/** The event of one type: `GitEventOf<'git.push'>` is `GitPushEvent` */
export type GitEventOf<T extends GitEventType> = Extract<GitEvent, { type: T }>;

/** An event without what the host adds per receiver (owner, users, raw) — what the normaliser produces */
export type GitEventCore = GitEvent extends infer E ? (E extends GitEvent ? Omit<E, 'owner' | 'users' | 'raw'> : never) : never;

export const isGitEventType = (v: unknown): v is GitEventType => typeof v === 'string' && (GIT_EVENT_TYPES as readonly string[]).includes(v);
