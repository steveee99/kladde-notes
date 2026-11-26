// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import crypto from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startSyncServer } from './support/syncServer';

// Online mode (KLADDE_MODE=online): the device holds a catalog of the notes without their texts, loads a text when a
// note opens, sends moves and deletions without the text and lets the server rewrite links. The rule that matters
// most: a text computed from a catalog entry must never replace the real one (AGENTS.md, `put`)

let s: Awaited<ReturnType<typeof startSyncServer>>;
beforeEach(async () => {
  s = await startSyncServer({ online: true });
});
afterEach(() => s.stop());

const id = () => crypto.randomBytes(16).toString('hex');

describe('vault in online mode', () => {
  it('starts with a catalog and loads a text once, when the note opens', async () => {
    const note = id();
    s.serverPush([{ id: note, path: 'Archiv/Bericht.md', content: '# Bericht\nLanger Text' }]);
    const a = await s.device();

    const entry = a.vault.get(note)!;
    expect(entry.path).toBe('Archiv/Bericht.md');
    expect(entry.partial).toBe(true);
    expect(entry.content).toBe('');
    expect(a.vault.isPartial(note)).toBe(true);
    expect(s.requests).toContain('GET /api/sync');

    const before = s.requests.filter((r) => r === 'POST /api/sync/notes').length;
    const [full, same] = await Promise.all([a.vault.ensureFull(note), a.vault.ensureFull(note)]);
    expect(full?.content).toBe('# Bericht\nLanger Text');
    expect(same).toBe(full);
    expect(a.vault.isPartial(note)).toBe(false);
    // Asked twice at once, loaded once; afterwards it is on the device
    await a.vault.ensureFull(note);
    expect(s.requests.filter((r) => r === 'POST /api/sync/notes').length).toBe(before + 1);
  });

  it('never writes a text computed from a catalog entry', async () => {
    const note = id();
    s.serverPush([{ id: note, path: 'Wichtig.md', content: 'Darf nicht verloren gehen' }]);
    const a = await s.device();

    expect(await a.vault.updateContents([{ id: note, content: 'aus dem Nichts berechnet' }])).toBe(0);
    await a.vault.sync();
    expect(s.serverNote(note)?.content).toBe('Darf nicht verloren gehen');
  });

  it('moves and deletes notes without their text, and the server keeps the text', async () => {
    const moved = id();
    const deleted = id();
    s.serverPush([
      { id: moved, path: 'Eingang/Idee.md', content: 'Text der Idee' },
      { id: deleted, path: 'Eingang/Alt.md', content: 'Text im Papierkorb' },
    ]);
    const a = await s.device();

    await a.vault.update(moved, { folder: 'Projekte' });
    await a.vault.remove(deleted);
    expect(a.vault.isPartial(moved)).toBe(true);
    await a.vault.sync();

    expect(s.serverNote(moved)).toMatchObject({ path: 'Projekte/Idee.md', content: 'Text der Idee' });
    // Devices learn about the deletion from a tombstone; the text lives on in the trash
    expect(s.serverNote(deleted)).toMatchObject({ deleted: true });
    const trashed = s.ctx.notes.trash(s.user.id).find((e) => e.id === deleted);
    expect(trashed?.size).toBe(new TextEncoder().encode('Text im Papierkorb').length);
    expect(a.vault.get(deleted)).toBeUndefined();
    expect(a.vault.pendingCount()).toBe(0);
  });

  it('keeps a move made here when another device changed the text meanwhile', async () => {
    const note = id();
    s.serverPush([{ id: note, path: 'Eingang/Protokoll.md', content: 'Version 1' }]);
    const a = await s.device();

    s.setOffline(true);
    await a.vault.update(note, { folder: 'Besprechungen' });
    await a.vault.sync();
    s.serverPush([{ id: note, path: 'Eingang/Protokoll.md', content: 'Version 2 vom Laptop' }]);
    s.setOffline(false);
    await a.vault.sync();
    await a.vault.sync();

    expect(s.serverNote(note)).toMatchObject({ path: 'Besprechungen/Protokoll.md', content: 'Version 2 vom Laptop' });
    expect(a.vault.get(note)?.path).toBe('Besprechungen/Protokoll.md');
    expect(a.vault.pendingCount()).toBe(0);
  });

  it('lets the server rewrite links after a rename, also in notes the device never loaded', async () => {
    const target = id();
    const opened = id();
    const unopened = id();
    s.serverPush([
      { id: target, path: 'Alter Name.md', content: 'Ziel' },
      { id: opened, path: 'Geöffnet.md', content: 'Siehe [[Alter Name]]' },
      { id: unopened, path: 'Nie geöffnet.md', content: 'Auch [[Alter Name]]' },
    ]);
    const a = await s.device();
    await a.vault.ensureFull(opened);

    await a.vault.update(target, { title: 'Neuer Name' });
    await a.vault.sync();
    expect(s.requests).toContain('POST /api/sync/relink');
    expect(s.serverNote(opened)?.content).toBe('Siehe [[Neuer Name]]');
    expect(s.serverNote(unopened)?.content).toBe('Auch [[Neuer Name]]');

    // The opened note gets the new text with the next sync, the other one stays a catalog entry
    await a.vault.sync();
    expect(a.vault.get(opened)?.content).toBe('Siehe [[Neuer Name]]');
    expect(a.vault.isPartial(unopened)).toBe(true);
  });

  it('keeps a relink that could not be sent for the next sync', async () => {
    const target = id();
    const linking = id();
    s.serverPush([
      { id: target, path: 'Thema.md', content: 'x' },
      { id: linking, path: 'Index.md', content: '[[Thema]]' },
    ]);
    const a = await s.device();
    s.setOffline(true);
    await a.vault.update(target, { title: 'Hauptthema' });
    await a.vault.sync();
    s.setOffline(false);
    await a.vault.sync();
    expect(s.serverNote(linking)?.content).toBe('[[Hauptthema]]');
  });

  it('updates an opened note when it changed elsewhere and merges with local edits', async () => {
    const note = id();
    s.serverPush([{ id: note, path: 'Liste.md', content: 'eins\nzwei\ndrei' }]);
    const a = await s.device();
    await a.vault.ensureFull(note);

    await a.vault.update(note, { content: 'EINS\nzwei\ndrei' });
    s.serverPush([{ id: note, path: 'Liste.md', content: 'eins\nzwei\nDREI' }]);
    await a.vault.sync();
    await a.vault.sync();
    expect(s.serverNote(note)?.content).toBe('EINS\nzwei\nDREI');
    expect(a.vault.get(note)?.content).toBe('EINS\nzwei\nDREI');
  });

  it('loads the notes of database folders in full', async () => {
    const database = id();
    const row = id();
    const outside = id();
    s.serverPush([
      { id: database, path: 'Bücher/_database-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0.md', content: '---\ntype: database\nproperties:\n  - name: autor\n    type: text\n---\n' },
      { id: row, path: 'Bücher/Dune.md', content: '---\nautor: Frank Herbert\n---\n# Dune' },
      { id: outside, path: 'Sonstiges/Notiz.md', content: 'nicht nötig' },
    ]);
    const a = await s.device();

    expect(a.vault.isPartial(database)).toBe(false);
    expect(a.vault.get(row)?.content).toContain('Frank Herbert');
    expect(a.vault.isPartial(outside)).toBe(true);
  });

  it('keeps opened texts across a restart, catalog entries only in memory', async () => {
    const opened = id();
    const other = id();
    s.serverPush([
      { id: opened, path: 'Offen.md', content: 'bleibt auf dem Gerät' },
      { id: other, path: 'Zu.md', content: 'nur im Katalog' },
    ]);
    const a = await s.device();
    await a.vault.ensureFull(opened);
    a.vault.close();

    s.setOffline(true);
    const again = await s.device(a.idb);
    expect(again.vault.get(opened)?.content).toBe('bleibt auf dem Gerät');
    expect(again.vault.get(other)).toBeUndefined();
    await expect(again.vault.ensureFull(opened)).resolves.toMatchObject({ content: 'bleibt auf dem Gerät' });
  });
});
