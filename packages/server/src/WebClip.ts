import { extractWebClip, markdownUrl, type WebClip } from '@kladde/shared';
import { ImportError, fetchImage, fetchPage } from './RecipeImport.js';

/** At most this many images are downloaded per clip, each up to this size */
export const CLIP_MAX_IMAGES = 30;
export const CLIP_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Web clipper (#32): the server fetches the page (with the SSRF checks of the recipe import), extracts the
 * article as Markdown and, on request, stores its images as attachments of the user so the note works
 * offline and survives the page. Images that cannot be fetched keep their original address.
 */
export async function clipPage(raw: string, opts: { images: boolean; save: (name: string, mime: string, data: Buffer) => string }): Promise<WebClip & { savedImages: number }> {
  const { url, html } = await fetchPage(raw);
  const clip = extractWebClip(html, url);
  if (!clip.markdown && !clip.excerpt) throw new ImportError('Auf dieser Seite wurde kein Text gefunden.');
  let savedImages = 0;
  if (opts.images && clip.images.length) {
    const replaced = new Map<string, string>();
    for (const src of clip.images.slice(0, CLIP_MAX_IMAGES)) {
      try {
        const { mime, data } = await fetchImage(src, CLIP_MAX_IMAGE_BYTES);
        const name = decodeURIComponent(new URL(src).pathname.split('/').pop() || 'bild').slice(0, 120) || 'bild';
        replaced.set(src, opts.save(name, mime, data));
        savedImages++;
      } catch {
        // Keep the original address
      }
    }
    if (replaced.size) {
      // Replace exactly the link targets the writer produced (the same escaping as there)
      clip.markdown = clip.markdown.replace(/\]\(([^)\s]+)\)/g, (all, target: string) => {
        const original = clip.images.find((i) => markdownUrl(i) === target);
        const local = original ? replaced.get(original) : undefined;
        return local ? `](${local})` : all;
      });
      clip.images = clip.images.map((i) => replaced.get(i) ?? i);
    }
  }
  return { ...clip, savedImages };
}
