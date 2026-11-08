// Admin commands without Telegram, e.g. `docker exec kladde node packages/server/dist/cli.js einladen Anna`
import path from 'path';
import { fileURLToPath } from 'url';
import { openDatabase } from './db.js';
import { UserStore } from './UserStore.js';

const DB_PATH = path.resolve(process.env.DB_PATH ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'kladde.sqlite'));
const users = new UserStore(openDatabase(DB_PATH));
const [command, ...rest] = process.argv.slice(2);
const base = (process.env.PUBLIC_URL ?? '').replace(/\/$/, '');

switch (command) {
  case 'einladen': {
    const invite = users.createInvite(rest.join(' '));
    console.log(base ? `${base}/invite/${invite.code}` : invite.code);
    break;
  }
  case 'einladungen':
    for (const i of users.listInvites()) console.log(`${i.code}  ${i.note}  ${i.usedBy ? `benutzt von ${i.usedBy}` : 'offen'}`);
    break;
  case 'konten':
    for (const u of users.listUsers()) console.log(`${u.username}${u.bannedAt ? ' (gesperrt)' : ''}`);
    break;
  default:
    console.log('Befehle: einladen [Notiz] | einladungen | konten');
}
