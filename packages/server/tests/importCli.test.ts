import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { createKladdeApp } from '../src/app';
import { openDatabase } from '../src/db';
import { ImportTokenStore } from '../src/import/ImportTokenStore';
import { CliIo, buildPlan, renderPreview, runImportCli, scanFolder } from '../src/importCli';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);

const db = openDatabase(':memory:');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-import-cli-data-'));
const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-import-cli-vault-'));
const ctx = createKladdeApp({
  db,
  dataDir,
  env: { DATA_KEY: crypto.randomBytes(32).toString('base64') },
  standalone: false,
  isProduction: false,
  publicUrl: null,
  trustProxy: false,
});
const anna = ctx.users.createUser('anna');
const secret = new ImportTokenStore(db).create(anna.id, 'Test').secret;

let server: Server;
let base = '';

function write(rel: string, data: string | Buffer) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

beforeAll(async () => {
  server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  write('.obsidian/app.json', '{}');
  write('.obsidian/geheim.md', 'nicht importieren');
  write('Reise.md', '# Reise\n\n![[bild.png]]\n\n![x](sub/bild2.jpg)\n');
  write('bild.png', PNG);
  write('sub/bild2.jpg', JPG);
  write('sub/Notiz.markdown', 'Unterordner');
  write('Handbuch.pdf', '%PDF-1.4');
  write('Bericht.docx', 'binär');
  write('Vorhanden.md', 'neue Fassung');
  write('Nur hier.md', 'Nur hier verlinkt: ![[nurhier.png]]');
  write('nurhier.png', PNG);

  const now = Date.now();
  ctx.notes.push(anna.id, [
    { id: 'anna-0001', baseVersion: 0, path: 'Import/vorhanden.md', content: 'alte Fassung', deleted: false, createdAt: now, updatedAt: now },
    { id: 'anna-0002', baseVersion: 0, path: 'Import/Nur hier.md', content: 'schon da', deleted: false, createdAt: now, updatedAt: now },
  ]);
});

afterAll(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(vault, { recursive: true, force: true });
});

function io(overrides: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const value: CliIo = {
    fetch,
    env: { KLADDE_IMPORT_TOKEN: secret },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    isTTY: false,
    ask: async () => 'j',
    askHidden: async () => '',
    sleep: async () => {},
    ...overrides,
  };
  return { io: value, out, err };
}

const ownNotes = () => ctx.notes.ownedNotes(anna.id);

