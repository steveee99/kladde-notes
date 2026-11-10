import { extractMeta, splitPath } from './markdown.js';
import { LinkIndex, LinkNote } from './links.js';
import { PARA, RoleFolderMap, roleOfFolder } from './para.js';
import { bucketOf, parseTasks } from './tasks.js';

export interface ReviewNote extends LinkNote {
  updatedAt: number;
  createdAt: number;
}

export interface ProjectInfo {
  id: string;
  title: string;
  folder: string;
  status: string;
  openTasks: number;
  nextDue: string | null;
  updatedAt: number;
}

export interface Review {
  inbox: string[];
  overdueTasks: number;
  projects: ProjectInfo[];
  /** Active projects without an open task: what is the next step? */
  projectsWithoutNextStep: ProjectInfo[];
  /** Areas (top-level entries below configured areas folder) not touched for `staleDays` */
  staleAreas: { name: string; updatedAt: number }[];
  orphanZettel: string[];
  /** Fleeting notes older than a week: work them out or let them go */
  oldFleeting: string[];
}

const DAY = 86_400_000;

/** Project = a note directly in the projects folder or its subfolders */
export function projectsOf(notes: ReviewNote[], today = new Date(), config: RoleFolderMap = PARA): ProjectInfo[] {
  if (!config.projects) return [];
  return notes
    .filter((n) => roleOfFolder(splitPath(n.path).folder, config) === 'projects')
    .map((n) => {
      const meta = extractMeta(n.path, n.content);
      const open = parseTasks(n.content, today).filter((t) => !t.done);
      const due = open.map((t) => t.due).filter((d): d is string => !!d).sort();
      return {
        id: n.id,
        title: meta.title,
        folder: meta.folder,
        status: (meta.frontmatter.status ?? 'aktiv').toLowerCase(),
        openTasks: open.length,
        nextDue: due[0] ?? null,
        updatedAt: n.updatedAt,
      };
    })
    .filter((p) => p.status !== 'fertig');
}

export function buildReview(notes: ReviewNote[], now = Date.now(), staleDays = 30, config: RoleFolderMap = PARA): Review {
  const today = new Date(now);
  const index = new LinkIndex(notes);
  const projects = projectsOf(notes, today, config);
  const areas = new Map<string, number>();
  const areasRoot = config.areas;
  if (areasRoot) {
    for (const n of notes) {
      const folder = splitPath(n.path).folder;
      if (roleOfFolder(folder, config) !== 'areas') continue;
      const rest = folder === areasRoot ? splitPath(n.path).name : folder.slice(areasRoot.length + 1).split('/')[0];
      areas.set(rest, Math.max(areas.get(rest) ?? 0, n.updatedAt));
    }
  }
  let overdue = 0;
  for (const n of notes) for (const t of parseTasks(n.content, today)) if (!t.done && bucketOf(t, today) === 'overdue') overdue++;
  const zettel = config.zettel ? notes.filter((n) => roleOfFolder(splitPath(n.path).folder, config) === 'zettel') : [];
  return {
    inbox: notes.filter((n) => roleOfFolder(splitPath(n.path).folder, config) === 'inbox').map((n) => n.id),
    overdueTasks: overdue,
    projects,
    projectsWithoutNextStep: projects.filter((p) => p.status === 'aktiv' && p.openTasks === 0),
    staleAreas: [...areas].filter(([, at]) => at < now - staleDays * DAY).map(([name, updatedAt]) => ({ name, updatedAt })),
    orphanZettel: zettel.filter((n) => index.isOrphan(n.id)).map((n) => n.id),
    oldFleeting: zettel
      .filter((n) => (extractMeta(n.path, n.content).frontmatter.typ ?? '').toLowerCase() === 'flüchtig' && n.createdAt < now - 7 * DAY)
      .map((n) => n.id),
  };
}
