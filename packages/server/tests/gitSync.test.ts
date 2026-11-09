import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { openDatabase } from '../src/db';
import { DataCipher } from '../src/crypto';
import { UserStore } from '../src/UserStore';
import { GitSync, commitMessage } from '../src/GitSync';

describe('commitMessage', () => {
  it('fills date and time, defaults when empty', () => {
    const d = new Date(2026, 10, 9, 14, 5);
    expect(commitMessage('Sync {date} {time}', d)).toBe('Sync 2026-11-09 14:05');
    expect(commitMessage('', d)).toBe('Kladde-Sync 2026-11-09');
  });
});

describe('GitSync', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-git-'));
  const remote = path.join(tmp, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const db = openDatabase(':memory:');
  const users = new UserStore(db);
  const anna = users.createUser('anna');
  let notes = [{ path: 'Projekte/Plan', content: '# Plan' }, { path: '.kladde/settings.json', content: '{}' }];
  const sync = new GitSync(db, new DataCipher(crypto.randomBytes(32)), () => notes, () => 'anna', tmp, 'https:http:file');
  const url = `file://${remote}`;

  it('validates input and hides the token', () => {
    expect(() => sync.save(anna.id, { url: 'ftp://x/y', email: 'a@b.de' })).toThrow();
    expect(() => sync.save(anna.id, { url: 'https://u:p@x.de/r.git', email: 'a@b.de', token: 't' })).toThrow();
    expect(() => sync.save(anna.id, { url, email: 'kein-email' })).toThrow();
    const saved = sync.save(anna.id, { url, email: 'anna@example.com', token: 'secret', message: 'Backup {date}' });
    expect(saved.hasToken).toBe(true);
    expect(JSON.stringify(saved)).not.toContain('secret');
  });

  it('pushes notes as a commit on main and only again on changes', async () => {
    const first = await sync.run(anna.id);
    expect(first.lastStatus).toBe('ok');
    const log = () => execFileSync('git', ['--git-dir', remote, 'log', 'main', '--format=%s|%ae']).toString().trim().split('\n');
    expect(log()).toHaveLength(1);
    expect(log()[0]).toMatch(/^Backup \d{4}-\d{2}-\d{2}\|anna@example.com$/);
    expect(execFileSync('git', ['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main']).toString().trim()).toBe('Projekte/Plan.md');
    expect((await sync.run(anna.id)).lastStatus).toBe('unchanged');
    notes = [{ path: 'Projekte/Plan', content: '# Plan 2' }];
    expect((await sync.run(anna.id)).lastStatus).toBe('ok');
    expect(log()).toHaveLength(2);
  });

  it('reports errors without crashing', async () => {
    sync.save(anna.id, { url: `file://${tmp}/missing.git`, email: 'anna@example.com' });
    const r = await sync.run(anna.id);
    expect(r.lastStatus).toBe('error');
    expect(r.lastError).toBeTruthy();
  });
});