describe('import CLI', () => {
  it('previews new, skipped and ignored entries', () => {
    const plan = buildPlan(scanFolder(vault, 'Import'), ownNotes().map((n) => n.path));
    expect(plan.newNotes.map((n) => n.targetPath).sort()).toEqual(['Import/Reise.md', 'Import/sub/Notiz.md']);
    expect(plan.skippedNotes.map((n) => n.targetPath).sort()).toEqual(['Import/Nur hier.md', 'Import/Vorhanden.md']);
    expect(plan.newAttachments.map((a) => a.rel).sort()).toEqual(['bild.png', 'sub/bild2.jpg']);
    expect(plan.ignored.map((e) => e.rel).sort()).toEqual(['Bericht.docx', 'Handbuch.pdf', 'nurhier.png']);
    expect(plan.scan.notes.some((n) => n.rel.includes('.obsidian'))).toBe(false);

    const text = renderPreview(plan, 'http://kladde.test').join('\n');
    expect(text).toContain('Import nach http://kladde.test');
    expect(text).toContain('Zielordner: Import/');
    expect(text).toMatch(/Neue Notizen \(2\):\n {2}neu +Reise\.md → Import\/Reise\.md/);
    expect(text).toMatch(/Neue Anhänge \(2\):/);
    expect(text).toMatch(/Übersprungen \(Pfad vorhanden\) \(2\):\n {2}übersprungen/);
    expect(text).toMatch(/ignoriert +Handbuch\.pdf \(nicht verlinkt\)/);
    expect(text).toMatch(/ignoriert +Bericht\.docx \(Dateityp nicht unterstützt\)/);
    expect(text).toContain('2 neue Notizen, 2 neue Anhänge, 2 übersprungen, 3 ignoriert, 0 Fehler');
  });

  it('writes nothing with --dry-run', async () => {
    const before = ownNotes().length;
    const filesBefore = ctx.files.listByOwner(anna.id).length;
    const { io: cli, out } = io();
    expect(await runImportCli([vault, 'Import', '--url', base, '--dry-run'], cli)).toBe(0);
    expect(out.join('\n')).toContain('2 neue Notizen');
    expect(ownNotes().length).toBe(before);
    expect(ctx.files.listByOwner(anna.id).length).toBe(filesBefore);
  });

  it('aborts without a terminal unless --yes, and when the answer is no', async () => {
    const before = ownNotes().length;
    const noTty = io();
    expect(await runImportCli([vault, 'Import', '--url', base], noTty.io)).toBe(1);
    expect(noTty.err.join('\n')).toContain('--yes');
    const no = io({ isTTY: true, ask: async () => 'n' });
    expect(await runImportCli([vault, 'Import', '--url', base], no.io)).toBe(0);
    expect(no.out.join('\n')).toContain('Abgebrochen');
    expect(ownNotes().length).toBe(before);
  });

  it('imports new notes and only linked attachments, then skips everything on a second run', async () => {
    const { io: cli, out } = io({ isTTY: true, ask: async () => 'J' });
    expect(await runImportCli([vault, 'Import', '--url', `${base}/`], cli)).toBe(0);
    expect(out.join('\n')).toContain('Fertig: 2 Notizen angelegt, 2 übersprungen, 2 Anhänge hochgeladen, 3 ignoriert, 0 Fehler.');

    const uploaded = ctx.files.listByOwner(anna.id);
    expect(uploaded.map((f) => f.name).sort()).toEqual(['bild.png', 'bild2.jpg']);
    const reise = ownNotes().find((n) => n.path === 'Import/Reise.md')!;
    const png = uploaded.find((f) => f.name === 'bild.png')!;
    const jpg = uploaded.find((f) => f.name === 'bild2.jpg')!;
    expect(reise.content).toContain(`![bild.png](/api/files/${png.id})`);
    expect(reise.content).toContain(`![x](/api/files/${jpg.id})`);
    expect(ownNotes().find((n) => n.path === 'Import/sub/Notiz.md')!.content).toBe('Unterordner');
    expect(ownNotes().find((n) => n.path === 'Import/vorhanden.md')!.content).toBe('alte Fassung');
    expect(ownNotes().find((n) => n.path === 'Import/Nur hier.md')!.content).toBe('schon da');

    const again = io({ ask: async () => { throw new Error('should not ask'); } });
    expect(await runImportCli([vault, 'Import', '--url', base], again.io)).toBe(0);
    const text = again.out.join('\n');
    expect(text).toContain('0 neue Notizen, 0 neue Anhänge, 4 übersprungen');
    expect(text).toContain('Nichts Neues zu importieren.');
    expect(ctx.files.listByOwner(anna.id).length).toBe(2);
  });

  it('fails clearly before writing on a wrong token, server, url or folder', async () => {
    const before = ownNotes().length;
    const wrong = io({ env: { KLADDE_IMPORT_TOKEN: 'kli_falsch' } });
    expect(await runImportCli([vault, '--url', base, '--yes'], wrong.io)).toBe(1);
    expect(wrong.err.join('\n')).toContain('Import-Token ungültig oder widerrufen');

    const down = io();
    expect(await runImportCli([vault, '--url', 'http://127.0.0.1:1', '--yes'], down.io)).toBe(1);
    expect(down.err.join('\n')).toContain('nicht erreichbar');

    const badUrl = io();
    expect(await runImportCli([vault, '--url', 'ftp://example.org'], badUrl.io)).toBe(1);
    expect(badUrl.err.join('\n')).toContain('--url');
    expect(await runImportCli([vault], io().io)).toBe(1);

    const missing = io();
    expect(await runImportCli([path.join(vault, 'gibtsnicht'), '--url', base], missing.io)).toBe(1);
    expect(missing.err.join('\n')).toContain('Ordner nicht gefunden');
    const notDir = io();
    expect(await runImportCli([path.join(vault, 'Reise.md'), '--url', base], notDir.io)).toBe(1);
    expect(notDir.err.join('\n')).toContain('Kein Ordner');

    const system = io();
    expect(await runImportCli([vault, '.kladde', '--url', base], system.io)).toBe(1);
    expect(system.err.join('\n')).toContain('.kladde');

    const noToken = io({ env: {} });
    expect(await runImportCli([vault, '--url', base], noToken.io)).toBe(1);
    expect(noToken.err.join('\n')).toContain('KLADDE_IMPORT_TOKEN');
    expect(ownNotes().length).toBe(before);
  });

  it('asks for the token on a terminal and never prints it', async () => {
    const prompted = io({ env: {}, isTTY: true, askHidden: async () => secret });
    expect(await runImportCli([vault, 'Import', '--url', base, '--dry-run'], prompted.io)).toBe(0);
    expect([...prompted.out, ...prompted.err].join('\n')).not.toContain(secret);
  });

  it('retries after HTTP 429', async () => {
    let calls = 0;
    const flaky: typeof fetch = async (input, init) => (++calls === 1 ? new Response('{}', { status: 429 }) : fetch(input, init));
    const { io: cli } = io({ fetch: flaky });
    expect(await runImportCli([vault, 'Import', '--url', base, '--dry-run'], cli)).toBe(0);
    expect(calls).toBe(2);
  });

  it('prints German usage', async () => {
    const { io: cli, out } = io();
    expect(await runImportCli(['--help'], cli)).toBe(0);
    const text = out.join('\n');
    for (const word of ['--url', '--dry-run', '--yes', 'KLADDE_IMPORT_TOKEN', 'Verwendung']) expect(text).toContain(word);
  });
});
