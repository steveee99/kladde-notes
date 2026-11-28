import net from 'node:net';
import {
  applyWidget,
  COCKPIT_SOURCES,
  normalizeRemoteHost,
  resolveParams,
  type CockpitConnections,
  type CockpitResult,
  type CockpitRow,
  type CockpitWidget,
} from '@kladde/shared';
import type { RemoteFetcher } from '../remote/RemoteFetcher.js';
import type { RemoteInstance } from '../remote/RemoteInstances.js';
import type { HttpTransport } from '../confluence/ConfluenceClient.js';
import { isPrivateAddress } from '../RecipeImport.js';
import type { CockpitStore, GitlabConnection, JiraConnection } from './CockpitStore.js';
import { CockpitError, gitlabCompare, gitlabFailedJobs, gitlabGroups, gitlabMergeRequests, gitlabProjects, gitlabWhoAmI, JiraClient, type GitlabAccess } from './sources.js';

/** A source's rows are read again after this long (all widgets of a dashboard with the same source share one read) */
const FRESH_MS = 60_000;
const CACHE_ENTRIES = 300;

/** A GitLab the cockpit may read with personal tokens */
export interface CockpitHost {
  id: string;
  url: string;
  apiBase: string;
}

export interface CockpitServiceOptions {
  /** Hosts: the instances of remote notes, the GitLab of the sign-in and `COCKPIT_GITLAB_URL` */
  gitlabHosts: () => CockpitHost[];
  fetcher: RemoteFetcher;
  jiraTransport: HttpTransport;
  /** JIRA_ALLOW_PRIVATE: a Jira Data Center in the intranet */
  jiraAllowPrivate: boolean;
}

/** Settings → Cockpit takes the Jira address as the user copies it from the browser */
export function normalizeJiraUrl(raw: string, kind: 'cloud' | 'datacenter', allowPrivate: boolean): string {
  let url: URL;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new CockpitError('invalid', 'url');
  }
  if (url.protocol !== 'https:' || url.username || url.password) throw new CockpitError('invalid', 'url');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!allowPrivate && ((net.isIP(host) && isPrivateAddress(host)) || host === 'localhost' || /\.(localhost|local|internal)$/.test(host))) throw new CockpitError('invalid', 'private');
  if (kind === 'cloud' || host.endsWith('.atlassian.net')) return `https://${url.host}`;
  // Data Center may live below a context path (/jira); cut what the browser shows after it
  const path = url.pathname.replace(/\/(browse|secure|projects|rest|issues|plugins|login\.jsp|jira\/software)(\/.*)?$/, '').replace(/\/+$/, '');
  return `https://${url.host}${path}`;
}

/** Every GitLab the cockpit may read: hosts of remote notes, the sign-in's GitLab and `COCKPIT_GITLAB_URL`, each address once */
export function cockpitHosts(instances: () => RemoteInstance[], env: NodeJS.ProcessEnv, signin: { url: string; internalUrl: string } | null): () => CockpitHost[] {
  const extra: CockpitHost[] = [];
  const add = (id: string, url: string | null, internal?: string | null) => {
    if (url) extra.push({ id, url, apiBase: `${internal ?? url}/api/v4` });
  };
  if (signin) add('signin-gitlab', normalizeRemoteHost(signin.url), normalizeRemoteHost(signin.internalUrl));
  const raw = env.COCKPIT_GITLAB_URL?.trim();
  if (raw) {
    const url = normalizeRemoteHost(raw);
    if (url) add('env-cockpit', url, env.COCKPIT_GITLAB_INTERNAL_URL?.trim() ? normalizeRemoteHost(env.COCKPIT_GITLAB_INTERNAL_URL.trim()) : null);
    else console.error(`COCKPIT_GITLAB_URL ist keine gültige Adresse: ${raw}`);
  }
  return () => {
    const out: CockpitHost[] = [];
    for (const h of [...instances().map((i) => ({ id: i.id, url: i.url, apiBase: i.apiBase })), ...extra]) if (!out.some((o) => o.url === h.url)) out.push(h);
    return out;
  };
}

/**
 * Runs cockpit widgets for a user with their own connections. Rows of a source (with its resolved parameters) are kept
 * a minute per user, so a dashboard with several widgets on the same source reads it once.
 */
export class CockpitService {
  private readonly cache = new Map<string, { at: number; rows: CockpitRow[]; partial: boolean }>();
  private readonly running = new Map<string, Promise<{ rows: CockpitRow[]; partial: boolean }>>();

  constructor(
    readonly store: CockpitStore,
    private readonly opts: CockpitServiceOptions
  ) {}

  hosts(): CockpitHost[] {
    return this.opts.gitlabHosts();
  }

  private host(id: string): RemoteInstance | null {
    const h = this.hosts().find((x) => x.id === id);
    return h ? { ...h, kind: 'gitlab', token: '', anonymous: false, allowedPaths: [], fromEnv: false } : null;
  }

  connections(userId: string): CockpitConnections {
    const gl = this.store.connection(userId, 'gitlab');
    const jira = this.store.connection(userId, 'jira');
    const host = gl ? this.hosts().find((h) => h.id === gl.instanceId) : undefined;
    return {
      gitlab: gl && host ? { instanceId: gl.instanceId, url: host.url, username: gl.username, name: gl.name, updatedAt: gl.updatedAt } : null,
      jira: jira ? { url: jira.url, kind: jira.kind, email: jira.email, accountName: jira.accountName, updatedAt: jira.updatedAt } : null,
      instances: this.hosts().map((h) => ({ id: h.id, url: h.url })),
    };
  }

