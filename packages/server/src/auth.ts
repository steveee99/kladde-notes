import express, { Request } from 'express';
import crypto from 'crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import type { Me } from '@kladde/shared';
import { AccountError, UserRecord, UserStore, checkPassword, hashPassword } from './UserStore.js';
import { AuditLog } from './security/AuditLog.js';
import { SESSION_COOKIE, deviceName, handle, rateLimit, readCookie, requireUser, setSessionCookie } from './http.js';

const FLOW_MAX_AGE_MS = 5 * 60 * 1000;
/** Wrong passwords per account, from whatever IP: guessing from many addresses is braked too */
const ACCOUNT_FAILS_MAX = 10;
const ACCOUNT_FAILS_WINDOW_MS = 15 * 60 * 1000;
const RP_NAME = 'Kladde';

type Flow =
  | { kind: 'register'; challenge: string; origin: string; rpID: string; userId: string; username: string; invite: string; at: number }
  | { kind: 'link'; challenge: string; origin: string; rpID: string; userId: string; code: string; at: number }
  | { kind: 'add'; challenge: string; origin: string; rpID: string; userId: string; at: number }
  | { kind: 'login'; challenge: string; origin: string; rpID: string; at: number };

export interface AuthOptions {
  users: UserStore;
  audit: AuditLog;
  /** PUBLIC_URL: fixes the passkey domain; otherwise the (already checked) Origin of the request is used */
  publicUrl: string | null;
  secureCookies: boolean;
  devLogin: boolean;
  onRegistered?: (user: UserRecord, inviteNote: string) => void;
}

