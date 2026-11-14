/**
 * PWA share target (imported into the generated service worker, see vite.config.ts).
 * Other apps POST title/text/url and files to /share. The worker keeps them in the cache "kladde-share"
 * under a random id and redirects to /share?id=…, where Quick Capture picks them up (lib/shareTarget.ts).
 * Nothing leaves the device here; files are uploaded only when the user saves.
 */
const SHARE_CACHE = 'kladde-share';
const MAX_FILES = 10;

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || url.origin !== self.location.origin || url.pathname !== '/share') return;
  event.respondWith(receiveShare(event.request));
});

async function receiveShare(request) {
  const id = self.crypto.randomUUID();
  try {
    const form = await request.formData();
    const str = (name) => {
      const v = form.get(name);
      return typeof v === 'string' ? v : '';
    };
    const cache = await caches.open(SHARE_CACHE);
    const files = form
      .getAll('files')
      .filter((f) => typeof f !== 'string' && f.size > 0)
      .slice(0, MAX_FILES);
    const meta = { title: str('title'), text: str('text'), url: str('url'), files: [], at: Date.now() };
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      meta.files.push({ name: f.name || `datei-${i + 1}`, type: f.type || 'application/octet-stream' });
      await cache.put(new Request(`/share-data/${id}/${i}`), new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream' } }));
    }
    await cache.put(new Request(`/share-data/${id}/meta`), new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
    return Response.redirect(`/share?id=${id}`, 303);
  } catch {
    return Response.redirect('/share?error=1', 303);
  }
}
