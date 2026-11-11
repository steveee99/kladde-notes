// Kladde Import-CLI: importiert einen lokalen Ordner (z. B. einen Obsidian-Vault) über die Import-API eines Servers
// Beispiel: `KLADDE_IMPORT_TOKEN=kli_… npm run import -- ~/Vault Import --url https://kladde.example.org`
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { pathToFileURL } from 'url';
import { parseArgs } from 'util';
import { MAX_FILE_BYTES, MAX_NOTE_BYTES } from '@kladde/shared';
import {
  AttachmentLookup,
  AttachmentRef,
  CliError,
  MIME_BY_EXT,
  NOTE_EXTS,
  cleanSpaceFolder,
  notePathFor,
  rewriteLinks,
  walkDirectory,
} from './importScan.js';

/** Notes per POST /api/import/notes (the server's limit) */
const BATCH_SIZE = 100;
/** Bytes of JSON per POST /api/import/notes, below the server's body limit */
const BATCH_MAX_BYTES = 20 * 1024 * 1024;
const MAX_RETRIES = 3;

export const TOKEN_ENV = 'KLADDE_IMPORT_TOKEN';
const MSG_UNAUTHORIZED = 'Import-Token ungültig oder widerrufen';

export interface ScannedFile {
  /** Absolute path */
  file: string;
  /** Path below the source folder, with "/" */
  rel: string;
  size: number;
  mtimeMs: number;
}

export interface ScannedNote extends ScannedFile {
  targetPath: string;
}

export interface ScannedAttachment extends ScannedFile {
  mime: string;
  name: string;
}

export interface Scan {
  root: string;
  targetRoot: string;
  notes: ScannedNote[];
  attachments: ScannedAttachment[];
  /** Files of other types */
  others: ScannedFile[];
}

export interface PlanEntry {
  rel: string;
  /** Note path in Kladde (notes only) */
  targetPath?: string;
  reason?: string;
}

export interface Plan {
  scan: Scan;
  newNotes: ScannedNote[];
  skippedNotes: ScannedNote[];
  newAttachments: ScannedAttachment[];
  ignored: PlanEntry[];
  errors: PlanEntry[];
}

/** Where the CLI talks to: the server, the token and where its output goes */
export interface ImportContext {
  baseUrl: string;
  token: string;
  fetch: typeof fetch;
  out: (line: string) => void;
  /** Wait before retrying after HTTP 429 */
  sleep?: (ms: number) => Promise<void>;
  retryDelayMs?: number;
}

export interface ImportSummary {
  created: number;
  skipped: number;
  uploaded: number;
  ignored: number;
  errors: string[];
}

const toPosix = (p: string) => p.split(path.sep).join('/');
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function helpText(): string {
  return [
    'Kladde Import – lokalen Ordner (z. B. Obsidian-Vault) in deinen Space importieren',
    '',
    'Verwendung:',
    '  npm run import -- <ordner> [<zielordner>] --url <Kladde-URL> [--dry-run] [--yes]',
    '',
    'Argumente:',
    '  <ordner>          Lokaler Ordner, wird rekursiv gelesen (versteckte Ordner wie .obsidian werden ignoriert)',
    '  <zielordner>      Ordner im Space, Standard: oberste Ebene',
    '',
    'Optionen:',
    '  --url <url>       Adresse deiner Kladde, z. B. https://kladde.example.org',
    '  --dry-run         Nur die Vorschau zeigen, nichts importieren',
    '  --yes, -y         Ohne Rückfrage importieren',
    '  --help, -h        Diese Hilfe anzeigen',
    '',
    'Token:',
    `  Das Import-Token (Einstellungen → Import) wird aus der Umgebungsvariable ${TOKEN_ENV} gelesen.`,
    '  Fehlt sie, fragt die CLI im Terminal verdeckt danach. Es wird nie gespeichert oder ausgegeben.',
    '',
    'Importiert werden .md, .markdown und .txt als Notizen sowie Bilder und PDFs, die eine neue Notiz verlinkt.',
    'Vorhandene Pfade werden übersprungen, nie überschrieben.',
  ].join('\n');
}