  /** Checks the token against the instance and saves it with the account it belongs to */
  async connectGitlab(userId: string, instanceId: string, token: string): Promise<GitlabConnection> {
    const host = this.host(instanceId);
    if (!host) throw new CockpitError('not_found', 'instance');
    const typed = token.trim();
    const saved = this.store.connection(userId, 'gitlab');
    // An empty token keeps the saved one, but never for another instance
    const use = typed || (saved?.instanceId === instanceId ? saved.token : '');
    if (!/^[\x21-\x7e]{8,500}$/.test(use)) throw new CockpitError('invalid', 'token');
    const who = await gitlabWhoAmI({ fetcher: this.opts.fetcher, host, connection: { instanceId, token: use, username: '', userId: 0, name: '' } });
    const conn: GitlabConnection = { instanceId, token: use, ...who };
    this.store.saveConnection(userId, 'gitlab', conn);
    this.forget(userId);
    return conn;
  }

  async connectJira(userId: string, input: { url?: unknown; kind?: unknown; email?: unknown; token?: unknown }): Promise<JiraConnection> {
    const kind = input.kind === 'datacenter' ? 'datacenter' : 'cloud';
    const url = normalizeJiraUrl(String(input.url ?? ''), kind, this.opts.jiraAllowPrivate);
    const email = kind === 'cloud' ? String(input.email ?? '').trim().slice(0, 200) : '';
    if (kind === 'cloud' && !/^[^\s@]+@[^\s@]+$/.test(email)) throw new CockpitError('invalid', 'email');
    const saved = this.store.connection(userId, 'jira');
    const typed = typeof input.token === 'string' ? input.token.trim() : '';
    const token = typed || (saved && saved.url === url && saved.kind === kind ? saved.token : '');
    if (!/^[\x21-\x7e]{8,2000}$/.test(token)) throw new CockpitError('invalid', 'token');
    const who = await new JiraClient({ url, kind, email, token }, this.opts.jiraTransport).myself();
    const conn: JiraConnection = { url, kind, email, token, ...who };
    this.store.saveConnection(userId, 'jira', conn);
    this.forget(userId);
    return conn;
  }

  disconnect(userId: string, provider: 'gitlab' | 'jira'): boolean {
    this.forget(userId);
    return this.store.removeConnection(userId, provider);
  }

  private forget(userId: string): void {
    for (const key of this.cache.keys()) if (key.startsWith(`${userId}\n`)) this.cache.delete(key);
  }

  /** The rows of a widget's source, before its filters (cached a minute; `fresh` reads again) */
  async rows(userId: string, w: CockpitWidget, vars: Record<string, string>, fresh = false): Promise<{ rows: CockpitRow[]; partial: boolean } | { missing: string[] }> {
    const { params, missing } = resolveParams(w.source.params, vars);
    if (missing.length) return { missing };
    const key = `${userId}\n${w.source.kind}\n${JSON.stringify(params)}`;
    const hit = this.cache.get(key);
    if (hit && !fresh && Date.now() - hit.at < FRESH_MS) return hit;
    let job = this.running.get(key);
    if (!job) {
      job = this.read(userId, w.source.kind, params, fresh)
        .then((value) => {
          this.cache.set(key, { ...value, at: Date.now() });
          if (this.cache.size > CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
          return value;
        })
        .finally(() => this.running.delete(key));
      this.running.set(key, job);
    }
    return job;
  }

  private async read(userId: string, kind: CockpitWidget['source']['kind'], params: CockpitWidget['source']['params'], fresh: boolean): Promise<{ rows: CockpitRow[]; partial: boolean }> {
    if (COCKPIT_SOURCES[kind].provider === 'jira') {
      const conn = this.store.connection(userId, 'jira');
      if (!conn) throw new CockpitError('not_connected');
      const jql = typeof params.jql === 'string' ? params.jql.trim() : '';
      if (!jql) throw new CockpitError('invalid', 'jql');
      return { rows: await new JiraClient(conn, this.opts.jiraTransport).search(jql.slice(0, 2000)), partial: false };
    }
    const conn = this.store.connection(userId, 'gitlab');
    const host = conn && this.host(conn.instanceId);
    if (!conn || !host) throw new CockpitError('not_connected');
    const access: GitlabAccess = { fetcher: this.opts.fetcher, host, connection: conn, fresh };
    if (kind === 'gitlab.jobs') return gitlabFailedJobs(access, params);
    if (kind === 'gitlab.compare') return gitlabCompare(access, params);
    if (kind === 'gitlab.projects') return { rows: await gitlabProjects(access, params), partial: false };
    if (kind === 'gitlab.groups') return { rows: await gitlabGroups(access, params), partial: false };
    return { rows: await gitlabMergeRequests(access, params), partial: false };
  }

  /** A widget's result as the client shows it: the rows after its filters, sort order and limit */
  async run(userId: string, w: CockpitWidget, vars: Record<string, string>, fresh = false): Promise<CockpitResult> {
    const provider = COCKPIT_SOURCES[w.source.kind].provider;
    try {
      const got = await this.rows(userId, w, vars, fresh);
      if ('missing' in got) return { problem: 'missing_var', missing: got.missing };
      const applied = applyWidget(got.rows, w);
      return { rows: applied.rows, total: applied.total, fetchedAt: Date.now(), ...(got.partial ? { partial: true } : {}) };
    } catch (err) {
      if (err instanceof CockpitError) return { problem: err.problem, provider, ...(err.message !== err.problem ? { detail: err.message.slice(0, 300) } : {}) };
      throw err;
    }
  }
}
