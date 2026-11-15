import https from 'node:https';
import net from 'node:net';
import crypto from 'crypto';
import type { ConfluenceKind, ConfluencePageRef, ConfluenceSpace } from '@kladde/shared';
import { isPrivateAddress, safeLookup } from '../RecipeImport.js';

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: URL;
  headers: Record<string, string>;
  body?: Buffer;
}

export interface HttpResponse {
  status: number;
  body: Buffer;
}

/** Sends one request; injected so tests can answer like Confluence */
export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

export class ConfluenceError extends Error {
  constructor(
    message: string,
    readonly status = 0
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 30_000;
/** Answers from Confluence (search results, pages with body) */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** Settings → Confluence takes the address as the user copies it from the browser */
export function normalizeConfluenceUrl(raw: string, kind: ConfluenceKind, allowPrivate: boolean): string {
  let url: URL;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new ConfluenceError('Das ist keine gültige Adresse.');
  }
  if (url.protocol !== 'https:') throw new ConfluenceError('Nur https-Adressen sind erlaubt.');
  if (url.username || url.password) throw new ConfluenceError('Adressen mit Zugangsdaten gehen nicht.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!allowPrivate) {
    if (net.isIP(host) && isPrivateAddress(host)) throw new ConfluenceError('Private Adressen sind nicht erlaubt (CONFLUENCE_ALLOW_PRIVATE).');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
      throw new ConfluenceError('Private Adressen sind nicht erlaubt (CONFLUENCE_ALLOW_PRIVATE).');
    }
  }
  // Cut what the browser shows after the base (…/wiki/spaces/…, …/display/…, …/pages/…)
  let path = url.pathname.replace(/\/(spaces|display|pages|rest|plugins|dashboard\.action|homepage\.action)(\/.*)?$/, '').replace(/\/+$/, '');
  // Atlassian Cloud always serves Confluence below /wiki
  if (host.endsWith('.atlassian.net')) path = '/wiki';
  return `https://${url.host}${path}`;
}