/** http(s) URL without trailing slash */
export function parseBaseUrl(raw: string | undefined): string {
  if (!raw) throw new CliError('Bitte die Adresse deiner Kladde mit --url angeben, z. B. --url https://kladde.example.org');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError(`Ungültige --url "${raw}": erwartet wird eine http- oder https-Adresse.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliError(`Ungültige --url "${raw}": erwartet wird eine http- oder https-Adresse.`);
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/** Reads the source folder: notes, attachment candidates and everything else */
export function scanFolder(srcDir: string, targetRoot: string): Scan {
  const resolved = path.resolve(srcDir);
  if (!fs.existsSync(resolved)) throw new CliError(`Ordner nicht gefunden: ${srcDir}`);
  if (!fs.statSync(resolved).isDirectory()) throw new CliError(`Kein Ordner: ${srcDir}`);
  const root = fs.realpathSync(resolved);
  const scan: Scan = { root, targetRoot, notes: [], attachments: [], others: [] };
  for (const file of walkDirectory(root)) {
    const stat = fs.statSync(file);
    const base = { file, rel: toPosix(path.relative(root, file)), size: stat.size, mtimeMs: stat.mtimeMs };
    const ext = path.extname(file).toLowerCase();
    if (NOTE_EXTS.has(ext)) scan.notes.push({ ...base, targetPath: notePathFor(root, file, targetRoot) });
    else if (MIME_BY_EXT[ext]) scan.attachments.push({ ...base, mime: MIME_BY_EXT[ext], name: path.basename(file) });
    else scan.others.push(base);
  }
  return scan;
}

const attachmentsByBase = (attachments: ScannedAttachment[]) => {
  const map = new Map<string, ScannedAttachment[]>();
  for (const a of attachments) {
    const key = a.name.toLowerCase();
    map.set(key, [...(map.get(key) ?? []), a]);
  }
  return map;
};

/** Decides what is new, skipped, ignored or too large, given the note paths that already exist */
export function buildPlan(scan: Scan, existingPaths: string[]): Plan {
  const plan: Plan = { scan, newNotes: [], skippedNotes: [], newAttachments: [], ignored: [], errors: [] };
  const taken = new Set(existingPaths.map((p) => p.toLowerCase()));
  for (const note of scan.notes) {
    const key = note.targetPath.toLowerCase();
    if (taken.has(key)) {
      plan.skippedNotes.push(note);
      continue;
    }
    taken.add(key);
    if (note.size > MAX_NOTE_BYTES) plan.errors.push({ rel: note.rel, targetPath: note.targetPath, reason: 'Notiz größer als 2 MB' });
    else plan.newNotes.push(note);
  }

  // An attachment counts only if a new note links to it, resolved exactly like the rewrite at import time
  const byFile = new Map(scan.attachments.map((a) => [a.file, a]));
  const byBase = attachmentsByBase(scan.attachments);
  const linked = new Set<ScannedAttachment>();
  const lookup: AttachmentLookup = {
    file: (disk) => {
      const hit = byFile.get(disk);
      if (!hit) return null;
      linked.add(hit);
      return { url: hit.rel, name: hit.name };
    },
    byBase: (baseLower) => {
      const hits = byBase.get(baseLower);
      if (hits?.length === 1) linked.add(hits[0]);
      return hits?.map((h) => ({ url: h.rel, name: h.name }));
    },
  };
  for (const note of plan.newNotes) {
    rewriteLinks(path.dirname(note.file), scan.root, fs.readFileSync(note.file, 'utf8'), lookup);
  }

  for (const a of scan.attachments) {
    if (!linked.has(a)) plan.ignored.push({ rel: a.rel, reason: 'nicht verlinkt' });
    else if (a.size > MAX_FILE_BYTES) plan.errors.push({ rel: a.rel, reason: 'Datei größer als 25 MB' });
    else plan.newAttachments.push(a);
  }
  for (const o of scan.others) plan.ignored.push({ rel: o.rel, reason: 'Dateityp nicht unterstützt' });
  return plan;
}

/** The preview in the style of `git status` */
export function renderPreview(plan: Plan, baseUrl: string): string[] {
  const lines = [`Import nach ${baseUrl}`, `Zielordner: ${plan.scan.targetRoot ? `${plan.scan.targetRoot}/` : '(oberste Ebene)'}`, ''];
  const group = (title: string, word: string, entries: string[]) => {
    if (!entries.length) return;
    lines.push(`${title} (${entries.length}):`);
    for (const e of entries) lines.push(`  ${word.padEnd(13)}${e}`);
    lines.push('');
  };
  const notePair = (n: { rel: string; targetPath?: string }) => (n.targetPath && n.targetPath !== n.rel ? `${n.rel} → ${n.targetPath}` : n.rel);
  group('Neue Notizen', 'neu', plan.newNotes.map(notePair));
  group('Neue Anhänge', 'neu', plan.newAttachments.map((a) => a.rel));
  group('Übersprungen (Pfad vorhanden)', 'übersprungen', plan.skippedNotes.map(notePair));
  group('Ignoriert', 'ignoriert', plan.ignored.map((e) => `${e.rel} (${e.reason})`));
  group('Fehler (wird nicht gesendet)', 'fehler', plan.errors.map((e) => `${e.rel} (${e.reason})`));
  lines.push(
    `${plural(plan.newNotes.length, 'neue Notiz', 'neue Notizen')}, ${plural(plan.newAttachments.length, 'neuer Anhang', 'neue Anhänge')}, ` +
      `${plan.skippedNotes.length} übersprungen, ${plan.ignored.length} ignoriert, ${plural(plan.errors.length, 'Fehler', 'Fehler')}`
  );
  return lines;
}

/** One request to the import API; retries on HTTP 429. Network errors become CliErrors */
async function request(ctx: ImportContext, pathname: string, init: RequestInit = {}): Promise<Response> {
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await ctx.fetch(`${ctx.baseUrl}${pathname}`, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${ctx.token}` } });
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new CliError(`Kladde unter ${ctx.baseUrl} nicht erreichbar (${cause?.code ?? cause?.message ?? (err as Error).message}).`);
    }
    if (res.status !== 429 || attempt >= MAX_RETRIES) return res;
    const wait = (ctx.retryDelayMs ?? 15_000) * (attempt + 1);
    ctx.out(`Zu viele Anfragen – warte ${Math.round(wait / 1000)} s …`);
    await sleep(wait);
  }
}

