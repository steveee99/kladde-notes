export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A note path without empty, "." and ".." segments; throws when nothing is left */
export function cleanPath(path: unknown): string {
  if (typeof path !== 'string') throw new Error('invalid path');
  const parts = path
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p && p !== '.' && p !== '..');
  if (!parts.length) throw new Error('invalid path');
  return parts.join('/').slice(0, 400);
}

/**
 * A URL from note content that is safe to put into href/src, or null. Markdown lets a note carry any
 * scheme, and `javascript:` in a link, image or iframe runs in the app's origin (stored XSS through shared
 * or public notes). Relative URLs stay; absolute ones need an allowed scheme. `media` (img/iframe) allows
 * http(s) and, for images, `data:image/…` (`allowDataImage`); links also allow mailto: and tel:.
 */
export function safeUrl(raw: unknown, kind: 'link' | 'media' = 'link', allowDataImage = false): string | null {
  if (typeof raw !== 'string') return null;
  const url = raw.trim();
  if (!url) return null;
  // Browsers drop tabs, newlines and control characters inside a scheme ("java\tscript:"), so judge without them
  // eslint-disable-next-line no-control-regex
  const probe = url.replace(/[\u0000-\u0020\u007f-\u009f]/g, '').toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(probe)?.[1];
  // "\\host\share" is a UNC path on Windows
  if (!scheme) return probe.startsWith('\\') ? null : url;
  if (scheme === 'http' || scheme === 'https') return url;
  if (kind === 'link' && (scheme === 'mailto' || scheme === 'tel')) return url;
  if (kind === 'media' && allowDataImage && /^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml)[;,]/.test(probe)) return url;
  return null;
}