/** https request with the SSRF protections of the web clipper (unless private addresses are allowed), size and time limits */
export function httpsTransport(opts: { allowPrivate: boolean }): HttpTransport {
  return (req) =>
    new Promise((resolve, reject) => {
      if (req.url.protocol !== 'https:') return reject(new ConfluenceError('Nur https-Adressen sind erlaubt.'));
      const request = https.request(
        req.url,
        {
          method: req.method,
          headers: { ...req.headers, ...(req.body ? { 'Content-Length': String(req.body.length) } : {}) },
          lookup: opts.allowPrivate ? undefined : safeLookup,
          timeout: TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_RESPONSE_BYTES) {
              request.destroy(new ConfluenceError('Die Antwort von Confluence ist zu groß.'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
          res.on('error', reject);
        }
      );
      request.on('timeout', () => request.destroy(new ConfluenceError('Confluence antwortet nicht.')));
      request.on('error', (err) => reject(err instanceof ConfluenceError ? err : new ConfluenceError(`Confluence ist nicht erreichbar (${(err as Error).message}).`)));
      if (req.body) request.write(req.body);
      request.end();
    });
}

export interface PageInfo {
  id: string;
  title: string;
  version: number;
  spaceKey: string;
  parentId: string | null;
}

interface RawPage {
  id: string;
  title: string;
  version?: { number?: number };
  space?: { key?: string };
  ancestors?: { id: string }[];
}

/** REST API v1 of Confluence (Cloud and Data Center/Server share it) */
export class ConfluenceClient {
  readonly base: string;

  constructor(
    account: { url: string; kind: ConfluenceKind; email: string; token: string },
    private readonly transport: HttpTransport
  ) {
    this.base = account.url.replace(/\/+$/, '');
    this.auth = account.kind === 'cloud' ? `Basic ${Buffer.from(`${account.email}:${account.token}`).toString('base64')}` : `Bearer ${account.token}`;
  }

  private readonly auth: string;

  pageUrl(id: string): string {
    return `${this.base}/pages/viewpage.action?pageId=${encodeURIComponent(id)}`;
  }

  private async call<T>(method: HttpRequest['method'], path: string, body?: unknown, extra?: { headers: Record<string, string>; raw: Buffer }): Promise<T> {
    const url = new URL(`${this.base}/rest/api${path}`);
    const headers: Record<string, string> = { Authorization: this.auth, Accept: 'application/json', 'X-Atlassian-Token': 'no-check', ...(extra?.headers ?? {}) };
    let payload: Buffer | undefined = extra?.raw;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = Buffer.from(JSON.stringify(body));
    }
    const res = await this.transport({ method, url, headers, body: payload });
    if (res.status >= 200 && res.status < 300) {
      if (!res.body.length) return undefined as T;
      try {
        return JSON.parse(res.body.toString('utf8')) as T;
      } catch {
        throw new ConfluenceError('Unerwartete Antwort von Confluence (kein JSON). Stimmt die Adresse?', res.status);
      }
    }
    let message = '';
    try {
      const data = JSON.parse(res.body.toString('utf8')) as { message?: unknown };
      if (typeof data.message === 'string') message = data.message.slice(0, 300);
    } catch {
      // not JSON
    }
    if (res.status === 401) throw new ConfluenceError('Anmeldung bei Confluence fehlgeschlagen: Token ungültig oder abgelaufen.', 401);
    if (res.status === 403) throw new ConfluenceError(`Keine Berechtigung in Confluence${message ? ` (${message})` : ''}.`, 403);
    if (res.status === 404) throw new ConfluenceError(message || 'In Confluence nicht gefunden.', 404);
    if (res.status >= 300 && res.status < 400) throw new ConfluenceError('Confluence leitet um. Stimmt die Adresse?', res.status);
    throw new ConfluenceError(`Confluence meldet Fehler ${res.status}${message ? `: ${message}` : ''}.`, res.status);
  }

  async currentUser(): Promise<string> {
    const user = await this.call<{ displayName?: string; username?: string; publicName?: string; type?: string }>('GET', '/user/current');
    if (!user || user.type === 'anonymous') throw new ConfluenceError('Anmeldung bei Confluence fehlgeschlagen: Token ungültig oder abgelaufen.', 401);
    return user.displayName || user.publicName || user.username || 'Unbekannt';
  }

  async spaces(query = ''): Promise<ConfluenceSpace[]> {
    const res = await this.call<{ results?: { key: string; name: string }[] }>('GET', '/space?limit=250');
    const q = query.trim().toLowerCase();
    return (res?.results ?? [])
      .map((s) => ({ key: s.key, name: s.name }))
      .filter((s) => !q || s.key.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
      .slice(0, 50);
  }

  /** Pages of a space whose title contains the words (parent page search) */
  async searchPages(spaceKey: string, query: string): Promise<ConfluencePageRef[]> {
    const quote = (s: string) => `"${s.replace(/["\\]/g, (c) => `\\${c}`)}"`;
    const words = query.trim().replace(/[^\p{L}\p{N}\s_-]/gu, ' ').trim();
    const cql = `type=page AND space=${quote(spaceKey)}${words ? ` AND title~${quote(`${words}*`)}` : ''} ORDER BY title`;
    const res = await this.call<{ results?: RawPage[] }>('GET', `/content/search?limit=25&expand=space&cql=${encodeURIComponent(cql)}`);
    return (res?.results ?? []).map((p) => ({ id: p.id, title: p.title, spaceKey: p.space?.key ?? spaceKey, url: this.pageUrl(p.id) }));
  }

  /** null when the page is gone (deleted or in the trash) */
  async page(id: string): Promise<PageInfo | null> {
    try {
      const p = await this.call<RawPage & { status?: string }>('GET', `/content/${encodeURIComponent(id)}?expand=version,space,ancestors`);
      if (!p || (p.status && p.status !== 'current')) return null;
      return this.info(p);
    } catch (err) {
      if (err instanceof ConfluenceError && err.status === 404) return null;
      throw err;
    }
  }

  private info(p: RawPage): PageInfo {
    const ancestors = p.ancestors ?? [];
    return { id: String(p.id), title: p.title, version: p.version?.number ?? 1, spaceKey: p.space?.key ?? '', parentId: ancestors.length ? String(ancestors[ancestors.length - 1].id) : null };
  }

  async createPage(input: { spaceKey: string; parentId: string | null; title: string; body: string }): Promise<PageInfo> {
    const p = await this.call<RawPage>('POST', '/content', {
      type: 'page',
      title: input.title,
      space: { key: input.spaceKey },
      ...(input.parentId ? { ancestors: [{ id: input.parentId }] } : {}),
      body: { storage: { value: input.body, representation: 'storage' } },
    });
    return { ...this.info(p), spaceKey: input.spaceKey, parentId: input.parentId };
  }

  async updatePage(id: string, input: { spaceKey: string; parentId: string | null; title: string; body: string; version: number }): Promise<PageInfo> {
    const p = await this.call<RawPage>('PUT', `/content/${encodeURIComponent(id)}`, {
      id,
      type: 'page',
      title: input.title,
      space: { key: input.spaceKey },
      version: { number: input.version, message: 'Kladde' },
      ...(input.parentId ? { ancestors: [{ id: input.parentId }] } : {}),
      body: { storage: { value: input.body, representation: 'storage' } },
    });
    return { ...this.info(p), spaceKey: input.spaceKey, parentId: input.parentId };
  }

  /** Moves the page to the space's trash */
  async trashPage(id: string): Promise<void> {
    try {
      await this.call('DELETE', `/content/${encodeURIComponent(id)}`);
    } catch (err) {
      if (!(err instanceof ConfluenceError && err.status === 404)) throw err;
    }
  }

  async addLabels(id: string, labels: string[]): Promise<void> {
    if (!labels.length) return;
    await this.call('POST', `/content/${encodeURIComponent(id)}/label`, labels.map((name) => ({ prefix: 'global', name })));
  }

  /** Creates or replaces an attachment with this file name on the page */
  async putAttachment(pageId: string, filename: string, mime: string, data: Buffer): Promise<void> {
    const boundary = `----kladde${crypto.randomBytes(12).toString('hex')}`;
    const safeName = filename.replace(/["\r\n]/g, '_');
    const raw = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(filename)}\r\nContent-Type: ${mime}\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="minorEdit"\r\n\r\ntrue\r\n--${boundary}--\r\n`),
    ]);
    await this.call('PUT', `/content/${encodeURIComponent(pageId)}/child/attachment`, undefined, {
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      raw,
    });
  }
}
