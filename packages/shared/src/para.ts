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

export const FEATURES_SETTING = 'features';

export const DEFAULT_PARA_FOLDERS = {
  projects: '1 Projekte',
  areas: '2 Bereiche',
  resources: '3 Ressourcen',
  archive: '4 Archiv',
} as const;

export const DEFAULT_ZETTEL_FOLDER = 'Zettelkasten';
export const DEFAULT_RECIPE_FOLDER = '3 Ressourcen/Rezepte';
export const STANDALONE_RECIPE_FOLDER = 'Rezepte';

export interface ParaFolderSettings {
  projects: string;
  areas: string;
  resources: string;
  archive: string;
}

export interface FeatureSettings {
  para: {
    enabled: boolean;
    folders: ParaFolderSettings;
  };
  zettel: {
    enabled: boolean;
    folder: string;
  };
  recipe: {
    enabled: boolean;
    folder: string;
  };
}

/** Configurable folder mapping per role; `null` disables matching for that role */
export interface RoleFolderMap {
  inbox?: string | null;
  projects?: string | null;
  areas?: string | null;
  resources?: string | null;
  archive?: string | null;
  zettel?: string | null;
}

function cleanFeatureFolder(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw
    .split('/')
    .map((p) => p.trim().replace(/[\\]/g, '-'))
    .filter((p) => p && p !== '.' && p !== '..')
    .join('/');
  return cleaned || fallback;
}

function hasFolderPrefix(folders: string[], target: string): boolean {
  return folders.some((f) => f === target || f.startsWith(`${target}/`));
}

/**
 * Normalizes feature opt-in settings. When a flag is missing (upgraded space), pre-enables
 * features whose standard folders already exist in `existingFolders`; new spaces start disabled.
 */
export function normalizeFeatures(raw: unknown, existingFolders: string[] = []): FeatureSettings {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const rawPara = obj.para && typeof obj.para === 'object' && !Array.isArray(obj.para) ? (obj.para as Record<string, unknown>) : undefined;
  const rawParaFolders =
    rawPara?.folders && typeof rawPara.folders === 'object' && !Array.isArray(rawPara.folders)
      ? (rawPara.folders as Record<string, unknown>)
      : undefined;
  const rawZettel = obj.zettel && typeof obj.zettel === 'object' && !Array.isArray(obj.zettel) ? (obj.zettel as Record<string, unknown>) : undefined;
  const rawRecipe = obj.recipe && typeof obj.recipe === 'object' && !Array.isArray(obj.recipe) ? (obj.recipe as Record<string, unknown>) : undefined;

  const hasExistingPara = Object.values(DEFAULT_PARA_FOLDERS).some((f) => hasFolderPrefix(existingFolders, f));
  const hasExistingZettel = hasFolderPrefix(existingFolders, DEFAULT_ZETTEL_FOLDER);
  const hasExistingRecipe = hasFolderPrefix(existingFolders, DEFAULT_RECIPE_FOLDER);

  const paraEnabled = typeof rawPara?.enabled === 'boolean' ? rawPara.enabled : hasExistingPara;
  const zettelEnabled = typeof rawZettel?.enabled === 'boolean' ? rawZettel.enabled : hasExistingZettel;
  const recipeEnabled = typeof rawRecipe?.enabled === 'boolean' ? rawRecipe.enabled : hasExistingRecipe;

  const defaultRecipeFolder =
    paraEnabled || hasExistingRecipe || hasFolderPrefix(existingFolders, DEFAULT_PARA_FOLDERS.resources)
      ? DEFAULT_RECIPE_FOLDER
      : STANDALONE_RECIPE_FOLDER;

  return {
    para: {
      enabled: paraEnabled,
      folders: {
        projects: cleanFeatureFolder(rawParaFolders?.projects, DEFAULT_PARA_FOLDERS.projects),
        areas: cleanFeatureFolder(rawParaFolders?.areas, DEFAULT_PARA_FOLDERS.areas),
        resources: cleanFeatureFolder(rawParaFolders?.resources, DEFAULT_PARA_FOLDERS.resources),
        archive: cleanFeatureFolder(rawParaFolders?.archive, DEFAULT_PARA_FOLDERS.archive),
      },
    },
    zettel: {
      enabled: zettelEnabled,
      folder: cleanFeatureFolder(rawZettel?.folder, DEFAULT_ZETTEL_FOLDER),
    },
    recipe: {
      enabled: recipeEnabled,
      folder: cleanFeatureFolder(rawRecipe?.folder, defaultRecipeFolder),
    },
  };
}

const ROLE_ORDER: ParaRole[] = ['inbox', 'archive', 'projects', 'areas', 'resources', 'zettel'];

export function roleOfFolder(folder: string, config: RoleFolderMap = PARA): ParaRole | null {
  if (!folder) return null;
  let bestRole: ParaRole | null = null;
  let bestLen = -1;
  for (const role of ROLE_ORDER) {
    const root = config[role];
    if (!root) continue;
    if ((folder === root || folder.startsWith(`${root}/`)) && root.length > bestLen) {
      bestRole = role;
      bestLen = root.length;
    }
  }
  return bestRole;
}

export const roleOfPath = (path: string, config: RoleFolderMap = PARA) => roleOfFolder(splitPath(path).folder, config);

export type ProjectStatus = 'aktiv' | 'pausiert' | 'fertig';
export const PROJECT_STATUSES: ProjectStatus[] = ['aktiv', 'pausiert', 'fertig'];

export type ZettelType = 'flüchtig' | 'literatur' | 'dauerhaft';
export const ZETTEL_TYPES: { id: ZettelType; label: string; hint: string }[] = [
  { id: 'flüchtig', label: 'Flüchtig', hint: 'Schneller Einfall, wird später ausgearbeitet oder verworfen' },
  { id: 'literatur', label: 'Literatur', hint: 'Gedanken zu einer Quelle, in eigenen Worten' },
  { id: 'dauerhaft', label: 'Dauerhaft', hint: 'Ein ausgearbeiteter Gedanke, mit anderen verknüpft' },
];

/** Where a folder goes when archived: "<archive>/<original path>" */
export function archiveTarget(folder: string, archiveFolder: string = PARA.archive): string {
  if (!folder) return archiveFolder;
  if (folder === archiveFolder || folder.startsWith(`${archiveFolder}/`)) return folder;
  return `${archiveFolder}/${folder}`;
}

/** The original folder of an archived one, or null if it is not inside the archive */
export function restoreTarget(folder: string, archiveFolder: string = PARA.archive): string | null {
  const prefix = `${archiveFolder}/`;
  return folder.startsWith(prefix) ? folder.slice(prefix.length) : null;
}

/** Zettel ids: year, month, day, hour, minute – sortable and unique enough for one person */
export function zettelId(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

export const ZETTEL_ID_PATTERN = /^(\d{12,14})\b/;
