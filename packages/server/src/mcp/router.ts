import express, { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import type { OAuthRequestInfo } from '@kladde/shared';
import { NoteStore } from '../NoteStore.js';
import { AccountError, UserStore } from '../UserStore.js';
import { AuditLog } from '../security/AuditLog.js';
import { handle, rateLimit, requireUser } from '../http.js';
import { McpGrant, McpTokenStore, OAuthClient } from './McpTokenStore.js';
import { handleBody } from './protocol.js';

/** An authorization code must be redeemed this fast */
const CODE_MAX_AGE_MS = 5 * 60 * 1000;
export const SCOPE_READ = 'notes:read';
export const SCOPE_WRITE = 'notes:write';

export interface McpOptions {
  users: UserStore;
  notes: NoteStore;
  tokens: McpTokenStore;
  audit: AuditLog;
  /** PUBLIC_URL; otherwise the address the request came in on */
  publicUrl: string | null;
}

interface PendingCode {
  clientId: string;
  userId: string;
  redirectUri: string;
  /** The client named redirect_uri in the request, so it must repeat it when redeeming the code */
  explicitRedirect: boolean;
  challenge: string;
  canWrite: boolean;
  at: number;
}

interface AuthorizeRequest {
  client: OAuthClient;
  redirectUri: string;
  explicitRedirect: boolean;
  challenge: string;
  state: string | null;
  wantsWrite: boolean;
}

declare module 'express-serve-static-core' {
  interface Request {
    mcpGrant?: McpGrant;
  }
}

const sha256Base64Url = (value: string) => crypto.createHash('sha256').update(value).digest('base64url');
const one = (v: unknown): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined);

/** Checks an OAuth authorization request (from the consent page); throws with a message the page shows */
function checkAuthorizeRequest(q: Record<string, unknown>, tokens: McpTokenStore, base: string): AuthorizeRequest {
  const client = tokens.getClient(one(q.client_id));
  if (!client) throw new AccountError('Unbekannte App (client_id). Verbinde sie bitte noch einmal neu.');
  const requested = one(q.redirect_uri);
  const redirectUri = requested ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) throw new AccountError('Die Rücksprungadresse passt nicht zu dieser App.');
  if (one(q.response_type) !== 'code') throw new AccountError('Nicht unterstützte Anfrage (response_type).');
  const challenge = one(q.code_challenge) ?? '';
  if (one(q.code_challenge_method) !== 'S256' || !/^[A-Za-z0-9._~-]{43,128}$/.test(challenge)) {
    throw new AccountError('Die App muss PKCE (S256) verwenden.');
  }
  const resource = one(q.resource);
  if (resource) {
    let ok = false;
    try {
      const url = new URL(resource);
      ok = url.origin === new URL(base).origin && url.pathname.replace(/\/$/, '') === '/mcp';
    } catch {
      // not a URL
    }
    if (!ok) throw new AccountError('Die App fragt nach Zugriff auf einen anderen Server.');
  }
  const scope = one(q.scope);
  const wantsWrite = !scope || scope.split(/\s+/).includes(SCOPE_WRITE);
  const state = one(q.state);
  return { client, redirectUri, explicitRedirect: requested !== undefined, challenge, state: state ? state.slice(0, 1000) : null, wantsWrite };
}

function redirectWith(uri: string, params: Record<string, string | null>): string {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
  return url.toString();
}

/**
 * MCP for AI assistants: a Streamable-HTTP endpoint (stateless, JSON answers) at /mcp, protected by OAuth 2.1
 * (dynamic client registration, PKCE, consent with the normal Kladde login) or a personal token.
 * Every tool works on the token owner's own notes only.
 */
