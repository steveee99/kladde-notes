import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';
import { extractRecipe, type Recipe } from '@kladde/shared';

/**
 * Fetches a recipe page for the recipe import. The server runs in a home network, so the fetch must
 * never reach private addresses: every resolved IP (also after redirects) is checked in the socket's
 * own DNS lookup, which leaves no gap for DNS rebinding.
 */

export class ImportError extends Error {}

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 5;

/** True for loopback, private, link-local, CGNAT, multicast and other non-public ranges */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivateAddress(mapped[1]);
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff') || v6.startsWith('64:ff9b');
}

const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 4);
    const list = addresses as dns.LookupAddress[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad || !list.length) return callback(new ImportError('Diese Adresse ist nicht erlaubt.'), '', 4);
    if ((options as dns.LookupOptions).all) (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    else callback(null, list[0].address, list[0].family);
  });
};

export function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ImportError('Das ist kein gültiger Link.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ImportError('Nur http- und https-Links gehen.');
  if (url.username || url.password) throw new ImportError('Links mit Zugangsdaten gehen nicht.');
  if (url.port && !['80', '443'].includes(url.port)) throw new ImportError('Nur Standard-Ports sind erlaubt.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isPrivateAddress(host)) throw new ImportError('Diese Adresse ist nicht erlaubt.');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new ImportError('Diese Adresse ist nicht erlaubt.');
  return url;
}

function decode(body: Buffer, contentType: string): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 4096).toString('latin1'))?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset.toLowerCase()).decode(body);
  } catch {
    return body.toString('utf8');
  }
}

function get(url: URL): Promise<{ status: number; location?: string; contentType: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.get(
      url,
      {
        lookup: safeLookup,
        timeout: TIMEOUT_MS,
        headers: {
          // Many recipe sites answer bots with an empty page, so ask like a browser does
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'de-DE,de;q=0.9,en;q=0.7',
          'Accept-Encoding': 'gzip, deflate, br',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          resolve({ status, location: res.headers.location, contentType: '', body: Buffer.alloc(0) });
          return;
        }
        const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
        const stream =
          enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : enc === 'br' ? res.pipe(zlib.createBrotliDecompress()) : res;
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) {
            req.destroy(new ImportError('Die Seite ist zu groß.'));
            return;
          }
          chunks.push(c);
        });
        stream.on('end', () => resolve({ status, contentType: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks) }));
        stream.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new ImportError('Die Seite antwortet nicht.')));
    req.on('error', reject);
  });
}

export async function fetchPage(raw: string): Promise<{ url: string; html: string }> {
  let url = checkUrl(raw);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    let res;
    try {
      res = await get(url);
    } catch (err) {
      if (err instanceof ImportError) throw err;
      throw new ImportError('Die Seite ist nicht erreichbar.');
    }
    if (res.location) {
      url = checkUrl(new URL(res.location, url).toString());
      continue;
    }
    if (res.status >= 400) throw new ImportError(`Die Seite antwortet mit Fehler ${res.status}.`);
    if (!/html|xml/i.test(res.contentType)) throw new ImportError('Unter diesem Link liegt keine Webseite.');
    return { url: url.toString(), html: decode(res.body, res.contentType) };
  }
  throw new ImportError('Zu viele Weiterleitungen.');
}

export async function importRecipe(raw: string): Promise<Recipe> {
  const { url, html } = await fetchPage(raw);
  const recipe = extractRecipe(html, raw.trim() || url);
  if (!recipe) throw new ImportError('Auf dieser Seite wurde kein Rezept gefunden.');
  return recipe;
}
