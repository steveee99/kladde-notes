// Fills a local Kladde database with a large test vault (notes, [[links]], tasks) for trying out large vaults and the
// online mode: `npm run build`, then `npm run seed -- --notes 20000`. Uses the generator of the benchmarks
// (e2e/fixtures/largeVault.mjs) and writes through NoteStore.push, so the notes are encrypted and synced like any other.
//
//   --notes <n>      number of notes (default 10000)
//   --links <n>      number of [[links]] (default 4 per note)
//   --tasks <n>      number of tasks (default 2 per note)
//   --user <name>    account that gets the notes (default "dev", the account of the dev login)
//   --group <name>   put the notes into this group instead (created with --user as owner if missing)
//   --members <n>    with --group: also create the accounts user01…user<n> as editors of the group
//   --password <pw>  password for --user and the created members (default "kladde-test")
//   --seed <n>       other titles and texts; notes of an earlier run with the same seed are skipped
//
// The database is the one `npm run dev` uses (packages/server/data), or KLADDE_DATA_DIR / DB_PATH. The server may keep
// running: devices pick the notes up with their next sync.
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { generateVault } from '../e2e/fixtures/largeVault.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = (file) => import(pathToFileURL(path.join(root, 'packages/server/dist', file)).href);

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key.slice(2)] = true;
    else out[key.slice(2)] = argv[++i];
  }
  return out;
}

const opts = args(process.argv.slice(2));
if (opts.help) {
  console.log('npm run seed -- [--notes 10000] [--links n] [--tasks n] [--user dev] [--group Team] [--members 50] [--password pw] [--seed 1]');
  process.exit(0);
}
const int = (name, fallback) => {
  if (opts[name] === undefined) return fallback;
  const n = Number(opts[name]);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`--${name} needs a whole number`);
    process.exit(1);
  }
  return n;
};
const notes = int('notes', 10_000);
const links = int('links', notes * 4);
const tasks = int('tasks', notes * 2);
const seed = int('seed', 1);
const members = int('members', 0);
const username = typeof opts.user === 'string' ? opts.user : 'dev';
const groupName = typeof opts.group === 'string' ? opts.group : null;
const password = typeof opts.password === 'string' ? opts.password : 'kladde-test';
if (members && !groupName) {
  console.error('--members needs --group');
  process.exit(1);
}

const { openDatabase } = await dist('db.js');
const { DataCipher } = await dist('crypto.js');
const { NoteStore } = await dist('NoteStore.js');
const { UserStore } = await dist('UserStore.js');
const { GroupStore } = await dist('GroupStore.js');
const { resolveDataDir, resolveDbPath } = await dist('standalone.js');

const dataDir = resolveDataDir({ defaultDir: path.join(root, 'packages/server/data'), standalone: false });
const dbPath = resolveDbPath(dataDir);
const db = openDatabase(dbPath);
const cipher = DataCipher.fromEnv(dataDir);
const users = new UserStore(db);
const groups = new GroupStore(db);
const store = new NoteStore(db, cipher);

/** Finds or creates an account; a new one (or one without a password) gets the password */
async function account(name) {
  const existing = users.findByUsername(name);
  if (existing) return { user: existing, created: false };
  const user = users.createUser(name);
  await users.setPassword(user.id, password);
  return { user, created: true };
}

try {
  const owner = await account(username);
  let targetId = owner.user.id;
  let target = `account "${username}"`;
  if (groupName) {
    const found = db
      .prepare("SELECT u.id FROM users u JOIN group_members m ON m.group_id = u.id WHERE u.is_group = 1 AND u.username = ? AND m.user_id = ? AND m.role = 'owner'")
      .get(groupName, owner.user.id);
    targetId = found?.id ?? groups.create(owner.user.id, groupName).id;
    target = `group "${groupName}"`;
    let created = 0;
    for (let i = 1; i <= members; i++) {
      const member = await account(`user${String(i).padStart(2, '0')}`);
      if (member.created) created++;
      if (!groups.roleOf(targetId, member.user.id)) groups.setMember(owner.user.id, targetId, member.user.id, 'editor');
    }
    if (members) console.log(`Members: user01…user${String(members).padStart(2, '0')} (${created} new, editors)`);
  }

  // Due dates around today, so the task page and home have something due
  const today = new Date();
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const prefix = `seed${seed}x`;
  const vault = generateVault({ notes, links, tasks, seed, now, idPrefix: prefix });
  const known = new Set(db.prepare('SELECT id FROM notes WHERE id LIKE ?').all(`${prefix}%`).map((row) => row.id));
  const fresh = vault.filter((note) => !known.has(note.id));

  const started = Date.now();
  let done = 0;
  for (let i = 0; i < fresh.length; i += 500) {
    const chunk = fresh.slice(i, i + 500).map((note) => ({ ...note, baseVersion: 0, deleted: false }));
    store.push(targetId, chunk);
    done += chunk.length;
    process.stdout.write(`\r${done} / ${fresh.length} notes`);
  }
  if (fresh.length) process.stdout.write('\n');
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `${fresh.length} notes with about ${links} links and ${tasks} tasks written to ${target} in ${seconds} s` +
      (known.size ? ` (${known.size} from an earlier run skipped)` : '')
  );
  console.log(`Database: ${dbPath}`);
  if (owner.created) console.log(`New account "${username}" with password "${password}"`);
} finally {
  db.close();
}
