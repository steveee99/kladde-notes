/**
 * Reads what another app shared with Kladde ("Share → Kladde"). The service worker (public/share-target.js)
 * receives the POST, keeps title/text/url and files in the cache "kladde-share" and redirects to /share?id=….
 */
const SHARE_CACHE = 'kladde-share';
/** Leftovers of shares that were never opened are removed after a day */
const MAX_AGE = 24 * 60 * 60 * 1000;

export interface SharedItem {
  title: string;
  text: string;
  url: string;
  files: File[];
}

interface SharedMeta {
  title?: string;
  text?: string;
  url?: string;
  files?: { name: string; type: string }[];
  at?: number;
}

const metaKey = (id: string) => `/share-data/${id}/meta`;

export async function readSharedItem(id: string): Promise<SharedItem | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id) || typeof caches === 'undefined') return null;
  const cache = await caches.open(SHARE_CACHE);
  const res = await cache.match(metaKey(id));
  if (!res) return null;
  const meta = (await res.json()) as SharedMeta;
  const files: File[] = [];
  for (const [i, f] of (meta.files ?? []).entries()) {
    const blob = await (await cache.match(`/share-data/${id}/${i}`))?.blob();
    if (blob) files.push(new File([blob], f.name, { type: f.type || blob.type }));
  }
  return { title: meta.title ?? '', text: meta.text ?? '', url: meta.url ?? '', files };
}

/** Removes a share once it was saved or dismissed, plus anything older than a day */
export async function clearSharedItem(id: string): Promise<void> {
  if (typeof caches === 'undefined') return;
  const cache = await caches.open(SHARE_CACHE);
  const now = Date.now();
  const expired = new Set<string>([id]);
  for (const req of await cache.keys()) {
    const m = /\/share-data\/([^/]+)\/meta$/.exec(new URL(req.url).pathname);
    if (!m || m[1] === id) continue;
    const meta = (await (await cache.match(req))?.json().catch(() => null)) as SharedMeta | null;
    if (!meta?.at || now - meta.at > MAX_AGE) expired.add(m[1]);
  }
  for (const req of await cache.keys()) {
    const sid = /\/share-data\/([^/]+)\//.exec(new URL(req.url).pathname)?.[1];
    if (sid && expired.has(sid)) await cache.delete(req);
  }
}
