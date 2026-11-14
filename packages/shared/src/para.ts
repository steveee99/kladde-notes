import { parseFrontmatter, splitPath } from './markdown.js';

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
export const DEFAULT_DAILY_FOLDER = '0 Daily';
export const DEFAULT_DAILY_FORMAT = 'YYYY/MM/YYYY-MM-DD.md';
export const PROJECT_HOME_NAME = 'Home';

export interface ParaFolderSettings {
  projects: string;
  areas: string;
  resources: string;
  archive: string;
}

export interface DailySettings {
  enabled: boolean;
  folder: string;
  format: string;
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
  daily: DailySettings;
  heatmap: {
    enabled: boolean;
  };
  /** Weekly review (`/review`) with its reminder on the home screen */
  review: {
    enabled: boolean;
  };
  /** Favorites list in the sidebar, toggled per note with Ctrl/⌘+D */
  favorites: {
    enabled: boolean;
  };
  /** Status line under a note: words, characters, reading time (on unless turned off) */
  writingStats: {
    enabled: boolean;
  };
  /** Focus mode (Ctrl/⌘+Shift+F): hides navigation and panels; `dim` fades all paragraphs but the current one */
  focus: {
    enabled: boolean;
    dim: boolean;
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
  const parts = raw
    .split('/')
    .map((p) => p.trim().replace(/[\\]/g, '-'))
    .filter((p) => p && p !== '.' && p !== '..');
  if (parts[0]?.toLowerCase() === '.kladde') return fallback;
  return parts.join('/') || fallback;
}

/** Daily folder may intentionally be empty (vault root), but never `.kladde` */
export function cleanDailyFolder(raw: unknown, fallback = DEFAULT_DAILY_FOLDER): string {
  if (typeof raw !== 'string') return fallback;
  const parts = raw
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p && p !== '.' && p !== '..');
  if (parts[0]?.toLowerCase() === '.kladde') return fallback;
  return parts.join('/');
}

/** Daily filename/subfolder pattern (e.g. "YYYY/MM/YYYY-MM-DD.md") */
export function cleanDailyFormat(raw: unknown, fallback = DEFAULT_DAILY_FORMAT): string {
  if (typeof raw !== 'string') return fallback;
  const parts = raw
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p && p !== '.' && p !== '..');
  if (!parts.length || parts[0].toLowerCase() === '.kladde') return fallback;
  return parts.join('/');
}

/** Only `{ enabled: false }` turns an opt-out feature off; anything else leaves it on */
function optOutFlag(raw: unknown): boolean {
  return !(raw && typeof raw === 'object' && (raw as Record<string, unknown>).enabled === false);
}

/** `{ enabled: true }` turns an opt-in feature on; anything else leaves it off */
function optInFlag(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && (raw as Record<string, unknown>).enabled === true;
}

function hasFolderPrefix(folders: string[], target: string): boolean {
  return folders.some((f) => f === target || f.startsWith(`${target}/`));
}

/**
 * Normalizes feature opt-in settings. When a flag is missing (upgraded space), pre-enables
 * features whose standard folders already exist in `existingFolders`; new spaces start disabled.
 * Daily notes default to enabled with "0 Daily/YYYY/MM/YYYY-MM-DD.md" unless explicitly turned off.
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
  const rawDaily = obj.daily && typeof obj.daily === 'object' && !Array.isArray(obj.daily) ? (obj.daily as Record<string, unknown>) : undefined;
  const rawHeatmap =
    obj.heatmap && typeof obj.heatmap === 'object' && !Array.isArray(obj.heatmap) ? (obj.heatmap as Record<string, unknown>) : undefined;

  const hasExistingPara = Object.values(DEFAULT_PARA_FOLDERS).some((f) => hasFolderPrefix(existingFolders, f));
  const hasExistingZettel = hasFolderPrefix(existingFolders, DEFAULT_ZETTEL_FOLDER);
  const hasExistingRecipe = hasFolderPrefix(existingFolders, DEFAULT_RECIPE_FOLDER);

  const paraEnabled = typeof rawPara?.enabled === 'boolean' ? rawPara.enabled : hasExistingPara;
  const zettelEnabled = typeof rawZettel?.enabled === 'boolean' ? rawZettel.enabled : hasExistingZettel;
  const recipeEnabled = typeof rawRecipe?.enabled === 'boolean' ? rawRecipe.enabled : hasExistingRecipe;
  const dailyEnabled = typeof rawDaily?.enabled === 'boolean' ? rawDaily.enabled : true;

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
    daily: {
      enabled: dailyEnabled,
      folder: cleanDailyFolder(rawDaily?.folder, DEFAULT_DAILY_FOLDER),
      format: cleanDailyFormat(rawDaily?.format, DEFAULT_DAILY_FORMAT),
    },
    heatmap: {
      enabled: rawHeatmap?.enabled === true,
    },
    review: {
      enabled: optInFlag(obj.review),
    },
    favorites: {
      enabled: optInFlag(obj.favorites),
    },
    writingStats: {
      enabled: optOutFlag(obj.writingStats),
    },
    focus: {
      enabled: optOutFlag(obj.focus),
      dim: !!obj.focus && typeof obj.focus === 'object' && (obj.focus as Record<string, unknown>).dim === true,
    },
  };
}

const MONTHS_DE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const MONTHS_SHORT_DE = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS_DE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const DAYS_SHORT_DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const DAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS_SHORT_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function isoWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

/**
 * Formats a daily note path relative to the vault from folder + pattern.
 * Supported tokens: YYYY, YY, MMMM, MMM, MM, M, DD, D, dddd, ddd, WW, W, plus [literal] escapes.
 */
