// Kladde CLI: Import, Export, Notiz-/Anhangsverwaltung und Server-Administration
// Beispiel: `docker exec kladde node packages/server/dist/cli.js export / ./backup-md`
import path from 'path';
import { cliHelpText, CliError, runCli } from './cliActions.js';
import { DataCipher } from './crypto.js';
import { openDatabase } from './db.js';
import { ExportMirror } from './ExportMirror.js';
import { FileStore } from './FileStore.js';
import { NoteStore } from './NoteStore.js';
import { AuditLog } from './security/AuditLog.js';
import { isStandaloneMode, moduleDir, resolveDataDir, resolveDbPath } from './standalone.js';
import { UserStore } from './UserStore.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const first = argv[0]?.toLowerCase();

  if (!first || first === 'hilfe' || first === 'help' || first === '--help' || first === '-h') {
    console.log(cliHelpText());
    process.exit(0);
  }

  const env = process.env;
  const standalone = isStandaloneMode(env, argv);
  const defaultDir = path.join(moduleDir(import.meta.url), '..', 'data');
  const DATA_DIR = resolveDataDir({ env, argv, standalone, defaultDir });
  const DB_PATH = resolveDbPath(DATA_DIR, env, argv);
  const BACKUP_DIR = path.resolve(env.BACKUP_DIR ?? path.join(DATA_DIR, 'backups'));
  const db = openDatabase(DB_PATH, { backupDir: BACKUP_DIR });

  try {
    const cipher = DataCipher.fromEnv(DATA_DIR);
    const users = new UserStore(db);
    const mirror = ExportMirror.fromEnv((id) => users.getUser(id)?.username ?? null);
    const notes = new NoteStore(db, cipher, (event) => mirror?.apply(event));
    const files = new FileStore(db, cipher, DATA_DIR);
    const audit = new AuditLog(db);

    const result = await runCli(argv, {
      db,
      users,
      notes,
      files,
      audit,
      publicUrl: env.PUBLIC_URL,
      defaultBackupDir: BACKUP_DIR,
    });

    if (argv.includes('--json')) {
      console.log(JSON.stringify(result.data ?? { lines: result.lines }, null, 2));
    } else {
      for (const line of result.lines) console.log(line);
    }
  } catch (err) {
    if (err instanceof CliError) {
      console.error(`Fehler: ${err.message}`);
      process.exitCode = 1;
    } else {
      console.error(err);
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

void main();
