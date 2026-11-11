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
