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
import { MAX_NOTE_BYTES, NoteStore } from './NoteStore.js';
import { UserRecord, UserStore } from './UserStore.js';
import type { AuditLog } from './security/AuditLog.js';
import {
  CliError,
  MIME_BY_EXT,
  NOTE_EXTS,
  cleanSpaceFolder,
  cleanSpaceNotePath,
  notePathFor,
  rewriteLinks,
  safeFileSegment,
  walkDirectory,
} from './importScan.js';

export { CliError };

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

export const FILE_URL_RE = /\/api\/files\/([A-Za-z0-9_-]{22})/g;

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
    if (!user) throw new CliError(`User "${name}" not found.`);
    return user;
  }
  const all = users.listUsers();
  if (all.length === 0) throw new CliError('There are no user accounts yet. Create one with an invitation first.');
  if (all.length === 1) return all[0];
  throw new CliError(`Several accounts exist (${all.map((u) => u.username).join(', ')}). Please pass --user <name>.`);
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

/**
 * German command names from before 2.11.0, still accepted so existing scripts keep working.
 * They are no longer listed in the help.
 */
export const GERMAN_COMMAND_ALIASES: Readonly<Record<string, string>> = {
  hilfe: 'help',
  notizen: 'notes',
  suche: 'search',
  ordner: 'folders',
  anhaenge: 'attachments',
  'anhaenge-bereinigen': 'clean-attachments',
  einladen: 'invite',
  einladungen: 'invites',
  'einladung-loeschen': 'delete-invite',
  einladung_loeschen: 'delete-invite',
  konten: 'users',
  sperren: 'suspend',
  entsperren: 'unsuspend',
  passwort: 'reset-password',
  protokoll: 'audit-log',
};

/** The English command name for `raw` (lower-cased, German aliases resolved) */
export function canonicalCommand(raw: string): string {
  const cmd = raw.toLowerCase();
  return GERMAN_COMMAND_ALIASES[cmd] ?? cmd;
}

export function cliHelpText(): string {
  return [
    'Kladde CLI – commands:',
    '',
    'Space import & export:',
    '  import <source> <target>   Import a file or folder (recursively) into the space',
    '                             Options: --user <name>, --overwrite | --rename | --skip (default), --dry-run',
    '  export <source> <target>   Export the space ("/"), a folder or a single note to <target>',
    '                             Options: --user <name>, --strip-frontmatter, --with-files, --skip',
    '',
    'Notes & attachments:',
    '  notes [folder]             List notes (--user, --limit <n>)',
    '  search <query>             Semantic search across all notes (--user, --folder, --limit)',
    '  folders                    Show folders with their note count (--user)',
    '  attachments                List attachments and where they are used (--user, --unused)',
    '  clean-attachments          Safely delete unused attachments (--user, --dry-run)',
    '',
    'Server, backups & accounts:',
    '  status                     System status (version, accounts, notes, shares, attachments)',
    '  backup <target>            Consistent SQLite backup (file or folder)',
    '  invite [note]              Create a new invitation code',
    '  invites                    List all invitation codes',
    '  delete-invite <code>       Remove an invitation code',
    '  users                      List all user accounts',
    '  suspend <user>             Suspend an account and end its sessions',
    '  unsuspend <user>           Lift the suspension',
    '  reset-password <user>      Set a random password and end the sessions',
    '  admin <user> [on|off]      Grant or revoke the admin role',
    '  audit-log [count]          Show the latest audit log entries',
    '  help                       Show this help',
    '',
    'The German command names from earlier versions (hilfe, notizen, einladen, …) still work.',
  ].join('\n');
}

