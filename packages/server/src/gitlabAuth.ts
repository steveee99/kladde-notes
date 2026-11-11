import express, { Request, Response } from 'express';
import crypto from 'crypto';
import type { AuthProviders } from '@kladde/shared';
import { AccountError, UserRecord, UserStore } from './UserStore.js';
import { AuditLog } from './security/AuditLog.js';
import { SESSION_COOKIE, rateLimit, readCookie } from './http.js';

/**
 * "Sign in with GitLab" (OAuth 2.0 authorization code + PKCE, GitLab.com or a self-hosted instance).
 * A GitLab identity signs in the Kladde account it is linked to. New accounts need an invite code
 * unless SIGNUP_WITHOUT_INVITE contains gitlab (or GITLAB_ALLOW_SIGNUP is set); GITLAB_ALLOWED_GROUPS restricts every GitLab sign-in to members
 * of those groups. Existing accounts link GitLab in the settings.
 */

export const GITLAB = 'gitlab';
const FLOW_COOKIE = 'kladde_oauth';
const FLOW_MAX_AGE_MS = 10 * 60 * 1000;

export interface GitLabConfig {
  /** Base URL of the GitLab instance as the browser reaches it, without trailing slash */
  url: string;
  /** Base URL for the server's own token and user lookups (GITLAB_INTERNAL_URL); defaults to `url` */
  internalUrl: string;
  clientId: string;
  clientSecret: string;
  label: string;
  allowSignup: boolean;
  /** Full group paths (e.g. "team" or "team/sub"); empty = any GitLab user */
  allowedGroups: string[];
}

const truthy = (v: string | undefined) => v === '1' || v?.toLowerCase() === 'true' || v?.toLowerCase() === 'yes';

/** Sign-in methods that can create an account */
export type SignupMethod = 'passkey' | 'password' | 'gitlab';
const SIGNUP_METHODS: SignupMethod[] = ['passkey', 'password', 'gitlab'];

/**
 * SIGNUP_WITHOUT_INVITE: comma-separated sign-in methods (passkey, password, gitlab or all) that create
 * accounts without an invite. Everything else still needs one. GITLAB_ALLOW_SIGNUP=1 adds gitlab.
 */
export function openSignupFromEnv(env: NodeJS.ProcessEnv): Set<SignupMethod> {
  const open = new Set<SignupMethod>();
  for (const raw of (env.SIGNUP_WITHOUT_INVITE ?? '').split(',')) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    if (name === 'all') SIGNUP_METHODS.forEach((m) => open.add(m));
    else if ((SIGNUP_METHODS as string[]).includes(name)) open.add(name as SignupMethod);
    else console.error(`SIGNUP_WITHOUT_INVITE: unbekannte Anmeldeart „${name}“ (erlaubt: passkey, password, gitlab, all).`);
  }
  if (truthy(env.GITLAB_ALLOW_SIGNUP)) open.add('gitlab');
  return open;
}

/** Reads GITLAB_* variables; null when GitLab sign-in is not configured */
export function gitlabConfigFromEnv(env: NodeJS.ProcessEnv): GitLabConfig | null {
  const clientId = env.GITLAB_CLIENT_ID?.trim();
  const clientSecret = env.GITLAB_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const url = (env.GITLAB_URL?.trim() || 'https://gitlab.com').replace(/\/+$/, '');
  const internalUrl = (env.GITLAB_INTERNAL_URL?.trim() || url).replace(/\/+$/, '');
  for (const [name, value] of [['GITLAB_URL', url], ['GITLAB_INTERNAL_URL', internalUrl]]) {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('protocol');
    } catch {
      console.error(`${name} ist keine gültige Adresse: ${value} – GitLab-Anmeldung bleibt aus.`);
      return null;
    }
  }
  return {
    url,
    internalUrl,
    clientId,
    clientSecret,
    label: env.GITLAB_LABEL?.trim() || 'GitLab',
    allowSignup: openSignupFromEnv(env).has('gitlab'),
    allowedGroups: (env.GITLAB_ALLOWED_GROUPS ?? '')
      .split(',')
      .map((g) => g.trim().replace(/^\/+|\/+$/g, '').toLowerCase())
      .filter(Boolean),
  };
}