async function errorOf(res: Response): Promise<string> {
  if (res.status === 401) return MSG_UNAUTHORIZED;
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ? `${body.error} (HTTP ${res.status})` : `HTTP ${res.status}`;
}

/** The paths of the token owner's notes; fails before anything is written if the server or token is wrong */
export async function fetchExistingPaths(ctx: ImportContext): Promise<string[]> {
  const res = await request(ctx, '/api/import/notes');
  if (res.status === 401) throw new CliError(MSG_UNAUTHORIZED);
  const body = (await res.json().catch(() => null)) as { paths?: unknown } | null;
  if (!res.ok || !Array.isArray(body?.paths)) {
    throw new CliError(`Kladde unter ${ctx.baseUrl} nicht erreichbar: keine gültige Antwort der Import-API (HTTP ${res.status}).`);
  }
  return body.paths.filter((p): p is string => typeof p === 'string');
}

/** Uploads the linked attachments, then creates the new notes in batches; single failures are reported and skipped */
export async function runImport(plan: Plan, ctx: ImportContext): Promise<ImportSummary> {
  const summary: ImportSummary = {
    created: 0,
    skipped: plan.skippedNotes.length,
    uploaded: 0,
    ignored: plan.ignored.length,
    errors: plan.errors.map((e) => `${e.rel}: ${e.reason}`),
  };
  const fail = (what: string, err: unknown) => summary.errors.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);

  const uploaded = new Map<string, AttachmentRef>();
  for (const a of plan.newAttachments) {
    try {
      const res = await request(ctx, '/api/import/files', {
        method: 'POST',
        headers: { 'Content-Type': a.mime, 'X-Filename': encodeURIComponent(a.name) },
        body: fs.readFileSync(a.file),
      });
      if (!res.ok) throw new Error(await errorOf(res));
      const saved = (await res.json()) as { url: string; name: string };
      uploaded.set(a.file, { url: saved.url, name: a.name });
      summary.uploaded++;
    } catch (err) {
      fail(a.rel, err);
    }
  }

  const byBase = attachmentsByBase(plan.scan.attachments);
  const lookup: AttachmentLookup = {
    file: (disk) => uploaded.get(disk) ?? null,
    byBase: (baseLower) => {
      const hits = byBase.get(baseLower);
      if (hits?.length !== 1) return hits?.map((h) => ({ url: h.rel, name: h.name }));
      const ref = uploaded.get(hits[0].file);
      return ref ? [ref] : [];
    },
  };

  type Item = { note: ScannedNote; body: { path: string; content: string; updatedAt: number }; bytes: number };
  const batches: Item[][] = [];
  let batch: Item[] = [];
  let batchBytes = 0;
  for (const note of plan.newNotes) {
    let content: string;
    try {
      content = rewriteLinks(path.dirname(note.file), plan.scan.root, fs.readFileSync(note.file, 'utf8'), lookup);
    } catch (err) {
      fail(note.rel, err);
      continue;
    }
    const body = { path: note.targetPath, content, updatedAt: Math.round(note.mtimeMs) };
    const bytes = Buffer.byteLength(JSON.stringify(body));
    if (batch.length && (batch.length >= BATCH_SIZE || batchBytes + bytes > BATCH_MAX_BYTES)) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push({ note, body, bytes });
    batchBytes += bytes;
  }
  if (batch.length) batches.push(batch);

  for (const items of batches) {
    try {
      const res = await request(ctx, '/api/import/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: items.map((i) => i.body) }),
      });
      if (!res.ok) throw new Error(await errorOf(res));
      const { results } = (await res.json()) as { results: { path: string; status: string; error?: string }[] };
      results.forEach((r, i) => {
        if (r.status === 'created') summary.created++;
        else if (r.status === 'skipped') summary.skipped++;
        else summary.errors.push(`${items[i]?.note.rel ?? r.path}: ${r.error ?? 'ungültig'}`);
      });
    } catch (err) {
      for (const i of items) fail(i.note.rel, err);
    }
  }
  return summary;
}

