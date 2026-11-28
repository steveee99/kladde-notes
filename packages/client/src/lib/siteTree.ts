import { extractMeta, splitPath, type PublicSiteNote } from '@kladde/shared';
import { compareText } from './i18n';

/** A note in a folder website's tree */
export interface SiteEntry {
  id: string;
  path: string;
  title: string;
}

export interface SiteFolder {
  name: string;
  /** Relative to the site; '' for the site itself */
  path: string;
  folders: SiteFolder[];
  notes: SiteEntry[];
}

export const siteTitleOf = (n: Pick<PublicSiteNote, 'path' | 'content'>): string => extractMeta(n.path, n.content).title;

/** The folder tree of a site: subfolders first, then notes, both by name */
export function buildSiteTree(notes: readonly Pick<PublicSiteNote, 'id' | 'path' | 'content'>[]): SiteFolder {
  const root: SiteFolder = { name: '', path: '', folders: [], notes: [] };
  const folders = new Map<string, SiteFolder>([['', root]]);
  const folderAt = (path: string): SiteFolder => {
    let f = folders.get(path);
    if (f) return f;
    const { folder: parent, name } = splitPath(path);
    f = { name, path, folders: [], notes: [] };
    folderAt(parent).folders.push(f);
    folders.set(path, f);
    return f;
  };
  for (const n of notes) folderAt(splitPath(n.path).folder).notes.push({ id: n.id, path: n.path, title: siteTitleOf(n) });
  const sort = (f: SiteFolder) => {
    f.folders.sort((a, b) => compareText(a.name, b.name));
    f.notes.sort((a, b) => compareText(a.title, b.title));
    f.folders.forEach(sort);
  };
  sort(root);
  return root;
}

/** The folders above a note's path ('A', 'A/B' for 'A/B/Note.md') */
export function ancestorsOf(path: string): string[] {
  const parts = splitPath(path).folder.split('/').filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

/** The note an address names: the part after `/site/<slug>/`, its path without `.md` (case does not matter) */
export function findSiteNote<T extends Pick<PublicSiteNote, 'path'>>(notes: readonly T[], rest: string): T | undefined {
  const wanted = rest.replace(/^\/+|\/+$/g, '').toLowerCase();
  if (!wanted) return undefined;
  return notes.find((n) => n.path.replace(/\.md$/i, '').toLowerCase() === wanted);
}

const HOME_NAMES = ['index', 'readme', 'home', 'start', 'startseite', 'übersicht', 'overview'];

/** The site's start page: a top-level note named like a start page or like the folder, else none (the overview shows) */
export function homeOf<T extends Pick<PublicSiteNote, 'path'>>(notes: readonly T[], siteTitle: string): T | undefined {
  const names = [...HOME_NAMES, siteTitle.toLowerCase()];
  const top = notes.filter((n) => !n.path.includes('/'));
  for (const name of names) {
    const hit = top.find((n) => splitPath(n.path).name.toLowerCase() === name);
    if (hit) return hit;
  }
  return undefined;
}

/** Notes whose title or text contains every word of the query */
export function searchSite<T extends Pick<PublicSiteNote, 'path' | 'content'>>(notes: readonly T[], query: string, limit = 50): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored: { note: T; score: number }[] = [];
  for (const n of notes) {
    const title = siteTitleOf(n).toLowerCase();
    const text = n.content.toLowerCase();
    if (!words.every((w) => title.includes(w) || text.includes(w))) continue;
    scored.push({ note: n, score: words.filter((w) => title.includes(w)).length });
  }
  return scored
    .sort((a, b) => b.score - a.score || compareText(siteTitleOf(a.note), siteTitleOf(b.note)))
    .slice(0, limit)
    .map((s) => s.note);
}
