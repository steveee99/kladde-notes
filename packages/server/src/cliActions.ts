import { DatabaseSync } from 'node:sqlite';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  APP_VERSION,
  PushChange,
  SYSTEM_PREFIX,
  extractMeta,
  semanticSearch,
  splitPath,
  stripFrontmatter,
} from '@kladde/shared';
import { backupDatabase } from './db.js';
import { FileStore, MAX_FILE_BYTES } from './FileStore.js';
import { MAX_NOTE_BYTES, NoteStore, cleanPath } from './NoteStore.js';
import { UserRecord, UserStore } from './UserStore.js';
import type { AuditLog } from './security/AuditLog.js';

export class CliError extends Error {}

export interface CliDeps {
  db: DatabaseSync;
  users: UserStore;
  notes: NoteStore;
  files: FileStore;
  audit?: AuditLog;
  publicUrl?: string | null;
  defaultBackupDir?: string;
}

export interface CliResult {
  lines: string[];
  data?: unknown;
}

const NOTE_EXTS = new Set(['.md', '.markdown', '.txt']);
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
};

const SKIP_NAMES = new Set(['.git', '.obsidian', '.kladde', 'node_modules', '.DS_Store', 'Thumbs.db']);
const FILE_URL_RE = /\/api\/files\/([A-Za-z0-9_-]{22})/g;

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

const VALUE_FLAGS = new Set(['user', 'u', 'folder', 'f', 'limit', 'n']);