export function authRouter(opts: AuthOptions): express.Router {
  const { users, audit } = opts;
  const router = express.Router();
  const flows = new Map<string, Flow>();
  const limit = rateLimit(40, 60_000);
  const passwordLimit = rateLimit(10, 60_000);
  const accountFails = new Map<string, { count: number; reset: number }>();
  const accountLocked = (name: string) => {
    const entry = accountFails.get(name);
    return !!entry && entry.reset > Date.now() && entry.count >= ACCOUNT_FAILS_MAX;
  };
  const accountFailed = (name: string) => {
    const now = Date.now();
    const entry = accountFails.get(name);
    if (!entry || entry.reset < now) accountFails.set(name, { count: 1, reset: now + ACCOUNT_FAILS_WINDOW_MS });
    else entry.count++;
    if (accountFails.size > 10_000) for (const [k, v] of accountFails) if (v.reset < now) accountFails.delete(k);
  };

  const relyingParty = (req: Request) => {
    const origin = opts.publicUrl ? new URL(opts.publicUrl).origin : (req.headers.origin ?? `${req.protocol}://${req.headers.host}`);
    return { origin, rpID: new URL(origin).hostname };
  };

  const startFlow = (flow: Flow) => {
    const now = Date.now();
    for (const [id, f] of flows) if (f.at < now - FLOW_MAX_AGE_MS) flows.delete(id);
    const id = crypto.randomBytes(16).toString('base64url');
    flows.set(id, flow);
    return id;
  };

  const takeFlow = <K extends Flow['kind']>(id: unknown, kind: K): Extract<Flow, { kind: K }> => {
    const flow = typeof id === 'string' ? flows.get(id) : undefined;
    if (typeof id === 'string') flows.delete(id);
    if (!flow || flow.kind !== kind || flow.at < Date.now() - FLOW_MAX_AGE_MS) throw new AccountError('Die Anfrage ist abgelaufen, bitte noch einmal.', 400);
    return flow as Extract<Flow, { kind: K }>;
  };

  const registrationOptions = (req: Request, user: { id: string; username: string }, exclude: { id: string; transports: string[] }[]) => {
    const { rpID } = relyingParty(req);
    return generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userName: user.username,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      excludeCredentials: exclude.map((c) => ({ id: c.id, transports: c.transports as AuthenticatorTransportFuture[] })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
  };

  /** Verifies a new passkey and stores it for `userId` */
  const finishRegistration = async (req: Request, flow: { challenge: string; origin: string; rpID: string }, userId: string) => {
    const result = await verifyRegistrationResponse({
      response: req.body?.response,
      expectedChallenge: flow.challenge,
      expectedOrigin: flow.origin,
      expectedRPID: flow.rpID,
      requireUserVerification: false,
    }).catch((err) => {
      throw new AccountError(`Passkey konnte nicht geprüft werden: ${err.message}`);
    });
    if (!result.verified || !result.registrationInfo) throw new AccountError('Passkey konnte nicht geprüft werden.');
    const { credential } = result.registrationInfo;
    return {
      id: credential.id,
      userId,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports ?? [],
      name: deviceName(req.headers['user-agent']),
      createdAt: Date.now(),
    };
  };

  /**
   * Secure cookies over HTTPS and for the public domain; a plain-HTTP request to another host
   * (home network by IP, password login) would never get a Secure cookie back from the browser
   */
  const publicHost = opts.publicUrl ? new URL(opts.publicUrl).hostname.toLowerCase() : null;
  const secureFor = (req: Request) => opts.secureCookies && (req.protocol === 'https' || req.hostname?.toLowerCase() === publicHost);

  const signIn = (req: Request, res: express.Response, user: UserRecord, event: 'login' | 'register') => {
    setSessionCookie(res, users.createSession(user.id), secureFor(req));
    audit.record(event, { userId: user.id, username: user.username, ip: req.ip });
    res.json(me(user));
  };

  const me = (record: UserRecord): Me => {
    // Read again: the request's record is from before a password or passkey change
    const user = users.getUser(record.id) ?? record;
    return {
      id: user.id,
      username: user.username,
      createdAt: user.createdAt,
      passkeys: users.credentialsOf(user.id).map((c) => ({ id: c.id, name: c.name, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt })),
      hasPassword: user.hasPassword,
      isAdmin: user.isAdmin,
      avatarUrl: user.avatarUrl,
    };
  };

  // ---------------------------------------------------------------- register with an invite

  router.post(
    '/register/options',
    limit,
    handle(async (req, res) => {
      const invite = users.checkInvite(req.body?.inviteCode);
      const username = users.checkNewUsername(req.body?.username);
      const userId = crypto.randomUUID();
      const options = await registrationOptions(req, { id: userId, username }, []);
      const flowId = startFlow({ kind: 'register', challenge: options.challenge, ...relyingParty(req), userId, username, invite, at: Date.now() });
      res.json({ flowId, options });
    })
  );

  router.post(
    '/register/verify',
    limit,
    handle(async (req, res) => {
      const flow = takeFlow(req.body?.flowId, 'register');
      const credential = await finishRegistration(req, flow, flow.userId);
      // Checked again: the invite or the name may have been taken during the ceremony
      users.checkInvite(flow.invite);
      users.checkNewUsername(flow.username);
      const user = users.createUser(flow.username);
      users.addCredential({ ...credential, userId: user.id });
      users.useInvite(flow.invite, user.id);
      const note = users.listInvites().find((i) => i.usedBy === user.username)?.note ?? '';
      opts.onRegistered?.(user, note);
      signIn(req, res, user, 'register');
    })
  );

  // ---------------------------------------------------------------- login (usernameless, discoverable passkeys)

  router.post(
    '/login/options',
    limit,
    handle(async (req, res) => {
      const { rpID, origin } = relyingParty(req);
      const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred', allowCredentials: [] });
      res.json({ flowId: startFlow({ kind: 'login', challenge: options.challenge, rpID, origin, at: Date.now() }), options });
    })
  );

  router.post(
    '/login/verify',
    limit,
    handle(async (req, res) => {
      const flow = takeFlow(req.body?.flowId, 'login');
      const credentialId = req.body?.response?.id;
      const stored = typeof credentialId === 'string' ? users.getCredential(credentialId) : null;
      const user = stored ? users.getUser(stored.userId) : null;
      if (!stored || !user) {
        audit.record('login_failed', { ip: req.ip, detail: 'unknown passkey' });
        throw new AccountError('Dieser Passkey ist hier nicht bekannt.', 401);
      }
      if (user.bannedAt) {
        audit.record('login_blocked', { userId: user.id, username: user.username, ip: req.ip });
        throw new AccountError('Dieses Konto ist gesperrt.', 403);
      }
      const result = await verifyAuthenticationResponse({
        response: req.body.response,
        expectedChallenge: flow.challenge,
        expectedOrigin: flow.origin,
        expectedRPID: flow.rpID,
        credential: { id: stored.id, publicKey: stored.publicKey as Uint8Array<ArrayBuffer>, counter: stored.counter, transports: stored.transports as AuthenticatorTransportFuture[] },
        requireUserVerification: false,
      }).catch(() => ({ verified: false as const, authenticationInfo: undefined }));
      if (!result.verified || !result.authenticationInfo) {
        audit.record('login_failed', { userId: user.id, username: user.username, ip: req.ip });
        throw new AccountError('Anmeldung fehlgeschlagen.', 401);
      }
      users.touchCredential(stored.id, result.authenticationInfo.newCounter);
      signIn(req, res, user, 'login');
    })
  );

  // ---------------------------------------------------------------- username + password (works without HTTPS)

  router.post(
    '/password/register',
    passwordLimit,
    handle(async (req, res) => {
      const invite = users.checkInvite(req.body?.inviteCode);
      const username = users.checkNewUsername(req.body?.username);
      const hash = await hashPassword(checkPassword(req.body?.password));
      // Checked again after the (slow) hash: no await from here on, so the invite cannot be used twice
      users.checkInvite(invite);
      users.checkNewUsername(username);
      const user = users.createUser(username);
      users.setPasswordHash(user.id, hash);
      users.useInvite(invite, user.id);
      const note = users.listInvites().find((i) => i.usedBy === user.username)?.note ?? '';
      opts.onRegistered?.(user, note);
      signIn(req, res, user, 'register');
    })
  );

  router.post(
    '/password/login',
    passwordLimit,
    handle(async (req, res) => {
      const name = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase().slice(0, 64) : '';
      if (accountLocked(name)) {
        audit.record('login_blocked', { username: name, ip: req.ip, detail: 'too many wrong passwords' });
        throw new AccountError('Zu viele falsche Passwörter – bitte in 15 Minuten noch einmal.', 429);
      }
      const user = await users.checkLogin(req.body?.username, req.body?.password);
      if (!user) {
        accountFailed(name);
        audit.record('login_failed', { username: name, ip: req.ip, detail: 'password' });
        throw new AccountError('Benutzername oder Passwort stimmt nicht.', 401);
      }
      if (user.bannedAt) {
        audit.record('login_blocked', { userId: user.id, username: user.username, ip: req.ip });
        throw new AccountError('Dieses Konto ist gesperrt.', 403);
      }
      accountFails.delete(name);
      signIn(req, res, user, 'login');
    })
  );

  // ---------------------------------------------------------------- new device via one-time code

  router.post(
    '/link/options',
    limit,
    handle(async (req, res) => {
      const user = users.userForDeviceLink(req.body?.code);
      const options = await registrationOptions(req, user, users.credentialsOf(user.id));
      const flowId = startFlow({ kind: 'link', challenge: options.challenge, ...relyingParty(req), userId: user.id, code: String(req.body.code), at: Date.now() });
      res.json({ flowId, options, username: user.username });
    })
  );

  router.post(
    '/link/verify',
    limit,
    handle(async (req, res) => {
      const flow = takeFlow(req.body?.flowId, 'link');
      const user = users.userForDeviceLink(flow.code);
      users.addCredential(await finishRegistration(req, flow, user.id));
      users.useDeviceLink(flow.code);
      signIn(req, res, user, 'login');
    })
  );

  // ---------------------------------------------------------------- signed in

  const authed = requireUser(users);

  router.get('/me', authed, (req, res) => res.json(me(req.user!)));

  router.post('/logout', (req, res) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) users.deleteSession(token);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  /** Sets or changes the password; changing needs the current one, other devices are signed out */
  router.post(
    '/password',
    authed,
    passwordLimit,
    handle(async (req, res) => {
      const user = req.user!;
      if (user.hasPassword && !(await users.verifyUserPassword(user.id, req.body?.currentPassword))) {
        audit.record('login_failed', { userId: user.id, username: user.username, ip: req.ip, detail: 'password change' });
        throw new AccountError('Das aktuelle Passwort stimmt nicht.', 403);
      }
      await users.setPassword(user.id, req.body?.newPassword);
      users.deleteSessionsOf(user.id, readCookie(req, SESSION_COOKIE));
      audit.record('password_changed', { userId: user.id, username: user.username, ip: req.ip });
      res.json(me(user));
    })
  );

  router.delete(
    '/password',
    authed,
    handle((req, res) => {
      users.removePassword(req.user!.id);
      audit.record('password_changed', { userId: req.user!.id, username: req.user!.username, ip: req.ip, detail: 'removed' });
      res.json(me(req.user!));
    })
  );

  router.post('/device-link', authed, (req, res) => res.json(users.createDeviceLink(req.user!.id)));

  router.post(
    '/passkeys/options',
    authed,
    handle(async (req, res) => {
      const user = req.user!;
      const options = await registrationOptions(req, user, users.credentialsOf(user.id));
      res.json({ flowId: startFlow({ kind: 'add', challenge: options.challenge, ...relyingParty(req), userId: user.id, at: Date.now() }), options });
    })
  );

  router.post(
    '/passkeys/verify',
    authed,
    handle(async (req, res) => {
      const flow = takeFlow(req.body?.flowId, 'add');
      if (flow.userId !== req.user!.id) throw new AccountError('Falsches Konto', 403);
      users.addCredential(await finishRegistration(req, flow, flow.userId));
      res.json(me(req.user!));
    })
  );

  router.delete(
    '/passkeys/:id',
    authed,
    handle((req, res) => {
      users.deleteCredential(req.user!.id, String(req.params.id));
      res.json(me(req.user!));
    })
  );

  // ---------------------------------------------------------------- local development only

  if (opts.devLogin) {
    router.post('/dev-login', (req, res) => {
      const user = users.findByUsername('dev') ?? users.createUser('dev');
      signIn(req, res, user, 'login');
    });
  }

  return router;
}
