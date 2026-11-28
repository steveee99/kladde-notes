import type { PublicNote } from './types.js';

/**
 * Folder websites: an own folder published read-only under `/site/<slug>`, with its notes, the folder tree, the graph and
 * the backlinks between them. The slug is random (like a public link) unless the owner picks one.
 */

export const SITE_SLUG_MIN = 3;
export const SITE_SLUG_MAX = 48;
/** Lower case letters, digits and single hyphens inside */
export const SITE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** At most this many notes go out with one site; the rest are left out (`truncated`) */
export const MAX_SITE_NOTES = 2000;

export function isValidSiteSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && slug.length >= SITE_SLUG_MIN && slug.length <= SITE_SLUG_MAX && SITE_SLUG_PATTERN.test(slug);
}

const UMLAUTS: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };

/** `text` without hyphens at its start and end (a loop, no backtracking regex on input) */
function trimHyphens(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === '-') start++;
  while (end > start && text[end - 1] === '-') end--;
  return text.slice(start, end);
}

/** What the owner typed, made into a slug: lower case, umlauts spelled out, anything else between words a hyphen */
export function normalizeSiteSlug(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => UMLAUTS[c])
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-');
  return trimHyphens(trimHyphens(slug).slice(0, SITE_SLUG_MAX));
}

/** The website of a folder as its owner manages it */
export interface FolderSite {
  slug: string;
  createdAt: number;
}

/** One note of a published folder; `path` is relative to the folder */
export interface PublicSiteNote extends Pick<PublicNote, 'path' | 'content' | 'updatedAt' | 'variables' | 'noteType' | 'versioning' | 'releases' | 'showsRelease'> {
  /** Opaque id (not the note's own id) */
  id: string;
}

/** What guests get for `/site/<slug>` */
export interface PublicSite {
  /** The folder's name (its path above stays private) */
  title: string;
  owner: string;
  ownerAvatar?: string | null;
  /** Newest change of a note in it */
  updatedAt: number;
  notes: PublicSiteNote[];
  /** More than MAX_SITE_NOTES notes: the rest are left out */
  truncated?: boolean;
}

/** The part of the address after `/site/<slug>/` for a note: its path without `.md` */
export function siteNoteHref(slug: string, path: string): string {
  const parts = path.replace(/\.md$/i, '').split('/').map(encodeURIComponent);
  return `/site/${encodeURIComponent(slug)}/${parts.join('/')}`;
}