export function renderSummary(summary: ImportSummary): string[] {
  const lines = [
    `Fertig: ${plural(summary.created, 'Notiz', 'Notizen')} angelegt, ${summary.skipped} übersprungen, ` +
      `${plural(summary.uploaded, 'Anhang', 'Anhänge')} hochgeladen, ${summary.ignored} ignoriert, ${plural(summary.errors.length, 'Fehler', 'Fehler')}.`,
  ];
  for (const e of summary.errors) lines.push(`  Fehler: ${e}`);
  return lines;
}

export interface CliIo {
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  /** stdin is a terminal: prompts are possible */
  isTTY: boolean;
  ask: (question: string) => Promise<string>;
  /** Asks without echoing the answer */
  askHidden: (question: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  retryDelayMs?: number;
}

/** The whole CLI; returns the exit code */
export async function runImportCli(argv: string[], io: CliIo): Promise<number> {
  try {
    let parsed;
    try {
      parsed = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
          url: { type: 'string' },
          'dry-run': { type: 'boolean' },
          yes: { type: 'boolean', short: 'y' },
          help: { type: 'boolean', short: 'h' },
        },
      });
    } catch (err) {
      throw new CliError(`${(err as Error).message}\n\n${helpText()}`);
    }
    const { values, positionals } = parsed;
    if (values.help) {
      io.out(helpText());
      return 0;
    }
    const [srcArg, targetArg, ...extra] = positionals;
    if (!srcArg || extra.length) throw new CliError(`Bitte genau einen Quellordner und höchstens einen Zielordner angeben.\n\n${helpText()}`);
    const baseUrl = parseBaseUrl(values.url);
    // npm run starts in the repo root; INIT_CWD is where the user called it
    const resolved = path.resolve(io.env.INIT_CWD ?? process.cwd(), srcArg);
    if (!fs.existsSync(resolved)) throw new CliError(`Ordner nicht gefunden: ${srcArg}`);
    if (!fs.statSync(resolved).isDirectory()) throw new CliError(`Kein Ordner: ${srcArg}`);
    const targetRoot = cleanSpaceFolder(targetArg ?? '');

    let token = io.env[TOKEN_ENV]?.trim();
    if (!token) {
      if (!io.isTTY) throw new CliError(`Kein Import-Token: setze ${TOKEN_ENV} (Einstellungen → Import in deiner Kladde).`);
      token = (await io.askHidden('Import-Token (Eingabe bleibt unsichtbar): ')).trim();
      if (!token) throw new CliError('Kein Import-Token eingegeben.');
    }

    const ctx: ImportContext = { baseUrl, token, fetch: io.fetch, out: io.out, sleep: io.sleep, retryDelayMs: io.retryDelayMs };
    const scan = scanFolder(resolved, targetRoot);
    const plan = buildPlan(scan, await fetchExistingPaths(ctx));
    for (const line of renderPreview(plan, baseUrl)) io.out(line);

    if (values['dry-run']) {
      io.out('');
      io.out('Vorschau (--dry-run): nichts wurde importiert.');
      return 0;
    }
    if (!plan.newNotes.length) {
      io.out('');
      io.out('Nichts Neues zu importieren.');
      return 0;
    }
    if (!values.yes) {
      if (!io.isTTY) throw new CliError('Keine Rückfrage möglich (kein Terminal): mit --yes ohne Rückfrage importieren.');
      const answer = (await io.ask('Importieren? [j/N] ')).trim().toLowerCase();
      if (!['j', 'ja', 'y', 'yes'].includes(answer)) {
        io.out('Abgebrochen, nichts importiert.');
        return 0;
      }
    }

    io.out('');
    const summary = await runImport(plan, ctx);
    for (const line of renderSummary(summary)) io.out(line);
    return summary.errors.length ? 1 : 0;
  } catch (err) {
    if (err instanceof CliError) {
      io.err(`Fehler: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    })
  );
}

function askHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    let value = '';
    const done = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          done();
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          done();
          reject(new CliError('Abgebrochen.'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  runImportCli(process.argv.slice(2), {
    fetch,
    env: process.env,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    isTTY: !!process.stdin.isTTY,
    ask,
    askHidden,
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err);
      process.exitCode = 1;
    }
  );
}
