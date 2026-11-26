import crypto from 'crypto';
import fs from 'fs';
import { normalizeRemoteHost, parseAllowedPaths, type AdminRemoteInstance, type RemoteHost, type RemoteKind } from '@kladde/shared';
import type { DataCipher } from '../crypto.js';
import type { ServerSettings } from '../ServerSettings.js';
import { AccountError } from '../UserStore.js';

/** A GitLab or GitHub the server may read for remote notes, with the token that applies to every user */
export interface RemoteInstance extends RemoteHost {
  id: string;
  /** Read token, '' = none */
  token: string;
  /** Without a token: read public projects anyway */
  anonymous: boolean;
  /** Group or repository prefixes users may read; empty = whatever the token can */
  allowedPaths: string[];
  /** Root of the REST API; every request of this instance stays below it */
  apiBase: string;
  fromEnv: boolean;
}

interface Stored {
  id: string;
  kind: RemoteKind;
  url: string;
  token: string;
  anonymous: boolean;
  allowedPaths: string[];
}

const SETTING = 'remote_instances';
const AAD = 'server_settings:remote_instances';
const MAX_INSTANCES = 20;

const truthy = (v: string | undefined) => ['1', 'true', 'yes'].includes(v?.trim().toLowerCase() ?? '');
/** What fits into a header: a token with line breaks or spaces is a paste error */
const isToken = (token: string) => /^[\x21-\x7e]{1,500}$/.test(token);

function apiBaseOf(kind: RemoteKind, url: string): string {
  if (kind === 'gitlab') return `${url}/api/v4`;
  return url === 'https://github.com' ? 'https://api.github.com' : `${url}/api/v3`;
}

/** `NAME`, or the content of the file `NAME_FILE` names (Docker secrets) */
function secretFromEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (value) return value;
  const file = env[`${name}_FILE`]?.trim();
  if (!file) return '';
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    console.error(`${name}_FILE ist nicht lesbar: ${file}`);
    return '';
  }
}

/** Reads REMOTE_GITLAB_* and REMOTE_GITHUB_*; an instance without a token needs its *_PUBLIC switch */
export function remoteInstancesFromEnv(env: NodeJS.ProcessEnv): RemoteInstance[] {
  // One list for both: with only `github:…` entries nothing of GitLab is allowed, never everything
  const allowedPaths = parseAllowedPaths(env.REMOTE_ALLOWED_PATHS ?? '');
  const out: RemoteInstance[] = [];
  for (const kind of ['gitlab', 'github'] as const) {
    const prefix = `REMOTE_${kind.toUpperCase()}`;
    const off = `${kind === 'gitlab' ? 'GitLab' : 'GitHub'}-Notizen bleiben aus.`;
    const token = secretFromEnv(env, `${prefix}_TOKEN`);
    const anonymous = !token && truthy(env[`${prefix}_PUBLIC`]);
    if (!token && !anonymous) continue;
    const url = normalizeRemoteHost(env[`${prefix}_URL`]?.trim() || `https://${kind}.com`);
    const internalRaw = kind === 'gitlab' ? env.REMOTE_GITLAB_INTERNAL_URL?.trim() : '';
    const internal = internalRaw ? normalizeRemoteHost(internalRaw) : url;
    if (!url || !internal) {
      console.error(`${prefix}_URL ist keine gültige Adresse – ${off}`);
      continue;
    }
    if (token && !isToken(token)) {
      console.error(`${prefix}_TOKEN enthält ungültige Zeichen – ${off}`);
      continue;
    }
    out.push({ id: `env-${kind}`, kind, url, token, anonymous, allowedPaths, apiBase: apiBaseOf(kind, internal), fromEnv: true });
  }
  return out;
}

/**
 * The configured instances: from the environment, and those an admin entered (stored encrypted as a whole; a token only
 * ever leaves this class towards its own instance). An environment entry wins over an admin's with the same address.
 */
export class RemoteInstances {
  private readonly env: RemoteInstance[];

  constructor(
    env: NodeJS.ProcessEnv,
    private readonly settings: ServerSettings,
    private readonly cipher: DataCipher
  ) {
    this.env = remoteInstancesFromEnv(env);
  }

  private stored(): Stored[] {
    const value = this.settings.get<{ enc?: string }>(SETTING);
    if (!value?.enc) return [];
    try {
      return this.cipher.decryptJson<Stored[]>(Buffer.from(value.enc, 'base64'), AAD);
    } catch {
      // Another DATA_KEY: the entries are unreadable and have to be entered again
      console.error('Die GitLab-/GitHub-Zugänge der Verwaltung sind mit diesem Schlüssel nicht lesbar.');
      return [];
    }
  }

