/**
 * GitLab preview cards: a link to a merge request, issue, pipeline, commit, milestone, release, project or group of a
 * configured GitLab instance, alone on its line, shows as a card with what matters about it (state, branches, labels,
 * people, numbers) instead of a bare address. The server reads the details with the instance's shared token
 * (`server/remote/GitlabCards.ts`); the note keeps the plain link, so exports and other apps see a normal link.
 *
 * Everything in a card is untrusted text from GitLab: it is only ever put into text nodes, never into markup.
 */

import { remoteProjectAllowed, type RemoteHost, type RemoteProblem } from './remoteNote.js';

export type GitlabCardKind = 'merge_request' | 'issue' | 'pipeline' | 'commit' | 'milestone' | 'release' | 'project' | 'group';

/** What a link points to, before anything is asked */
export interface GitlabResource {
  /** `project` and `group` cannot be told apart from the address alone: `path` is tried as a project, then as a group */
  kind: GitlabCardKind | 'path';
  /** The configured instance (`RemoteHost.url`) */
  host: string;
  /** `group/sub/project` or `group/sub` */
  path: string;
  /** Number (iid) of a merge request, issue, milestone or pipeline, a commit sha, a release tag; null for projects and groups */
  id: string | null;
}

const PART = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/;
/** Top-level paths of GitLab that are no group or project */
const RESERVED = new Set(['-', 'users', 'explore', 'dashboard', 'help', 'admin', 'search', 'api', 'oauth', 'profile', 'projects', 'snippets', 'assets', 'uploads', 'import', 'login']);
const MAX_URL = 2000;

const isPath = (parts: string[]): boolean => parts.length >= 1 && parts.length <= 21 && parts.every((p) => PART.test(p) && !p.includes('..') && !p.endsWith('.git'));

/** Decoded path parts; null when one of them is not plain */
function partsOf(pathname: string): string[] | null {
  const out: string[] = [];
  for (const raw of pathname.split('/')) {
    if (!raw) continue;
    let part: string;
    try {
      part = decodeURIComponent(raw);
    } catch {
      return null;
    }
    // eslint-disable-next-line no-control-regex
    if (/[/\\\u0000-\u001f\u007f]/.test(part) || part === '.' || part === '..') return null;
    out.push(part);
  }
  return out;
}

/** The configured GitLab instance an address belongs to (the longest matching base wins), with the rest of its path */
function hostOf(url: URL, hosts: readonly RemoteHost[]): { host: RemoteHost; rest: string } | null {
  let best: { host: RemoteHost; rest: string; base: number } | null = null;
  for (const h of hosts) {
    if (h.kind !== 'gitlab') continue;
    let u: URL;
    try {
      u = new URL(h.url);
    } catch {
      continue;
    }
    const base = u.pathname.replace(/\/$/, '');
    if (u.origin !== url.origin || !(url.pathname === base || url.pathname.startsWith(`${base}/`))) continue;
    if (best && base.length <= best.base) continue;
    best = { host: h, rest: url.pathname.slice(base.length), base: base.length };
  }
  return best;
}