export function parseCliArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq >= 0) {
        flags.set(arg.slice(2, eq).toLowerCase(), arg.slice(eq + 1));
      } else {
        const key = arg.slice(2).toLowerCase();
        if (VALUE_FLAGS.has(key) && i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
          flags.set(key, argv[++i]);
        } else {
          flags.set(key, true);
        }
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      const short = arg.slice(1).toLowerCase();
      if (VALUE_FLAGS.has(short) && i + 1 < argv.length) {
        flags.set(short, argv[++i]);
      } else {
        flags.set(short, true);
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function getFlagString(flags: Map<string, string | boolean>, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = flags.get(n);
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function hasFlag(flags: Map<string, string | boolean>, ...names: string[]): boolean {
  return names.some((n) => flags.get(n) === true || typeof flags.get(n) === 'string');
}

function resolveUser(users: UserStore, flags: Map<string, string | boolean>): UserRecord {
  const name = getFlagString(flags, 'user', 'u');
  if (name) {
    const user = users.findByUsername(name);
    if (!user) throw new CliError(`Benutzer "${name}" nicht gefunden.`);
    return user;
  }
  const all = users.listUsers();
  if (all.length === 0) throw new CliError('Es gibt noch keine Benutzerkonten. Lege zuerst eins per Einladung an.');
  if (all.length === 1) return all[0];
  throw new CliError(`Mehrere Konten vorhanden (${all.map((u) => u.username).join(', ')}). Bitte --user <Name> angeben.`);
}

function cleanSpaceFolder(raw: string): string {
  const trimmed = raw.trim().replace(/\\/g, '/');
  if (!trimmed || trimmed === '/' || trimmed === '.') return '';
  const cleaned = cleanPath(trimmed);
  if (cleaned === SYSTEM_PREFIX.slice(0, -1) || cleaned.startsWith(SYSTEM_PREFIX)) {
    throw new CliError('Der Ordner ".kladde" ist für interne Einstellungen reserviert.');
  }
  return cleaned;
}

function cleanSpaceNotePath(raw: string): string {
  const cleaned = cleanPath(raw.trim().replace(/\\/g, '/'));
  if (cleaned.startsWith(SYSTEM_PREFIX)) {
    throw new CliError('Der Ordner ".kladde" ist für interne Einstellungen reserviert.');
  }
  return cleaned.toLowerCase().endsWith('.md') ? cleaned : `${cleaned}.md`;
}

function walkDirectory(rootDir: string): string[] {
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

function safeFileSegment(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').trim() || 'datei';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function findUniqueNotePath(existingPathsLower: Set<string>, desiredPath: string): string {
  if (!existingPathsLower.has(desiredPath.toLowerCase())) return desiredPath;
  const { folder, name } = splitPath(desiredPath);
  for (let n = 2; ; n++) {
    const candidate = `${folder ? `${folder}/` : ''}${name} ${n}.md`;
    if (!existingPathsLower.has(candidate.toLowerCase())) return candidate;
  }
}

export function attachmentUsageMap(notes: NoteStore, userId: string): Map<string, { id: string; path: string; title: string }[]> {
  const visibleNotes = notes.pull(userId, 0).notes.filter((n) => !n.deleted && !n.path.startsWith(SYSTEM_PREFIX));
  const map = new Map<string, { id: string; path: string; title: string }[]>();
  for (const n of visibleNotes) {
    const ids = new Set<string>();
    for (const m of n.content.matchAll(FILE_URL_RE)) ids.add(m[1]);
    if (!ids.size) continue;
    const title = extractMeta(n.path, n.content).title;
    for (const fid of ids) {
      let arr = map.get(fid);
      if (!arr) map.set(fid, (arr = []));
      arr.push({ id: n.id, path: n.path, title });
    }
  }
  return map;
}

export function cliHelpText(): string {
  return [
    'Kladde CLI – Befehle:',
    '',
    'Space Import & Export:',
    '  import <quelle> <ziel>     Datei oder Ordner rekursiv in den Space importieren',
    '                             Optionen: --user <name>, --overwrite | --rename | --skip (Standard), --dry-run',
    '  export <quelle> <ziel>     Space ("/"), Ordner oder einzelne Notiz nach <ziel> exportieren',
    '                             Optionen: --user <name>, --strip-frontmatter, --with-files, --skip',
    '',
    'Notizen & Anhänge:',
    '  notizen [ordner]           Notizen auflisten (--user, --limit <n>)',
    '  suche <suchbegriff>        Semantische Suche über alle Notizen (--user, --folder, --limit)',
    '  ordner                     Ordner mit Notizanzahl anzeigen (--user)',
    '  anhaenge                   Anhänge mit Verwendungsstatus auflisten (--user, --unused)',
    '  anhaenge-bereinigen        Ungenutzte Anhänge sicher löschen (--user, --dry-run)',
    '',
    'Server, Sicherung & Konten:',
    '  status                     Systemstatus (Version, Konten, Notizen, Freigaben, Anhänge)',
    '  backup <ziel>              Konsistentes SQLite-Backup (Datei oder Ordner)',
    '  einladen [Notiz]           Neuen Einladungscode erzeugen',
    '  einladungen                Alle Einladungscodes anzeigen',
    '  einladung-loeschen <Code>  Einladungscode entfernen',
    '  konten                     Alle Benutzerkonten auflisten',
    '  sperren <Benutzer>         Konto sperren & Sitzungen beenden',
    '  entsperren <Benutzer>      Konto entsperren',
    '  passwort <Benutzer>        Zufallspasswort setzen & Sitzungen beenden',
    '  admin <Benutzer> [an|aus]  Admin-Rolle vergeben oder entziehen',
    '  protokoll [Anzahl]         Letzte Audit-Log-Einträge anzeigen',
    '  hilfe                      Diese Hilfe anzeigen',
  ].join('\n');
}

export async function runCli(argv: string[], deps: CliDeps): Promise<CliResult> {
  const [rawCmd, ...rest] = argv;
  if (!rawCmd || rawCmd === 'hilfe' || rawCmd === 'help' || rawCmd === '--help' || rawCmd === '-h') {
    return { lines: [cliHelpText()] };
  }

  const cmd = rawCmd.toLowerCase();
  const { positionals, flags } = parseCliArgs(rest);
  if (hasFlag(flags, 'help', 'h')) return { lines: [cliHelpText()] };

  const publicBase = (deps.publicUrl ?? '').replace(/\/$/, '');

  switch (cmd) {
    case 'import':
      return runImport(positionals, flags, deps);

    case 'export':
      return runExport(positionals, flags, deps);

    case 'notizen': {
      const user = resolveUser(deps.users, flags);
      const folderArg = positionals[0] ?? getFlagString(flags, 'folder', 'f');
      const folder = folderArg ? cleanSpaceFolder(folderArg) : undefined;
      const limit = Math.max(1, Number(getFlagString(flags, 'limit', 'n') ?? 200) || 200);
      const all = deps.notes
        .ownedNotes(user.id)
        .filter((n) => !n.path.startsWith(SYSTEM_PREFIX) && (!folder || n.path.startsWith(`${folder}/`)))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const shown = all.slice(0, limit);
      const lines = shown.map((n) => `${n.path}  (${n.id}, v${n.version})`);
      lines.push(`Gesamt: ${all.length} Notizen${shown.length < all.length ? ` (${shown.length} angezeigt)` : ''}`);
      return { lines, data: { total: all.length, notes: shown.map((n) => ({ id: n.id, path: n.path, version: n.version })) } };
    }

    case 'suche': {
      const query = positionals.join(' ').trim();
      if (!query) throw new CliError('Verwendung: suche <Suchbegriff> [--user <Name>] [--folder <Ordner>]');
      const user = resolveUser(deps.users, flags);
      const folderArg = getFlagString(flags, 'folder', 'f');
      const folder = folderArg ? cleanSpaceFolder(folderArg) : undefined;
      const limit = Math.max(1, Math.min(50, Number(getFlagString(flags, 'limit', 'n') ?? 10) || 10));
      const all = deps.notes.ownedNotes(user.id).filter((n) => !n.path.startsWith(SYSTEM_PREFIX));
      const hits = semanticSearch(query, all, { folder, limit });
      const lines = hits.length
        ? hits.map((h) => `[${h.score.toFixed(2)}] ${h.note.path} (${h.reasons.join(', ')}) — ${h.snippet}`)
        : ['Keine passenden Notizen gefunden.'];
      return { lines, data: hits };
    }

    case 'ordner': {
      const user = resolveUser(deps.users, flags);
      const all = deps.notes.ownedNotes(user.id).filter((n) => !n.path.startsWith(SYSTEM_PREFIX));
      const counts = new Map<string, number>();
      for (const n of all) {
        const f = splitPath(n.path).folder || '(oberste Ebene)';
        counts.set(f, (counts.get(f) ?? 0) + 1);
      }
      const entries = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], 'de'));
      const lines = entries.length ? entries.map(([f, c]) => `${f}: ${c}`) : ['Keine Notizen im Space.'];
      return { lines, data: Object.fromEntries(entries) };
    }

    case 'anhaenge': {
      const user = resolveUser(deps.users, flags);
      const onlyUnused = hasFlag(flags, 'unused');
      const usage = attachmentUsageMap(deps.notes, user.id);
      const list = deps.files.listByOwner(user.id).map((f) => ({ ...f, usedIn: usage.get(f.id) ?? [] }));
      const filtered = onlyUnused ? list.filter((f) => f.usedIn.length === 0) : list;
      const lines = filtered.length
        ? filtered.map((f) => `${f.id}  ${f.name}  (${formatBytes(f.size)}, ${f.usedIn.length ? `verwendet in ${f.usedIn.length} Notiz(en)` : 'ungenutzt'})`)
        : [onlyUnused ? 'Keine ungenutzten Anhänge.' : 'Keine Anhänge vorhanden.'];
      return { lines, data: filtered };
    }

    case 'anhaenge-bereinigen': {
      const user = resolveUser(deps.users, flags);
      const dryRun = hasFlag(flags, 'dry-run');
      const usage = attachmentUsageMap(deps.notes, user.id);
      const all = deps.files.listByOwner(user.id);
      const unused = all.filter((f) => !(usage.get(f.id)?.length));
      const protectedCount = all.length - unused.length;
      const deleted: string[] = [];
      let freedBytes = 0;
      for (const f of unused) {
        if (!dryRun) {
          if (deps.files.delete(user.id, f.id)) {
            deleted.push(f.id);
            freedBytes += f.size;
          }
        } else {
          deleted.push(f.id);
          freedBytes += f.size;
        }
      }
      const verb = dryRun ? 'Würden gelöscht' : 'Gelöscht';
      return {
        lines: [`${verb}: ${deleted.length} ungenutzte(r) Anhang/Anhänge (${formatBytes(freedBytes)}). Geschützt (in Notizen verwendet): ${protectedCount}.`],
        data: { dryRun, deleted: unused.map((f) => ({ id: f.id, name: f.name, size: f.size })), protectedCount, freedBytes },
      };
    }

    case 'status': {
      const uCount = deps.users.countUsers();
      const { notes: nCount, shares: sCount } = deps.notes.counts();
      const fRow = deps.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM files').get() as { n: number; bytes: number };
      const lines = [
        `Kladde ${APP_VERSION}`,
        `Konten: ${uCount}`,
        `Notizen: ${nCount}`,
        `Freigaben: ${sCount}`,
        `Anhänge: ${fRow.n} (${formatBytes(Number(fRow.bytes))})`,
      ];
      return { lines, data: { version: APP_VERSION, users: uCount, notes: nCount, shares: sCount, files: fRow.n, fileBytes: Number(fRow.bytes) } };
    }

    case 'backup': {
      const targetArg = positionals[0] ?? deps.defaultBackupDir;
      if (!targetArg) throw new CliError('Bitte einen Zielpfad (Datei oder Ordner) für das Backup angeben.');
      const resolved = path.resolve(targetArg);
      let filePath: string;
      if (resolved.endsWith('.sqlite') || resolved.endsWith('.db')) {
        fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
        deps.db.exec(`VACUUM INTO '${resolved.replace(/'/g, "''")}'`);
        fs.chmodSync(resolved, 0o600);
        filePath = resolved;
      } else {
        filePath = backupDatabase(deps.db, resolved, 30);
      }
      return { lines: [`Backup erstellt: ${filePath}`], data: { path: filePath } };
    }

    case 'einladen': {
      const invite = deps.users.createInvite(positionals.join(' '));
      return { lines: [publicBase ? `${publicBase}/invite/${invite.code}` : invite.code], data: invite };
    }

    case 'einladungen': {
      const list = deps.users.listInvites();
      return {
        lines: list.length ? list.map((i) => `${i.code}  ${i.note}  ${i.usedBy ? `benutzt von ${i.usedBy}` : 'offen'}`) : ['Keine Einladungen.'],
        data: list,
      };
    }

    case 'einladung-loeschen':
    case 'einladung_loeschen': {
      const code = positionals[0];
      if (!code) throw new CliError('Bitte Einladungscode angeben.');
      const ok = deps.users.deleteInvite(code);
      if (!ok) throw new CliError(`Einladung "${code}" nicht gefunden.`);
      return { lines: ['Einladung gelöscht.'] };
    }

    case 'konten': {
      const list = deps.users.listUsers();
      return {
        lines: list.length
          ? list.map((u) => `${u.username}${u.isAdmin ? ' [Admin]' : ''}${u.bannedAt ? ' (gesperrt)' : ''}`)
          : ['Keine Konten vorhanden.'],
        data: list,
      };
    }

    case 'sperren':
    case 'entsperren': {
      const username = positionals[0];
      if (!username) throw new CliError('Bitte einen Benutzernamen angeben.');
      const u = deps.users.findByUsername(username);
      if (!u) throw new CliError(`Benutzer "${username}" nicht gefunden.`);
      const ban = cmd === 'sperren';
      deps.users.setBanned(u.id, ban);
      return { lines: [`${u.username} ${ban ? 'gesperrt' : 'entsperrt'}.`] };
    }

    case 'passwort': {
      const username = positionals[0];
      if (!username) throw new CliError('Bitte einen Benutzernamen angeben.');
      const u = deps.users.findByUsername(username);
      if (!u) throw new CliError(`Benutzer "${username}" nicht gefunden.`);
      const password = await deps.users.resetPassword(u.id);
      return { lines: [`Neues Passwort für ${u.username}: ${password}`], data: { username: u.username, password } };
    }

    case 'admin': {
      const username = positionals[0];
      if (!username) throw new CliError('Verwendung: admin <Benutzer> [an|aus]');
      const u = deps.users.findByUsername(username);
      if (!u) throw new CliError(`Benutzer "${username}" nicht gefunden.`);
      const on = (positionals[1] ?? 'an').toLowerCase() !== 'aus';
      deps.users.setAdmin(u.id, on);
      return { lines: [`${u.username} ist ${on ? 'jetzt Admin' : 'kein Admin mehr'}.`] };
    }

    case 'protokoll': {
      if (!deps.audit) return { lines: ['Kein Audit-Log verfügbar.'] };
      const limit = Math.max(1, Number(positionals[0] ?? 25) || 25);
      const entries = deps.audit.recent(limit);
      return {
        lines: entries.length
          ? entries.map((e) => `${new Date(e.at).toISOString()}  ${e.event}  ${e.username ?? '-'}  ${e.detail ?? ''}`.trim())
          : ['Protokoll ist leer.'],
        data: entries,
      };
    }

    default:
      throw new CliError(`Unbekannter Befehl "${rawCmd}". "hilfe" zeigt alle Befehle.`);
  }
}

// ------------------------------------------------------------------ import / export implementations

async function runImport(positionals: string[], flags: Map<string, string | boolean>, deps: CliDeps): Promise<CliResult> {
  const [srcArg, dstArg] = positionals;
  if (!srcArg || !dstArg) {
    throw new CliError('Verwendung: import <quelle> <ziel> [--user <Name>] [--overwrite|--rename|--skip] [--dry-run]');
  }

  const user = resolveUser(deps.users, flags);
  const srcPath = path.resolve(srcArg);
  if (!fs.existsSync(srcPath)) throw new CliError(`Quellpfad existiert nicht: ${srcArg}`);
  const stat = fs.lstatSync(srcPath);
  if (!stat.isFile() && !stat.isDirectory()) throw new CliError(`Quelle muss eine Datei oder ein Ordner sein: ${srcArg}`);

  const dryRun = hasFlag(flags, 'dry-run');
  const conflictMode: 'overwrite' | 'rename' | 'skip' = hasFlag(flags, 'overwrite')
    ? 'overwrite'
    : hasFlag(flags, 'rename')
      ? 'rename'
      : 'skip';

  const existingNotes = deps.notes.ownedNotes(user.id);
  const byLowerPath = new Map(existingNotes.map((n) => [n.path.toLowerCase(), n]));
  const usedPathsLower = new Set(byLowerPath.keys());

  let notesCreated = 0;
  let notesUpdated = 0;
  let notesSkipped = 0;
  let filesImported = 0;
  let ignored = 0;
  const importedPaths: string[] = [];
  const importedFilesByDisk = new Map<string, { id: string; url: string; name: string }>();
  const importedFilesByBase = new Map<string, { id: string; url: string; name: string }[]>();

  const registerDiskFile = (diskFile: string): { id: string; url: string; name: string } | null => {
    const real = fs.realpathSync(diskFile);
    const cached = importedFilesByDisk.get(real);
    if (cached) return cached;
    const ext = path.extname(diskFile).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) return null;
    const data = fs.readFileSync(diskFile);
    if (data.length > MAX_FILE_BYTES) {
      throw new CliError(`Anhang zu groß (> ${formatBytes(MAX_FILE_BYTES)}): ${diskFile}`);
    }
    const name = path.basename(diskFile);
    const id = dryRun ? `dryrun_${crypto.randomBytes(11).toString('base64url').slice(0, 15)}` : deps.files.save(user.id, name, mime, data).id;
    const info = { id, url: `/api/files/${id}`, name };
    importedFilesByDisk.set(real, info);
    const bKey = name.toLowerCase();
    const list = importedFilesByBase.get(bKey) ?? [];
    list.push(info);
    importedFilesByBase.set(bKey, list);
    filesImported++;
    return info;
  };

  const rewriteLinks = (mdFileDir: string, allowedRootDir: string, rawContent: string): string => {
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
        const info = registerDiskFile(disk);
        if (info) return `${bang}[${label}](${info.url})`;
      }
      const baseMatches = importedFilesByBase.get(path.basename(targetPart).toLowerCase());
      if (baseMatches?.length === 1) return `${bang}[${label}](${baseMatches[0].url})`;
      return full;
    });

    // Obsidian image embeds ![[filename]] or ![[filename|alt]]
    out = out.replace(/!\[\[([^\]|#\n]+)(?:\|([^\]\n]*))?\]\]/g, (full, target, alias) => {
      const disk = resolveLocal(target);
      if (disk) {
        const info = registerDiskFile(disk);
        if (info) return `![${(alias || info.name).trim()}](${info.url})`;
      }
      const baseMatches = importedFilesByBase.get(path.basename(target.trim()).toLowerCase());
      if (baseMatches?.length === 1) return `![${(alias || baseMatches[0].name).trim()}](${baseMatches[0].url})`;
      return full;
    });

    return out;
  };

  const pendingChanges: PushChange[] = [];
  const queuedByLowerPath = new Map<string, PushChange>();

  const queueNote = (desiredPath: string, content: string, mtimeMs: number) => {
    if (Buffer.byteLength(content) > MAX_NOTE_BYTES) {
      throw new CliError(`Notiz überschreitet 2 MB Grenze: ${desiredPath}`);
    }
    const lowerKey = desiredPath.toLowerCase();
    const existing = byLowerPath.get(lowerKey);
    const queued = queuedByLowerPath.get(lowerKey);
    const now = Date.now();
    const updatedAt = Math.min(mtimeMs || now, now);

    if (existing || queued) {
      if (conflictMode === 'skip') {
        notesSkipped++;
        return;
      }
      if (conflictMode === 'overwrite') {
        if (queued) {
          queued.content = content;
          queued.updatedAt = updatedAt;
          return;
        }
        pendingChanges.push({
          id: existing!.id,
          baseVersion: existing!.version,
          path: existing!.path,
          content,
          deleted: false,
          createdAt: existing!.createdAt,
          updatedAt,
        });
        notesUpdated++;
        importedPaths.push(existing!.path);
        return;
      }
      const renamed = findUniqueNotePath(usedPathsLower, desiredPath);
      usedPathsLower.add(renamed.toLowerCase());
      const id = crypto.randomBytes(16).toString('hex');
      const change: PushChange = { id, baseVersion: 0, path: renamed, content, deleted: false, createdAt: updatedAt, updatedAt };
      pendingChanges.push(change);
      queuedByLowerPath.set(renamed.toLowerCase(), change);
      notesCreated++;
      importedPaths.push(renamed);
      return;
    }

    usedPathsLower.add(lowerKey);
    const id = crypto.randomBytes(16).toString('hex');
    const change: PushChange = { id, baseVersion: 0, path: desiredPath, content, deleted: false, createdAt: updatedAt, updatedAt };
    pendingChanges.push(change);
    queuedByLowerPath.set(lowerKey, change);
    notesCreated++;
    importedPaths.push(desiredPath);
  };

  if (stat.isFile()) {
    const ext = path.extname(srcPath).toLowerCase();
    if (NOTE_EXTS.has(ext)) {
      const targetPath = dstArg.trim().toLowerCase().endsWith('.md')
        ? cleanSpaceNotePath(dstArg)
        : cleanSpaceNotePath((() => {
            const folder = cleanSpaceFolder(dstArg);
            const name = path.basename(srcPath, ext);
            return `${folder ? `${folder}/` : ''}${name}.md`;
          })());
      const raw = fs.readFileSync(srcPath, 'utf8');
      const content = rewriteLinks(path.dirname(srcPath), path.dirname(srcPath), raw);
      queueNote(targetPath, content, stat.mtimeMs);
    } else if (MIME_BY_EXT[ext]) {
      const info = registerDiskFile(srcPath)!;
      if (dstArg.trim().toLowerCase().endsWith('.md')) {
        const targetPath = cleanSpaceNotePath(dstArg);
        queueNote(targetPath, `![${info.name}](${info.url})\n`, stat.mtimeMs);
      }
      importedPaths.push(info.url);
    } else {
      ignored++;
      throw new CliError(`Dateityp nicht unterstützt: ${path.basename(srcPath)}`);
    }
  } else {
    const targetRoot = cleanSpaceFolder(dstArg);
    const allFiles = walkDirectory(srcPath);
    const attachmentFiles: string[] = [];
    const noteFiles: string[] = [];
    for (const f of allFiles) {
      const ext = path.extname(f).toLowerCase();
      if (MIME_BY_EXT[ext]) attachmentFiles.push(f);
      else if (NOTE_EXTS.has(ext)) noteFiles.push(f);
      else ignored++;
    }

    // 1) Import attachments first so all references resolve cleanly
    for (const f of attachmentFiles) registerDiskFile(f);

    // 2) Import Markdown/text notes preserving nested subfolders
    for (const f of noteFiles) {
      const ext = path.extname(f).toLowerCase();
      const rel = path.relative(srcPath, f).split(path.sep);
      const relDir = rel.slice(0, -1).map(safeFileSegment).filter(Boolean).join('/');
      const base = safeFileSegment(path.basename(f, ext));
      const fullFolder = [targetRoot, relDir].filter(Boolean).join('/');
      const desiredPath = cleanSpaceNotePath(`${fullFolder ? `${fullFolder}/` : ''}${base}.md`);
      const fStat = fs.statSync(f);
      const raw = fs.readFileSync(f, 'utf8');
      const content = rewriteLinks(path.dirname(f), srcPath, raw);
      queueNote(desiredPath, content, fStat.mtimeMs);
    }
  }

  if (!dryRun && pendingChanges.length > 0) {
    // Push in chunks matching Sync limit
    for (let i = 0; i < pendingChanges.length; i += 250) {
      const results = deps.notes.push(user.id, pendingChanges.slice(i, i + 250));
      const bad = results.find((r) => r.status !== 'ok');
      if (bad) throw new CliError(`Fehler beim Speichern von Notiz ${bad.id}: ${bad.status}`);
    }
  }

  const summary = {
    dryRun,
    user: user.username,
    notesCreated,
    notesUpdated,
    notesSkipped,
    filesImported,
    ignored,
    paths: importedPaths,
  };
  const prefix = dryRun ? '[Vorschau] ' : '';
  return {
    lines: [
      `${prefix}Import für "${user.username}" abgeschlossen: ${notesCreated} angelegt, ${notesUpdated} aktualisiert, ${notesSkipped} übersprungen, ${filesImported} Anhänge importiert${ignored ? `, ${ignored} ignoriert` : ''}.`,
    ],
    data: summary,
  };
}

