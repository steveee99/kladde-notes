import { splitPath } from './markdown.js';

/**
 * PARA (Projects, Areas, Resources, Archive) plus Inbox and Zettelkasten. The roots are ordinary
 * top-level folders; this maps paths to their role.
 */
export const PARA = {
  inbox: '0 Inbox',
  projects: '1 Projekte',
  areas: '2 Bereiche',
  resources: '3 Ressourcen',
  archive: '4 Archiv',
  zettel: 'Zettelkasten',
} as const;

export type ParaRole = keyof typeof PARA;

export function roleOfFolder(folder: string): ParaRole | null {
  const top = folder.split('/')[0];
  for (const [role, root] of Object.entries(PARA)) if (top === root) return role as ParaRole;
  return null;
}

export const roleOfPath = (path: string) => roleOfFolder(splitPath(path).folder);

export type ProjectStatus = 'aktiv' | 'pausiert' | 'fertig';
export const PROJECT_STATUSES: ProjectStatus[] = ['aktiv', 'pausiert', 'fertig'];

export type ZettelType = 'flüchtig' | 'literatur' | 'dauerhaft';
export const ZETTEL_TYPES: { id: ZettelType; label: string; hint: string }[] = [
  { id: 'flüchtig', label: 'Flüchtig', hint: 'Schneller Einfall, wird später ausgearbeitet oder verworfen' },
  { id: 'literatur', label: 'Literatur', hint: 'Gedanken zu einer Quelle, in eigenen Worten' },
  { id: 'dauerhaft', label: 'Dauerhaft', hint: 'Ein ausgearbeiteter Gedanke, mit anderen verknüpft' },
];

/** Where a folder goes when archived: "4 Archiv/<original path>" */
export function archiveTarget(folder: string): string {
  return `${PARA.archive}/${folder}`;
}

/** The original folder of an archived one, or null if it is not inside the archive */
export function restoreTarget(folder: string): string | null {
  return folder.startsWith(`${PARA.archive}/`) ? folder.slice(PARA.archive.length + 1) : null;
}

/** Zettel ids: year, month, day, hour, minute – sortable and unique enough for one person */
export function zettelId(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

export const ZETTEL_ID_PATTERN = /^(\d{12,14})\b/;