export function mcpRouters(opts: McpOptions): { publicRouter: express.Router; accountRouter: express.Router } {
  const { users, notes, tokens, audit } = opts;
  const codes = new Map<string, PendingCode>();
  const base = (req: Request) => (opts.publicUrl ?? `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const resourceMetadataUrl = (req: Request) => `${base(req)}/.well-known/oauth-protected-resource`;

  // ---------------------------------------------------------------- public: discovery, OAuth endpoints, /mcp

  const publicRouter = express.Router();

  // Bearer tokens instead of cookies: any origin may call these (browser-based MCP clients)
  publicRouter.use(['/mcp', '/oauth/register', '/oauth/token', '/oauth/revoke', '/.well-known'], (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID');
    res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  const protectedResource = (req: Request, res: Response) =>
    res.json({
      resource: `${base(req)}/mcp`,
      authorization_servers: [base(req)],
      scopes_supported: [SCOPE_READ, SCOPE_WRITE],
      bearer_methods_supported: ['header'],
      resource_name: 'Kladde',
    });
  publicRouter.get('/.well-known/oauth-protected-resource', protectedResource);
  publicRouter.get('/.well-known/oauth-protected-resource/mcp', protectedResource);

  publicRouter.get('/.well-known/oauth-authorization-server', (req, res) => {
    const b = base(req);
    res.json({
      issuer: b,
      authorization_endpoint: `${b}/oauth/authorize`,
      token_endpoint: `${b}/oauth/token`,
      registration_endpoint: `${b}/oauth/register`,
      revocation_endpoint: `${b}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [SCOPE_READ, SCOPE_WRITE],
    });
  });

  const oauthBody = [express.json({ limit: '32kb' }), express.urlencoded({ extended: false, limit: '32kb' })];
  const oauthError = (res: Response, status: number, error: string, description?: string) =>
    res.status(status).json({ error, ...(description ? { error_description: description } : {}) });

  // Dynamic client registration (RFC 7591): MCP clients register themselves, the user decides on the consent page
  publicRouter.post('/oauth/register', rateLimit(20, 60 * 60_000), ...oauthBody, (req, res) => {
    try {
      const client = tokens.registerClient(req.body?.client_name, req.body?.redirect_uris);
      res.status(201).json({
        client_id: client.id,
        client_id_issued_at: Math.floor(client.createdAt / 1000),
        client_name: client.name,
        redirect_uris: client.redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      });
    } catch {
      oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris must be https, http on localhost or an app scheme');
    }
  });

  /** Public clients send client_id in the body; some send it as HTTP Basic user instead */
  const clientIdOf = (req: Request): string | undefined => {
    const fromBody = one(req.body?.client_id);
    if (fromBody) return fromBody;
    const basic = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? '');
    if (!basic) return undefined;
    return decodeURIComponent(Buffer.from(basic[1], 'base64').toString('utf8').split(':')[0] ?? '');
  };

  publicRouter.post('/oauth/token', rateLimit(60, 60_000), ...oauthBody, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const grantType = one(req.body?.grant_type);
    const clientId = clientIdOf(req);
    const client = tokens.getClient(clientId);
    if (!client) return void oauthError(res, 401, 'invalid_client');
    const send = (issued: { accessToken: string; refreshToken: string; expiresIn: number; canWrite: boolean }) =>
      res.json({
        access_token: issued.accessToken,
        token_type: 'Bearer',
        expires_in: issued.expiresIn,
        refresh_token: issued.refreshToken,
        scope: issued.canWrite ? `${SCOPE_READ} ${SCOPE_WRITE}` : SCOPE_READ,
      });

    if (grantType === 'authorization_code') {
      const code = one(req.body?.code) ?? '';
      const pending = codes.get(code);
      codes.delete(code);
      const verifier = one(req.body?.code_verifier) ?? '';
      if (
        !pending ||
        pending.at < Date.now() - CODE_MAX_AGE_MS ||
        pending.clientId !== client.id ||
        (one(req.body?.redirect_uri) ?? (pending.explicitRedirect ? null : pending.redirectUri)) !== pending.redirectUri ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
        sha256Base64Url(verifier) !== pending.challenge
      ) {
        return void oauthError(res, 400, 'invalid_grant');
      }
      const user = users.getUser(pending.userId);
      if (!user || user.bannedAt) return void oauthError(res, 400, 'invalid_grant');
      try {
        send(tokens.issueOAuth(user.id, client, pending.canWrite));
      } catch (err) {
        oauthError(res, 400, 'invalid_grant', (err as Error).message);
      }
      return;
    }
    if (grantType === 'refresh_token') {
      const issued = tokens.refresh(one(req.body?.refresh_token), client.id);
      if (!issued) return void oauthError(res, 400, 'invalid_grant');
      send(issued);
      return;
    }
    oauthError(res, 400, 'unsupported_grant_type');
  });

  publicRouter.post('/oauth/revoke', rateLimit(60, 60_000), ...oauthBody, (req, res) => {
    tokens.revokeByToken(one(req.body?.token), clientIdOf(req));
    res.status(200).end();
  });

  const requireGrant = (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    const grant = tokens.grantFor(token);
    const user = grant ? users.getUser(grant.userId) : null;
    if (!grant || !user || user.bannedAt) {
      const error = token ? ', error="invalid_token"' : '';
      res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl(req)}"${error}`);
      res.status(401).json({ error: token ? 'invalid_token' : 'unauthorized', error_description: 'Anmeldung bei Kladde nötig' });
      return;
    }
    req.mcpGrant = grant;
    next();
  };

  publicRouter.post(
    '/mcp',
    rateLimit(300, 60_000),
    requireGrant,
    express.json({ limit: '3mb' }),
    (err: Error, _req: Request, res: Response, next: NextFunction) => {
      // Malformed JSON: a JSON-RPC parse error instead of the generic server error
      if ((err as { type?: string }).type === 'entity.parse.failed') res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      else if ((err as { type?: string }).type === 'entity.too.large') res.status(413).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large' } });
      else next(err);
    },
    (req: Request, res: Response) => {
      const grant = req.mcpGrant!;
      const answer = handleBody(req.body, { userId: grant.userId, canWrite: grant.canWrite, notes });
      if (answer === null) res.status(202).end();
      else res.json(answer);
    }
  );
  // Stateless server: no server-sent stream and no sessions to end
  publicRouter.get('/mcp', requireGrant, (_req, res) => res.status(405).setHeader('Allow', 'POST').json({ error: 'Nur POST' }));
  publicRouter.delete('/mcp', requireGrant, (_req, res) => res.status(405).setHeader('Allow', 'POST').json({ error: 'Nur POST' }));

  // ---------------------------------------------------------------- signed in (Kladde session): consent and settings

  const accountRouter = express.Router();
  accountRouter.use(requireUser(users));

  accountRouter.get('/connections', (req, res) => res.json(tokens.connectionsOf(req.user!.id)));

  accountRouter.post(
    '/tokens',
    handle((req, res) => {
      const created = tokens.createPersonalToken(req.user!.id, req.body?.name, !!req.body?.canWrite);
      audit.record('mcp_token_created', { userId: req.user!.id, username: req.user!.username, ip: req.ip, detail: `${created.connection.name}${created.connection.canWrite ? ' (schreiben)' : ''}` });
      res.json(created);
    })
  );

  accountRouter.delete('/connections/:id', (req, res) => {
    const connection = tokens.connection(req.params.id);
    if (tokens.revoke(req.user!.id, req.params.id)) {
      audit.record('mcp_revoked', { userId: req.user!.id, username: req.user!.username, ip: req.ip, detail: connection?.name });
    }
    res.json(tokens.connectionsOf(req.user!.id));
  });

  accountRouter.get(
    '/authorize',
    handle((req, res) => {
      const r = checkAuthorizeRequest(req.query, tokens, base(req));
      const info: OAuthRequestInfo = { clientName: r.client.name, redirectHost: new URL(r.redirectUri).host || r.redirectUri, wantsWrite: r.wantsWrite };
      res.json(info);
    })
  );

  accountRouter.post(
    '/authorize',
    handle((req, res) => {
      const params = (req.body?.params ?? {}) as Record<string, unknown>;
      const r = checkAuthorizeRequest(params, tokens, base(req));
      const issuer = base(req);
      if (req.body?.approve !== true) {
        res.json({ redirect: redirectWith(r.redirectUri, { error: 'access_denied', state: r.state, iss: issuer }) });
        return;
      }
      const now = Date.now();
      for (const [c, p] of codes) if (p.at < now - CODE_MAX_AGE_MS) codes.delete(c);
      const code = crypto.randomBytes(32).toString('base64url');
      const canWrite = r.wantsWrite && req.body?.allowWrite === true;
      codes.set(code, { clientId: r.client.id, userId: req.user!.id, redirectUri: r.redirectUri, explicitRedirect: r.explicitRedirect, challenge: r.challenge, canWrite, at: now });
      audit.record('mcp_connected', { userId: req.user!.id, username: req.user!.username, ip: req.ip, detail: `${r.client.name}${canWrite ? ' (schreiben)' : ''}` });
      res.json({ redirect: redirectWith(r.redirectUri, { code, state: r.state, iss: issuer }) });
    })
  );

  return { publicRouter, accountRouter };
}
