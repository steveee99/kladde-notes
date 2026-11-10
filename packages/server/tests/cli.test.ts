import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SYSTEM_PREFIX } from '@kladde/shared';
import { CliError, runCli } from '../src/cliActions';
import { DataCipher } from '../src/crypto';
import { openDatabase } from '../src/db';
import { FileStore } from '../src/FileStore';
import { NoteStore } from '../src/NoteStore';
import { AuditLog } from '../src/security/AuditLog';
import { UserStore } from '../src/UserStore';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'kladde-cli-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function setup() {
  const dataDir = makeTempDir('kladde-data-');
  const dbPath = path.join(dataDir, 'kladde.sqlite');
  const db = openDatabase(dbPath);
  const cipher = new DataCipher(crypto.randomBytes(32));
  const users = new UserStore(db);
  const notes = new NoteStore(db, cipher);
  const files = new FileStore(db, cipher, dataDir);
  const audit = new AuditLog(db);
  const anna = users.createUser('anna');
  return {
    dataDir,
    dbPath,
    db,
    users,
    notes,
    files,
    audit,
    anna,
    deps: { db, users, notes, files, audit, publicUrl: 'https://notes.example.org', defaultBackupDir: path.join(dataDir, 'backups') },
  };
}

describe('CLI import & export & utilities', () => {
  it('imports a single markdown file into a target folder and resolves sibling images', async () => {
    const { deps, notes, files, anna, db } = setup();
    const srcDir = makeTempDir('src-single-');
    fs.writeFileSync(path.join(srcDir, 'foto.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    fs.writeFileSync(path.join(srcDir, 'Plan.md'), '# Mein Plan\n\nSiehe ![Skizze](./foto.png)\n');

    const res = await runCli(['import', path.join(srcDir, 'Plan.md'), 'Projekte'], deps);
    expect(res.data).toMatchObject({ notesCreated: 1, filesImported: 1 });

    const all = notes.ownedNotes(anna.id);
    expect(all).toHaveLength(1);
    expect(all[0].path).toBe('Projekte/Plan.md');
    const savedFiles = files.listByOwner(anna.id);
    expect(savedFiles).toHaveLength(1);
    expect(all[0].content).toContain(`/api/files/${savedFiles[0].id}`);

    // Explicit .md destination path
    fs.writeFileSync(path.join(srcDir, 'Extra.md'), 'Zweite Notiz');
    await runCli(['import', path.join(srcDir, 'Extra.md'), 'Notizen/Umbenannt.md'], deps);
    expect(notes.ownedNotes(anna.id).map((n) => n.path)).toContain('Notizen/Umbenannt.md');
    db.close();
  });

  it('recursively imports folders, rewrites relative & Obsidian links, skips dotfiles, and respects conflict modes', async () => {
    const { deps, notes, files, anna, db } = setup();
    const vault = makeTempDir('src-vault-');
    fs.mkdirSync(path.join(vault, 'Unterordner', 'Tief'), { recursive: true });
    fs.mkdirSync(path.join(vault, 'Assets'), { recursive: true });
    fs.mkdirSync(path.join(vault, '.git'), { recursive: true });

    fs.writeFileSync(path.join(vault, '.git', 'HEAD'), 'ref: refs/heads/main');
    fs.writeFileSync(path.join(vault, '.DS_Store'), 'junk');
    fs.writeFileSync(path.join(vault, 'raw.bin'), Buffer.from([0, 1, 2]));
    fs.writeFileSync(path.join(vault, 'Assets', 'diagramm.svg'), '<svg/>');
    fs.writeFileSync(path.join(vault, 'Start.md'), '---\ntags: [arbeit]\n---\n# Start\n![[diagramm.svg|Architektur]]');
    fs.writeFileSync(path.join(vault, 'Unterordner', 'Tief', 'Detail.md'), '# Detail\n![Grafik](../../Assets/diagramm.svg)');

    // Dry-run does not persist anything
    const dry = await runCli(['import', vault, 'Archiv', '--dry-run'], deps);
    expect(dry.data).toMatchObject({ dryRun: true, notesCreated: 2, filesImported: 1, ignored: 1 });
    expect(notes.ownedNotes(anna.id)).toHaveLength(0);
    expect(files.listByOwner(anna.id)).toHaveLength(0);

    // Real import
    const res = await runCli(['import', vault, 'Archiv'], deps);
    expect(res.data).toMatchObject({ notesCreated: 2, filesImported: 1, ignored: 1 });
    const owned = notes.ownedNotes(anna.id);
    const paths = owned.map((n) => n.path).sort();
    expect(paths).toEqual(['Archiv/Start.md', 'Archiv/Unterordner/Tief/Detail.md']);

    const fid = files.listByOwner(anna.id)[0].id;
    const startNote = owned.find((n) => n.path === 'Archiv/Start.md')!;
    const detailNote = owned.find((n) => n.path === 'Archiv/Unterordner/Tief/Detail.md')!;
    expect(startNote.content).toContain(`![Architektur](/api/files/${fid})`);
    expect(detailNote.content).toContain(`![Grafik](/api/files/${fid})`);

    // Re-importing with default (--skip) skips existing, --rename creates "2", --overwrite updates
    fs.writeFileSync(path.join(vault, 'Start.md'), '# Start v2');
    const skipRes = await runCli(['import', path.join(vault, 'Start.md'), 'Archiv'], deps);
    expect(skipRes.data).toMatchObject({ notesSkipped: 1, notesCreated: 0, notesUpdated: 0 });

    const renameRes = await runCli(['import', path.join(vault, 'Start.md'), 'Archiv', '--rename'], deps);
    expect(renameRes.data).toMatchObject({ notesCreated: 1 });
    expect(notes.ownedNotes(anna.id).map((n) => n.path)).toContain('Archiv/Start 2.md');

    const overwriteRes = await runCli(['import', path.join(vault, 'Start.md'), 'Archiv', '--overwrite'], deps);
    expect(overwriteRes.data).toMatchObject({ notesUpdated: 1 });
    expect(notes.ownedNotes(anna.id).find((n) => n.path === 'Archiv/Start.md')!.content).toBe('# Start v2');
    db.close();
  });

  it('exports the space, a subfolder, or a single note with --strip-frontmatter and --with-files', async () => {
    const { deps, notes, files, anna, db } = setup();
    const img = files.save(anna.id, 'bild.png', 'image/png', Buffer.from([1, 2, 3, 4]));
    const pushRes = notes.push(anna.id, [
      {
        id: 'note-alpha-01',
        baseVersion: 0,
        path: 'Projekte/Alpha.md',
        content: `---\nstatus: aktiv\n---\n# Alpha\n![Foto](/api/files/${img.id})`,
        deleted: false,
        createdAt: 1000,
        updatedAt: 1000,
      },
      {
        id: 'note-inbox-02',
        baseVersion: 0,
        path: 'Inbox/Gedanke.md',
        content: 'Kurzer Gedanke',
        deleted: false,
        createdAt: 1000,
        updatedAt: 1000,
      },
      {
        id: 'note-system-01',
        baseVersion: 0,
        path: `${SYSTEM_PREFIX}templates.md`,
        content: 'internal',
        deleted: false,
        createdAt: 1000,
        updatedAt: 1000,
      },
    ]);
    expect(pushRes.every((r) => r.status === 'ok')).toBe(true);

    const exportDir = makeTempDir('export-space-');
    const full = await runCli(['export', '/', exportDir, '--strip-frontmatter', '--with-files'], deps);
    expect(full.data).toMatchObject({ exportedNotes: 2, exportedFiles: 1 });

    // System notes are excluded
    expect(fs.existsSync(path.join(exportDir, '.kladde'))).toBe(false);

    const alphaText = fs.readFileSync(path.join(exportDir, 'Projekte', 'Alpha.md'), 'utf8');
    expect(alphaText).not.toContain('status: aktiv');
    expect(alphaText).toContain(`../_attachments/${img.id}-bild.png`);
    expect(fs.existsSync(path.join(exportDir, '_attachments', `${img.id}-bild.png`))).toBe(true);

    // Subfolder export into fresh directory
    const subDir = makeTempDir('export-sub-');
    await runCli(['export', 'Projekte', subDir], deps);
    expect(fs.existsSync(path.join(subDir, 'Alpha.md'))).toBe(true);
    // Original keeps frontmatter when --strip-frontmatter isn't passed
    expect(fs.readFileSync(path.join(subDir, 'Alpha.md'), 'utf8')).toContain('status: aktiv');

    // Single-note export
    const singleFile = path.join(makeTempDir('export-one-'), 'NurAlpha.md');
    await runCli(['export', 'Projekte/Alpha.md', singleFile, '--strip-frontmatter'], deps);
    expect(fs.readFileSync(singleFile, 'utf8')).toContain('# Alpha');
    expect(fs.readFileSync(singleFile, 'utf8')).not.toContain('status: aktiv');
    db.close();
  });

  it('requires --user when multiple accounts exist and runs search, attachments cleanup, backup, and admin commands', async () => {
    const { deps, users, notes, files, anna, db } = setup();
    const ben = users.createUser('ben');

    await expect(runCli(['notizen'], deps)).rejects.toThrow(CliError);

    const used = files.save(anna.id, 'used.png', 'image/png', Buffer.from([1]));
    const unused = files.save(anna.id, 'unused.pdf', 'application/pdf', Buffer.from('%PDF'));
    const pushHouse = notes.push(anna.id, [
      {
        id: 'note-house-01',
        baseVersion: 0,
        path: 'Wohnen/Checkliste.md',
        content: `---\ntags: [haus]\n---\n# Mietvertrag & Kaution\n![Beleg](/api/files/${used.id})`,
        deleted: false,
        createdAt: 1000,
        updatedAt: 1000,
      },
    ]);
    expect(pushHouse[0].status).toBe('ok');

    // Semantic search finds Wohnung -> Wohnen/Checkliste.md
    const searchRes = await runCli(['suche', 'Wohnungssuche', '--user', 'anna'], deps);
    expect((searchRes.data as { note: { path: string } }[])[0].note.path).toBe('Wohnen/Checkliste.md');

    // Attachments inspection & safe cleanup (must preserve `used` and delete `unused`)
    const attachList = await runCli(['anhaenge', '--user', 'anna', '--unused'], deps);
    expect((attachList.data as { id: string }[]).map((f) => f.id)).toEqual([unused.id]);

    const cleanRes = await runCli(['anhaenge-bereinigen', '--user', 'anna'], deps);
    expect(cleanRes.data).toMatchObject({ protectedCount: 1 });
    expect(files.listByOwner(anna.id).map((f) => f.id)).toEqual([used.id]);

    // Backup to explicit .sqlite path and directory
    const backupDir = makeTempDir('cli-backup-');
    const sqliteOut = path.join(backupDir, 'snap.sqlite');
    await runCli(['backup', sqliteOut], deps);
    expect(fs.existsSync(sqliteOut)).toBe(true);
    const dirBackup = await runCli(['backup', backupDir], deps);
    expect(fs.existsSync((dirBackup.data as { path: string }).path)).toBe(true);

    // Status & admin commands
    const statusRes = await runCli(['status'], deps);
    expect(statusRes.data).toMatchObject({ users: 2, notes: 1, files: 1 });

    const inviteRes = await runCli(['einladen', 'Für Gast'], deps);
    expect(inviteRes.lines[0]).toMatch(/^https:\/\/notes\.example\.org\/invite\//);
    const code = (inviteRes.data as { code: string }).code;
    await runCli(['einladung-loeschen', code], deps);

    await runCli(['sperren', 'ben'], deps);
    expect(users.getUser(ben.id)?.bannedAt).not.toBeNull();
    await runCli(['entsperren', 'ben'], deps);
    expect(users.getUser(ben.id)?.bannedAt).toBeNull();

    await runCli(['admin', 'ben', 'an'], deps);
    expect(users.getUser(ben.id)?.isAdmin).toBe(true);

    const pwRes = await runCli(['passwort', 'ben'], deps);
    expect((pwRes.data as { password: string }).password.length).toBeGreaterThan(8);

    const helpRes = await runCli(['hilfe'], deps);
    expect(helpRes.lines[0]).toContain('Kladde CLI');
    db.close();
  });
});
