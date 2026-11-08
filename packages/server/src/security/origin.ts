import type { IncomingMessage } from 'http';

/**
 * The game is served from the same origin as the API, so foreign pages may neither
 * call the API with the player's browser nor open a socket in their name.
 * Allowed: the host the request went to (Host, or X-Forwarded-Host behind a trusted proxy),
 * PUBLIC_URL and ALLOWED_ORIGINS (comma separated, e.g. for a separate dev frontend).
 */

function originOf(url: string): string | null {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return null;
  }
}

export function configuredOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const origins = new Set<string>();
  for (const entry of [env.PUBLIC_URL ?? '', ...(env.ALLOWED_ORIGINS ?? '').split(',')]) {
    const origin = entry.trim() ? originOf(entry.trim()) : null;
    if (origin) origins.add(origin);
  }
  return origins;
}

const firstHeader = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.split(',')[0]?.trim();

/** True for same-origin requests, configured origins and requests without an Origin header (same-origin GETs) */
export function isAllowedOrigin(req: IncomingMessage, allowed: Set<string>, trustProxy: boolean): boolean {
  const origin = firstHeader(req.headers.origin);
  if (!origin) return true;
  const normalized = originOf(origin);
  if (!normalized) return false;
  if (allowed.has(normalized)) return true;
  const host = new URL(normalized).host;
  const hosts = [firstHeader(req.headers.host)];
  if (trustProxy) hosts.push(firstHeader(req.headers['x-forwarded-host']));
  return hosts.some((h) => h?.toLowerCase() === host);
}
