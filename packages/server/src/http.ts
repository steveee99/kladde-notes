import type { NextFunction, Request, Response } from 'express';
import type { UserRecord, UserStore } from './UserStore.js';
import { AccountError } from './UserStore.js';

export const SESSION_COOKIE = 'kladde_session';

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function setSessionCookie(res: Response, token: string, secure: boolean): void {
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, maxAge: 180 * 24 * 60 * 60 * 1000, path: '/' });
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: UserRecord;
  }
}

export function requireUser(users: UserStore, standaloneUser?: UserRecord) {
  if (standaloneUser) {
    return (req: Request, _res: Response, next: NextFunction) => {
      req.user = standaloneUser;
      next();
    };
  }
  return (req: Request, res: Response, next: NextFunction) => {
    const user = users.userForSession(readCookie(req, SESSION_COOKIE));
    if (!user) {
      res.status(401).json({ error: 'Nicht angemeldet' });
      return;
    }
    req.user = user;
    next();
  };
}

/** Express 4 does not catch rejected promises: wraps a handler and maps AccountErrors to their status */
export const handle =
  (fn: (req: Request, res: Response) => unknown | Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
    // Through then(): synchronous throws land in catch() too
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((err) => {
        if (err instanceof AccountError) res.status(err.status).json({ error: err.message });
        else next(err);
      });
  };

/** Simple fixed-window limit per IP and bucket (auth endpoints) */
export function rateLimit(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    const entry = hits.get(key);
    if (!entry || entry.reset < now) hits.set(key, { count: 1, reset: now + windowMs });
    else if (++entry.count > limit) {
      res.status(429).json({ error: 'Zu viele Versuche – bitte kurz warten.' });
      return;
    }
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    next();
  };
}

/** Rough device name for the passkey list, e.g. "iPhone · Safari" */
export function deviceName(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Gerät';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return browser ? `${os} · ${browser}` : os;
}