/** Takes a GitLab address apart; null when it is none of a configured instance, or nothing a card can show */
export function parseGitlabUrl(raw: string, hosts: readonly RemoteHost[]): GitlabResource | null {
  const text = raw.trim();
  if (!text || text.length > MAX_URL || !/^https?:\/\//i.test(text) || /[\s<>"`\\]/.test(text)) return null;
  // Encoded dots and slashes, and `.`/`..` parts, would be resolved away by URL: refused like remote notes do
  if (/%(?:00|2e|2f|5c)|\/\.{1,2}(?:\/|$)/i.test(text.split(/[?#]/, 1)[0])) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const found = hostOf(url, hosts);
  if (!found) return null;
  const parts = partsOf(found.rest);
  if (!parts?.length) return null;
  const host = found.host.url;
  const dash = parts.indexOf('-');
  const head = dash >= 0 ? parts.slice(0, dash) : parts;
  const tail = dash >= 0 ? parts.slice(dash + 1) : [];

  // Groups: `/groups/a/b` (and their pages below `/-/`)
  if (head[0] === 'groups') {
    const path = head.slice(1);
    return isPath(path) ? { kind: 'group', host, path: path.join('/'), id: null } : null;
  }
  if (!isPath(head) || RESERVED.has(head[0].toLowerCase())) return null;
  const path = head.join('/');
  if (!tail.length) return { kind: head.length === 1 ? 'group' : 'path', host, path, id: null };
  // Below `/-/` the path is a project
  if (head.length < 2) return null;
  const [what, id, ...more] = tail;
  const number = id && /^\d{1,12}$/.test(id) ? id : null;
  switch (what) {
    case 'merge_requests':
      return number ? { kind: 'merge_request', host, path, id: number } : { kind: 'project', host, path, id: null };
    case 'issues':
    case 'work_items':
      return number ? { kind: 'issue', host, path, id: number } : { kind: 'project', host, path, id: null };
    case 'pipelines':
      return number ? { kind: 'pipeline', host, path, id: number } : { kind: 'project', host, path, id: null };
    case 'milestones':
      return number ? { kind: 'milestone', host, path, id: number } : { kind: 'project', host, path, id: null };
    case 'commit':
      return id && /^[0-9a-f]{7,64}$/i.test(id) ? { kind: 'commit', host, path, id: id.toLowerCase() } : null;
    case 'releases':
    case 'tags': {
      const tag = [id, ...more].filter(Boolean).join('/');
      return tag && /^[\p{L}\p{N}_.+/-]{1,255}$/u.test(tag) && !tag.includes('..') ? { kind: 'release', host, path, id: tag } : { kind: 'project', host, path, id: null };
    }
    default:
      // Files, folders, the wiki, settings …: the project
      return { kind: 'project', host, path, id: null };
  }
}

/** A line that is only an address (bare or in `<…>`): the line a card replaces; null for any other */
export function cardLineUrl(line: string): string | null {
  const m = /^\s*<?(https?:\/\/[^\s<>]+?)>?\s*$/i.exec(line);
  return m ? m[1] : null;
}

/** May the shared token read this path? (the admin's allowed paths; groups like projects, by prefix) */
export const gitlabPathAllowed = (path: string, allowed: readonly string[]): boolean => remoteProjectAllowed('gitlab', path, allowed);

export type GitlabTone = 'open' | 'merged' | 'closed' | 'draft' | 'success' | 'failed' | 'running' | 'neutral';

export interface GitlabPerson {
  name: string;
  username: string;
}

/** What a card shows; every field is optional besides kind, title and url */
export interface GitlabCard {
  kind: GitlabCardKind;
  /** The address the card opens (built from the instance and the path, not taken from GitLab's answer) */
  url: string;
  title: string;
  /** `group/project!12`, `group/project#4`, `group/project@abc1234`, `group/project` */
  reference: string;
  /** GitLab's own state word (`opened`, `merged`, `success`, …) */
  state?: string;
  tone?: GitlabTone;
  draft?: boolean;
  /** First lines of the description, plain text */
  description?: string;
  author?: GitlabPerson;
  assignees?: GitlabPerson[];
  reviewers?: GitlabPerson[];
  labels?: string[];
  milestone?: string;
  /** Merge requests: source → target branch */
  sourceBranch?: string;
  targetBranch?: string;
  /** Pipelines: the branch or tag; projects: the default branch */
  ref?: string;
  /** Status of the latest pipeline of a merge request or commit */
  pipeline?: string;
  conflicts?: boolean;
  /** Seconds a pipeline ran */
  duration?: number;
  visibility?: string;
  topics?: string[];
  /** Up to four, by share */
  languages?: { name: string; percent: number }[];
  comments?: number;
  upvotes?: number;
  stars?: number;
  forks?: number;
  openIssues?: number;
  projects?: number;
  subgroups?: number;
  changes?: string;
  additions?: number;
  deletions?: number;
  tasksDone?: number;
  tasksTotal?: number;
  /** Times in ms */
  created?: number;
  updated?: number;
  merged?: number;
  closed?: number;
  /** Dates as `YYYY-MM-DD` */
  due?: string;
  start?: string;
}

export type GitlabCardResponse = { state: 'ok'; card: GitlabCard; fetchedAt: number } | { state: RemoteProblem };

/** Tone of a GitLab state word */
export function gitlabTone(kind: GitlabCardKind, state: string | undefined, draft = false): GitlabTone {
  const s = (state ?? '').toLowerCase();
  if (draft && s === 'opened') return 'draft';
  if (s === 'merged') return 'merged';
  if (s === 'opened' || s === 'active') return 'open';
  if (s === 'closed' || s === 'locked' || s === 'canceled' || s === 'skipped') return 'closed';
  if (s === 'success') return 'success';
  if (s === 'failed') return 'failed';
  if (['running', 'pending', 'created', 'preparing', 'waiting_for_resource', 'scheduled', 'manual'].includes(s)) return 'running';
  return kind === 'milestone' && s === 'active' ? 'open' : 'neutral';
}
