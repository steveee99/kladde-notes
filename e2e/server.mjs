// Test server for the Playwright tests (#62): a fresh data directory, a few accounts with passwords, DEV_LOGIN=1.
// Serves the built client (npm run build) like production, but in development mode so the dev login works.
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { E2E_PASSWORD, E2E_USERS } from './accounts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-e2e-'));
const dbPath = path.join(dataDir, 'kladde.sqlite');


const { openDatabase } = await import(path.join(root, 'packages/server/dist/db.js'));
const { UserStore } = await import(path.join(root, 'packages/server/dist/UserStore.js'));
const db = openDatabase(dbPath);
const users = new UserStore(db);
for (const name of E2E_USERS) {
  const user = users.createUser(name);
  await users.setPassword(user.id, E2E_PASSWORD);
}
db.close();

Object.assign(process.env, {
  NODE_ENV: 'test',
  DEV_LOGIN: '1',
  DB_PATH: dbPath,
  DATA_KEY: crypto.randomBytes(32).toString('base64'),
  PORT: process.env.E2E_PORT ?? '3102',
  BACKUP_KEEP: '0',
  TRASH_RETENTION_DAYS: '30',
});
for (const key of ['PUBLIC_URL', 'EXPORT_DIR', 'GITLAB_CLIENT_ID', 'GITLAB_CLIENT_SECRET', 'TRUST_PROXY']) delete process.env[key];

const cleanup = () => fs.rmSync(dataDir, { recursive: true, force: true });
process.on('exit', cleanup);
console.log(`E2E data in ${dataDir}`);
await import(path.join(root, 'packages/server/dist/index.js'));