export function authProviders(config: GitLabConfig | null, openSignup: ReadonlySet<SignupMethod> = new Set()): AuthProviders {
  return {
    gitlab: { enabled: !!config, label: config?.label ?? 'GitLab', signup: !!config?.allowSignup },
    signup: { passkey: openSignup.has('passkey'), password: openSignup.has('password') },
  };
}

/** Member of one of the allowed groups (a subgroup of an allowed group counts too) */
export function inAllowedGroups(groups: string[], allowed: string[]): boolean {
  if (!allowed.length) return true;
  const mine = groups.map((g) => g.toLowerCase());
  return mine.some((g) => allowed.some((a) => g === a || g.startsWith(`${a}/`)));
}

interface GitLabUser {
  sub: string;
  username: string;
  groups: string[];
}

type Flow = {
  intent: 'login' | 'link';
  state: string;
  verifier: string;
  redirectUri: string;
  invite?: string;
  userId?: string;
  at: number;
};

export interface GitLabRouterOptions {
  users: UserStore;
  audit: AuditLog;
  config: GitLabConfig;
  publicUrl: string | null;
  secureFor: (req: Request) => boolean;
  onSignedIn: (req: Request, res: Response, user: UserRecord, event: 'login' | 'register') => void;
  /** Token and user lookups; replaceable in tests */
  fetchImpl?: typeof fetch;
}