function runExport(positionals: string[], flags: Map<string, string | boolean>, deps: CliDeps): Promise<CliResult> | CliResult {
  const [srcArg, dstArg] = positionals;
  if (!srcArg || !dstArg) {
    throw new CliError('Verwendung: export <quelle> <ziel> [--user <Name>] [--strip-frontmatter] [--with-files] [--skip]');
  }

  const user = resolveUser(deps.users, flags);
  const stripFm = hasFlag(flags, 'strip-frontmatter');
  const withFiles = hasFlag(flags, 'with-files');
  const skipExisting = hasFlag(flags, 'skip');

  const ownNotes = deps.notes.ownedNotes(user.id).filter((n) => !n.path.startsWith(SYSTEM_PREFIX));
  const srcTrim = srcArg.trim().replace(/\\/g, '/');

  type Selected = { relPath: string; content: string; noteId: string };
  let selected: Selected[] = [];
  let singleFileOutput = false;

  if (!srcTrim || srcTrim === '/' || srcTrim === '.' || srcTrim === '*') {
    selected = ownNotes.map((n) => ({ relPath: n.path, content: n.content, noteId: n.id }));
  } else {
    const cleaned = cleanSpaceFolder(srcTrim);
    const lower = cleaned.toLowerCase();
    const single = ownNotes.find((n) => n.path.toLowerCase() === lower || n.path.toLowerCase() === `${lower}.md`);
    if (single) {
      const baseName = `${splitPath(single.path).name}.md`;
      singleFileOutput = dstArg.trim().toLowerCase().endsWith('.md');
      selected = [{ relPath: singleFileOutput ? path.basename(dstArg) : baseName, content: single.content, noteId: single.id }];
    } else {
      const prefix = `${cleaned}/`;
      const prefixLower = prefix.toLowerCase();
      selected = ownNotes
        .filter((n) => n.path.toLowerCase().startsWith(prefixLower))
        .map((n) => ({ relPath: n.path.slice(prefix.length), content: n.content, noteId: n.id }));
      if (!selected.length) {
        throw new CliError(`Quelle "${srcArg}" im Space von "${user.username}" nicht gefunden.`);
      }
    }
  }

  const dstResolved = path.resolve(dstArg);
  const exportRoot = singleFileOutput ? path.dirname(dstResolved) : dstResolved;
  fs.mkdirSync(exportRoot, { recursive: true });
  const exportRootSep = exportRoot.endsWith(path.sep) ? exportRoot : `${exportRoot}${path.sep}`;

  let exportedNotes = 0;
  let skippedNotes = 0;
  let exportedFiles = 0;
  const savedAttachments = new Map<string, string>(); // fileId -> relPath from exportRoot (posix)

  const exportAttachment = (fileId: string): string | null => {
    const cached = savedAttachments.get(fileId);
    if (cached) return cached;
    const meta = deps.files.getMeta(user.id, fileId);
    if (!meta) return null;
    const loaded = deps.files.load(fileId);
    if (!loaded) return null;
    const attachDir = path.join(exportRoot, '_attachments');
    fs.mkdirSync(attachDir, { recursive: true });
    const outName = `${fileId}-${safeFileSegment(meta.name)}`;
    const dest = path.join(attachDir, outName);
    if (!skipExisting || !fs.existsSync(dest)) fs.writeFileSync(dest, loaded.data);
    const relFromRoot = `_attachments/${outName}`;
    savedAttachments.set(fileId, relFromRoot);
    exportedFiles++;
    return relFromRoot;
  };

  for (const item of selected) {
    const outFile = singleFileOutput ? dstResolved : path.resolve(exportRoot, ...item.relPath.split('/'));
    if (outFile !== dstResolved && !outFile.startsWith(exportRootSep)) {
      throw new CliError(`Ungültiger Zielpfad: ${outFile}`);
    }
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    if (skipExisting && fs.existsSync(outFile)) {
      skippedNotes++;
      continue;
    }

    let content = stripFm ? stripFrontmatter(item.content) : item.content;
    if (withFiles) {
      const noteRelDir = path.posix.dirname(singleFileOutput ? path.basename(outFile) : item.relPath.replace(/\\/g, '/'));
      content = content.replace(FILE_URL_RE, (full, fileId) => {
        const relAttach = exportAttachment(fileId);
        if (!relAttach) return full;
        const rel = noteRelDir === '.' ? `./${relAttach}` : path.posix.relative(noteRelDir, relAttach);
        return rel.startsWith('.') ? rel : `./${rel}`;
      });
    }

    fs.writeFileSync(outFile, content, 'utf8');
    exportedNotes++;
  }

  // When exporting the entire space with --with-files, also include unreferenced attachments owned by the user
  if (withFiles && (!srcTrim || srcTrim === '/' || srcTrim === '.' || srcTrim === '*')) {
    for (const f of deps.files.listByOwner(user.id)) exportAttachment(f.id);
  }

  return {
    lines: [
      `Export für "${user.username}" nach "${dstArg}" abgeschlossen: ${exportedNotes} Notizen${skippedNotes ? `, ${skippedNotes} übersprungen` : ''}${withFiles ? `, ${exportedFiles} Anhänge` : ''}.`,
    ],
    data: { user: user.username, destination: dstArg, exportedNotes, skippedNotes, exportedFiles },
  };
}
