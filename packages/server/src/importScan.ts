// Database-free helpers shared by the server import (`cli.ts import`) and the import CLI (`importCli.ts`)
import fs from 'fs';
import path from 'path';
import { SYSTEM_PREFIX, cleanPath } from '@kladde/shared';

export class CliError extends Error {}

export const NOTE_EXTS = new Set(['.md', '.markdown', '.txt']);
export const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
};

export const SKIP_NAMES = new Set(['.git', '.obsidian', '.kladde', 'node_modules', '.DS_Store', 'Thumbs.db']);

export function cleanSpaceFolder(raw: string): string {
  const trimmed = raw.trim().replace(/\\/g, '/');
  if (!trimmed || trimmed === '/' || trimmed === '.') return '';
  const cleaned = cleanPath(trimmed);
  if (cleaned === SYSTEM_PREFIX.slice(0, -1) || cleaned.startsWith(SYSTEM_PREFIX)) {
    throw new CliError('Der Ordner ".kladde" ist für interne Einstellungen reserviert.');
  }
  return cleaned;
}

export function cleanSpaceNotePath(raw: string): string {
  const cleaned = cleanPath(raw.trim().replace(/\\/g, '/'));
  if (cleaned.startsWith(SYSTEM_PREFIX)) {
    throw new CliError('Der Ordner ".kladde" ist für interne Einstellungen reserviert.');
  }
  return cleaned.toLowerCase().endsWith('.md') ? cleaned : `${cleaned}.md`;
}

/** All files below rootDir, sorted; hidden entries, SKIP_NAMES and symlinks are left out */
export function walkDirectory(rootDir: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      if (SKIP_NAMES.has(entry.name) || entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  visit(rootDir);
  return out;
}

export function safeFileSegment(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').trim() || 'datei';
}

/** The note path a local note file gets: target folder, its subfolders below srcRoot, then `<base>.md` */
export function notePathFor(srcRoot: string, file: string, targetRoot: string): string {
  const ext = path.extname(file).toLowerCase();
  const rel = path.relative(srcRoot, file).split(path.sep);
  const relDir = rel.slice(0, -1).map(safeFileSegment).filter(Boolean).join('/');
  const base = safeFileSegment(path.basename(file, ext));
  const fullFolder = [targetRoot, relDir].filter(Boolean).join('/');
  return cleanSpaceNotePath(`${fullFolder ? `${fullFolder}/` : ''}${base}.md`);
}

export interface AttachmentRef {
  url: string;
  name: string;
}

/** Where rewriteLinks gets attachment URLs from */
export interface AttachmentLookup {
  /** A local attachment file (absolute path) a link points to; null leaves the link unchanged */
  file(diskPath: string): AttachmentRef | null;
  /** Fallback by file name (lower case): a link is rewritten only when exactly one attachment matches */
  byBase(baseLower: string): AttachmentRef[] | undefined;
}

/**
 * Points Markdown links/images `[..](..)` and Obsidian embeds `![[file|alt]]` to local attachments
 * at their uploaded URLs. Targets must stay inside allowedRootDir.
 */
export function rewriteLinks(mdFileDir: string, allowedRootDir: string, rawContent: string, lookup: AttachmentLookup): string {
  const resolveLocal = (rawRef: string): string | null => {
    const cleaned = rawRef.split('#')[0].split('?')[0].trim();
    if (!cleaned || /^[a-z]+:/i.test(cleaned) || cleaned.startsWith('/api/files/')) return null;
    let decoded = cleaned;
    try {
      decoded = decodeURIComponent(cleaned);
    } catch {
      // keep original
    }
    const candidate = path.resolve(mdFileDir, decoded);
    const rootWithSep = allowedRootDir.endsWith(path.sep) ? allowedRootDir : `${allowedRootDir}${path.sep}`;
    if (candidate !== allowedRootDir && !candidate.startsWith(rootWithSep)) return null;
    if (fs.existsSync(candidate) && fs.lstatSync(candidate).isFile() && MIME_BY_EXT[path.extname(candidate).toLowerCase()]) {
      return candidate;
    }
    return null;
  };

  // Standard Markdown links & images ![alt](target) / [label](target)
  let out = rawContent.replace(/(!?)\[([^\]]*)\]\(([^)\n]+)\)/g, (full, bang, label, target) => {
    const targetPart = target.trim();
    const disk = resolveLocal(targetPart);
    if (disk) {
      const info = lookup.file(disk);
      if (info) return `${bang}[${label}](${info.url})`;
    }
    const baseMatches = lookup.byBase(path.basename(targetPart).toLowerCase());
    if (baseMatches?.length === 1) return `${bang}[${label}](${baseMatches[0].url})`;
    return full;
  });

  // Obsidian image embeds ![[filename]] or ![[filename|alt]]
  out = out.replace(/!\[\[([^\]|#\n]+)(?:\|([^\]\n]*))?\]\]/g, (full, target, alias) => {
    const disk = resolveLocal(target);
    if (disk) {
      const info = lookup.file(disk);
      if (info) return `![${(alias || info.name).trim()}](${info.url})`;
    }
    const baseMatches = lookup.byBase(path.basename(target.trim()).toLowerCase());
    if (baseMatches?.length === 1) return `![${(alias || baseMatches[0].name).trim()}](${baseMatches[0].url})`;
    return full;
  });

  return out;
}