export function resolveDailyNote(
  daily: Pick<DailySettings, 'folder' | 'format'>,
  date = new Date(),
  lang: 'de' | 'en' = 'de'
): { path: string; folder: string; name: string } {
  const folderRoot = cleanDailyFolder(daily.folder, '');
  const rawFormat = cleanDailyFormat(daily.format, DEFAULT_DAILY_FORMAT);
  const hadMd = /\.md$/i.test(rawFormat);
  const stemPattern = hadMd ? rawFormat.slice(0, -3) : rawFormat;

  const year = date.getFullYear();
  const monthIdx = date.getMonth();
  const month = monthIdx + 1;
  const day = date.getDate();
  const weekday = date.getDay();
  const week = isoWeek(date);
  const pad = (n: number) => String(n).padStart(2, '0');

  const tokens: Record<string, string> = {
    YYYY: String(year),
    YY: String(year).slice(-2),
    MMMM: (lang === 'en' ? MONTHS_EN : MONTHS_DE)[monthIdx],
    MMM: (lang === 'en' ? MONTHS_SHORT_EN : MONTHS_SHORT_DE)[monthIdx],
    MM: pad(month),
    M: String(month),
    DD: pad(day),
    D: String(day),
    dddd: (lang === 'en' ? DAYS_EN : DAYS_DE)[weekday],
    ddd: (lang === 'en' ? DAYS_SHORT_EN : DAYS_SHORT_DE)[weekday],
    WW: pad(week),
    W: String(week),
  };

  const formattedStem = stemPattern.replace(
    /\[([^\]]*)\]|(YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|WW|W)/g,
    (full, literal: string | undefined, tok: string | undefined, offset: number, str: string) => {
      if (literal !== undefined) return literal;
      if (!tok) return full;
      const prev = offset > 0 ? str[offset - 1] : '';
      const next = offset + full.length < str.length ? str[offset + full.length] : '';
      const isNonTokenLetter = (ch: string) => !!ch && /\p{L}/u.test(ch) && !/[YMDdW]/.test(ch);
      if (isNonTokenLetter(prev) || isNonTokenLetter(next)) return full;
      return tokens[tok] ?? full;
    }
  );

  const fallbackName = `${year}-${pad(month)}-${pad(day)}`;
  const relParts = `${formattedStem}.md`
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p && p !== '.' && p !== '..');

  const rawFile = relParts.pop() ?? `${fallbackName}.md`;
  const cleanFileStem = rawFile.replace(/\.md$/i, '').trim() || fallbackName;
  const allParts = [...(folderRoot ? folderRoot.split('/') : []), ...relParts];
  if (allParts[0]?.toLowerCase() === '.kladde') allParts[0] = DEFAULT_DAILY_FOLDER;

  const fullPath = `${allParts.length ? `${allParts.join('/')}/` : ''}${cleanFileStem}.md`;
  const split = splitPath(fullPath);
  return { path: fullPath, folder: split.folder, name: split.name };
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

/** Single-file project sitting directly inside the projects root (`<projects>/<Name>.md`) */
export function isSingleProjectFile(path: string, config: RoleFolderMap = PARA): boolean {
  if (!config.projects) return false;
  return splitPath(path).folder === config.projects;
}

/** Folder-based project represented by `<projects>/<ProjectFolder>/Home.md` (strictly one level deep) */
export function isFolderProjectHome(path: string, config: RoleFolderMap = PARA): boolean {
  if (!config.projects) return false;
  const { folder, name } = splitPath(path);
  if (name.toLowerCase() !== PROJECT_HOME_NAME.toLowerCase()) return false;
  const prefix = `${config.projects}/`;
  return folder.startsWith(prefix) && !folder.slice(prefix.length).includes('/');
}

/** True only for true project notes (single file in projects root OR `Home.md` in a direct project subfolder) */
export function isProjectNote(path: string, config: RoleFolderMap = PARA): boolean {
  return isSingleProjectFile(path, config) || isFolderProjectHome(path, config);
}

/** Display title for any note, using the project folder name for `<projects>/<Folder>/Home.md` */
export function projectTitleOf(path: string, content: string, config: RoleFolderMap = PARA): string {
  const { data } = parseFrontmatter(content);
  if (data.title) return data.title;
  const { folder, name } = splitPath(path);
  if (isFolderProjectHome(path, config)) return folder.split('/').pop() || name;
  return name;
}

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