export function gitlabRouter(opts: GitLabRouterOptions): express.Router {
  const { users, audit, config } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  const router = express.Router();
  const flows = new Map<string, Flow>();
  const limit = rateLimit(30, 60_000);

  const baseUrl = (req: Request) => (opts.publicUrl ?? `${req.protocol}://${req.headers.host}`).replace(/\/+$/, '');

  /** Back into the app: errors are shown on the login page or in the settings */
  const finish = (res: Response, path: string, params: Record<string, string>) => {
    res.clearCookie(FLOW_COOKIE, { path: '/api/auth/gitlab' });
    const q = new URLSearchParams(params).toString();
    res.redirect(303, q ? `${path}?${q}` : path);
  };

  router.get('/start', limit, (req, res) => {
    const intent = req.query.intent === 'link' ? 'link' : 'login';
    const now = Date.now();
    for (const [id, f] of flows) if (f.at < now - FLOW_MAX_AGE_MS) flows.delete(id);
    let userId: string | undefined;
    if (intent === 'link') {
      const user = users.userForSession(readCookie(req, SESSION_COOKIE));
      if (!user) return finish(res, '/', { login_error: 'Bitte zuerst anmelden.' });
      userId = user.id;
    }
    const invite = typeof req.query.invite === 'string' && req.query.invite ? req.query.invite.slice(0, 64) : undefined;
    const id = crypto.randomBytes(24).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const flow: Flow = { intent, state: id, verifier, redirectUri: `${baseUrl(req)}/api/auth/gitlab/callback`, invite, userId, at: now };
    flows.set(id, flow);
    res.cookie(FLOW_COOKIE, id, { httpOnly: true, sameSite: 'lax', secure: opts.secureFor(req), maxAge: FLOW_MAX_AGE_MS, path: '/api/auth/gitlab' });
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const authorize = new URL(`${config.url}/oauth/authorize`);
    authorize.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: flow.redirectUri,
      response_type: 'code',
      scope: 'openid profile',
      state: id,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    res.redirect(303, authorize.toString());
  });

  /** Exchanges the code and reads the GitLab user (id, username, groups) */
  const lookup = async (code: string, flow: Flow): Promise<GitLabUser> => {
    const tokenRes = await doFetch(`${config.internalUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: flow.redirectUri,
        code_verifier: flow.verifier,
      }).toString(),
    });
    const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
    if (!tokenRes.ok || !token.access_token) throw new AccountError('GitLab hat die Anmeldung nicht bestätigt.', 401);
    const infoRes = await doFetch(`${config.internalUrl}/oauth/userinfo`, { headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' } });
    const info = (await infoRes.json().catch(() => ({}))) as { sub?: unknown; nickname?: unknown; preferred_username?: unknown; groups?: unknown };
    if (!infoRes.ok || (typeof info.sub !== 'string' && typeof info.sub !== 'number')) throw new AccountError('GitLab-Benutzer konnte nicht gelesen werden.', 401);
    const username = String(info.preferred_username ?? info.nickname ?? '');
    const groups = Array.isArray(info.groups) ? info.groups.filter((g): g is string => typeof g === 'string') : [];
    return { sub: String(info.sub), username, groups };
  };

  router.get('/callback', limit, async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const flow = state ? flows.get(state) : undefined;
    if (state) flows.delete(state);
    const back = flow?.intent === 'link' ? '/settings' : '/';
    const fail = (message: string) => finish(res, back, flow?.intent === 'link' ? { gitlab_error: message } : { login_error: message });

    // The state must belong to this browser (cookie) and be fresh
    if (!flow || readCookie(req, FLOW_COOKIE) !== state || flow.at < Date.now() - FLOW_MAX_AGE_MS) {
      return fail('Die GitLab-Anmeldung ist abgelaufen, bitte noch einmal.');
    }
    if (typeof req.query.error === 'string') return fail('Die Anmeldung bei GitLab wurde abgebrochen.');
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) return fail('GitLab hat keinen Code geliefert.');

    try {
      const gl = await lookup(code, flow);
      if (!inAllowedGroups(gl.groups, config.allowedGroups)) {
        audit.record('login_blocked', { ip: req.ip, detail: `gitlab ${gl.username}: not in allowed groups` });
        return fail('Dein GitLab-Konto gehört zu keiner freigegebenen Gruppe.');
      }

      if (flow.intent === 'link') {
        const user = users.userForSession(readCookie(req, SESSION_COOKIE));
        if (!user || user.id !== flow.userId) return fail('Bitte zuerst anmelden.');
        users.linkExternal(user.id, GITLAB, gl.sub, gl.username);
        audit.record('external_linked', { userId: user.id, username: user.username, ip: req.ip, detail: `gitlab ${gl.username}` });
        return finish(res, '/settings', { gitlab: 'linked' });
      }

      const linked = users.findByExternal(GITLAB, gl.sub);
      if (linked) {
        if (linked.bannedAt) {
          audit.record('login_blocked', { userId: linked.id, username: linked.username, ip: req.ip, detail: 'gitlab' });
          return fail('Dieses Konto ist gesperrt.');
        }
        opts.onSignedIn(req, res, linked, 'login');
        return finish(res, '/', {});
      }

      // Unknown GitLab user: a new account needs an invite (or open sign-up)
      const invite = flow.invite ? users.checkInvite(flow.invite) : null;
      if (!invite && !config.allowSignup) {
        audit.record('login_failed', { ip: req.ip, detail: `gitlab ${gl.username}: not linked` });
        return fail('Dieses GitLab-Konto ist mit keinem Kladde-Konto verknüpft. Verknüpfe es in den Einstellungen oder registriere dich mit einer Einladung.');
      }
      const user = users.createUser(users.availableUsername(gl.username || 'gitlab'));
      users.linkExternal(user.id, GITLAB, gl.sub, gl.username);
      if (invite) users.useInvite(invite, user.id);
      opts.onSignedIn(req, res, user, 'register');
      return finish(res, '/', {});
    } catch (err) {
      if (!(err instanceof AccountError)) console.error('GitLab sign-in failed:', err);
      return fail(err instanceof AccountError ? err.message : 'GitLab ist gerade nicht erreichbar.');
    }
  });

  return router;
}