  private save(list: Stored[]): void {
    this.settings.set(SETTING, { enc: this.cipher.encryptJson(list, AAD).toString('base64') });
  }

  private overridden(s: Stored): boolean {
    return this.env.some((e) => e.url === s.url);
  }

  /** Every instance remote notes may read */
  active(): RemoteInstance[] {
    const own = this.stored()
      .filter((s) => (s.token || s.anonymous) && !this.overridden(s))
      .map((s): RemoteInstance => ({ ...s, apiBase: apiBaseOf(s.kind, s.url), fromEnv: false }));
    return [...this.env, ...own];
  }

  /**
   * Every configured GitLab, with or without a shared token: the cockpit reads them with each user's own token, so an
   * admin can allow an instance for personal tokens only
   */
  gitlabHosts(): RemoteInstance[] {
    const own = this.stored()
      .filter((s) => s.kind === 'gitlab' && !this.overridden(s))
      .map((s): RemoteInstance => ({ ...s, apiBase: apiBaseOf(s.kind, s.url), fromEnv: false }));
    return [...this.env.filter((e) => e.kind === 'gitlab'), ...own];
  }

  get(id: string): RemoteInstance | undefined {
    return this.active().find((i) => i.id === id);
  }

  /** For the admin area: without tokens */
  list(): AdminRemoteInstance[] {
    const show = ({ id, kind, url, token, anonymous, allowedPaths }: Stored) => ({ id, kind, url, hasToken: !!token, anonymous, allowedPaths });
    return [
      ...this.env.map((e) => ({ ...show(e), fromEnv: true })),
      ...this.stored().map((s) => ({ ...show(s), fromEnv: false, ...(this.overridden(s) ? { overridden: true } : {}) })),
    ];
  }

  /** Creates (`id` null) or changes an admin entry. An empty token keeps the stored one, unless the address changed */
  put(id: string | null, input: Record<string, unknown> | undefined): string {
    const list = this.stored();
    const before = id === null ? undefined : list.find((s) => s.id === id);
    if (id !== null && !before) throw new AccountError('Diesen Zugang gibt es nicht.', 404);
    const kind = input?.kind;
    if (kind !== 'gitlab' && kind !== 'github') throw new AccountError('Bitte GitLab oder GitHub wählen.', 400);
    const url = normalizeRemoteHost(typeof input?.url === 'string' ? input.url : '');
    if (!url) throw new AccountError('Das ist keine gültige Adresse (https://…, ohne Zugangsdaten).', 400);
    if (list.some((s) => s.url === url && s.id !== id) || this.env.some((e) => e.url === url)) throw new AccountError('Für diese Adresse gibt es schon einen Zugang.', 409);
    if (id === null && list.length >= MAX_INSTANCES) throw new AccountError('Mehr Zugänge sind nicht möglich.', 400);
    const typed = typeof input?.token === 'string' ? input.token.trim() : '';
    if (typed && !isToken(typed)) throw new AccountError('Das Token enthält ungültige Zeichen.', 400);
    // A stored token never follows to another address: nobody can have it sent somewhere else without knowing it
    const kept = before && before.url === url && before.kind === kind && input?.anonymous !== true ? before.token : '';
    const token = typed || kept;
    const anonymous = !token && input?.anonymous === true;
    if (!token && !anonymous) throw new AccountError('Bitte ein Token eingeben oder den Zugriff ohne Token erlauben.', 400);
    const allowedPaths = parseAllowedPaths(Array.isArray(input?.allowedPaths) ? input.allowedPaths.filter((p) => typeof p === 'string').join('\n') : '');
    if (allowedPaths.some((p) => !/^(?:(?:gitlab|github):)?[A-Za-z0-9_./-]{1,300}$/i.test(p))) throw new AccountError('Erlaubte Pfade sind Gruppen oder Projekte wie team/doku.', 400);
    const entry: Stored = { id: before?.id ?? crypto.randomBytes(8).toString('hex'), kind, url, token, anonymous, allowedPaths };
    this.save(before ? list.map((s) => (s.id === entry.id ? entry : s)) : [...list, entry]);
    return entry.id;
  }

  /** The address of the removed entry, null when there was none */
  remove(id: string): string | null {
    const list = this.stored();
    const found = list.find((s) => s.id === id);
    if (!found) return null;
    this.save(list.filter((s) => s.id !== id));
    return found.url;
  }
}