export async function runCli(argv: string[], deps: CliDeps): Promise<CliResult> {
  const [rawCmd, ...rest] = argv;
  const cmd = rawCmd ? canonicalCommand(rawCmd) : 'help';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    return { lines: [cliHelpText()] };
  }

  const { positionals, flags } = parseCliArgs(rest);
  if (hasFlag(flags, 'help', 'h')) return { lines: [cliHelpText()] };

  const publicBase = (deps.publicUrl ?? '').replace(/\/$/, '');

  switch (cmd) {
    case 'import':
      return runImport(positionals, flags, deps);

    case 'export':
      return runExport(positionals, flags, deps);

    case 'notes': {
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
      lines.push(`Total: ${all.length} notes${shown.length < all.length ? ` (${shown.length} shown)` : ''}`);
      return { lines, data: { total: all.length, notes: shown.map((n) => ({ id: n.id, path: n.path, version: n.version })) } };
    }

    case 'search': {
      const query = positionals.join(' ').trim();
      if (!query) throw new CliError('Usage: search <query> [--user <name>] [--folder <folder>]');
      const user = resolveUser(deps.users, flags);
      const folderArg = getFlagString(flags, 'folder', 'f');
      const folder = folderArg ? cleanSpaceFolder(folderArg) : undefined;
      const limit = Math.max(1, Math.min(50, Number(getFlagString(flags, 'limit', 'n') ?? 10) || 10));
      const all = deps.notes.ownedNotes(user.id).filter((n) => !n.path.startsWith(SYSTEM_PREFIX));
      const hits = semanticSearch(query, all, { folder, limit, corpusKey: user.id });
      const lines = hits.length
        ? hits.map((h) => `[${h.score.toFixed(2)}] ${h.note.path} (${h.reasons.join(', ')}) — ${h.snippet}`)
        : ['No matching notes found.'];
      return { lines, data: hits };
    }

    case 'folders': {
      const user = resolveUser(deps.users, flags);
      const all = deps.notes.ownedNotes(user.id).filter((n) => !n.path.startsWith(SYSTEM_PREFIX));
      const counts = new Map<string, number>();
      for (const n of all) {
        const f = splitPath(n.path).folder || '(top level)';
        counts.set(f, (counts.get(f) ?? 0) + 1);
      }
      const entries = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const lines = entries.length ? entries.map(([f, c]) => `${f}: ${c}`) : ['No notes in the space.'];
      return { lines, data: Object.fromEntries(entries) };
    }

    case 'attachments': {
      const user = resolveUser(deps.users, flags);
      const onlyUnused = hasFlag(flags, 'unused');
      const usage = attachmentUsageMap(deps.notes, user.id);
      const list = deps.files.listByOwner(user.id).map((f) => ({ ...f, usedIn: usage.get(f.id) ?? [] }));
      const filtered = onlyUnused ? list.filter((f) => f.usedIn.length === 0) : list;
      const lines = filtered.length
        ? filtered.map((f) => `${f.id}  ${f.name}  (${formatBytes(f.size)}, ${f.usedIn.length ? `used in ${f.usedIn.length} note(s)` : 'unused'})`)
        : [onlyUnused ? 'No unused attachments.' : 'No attachments.'];
      return { lines, data: filtered };
    }

    case 'clean-attachments': {
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
      const verb = dryRun ? 'Would delete' : 'Deleted';
      return {
        lines: [`${verb}: ${deleted.length} unused attachment(s) (${formatBytes(freedBytes)}). Kept (used in notes): ${protectedCount}.`],
        data: { dryRun, deleted: unused.map((f) => ({ id: f.id, name: f.name, size: f.size })), protectedCount, freedBytes },
      };
    }

    case 'status': {
      const uCount = deps.users.countUsers();
      const { notes: nCount, shares: sCount } = deps.notes.counts();
      const fRow = deps.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM files').get() as { n: number; bytes: number };
      const lines = [
        `Kladde ${APP_VERSION}`,
        `Accounts: ${uCount}`,
        `Notes: ${nCount}`,
        `Shares: ${sCount}`,
        `Attachments: ${fRow.n} (${formatBytes(Number(fRow.bytes))})`,
      ];
      return { lines, data: { version: APP_VERSION, users: uCount, notes: nCount, shares: sCount, files: fRow.n, fileBytes: Number(fRow.bytes) } };
    }

    case 'backup': {
      const targetArg = positionals[0] ?? deps.defaultBackupDir;
      if (!targetArg) throw new CliError('Please give a target path (file or folder) for the backup.');
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
      return { lines: [`Backup created: ${filePath}`], data: { path: filePath } };
    }

    case 'invite': {
      const invite = deps.users.createInvite(positionals.join(' '));
      return { lines: [publicBase ? `${publicBase}/invite/${invite.code}` : invite.code], data: invite };
    }

    case 'invites': {
      const list = deps.users.listInvites();
      return {
        lines: list.length ? list.map((i) => `${i.code}  ${i.note}  ${i.usedBy ? `used by ${i.usedBy}` : 'open'}`) : ['No invitations.'],
        data: list,
      };
    }

    case 'delete-invite': {
      const code = positionals[0];
      if (!code) throw new CliError('Please give an invitation code.');
      const ok = deps.users.deleteInvite(code);
      if (!ok) throw new CliError(`Invitation "${code}" not found.`);
      return { lines: ['Invitation deleted.'] };
    }

    case 'users': {
      const list = deps.users.listUsers();
      return {
        lines: list.length
          ? list.map((u) => `${u.username}${u.isAdmin ? ' [Admin]' : ''}${u.bannedAt ? ' (suspended)' : ''}`)
          : ['No accounts.'],
        data: list,
      };
    }

    case 'suspend':
    case 'unsuspend': {
      const username = positionals[0];
      if (!username) throw new CliError('Bitte einen Benutzernamen angeben.');
      const u = deps.users.findByUsername(username);
      if (!u) throw new CliError(`Benutzer "${username}" nicht gefunden.`);
      const ban = cmd === 'suspend';
      deps.users.setBanned(u.id, ban);
      return { lines: [`${u.username} ${ban ? 'suspended' : 'unsuspended'}.`] };
    }

    case 'reset-password': {
      const username = positionals[0];
      if (!username) throw new CliError('Bitte einen Benutzernamen angeben.');
      const u = deps.users.findByUsername(username);
      if (!u) throw new CliError(`Benutzer "${username}" nicht gefunden.`);
      const password = await deps.users.resetPassword(u.id);
      return { lines: [`New password for ${u.username}: ${password}`], data: { username: u.username, password } };
    }

    case 'admin': {
      const username = positionals[0];
      if (!username) throw new CliError('Usage: admin <user> [on|off]');
      const u = deps.users.findByUsername(username);
      if (!u) throw new CliError(`Benutzer "${username}" nicht gefunden.`);
      const on = !['off', 'aus'].includes((positionals[1] ?? 'on').toLowerCase());
      deps.users.setAdmin(u.id, on);
      return { lines: [`${u.username} ${on ? 'is now an admin' : 'is no longer an admin'}.`] };
    }

    case 'audit-log': {
      if (!deps.audit) return { lines: ['No audit log available.'] };
      const limit = Math.max(1, Number(positionals[0] ?? 25) || 25);
      const entries = deps.audit.recent(limit);
      return {
        lines: entries.length
          ? entries.map((e) => `${new Date(e.at).toISOString()}  ${e.event}  ${e.username ?? '-'}  ${e.detail ?? ''}`.trim())
          : ['The audit log is empty.'],
        data: entries,
      };
    }

    default:
      throw new CliError(`Unknown command "${rawCmd}". "help" lists all commands.`);
  }
}

// ------------------------------------------------------------------ import / export implementations

async function runImport(positionals: string[], flags: Map<string, string | boolean>, deps: CliDeps): Promise<CliResult> {
  const [srcArg, dstArg] = positionals;
  if (!srcArg || !dstArg) {
    throw new CliError('Usage: import <source> <target> [--user <name>] [--overwrite|--rename|--skip] [--dry-run]');
  }

  const user = resolveUser(deps.users, flags);
  const srcPath = path.resolve(srcArg);
  if (!fs.existsSync(srcPath)) throw new CliError(`Source path does not exist: ${srcArg}`);
  const stat = fs.lstatSync(srcPath);
  if (!stat.isFile() && !stat.isDirectory()) throw new CliError(`Source must be a file or a folder: ${srcArg}`);

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
      throw new CliError(`Attachment too large (> ${formatBytes(MAX_FILE_BYTES)}): ${diskFile}`);
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

  const lookup = {
    file: registerDiskFile,
    byBase: (baseLower: string) => importedFilesByBase.get(baseLower),
  };

  const pendingChanges: PushChange[] = [];
  const queuedByLowerPath = new Map<string, PushChange>();

  const queueNote = (desiredPath: string, content: string, mtimeMs: number) => {
    if (Buffer.byteLength(content) > MAX_NOTE_BYTES) {
      throw new CliError(`Note exceeds the 2 MB limit: ${desiredPath}`);
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
      const content = rewriteLinks(path.dirname(srcPath), path.dirname(srcPath), raw, lookup);
      queueNote(targetPath, content, stat.mtimeMs);
    } else if (MIME_BY_EXT[ext]) {
      const info = registerDiskFile(srcPath)!;
      if (dstArg.trim().toLowerCase().endsWith('.md')) {
        const targetPath = cleanSpaceNotePath(dstArg);
        queueNote(targetPath, `![${info.name}](${info.url})\n`, stat.mtimeMs);
      }
      importedPaths.push(info.url);
    } else {
      throw new CliError(`File type not supported: ${path.basename(srcPath)}`);
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
      const desiredPath = notePathFor(srcPath, f, targetRoot);
      const fStat = fs.statSync(f);
      const raw = fs.readFileSync(f, 'utf8');
      const content = rewriteLinks(path.dirname(f), srcPath, raw, lookup);
      queueNote(desiredPath, content, fStat.mtimeMs);
    }
  }

  if (!dryRun && pendingChanges.length > 0) {
    // Push in chunks matching Sync limit
    for (let i = 0; i < pendingChanges.length; i += 250) {
      const results = deps.notes.push(user.id, pendingChanges.slice(i, i + 250));
      const bad = results.find((r) => r.status !== 'ok');
      if (bad) throw new CliError(`Could not save note ${bad.id}: ${bad.status}`);
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
  const prefix = dryRun ? '[Preview] ' : '';
  return {
    lines: [
      `${prefix}Import for "${user.username}" finished: ${notesCreated} created, ${notesUpdated} updated, ${notesSkipped} skipped, ${filesImported} attachments imported${ignored ? `, ${ignored} ignored` : ''}.`,
    ],
    data: summary,
  };
}

function runExport(positionals: string[], flags: Map<string, string | boolean>, deps: CliDeps): Promise<CliResult> | CliResult {
  const [srcArg, dstArg] = positionals;
  if (!srcArg || !dstArg) {
    throw new CliError('Usage: export <source> <target> [--user <name>] [--strip-frontmatter] [--with-files] [--skip]');
  }

  const user = resolveUser(deps.users, flags);
  const stripFm = hasFlag(flags, 'strip-frontmatter');
  const withFiles = hasFlag(flags, 'with-files');
  const skipExisting = hasFlag(flags, 'skip');

  const ownNotes = deps.notes.ownedNotes(user.id).filter((n) => !n.path.startsWith(SYSTEM_PREFIX));
  const srcTrim = srcArg.trim().replace(/\\/g, '/');

  type Selected = { relPath: string; content: string; noteId: string };
  let selected: Selected[];
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
        throw new CliError(`Source "${srcArg}" not found in the space of "${user.username}".`);
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
      throw new CliError(`Invalid target path: ${outFile}`);
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
      `Export for "${user.username}" to "${dstArg}" finished: ${exportedNotes} notes${skippedNotes ? `, ${skippedNotes} skipped` : ''}${withFiles ? `, ${exportedFiles} attachments` : ''}.`,
    ],
    data: { user: user.username, destination: dstArg, exportedNotes, skippedNotes, exportedFiles },
  };
}
